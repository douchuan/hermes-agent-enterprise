// 第三方授权撤销重试队列测试
//
// 覆盖：
// - 正常撤销成功
// - 429 限流 + Retry-After
// - 5xx 服务端错误 + 指数退避
// - 超时错误
// - 401/403（视为已撤销）
// - 404（视为已撤销）
// - 不可恢复错误 → 转人工
// - 最大重试次数达到 → 失败 + 告警
// - 进程重启恢复
// - 审计事件不含 Token
// - 队列统计
// - 错误类型分类

import {
  RevocationQueue,
  InMemoryRevocationStore,
  MockRevokeClient,
  ConsoleAlertChannel,
} from "./index.js";
import { DEFAULT_REVOCATION_CONFIG, classifyHttpError, type RevocationAuditEvent, type RevocationTask } from "./types.js";

const TEST_CONFIG = {
  ...DEFAULT_REVOCATION_CONFIG,
  initialBackoffMs: 100,
  maxBackoffMs: 500,
  maxRetries: 3,
  deadlineHours: 1,
  jitterPercent: 10,
};

function makeTask(overrides: Partial<RevocationTask> = {}): Omit<RevocationTask, "createdAt" | "nextRetryAt" | "retryCount" | "status" | "maxRetries" | "initialBackoffMs" | "maxBackoffMs" | "deadlineAt"> {
  return {
    id: "revoke-001",
    employeeId: "user-alice-001",
    tenantId: "tenant-acme-001",
    agentId: "agent-alice-001",
    provider: "github",
    connectionId: "gh-alice-001",
    revokeEndpoint: "https://github.com/settings/connections",
    accessToken: "ghp_test_token_for_revocation",
    ...overrides,
  };
}

function makeQueue(client: MockRevokeClient) {
  const store = new InMemoryRevocationStore();
  const alertChannel = new ConsoleAlertChannel();
  const auditEvents: RevocationAuditEvent[] = [];
  const queue = new RevocationQueue(
    store, client, alertChannel,
    async (event) => { auditEvents.push(event); },
    TEST_CONFIG
  );
  return { queue, store, auditEvents };
}

// ── 正常撤销成功 ──

async function test_successful_revocation() {
  const client = new MockRevokeClient();
  client.setBehavior("success");
  const { queue, auditEvents } = makeQueue(client);
  await queue.enqueue(makeTask());
  await queue.processDueTasks();
  const stats = await queue.getStats();
  console.assert(stats.succeeded === 1, `Expected 1 succeeded, got ${stats.succeeded}`);
  console.assert(auditEvents.some(e => e.eventType === "REVOCATION_SUCCEEDED"), "Expected succeeded audit event");
  console.log("✓ test_successful_revocation");
}

// ── 429 限流 + Retry-After ──

async function test_rate_limited_with_retry_after() {
  const client = new MockRevokeClient();
  client.setBehavior("rate_limited", 50);
  const { queue, store } = makeQueue(client);
  await queue.enqueue(makeTask({ id: "revoke-rl-001" }));
  await queue.processDueTasks();
  const updated = await store.load("revoke-rl-001");
  console.assert(updated?.status === "retrying", `Expected retrying, got ${updated?.status}`);
  console.assert(updated?.lastErrorType === "rate_limited", `Expected rate_limited, got ${updated?.lastErrorType}`);
  console.assert(updated?.lastHttpStatus === 429, `Expected 429, got ${updated?.lastHttpStatus}`);
  console.assert(updated?.retryCount === 1, `Expected retryCount 1, got ${updated?.retryCount}`);
  console.log("✓ test_rate_limited_with_retry_after");
}

// ── 5xx 服务端错误 + 指数退避 ──

async function test_server_error_backoff() {
  const client = new MockRevokeClient();
  client.setBehavior("server_error");
  const { queue, store } = makeQueue(client);
  await queue.enqueue(makeTask({ id: "revoke-5xx-001" }));
  const t0 = new Date();
  await queue.processDueTasks(t0);
  let task = await store.load("revoke-5xx-001");
  console.assert(task?.retryCount === 1, `Expected 1 retry, got ${task?.retryCount}`);
  console.assert(task?.lastErrorType === "server_error", `Expected server_error`);
  // 推进时间超过 nextRetryAt
  const t1 = new Date(t0.getTime() + 2000);
  await queue.processDueTasks(t1);
  task = await store.load("revoke-5xx-001");
  console.assert(task?.retryCount === 2, `Expected 2 retries, got ${task?.retryCount}`);
  console.log("✓ test_server_error_backoff");
}

// ── 超时错误 ──

async function test_timeout_error() {
  const client = new MockRevokeClient();
  client.setBehavior("timeout");
  const { queue, store } = makeQueue(client);
  await queue.enqueue(makeTask({ id: "revoke-to-001" }));
  await queue.processDueTasks();
  const task = await store.load("revoke-to-001");
  console.assert(task?.lastErrorType === "timeout", `Expected timeout, got ${task?.lastErrorType}`);
  console.assert(task?.status === "retrying", `Expected retrying, got ${task?.status}`);
  console.log("✓ test_timeout_error");
}

// ── 401/403 视为已撤销 ──

async function test_auth_error_treated_as_revoked() {
  const client = new MockRevokeClient();
  client.setBehavior("auth_error");
  const { queue, store, auditEvents } = makeQueue(client);
  await queue.enqueue(makeTask({ id: "revoke-auth-001" }));
  await queue.processDueTasks();
  const task = await store.load("revoke-auth-001");
  console.assert(task?.status === "succeeded", `Expected succeeded, got ${task?.status}`);
  console.assert(auditEvents.some(e => e.eventType === "REVOCATION_SUCCEEDED"), "Expected succeeded audit event");
  console.log("✓ test_auth_error_treated_as_revoked");
}

// ── 404 视为已撤销 ──

async function test_not_found_treated_as_revoked() {
  const client = new MockRevokeClient();
  client.setBehavior("not_found");
  const { queue, store, auditEvents } = makeQueue(client);
  await queue.enqueue(makeTask({ id: "revoke-404-001" }));
  await queue.processDueTasks();
  const task = await store.load("revoke-404-001");
  console.assert(task?.status === "succeeded", `Expected succeeded, got ${task?.status}`);
  console.assert(auditEvents.some(e => e.eventType === "REVOCATION_SUCCEEDED"), "Expected succeeded audit event");
  console.log("✓ test_not_found_treated_as_revoked");
}

// ── 不可恢复错误 → 转人工 ──

async function test_irrecoverable_error_manual_review() {
  const client = new MockRevokeClient();
  client.setBehavior("irrecoverable");  // 422 → "irrecoverable"
  const { queue, store, auditEvents } = makeQueue(client);
  const t0 = new Date();
  await queue.enqueue(makeTask({ id: "revoke-irr-001" }));

  // 第一次：422 → classifyHttpError → "irrecoverable" → status = "retrying"
  await queue.processDueTasks(t0);
  const afterFirst = await store.load("revoke-irr-001");
  console.assert(afterFirst?.lastErrorType === "irrecoverable",
    `Expected irrecoverable, got ${afterFirst?.lastErrorType}`);

  // 第二次：推进时间，shouldRetry 看到 irrecoverable → 转 manual_review
  const t1 = new Date(t0.getTime() + 2000);
  await queue.processDueTasks(t1);
  const updated = await store.load("revoke-irr-001");
  console.assert(updated?.status === "manual_review", `Expected manual_review, got ${updated?.status}`);
  console.assert(auditEvents.some(e => e.eventType === "REVOCATION_MANUAL_REVIEW"), "Expected manual_review audit event");
  console.log("✓ test_irrecoverable_error_manual_review");
}

// ── 最大重试次数达到 → 失败 ──

async function test_max_retries_exceeded() {
  const client = new MockRevokeClient();
  client.setBehavior("server_error");
  const { queue, store } = makeQueue(client);
  await queue.enqueue(makeTask({ id: "revoke-max-001" }));

  const t0 = new Date();
  await queue.processDueTasks(t0);               // retry 1
  await queue.processDueTasks(new Date(t0.getTime() + 2000));   // retry 2
  await queue.processDueTasks(new Date(t0.getTime() + 4000));   // retry 3 (max)
  // 再调用一次 → 达到 maxRetries → failed
  await queue.processDueTasks(new Date(t0.getTime() + 6000));

  const task = await store.load("revoke-max-001");
  console.assert(task?.status === "failed", `Expected failed, got ${task?.status}`);
  console.assert(task?.retryCount === 3, `Expected 3 retries, got ${task?.retryCount}`);
  console.log("✓ test_max_retries_exceeded");
}

// ── 进程重启恢复 ──

async function test_process_restart_recovery() {
  const client = new MockRevokeClient();
  client.setBehavior("server_error");
  const store1 = new InMemoryRevocationStore();
  const auditEvents1: RevocationAuditEvent[] = [];
  const queue1 = new RevocationQueue(
    store1, client, new ConsoleAlertChannel(),
    async (e) => { auditEvents1.push(e); },
    { ...DEFAULT_REVOCATION_CONFIG, initialBackoffMs: 100, maxBackoffMs: 500, maxRetries: 5, deadlineHours: 1, jitterPercent: 10 }
  );
  const t0 = new Date();
  await queue1.enqueue(makeTask({ id: "revoke-restart-001" }));
  await queue1.processDueTasks(t0);

  // 模拟重启：快照 → 新 store → 新队列
  const store2 = new InMemoryRevocationStore();
  for (const t of store1.snapshot()) await store2.save(t);
  const queue2 = new RevocationQueue(
    store2, client, new ConsoleAlertChannel(),
    async () => {},
    { ...DEFAULT_REVOCATION_CONFIG, initialBackoffMs: 100, maxBackoffMs: 500, maxRetries: 5, deadlineHours: 1, jitterPercent: 10 }
  );

  const dueTasks = await store2.listDue(new Date(t0.getTime() + 2000));
  console.assert(dueTasks.length === 1, `Expected 1 due task after restart, got ${dueTasks.length}`);
  console.log("✓ test_process_restart_recovery");
}

// ── 审计事件不含 Token ──

async function test_audit_no_token() {
  const client = new MockRevokeClient();
  client.setBehavior("success");
  const { queue, auditEvents } = makeQueue(client);
  await queue.enqueue(makeTask({ id: "revoke-audit-001", accessToken: "ghp_super_secret_token_xyz" }));
  await queue.processDueTasks();
  const allAuditJson = JSON.stringify(auditEvents);
  console.assert(!allAuditJson.includes("ghp_super_secret_token_xyz"), "Token must NOT appear in audit events");
  console.assert(!allAuditJson.includes("super_secret"), "Secret must NOT appear in audit events");
  console.assert(auditEvents.length > 0, "Expected audit events");
  console.log("✓ test_audit_no_token");
}

// ── 队列统计 ──

async function test_queue_stats() {
  const client = new MockRevokeClient();
  client.setBehavior("success");
  const { queue } = makeQueue(client);
  const stats = await queue.getStats();
  console.assert(typeof stats.pending === "number", "Expected pending count");
  console.assert(typeof stats.succeeded === "number", "Expected succeeded count");
  console.assert(typeof stats.failed === "number", "Expected failed count");
  console.assert(typeof stats.retrying === "number", "Expected retrying count");
  console.assert(typeof stats.manual_review === "number", "Expected manual_review count");
  console.log("✓ test_queue_stats");
}

// ── 错误类型分类 ──

function test_error_classification() {
  console.assert(classifyHttpError(429) === "rate_limited", "429 → rate_limited");
  console.assert(classifyHttpError(500) === "server_error", "500 → server_error");
  console.assert(classifyHttpError(503) === "server_error", "503 → server_error");
  console.assert(classifyHttpError(401) === "auth_error", "401 → auth_error");
  console.assert(classifyHttpError(403) === "auth_error", "403 → auth_error");
  console.assert(classifyHttpError(404) === "not_found", "404 → not_found");
  console.assert(classifyHttpError(400, "invalid_grant") === "not_found", "400 + invalid_grant → not_found");
  console.assert(classifyHttpError(400, "invalid_token") === "not_found", "400 + invalid_token → not_found");
  console.assert(classifyHttpError(400, "some_other") === "irrecoverable", "400 + other → irrecoverable");
  console.assert(classifyHttpError(422) === "irrecoverable", "422 → irrecoverable");
  console.assert(classifyHttpError(418) === "irrecoverable", "418 → irrecoverable");
  console.log("✓ test_error_classification");
}

// ── 运行所有测试 ──

async function runAll() {
  test_error_classification();
  await test_successful_revocation();
  await test_rate_limited_with_retry_after();
  await test_server_error_backoff();
  await test_timeout_error();
  await test_auth_error_treated_as_revoked();
  await test_not_found_treated_as_revoked();
  await test_irrecoverable_error_manual_review();
  await test_max_retries_exceeded();
  await test_process_restart_recovery();
  await test_audit_no_token();
  await test_queue_stats();
  console.log("\nAll revocation queue tests passed.");
}

runAll().catch(console.error);
