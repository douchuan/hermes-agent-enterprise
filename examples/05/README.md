# examples/05

Agent Sandbox Kubernetes 资源示例。

## 文件清单

| 文件 | 说明 |
|------|------|
| `agent-sandbox.yaml` | 完整的 Pod 配置（Namespace + Pod + volumes） |
| `agent-deployment.yaml` | Deployment 版本（replicas: 1, Recreate 策略） |
| `agent-service-account.yaml` | ServiceAccount + 注释版的 Role/RoleBinding |
| `resource-quota.yaml` | Namespace 资源配额 |
| `limit-range.yaml` | 容器默认资源和上下限 |
| `pvc.yaml` | 加密 StorageClass + 每员工 PVC |
| `volume-snapshot-class.yaml` | EBS 快照类配置 |
| `volume-snapshot.yaml` | PVC 快照创建 |
| `pvc-restore.yaml` | 从快照恢复 PVC |
| `control-plane-sandbox.ts` | Control Plane 创建 Sandbox 的 TypeScript 示例 |
| `sandbox-recycle.ts` | 员工离职 Sandbox 回收流程 |

## 使用方法

```bash
# 部署到特定 Namespace
kubectl apply -f agent-sandbox.yaml -n hermes-agent-alice

# 创建加密 PVC
kubectl apply -f pvc.yaml -n hermes-agent-alice

# 创建快照
kubectl apply -f volume-snapshot.yaml -n hermes-agent-alice

# 从快照恢复
kubectl apply -f pvc-restore.yaml -n hermes-agent-alice
```
