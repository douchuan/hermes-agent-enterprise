# 第 7 章：构建 Tool Gateway，统一企业 API 访问

> 状态：待撰写

## 本章目标

为 Agent 访问企业系统建立统一、可审计且能够实施资源级授权的入口。

## 建议内容

- 为什么不能直接向 Agent 注入所有企业 API Key
- Tool Gateway 的职责与架构
- MCP 的作用：协议标准化不等于授权边界
- 调用方身份、员工身份与资源权限的绑定
- GitHub、Jira、Slack 等系统的连接方式
- OAuth Delegated Access、应用身份与机器人账号的区别
- 细粒度权限：仓库、项目、频道和操作类型
- 速率限制、配额、超时、重试与幂等性
- 防止 Confused Deputy（混淆代理）问题

## 本章产出

- Tool Gateway 参考实现
- 至少一种企业系统集成
- 资源级授权检查
- 未授权访问测试
