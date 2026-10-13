# 术语表

| 术语 | 简要说明 |
|---|---|
| Agent Loop | Agent 根据模型输出调用工具、接收结果并继续决策的循环 |
| Agent Identity | 平台分配给每位员工的长期稳定 Agent 标识（如 `agent-alice-001`），不因 Pod 重建而改变 |
| Agent Runtime Instance | 承载 Agent 的 Kubernetes Pod 或进程，可重建，与 Agent Identity 分离 |
| Agent Persistent State | 与 Agent Identity 绑定的 Memory、Skills、Sessions、Workspace 数据 |
| Control Plane | 负责身份、策略、资源编排与生命周期管理的控制平面 |
| Identity & Authorization Manager | Control Plane 的子组件，负责员工→Agent 身份映射、权限计算和组织变更触发权限重算 |
| Credential Store / Credential Broker | 为 Tool Gateway 提供临时凭证和资源级 Token 的服务，实现授权与凭证持有的分离 |
| Delegated Authorization | 员工主动委托 Agent 代表自己访问第三方服务的授权模式（如 OAuth） |
| External Auth Connection | 员工与外部服务（如 GitHub）之间的授权连接记录，包含 scope、状态和部门绑定 |
| Sandbox | 限制 Agent 执行权限和影响范围的隔离运行环境 |
| OIDC | 基于 OAuth 2.0 的身份认证协议层 |
| PKCE | 用于降低授权码被截获后遭滥用风险的机制 |
| MCP | 用于连接模型应用与工具/上下文服务的协议 |
| Tool Gateway | 统一承接工具调用、授权和审计的服务层 |
| Egress | 从工作负载向外发起的网络流量 |
| Workload Identity | 将运行中的工作负载与特定身份绑定的机制 |
| Prompt Injection | 通过恶意或不可信内容影响模型指令执行的攻击方式 |
| Memory | Agent 的长期记忆，包含经过提炼的事实和技能。是历史上下文，不是授权凭证 |
| Skill | Agent 的任务能力模块，描述如何完成特定任务。是操作指南，不是访问资源的许可证 |
| Personal Agent | 每位员工绑定的长期 Hermes Agent，持续积累 Memory、Skills 和会话 |
