// 内部用户与租户映射
//
// 生产环境：从数据库加载
// 本地开发：静态映射，用于演示跨租户隔离、员工-Agent 绑定和转岗流程

export interface InternalUser {
  // 由 (issuer, subject) 稳定标识
  id: string;
  issuer: string;
  subject: string;
  email: string;
  name: string;
  // 用户所属的租户列表
  tenantIds: string[];
  // 部门与角色（用于 Tool Gateway 授权策略）
  department: string;
  role: string;
  // 绑定的个人 Agent 身份
  agentId: string;
}

// 外部授权连接（模拟 OAuth 委托授权）
export interface ExternalAuthConnection {
  id: string;
  employeeId: string;
  provider: "github" | "jira" | "slack";
  mode: "oauth_delegated" | "enterprise_app";
  scopes: string[];
  status: "active" | "expired" | "revoked" | "disabled";
  createdAt: string;
  // 部门绑定（用于转岗时评估）
  departmentAtCreation: string;
}

// 本地开发用静态用户映射
// 生产环境应从数据库查询
export const devUsers: Map<string, InternalUser> = new Map([
  [
    "alice@example.com",
    {
      id: "user-alice-001",
      issuer: "http://localhost:5556/dex",
      subject: "08a8684b-db88-4b73-90a9-3cd1661f5466",
      email: "alice@example.com",
      name: "Alice",
      tenantIds: ["tenant-acme-001"],
      department: "engineering",
      role: "engineer",
      agentId: "agent-alice-001",
    },
  ],
  [
    "bob@example.com",
    {
      id: "user-bob-002",
      issuer: "http://localhost:5556/dex",
      subject: "18b8684b-db88-4b73-90a9-3cd1661f5467",
      email: "bob@example.com",
      name: "Bob",
      tenantIds: ["tenant-acme-001"],
      department: "engineering",
      role: "engineer",
      agentId: "agent-bob-001",
    },
  ],
  [
    "carol@otherorg.com",
    {
      id: "user-carol-003",
      issuer: "http://localhost:5556/dex",
      subject: "28c8684b-db88-4b73-90a9-3cd1661f5468",
      email: "carol@otherorg.com",
      name: "Carol",
      tenantIds: ["tenant-other-002"],
      department: "finance",
      role: "analyst",
      agentId: "agent-carol-001",
    },
  ],
]);

// 模拟外部授权连接（本地开发用）
export const devAuthConnections: Map<string, ExternalAuthConnection> = new Map([
  [
    "gh-alice-001",
    {
      id: "gh-alice-001",
      employeeId: "user-alice-001",
      provider: "github",
      mode: "oauth_delegated",
      scopes: ["repo", "read:org"],
      status: "active",
      createdAt: "2025-01-01T00:00:00Z",
      departmentAtCreation: "engineering",
    },
  ],
]);

// 根据 OIDC 身份查找或创建内部用户
export function resolveUser(
  issuer: string,
  subject: string,
  email: string,
  name: string
): InternalUser | null {
  // 优先在开发用户表中查找（本地环境）
  const devUser = devUsers.get(email);
  if (devUser) {
    // 验证 issuer 和 subject 是否匹配
    if (devUser.issuer === issuer && devUser.subject === subject) {
      return devUser;
    }
    // 邮箱匹配但 (issuer, subject) 不匹配：
    // 这是身份冲突，应拒绝或走绑定流程
    console.warn(
      `[users] email ${email} exists but (issuer, subject) mismatch: ` +
        `expected (${devUser.issuer}, ${devUser.subject}), ` +
        `got (${issuer}, ${subject})`
    );
    return null;
  }

  // 未知身份：拒绝访问
  // 生产环境可改为重定向到注册/绑定流程
  console.warn(
    `[users] Unknown identity: (${issuer}, ${subject}, ${email}). Access denied.`
  );
  return null;
}

// 验证用户是否有权限访问指定租户的资源
export function hasTenantAccess(user: InternalUser, tenantId: string): boolean {
  return user.tenantIds.includes(tenantId);
}

// 根据员工 ID 查找用户
export function findById(userId: string): InternalUser | null {
  for (const user of devUsers.values()) {
    if (user.id === userId) return user;
  }
  return null;
}

// 根据 Agent ID 查找对应的员工
export function findByAgentId(agentId: string): InternalUser | null {
  for (const user of devUsers.values()) {
    if (user.agentId === agentId) return user;
  }
  return null;
}

// 模拟转岗：更新部门并重新计算权限
// 返回变更详情，用于审计记录
export function transferDepartment(
  userId: string,
  newDepartment: string
): {
  user: InternalUser;
  oldDepartment: string;
  newDepartment: string;
  revokedConnections: string[];
  auditEvents: Array<{ eventType: string; details: Record<string, unknown> }>;
} | null {
  const user = findById(userId);
  if (!user) return null;

  const oldDepartment = user.department;
  const auditEvents: Array<{ eventType: string; details: Record<string, unknown> }> = [];

  // 1. 更新部门
  user.department = newDepartment;

  // 记录组织变更事件
  auditEvents.push({
    eventType: "ORGANIZATION_CHANGED",
    details: {
      employeeId: userId,
      agentId: user.agentId,
      oldDepartment,
      newDepartment,
      initiatedBy: "admin",
      timestamp: new Date().toISOString(),
    },
  });

  // 2. 重新计算权限（模拟）
  // 研发部 → 非研发部：撤销研发部专属的外部授权
  const revokedConnections: string[] = [];
  if (oldDepartment === "engineering" && newDepartment !== "engineering") {
    // 检查是否有部门绑定的外部授权连接需要撤销
    for (const [connId, conn] of devAuthConnections.entries()) {
      if (conn.employeeId === userId && conn.departmentAtCreation === "engineering") {
        conn.status = "disabled";
        revokedConnections.push(connId);
        auditEvents.push({
          eventType: "EXTERNAL_AUTH_DISABLED",
          details: {
            employeeId: userId,
            agentId: user.agentId,
            externalAuthConnectionId: connId,
            externalAuthProvider: conn.provider,
            reason: `department_change: ${oldDepartment} → ${newDepartment}`,
            initiatedBy: "control-plane",
            timestamp: new Date().toISOString(),
          },
        });
      }
    }
  }

  // 3. 记录权限重算事件
  auditEvents.push({
    eventType: "PERMISSION_RECALCULATED",
    details: {
      employeeId: userId,
      agentId: user.agentId,
      oldDepartment,
      newDepartment,
      revokedConnections,
      initiatedBy: "control-plane",
      timestamp: new Date().toISOString(),
    },
  });

  return { user, oldDepartment, newDepartment, revokedConnections, auditEvents };
}

// 检查用户是否有权限执行某个工具操作（模拟 Tool Gateway 策略）
export function canExecuteToolAction(
  user: InternalUser,
  toolName: string,
  action: string
): { allowed: boolean; reason: string } {
  // 研发部可以使用 GitHub 工具
  if (toolName === "github") {
    if (user.department !== "engineering") {
      return { allowed: false, reason: `Department ${user.department} does not have access to ${toolName}` };
    }
  }

  // 高风险操作需要审批（模拟）
  const highRiskActions = new Set(["delete_repo", "force_push", "modify_branch_protection"]);
  if (highRiskActions.has(action)) {
    return { allowed: false, reason: `Action ${action} requires approval` };
  }

  return { allowed: true, reason: "allowed" };
}
