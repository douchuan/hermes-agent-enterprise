// 认证路由：登录、回调、登出
//
// 实现标准 OIDC Authorization Code Flow + PKCE。

import { Router, Request, Response, NextFunction } from "express";
import type { AppConfig } from "../config.js";
import { createAuthUrl, handleCallback, registerAuthRequest } from "../oidc.js";
import { resolveUser } from "../users.js";
import type { SessionData } from "../session.js";

export function createAuthRoutes(config: AppConfig): Router {
  const router = Router();

  // GET /auth/login — 发起 OIDC 登录
  router.get("/login", (_req: Request, res: Response) => {
    const { url, authRequest } = createAuthUrl(config.oidc);
    const state = registerAuthRequest(authRequest);
    console.log(`[auth] Redirecting to OIDC provider: ${config.oidc.issuerUrl}`);
    res.redirect(`${url}&state=${state}`);
  });

  // GET /auth/callback — OIDC 回调
  router.get("/callback", async (req: Request, res: Response) => {
    try {
      const state = req.query.state as string | undefined;
      const code = req.query.code as string | undefined;

      if (!state || !code) {
        res.status(400).send("Missing state or code parameter");
        return;
      }

      const queryString = req.url.split("?")[1];
      const params: Record<string, string> = {};
      if (queryString) {
        new URLSearchParams(queryString).forEach((v, k) => { params[k] = v; });
      }
      const tokenSet = await handleCallback(config.oidc, params);

      const claims = tokenSet.claims();
      if (!claims) {
        res.status(500).send("No claims in ID Token");
        return;
      }

      const issuer = claims.iss as string;
      const subject = claims.sub as string;
      const email = (claims.email as string) || "";
      const name = (claims.name as string) || email;

      console.log(
        `[auth] OIDC callback: iss=${issuer}, sub=${subject}, email=${email}`
      );

      // 将外部身份映射到内部用户
      const user = resolveUser(issuer, subject, email, name);
      if (!user) {
        // 未知身份：拒绝访问
        res.status(403).send(
          "Access denied: your identity is not recognized. " +
            "Contact your administrator to be added."
        );
        return;
      }

      // 建立服务端 Session
      const session = req.session as SessionData;
      session.userId = user.id;
      session.email = user.email;
      session.name = user.name;
      session.tenantIds = user.tenantIds;
      // 不将 ID Token 存入 session，避免敏感凭证泄露到浏览器

      console.log(
        `[auth] Login success: ${user.name} (${user.email}), tenants: ${user.tenantIds.join(", ")}`
      );

      res.redirect("/");
    } catch (err) {
      console.error("[auth] Callback error:", err);
      // 不向浏览器泄漏 Token 或签名验证细节
      res.status(401).send("Authentication failed. Please try again.");
    }
  });

  // POST /auth/logout — 登出
  router.post("/logout", (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        console.error("[auth] Logout error:", err);
      }
      res.clearCookie("hermes-session");
      res.redirect("/auth/login");
    });
  });

  return router;
}
