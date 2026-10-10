# 第 5 章：Agent Sandbox 示例配置
#
# 本目录包含第 5 章中涉及的 Kubernetes 资源配置。
# 所有配置使用占位符值，部署前需替换为实际环境参数。
#
# 文件清单：
#   agent-sandbox.yaml        - 完整的 Agent Sandbox Pod 配置
#   agent-deployment.yaml     - 使用 Deployment 管理的 Sandbox
#   agent-service-account.yaml - ServiceAccount 和可选的最小权限 RoleBinding
#   resource-quota.yaml       - ResourceQuota 配置
#   limit-range.yaml          - LimitRange 配置
#   pvc.yaml                  - PersistentVolumeClaim 配置
#   control-plane-sandbox.ts  - Control Plane 创建 Sandbox 的 TypeScript 示例
#   sandbox-recycle.ts        - Sandbox 回收流程的 TypeScript 示例
