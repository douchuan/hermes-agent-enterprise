// Session 类型定义
//
// 使用 express-session，采用安全 Cookie 设置。
// 生产环境应使用 Redis 等分布式 session store。

declare module "express-session" {
  interface SessionData {
    userId: string;
    email: string;
    name: string;
    tenantIds: string[];
    // 组织信息与 Agent 身份
    department?: string;
    role?: string;
    agentId?: string;
  }
}

export interface SessionData {
  userId: string;
  email: string;
  name: string;
  tenantIds: string[];
  department?: string;
  role?: string;
  agentId?: string;
}
