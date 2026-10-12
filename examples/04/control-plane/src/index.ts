// Control Plane 入口
//
// Express 应用初始化、中间件、路由注册。

import express, { Request, Response } from "express";
import session from "express-session";
import { loadConfig } from "./config.js";
import { initOidc } from "./oidc.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createApiRoutes } from "./routes/api.js";
import type { SessionData } from "./session.js";

async function main() {
  const config = loadConfig();

  // 初始化 OIDC 客户端（从 Issuer 发现 JWKS、端点等）
  await initOidc(config.oidc);

  const app = express();

  // --- 中间件 ---

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Session 配置
  app.use(
    session({
      name: "hermes-session",
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true, // 防止 JavaScript 读取 Cookie
        secure: process.env.NODE_ENV === "production", // 生产环境仅 HTTPS
        sameSite: "lax", // 防御 CSRF
        maxAge: 8 * 60 * 60 * 1000, // 8 小时
        path: "/",
      },
    })
  );

  // --- 路由 ---

  // 认证路由
  app.use("/auth", createAuthRoutes(config));

  // API 路由
  app.use("/api", createApiRoutes());

  // 首页
  app.get("/", (req: Request, res: Response) => {
    const sessionData = (req as any).session as SessionData | undefined;
    if (sessionData?.userId) {
      res.send(`
        <html>
          <body>
            <h1>Welcome, ${sessionData.name}</h1>
            <p>Email: ${sessionData.email}</p>
            <p>Tenants: ${(sessionData.tenantIds || []).join(", ")}</p>
            <form action="/auth/logout" method="POST">
              <button type="submit">Logout</button>
            </form>
            <hr>
            <h2>API Endpoints</h2>
            <ul>
              <li><a href="/api/me">GET /api/me</a></li>
              <li><a href="/api/tenant/tenant-acme-001/sandbox">GET /api/tenant/tenant-acme-001/sandbox</a></li>
              <li><a href="/api/tenant/tenant-other-002/sandbox">GET /api/tenant/tenant-other-002/sandbox</a> (should fail for Alice/Bob)</li>
            </ul>
          </body>
        </html>
      `);
    } else {
      res.send(`
        <html>
          <body>
            <h1>Hermes Control Plane</h1>
            <p>Not authenticated.</p>
            <a href="/auth/login">Login via OIDC</a>
          </body>
        </html>
      `);
    }
  });

  // 健康检查
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", oidcIssuer: config.oidc.issuerUrl });
  });

  app.listen(config.port, () => {
    console.log(
      `[control-plane] Listening on http://localhost:${config.port}`
    );
    console.log(
      `[control-plane] OIDC issuer: ${config.oidc.issuerUrl}`
    );
    console.log(
      `[control-plane] Login: http://localhost:${config.port}/auth/login`
    );
  });
}

main().catch((err) => {
  console.error("[control-plane] Failed to start:", err);
  process.exit(1);
});
