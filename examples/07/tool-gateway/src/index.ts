// Tool Gateway — Entry Point (reference implementation)
//
// 这是参考实现/待实现设计，尚未在真实第三方服务上验证。
//
// 生产环境需要：
// - Express / Fastify 作为 HTTP 服务器
// - MCP SDK 作为工具传输层（stdio 或 HTTP）
// - mTLS 双向认证验证调用方身份
// - 真实的 Credential Store（Vault / AWS Secrets Manager）
// - 真实的审计存储（S3 / 独立数据库）
// - 真实的 Tool Adapter 实现
// - 网络策略和容器安全加固

export { ToolGateway, InMemoryApprovalStore } from "./gateway.js";
export { InMemoryAuditStore, sanitizeForAudit } from "./audit.js";
export { InMemoryIdempotencyStore, generateIdempotencyKey } from "./idempotency.js";
export { checkAuthorization, hashParameters } from "./authorization.js";
export { allTools, githubTool, financeTool, calendarTool } from "./tools/definitions.js";
