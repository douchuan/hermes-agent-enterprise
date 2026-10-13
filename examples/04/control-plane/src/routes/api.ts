// 受保护的 API 路由
//
// 演示：
// - Session 验证
// - 租户级授权
// - 拒绝越权访问
// - 工具调用授权检查
// - 员工转岗与权限回收

import { Router, Request, Response, NextFunction } from "express";
import type { SessionData } from "../session.js";
import {
  findById,
  transferDepartment,
  canExecuteToolAction,
  devAuthConnections,
} from "../users.js";

function getSession(req: Request): SessionData {
  return req.session as unknown as SessionData;
}

// 审计事件存储（内存中，生产环境用数据库）
const auditEvents: Array<Record<string, unknown>> = [];

export function createApiRoutes(): Router {
  const router = Router();

  // 中间件：要求已认证
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const session = getSession(req);
    if (!session.userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    next();
  };

  // GET /api/me — 当前用户信息
  router.get("/me", requireAuth, (req: Request, res: Response) => {
    const s = getSession(req);
    res.json({
      userId: s.userId,
      email: s.email,
      name: s.name,
      tenantIds: s.tenantIds,
      department: (s as any).department,
      role: (s as any).role,
      agentId: (s as any).agentId,
    });
  });

  // GET /api/tenant/:tenantId/sandbox — 获取租户 Sandbox 信息
  // 演示租户级授权
  router.get(
    "/tenant/:tenantId/sandbox",
    requireAuth,
    (req: Request, res: Response) => {
      const requestedTenant = Array.isArray(req.params.tenantId)
        ? req.params.tenantId[0]
        : req.params.tenantId;
      const s = getSession(req);
      const userTenantIds = s.tenantIds || [];

      // 服务端授权检查：不信任请求中的 tenant_id
      // 而是检查当前用户的 session 是否有权访问该租户
      if (!userTenantIds.includes(requestedTenant)) {
        console.warn(
          `[api] Access denied: user ${s.email} tried to access ` +
            `tenant ${requestedTenant}, allowed: ${userTenantIds.join(", ")}`
        );
        res.status(403).json({
          error: "Access denied",
          message: "You do not have access to this tenant",
        });
        return;
      }

      // 模拟 Sandbox 信息
      res.json({
        tenantId: requestedTenant,
        sandbox: {
          namespace: `hermes-${s.userId}`,
          pod: `agent-${s.userId}`,
          agentId: (s as any).agentId,
          status: "running",
        },
      });
    }
  );

  // POST /api/tool/github — 模拟 Tool Gateway 调用
  // 演示：Tool Gateway 不信任 Agent 传来的 employee_id / tenant_id
  // 而是使用 Session 中验证的身份
  router.post("/tool/github", requireAuth, (req: Request, res: Response) => {
    const s = getSession(req);
    const action = (req.body && req.body.action) as string | undefined;
    const resource = (req.body && req.body.resource) as string | undefined;

    const user = findById(s.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // 工具调用授权检查
    const authResult = canExecuteToolAction(user, "github", action || "");
    if (!authResult.allowed) {
      auditEvents.push({
        eventType: "TOOL_CALL_DENIED",
        employeeId: s.userId,
        agentId: user.agentId,
        toolName: "github",
        action,
        resource,
        reason: authResult.reason,
        timestamp: new Date().toISOString(),
      });

      res.status(403).json({
        error: "Authorization denied",
        reason: authResult.reason,
      });
      return;
    }

    console.log(
      `[api] Tool call: user=${s.email}, action=${action}, ` +
        `resource=${resource}, department=${user.department}`
    );

    // 模拟工具调用结果
    res.json({
      status: "ok",
      message: `Tool call "${action}" on "${resource}" executed for ${s.name}`,
    });
  });

  // POST /api/transfer — 模拟员工转岗（管理端点）
  // 演示：部门变更后权限重新计算和外部授权回收
  router.post("/transfer", requireAuth, (req: Request, res: Response) => {
    const s = getSession(req);
    const { newDepartment } = req.body || {};

    if (!newDepartment) {
      res.status(400).json({ error: "newDepartment is required" });
      return;
    }

    const result = transferDepartment(s.userId, newDepartment);
    if (!result) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // 更新 Session 中的部门信息
    (s as any).department = result.user.department;

    // 记录审计事件
    auditEvents.push(...result.auditEvents);

    res.json({
      message: `Transfered ${result.user.name} from ${result.oldDepartment} to ${result.newDepartment}`,
      revokedConnections: result.revokedConnections,
      user: {
        userId: result.user.id,
        email: result.user.email,
        department: result.user.department,
        agentId: result.user.agentId,
      },
    });
  });

  // GET /api/audit — 查看审计事件（管理端点）
  router.get("/audit", requireAuth, (req: Request, res: Response) => {
    res.json({ events: auditEvents });
  });

  // GET /api/connections — 查看外部授权连接
  router.get("/connections", requireAuth, (req: Request, res: Response) => {
    const s = getSession(req);
    const connections: Array<Record<string, unknown>> = [];
    for (const conn of devAuthConnections.values()) {
      if (conn.employeeId === s.userId) {
        connections.push({
          id: conn.id,
          provider: conn.provider,
          mode: conn.mode,
          scopes: conn.scopes,
          status: conn.status,
          createdAt: conn.createdAt,
          departmentAtCreation: conn.departmentAtCreation,
        });
      }
    }
    res.json({ connections });
  });

  return router;
}
