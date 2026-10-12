// 内部用户与租户映射
//
// 生产环境：从数据库加载
// 本地开发：静态映射，用于演示跨租户隔离

export interface InternalUser {
  // 由 (issuer, subject) 稳定标识
  id: string;
  issuer: string;
  subject: string;
  email: string;
  name: string;
  // 用户所属的租户列表
  tenantIds: string[];
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
