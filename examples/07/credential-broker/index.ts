// Credential Broker — 第一阶段：Tool Gateway 内置模块
//
// 架构决策：
// - 第一阶段作为 Tool Gateway 的内部模块部署，不作为独立服务
// - 保持清晰的内部模块边界：独立接口、独立审计、独立错误处理
// - 拆分条件：独立安全团队审计、需要独立扩缩、或需要单独部署策略时
//
// 为什么不立即拆为独立服务？
// - 第一阶段的平台规模不需要独立扩缩容
// - 增加服务间网络调用增加凭证暴露面
// - 增加部署复杂度但收益有限
// - Tool Gateway 已经有明确的信任边界和网络隔离
//
// 什么时候应该拆分？
// - 需要独立的安全团队审核和维护凭证服务
// - 需要为不同租户/企业提供独立的凭证服务实例
// - 需要独立的审计和合规报告
// - Tool Gateway 的扩缩与凭证获取频率不匹配
//
// 拆分条件（任一触发）：
// - 平台支持 > 5000 名员工，凭证获取成为瓶颈
// - 合规要求独立的凭证服务审计
// - 安全团队要求凭证服务有独立的部署和变更流程
// - 需要支持 Token Exchange（RFC 8693）等复杂凭证流转

import type { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// ── 凭证类型 ──

export interface Credential {
  type: "oauth_token" | "app_installation_token" | "api_key" | "short_lived_token";
  value: string;
  expiresAt?: Date;
  scopes?: string[];
}

export interface CredentialRequest {
  employeeId: string;
  tenantId: string;
  agentId: string;
  toolName: string;
  action: string;
  resource?: string;
  connectionId: string;
}

export interface CredentialAuditEvent {
  timestamp: string;
  employeeId: string;
  tenantId: string;
  agentId: string;
  toolName: string;
  action: string;
  connectionId: string;
  credentialType: string;
  status: "granted" | "denied" | "expired" | "error";
  reason?: string;
  // 注意：绝不记录凭证值
}

// ── 凭证存储接口 ──

export interface CredentialStore {
  getSecret(secretId: string): Promise<string>;
  revokeSecret(secretId: string): Promise<void>;
}

// 云 Secret Manager 适配器
export class CloudSecretManager implements CredentialStore {
  private client: SecretsManagerClient;

  constructor(client: SecretsManagerClient) {
    this.client = client;
  }

  async getSecret(secretId: string): Promise<string> {
    const { GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const command = new GetSecretValueCommand({ SecretId: secretId });
    const response = await this.client.send(command);
    if (!response.SecretString) {
      throw new Error(`Secret ${secretId} has no string value`);
    }
    return response.SecretString;
  }

  async revokeSecret(secretId: string): Promise<void> {
    const { DeleteSecretCommand } = await import("@aws-sdk/client-secrets-manager");
    const command = new DeleteSecretCommand({ SecretId: secretId });
    await this.client.send(command);
  }
}

// ── Credential Broker 模块 ──

export class CredentialBroker {
  private store: CredentialStore;
  private auditCallback: (event: CredentialAuditEvent) => Promise<void>;
  // 内存缓存：connectionId → Credential（短期持有，不持久化）
  private cache = new Map<string, { credential: Credential; fetchedAt: number }>();
  private readonly cacheTtlMs: number;

  constructor(
    store: CredentialStore,
    auditCallback: (event: CredentialAuditEvent) => Promise<void>,
    cacheTtlMs = 300_000 // 5 分钟缓存
  ) {
    this.store = store;
    this.auditCallback = auditCallback;
    this.cacheTtlMs = cacheTtlMs;
  }

  // 核心方法：获取凭证
  async acquireCredential(request: CredentialRequest): Promise<Credential> {
    const auditEvent: CredentialAuditEvent = {
      timestamp: new Date().toISOString(),
      employeeId: request.employeeId,
      tenantId: request.tenantId,
      agentId: request.agentId,
      toolName: request.toolName,
      action: request.action,
      connectionId: request.connectionId,
      credentialType: "",
      status: "denied",
    };

    try {
      // 1. 检查缓存（短期持有）
      const cached = this.cache.get(request.connectionId);
      if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
        if (cached.credential.expiresAt && cached.credential.expiresAt < new Date()) {
          this.cache.delete(request.connectionId);
        } else {
          auditEvent.status = "granted";
          auditEvent.credentialType = cached.credential.type;
          await this.auditCallback(auditEvent);
          return cached.credential;
        }
      }

      // 2. 从 Secret Manager 获取
      const secretId = `hermes/oauth/${request.employeeId}/${request.connectionId}`;
      const secretJson = await this.store.getSecret(secretId);
      const parsed = JSON.parse(secretJson);

      const credential: Credential = {
        type: parsed.type || "oauth_token",
        value: parsed.access_token,
        expiresAt: parsed.expires_at ? new Date(parsed.expires_at) : undefined,
        scopes: parsed.scopes || [],
      };

      // 3. 短期缓存
      this.cache.set(request.connectionId, { credential, fetchedAt: Date.now() });

      auditEvent.status = "granted";
      auditEvent.credentialType = credential.type;
      await this.auditCallback(auditEvent);
      return credential;
    } catch (error) {
      auditEvent.status = "error";
      auditEvent.reason = error instanceof Error ? error.message : "unknown error";
      await this.auditCallback(auditEvent);
      throw error;
    }
  }

  // 撤销凭证（转岗、离职、安全事件）
  async revokeCredential(connectionId: string, reason: string, employeeId?: string): Promise<void> {
    // 从缓存清除
    this.cache.delete(connectionId);

    // 从 Secret Manager 删除（需要知道 employeeId 来构建路径）
    const secretId = employeeId
      ? `hermes/oauth/${employeeId}/${connectionId}`
      : `hermes/oauth/revoke/${connectionId}`;
    try {
      await this.store.revokeSecret(secretId);
    } catch (error) {
      // 记录但不清除本地状态
      console.error(`[credential-broker] Revoke failed for ${connectionId}:`, error);
    }
  }

  // 强制清除所有缓存（凭证轮换后）
  clearCache(): void {
    this.cache.clear();
  }

  // 获取缓存统计（运维用）
  getCacheStats(): { size: number; keys: string[] } {
    return { size: this.cache.size, keys: Array.from(this.cache.keys()) };
  }
}
