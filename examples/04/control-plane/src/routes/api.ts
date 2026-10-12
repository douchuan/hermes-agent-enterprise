// 受保护的 API 路由
//
// 演示：
// - Session 验证
// - 租户级授权
// - 拒绝越权访问

import { Router, Request, Response, NextFunction } from "express";
import type { SessionData } from "../session.js";

function getSession(req: Request): SessionData {
  return req.session as unknown as SessionData;
}

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
          status: "running",
        },
      });
    }
  );

  // POST /api/tool/github — 模拟 Tool Gateway 调用
  // 演示：Tool Gateway 不信任 Agent 传来的 employee_id / tenant_id
  router.post("/tool/github", requireAuth, (req: Request, res: Response) => {
    const s = getSession(req);
    const action = (req.body && req.body.action) as string | undefined;
    const resource = (req.body && req.body.resource) as string | undefined;

    console.log(
      `[api] Tool call: user=${s.email}, action=${action}, ` +
        `resource=${resource}, tenant=${(s.tenantIds || []).join(", ")}`
    );

    // 模拟工具调用结果
    res.json({
      status: "ok",
      message: `Tool call "${action}" on "${resource}" executed for ${s.name}`,
    });
  });

  return router;
}
