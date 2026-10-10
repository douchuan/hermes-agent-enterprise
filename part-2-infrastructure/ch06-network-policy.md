# 第 6 章：使用 Cilium 控制 Agent 的网络访问

> 状态：待撰写

## 本章目标

通过网络层强制执行出站访问策略，防止 Agent 仅通过修改应用配置绕过代理。

## 建议内容

- 为什么设置 `HTTP_PROXY` / `HTTPS_PROXY` 还不够
- Kubernetes NetworkPolicy 与 CiliumNetworkPolicy
- eBPF 在网络策略执行中的作用
- 默认拒绝出站流量（Default-Deny Egress）
- 只允许 Agent 访问指定代理服务
- DNS、集群内部服务和外部目标的访问规则
- 使用 Cilium 观测被拒绝的连接
- 代理绕过测试与常见配置错误
- 网络策略的边界：不等于 HTTPS 内容审计，也不等于完整的主机安全隔离

## 建议实验

让 Hermes 尝试绕过 CrabTrap 直接访问外网，并验证 Cilium 阻断该连接。随后验证通过代理访问获准目标仍然可用。

## 本章产出

- 可验证的网络隔离实验
- Cilium 策略配置
- 出站流量测试清单
