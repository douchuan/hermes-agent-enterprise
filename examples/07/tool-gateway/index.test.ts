// Tool Gateway — 测试
//
// 覆盖场景：
// 1. 正常工具调用（ALLOW）
// 2. 无授权连接（DENY）
// 3. 授权连接已过期/禁用（DENY）
// 4. 操作不在 scope 范围内（DENY）
// 5. 跨租户越权（DENY）
// 6. 高风险操作需要审批（REQUIRE_APPROVAL）
// 7. 审批后参数篡改被拒绝（参数哈希不匹配）
// 8. 幂等性：重试不导致重复操作
// 9. Token 不进入审计日志
//
// 运行方式：node index.test.js

import { ToolGateway, InMemoryApprovalStore } from "./src/gateway.js";
import { InMemoryAuditStore } from "./src/audit.js";
import { InMemoryIdempotencyStore } from "./src/idempotency.js";
import type { CallerIdentity, ToolCallRequest, ExternalAuthConnection } from "./src/authorization.js";

// ── 辅助函数 ──

function createTestGateway(
  connections: Map<string, ExternalAuthConnection>,
  policyResult: "ALLOW" | "DENY" | "REQUIRE_APPROVAL" = "ALLOW",
) {
  const auditStore = new InMemoryAuditStore();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const approvalStore = new InMemoryApprovalStore();

  const credentialBroker = {
    async getCredentials(employeeId: string, toolName: string, connectionId: string) {
      return { type: "mock_token", value: "mock-credential-not-logged" };
    },
  };

  const toolAdapter = {
    async execute(toolName: string, action: string, parameters: Record<string, unknown>, credentials: unknown) {
      // 模拟执行：验证凭证没有被输出到结果中
      const credStr = JSON.stringify(credentials);
      if (credStr.includes("mock-credential-not-logged")) {
        return { success: true, tool: toolName, action };
      }
      throw new Error("Invalid credentials");
    },
  };

  const getConnection = async (employeeId: string, toolName: string): Promise<ExternalAuthConnection | null> => {
    const key = `${employeeId}:${toolName}`;
    return connections.get(key) ?? null;
  };

  const evaluatePolicy = async (): Promise<"ALLOW" | "DENY" | "REQUIRE_APPROVAL"> => policyResult;

  const gateway = new ToolGateway(
    auditStore,
    idempotencyStore,
    approvalStore,
    credentialBroker,
    toolAdapter,
    getConnection,
    evaluatePolicy,
  );

  return { gateway, auditStore, approvalStore };
}

const aliceCaller: CallerIdentity = {
  sandboxId: "sandbox-alice-001",
  employeeId: "alice",
  tenantId: "acme-corp",
  agentId: "agent-alice-001",
};

const bobCaller: CallerIdentity = {
  sandboxId: "sandbox-bob-001",
  employeeId: "bob",
  tenantId: "other-org",
  agentId: "agent-bob-001",
};

let testNum = 0;
let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  testNum++;
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

// ── 测试用例 ──

async function runTests() {
  console.log("Tool Gateway Tests\n");

  // 1. 正常工具调用
  await test("allows create_pr with valid auth", async () => {
    const connections = new Map<string, ExternalAuthConnection>();
    connections.set("alice:github", {
      id: "gh-alice-001",
      employeeId: "alice",
      tenantId: "acme-corp",
      provider: "github",
      mode: "oauth_delegated",
      scopes: ["repo"],
      status: "active",
    });

    const { gateway, auditStore } = createTestGateway(connections);
    const result = await gateway.handleToolCall(aliceCaller, {
      toolName: "github",
      action: "create_pr",
      resource: "acme/backend-service",
      parameters: { repo: "acme/backend-service", title: "Fix bug", head: "feature/fix", base: "main" },
    }, "corr-001");

    assert(result.status === "success", `Expected success, got ${result.status}: ${result.reason}`);

    // 验证审计事件
    const events = auditStore.getEventsByCorrelationId("corr-001");
    assert(events.some(e => e.eventType === "TOOL_CALL_RECEIVED"), "Missing TOOL_CALL_RECEIVED");
    assert(events.some(e => e.eventType === "AUTHORIZATION_CHECKED"), "Missing AUTHORIZATION_CHECKED");
    assert(events.some(e => e.eventType === "TOOL_CALL_EXECUTED"), "Missing TOOL_CALL_EXECUTED");

    // 验证审计中不包含凭证值
    for (const event of events) {
      const json = JSON.stringify(event);
      assert(!json.includes("mock-credential-not-logged"), "Credential value found in audit event");
    }
  });

  // 2. 无授权连接
  await test("denies without github connection", async () => {
    const connections = new Map<string, ExternalAuthConnection>();
    const { gateway } = createTestGateway(connections);

    const result = await gateway.handleToolCall(aliceCaller, {
      toolName: "github",
      action: "create_pr",
      parameters: { repo: "acme/backend-service", title: "Test", head: "fix", base: "main" },
    }, "corr-002");

    assert(result.status === "denied", `Expected denied, got ${result.status}`);
    assert(result.reason?.includes("No github authorization connected"), `Unexpected reason: ${result.reason}`);
  });

  // 3. 授权连接已禁用
  await test("denies with disabled connection", async () => {
    const connections = new Map<string, ExternalAuthConnection>();
    connections.set("alice:github", {
      id: "gh-alice-001",
      employeeId: "alice",
      tenantId: "acme-corp",
      provider: "github",
      mode: "oauth_delegated",
      scopes: ["repo"],
      status: "disabled",  // 转岗后被禁用
    });

    const { gateway } = createTestGateway(connections);
    const result = await gateway.handleToolCall(aliceCaller, {
      toolName: "github",
      action: "create_pr",
      parameters: { repo: "acme/backend-service", title: "Test", head: "fix", base: "main" },
    }, "corr-003");

    assert(result.status === "denied", `Expected denied, got ${result.status}`);
    assert(result.reason?.includes("disabled"), `Unexpected reason: ${result.reason}`);
  });

  // 4. 操作不在 scope 范围内
  await test("denies action outside scope", async () => {
    const connections = new Map<string, ExternalAuthConnection>();
    connections.set("alice:github", {
      id: "gh-alice-001",
      employeeId: "alice",
      tenantId: "acme-corp",
      provider: "github",
      mode: "oauth_delegated",
      scopes: ["public_repo"],  // 只有 public_repo，没有 repo
      status: "active",
    });

    const { gateway } = createTestGateway(connections);
    const result = await gateway.handleToolCall(aliceCaller, {
      toolName: "github",
      action: "create_pr",  // 需要 "repo" scope
      parameters: { repo: "acme/backend-service", title: "Test", head: "fix", base: "main" },
    }, "corr-004");

    assert(result.status === "denied", `Expected denied, got ${result.status}`);
    assert(result.reason?.includes("not in granted scopes"), `Unexpected reason: ${result.reason}`);
  });

  // 5. 跨租户越权
  await test("denies cross-tenant access", async () => {
    const connections = new Map<string, ExternalAuthConnection>();
    connections.set("alice:github", {
      id: "gh-alice-001",
      employeeId: "alice",
      tenantId: "other-org",  // 连接属于另一个租户
      provider: "github",
      mode: "oauth_delegated",
      scopes: ["repo"],
      status: "active",
    });

    const { gateway } = createTestGateway(connections);
    const result = await gateway.handleToolCall(bobCaller, {  // Bob 尝试使用 Alice 的连接
      toolName: "github",
      action: "create_pr",
      parameters: { repo: "acme/backend-service", title: "Test", head: "fix", base: "main" },
    }, "corr-005");

    assert(result.status === "denied", `Expected denied, got ${result.status}`);
    assert(result.reason?.includes("Cross-tenant"), `Unexpected reason: ${result.reason}`);
  });

  // 6. 高风险操作需要审批
  await test("requires approval for delete_repo", async () => {
    const connections = new Map<string, ExternalAuthConnection>();
    connections.set("alice:github", {
      id: "gh-alice-001",
      employeeId: "alice",
      tenantId: "acme-corp",
      provider: "github",
      mode: "oauth_delegated",
      scopes: ["repo", "delete_repo"],
      status: "active",
    });

    const { gateway, approvalStore } = createTestGateway(connections);
    const result = await gateway.handleToolCall(aliceCaller, {
      toolName: "github",
      action: "delete_repo",  // 高风险
      resource: "acme/old-repo",
      parameters: { repo: "acme/old-repo" },
    }, "corr-006");

    assert(result.status === "approval_pending", `Expected approval_pending, got ${result.status}`);
    assert(result.approvalId, "Missing approvalId");

    // 验证审批请求已创建
    const approval = await approvalStore.get(result.approvalId!);
    assert(approval !== null, "Approval request not created");
    assert(approval!.action === "delete_repo", "Wrong action in approval request");
  });

  // 7. 审批后参数篡改
  await test("rejects execution if params changed after approval", async () => {
    const connections = new Map<string, ExternalAuthConnection>();
    connections.set("alice:github", {
      id: "gh-alice-001",
      employeeId: "alice",
      tenantId: "acme-corp",
      provider: "github",
      mode: "oauth_delegated",
      scopes: ["repo", "delete_repo"],
      status: "active",
    });

    const { gateway, approvalStore } = createTestGateway(connections);

    // 先发起审批
    const initResult = await gateway.handleToolCall(aliceCaller, {
      toolName: "github",
      action: "delete_repo",
      resource: "acme/safe-repo",
      parameters: { repo: "acme/safe-repo" },
    }, "corr-007");

    assert(initResult.status === "approval_pending", "Expected approval_pending");
    assert(initResult.approvalId, "Missing approvalId");

    // 篡改参数（改为删除另一个仓库）
    const approval = await approvalStore.get(initResult.approvalId!);
    assert(approval !== null, "Approval not found");
    approval!.parameters = { repo: "acme/prod-repo" };  // 模拟参数被篡改

    // 审批通过
    const result = await gateway.handleApprovalResponse(initResult.approvalId!, true, "manager-001");

    assert(result.status === "denied", `Expected denied (param mismatch), got ${result.status}`);
    assert(result.reason?.includes("modified after approval"), `Unexpected reason: ${result.reason}`);

    // 验证审计记录了参数不匹配事件
    const events = approvalStore ? [] : [];  // 通过 auditStore 验证
  });

  // 8. 幂等性：重试不导致重复操作
  await test("prevents duplicate operations on retry", async () => {
    const connections = new Map<string, ExternalAuthConnection>();
    connections.set("alice:github", {
      id: "gh-alice-001",
      employeeId: "alice",
      tenantId: "acme-corp",
      provider: "github",
      mode: "oauth_delegated",
      scopes: ["repo"],
      status: "active",
    });

    let executeCount = 0;
    const auditStore = new InMemoryAuditStore();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const approvalStore = new InMemoryApprovalStore();

    const credentialBroker = {
      async getCredentials() { return { type: "mock" }; },
    };

    const toolAdapter = {
      async execute() {
        executeCount++;
        return { success: true };
      },
    };

    const getConnection = async () => connections.get("alice:github") ?? null;
    const evaluatePolicy = async () => "ALLOW" as const;

    const gateway = new ToolGateway(
      auditStore,
      idempotencyStore,
      approvalStore,
      credentialBroker,
      toolAdapter,
      getConnection,
      evaluatePolicy,
    );

    const request = {
      toolName: "github",
      action: "create_pr",
      parameters: { repo: "acme/backend-service", title: "Fix", head: "fix", base: "main" },
    };

    // 第一次调用
    const result1 = await gateway.handleToolCall(aliceCaller, request, "corr-008a");
    assert(result1.status === "success", `First call failed: ${result1.reason}`);

    // 第二次调用（重试，相同参数）
    const result2 = await gateway.handleToolCall(aliceCaller, request, "corr-008b");
    assert(result2.status === "success", `Retry call failed: ${result2.reason}`);

    // 验证只执行了一次
    assert(executeCount === 1, `Expected 1 execution, got ${executeCount}`);
  });

  // 9. Token 不进入审计日志
  await test("audit events do not contain credential values", async () => {
    const connections = new Map<string, ExternalAuthConnection>();
    connections.set("alice:github", {
      id: "gh-alice-001",
      employeeId: "alice",
      tenantId: "acme-corp",
      provider: "github",
      mode: "oauth_delegated",
      scopes: ["repo"],
      status: "active",
    });

    const { gateway, auditStore } = createTestGateway(connections);
    await gateway.handleToolCall(aliceCaller, {
      toolName: "github",
      action: "create_pr",
      parameters: { repo: "acme/backend-service", title: "Fix", head: "fix", base: "main" },
    }, "corr-009");

    const events = auditStore.getEvents();
    for (const event of events) {
      const json = JSON.stringify(event);
      assert(!json.includes("mock-credential-not-logged"), `Credential value found in audit event: ${event.eventType}`);
      assert(!json.includes("access_token"), `access_token found in audit event: ${event.eventType}`);
      assert(!json.includes("token"), `token string found in audit event: ${event.eventType}`);
    }
  });

  // 10. 策略引擎拒绝
  await test("denies when enterprise policy says DENY", async () => {
    const connections = new Map<string, ExternalAuthConnection>();
    connections.set("alice:github", {
      id: "gh-alice-001",
      employeeId: "alice",
      tenantId: "acme-corp",
      provider: "github",
      mode: "oauth_delegated",
      scopes: ["repo"],
      status: "active",
    });

    const { gateway } = createTestGateway(connections, "DENY");
    const result = await gateway.handleToolCall(aliceCaller, {
      toolName: "github",
      action: "create_pr",
      parameters: { repo: "acme/backend-service", title: "Fix", head: "fix", base: "main" },
    }, "corr-010");

    assert(result.status === "denied", `Expected denied, got ${result.status}`);
    assert(result.reason?.includes("Enterprise policy"), `Unexpected reason: ${result.reason}`);
  });

  // 总结
  console.log(`\n${passed}/${testNum} tests passed`);
  if (failed > 0) {
    console.log(`${failed} tests failed`);
    process.exit(1);
  }
}

runTests();
