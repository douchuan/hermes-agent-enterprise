# 第 13 章：从零搭建一个企业级 Hermes Agent 平台

## 本章目标

把前面章节的组件组合成一个可以演示、测试和继续扩展的参考项目。本章提供可执行的步骤，让读者能够：

1. 启动本地 OIDC 环境（Dex）并完成身份认证实验
2. 启动 Control Plane，完成员工登录、身份映射和租户授权
3. 验证跨租户访问拒绝
4. 理解如何切换到正式环境的 Google OIDC

本章聚焦身份认证和授权的端到端流程。Sandbox 编排（第 5 章）、网络策略（第 6 章）、Tool Gateway（第 7 章）等组件在后续阶段逐步加入。

## 前置条件

- Docker + Docker Compose（用于启动 Dex）
- Node.js 22+（用于运行 Control Plane）
- 终端和浏览器

## 项目目录结构

```
examples/
├── 04/                          # 身份认证与授权
│   ├── dex-config.yaml          # Dex 配置
│   ├── docker-compose.yml       # Dex 容器编排
│   ├── .env.example             # 环境变量模板
│   ├── README.md                # 身份认证实验说明
│   └── control-plane/           # Control Plane 参考实现
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts         # Express 应用入口
│           ├── config.ts        # 配置（支持 Dex / Google 切换）
│           ├── oidc.ts          # OIDC 客户端
│           ├── users.ts         # 内部用户与租户映射
│           ├── session.ts       # Session 类型
│           └── routes/
│               ├── auth.ts      # 登录、回调、登出
│               └── api.ts       # 受保护的 API
├── 05/                          # Agent Sandbox（第 5 章）
├── 06/                          # 网络策略（第 6 章）
├── 07/                          # Tool Gateway（第 7 章）
```

## 阶段 1：身份认证与授权

这是平台的入口。完成本阶段后，你可以：

- 启动 Dex 作为本地 OIDC Provider
- 启动 Control Plane
- 用 Alice、Bob、Carol 登录
- 验证租户级授权和跨租户隔离

### 步骤 1：启动 Dex

```bash
cd examples/04
docker compose up -d
```

验证 Dex 正常运行：

```bash
# 健康检查 — 应返回 {"health":"ok"} 或 "Health check passed"
curl http://localhost:5556/dex/healthz

# OIDC 发现文档 — 应返回 JWKS 端点、授权端点等
curl http://localhost:5556/dex/.well-known/openid-configuration | python3 -m json.tool
```

预期输出中应包含：
```json
{
  "issuer": "http://localhost:5556/dex",
  "authorization_endpoint": "http://localhost:5556/dex/auth",
  "token_endpoint": "http://localhost:5556/dex/token",
  "jwks_uri": "http://localhost:5556/dex/keys"
}
```

### 步骤 2：启动 Control Plane

```bash
cd examples/04/control-plane
npm install
npm run dev
```

Control Plane 默认监听 `http://localhost:3000`，并通过 `OIDC_ISSUER_URL=http://localhost:5556/dex` 连接到 Dex。

### 步骤 3：完成 Alice 登录

1. 浏览器打开 `http://localhost:3000`
2. 点击 "Login via OIDC"
3. 跳转到 Dex 登录页面（`http://localhost:5556/dex`）
4. 选择 "Email Password" 连接器
5. 输入 Alice 的凭据：
   - Email: `alice@example.com`
   - Password: `password`
6. 登录成功后，页面显示 Alice 的信息和租户

验证：

```bash
# 查看当前用户信息
curl -H "Cookie: hermes-session=<your-session-cookie>" http://localhost:3000/api/me

# 应返回：
# {
#   "userId": "user-alice-001",
#   "email": "alice@example.com",
#   "name": "Alice",
#   "tenantIds": ["tenant-acme-001"]
# }
```

### 步骤 4：完成 Bob 登录

用 Bob 的凭据重复登录：
- Email: `bob@example.com`
- Password: `password`

Bob 与 Alice 同属 `tenant-acme-001`。登录后，Bob 也应能访问 `tenant-acme-001` 的资源。

### 步骤 5：验证内部用户与租户映射

登录后访问 `GET /api/me`，确认返回的 `userId`、`email` 和 `tenantIds` 与 `examples/04/control-plane/src/users.ts` 中的映射一致。

映射关系：

```
OIDC Identity                        Internal User
──────────────────────────────────────────────────────────────
(iss=dex, sub=08a86..., email=alice)  → user-alice-001, tenant-acme-001
(iss=dex, sub=18b86..., email=bob)    → user-bob-002,   tenant-acme-001
(iss=dex, sub=28c86..., email=carol)  → user-carol-003, tenant-other-002
```

### 步骤 6：验证跨租户访问拒绝

使用 Alice 的 Session：

```bash
# Alice 访问自己的租户 — 成功
curl http://localhost:3000/api/tenant/tenant-acme-001/sandbox \
  -H "Cookie: hermes-session=<alice-session>"

# Alice 尝试访问 Carol 的租户 — 403 拒绝
curl http://localhost:3000/api/tenant/tenant-other-002/sandbox \
  -H "Cookie: hermes-session=<alice-session>"

# 预期返回：
# {"error":"Access denied","message":"You do not have access to this tenant"}
```

使用 Carol 的 Session 反向验证：

```bash
# Carol 访问自己的租户 — 成功
curl http://localhost:3000/api/tenant/tenant-other-002/sandbox \
  -H "Cookie: hermes-session=<carol-session>"

# Carol 尝试访问 Alice 的租户 — 403 拒绝
curl http://localhost:3000/api/tenant/tenant-acme-001/sandbox \
  -H "Cookie: hermes-session=<carol-session>"
```

这验证了服务端授权正确执行。即使前端没有显示其他租户的入口，或攻击者在 URL 中伪造 `tenantId`，服务端仍然拒绝。

### 步骤 7：切换到 Google OIDC

当准备在正式环境部署时，只需设置环境变量：

```bash
export OIDC_ISSUER_URL=https://accounts.google.com
export OIDC_CLIENT_ID=your-google-client-id
export OIDC_CLIENT_SECRET=your-google-client-secret
export OIDC_REDIRECT_URI=https://your-domain.com/auth/callback
export SESSION_SECRET=your-production-session-secret
```

然后启动 Control Plane：

```bash
npm run dev
```

无需修改任何业务代码。Control Plane 使用同一套 OIDC 客户端逻辑，只是 Issuer 和凭证不同。

在 Google Cloud Console 中，确保：
1. 创建 OAuth 2.0 Client ID（类型：Web application）
2. 在 Authorized redirect URIs 中添加 `OIDC_REDIRECT_URI`
3. 启用 Google+ API（部分旧项目需要）

## 安全验收清单

完成本阶段后，应通过以下检查：

| 检查项 | 方法 | 预期结果 |
|--------|------|----------|
| Dex 能正常启动 | `curl http://localhost:5556/dex/health` | `{"health":"ok"}` |
| OIDC 发现文档可访问 | `curl .../.well-known/openid-configuration` | 返回端点和 JWKS URI |
| 应用能发起登录 | 浏览器访问 `/auth/login` | 重定向到 Dex |
| 登录成功并回调 | 用 Alice 登录 | 重定向到首页，显示用户信息 |
| ID Token 验证通过 | 登录后访问 `/api/me` | 返回正确的用户信息 |
| 错误 Issuer 被拒绝 | 修改 OIDC_ISSUER_URL 为无效值 | 启动失败或登录报错 |
| 未知身份被拒绝 | 用不在 `devUsers` 中的账号登录 | 403 Access denied |
| Alice 能访问自己的租户 | `GET /api/tenant/tenant-acme-001/sandbox` | 返回 Sandbox 信息 |
| Alice 不能访问 Carol 的租户 | `GET /api/tenant/tenant-other-002/sandbox` | 403 |
| Session Cookie 安全 | 检查 Cookie 属性 | HttpOnly=true, SameSite=Lax |

## 常见故障排查

### Dex 无法启动

```bash
docker compose logs dex
```

常见原因：
- 端口 5556 被占用：`lsof -i :5556`
- 配置文件 YAML 缩进错误

### 登录后回调失败

- 检查浏览器开发者工具 Console 和 Network 面板
- 确认 Dex 的 `redirectURIs` 与 `OIDC_REDIRECT_URI` 一致

### 登录后仍然显示未认证

- 检查 Cookie：开发者工具 → Application → Cookies
- 确认 `hermes-session` Cookie 存在且有值

## 已知限制与后续扩展

当前参考实现的限制：

1. **内存 Session**：使用 express-session 内存存储，重启后 Session 丢失。生产环境应使用 Redis。
2. **静态用户映射**：`devUsers` 是硬编码的。生产环境应从 PostgreSQL 查询。
3. **无 Sandbox 创建**：本章只演示身份认证和授权。Agent Sandbox 的创建见第 5 章。
4. **无 Tool Gateway**：工具调用的资源级授权在第 7 章展开。

## 本章小结

本章完成了企业 Hermes Agent 平台的身份认证和授权端到端流程：

1. 使用 Dex 启动本地 OIDC 环境，无需 Google 账号
2. 启动 Control Plane，完成 Alice、Bob、Carol 的登录
3. 验证 `(issuer, subject)` 到内部用户的映射
4. 验证跨租户访问拒绝
5. 通过环境变量切换到 Google OIDC

后续阶段将逐步加入 Sandbox 编排、网络策略、Tool Gateway、审批流程和可观测性。

## 参考资料

- 配套代码：`examples/04/`
- Dex 项目：https://dexidp.io/
- Google OAuth 2.0：https://developers.google.com/identity/protocols/oauth2
- openid-client：https://github.com/panva/node-openid-client
