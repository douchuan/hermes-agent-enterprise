// 配置管理
//
// 通过环境变量切换 OIDC Provider（Dex 本地开发 / Google 生产）。
// 应用逻辑不依赖具体的 Provider，只使用标准 OIDC 协议。

import { randomBytes } from "node:crypto";

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AppConfig {
  port: number;
  oidc: OidcConfig;
  sessionSecret: string;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (!value && fallback !== undefined) return fallback;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function loadConfig(): AppConfig {
  // 本地开发默认使用 Dex
  // 生产环境设置 OIDC_ISSUER_URL=https://accounts.google.com
  const issuerUrl = env("OIDC_ISSUER_URL", "http://localhost:5556/dex");
  const clientId = env("OIDC_CLIENT_ID", "hermes-control-plane");
  const clientSecret = env("OIDC_CLIENT_SECRET", "not-a-real-secret-dev-only");
  const redirectUri = env(
    "OIDC_REDIRECT_URI",
    "http://localhost:3000/auth/callback"
  );

  // Session secret：生产环境必须通过环境变量或密钥管理工具提供
  let sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SESSION_SECRET must be set in production. Do not use the default."
      );
    }
    // 本地开发：每次启动随机生成（重启后 session 失效，可接受）
    sessionSecret = randomBytes(32).toString("hex");
    console.warn(
      "[config] SESSION_SECRET not set, using random value (session will not survive restart)"
    );
  }

  return {
    port: parseInt(env("PORT", "3000"), 10),
    oidc: { issuerUrl, clientId, clientSecret, redirectUri },
    sessionSecret,
  };
}
