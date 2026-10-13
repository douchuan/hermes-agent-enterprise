# 配套实验与配置示例

此目录存放书中引用的可复现示例，例如：

- 身份认证与授权（Dex 本地 OIDC + Control Plane 参考实现）
- Kubernetes Sandbox 配置
- CiliumNetworkPolicy 示例
- Tool Gateway 的最小实现
- 审批流程示例
- OpenTelemetry 配置与测试
- 安全验收脚本

每个实验应附带 README，说明版本和前置条件、部署步骤、预期结果、清理方式及安全边界。未经验证的配置应明确标记为示例。

## 目录

| 目录 | 对应章节 | 说明 |
|------|----------|------|
| [`01/`](01/README.md) | 第 1 章 | 单节点 Kubernetes 集群安装脚本 |
| [`04/`](04/README.md) | 第 4 章 | Dex 本地 OIDC 环境（Kubernetes 部署） + Control Plane 最小参考实现 |
| [`05/`](05/README.md) | 第 5 章 | Agent Sandbox 配置（PVC、Deployment、NetworkPolicy 等） |
| [`07/credential-broker/`](07/credential-broker/README.md) | 第 7-8 章 | Credential Broker：临时凭证获取与审计 |
| [`08/revocation-queue/`](08/revocation-queue/README.md) | 第 8 章 | 第三方授权撤销重试队列 |
| [`11/memory-classifier/`](11/memory-classifier/README.md) | 第 11 章 | Memory 敏感信息分类器 |
