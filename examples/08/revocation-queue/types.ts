// 第三方授权撤销重试队列
//
// 架构决策：
// - 采用持久化队列 + 指数退避 + 随机抖动
// - 区分错误类型（429/5xx/401/403/不可恢复）
// - 平台侧先阻断，第三方撤销是后续动作
// - 进程重启后任务不丢失
// - 避免并发重试和重复撤销
//
// 默认参数（可配置）：
// - 初始重试间隔：5 秒
// - 退避系数：2（指数退避）
// - 最大重试间隔：300 秒（5 分钟）
// - 最大尝试次数：10
// - 重试截止时间：24 小时
// - 随机抖动：±20%
//
// 这些是参考配置，需要根据实际供应商 API 限制调整。

// 撤销任务状态
export type RevocationStatus =
  | "pending"           // 等待首次尝试
  | "retrying"          // 重试中
  | "succeeded"         // 成功撤销
  | "failed"            // 失败（达到最大次数或截止时间）
  | "manual_review";    // 需要人工处理

// 错误类型分类
export type ErrorType =
  | "rate_limited"      // 429
  | "server_error"      // 5xx
  | "timeout"           // 超时
  | "auth_error"        // 401/403
  | "not_found"         // 已撤销或不存在
  | "irrecoverable";    // 不可恢复错误

export interface RevocationTask {
  id: string;
  employeeId: string;
  tenantId: string;
  agentId: string;
  provider: string;              // "github", "slack", "jira"
  connectionId: string;
  revokeEndpoint: string;
  accessToken?: string;          // 用于撤销的 Token（非访问用）
  createdAt: string;
  nextRetryAt: string;
  retryCount: number;
  status: RevocationStatus;
  lastError?: string;
  lastErrorType?: ErrorType;
  lastHttpStatus?: number;
  // 配置（从策略获取）
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  deadlineAt: string;
}

// 配置
export interface RevocationConfig {
  initialBackoffMs: number;       // 5_000 (5 秒)
  backoffMultiplier: number;      // 2
  maxBackoffMs: number;           // 300_000 (5 分钟)
  maxRetries: number;             // 10
  deadlineHours: number;          // 24
  jitterPercent: number;          // 20
}

// 默认配置
export const DEFAULT_REVOCATION_CONFIG: RevocationConfig = {
  initialBackoffMs: 5_000,
  backoffMultiplier: 2,
  maxBackoffMs: 300_000,
  maxRetries: 10,
  deadlineHours: 24,
  jitterPercent: 20,
};

// 计算下一次重试时间（指数退避 + 随机抖动）
export function calculateNextRetry(
  retryCount: number,
  config: RevocationConfig,
  retryAfterMs?: number  // 429 的 Retry-After
): Date {
  // 如果有 Retry-After，优先使用
  if (retryAfterMs !== undefined) {
    const jitter = retryAfterMs * (config.jitterPercent / 100);
    const jittered = retryAfterMs + (Math.random() - 0.5) * 2 * jitter;
    return new Date(Date.now() + jittered);
  }

  // 指数退避
  const backoff = Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, retryCount),
    config.maxBackoffMs
  );

  // 随机抖动
  const jitter = backoff * (config.jitterPercent / 100);
  const jitteredBackoff = backoff + (Math.random() - 0.5) * 2 * jitter;

  return new Date(Date.now() + jitteredBackoff);
}

// 分类 HTTP 错误
export function classifyHttpError(status: number, body?: string): ErrorType {
  if (status === 429) return "rate_limited";
  if (status >= 500 && status < 600) return "server_error";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) {
    // 某些 4xx 可能是不可恢复的（如无效参数）
    if (body?.includes("invalid_grant") || body?.includes("invalid_token")) {
      return "not_found";  // Token 已失效或已撤销
    }
    return "irrecoverable";
  }
  return "irrecoverable";
}

// 判断是否应该重试
export function shouldRetry(task: RevocationTask, now: Date = new Date()): { retry: boolean; reason: string } {
  if (task.status === "succeeded" || task.status === "failed" || task.status === "manual_review") {
    return { retry: false, reason: `Terminal status: ${task.status}` };
  }

  if (now >= new Date(task.deadlineAt)) {
    return { retry: false, reason: "Past deadline" };
  }

  if (task.retryCount >= task.maxRetries) {
    return { retry: false, reason: `Max retries reached (${task.retryCount}/${task.maxRetries})` };
  }

  // 不可恢复错误 → 不重试，转人工
  if (task.lastErrorType === "irrecoverable") {
    return { retry: false, reason: "Irrecoverable error → manual review" };
  }

  // Token 已不存在 → 视为成功
  if (task.lastErrorType === "not_found") {
    return { retry: false, reason: "Token not found → already revoked" };
  }

  // 还没到重试时间
  if (now < new Date(task.nextRetryAt)) {
    return { retry: false, reason: "Not yet time for next retry" };
  }

  return { retry: true, reason: "Ready to retry" };
}

// 审计事件
export interface RevocationAuditEvent {
  eventType: "REVOCATION_ATTEMPT" | "REVOCATION_SUCCEEDED" | "REVOCATION_FAILED" | "REVOCATION_MANUAL_REVIEW";
  taskId: string;
  employeeId: string;
  agentId: string;
  tenantId: string;
  provider: string;
  connectionId: string;
  retryCount: number;
  status: RevocationStatus;
  errorType?: ErrorType;
  httpStatus?: number;
  errorMessage?: string;
  timestamp: string;
  // 注意：不记录 Token 值
}
