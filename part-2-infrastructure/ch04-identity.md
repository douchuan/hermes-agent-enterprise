# 第 4 章：企业身份认证与授权

## 本章目标

实现可靠的员工身份认证，将外部身份安全地映射到平台内部用户，并在服务端执行租户级授权和资源访问控制。通过本章，读者将理解：

- 为什么企业 Agent 平台必须采用标准 OIDC 而非自建用户名密码系统
- 如何通过配置切换 OIDC Provider（正式环境用 Google 等企业 IdP，本地开发用 Dex）
- 如何在服务端完整验证 ID Token（签名、Issuer、Audience、Nonce、有效期）
- 为什么 `state`、`nonce` 和 PKCE 缺一不可
- 如何建立安全的 Session Cookie
- 如何将 `(issuer, subject)` 映射到内部用户和租户
- 为什么认证成功不等于授权成功，以及 Tool Gateway 如何独立执行授权

## 问题背景与使用场景

员工需要登录平台来使用自己的 Agent。这个登录过程必须：

1. **验证员工确实是企业成员** — 不能允许任意人员注册并获得 Agent。
2. **建立稳定、不可伪造的身份** — 邮箱可以被修改或伪造，不能仅凭邮箱确定身份。
3. **将身份关联到租户和资源权限** — Alice 不能访问 Bob 的 Sandbox。
4. **防止会话劫持和 CSRF 攻击** — Cookie 设置不当会导致登录被窃取。
5. **在本地开发中无需 Google 账号** — 开发者应该能快速验证登录流程。

## 威胁模型与设计目标

### 威胁

| 威胁 | 影响 | 缓解 |
|------|------|------|
| 攻击者伪造 OIDC Token | 冒充其他员工 | 服务端验证签名、Issuer、Audience、有效期 |
| 浏览器 XSS 窃取 Session | 会话劫持 | `HttpOnly` Cookie，不将 Token 暴露给 JS |
| CSRF 攻击 | 未授权的写操作 | `SameSite` Cookie + `state` 参数 |
| 仅凭邮箱绑定身份 | 邮箱复用导致身份冲突 | 使用 `(issuer, subject)` 作为稳定身份标识 |
| 认证成功即授权 | 越权访问其他租户资源 | 服务端独立执行租户级授权 |
| 未知身份默认获得访问权 | 未注册用户访问系统 | 未知身份拒绝访问或进入受控注册流程 |

### 设计目标

- 使用标准 OIDC 协议，不自行实现认证或 JWT 签名验证。
- Provider 通过配置切换，业务代码不硬编码 Google 或 Dex。
- Session 采用安全 Cookie 设置，不将敏感凭证放入浏览器可访问的存储。
- 内部身份映射使用 `(issuer, subject)`，不单独依赖邮箱。
- 认证与授权分离：OIDC 只负责身份验证，平台负责租户和工具授权。

## 架构与工作机制

### 身份认证架构

```
                     ┌───────────────────────────┐
                     │ OIDC Identity Provider    │
                     │                           │
                     │ Google OIDC（正式环境）    │
                     │ Dex（本地开发/测试）       │
                     └───────────┬───────────────┘
                                 │ OIDC
                                 ▼
                     ┌───────────────────────────┐
                     │ Control Plane             │
                     │                           │
                     │ 验证 ID Token 声明         │
                     │ 建立应用 Session           │
                     │ 映射内部用户与租户         │
                     └───────────┬───────────────┘
                                 │
                                 ▼
                     ┌───────────────────────────┐
                     │ Tool Gateway              │
                     │                           │
                     │ 资源级授权（独立验证）     │
                     │ 配额与审批                 │
                     │ 安全审计                   │
                     └───────────────────────────┘
```

**关键原则**：

1. OIDC Provider 只负责**认证用户是谁**。它不决定用户能做什么。
2. Control Plane 负责将外部身份**映射到内部用户**，并关联到租户。
3. Tool Gateway 负责**资源级授权**，不信任外部传来的身份声明。

### 为什么选择标准 OIDC

OIDC（OpenID Connect）是基于 OAuth 2.0 的身份层协议。选择 OIDC 而不是自建用户名密码系统的原因：

- **企业已有 IdP**：Google Workspace、Okta、Azure AD 等已管理员工身份，不应再建一套。
- **安全性由专业团队维护**：JWT 签名验证、密钥轮换、Token 生命周期等由 IdP 处理。
- **标准化**：任何符合 OIDC 标准的 Provider 都可以接入，不存在供应商锁定。

### 为什么本地开发需要 Dex

正式部署使用 Google OIDC 或其他企业 IdP，但在本地开发和集成测试中：

- **无需 Google 账号**：开发者不需要注册 Google Cloud 项目。
- **可预置测试用户**：Alice、Bob、Carol 可以属于不同租户，方便验证跨租户隔离。
- **完整的 OIDC 流程**：Dex 是标准 OIDC Provider，不是自定义的用户名密码认证。应用使用同一套 OIDC 客户端代码，只是 Issuer 不同。

**Dex 的定位**：它是正式 IdP 的替代，不是自定义认证系统。本地和正式环境复用同一套 OIDC 集成代码。

> **代码示例**：完整的 Dex 配置和 Control Plane 参考实现见 `examples/04/`。

### 登录时序

```
浏览器                    Control Plane                 OIDC Provider (Dex / Google)
  |                          |                                |
  |-- GET /auth/login ------>|                                |
  |                          |-- 生成 state, nonce, PKCE ---->|
  |<-- 302 重定向到 IdP -----|                                |
  |                          |                                |
  |-- 用户在 IdP 登录 ------------------------------->|        |
  |                          |                                |
  |<-- 302 重定向 + code ----|                                |
  |   /auth/callback?        |                                |
  |   code=xxx&state=yyy     |                                |
  |                          |                                |
  |-- GET /auth/callback --->|                                |
  |   (code + state)         |                                |
  |                          |-- 验证 state, 用 code 换取 -->|
  |                          |   Token (含 ID Token)          |
  |                          |<-- ID Token -------------------|
  |                          |                                |
  |                          |-- 验证 ID Token：              |
  |                          |   签名、Issuer、Audience、     |
  |                          |   Nonce、有效期                |
  |                          |                                |
  |                          |-- 映射 (issuer, subject)       |
  |                          |   到内部用户 + 租户            |
  |                          |                                |
  |                          |-- 设置 Session Cookie          |
  |<-- 302 重定向到 / --------|                                |
```

### ID Token 验证

Control Plane 收到 ID Token 后，必须验证以下声明：

| 声明 | 检查内容 |
|------|----------|
| `iss`（Issuer） | 必须是配置的 OIDC Provider 地址 |
| `aud`（Audience） | 必须是本应用的 `client_id` |
| `exp`（Expiry） | Token 未过期 |
| `nonce` | 与登录时生成的 nonce 一致 |
| 签名 | 使用 Provider 的 JWKS 公钥验证 |

`openid-client` 库在 `client.callback()` 中自动完成以上所有验证。不要自行实现 JWT 签名验证。

### Session 管理

登录成功后，Control Plane 创建服务端 Session，通过安全 Cookie 传递：

```typescript
// Session Cookie 设置
cookie: {
  httpOnly: true,        // 防止 JavaScript 读取
  secure: true,          // 仅 HTTPS 传输（生产环境）
  sameSite: "lax",       // 防御 CSRF
  maxAge: 8 * 60 * 60 * 1000,  // 8 小时
}
```

Session 中存储内部用户 ID、邮箱、名称和租户列表。**不存储 ID Token 或 Access Token**，避免敏感凭证泄露到浏览器。

## 实现步骤

本节基于 `examples/04/control-plane/` 的参考实现，说明关键代码。

### 配置驱动 Provider 切换

业务代码不关心是 Dex 还是 Google，所有差异通过配置：

```typescript
// src/config.ts
const issuerUrl = env("OIDC_ISSUER_URL", "http://localhost:5556/dex");
const clientId = env("OIDC_CLIENT_ID", "hermes-control-plane");
const clientSecret = env("OIDC_CLIENT_SECRET", "not-a-real-secret-dev-only");
const redirectUri = env("OIDC_REDIRECT_URI", "http://localhost:3000/auth/callback");
```

本地开发默认使用 Dex。生产环境设置 `OIDC_ISSUER_URL=https://accounts.google.com` 即可切换到 Google OIDC。

### OIDC 客户端初始化

```typescript
// src/oidc.ts
const issuer = await Issuer.discover(config.issuerUrl);
const client = new issuer.Client({
  client_id: config.clientId,
  client_secret: config.clientSecret,
  redirect_uris: [config.redirectUri],
  response_types: ["code"],
});
```

`Issuer.discover()` 自动获取 Provider 的 JWKS 端点、授权端点和 Token 端点。

### Authorization Code Flow + PKCE

```typescript
// src/oidc.ts — 生成授权 URL
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
```

- `state`：防止 CSRF。回调时验证 state 是否一致。
- `nonce`：防止重放攻击。ID Token 中的 nonce 必须与登录时生成的一致。
- `codeVerifier` / `codeChallenge`（PKCE）：防止授权码被拦截后冒用。即使攻击者截获了授权码，没有 verifier 也无法换取 Token。

### 回调处理

```typescript
// src/oidc.ts — 处理回调
const tokenSet = await client.callback(currentUrl, params, {
  state: authRequest.state,
  nonce: authRequest.nonce,
  code_verifier: authRequest.codeVerifier,
});
```

这一步自动完成：
1. 用授权码 + PKCE verifier 换取 Access Token 和 ID Token
2. 验证 ID Token 的签名、Issuer、Audience、Nonce、有效期
3. 如果任何验证失败，抛出异常

### 身份映射

```typescript
// src/users.ts
export function resolveUser(
  issuer: string,
  subject: string,
  email: string,
  name: string
): InternalUser | null {
  // 使用 (issuer, subject) 作为稳定身份标识
  // 不单独依赖 email
  const devUser = devUsers.get(email);
  if (devUser) {
    if (devUser.issuer === issuer && devUser.subject === subject) {
      return devUser;
    }
    // email 匹配但 (issuer, subject) 不匹配：身份冲突
    return null;
  }
  // 未知身份：拒绝访问
  return null;
}
```

**为什么不用邮箱作为唯一身份依据**：
- 不同 IdP 可能返回相同的邮箱但不同的用户
- 员工更换 IdP 后邮箱可能不变，但 `subject` 会变化
- `(issuer, subject)` 组合是 OIDC 协议保证唯一的标识符

### 租户级授权

```typescript
// src/routes/api.ts — 服务端授权检查
router.get("/tenant/:tenantId/sandbox", requireAuth, (req, res) => {
  const requestedTenant = req.params.tenantId;
  const userTenantIds = session.tenantIds || [];

  // 不信任请求中的 tenant_id，以服务端识别的 session 为准
  if (!userTenantIds.includes(requestedTenant)) {
    res.status(403).json({
      error: "Access denied",
      message: "You do not have access to this tenant",
    });
    return;
  }
  // ... 返回 Sandbox 信息
});
```

即使前端隐藏了其他租户的入口，或者攻击者在 URL 中伪造 `tenantId`，服务端仍然拒绝越权访问。

### 组织身份与角色

OIDC 认证解决了"员工是谁"的问题，但没有解决"员工在组织中担任什么角色"的问题。

在企业中，员工的权限不仅取决于租户，还取决于：

- **部门**：研发部、市场部、财务部等。
- **角色**：工程师、经理、管理员等。
- **组织关系**：员工可能属于多个团队，或在不同团队间调动。

Control Plane 需要从可信的 HR 系统或企业身份目录（如 Active Directory、Okta SCIM）获取员工的组织信息，并将其与 OIDC 身份关联。

```typescript
// 员工组织信息
interface EmployeeOrgInfo {
  employeeId: string;
  department: string;       // "engineering", "marketing", "finance"
  role: string;             // "engineer", "manager", "admin"
  teams: string[];          // ["backend-team", "infra-team"]
  managerId?: string;       // 审批人可能是直属经理
}
```

**为什么部门信息很重要？**

- Tool Gateway 的授权策略可以基于部门制定。例如，研发部员工可以使用 GitHub 工具，市场部员工可能不需要。
- 当员工从研发部调到市场部时，平台需要根据新的部门重新计算权限（见本章后续章节和第 5、7、8 章）。

### 员工与个人 Agent 的绑定

每位员工通过企业平台登录后，Control Plane 为其分配一个**长期稳定的个人 Agent 身份**：

```
OIDC 身份 (issuer, subject)  →  InternalUser  →  AgentIdentity
────────────────────────────────────────────────────────────────
(iss=dex, sub=08a86...,      →  user-alice-001 →  agent-alice-001
 email=alice, dept=engineering)
```

这个绑定关系在服务端维护。Agent 身份是稳定的——即使底层 Pod 重启、重建或暂停，Agent 的 `agentId`、Memory、Skills 和 Workspace 保持不变。

**区分以下概念**：

| 概念 | 说明 | 变化时机 |
|------|------|----------|
| 员工身份 (User Identity) | 由 OIDC (issuer, subject) 标识 | 员工更换 IdP 时 subject 可能变化 |
| 个人 Agent 身份 (Agent Identity) | 平台分配给员工的 Agent 标识 | 员工离职、身份主体变化或安全事件 |
| Agent 运行实例 (Runtime Instance) | 当前运行的 Pod / 进程 | Pod 重建、滚动更新、暂停恢复 |
| Agent 持久化状态 (Persistent State) | Memory、Skills、Workspace、会话 | PVC 删除或数据清理 |

**员工身份是 Agent 身份的归属主体。** 平台以员工为单位分配个人 Agent，员工通过主动授权委托 Agent 访问外部服务（第 7 章）。

### 组织关系变化与权限重算

员工的部门和角色可能发生变化——从研发部调到市场部，从工程师升职为经理，或离职。

**核心原则：Agent 的身份与长期学习状态可以保持连续，但 Agent 的有效访问权限必须服从员工当前的组织身份、外部服务授权和企业安全策略。**

这意味着：

1. **普通部门变更**：保留原 Agent 身份，重新评估权限和数据边界。
2. **转岗时**：旧部门的权限不应无条件保留，外部授权连接需要重新评估。
3. **离职时**：Agent 身份可保留过渡期（数据保留策略），但所有活跃权限必须撤销。

权限重算流程在第 5 章（Sandbox 生命周期）、第 7 章（外部授权撤销）、第 8 章（凭证回收）和第 10 章（审计记录）中详细展开。

## 本地开发：使用 Dex 模拟 OIDC 身份提供商

### 为什么选择 Dex

Dex 是一个开源的 OIDC Provider（https://dexidp.io/），它可以：
- 通过 Kubernetes Deployment 一行命令部署到本地集群
- 预置静态测试用户，无需注册流程
- 完整实现 OIDC 协议（Discovery、JWKS、Authorization Code Flow）
- 与 Google OIDC 使用同一套应用代码，仅 Issuer 不同

Dex **不**负责多租户授权、Sandbox 隔离或 Tool Gateway 授权。它只提供可信的用户身份，后续的身份映射、租户关联和资源授权由 Control Plane 和 Tool Gateway 执行。

### 启动 Dex

在本地 Kubernetes 集群中部署：

```bash
kubectl apply -k examples/04/k8s/
kubectl -n hermes-dev rollout status deployment/dex --timeout=60s
```

本地访问 Dex（port-forward，仅用于开发环境）：

```bash
kubectl -n hermes-dev port-forward svc/dex 5556:5556
```

验证 Dex 正常运行：

```bash
# 健康检查
curl http://localhost:5556/dex/healthz

# OIDC 发现文档
curl http://localhost:5556/dex/.well-known/openid-configuration

# JWKS（公钥端点）
curl http://localhost:5556/dex/keys
```

### 预置测试用户

`k8s/configmap.yaml` 中定义了三个测试用户：

| 用户 | 邮箱 | 密码 | 租户 | 用途 |
|------|------|------|------|------|
| Alice | alice@example.com | password | tenant-acme-001 | 同租户正常访问 |
| Bob | bob@example.com | password | tenant-acme-001 | 同租户正常访问 |
| Carol | carol@otherorg.com | password | tenant-other-002 | 跨租户隔离验证 |

密码使用 bcrypt 哈希存储。生成方式：

```bash
htpasswd -bnBC 10 "" "password" | tr -d ':\n'
```

### 将 (issuer, subject) 映射到内部用户

Control Plane 收到 Dex 返回的 ID Token 后，提取 `iss`、`sub`、`email` 等声明：

```
iss = "http://localhost:5556/dex"
sub = "08a8684b-db88-4b73-90a9-3cd1661f5466"
email = "alice@example.com"
```

然后与内部用户表匹配。本地开发中，`devUsers` 映射表直接定义了已知用户的 `(issuer, subject)` 组合。匹配成功后，返回内部用户 ID 和租户列表。

### 测试跨租户访问拒绝

1. 用 Alice 登录，访问 `GET /api/tenant/tenant-acme-001/sandbox` — 成功
2. 用 Alice 访问 `GET /api/tenant/tenant-other-002/sandbox` — **403 拒绝**
3. 用 Carol 登录，访问 `GET /api/tenant/tenant-other-002/sandbox` — 成功
4. 用 Carol 访问 `GET /api/tenant/tenant-acme-001/sandbox` — **403 拒绝**

这验证了服务端授权正确执行，不依赖前端隐藏入口。

### 切换到 Google OIDC

设置环境变量即可切换，无需修改业务代码：

```bash
export OIDC_ISSUER_URL=https://accounts.google.com
export OIDC_CLIENT_ID=your-google-client-id
export OIDC_CLIENT_SECRET=your-google-client-secret
export OIDC_REDIRECT_URI=https://your-domain.com/auth/callback
export SESSION_SECRET=your-production-session-secret
```

### 本地测试的安全边界

- Dex 的静态密码 **仅用于本地开发**。生产环境禁止使用。
- ConfigMap 中的 Client Secret 是开发用占位符。生产环境必须通过 Vault、KMS 或云平台密钥管理工具注入。
- Dex 只提供身份认证。多租户隔离、Tool Gateway 授权、Sandbox 安全等由平台其他组件负责。

## 常见问题与故障排查

### Dex 无法启动

```bash
kubectl -n hermes-dev describe pod -l app=dex
kubectl -n hermes-dev logs -l app=dex
```

常见原因：
- 镜像拉取失败（网络问题）
- ConfigMap 未创建（先执行 `kubectl apply -k`）

### 登录后仍然显示未认证

- 检查浏览器 Cookie 设置：开发者工具 → Application → Cookies → 查看 `hermes-session`
- 确认 Cookie 的 `HttpOnly` 和 `SameSite` 属性正确
- 确认 `SESSION_SECRET` 已设置（生产环境）

### 回调报 "Invalid state"

- 确认 Dex 的 `redirectURIs` 与 `OIDC_REDIRECT_URI` 完全一致
- 确认回调在 5 分钟内完成（state 过期时间）

### 登录后被拒绝 "Unknown identity"

- 这是预期行为：`devUsers` 只包含 Alice、Bob、Carol
- 未知邮箱的用户会被拒绝访问
- 生产环境可改为引导到注册/绑定流程

### 从 Dex 切换到 Google 后登录失败

- 确认 Google Cloud Console 中的 Authorized redirect URIs 包含 `OIDC_REDIRECT_URI`
- 确认 `OIDC_CLIENT_ID` 和 `OIDC_CLIENT_SECRET` 正确
- Google OIDC 返回的声明可能不同（如 `email_verified`），需要适配

## 安全边界、取舍与剩余风险

### 已防范的

- **OIDC Token 伪造**：服务端验证签名、Issuer、Audience、Nonce、有效期
- **CSRF 攻击**：`state` 参数 + `SameSite` Cookie
- **会话劫持**：`HttpOnly` Cookie，不将 Token 暴露给前端
- **身份冲突**：使用 `(issuer, subject)` 而非单独邮箱
- **越权访问**：服务端租户级授权，不信任客户端传来的 `tenant_id`

### 未覆盖的（后续章节）

- **员工与个人 Agent 的长期绑定**：每位员工对应一个稳定的 Agent 身份，运行实例可重建但身份不变（第 5 章）
- **外部服务委托授权**：员工主动委托 Agent 访问 GitHub 等第三方服务，OAuth 授权与运行时授权检查的区别（第 7 章）
- **组织关系变化时的权限重算**：员工转岗、离职时的权限回收、凭证处理和授权撤销（第 5、7、8 章）
- **Tool Gateway 资源级授权**：本章演示了基本的租户级授权，但 Tool Gateway 还需要资源级授权（第 7 章）
- **会话撤销**：员工离职后如何撤销所有活跃 Session（第 12 章）
- **Sandbox 生命周期**：员工入职/离职时的 Sandbox 创建和销毁（第 5 章）
- **高风险操作审批**：审批流程绑定具体操作和目标（第 9 章）

### 剩余风险

| 风险 | 说明 |
|------|------|
| Session 存储在内存中 | 生产环境必须使用 Redis 等分布式 store |
| `devUsers` 是静态映射 | 生产环境应从数据库加载用户和租户关系 |
| 未实现 Refresh Token 流程 | Session 过期后用户需要重新登录 |
| Dex 静态密码哈希暴露 | 仅用于本地开发，不得用于生产 |

## 本章小结

本章实现了企业 Hermes Agent 平台的身份认证与授权基础：

1. **标准 OIDC**：通过 `openid-client` 库实现 Authorization Code Flow + PKCE，支持 Dex 和 Google OIDC 的配置切换。
2. **完整的 ID Token 验证**：签名、Issuer、Audience、Nonce、有效期由库自动验证。
3. **安全的 Session 管理**：`HttpOnly`、`Secure`、`SameSite` Cookie，不将敏感凭证暴露给浏览器。
4. **稳定的身份映射**：使用 `(issuer, subject)` 而非单独邮箱，避免身份冲突。
5. **组织身份与角色**：员工身份与部门、角色关联，为 Tool Gateway 授权策略提供依据。
6. **员工与个人 Agent 绑定**：每位员工对应一个长期稳定的 Agent 身份，运行实例可重建但身份不变。
7. **认证与授权分离**：OIDC 只负责身份验证，Control Plane 负责租户映射，Tool Gateway 负责资源级授权。
8. **权限随组织关系重算**：员工转岗或离职时，Agent 身份可保留，但有效权限必须重新评估（详见第 5、7、8 章）。
9. **本地开发用 Dex**：无需 Google 账号，预置多租户测试用户，复用同一套应用代码。

## 参考资料

- OpenID Connect Core 1.0：https://openid.net/specs/openid-connect-core-1_0.html
- Dex 项目：https://dexidp.io/
- Dex 本地连接器：https://dexidp.io/docs/connectors/local/
- openid-client（Node.js OIDC 客户端）：https://github.com/panva/node-openid-client
- Google OpenID Connect：https://developers.google.com/identity/openid-connect/openid-connect
- 配套代码：`examples/04/`
