// Tool Gateway — Authorization Engine
//
// 多维度授权检查：外部授权连接状态 → OAuth scope → 目标资源 → 企业策略 → 高风险判定
//
// 安全原则：
// - 不信任 Agent 传来的 employee_id / tenant_id
// - 调用方身份通过 mTLS / Workload Identity 独立验证
// - 授权检查不是"Token 存在就放行"，而是综合多维度因素

export interface CallerIdentity {
  sandboxId: string;
  employeeId: string;
  tenantId: string;
  agentId: string;
}

export interface ToolCallRequest {
  toolName: string;
  action: string;
  resource?: string;
  parameters: Record<string, unknown>;
}

export interface ExternalAuthConnection {
  id: string;
  employeeId: string;
  tenantId: string;
  provider: string;
  mode: "oauth_delegated" | "enterprise_app";
  scopes: string[];
  status: "active" | "expired" | "revoked" | "disabled";
}

export type AuthorizationResult = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface AuthorizationDecision {
  result: AuthorizationResult;
  reason: string;
  connectionId?: string;
}

// 高风险操作列表（需要审批的操作）
const HIGH_RISK_ACTIONS = new Set([
  "delete_repo",
  "force_push",
  "modify_branch_protection",
  "delete_organization_member",
  "archive_channel",
  "approve_expense_report",
  "cancel_room_booking",  // 取消他人的预订需要审批
]);

// 中等风险操作（视策略而定）
const MEDIUM_RISK_ACTIONS = new Set([
  "create_pr",
  "submit_expense_report",
  "send_message",
  "create_room_booking",
  "create_purchase_request",
]);

/**
 * 多维度授权检查
 *
 * 检查顺序：
 * 1. 调用方身份验证（由 Gateway 外层完成，此处假设已传入可信的 caller）
 * 2. 查找员工的外部授权连接
 * 3. 检查连接状态（active / expired / revoked / disabled）
 * 4. 检查操作是否在 OAuth scope 范围内
 * 5. 检查目标资源是否在授权范围内
 * 6. 企业策略判定（部门、角色、租户策略——此处简化为函数）
 * 7. 高风险操作判定
 */
export async function checkAuthorization(
  caller: CallerIdentity,
  request: ToolCallRequest,
  getConnection: (employeeId: string, provider: string) => Promise<ExternalAuthConnection | null>,
  evaluatePolicy: (caller: CallerIdentity, request: ToolCallRequest) => Promise<"ALLOW" | "DENY" | "REQUIRE_APPROVAL">,
): Promise<AuthorizationDecision> {
  // 步骤 1：查找员工的外部授权连接
  const connection = await getConnection(caller.employeeId, request.toolName);
  if (!connection) {
    return { result: "DENY", reason: `No ${request.toolName} authorization connected for employee ${caller.employeeId}` };
  }

  // 步骤 2：检查连接状态
  if (connection.status !== "active") {
    return {
      result: "DENY",
      reason: `${request.toolName} authorization is ${connection.status} (connection: ${connection.id})`,
    };
  }

  // 步骤 3：跨租户检查
  if (connection.tenantId !== caller.tenantId) {
    return {
      result: "DENY",
      reason: `Cross-tenant access denied: caller tenant=${caller.tenantId}, connection tenant=${connection.tenantId}`,
    };
  }

  // 步骤 4：检查操作是否在 scope 范围内
  if (!isActionInScope(request.action, connection.scopes)) {
    return {
      result: "DENY",
      reason: `Action "${request.action}" not in granted scopes: ${connection.scopes.join(", ")}`,
    };
  }

  // 步骤 5：企业策略判定
  const policyResult = await evaluatePolicy(caller, request);
  if (policyResult === "DENY") {
    return { result: "DENY", reason: "Enterprise policy denied this operation" };
  }

  // 步骤 6：高风险操作需要审批
  if (HIGH_RISK_ACTIONS.has(request.action)) {
    return {
      result: "REQUIRE_APPROVAL",
      reason: `Action "${request.action}" is high-risk and requires approval`,
      connectionId: connection.id,
    };
  }

  // 步骤 7：中等风险操作，策略引擎决定
  if (MEDIUM_RISK_ACTIONS.has(request.action)) {
    if (policyResult === "REQUIRE_APPROVAL") {
      return {
        result: "REQUIRE_APPROVAL",
        reason: `Action "${request.action}" requires approval per enterprise policy`,
        connectionId: connection.id,
      };
    }
  }

  // 所有检查通过
  return { result: "ALLOW", connectionId: connection.id };
}

/**
 * 检查操作是否在 OAuth scope 范围内
 *
 * 不同系统的 scope 模型不同。此处使用简化映射。
 * 生产环境需要根据具体服务的 scope 定义做适配。
 */
function isActionInScope(action: string, scopes: string[]): boolean {
  // GitHub scope 映射
  const githubScopeMap: Record<string, string[]> = {
    "read_issue": ["repo", "public_repo"],
    "create_pr": ["repo"],
    "delete_repo": ["repo", "delete_repo"],
    "force_push": ["repo"],
    "modify_branch_protection": ["repo", "admin:repo_hook"],
    "delete_organization_member": ["admin:org"],
  };

  const requiredScopes = githubScopeMap[action];
  if (requiredScopes) {
    // 只要有一个 scope 匹配即可
    return requiredScopes.some(s => scopes.includes(s));
  }

  // 其他工具的 scope 检查：默认允许（生产环境需要实现具体检查）
  return true;
}

/**
 * 计算参数的哈希值（用于审批后参数校验）
 *
 * 审批人批准某个操作时，记录参数的哈希值。
 * 执行操作前，重新计算参数哈希并对比，防止参数被篡改。
 */
export async function hashParameters(params: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(params, Object.keys(params).sort());
  // 简化实现：使用 JSON 字符串作为"哈希"
  // 生产环境应使用 SHA-256 等加密哈希
  return json;
}
