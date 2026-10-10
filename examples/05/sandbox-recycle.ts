// Sandbox 回收流程 —— 员工离职或账号禁用时执行
// 对应第 5 章"回收"部分
//
// 注意：这是简化示例。实际生产环境需要：
// - 审计日志导出的完整实现
// - PVC 备份的完整实现（快照或数据复制）
// - 错误处理和回滚逻辑

import * as k8s from "@kubernetes/client-node";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const NAMESPACE = "hermes-agents";

async function recycleSandbox(employeeId: string): Promise<void> {
  console.log(`Starting sandbox recycle for ${employeeId}`);

  // 1. 停止 Pod（将 Deployment replicas 设为 0）
  try {
    await appsV1.patchNamespacedDeploymentScale(
      `agent-${employeeId}`,
      NAMESPACE,
      { spec: { replicas: 0 } } as k8s.V1Deployment
    );
    console.log(`Stopped deployment agent-${employeeId}`);
  } catch (err: any) {
    if (err.statusCode !== 404) throw err;
    console.log(`Deployment agent-${employeeId} not found, skipping stop`);
  }

  // 2. 导出审计日志和会话记录（归档到长期存储）
  await exportAuditLogs(employeeId);

  // 3. 备份 Memory PVC（按企业保留策略）
  await backupPVC(`memory-${employeeId}`);

  // 4. 删除资源
  const resources = [
    { type: "deployment", name: `agent-${employeeId}` },
    { type: "serviceaccount", name: `agent-${employeeId}` },
    { type: "configmap", name: `agent-${employeeId}-config` },
    { type: "pvc", name: `workspace-${employeeId}` },
    { type: "pvc", name: `memory-${employeeId}` },
  ];

  for (const { type, name } of resources) {
    try {
      switch (type) {
        case "deployment":
          await appsV1.deleteNamespacedDeployment(name, NAMESPACE);
          break;
        case "serviceaccount":
          await coreV1.deleteNamespacedServiceAccount(name, NAMESPACE);
          break;
        case "configmap":
          await coreV1.deleteNamespacedConfigMap(name, NAMESPACE);
          break;
        case "pvc":
          await coreV1.deleteNamespacedPersistentVolumeClaim(name, NAMESPACE);
          break;
      }
      console.log(`Deleted ${type} ${name}`);
    } catch (err: any) {
      if (err.statusCode !== 404) {
        console.error(`Failed to delete ${type} ${name}: ${err.message}`);
      }
    }
  }

  // 5. 更新元数据：标记员工为"已回收"
  await markEmployeeRecycled(employeeId);

  console.log(`Completed sandbox recycle for ${employeeId}`);
}

// 以下为伪代码占位函数
async function exportAuditLogs(_employeeId: string): Promise<void> {
  // 从审计系统导出该员工的日志和会话记录
  // 实际实现取决于第 10 章的可观测性架构
}

async function backupPVC(_pvcName: string): Promise<void> {
  // 使用 VolumeSnapshot 或数据复制工具备份 PVC
  // 实际实现取决于存储后端（第 8 章涉及凭证管理）
}

async function markEmployeeRecycled(_employeeId: string): Promise<void> {
  // 更新 PostgreSQL 中的员工记录，标记为已回收
}
