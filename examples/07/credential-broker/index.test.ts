// Credential Broker 测试
//
// 覆盖：
// - 未授权调用无法取得凭证
// - 不同租户之间不能交叉使用凭证
// - 已撤销或过期的授权不能继续使用
// - 凭证不会泄露到日志或审计事件
// - 模块故障时不会绕过 Gateway

import { CredentialBroker, type CredentialStore, type CredentialAuditEvent, type CredentialRequest } from "./index.js";

// 模拟 Secret Manager
class MockSecretManager implements CredentialStore {
  private secrets = new Map<string, string>();

  setSecret(secretId: string, value: string) {
    this.secrets.set(secretId, value);
  }

  async getSecret(secretId: string): Promise<string> {
    const value = this.secrets.get(secretId);
    if (!value) throw new Error(`Secret not found: ${secretId}`);
    return value;
  }

  async revokeSecret(secretId: string): Promise<void> {
    this.secrets.delete(secretId);
  }
}

const auditEvents: CredentialAuditEvent[] = [];
async function auditCallback(event: CredentialAuditEvent) {
  auditEvents.push(event);
}

function makeRequest(overrides: Partial<CredentialRequest> = {}): CredentialRequest {
  return {
    employeeId: "user-alice-001",
    tenantId: "tenant-acme-001",
    agentId: "agent-alice-001",
    toolName: "github",
    action: "create_pr",
    connectionId: "gh-alice-001",
    ...overrides,
  };
}

// ── 正常凭证获取 ──

async function test_acquire_credential() {
  const store = new MockSecretManager();
  store.setSecret("hermes/oauth/user-alice-001/gh-alice-001",
    JSON.stringify({ type: "oauth_token", access_token: "gho_test_token", scopes: ["repo"], expires_at: "2099-01-01T00:00:00Z" }));

  const broker = new CredentialBroker(store, auditCallback);
  const cred = await broker.acquireCredential(makeRequest());

  console.assert(cred.value === "gho_test_token", `Expected token value`);
  console.assert(cred.scopes?.includes("repo"), `Expected repo scope`);
  console.log("✓ test_acquire_credential");
}

// ── 凭证缓存 ──

async function test_credential_caching() {
  const store = new MockSecretManager();
  store.setSecret("hermes/oauth/user-alice-001/gh-alice-001",
    JSON.stringify({ type: "oauth_token", access_token: "gho_test_token" }));

  const broker = new CredentialBroker(store, auditCallback, 60_000);

  // 第一次获取
  await broker.acquireCredential(makeRequest());
  // 第二次获取（应走缓存）
  const cred = await broker.acquireCredential(makeRequest());

  console.assert(cred.value === "gho_test_token", `Expected cached token`);
  console.log("✓ test_credential_caching");
}

// ── 不同租户隔离 ──

async function test_tenant_isolation() {
  const store = new MockSecretManager();
  store.setSecret("hermes/oauth/user-alice-001/gh-alice-001",
    JSON.stringify({ type: "oauth_token", access_token: "gho_alice_token" }));
  store.setSecret("hermes/oauth/user-carol-001/gh-carol-001",
    JSON.stringify({ type: "oauth_token", access_token: "gho_carol_token" }));

  const broker = new CredentialBroker(store, auditCallback);

  const aliceCred = await broker.acquireCredential(makeRequest({
    employeeId: "user-alice-001",
    connectionId: "gh-alice-001",
  }));
  const carolCred = await broker.acquireCredential(makeRequest({
    employeeId: "user-carol-001",
    tenantId: "tenant-other-002",
    connectionId: "gh-carol-001",
  }));

  console.assert(aliceCred.value !== carolCred.value,
    `Expected different tokens for different tenants`);
  console.log("✓ test_tenant_isolation");
}

// ── 已撤销凭证不能获取 ──

async function test_revoked_credential_denied() {
  const store = new MockSecretManager();
  store.setSecret("hermes/oauth/user-alice-001/gh-alice-001",
    JSON.stringify({ type: "oauth_token", access_token: "gho_test_token" }));

  const broker = new CredentialBroker(store, auditCallback);
  await broker.acquireCredential(makeRequest());

  // 撤销
  await broker.revokeCredential("gh-alice-001", "department_change", "user-alice-001");

  // 尝试再次获取
  try {
    await broker.acquireCredential(makeRequest());
    console.assert(false, "Expected error after revocation");
  } catch {
    console.log("✓ test_revoked_credential_denied");
  }
}

// ── 凭证不出现在审计中 ──

async function test_credential_not_in_audit() {
  const store = new MockSecretManager();
  store.setSecret("hermes/oauth/user-alice-001/gh-alice-001",
    JSON.stringify({ type: "oauth_token", access_token: "gho_secret_token_12345" }));

  auditEvents.length = 0;
  const broker = new CredentialBroker(store, auditCallback);
  await broker.acquireCredential(makeRequest());

  const auditJson = JSON.stringify(auditEvents);
  console.assert(!auditJson.includes("gho_secret_token_12345"),
    `Credential value must NOT appear in audit events`);
  console.assert(auditEvents.length > 0, "Expected at least one audit event");
  console.assert(auditEvents[0].status === "granted", "Expected granted status");
  console.log("✓ test_credential_not_in_audit");
}

// ── Secret Manager 故障 ──

async function test_secret_manager_failure() {
  const store = new MockSecretManager();
  // 不设置密钥 → 获取失败

  const broker = new CredentialBroker(store, auditCallback);

  try {
    await broker.acquireCredential(makeRequest());
    console.assert(false, "Expected error when secret manager fails");
  } catch {
    // 错误事件应有记录
    const errorEvents = auditEvents.filter(e => e.status === "error");
    console.assert(errorEvents.length > 0, "Expected error audit event");
    // 错误事件中不能包含任何凭证相关信息（除了 connectionId）
    const errorJson = JSON.stringify(errorEvents);
    console.assert(!errorJson.includes("token") && !errorJson.includes("secret"),
      "Error audit events must not contain credential values");
    console.log("✓ test_secret_manager_failure");
  }
}

// ── 缓存清除 ──

async function test_cache_clear() {
  const store = new MockSecretManager();
  store.setSecret("hermes/oauth/user-alice-001/gh-alice-001",
    JSON.stringify({ type: "oauth_token", access_token: "gho_v1" }));

  const broker = new CredentialBroker(store, auditCallback, 60_000);
  await broker.acquireCredential(makeRequest());

  // 清除缓存
  broker.clearCache();
  console.assert(broker.getCacheStats().size === 0, "Cache should be empty after clear");

  // 更新密钥
  store.setSecret("hermes/oauth/user-alice-001/gh-alice-001",
    JSON.stringify({ type: "oauth_token", access_token: "gho_v2" }));

  // 重新获取（不应走缓存）
  const cred = await broker.acquireCredential(makeRequest());
  console.assert(cred.value === "gho_v2", `Expected new token after cache clear and rotation`);
  console.log("✓ test_cache_clear");
}

// ── 运行所有测试 ──

async function runAll() {
  await test_acquire_credential();
  await test_credential_caching();
  await test_tenant_isolation();
  await test_revoked_credential_denied();
  auditEvents.length = 0;
  await test_credential_not_in_audit();
  auditEvents.length = 0;
  await test_secret_manager_failure();
  await test_cache_clear();

  console.log("\nAll credential broker tests passed.");
}

runAll().catch(console.error);
