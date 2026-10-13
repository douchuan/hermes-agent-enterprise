# 示例：Tool Gateway 参考实现

对应书籍：第 7 章 — 构建 Tool Gateway，统一企业 API 访问

## 目的

演示 Tool Gateway 的完整工具调用处理链路：身份验证 → 多维度授权检查 → 幂等性 → 审批 → 凭证获取 → 执行 → 审计记录。

## 原理

Tool Gateway 承担企业工具调用的统一入口，实施以下安全控制：

1. **调用方身份验证**：通过 mTLS / Workload Identity 独立识别调用方，不信任 Agent 传来的 `employee_id` / `tenant_id` 参数。
2. **多维度授权检查**：外部授权连接状态 → OAuth scope → 跨租户检查 → 企业策略 → 高风险判定。
3. **幂等性处理**：防止 Agent 重试导致重复操作（如重复创建采购申请）。
4. **审批流程**：高风险操作需要审批，审批后校验参数哈希防止篡改。
5. **审计记录**：完整记录调用链路，不记录凭证值。

## 目录结构

| 文件 | 说明 |
|------|------|
| `src/gateway.ts` / `.js` | 核心 Gateway：完整工具调用处理链路 |
| `src/authorization.ts` / `.js` | 多维度授权检查引擎 |
| `src/audit.ts` / `.js` | 审计事件记录与脱敏 |
| `src/idempotency.ts` / `.js` | 幂等性处理 |
| `src/tools/definitions.ts` | 工具定义与参数 schema |
| `src/index.ts` | 统一导出 |
| `index.test.ts` / `.js` | 测试用例 |
| `package.json` | 依赖声明 |

## 运行方式

```bash
cd examples/07/tool-gateway
node index.test.js
```

需要 Node.js 18+。测试不依赖外部服务（使用 mock）。

## 预期结果

测试应全部通过，覆盖以下场景：

| # | 测试 | 预期 |
|---|------|------|
| 1 | 正常创建 PR | ALLOW，返回成功 |
| 2 | 无授权连接 | DENY |
| 3 | 连接已禁用（转岗后） | DENY |
| 4 | 操作不在 scope 范围内 | DENY |
| 5 | 跨租户越权 | DENY |
| 6 | 高风险操作（删除仓库） | REQUIRE_APPROVAL |
| 7 | 审批后参数篡改 | DENY（参数哈希不匹配） |
| 8 | 重试幂等性 | 只执行一次 |
| 9 | 审计日志不含凭证值 | 所有审计事件无 Token |
| 10 | 企业策略拒绝 | DENY |

## 关键设计

- **调用方身份通过独立通道验证**：`CallerIdentity` 由 Gateway 外部（mTLS / 内部 Token）传入，不是从请求参数中提取。
- **授权是多维度的**：不是"Token 存在就放行"，而是综合连接状态、scope、租户、策略和风险等级。
- **审批绑定参数哈希**：防止批准后替换操作内容。
- **幂等性 key 由员工 ID + 工具名 + 操作 + 参数组合生成**：确保相同请求不重复执行。
- **审计不记录凭证值**：只记录连接 ID、操作名、参数名列表和决策结果。

## 安全边界

- 本示例使用内存存储（Map）模拟外部授权连接、审批、审计和幂等性存储。生产环境需要持久化存储。
- 凭证获取和执行是 mock 实现。生产环境需要真实的 Credential Broker 和 Tool Adapter。
- mTLS 身份验证在示例中简化为函数参数传入。生产环境需要真实的双向 TLS 认证。
- 参数哈希使用 JSON 字符串简化实现。生产环境应使用 SHA-256 等加密哈希。

## 生产差距

生产环境需要补充：

- 真实的 mTLS 双向认证基础设施。
- 真实的 Credential Broker（Vault / AWS Secrets Manager 集成）。
- 真实的 Tool Adapter（GitHub API、财务系统 API 等）。
- 持久化审计存储（S3 / 独立数据库，WORM 特性）。
- 持久化幂等性存储（Redis）。
- Express / Fastify HTTP 服务器和 MCP SDK 传输层。
- 网络策略和容器安全加固（第 5、6 章）。
- 日志脱敏和敏感数据过滤（第 10 章）。
