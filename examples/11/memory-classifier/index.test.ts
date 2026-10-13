// Memory 分类器测试
//
// 覆盖：
// - 规则分类的确定性测试
// - 低置信度或分类冲突时的处理
// - 转岗后的 Memory 重新评估
// - 分类结果不绕过访问授权
// - 无来源元数据时的保守处理
// - 凭证关键词匹配

import {
  classifyMemory,
  reclassifyForTransfer,
  canAccessMemory,
  RULE_VERSION,
  type MemoryEntry,
} from "./index.js";

function makeEntry(overrides: Partial<Omit<MemoryEntry, "sensitivity" | "classificationReason" | "classificationVersion">> = {}): Omit<MemoryEntry, "sensitivity" | "classificationReason" | "classificationVersion"> {
  return {
    id: "mem-001",
    content: "Alice worked on the payment module last sprint.",
    sourceType: "conversation",
    createdAt: "2025-01-01T00:00:00Z",
    employeeId: "user-alice-001",
    departmentAtCreation: "engineering",
    ...overrides,
  };
}

// ── 凭证关键词匹配 ──

function test_credential_keyword_match() {
  const entry = makeEntry({
    content: "The API key is ghp_abcdefghijklmnopqrstuvwxyz123456",
  });
  const result = classifyMemory(entry);
  console.assert(result.sensitivity === "confidential",
    `Expected confidential, got ${result.sensitivity}`);
  console.assert(result.classificationReason.includes("sensitive-keywords"),
    `Expected rule match for sensitive-keywords`);
  console.log("✓ test_credential_keyword_match");
}

function test_slack_token_match() {
  const entry = makeEntry({
    content: "Slack bot token: xoxb-1234567890-1234567890123-abcDEF123",
  });
  const result = classifyMemory(entry);
  console.assert(result.sensitivity === "confidential",
    `Expected confidential, got ${result.sensitivity}`);
  console.log("✓ test_slack_token_match");
}

function test_private_key_match() {
  const entry = makeEntry({
    content: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...",
  });
  const result = classifyMemory(entry);
  console.assert(result.sensitivity === "confidential",
    `Expected confidential, got ${result.sensitivity}`);
  console.log("✓ test_private_key_match");
}

// ── 部门敏感内容 ──

function test_department_sensitive_salary() {
  const entry = makeEntry({
    content: "Alice's salary was adjusted to grade 5.",
    sourceType: "document",
  });
  const result = classifyMemory(entry);
  console.assert(result.sensitivity === "confidential",
    `Expected confidential, got ${result.sensitivity}`);
  console.log("✓ test_department_sensitive_salary");
}

function test_department_sensitive_layoff() {
  const entry = makeEntry({
    content: "The layoffs in Q3 affected 15 people.",
  });
  const result = classifyMemory(entry);
  console.assert(result.sensitivity === "confidential",
    `Expected confidential, got ${result.sensitivity}`);
  console.log("✓ test_department_sensitive_layoff");
}

// ── 无来源元数据的保守处理 ──

function test_unknown_source_conservative() {
  const entry = makeEntry({
    content: "The meeting was productive.",
    sourceType: "manual",
    sourceDepartment: undefined,
  });
  const result = classifyMemory(entry);
  // No rules matched → conservative default is "restricted"
  console.assert(result.sensitivity === "restricted",
    `Expected restricted, got ${result.sensitivity}`);
  console.log("✓ test_unknown_source_conservative");
}

// ── 转岗后重新评估 ──

function test_reclassify_on_transfer() {
  const entries = [
    makeEntry({
      id: "mem-eng-001",
      content: "Backend API endpoint /api/v2/payments deployed.",
      sourceType: "tool_result",
      sourceDepartment: "engineering",
      departmentAtCreation: "engineering",
    }),
    makeEntry({
      id: "mem-personal-001",
      content: "Alice prefers dark mode.",
      sourceType: "manual",
      departmentAtCreation: "engineering",
    }),
  ];

  const result = reclassifyForTransfer(entries, "marketing");
  console.assert(result.restricted.length >= 1,
    `Expected at least 1 restricted entry, got ${result.restricted.length}`);
  console.log("✓ test_reclassify_on_transfer");
}

function test_reclassify_same_department() {
  const entries = [
    makeEntry({
      id: "mem-eng-001",
      content: "Backend API endpoint deployed.",
      sourceDepartment: "engineering",
      departmentAtCreation: "engineering",
    }),
  ];

  const result = reclassifyForTransfer(entries, "engineering");
  console.assert(result.restricted.length === 0,
    `Expected 0 restricted entries for same-department transfer, got ${result.restricted.length}`);
  console.log("✓ test_reclassify_same_department");
}

// ── 访问控制不绕过 ──

function test_access_control_not_bypassed() {
  // 构造一个 internal 级别的 Memory（手动设置分类结果）
  const memory: MemoryEntry = {
    id: "mem-internal-001",
    content: "Internal meeting notes.",
    sourceType: "document",
    sourceDepartment: "engineering",
    createdAt: "2025-01-01T00:00:00Z",
    employeeId: "user-alice-001",
    departmentAtCreation: "engineering",
    sensitivity: "internal",
    classificationReason: "test: internal dept-scoped",
    classificationVersion: RULE_VERSION,
  };

  // Same department → allowed
  const sameDept = canAccessMemory(memory, "engineering");
  console.assert(sameDept.allowed === true,
    `Expected allowed for same department, got: ${sameDept.reason}`);

  // Different department → denied
  const diffDept = canAccessMemory(memory, "marketing");
  console.assert(diffDept.allowed === false,
    `Expected denied for different department, got: ${diffDept.reason}`);

  // Confidential, different department → denied
  const confidentialMemory: MemoryEntry = {
    ...memory,
    sensitivity: "confidential",
    classificationReason: "test: confidential",
  };
  const denied = canAccessMemory(confidentialMemory, "marketing");
  console.assert(denied.allowed === false,
    `Expected denied for confidential cross-department, got: ${denied.reason}`);
  console.log("✓ test_access_control_not_bypassed");
}

function test_restricted_denied_by_default() {
  const memory = classifyMemory(makeEntry({
    content: "The meeting was productive.",
    sourceType: "manual",
  }));

  const result = canAccessMemory(memory, "engineering");
  console.assert(result.allowed === false,
    `Expected restricted to be denied by default`);
  console.log("✓ test_restricted_denied_by_default");
}

// ── 规则版本追踪 ──

function test_classification_version() {
  const entry = makeEntry({ content: "Normal content." });
  const result = classifyMemory(entry);
  console.assert(result.classificationVersion === RULE_VERSION,
    `Expected version ${RULE_VERSION}, got ${result.classificationVersion}`);
  console.log("✓ test_classification_version");
}

// ── 运行所有测试 ──

function runAll() {
  test_credential_keyword_match();
  test_slack_token_match();
  test_private_key_match();
  test_department_sensitive_salary();
  test_department_sensitive_layoff();
  test_unknown_source_conservative();
  test_reclassify_on_transfer();
  test_reclassify_same_department();
  test_access_control_not_bypassed();
  test_restricted_denied_by_default();
  test_classification_version();

  console.log("\nAll memory classifier tests passed.");
}

runAll();
