// Control Plane 创建 Agent Sandbox 的 TypeScript 示例
// 对应第 5 章 5.1 节
//
// 注意：这是简化示例，实际生产环境需要更完善的错误处理、重试逻辑和指标上报。
// 依赖：@kubernetes/client-node

import * as k8s from "@kubernetes/client-node";

interface SandboxConfig {
  employeeId: string;
  tenantId: string;
  image: string;
  workspaceStorage: string; // e.g., "10Gi"
  memoryStorage: string;    // e.g., "5Gi"
  cpuLimit: string;         // e.g., "2"
  memoryLimit: string;      // e.g., "4Gi"
}

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

const NAMESPACE = "hermes-agents";
const AGENT_IMAGE = "ghcr.io/example-org/hermes-agent:v1.2.3";

async function createSandbox(config: SandboxConfig): Promise<void> {
  const { employeeId, tenantId } = config;

  // 1. 检查是否已有 Sandbox
  try {
    const existingPod = await coreV1.readNamespacedPod(
      `agent-${employeeId}`,
      NAMESPACE
    );
    if (existingPod) {
      console.log(`Sandbox already exists for ${employeeId}`);
      return;
    }
  } catch (err: any) {
    if (err.statusCode !== 404) throw err;
  }

  // 2. 创建 PVC
  await createPVC(`workspace-${employeeId}`, config.workspaceStorage);
  await createPVC(`memory-${employeeId}`, config.memoryStorage);

  // 3. 创建 ConfigMap
  await createConfigMap(employeeId, tenantId);

  // 4. 创建 Pod
  const pod: k8s.V1Pod = {
    metadata: {
      name: `agent-${employeeId}`,
      namespace: NAMESPACE,
      labels: {
        app: "hermes-agent",
        employee: employeeId,
        tenant: tenantId,
      },
    },
    spec: {
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      automountServiceAccountToken: false,
      securityContext: {
        runAsUser: 1000,
        runAsGroup: 1000,
        runAsNonRoot: true,
        fsGroup: 1000,
      },
      containers: [
        {
          name: "hermes-agent",
          image: AGENT_IMAGE,
          imagePullPolicy: "Always",
          workingDir: "/home/hermes/workspace",
          command: ["/usr/bin/hermes-agent"],
          args: [
            "--config=/etc/hermes/config.yaml",
            "--workspace=/home/hermes/workspace",
            "--memory=/home/hermes/memory",
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "500m", memory: "1Gi" },
            limits: { cpu: config.cpuLimit, memory: config.memoryLimit },
          },
          ports: [{ containerPort: 8080, name: "api", protocol: "TCP" }],
          readinessProbe: {
            httpGet: { path: "/healthz", port: 8080 },
            initialDelaySeconds: 10,
            periodSeconds: 5,
          },
          livenessProbe: {
            httpGet: { path: "/healthz", port: 8080 },
            initialDelaySeconds: 30,
            periodSeconds: 15,
          },
          volumeMounts: [
            { name: "workspace", mountPath: "/home/hermes/workspace" },
            { name: "memory", mountPath: "/home/hermes/memory" },
            { name: "config", mountPath: "/etc/hermes", readOnly: true },
            { name: "tmp", mountPath: "/tmp" },
          ],
          env: [
            { name: "HERMES_EMPLOYEE_ID", value: employeeId },
            { name: "HERMES_TENANT_ID", value: tenantId },
          ],
        },
      ],
      volumes: [
        {
          name: "workspace",
          persistentVolumeClaim: { claimName: `workspace-${employeeId}` },
        },
        {
          name: "memory",
          persistentVolumeClaim: { claimName: `memory-${employeeId}` },
        },
        {
          name: "config",
          configMap: { name: `agent-${employeeId}-config` },
        },
        {
          name: "tmp",
          emptyDir: { medium: "Memory", sizeLimit: "256Mi" },
        },
      ],
    },
  };

  await coreV1.createNamespacedPod(NAMESPACE, pod);
  console.log(`Created sandbox for ${employeeId}`);

  // 5. 等待 Pod Ready
  await waitForPodReady(`agent-${employeeId}`);
}

async function createPVC(name: string, storage: string): Promise<void> {
  const pvc: k8s.V1PersistentVolumeClaim = {
    metadata: { name, namespace: NAMESPACE },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "standard",
      resources: { requests: { storage } },
    },
  };
  try {
    await coreV1.createNamespacedPersistentVolumeClaim(NAMESPACE, pvc);
  } catch (err: any) {
    if (err.statusCode !== 409) throw err; // AlreadyExists
  }
}

async function createConfigMap(
  employeeId: string,
  tenantId: string
): Promise<void> {
  const cm: k8s.V1ConfigMap = {
    metadata: { name: `agent-${employeeId}-config`, namespace: NAMESPACE },
    data: {
      "config.yaml": `
employee_id: "${employeeId}"
tenant_id: "${tenantId}"
tool_gateway_url: "http://tool-gateway.hermez-systems.svc.cluster.local:9090"
memory_path: "/home/hermes/memory"
workspace_path: "/home/hermes/workspace"
`,
    },
  };
  try {
    await coreV1.createNamespacedConfigMap(NAMESPACE, cm);
  } catch (err: any) {
    if (err.statusCode !== 409) throw err;
  }
}

async function waitForPodReady(name: string, timeoutMs = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pod = await coreV1.readNamespacedPod(name, NAMESPACE);
      const ready = pod.status?.conditions?.some(
        (c) => c.type === "Ready" && c.status === "True"
      );
      if (ready) return;
    } catch {
      // Pod not yet created
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Pod ${name} did not become ready within ${timeoutMs}ms`);
}
