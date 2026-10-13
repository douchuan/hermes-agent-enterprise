// Tool Gateway — Audit Logger
//
// 记录工具调用的完整审计事件。
//
// 安全原则：
// - 审计事件中不得记录 Token 值、Refresh Token、Client Secret 或任何秘密值
// - 只记录连接 ID、授权范围（scopes）、状态变化和时间戳
// - 审计事件写入独立存储，不写入普通日志系统

export interface AuditEvent {
  eventType:
    | "TOOL_CALL_RECEIVED"
    | "AUTHORIZATION_CHECKED"
    | "CREDENTIAL_ACQUIRED"
    | "APPROVAL_REQUESTED"
    | "APPROVAL_RESPONDED"
    | "TOOL_CALL_EXECUTED"
    | "TOOL_CALL_DENIED"
    | "PARAMETER_HASH_MISMATCH"
    | "CROSS_TENANT_ACCESS_DENIED"
    | "EXTERNAL_AUTH_REVOCATION_RETRY"
    | "EXTERNAL_AUTH_REVOCATION_ALERT";

  correlationId: string;
  employeeId?: string;
  agentId?: string;
  tenantId?: string;
  sessionId?: string;

  // 工具调用信息
  toolName?: string;
  action?: string;
  resource?: string;
  parameterKeys?: string[];  // 参数名列表（不含值）

  // 授权信息
  authorizationDecision?: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
  authorizationReason?: string;
  externalAuthConnectionId?: string;
  approvalId?: string;

  // 执行信息
  operationStatus?: "success" | "failed" | "denied" | "approval_pending";
  credentialSource?: "oauth_delegated" | "enterprise_app";
  adapterName?: string;
  retryCount?: number;

  // 错误信息
  errorReason?: string;

  initiatedBy: string;
  timestamp: string;
}

// 审计存储接口
export interface AuditStore {
  write(event: AuditEvent): Promise<void>;
}

// 内存审计存储（测试用）
export class InMemoryAuditStore implements AuditStore {
  private events: AuditEvent[] = [];

  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  getEvents(): AuditEvent[] {
    return [...this.events];
  }

  getEventsByCorrelationId(correlationId: string): AuditEvent[] {
    return this.events.filter(e => e.correlationId === correlationId);
  }

  clear(): void {
    this.events = [];
  }
}

// 日志脱敏：确保敏感信息不进入审计事件
export function sanitizeForAudit(data: unknown): unknown {
  const SENSITIVE_KEYS = [
    "token", "access_token", "refresh_token", "client_secret",
    "password", "api_key", "secret", "authorization",
  ];

  if (typeof data !== "object" || data === null) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeForAudit);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = sanitizeForAudit(value);
    }
  }

  return sanitized;
}
