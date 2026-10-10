# 第 5 章：为每位员工构建隔离的 Agent Sandbox

## 本章目标

本章详细展开如何在 Kubernetes 中为每位员工构建独立、安全、可管理的 Agent Sandbox。通过本章，读者将理解：

- 为什么多员工共享一个 Agent 进程不可行
- Sandbox 的 Kubernetes 资源组成和隔离机制
- 容器运行时安全的纵深防御配置
- Sandbox 的完整生命周期：创建、运行、暂停、回收和故障恢复
- 如何验证隔离有效性

## 问题背景与使用场景

第 3 章已经建立了总体架构：每位员工运行一个独立的 Hermes Agent Sandbox。这里需要回答的是**如何实现**。

考虑一个 500 人企业的场景：

1. **员工 Alice** 的 Agent 正在分析一份内部文档，并将其中的事实提炼后写入自己的 Memory。
2. **员工 Bob** 的 Agent 正在通过 Tool Gateway 查询 Jira 工单。
3. **员工 Carol** 的 Agent 被一个包含恶意指令的网页 Prompt Injection，尝试读取 `/etc/passwd` 并向外发送数据。

如果所有员工共享同一个 Agent 进程或同一组容器：

- Alice 的 Memory 可能被 Bob 的 Agent 读取。
- Bob 的会话历史可能泄露给 Carol。
- Carol 的 Agent 被误导后，可能读取其他员工的文件。
- 一个 Agent 的内存泄漏或无限循环会影响所有人。

**所以，每位员工必须有一个独立的 Sandbox**，在计算、存储、网络和身份四个维度上相互隔离。本章解决计算和存储隔离；网络隔离由第 6 章展开。

## 威胁模型与设计目标

### 威胁模型

| 威胁 | 来源 | 影响 |
|------|------|------|
| 员工 A 的 Agent 读取员工 B 的文件 | 共享存储、配置错误 | 信息泄露 |
| Agent 进程逃逸容器边界 | 容器运行时漏洞 | 宿主机被控制 |
| Agent 消耗过多资源 | 模型输出异常、工具循环 | 拒绝服务 |
| Agent 使用高权限身份访问 Kubernetes API | 过度授权的 ServiceAccount | 集群被操控 |
| Agent 执行任意 Shell 命令 | Hermes 的 Shell 工具、代码执行工具 | 容器内任意操作 |

### 设计目标

1. **存储隔离**：每个 Sandbox 的工作目录、Memory、配置和会话对其他 Sandbox 不可见。
2. **运行时安全**：采用纵深防御（非 root、只读根文件系统、最小 capabilities、Seccomp、资源限制），降低容器逃逸和滥用的影响。
3. **最小权限身份**：Sandbox 的 ServiceAccount 只拥有完成工作所需的最小权限，默认不授予 Kubernetes API 访问权。
4. **可管理的生命周期**：Sandbox 能按需创建、暂停、恢复和回收，且故障时能自动恢复。
5. **可验证的隔离**：通过正向和负向实验确认隔离有效。

## 架构与工作机制

### 核心原则：One Person, One Namespace, One Pod, One Encrypted Volume

本书采用确定性的隔离策略：**每位员工拥有独立的 Namespace、独立的 Pod、独立的加密持久化存储。** 不做共享 Namespace 的折中。

```
hermes-agent-alice/          ← Namespace
  pod/agent                  ← Pod（单实例）
  pvc/agent-data             ← 加密 PersistentVolume
  pvc/agent-memory           ← 加密 PersistentVolume
  serviceaccount/agent       ← 最小权限身份
  networkpolicy/default-deny ← 网络策略（第 6 章）

hermes-agent-bob/            ← 完全独立的 Namespace
  ...
```

#### 为什么不做共享 Namespace 的折中？

| 维度 | 共享 Namespace + Label 隔离 | 每员工独立 Namespace |
|------|---------------------------|---------------------|
| RBAC | 需要复杂 LabelSelector 和精细 Role 配置 | Kubernetes RBAC 天然按 Namespace 隔离 |
| NetworkPolicy | 需要 `podSelector` 精确匹配，配置错误导致越权 | Namespace 级别的默认拒绝，作用域清晰 |
| 审计 | 日志中混杂所有员工，需过滤 Label | `kubectl logs -n hermes-agent-alice` 天然隔离 |
| 误操作影响 | 一个 `kubectl delete` 可能影响所有 Sandbox | Namespace 删除只影响该员工 |
| 管理开销 | 500 个 Pod 在一个 Namespace | 500 个 Namespace，但可通过 Controller 自动化 |

**结论**：管理开销的增加可以通过自动化消除，但隔离的强度一旦做弱就很难事后补救。独立 Namespace 是纵深防御的第一层，不是可选项。

### Sandbox 的 Kubernetes 资源组成

每个员工的 Sandbox 由以下 Kubernetes 资源组成：

| 资源 | 作用 |
|------|------|
| Namespace | 物理隔离边界，所有资源归属其中 |
| Pod | 运行 Hermes Agent 进程（单实例） |
| PersistentVolumeClaim (加密) | 持久化工作目录、Memory、会话 |
| ServiceAccount | 最小权限的工作负载身份 |
| ResourceQuota | 该 Namespace 的资源上限 |
| NetworkPolicy | 网络出站控制（第 6 章） |

### Sandbox 配置详解

以下是一个完整的 Agent Sandbox Pod 配置，每个安全字段都有解释：

```yaml
# examples/05/agent-sandbox.yaml
# 每位员工一个独立 Namespace，此处为 Alice 的完整配置
apiVersion: v1
kind: Namespace
metadata:
  name: hermes-agent-alice
  labels:
    app: hermes-agent
    employee: alice
    tenant: acme-corp
---
apiVersion: v1
kind: Pod
metadata:
  name: agent
  namespace: hermes-agent-alice
  labels:
    app: hermes-agent
    employee: alice
    tenant: acme-corp
spec:
  # --- 安全上下文 ---

  # Seccomp 限制系统调用
  securityContext:
    runAsUser: 1000
    runAsGroup: 1000
    runAsNonRoot: true
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault

  # 自动挂载 ServiceAccount Token 设为 false（默认不需要访问 K8s API）
  automountServiceAccountToken: false

  # --- 容器定义 ---

  containers:
    - name: hermes-agent
      image: ghcr.io/example-org/hermes-agent:v1.2.3
      imagePullPolicy: Always

      # 工作目录
      workingDir: /home/hermes/workspace

      # 命令和参数（由实际 Hermes 镜像决定）
      command: ["/usr/bin/hermes-agent"]
      args:
        - "--config=/etc/hermes/config.yaml"
        - "--workspace=/home/hermes/workspace"
        - "--memory=/home/hermes/memory"

      # --- 安全上下文 ---

      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL

      # --- 资源限制 ---

      resources:
        requests:
          cpu: "500m"
          memory: "1Gi"
        limits:
          cpu: "2"
          memory: "4Gi"

      # --- 端口 ---

      ports:
        - name: api
          containerPort: 8080
          protocol: TCP

      # --- 健康检查 ---

      readinessProbe:
        httpGet:
          path: /healthz
          port: 8080
        initialDelaySeconds: 10
        periodSeconds: 5
        timeoutSeconds: 3
        failureThreshold: 3

      livenessProbe:
        httpGet:
          path: /healthz
          port: 8080
        initialDelaySeconds: 30
        periodSeconds: 15
        timeoutSeconds: 5
        failureThreshold: 3

      # --- 卷挂载 ---

      volumeMounts:
        # 工作目录（可读写）
        - name: workspace
          mountPath: /home/hermes/workspace

        # Memory 存储（可读写）
        - name: memory
          mountPath: /home/hermes/memory

        # 配置文件（只读）
        - name: config
          mountPath: /etc/hermes
          readOnly: true

        # 临时目录（可读写，用于运行时临时文件）
        - name: tmp
          mountPath: /tmp

      # --- 环境变量 ---

      env:
        - name: HERMES_EMPLOYEE_ID
          value: "alice"
        - name: HERMES_TENANT_ID
          value: "acme-corp"
        # 注意：不在此处注入 API Token 或敏感凭证
        # 凭证由 Tool Gateway 在服务端管理（第 8 章）

  # --- 卷定义 ---

  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: agent-data

    - name: memory
      persistentVolumeClaim:
        claimName: agent-memory

    - name: config
      configMap:
        name: agent-config

    - name: tmp
      emptyDir:
        medium: Memory
        sizeLimit: 256Mi
```

### 关键字段解释

**`automountServiceAccountToken: false`**

这是默认设置。Agent Sandbox 不需要访问 Kubernetes API。除非有明确需求（例如 Agent 需要查询集群状态，这本身是一个需要严格审批的高风险操作），否则不要开启。

**`runAsNonRoot: true` + `runAsUser: 1000`**

进程以 UID 1000 运行，不是 root。即使进程被攻破，攻击者也不能直接获得 root 权限。`runAsNonRoot: true` 是 Kubernetes 的强制检查——如果镜像的 ENTRYPOINT 是 root，Pod 将无法启动。

**`readOnlyRootFilesystem: true`**

容器的根文件系统是只读的。这防止 Agent 向 `/usr`、`/etc` 等系统目录写入文件。需要写入的目录（workspace、memory、tmp）通过独立的卷挂载。

**`capabilities.drop: ALL`**

Linux capabilities 是比 root 更细粒度的权限控制。`drop: ALL` 移除所有 capabilities（包括 `NET_RAW`、`SYS_ADMIN` 等），只保留进程正常运行所需的最小权限集。如果 Hermes 需要绑定 1024 以下的端口（一般不需要），可以单独添加 `NET_BIND_SERVICE`。

**`allowPrivilegeEscalation: false`**

禁止进程通过 `setuid`、`setgid` 或 capabilities 提升权限。即使进程执行了 `sudo` 或 SUID 二进制文件，也无法获得更高权限。

**`tmp` 使用 `emptyDir` with `medium: Memory`**

`/tmp` 挂载为 tmpfs（内存文件系统），限制 256 MiB。这有两个好处：
1. 临时文件不写磁盘，Sandbox 销毁后自动清除。
2. 限制大小，防止 Agent 通过临时文件消耗过多磁盘空间。

### ServiceAccount 配置

```yaml
# examples/05/agent-service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: agent-alice
  namespace: hermes-agents
automountServiceAccountToken: false
---
# 如果确实需要访问 K8s API（例如查询自身 Pod 状态），
# 使用最小权限 RoleBinding。绝大多数场景不需要。
# 
# apiVersion: rbac.authorization.k8s.io/v1
# kind: Role
# metadata:
#   name: agent-self-read
#   namespace: hermes-agents
# rules:
#   - apiGroups: [""]
#     resources: ["pods"]
#     verbs: ["get"]
#     resourceNames: ["agent-alice"]  # 只能读取自己的 Pod
# ---
# apiVersion: rbac.authorization.k8s.io/v1
# kind: RoleBinding
# metadata:
#   name: agent-alice-self-read
#   namespace: hermes-agents
# subjects:
#   - kind: ServiceAccount
#     name: agent-alice
# roleRef:
#   kind: Role
#   name: agent-self-read
#   apiGroup: rbac.authorization.k8s.io
```

**关键原则**：`automountServiceAccountToken: false` 是默认值。只有当 Agent 明确需要访问 Kubernetes API 时，才创建对应的 Role 和 RoleBinding，并且 `resourceNames` 限定到具体的资源名称（例如只能读取自己的 Pod）。

### ResourceQuota 和 LimitRange

```yaml
# examples/05/resource-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: agent-alice-quota
  namespace: hermes-agents
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.cpu: "4"
    limits.memory: 8Gi
    pods: "1"
    persistentvolumeclaims: "3"
```

```yaml
# examples/05/limit-range.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: agent-default-limits
  namespace: hermes-agents
spec:
  limits:
    - type: Container
      default:
        cpu: "1"
        memory: 2Gi
      defaultRequest:
        cpu: 500m
        memory: 1Gi
      max:
        cpu: "4"
        memory: 8Gi
      min:
        cpu: 100m
        memory: 128Mi
```

ResourceQuota 限制该员工 Sandbox 的总资源消耗（防止创建大量 Pod 消耗集群资源）。LimitRange 为容器设置默认的 request 和 limit，以及上下限。

### 持久化存储：每员工一个独立 Namespace、一个 Pod、一个加密 Volume

每个员工的 Sandbox 在其独立 Namespace 中只挂载**一个**加密的 PersistentVolume，用于存储工作目录和 Memory：

```yaml
# examples/05/pvc.yaml
# Alice 的 Namespace 中的存储配置

---
# 1. 使用 encrypted StorageClass（由云提供商或本地 CSI 驱动提供）
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: encrypted-ssd
provisioner: kubernetes.io/no-provisioner  # 替换为实际 CSI，如 ebs.csi.aws.com
parameters:
  encrypted: "true"                        # AWS EBS 加密
  kmsKeyId: "alias/hermes-agent-key"       # 指定 KMS 密钥
  fsType: ext4
volumeBindingMode: WaitForFirstConsumer
---
# 2. 每员工 Namespace 中只创建一个 PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: agent-data                         # 该 Namespace 中唯一的 Volume
  namespace: hermes-agent-alice
spec:
  accessModes:
    - ReadWriteOnce                        # 只能被一个 Pod 挂载
  storageClassName: encrypted-ssd
  resources:
    requests:
      storage: 20Gi
```

**一个 Volume 而不是多个**：工作目录和 Memory 放在同一个加密 PVC 下的不同子目录中（通过 `subPath` 或 Pod 内路径区分），减少存储管理的复杂度，同时保持加密覆盖全部持久化数据。

**加密方式取决于存储后端**：

| 存储后端 | 加密方式 | 说明 |
|----------|----------|------|
| AWS EBS | EBS Encryption + KMS | 卷在创建时自动加密，解密在节点侧透明完成 |
| GCP PD | GCE PD Encryption + Cloud KMS | 同上 |
| Azure Disk | Azure Disk Encryption / SSE + CMK | 支持客户管理的密钥（CMK） |
| Ceph RBD | LUKS + cryptsetup | 需要 CSI 驱动支持，或使用 Ceph 原生加密 |
| Local PV | dm-crypt / LUKS | 手动加密，适合测试环境 |

**每员工一个 KMS 密钥还是共享？**

- **共享 KMS 密钥**（推荐起步方案）：所有员工的 Volume 使用同一个 KMS key，管理简单。如果 KMS key 泄露，所有 Volume 都受影响。
- **每员工一个 KMS 密钥**：更强的隔离，但 KMS key 数量随员工增长。适合合规要求严格的环境。

**为什么必须加密？** 第 8 章的安全边界表会提到：

| 威胁 | 未加密 | 加密 |
|------|--------|------|
| 存储后端被入侵（如 Ceph 节点被攻破） | 数据明文可读 | 数据被加密保护 |
| PVC 备份文件泄露 | Memory 内容完全暴露 | 需要 KMS key 才能解密 |
| 磁盘退役后数据残留 | 物理介质可能被恢复 | 密钥销毁即不可读 |

## 实现步骤

### 5.1 Control Plane 创建 Sandbox 的流程

Control Plane 在以下时机创建 Sandbox：

1. **员工首次登录**（第 4 章的 OIDC 流程完成后）
2. **管理员手动激活**
3. **Sandbox 被回收后重新激活**

创建流程：

```
Control Plane 收到员工登录事件
    │
    ├─ 检查是否已有活跃 Sandbox
    │   ├─ 有 → 检查健康状态，不健康则重建
    │   └─ 无 → 创建新 Sandbox
    │
    ├─ 生成 Kubernetes 资源
    │   ├─ PVC（workspace、memory）
    │   ├─ ConfigMap（Agent 配置）
    │   ├─ ServiceAccount（最小权限）
    │   └─ Pod（Hermes Agent）
    │
    ├─ 应用 NetworkPolicy（第 6 章）
    │
    ├─ 等待 Pod Ready（Readiness Probe 通过）
    │
    └─ 更新元数据：employee → sandbox 映射
```

以下是一个 Control Plane 创建 Sandbox 的 TypeScript 示例：

```typescript
// examples/05/control-plane-sandbox.ts
// 注意：这是简化示例，实际生产环境需要更完善的错误处理和重试逻辑

import * as k8s from "@kubernetes/client-node";

interface SandboxConfig {
  employeeId: string;
  tenantId: string;
  image: string;
  storage: string;         // e.g., "20Gi"
  storageClass: string;    // e.g., "encrypted-ssd"
  cpuLimit: string;        // e.g., "2"
  memoryLimit: string;     // e.g., "4Gi"
}

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);

const AGENT_IMAGE = "ghcr.io/example-org/hermes-agent:v1.2.3";

async function createSandbox(config: SandboxConfig): Promise<void> {
  const { employeeId, tenantId } = config;
  const ns = `hermes-agent-${employeeId}`;

  // 1. 创建 Namespace（如果不存在）
  await createNamespace(ns, employeeId, tenantId);

  // 2. 检查是否已有 Sandbox
  try {
    await coreV1.readNamespacedPod("agent", ns);
    console.log(`Sandbox already exists for ${employeeId}`);
    return;
  } catch (err: any) {
    if (err.statusCode !== 404) throw err;
  }

  // 3. 创建加密 PVC
  await createEncryptedPVC(ns, config.storage, config.storageClass);

  // 4. 创建 ConfigMap
  await createConfigMap(ns, employeeId, tenantId);

  // 5. 创建 ServiceAccount
  await createServiceAccount(ns, employeeId);

  // 6. 创建 Pod
  const pod: k8s.V1Pod = {
    metadata: {
      name: "agent",
      namespace: ns,
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
        seccompProfile: { type: "RuntimeDefault" },
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
            { name: "data", mountPath: "/home/hermes" },
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
          name: "data",
          persistentVolumeClaim: { claimName: "agent-data" },
        },
        {
          name: "config",
          configMap: { name: "agent-config" },
        },
        {
          name: "tmp",
          emptyDir: { medium: "Memory", sizeLimit: "256Mi" },
        },
      ],
    },
  };

  await coreV1.createNamespacedPod(ns, pod);
  console.log(`Created sandbox for ${employeeId} in namespace ${ns}`);

  // 7. 应用 NetworkPolicy（第 6 章）
  // await applyNetworkPolicy(ns);

  // 8. 等待 Pod Ready
  await waitForPodReady("agent", ns);
}

async function createNamespace(ns: string, employeeId: string, tenantId: string): Promise<void> {
  try {
    await coreV1.readNamespace(ns);
    return; // 已存在
  } catch (err: any) {
    if (err.statusCode !== 404) throw err;
  }

  const namespaceObj: k8s.V1Namespace = {
    metadata: {
      name: ns,
      labels: {
        app: "hermes-agent",
        employee: employeeId,
        tenant: tenantId,
      },
    },
  };
  await coreV1.createNamespace(namespaceObj);
}

async function createEncryptedPVC(ns: string, storage: string, storageClass: string): Promise<void> {
  const pvc: k8s.V1PersistentVolumeClaim = {
    metadata: { name: "agent-data", namespace: ns },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: storageClass,
      resources: { requests: { storage } },
    },
  };
  try {
    await coreV1.createNamespacedPersistentVolumeClaim(ns, pvc);
  } catch (err: any) {
    if (err.statusCode !== 409) throw err; // AlreadyExists
  }
}

async function createConfigMap(
  ns: string,
  employeeId: string,
  tenantId: string
): Promise<void> {
  const cm: k8s.V1ConfigMap = {
    metadata: { name: "agent-config", namespace: ns },
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
    await coreV1.createNamespacedConfigMap(ns, cm);
  } catch (err: any) {
    if (err.statusCode !== 409) throw err;
  }
}

async function createServiceAccount(ns: string, _employeeId: string): Promise<void> {
  const sa: k8s.V1ServiceAccount = {
    metadata: { name: "agent", namespace: ns },
    automountServiceAccountToken: false,
  };
  try {
    await coreV1.createNamespacedServiceAccount(ns, sa);
  } catch (err: any) {
    if (err.statusCode !== 409) throw err;
  }
}

async function waitForPodReady(name: string, ns: string, timeoutMs = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pod = await coreV1.readNamespacedPod(name, ns);
      const ready = pod.status?.conditions?.some(
        (c) => c.type === "Ready" && c.status === "True"
      );
      if (ready) return;
    } catch {
      // Pod not yet created
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Pod ${name} in ${ns} did not become ready within ${timeoutMs}ms`);
}
```

### 5.2 使用 Deployment 还是直接管理 Pod？

上面的示例直接创建 Pod。实际生产中有两种选择：

| 方案 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| 直接创建 Pod | 每员工一个独立实例，需要精细控制 | 完全控制 Pod 规格 | 需要自己处理重启、更新 |
| Deployment（replicas: 1） | 需要自动重启、滚动更新 | Kubernetes 自动管理生命周期 | 增加 ReplicaSet 资源开销 |

**建议**：使用 Deployment 而非直接创建 Pod。原因：

1. **自动重启**：如果 Agent 进程崩溃，Deployment 自动重启 Pod。
2. **滚动更新**：当 Hermes Agent 镜像更新时，Deployment 支持滚动更新（虽然每员工一个 Deployment 会带来管理开销，但可以用 Controller 自动化）。
3. **健康检查集成**：Deployment 的 `spec.strategy` 可以控制更新策略。

```yaml
# examples/05/agent-deployment.yaml
# 部署到 Alice 的 Namespace: kubectl apply -f agent-deployment.yaml -n hermes-agent-alice
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent
  namespace: hermes-agent-alice
  labels:
    app: hermes-agent
    employee: alice
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hermes-agent
      employee: alice
  strategy:
    type: Recreate  # Agent 不支持多实例同时运行
  template:
    metadata:
      labels:
        app: hermes-agent
        employee: alice
        tenant: acme-corp
    spec:
      # ... 与上面的 Pod spec 相同 ...
```

**注意 `strategy.type: Recreate`**：因为每个员工的 Sandbox 只运行一个 Agent 实例，且 Agent 可能在运行中有状态（正在执行工具调用），使用 `Recreate` 而非 `RollingUpdate`，确保旧 Pod 完全终止后再启动新 Pod。

## 容器运行时安全的纵深防御

容器安全不是单一配置能解决的，需要多层防御。每一层单独看都不够，但组合起来大幅降低了风险。

### 层 1：用户与权限

```yaml
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  runAsNonRoot: true
  fsGroup: 1000
```

- **`runAsNonRoot: true`**：Kubernetes 在启动容器前检查镜像的 USER。如果是 root，拒绝启动。
- **`runAsUser: 1000`**：明确指定 UID。如果镜像没有设置 USER，以 UID 1000 运行。
- **`fsGroup: 1000`**：挂载的卷的文件组 ID 设为 1000，确保进程能读写 PVC。

**为什么要同时设置 `runAsNonRoot` 和 `runAsUser`？** 因为如果镜像的 Dockerfile 设置了 `USER root`，仅设置 `runAsUser` 不会覆盖它。`runAsNonRoot: true` 是强制检查：无论镜像设置什么，都不能以 root 运行。

### 层 2：只读根文件系统

```yaml
securityContext:
  readOnlyRootFilesystem: true
```

容器根文件系统（`/usr`、`/bin`、`/lib` 等）只读。Agent 无法：
- 向 `/usr/local/bin` 写入恶意脚本
- 修改 `/etc/hosts` 进行 DNS 欺骗
- 向 `/tmp` 之外的系统目录写入文件

需要写入的目录通过独立卷挂载：
- `/home/hermes/workspace` → PVC（工作文件）
- `/home/hermes/memory` → PVC（Memory）
- `/tmp` → emptyDir（临时文件）

### 层 3：Capabilities

```yaml
securityContext:
  capabilities:
    drop:
      - ALL
```

Linux capabilities 列表（`capsh --print` 可查看完整列表）包含约 40 项权限，包括：

| Capability | 权限 | 为什么要移除 |
|------------|------|-------------|
| `NET_RAW` | 使用 RAW socket，可构造任意网络包 | 可用于网络扫描、ARP 欺骗 |
| `SYS_ADMIN` | 大量系统管理权限（挂载、加载模块等） | 几乎是 root 权限 |
| `SYS_PTRACE` | 追踪其他进程 | 可读取其他进程内存 |
| `DAC_OVERRIDE` | 绕过文件权限检查 | 即使不是 root 也能读任意文件 |
| `CHOWN` | 修改文件所有者 | 可修改其他用户的文件权限 |

**`drop: ALL`** 移除所有 capabilities。如果 Hermes Agent 需要特定能力（例如需要绑定 1024 以下端口），单独添加：

```yaml
capabilities:
  drop:
    - ALL
  add:
    - NET_BIND_SERVICE  # 仅当需要绑定 < 1024 端口时
```

绝大多数 Agent 场景不需要任何 capabilities。

### 层 4：Seccomp

```yaml
securityContext:
  seccompProfile:
    type: RuntimeDefault
```

Seccomp（Secure Computing Mode）限制进程可以调用的系统调用。`RuntimeDefault` 使用容器运行时（containerd/CRI-O）的默认 seccomp 配置文件，只允许常用的系统调用（`read`、`write`、`open`、`close`、`socket` 等），阻断危险系统调用（如 `ptrace`、`mount`、`reboot`）。

**与 capabilities 的区别**：capabilities 控制"可以做什么操作"，seccomp 控制"可以调用哪些系统调用"。两者互补。

### 层 5：资源限制

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "1Gi"
  limits:
    cpu: "2"
    memory: "4Gi"
```

- **requests**：调度时的保证资源。Kubernetes 确保 Pod 调度到有足够资源的节点。
- **limits**：硬上限。超过 CPU limit 会被节流（throttle），超过 memory limit 会被 OOM Kill。

**为什么要同时设置 requests 和 limits？**

- 只设置 limits 不设置 requests：requests 默认等于 limits，导致调度器认为该 Pod 需要全部 limit 资源，降低集群调度效率。
- 只设置 requests 不设置 limits：Pod 可以消耗无限资源，可能影响同节点的其他 Pod。

**进程数量限制**：Hermes Agent 在执行某些工具（如 Shell 命令、代码执行）时可能创建子进程。可以通过 LimitRange 间接控制，或在容器内设置 `ulimit -u`（最大进程数）。

```yaml
# 在容器启动命令中添加
command: ["/bin/sh", "-c"]
args:
  - |
    ulimit -u 256  # 最大 256 个进程
    exec /usr/bin/hermes-agent --config=/etc/hermes/config.yaml
```

**执行时间限制**：对于 Agent 的单次工具调用（如 Shell 命令），应在 Hermes Agent 层面设置超时，而非在 Kubernetes 层面。Kubernetes 的 `activeDeadlineSeconds` 适用于整个 Job，不是单个工具调用。

## 更强隔离：gVisor 和 Kata Containers

标准容器（runc）共享宿主机的 Linux 内核。这意味着：

- 如果存在内核漏洞（如 CVE-2021-4034 "PwnKit"、CVE-2022-0847），容器进程可能逃逸到宿主机。
- 对于执行不可信 Shell 或代码的场景（Agent 可能被 Prompt Injection 诱导执行任意命令），标准容器的隔离可能不够。

### gVisor

[gVisor](https://gvisor.dev/) 是 Google 开发的容器沙箱。它在容器进程和宿主机内核之间插入一个用户态内核（`runsc`），拦截系统调用并在用户态处理。

```yaml
# gVisor RuntimeClass
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
---
# Pod 使用 gVisor（在员工的 Namespace 中）
apiVersion: v1
kind: Pod
metadata:
  name: agent
  namespace: hermes-agent-alice
spec:
  runtimeClassName: gvisor
  # ... 其他配置不变 ...
```

**gVisor 的优势**：
- 容器进程无法直接调用宿主机内核的系统调用。
- 对大多数内核逃逸攻击有强防护。
- 兼容 OCI 运行时，使用方式与标准容器相同。

**gVisor 的限制**：
- 不完全支持所有系统调用。某些 Hermes Agent 依赖的功能（如 FUSE 挂载、特定网络功能）可能不可用。
- 性能开销：系统调用需要通过用户态内核处理，CPU 密集场景有 10-20% 的性能损失。
- 不是形式验证的系统——仍可能存在 gVisor 自身的漏洞。

### Kata Containers

[Kata Containers](https://katacontainers.io/) 为每个 Pod 运行一个轻量级虚拟机（VM），容器进程在 VM 内运行。

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata
handler: kata
---
# Pod 使用 Kata（在员工的 Namespace 中）
apiVersion: v1
kind: Pod
metadata:
  name: agent
  namespace: hermes-agent-alice
spec:
  runtimeClassName: kata
  # ... 其他配置不变 ...
```

**Kata 的优势**：
- 硬件级别的隔离（通过 VM）。即使容器进程完全控制了 VM 内的系统，也无法直接影响宿主机。
- 对内核逃逸攻击的防护强于 gVisor。

**Kata 的限制**：
- 更高的资源开销：每个 Pod 需要独立的 VM 内核，内存开销增加约 100-200 MiB。
- 启动时间更长：VM 启动比容器启动慢数秒。
- 需要 CPU 虚拟化支持（Intel VT-x / AMD-V）。

### 选型建议

| 场景 | 推荐方案 | 理由 |
|------|----------|------|
| Agent 执行可信工具（内部 API 调用、文档查询） | 标准容器 + 纵深防御 | 性能最好，隔离足够 |
| Agent 可能执行不可信 Shell 命令 | gVisor | 防护内核逃逸，性能开销可接受 |
| 高安全要求（金融、政府）或执行不可信代码 | Kata Containers | 最强隔离，资源开销可接受 |

**重要提醒**：无论选择哪种方案，都不能替代其他安全措施（网络策略、Tool Gateway 授权、最小权限）。更强隔离是纵深防御的又一层，不是替代。

## Sandbox 生命周期管理

### 创建

Control Plane 在员工首次登录或管理员激活时创建 Sandbox（见 5.1 节）。

### 运行中

- **健康检查**：Readiness Probe 和 Liveness Probe 监控 Agent 状态。
- **自动重启**：Deployment 在进程崩溃时自动重启 Pod。
- **资源监控**：通过 OpenTelemetry（第 10 章）监控 CPU、内存、磁盘使用量。

### 暂停

当员工长期不使用 Agent（例如休假），Control Plane 可以暂停 Sandbox 以节省资源：

```yaml
# 将 Deployment replicas 设为 0
# kubectl scale deployment agent-alice --replicas=0 -n hermes-agents
```

- PVC 保留，数据不丢失。
- 网络策略保留（但无 Pod 时不生效）。
- 恢复时只需将 replicas 设为 1。

### 回收

当员工离职或被禁用时，Control Plane 执行回收流程：

```
1. 将 Pod replicas 设为 0（停止 Pod）
2. 导出审计日志和会话记录（归档到长期存储）
3. 销毁加密 Volume 的 KMS key 或标记 Volume 待删除
4. 删除整个 Namespace（级联删除其中所有资源）
5. 等待 PVC 终止（可选：保留一段过渡期后删除）
6. 更新元数据：标记员工为"已回收"
```

```typescript
// examples/05/sandbox-recycle.ts
async function recycleSandbox(employeeId: string): Promise<void> {
  const ns = `hermes-agent-${employeeId}`;

  // 1. 停止 Pod
  await appsV1.patchNamespacedDeploymentScale(
    "agent",
    ns,
    { spec: { replicas: 0 } } as k8s.V1Deployment
  );

  // 2. 导出审计日志（伪代码）
  await exportAuditLogs(employeeId);

  // 3. 销毁 KMS key 或标记 Volume 待删除
  await destroyEncryptionKey(employeeId);

  // 4. 删除整个 Namespace（级联删除其中所有资源）
  await coreV1.deleteNamespace(ns);

  // 5. 更新元数据：标记员工为"已回收"
  await markEmployeeRecycled(employeeId);
}
```

### 故障恢复

| 故障 | 检测方式 | 恢复方式 |
|------|----------|----------|
| Agent 进程崩溃 | Liveness Probe 失败 | Deployment 自动重启 |
| 节点故障 | Pod 状态 NotReady | Deployment 在其他节点重建 |
| PVC 损坏 | Agent 启动失败 | 从备份恢复 PVC 数据 |
| 镜像拉取失败 | Pod 状态 ImagePullBackOff | 检查镜像仓库凭证和网络 |
| 内存超限 (OOM) | Pod 被 OOM Kill | 调查原因（可能是内存泄漏），调整 limit 或修复代码 |

**自动恢复的限制**：自动重启不解决根本原因。如果 Agent 因为特定输入反复崩溃，需要：
1. 从审计日志查看崩溃前的操作。
2. 修复 Hermes Agent 的 bug 或调整配置。
3. 必要时由管理员手动介入。

## 验证实验与预期结果

以下实验在 Kubernetes 测试集群中执行，验证 Sandbox 隔离的有效性。

### 实验 1：Namespace 隔离验证

**目标**：验证员工 A 的 Namespace 中的资源对员工 B 不可见。

**步骤**：

```bash
# 1. 在 Alice 的 Namespace 中查看资源
kubectl get all -n hermes-agent-alice

# 2. 在 Bob 的 Namespace 中查看资源
kubectl get all -n hermes-agent-bob

# 3. 尝试从 Bob 的 Pod 访问 Alice 的 Namespace
kubectl exec -n hermes-agent-bob agent -- \
  sh -c 'curl -s http://agent.hermes-agent-alice.svc.cluster.local:8080/healthz'
```

**预期结果**：第一条和第二条命令各自只看到自己的资源。第三条命令失败（连接被拒绝或 DNS 解析失败），因为 NetworkPolicy 禁止跨 Namespace 访问（第 6 章）。

### 实验 2：存储隔离与加密验证

**目标**：验证每个 Namespace 有独立的加密 PVC。

**步骤**：

```bash
# 1. 在 Alice 的 Pod 中写入文件
kubectl exec -n hermes-agent-alice agent -- \
  sh -c 'echo "secret from alice" > /home/hermes/workspace/alice-secret.txt'

# 2. 尝试在 Bob 的 Pod 中读取 Alice 的文件
kubectl exec -n hermes-agent-bob agent -- \
  sh -c 'cat /home/hermes/workspace/alice-secret.txt'

# 3. 验证 PVC 加密状态（以 AWS EBS 为例）
kubectl get pvc agent-data -n hermes-agent-alice -o jsonpath='{.spec.storageClassName}'
# 输出应为 "encrypted-ssd" 或类似的加密 StorageClass
```

**预期结果**：第二条命令失败（文件不存在）。Bob 的 PVC 是独立的，无法访问 Alice 的数据。

### 实验 3：进程隔离

**目标**：验证员工 A 的 Agent 无法看到或影响员工 B 的进程。

**步骤**：

```bash
# 1. 在 Alice 的 Namespace 中查看进程
kubectl exec -n hermes-agent-alice agent -- ps aux

# 2. 在 Bob 的 Namespace 中查看进程
kubectl exec -n hermes-agent-bob agent -- ps aux
```

**预期结果**：两个 Namespace 各自只能看到自己的进程（通常只有 hermes-agent 进程和其子进程）。看不到对方的进程。

### 实验 4：非 root 用户验证

**目标**：验证 Agent 进程不是以 root 运行。

**步骤**：

```bash
kubectl exec -n hermes-agent-alice agent -- id
```

**预期结果**：

```
uid=1000 gid=1000 groups=1000
```

而不是 `uid=0 (root)`。

### 实验 5：只读根文件系统验证

**目标**：验证无法向系统目录写入文件。

**步骤**：

```bash
# 尝试向 /usr/local/bin 写入文件
kubectl exec -n hermes-agent-alice agent -- \
  sh -c 'echo "malicious" > /usr/local/bin/backdoor'
```

**预期结果**：写入失败，返回 `Read-only file system` 错误。

```bash
# 但可以向 workspace 写入
kubectl exec -n hermes-agent-alice agent -- \
  sh -c 'echo "workspace file" > /home/hermes/workspace/test.txt && cat /home/hermes/workspace/test.txt'
```

**预期结果**：成功写入和读取。

### 实验 6：Capabilities 验证

**目标**：验证进程没有任何 capabilities。

**步骤**：

```bash
kubectl exec -n hermes-agent-alice agent -- cat /proc/1/status | grep Cap
```

**预期结果**：所有 capabilities 为 0。

```
CapInh: 0000000000000000
CapPrm: 0000000000000000
CapEff: 0000000000000000
CapBnd: 0000000000000000
CapAmb: 0000000000000000
```

如果任何一行不是全 0，说明还有 capabilities 未被移除。

### 实验 7：ResourceQuota 验证

**目标**：验证无法超过资源限制。

**步骤**：

```bash
# 在 Alice 的 Namespace 中消耗大量内存（超过 limit）
kubectl exec -n hermes-agent-alice agent -- \
  python3 -c 'import sys; x = "A" * (5 * 1024 * 1024 * 1024)'
```

**预期结果**：进程被 OOM Kill（返回 `Killed` 或退出码 137）。

```bash
kubectl get pod agent -n hermes-agent-alice -o jsonpath='{.status.containerStatuses[0].lastState}'
```

返回 `reason: OOMKilled`。

### 实验 8：Namespace 级删除验证

**目标**：验证删除一个 Namespace 不会影响其他员工的 Sandbox。

**步骤**：

```bash
# 1. 确认 Bob 的 Sandbox 正常运行
kubectl get pod agent -n hermes-agent-bob

# 2. 删除 Alice 的整个 Namespace
kubectl delete namespace hermes-agent-alice

# 3. 验证 Bob 的 Sandbox 仍然正常运行
kubectl get pod agent -n hermes-agent-bob
```

**预期结果**：删除 Alice 的 Namespace 后，Bob 的 Sandbox 不受任何影响。这验证了 Namespace 隔离的有效性。

## 常见问题与故障排查

### Pod 无法启动：`RunAsNonRoot` 检查失败

**症状**：Pod 状态为 `CreateContainerConfigError`，事件日志显示：

```
Error: container has runAsNonRoot and image will run as root
```

**原因**：Hermes Agent 镜像的 Dockerfile 没有设置 `USER`，或设置为 `USER root`。

**解决**：在 Dockerfile 中添加：

```dockerfile
RUN adduser --disabled-password --uid 1000 hermes
USER hermes
```

### PVC 无法挂载

**症状**：Pod 状态为 `ContainerCreating`，事件日志显示：

```
Unable to attach or mount volumes: timed out waiting for the condition
```

**原因**：可能是存储 Provisioner 未正确配置，或 PVC 的 `storageClassName` 不匹配。

**解决**：

```bash
kubectl get storageclass  # 确认可用的 StorageClass
kubectl describe pvc workspace-alice -n hermes-agents  # 查看详细事件
```

### Agent 启动后立即退出

**症状**：Pod 进入 `CrashLoopBackOff` 状态。

**排查步骤**：

```bash
# 查看日志
kubectl logs agent-alice -n hermes-agents

# 查看上一次退出码
kubectl get pod agent-alice -n hermes-agents -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}'

# 进入容器调试（如果容器还能启动）
kubectl exec -it agent-alice -n hermes-agents -- sh
```

**常见原因**：
- 配置文件路径错误
- 环境变量缺失
- 权限问题（PVC 挂载的目录权限与 UID 1000 不匹配）

### 容器内无法写入文件

**症状**：Agent 尝试写入文件时报 `Read-only file system`。

**原因**：`readOnlyRootFilesystem: true` 生效，但尝试写入的目录没有通过卷挂载。

**解决**：确认所有需要写入的目录都在 `volumeMounts` 中声明：
- `/home/hermes/workspace` → PVC
- `/home/hermes/memory` → PVC
- `/tmp` → emptyDir

如果 Hermes Agent 需要写入其他目录（例如 `/var/log/hermes`），添加对应的 emptyDir 卷。

## 安全边界、取舍与剩余风险

### 本章方案能防范什么

| 威胁 | 防范机制 | 有效性 |
|------|----------|--------|
| 员工 A 读取员工 B 的文件 | 独立 Namespace + 独立 PVC | 强 |
| 员工 A 的 Namespace 被误删影响员工 B | Namespace 隔离 | 强 |
| Agent 修改系统文件 | 只读根文件系统 | 强 |
| 容器进程以 root 运行 | runAsNonRoot + UID 1000 | 强 |
| 进程使用危险 capabilities | drop: ALL | 强 |
| 进程通过系统调用攻击内核 | Seccomp RuntimeDefault | 中（取决于 seccomp 配置覆盖度） |
| 单个 Agent 消耗过多资源 | ResourceQuota | 强 |
| Agent 访问 Kubernetes API | automountServiceAccountToken: false | 强 |
| 存储后端被入侵时数据泄露 | PVC 加密 | 强 |
| PVC 备份文件泄露 | 需要 KMS key 才能解密 | 强 |

### 本章方案不能防范什么

| 威胁 | 需要补充的措施 |
|------|----------------|
| Agent 被 Prompt Injection 误导后通过 Tool Gateway 发起恶意工具调用 | Tool Gateway 授权 + 审批（第 7、9 章） |
| Agent 通过网络直接连接外部系统 | NetworkPolicy + Egress Proxy（第 6 章） |
| 内核漏洞导致容器逃逸（标准容器） | gVisor 或 Kata Containers |
| Hermes Agent 镜像中的供应链漏洞 | 镜像签名验证、SBOM、漏洞扫描（第 12 章） |
| KMS key 泄露导致加密 Volume 可被解密 | KMS key 轮换、访问审计、每员工独立 key |
| 控制平面被攻破后任意 Namespace 操作 | 控制平面自身的安全加固（第 13、14 章） |

### 取舍

1. **每员工一个独立 Namespace**：管理开销增加，但可通过 Controller 自动化。隔离的强度一旦做弱就很难事后补救，独立 Namespace 是纵深防御的第一层。
2. **一个加密 Volume 而非多个**：工作目录和 Memory 放在同一个加密 PVC 下，减少存储管理复杂度，加密覆盖全部持久化数据。
3. **Deployment vs 直接创建 Pod**：选择了 Deployment，牺牲了少量控制粒度，换取自动重启和更新能力。
4. **标准容器 vs gVisor vs Kata**：默认使用标准容器 + 纵深防御，因为大多数企业 Agent 执行的是可信工具调用。当 Agent 需要执行不可信 Shell 或代码时，升级到 gVisor 或 Kata。
5. **只读根文件系统**：增加了运维复杂度（需要预先知道所有写入路径），但大幅减少了攻击面。
6. **加密存储的权衡**：加密增加了少量 I/O 延迟（通常 < 5%），但防止了存储后端被入侵时的数据泄露。对于高合规要求的行业（金融、医疗、政府），加密是强制要求。

## 本章小结

本章完成了为每位员工构建隔离 Agent Sandbox 的设计：

1. **核心原则**：One Person, One Namespace, One Pod, One Encrypted Volume。不做共享 Namespace 的折中。
2. **Namespace 隔离**：Kubernetes RBAC 天然按 Namespace 隔离，NetworkPolicy 作用域清晰，删除操作影响范围可控。
3. **纵深防御**：非 root、只读根文件系统、移除所有 capabilities、Seccomp、资源限制。
4. **加密持久化存储**：每个员工一个独立的加密 PVC，使用云提供商或 CSI 驱动提供的加密 StorageClass。
5. **最小权限身份**：`automountServiceAccountToken: false`，默认不访问 Kubernetes API。
6. **生命周期管理**：创建、暂停、回收和故障恢复的完整流程。回收时通过 `kubectl delete namespace` 级联删除。
7. **更强隔离**：当标准容器不够时，使用 gVisor 或 Kata Containers。

Sandbox 解决了计算和存储隔离的问题。但 Agent 仍然可能通过网络访问未授权的目标，或向 Tool Gateway 发起恶意工具调用——这分别由第 6 章（网络策略）和第 7 章（Tool Gateway 授权）解决。

## 参考资料

- Kubernetes Pod 安全标准：https://kubernetes.io/docs/concepts/security/pod-security-standards/
- Kubernetes Security Context：https://kubernetes.io/docs/tasks/configure-pod-container/security-context/
- Linux Capabilities 详解：https://man7.org/linux/man-pages/man7/capabilities.7.html
- Seccomp 配置文件：https://kubernetes.io/docs/tutorials/security/seccomp/
- gVisor 文档：https://gvisor.dev/docs/
- Kata Containers 文档：https://katacontainers.io/docs/
- Kubernetes ResourceQuota：https://kubernetes.io/docs/concepts/policy/resource-quotas/
- Kubernetes LimitRange：https://kubernetes.io/docs/concepts/policy/limit-range/
- 参考案例：Razorpay Hermes 部署的网络隔离与 Sandbox 实践 https://engineering.razorpay.com/running-hermes-at-razorpay-a-network-isolated-self-improving-second-brain-for-every-employee-f91d56bea3f1
