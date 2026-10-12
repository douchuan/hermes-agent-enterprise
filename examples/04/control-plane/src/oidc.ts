// OIDC 客户端初始化与流程处理
//
// 使用 openid-client 实现标准 OIDC Authorization Code Flow。
// 不依赖具体的 Provider（Google / Dex），通过配置驱动。

import { generators, Issuer, BaseClient, TokenSet, CallbackParamsType } from "openid-client";
import type { OidcConfig } from "./config.js";

export interface AuthRequest {
  state: string;
  nonce: string;
  codeVerifier: string;
  timestamp: number;
}

let client: BaseClient | null = null;
let issuerMetadata: Record<string, unknown> | null = null;

// 从 Issuer URL 发现 Provider 元数据（JWKS、端点等）
export async function initOidc(config: OidcConfig): Promise<BaseClient> {
  if (client) return client;

  console.log(`[oidc] Discovering provider: ${config.issuerUrl}`);
  const issuer = await Issuer.discover(config.issuerUrl);

  issuerMetadata = issuer.metadata;
  console.log(`[oidc] Discovered issuer: ${issuer.metadata.issuer}`);
  console.log(
    `[oidc] Endpoints: auth=${issuer.metadata.authorization_endpoint}, ` +
      `token=${issuer.metadata.token_endpoint}`
  );

  client = new issuer.Client({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uris: [config.redirectUri],
    response_types: ["code"],
    // openid-client 默认验证 ID Token 的签名、Issuer、Audience、有效期
    // nonce 在 authorizationUrl 中传入，callback 时自动检查
  });

  return client;
}

// 生成授权 URL（含 state、nonce、PKCE）
export function createAuthUrl(config: OidcConfig): {
  url: string;
  authRequest: AuthRequest;
} {
  if (!client) throw new Error("OIDC client not initialized");

  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);

  const url = client.authorizationUrl({
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    url,
    authRequest: { state, nonce, codeVerifier, timestamp: Date.now() },
  };
}

// 处理回调：用授权码换取 Token，验证 ID Token
export async function handleCallback(
  config: OidcConfig,
  params: Record<string, string>
): Promise<TokenSet> {
  if (!client) throw new Error("OIDC client not initialized");

  const state = typeof params.state === "string" ? params.state : undefined;
  const code = typeof params.code === "string" ? params.code : undefined;

  if (!state || !code) {
    throw new Error("Missing state or code parameter");
  }

  const authRequest = pendingAuthRequests.get(state);
  if (!authRequest) {
    throw new Error("Invalid or expired state parameter");
  }

  // 清理已使用的 state
  pendingAuthRequests.delete(state);

  // 检查 state 时效（5 分钟）
  if (Date.now() - authRequest.timestamp > 5 * 60 * 1000) {
    throw new Error("Auth request expired");
  }

  const currentUrl = config.redirectUri;

  // 使用授权码 + PKCE verifier 换取 Token
  // openid-client 自动验证 ID Token：签名、Issuer、Audience、Nonce、有效期
  const tokenSet = await client.callback(currentUrl, params, {
    state: authRequest.state,
    nonce: authRequest.nonce,
    code_verifier: authRequest.codeVerifier,
  });

  return tokenSet;
}

// 待处理的授权请求（内存存储，生产环境应使用 Redis 等）
const pendingAuthRequests = new Map<string, AuthRequest>();

// 注册授权请求（在重定向到 IdP 前调用）
export function registerAuthRequest(req: AuthRequest): string {
  pendingAuthRequests.set(req.state, req);
  return req.state;
}

// 获取 Provider 元数据（用于健康检查和调试）
export function getIssuerMetadata(): Record<string, unknown> | null {
  return issuerMetadata;
}
