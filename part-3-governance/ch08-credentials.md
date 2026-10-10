# 第 8 章：凭证管理与权限最小化

> 状态：待撰写

## 本章目标

避免 Agent 直接持有不必要的长期凭证，并降低凭证泄露后的影响范围。

## 建议内容

- 环境变量中的长期 Token 有哪些风险
- Vault、云 Secret Manager 与 KMS 的职责
- Workload Identity / IRSA 的工作机制
- 临时凭证与长期凭证的选择
- Agent Sandbox 与企业 API 凭证之间的边界
- 令牌轮换、吊销与泄露响应
- 防止 Agent 通过日志、Memory 或工具输出泄露凭证

## 本章产出

- 凭证访问架构
- 最小权限配置示例
- 凭证轮换与吊销流程
