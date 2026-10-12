# 第 4 章配套示例：身份认证与授权

本目录包含第 4 章「企业身份认证与授权」的可运行参考实现。

## 目录结构

```
examples/04/
├── dex-config.yaml          # Dex 本地 OIDC 配置
├── docker-compose.yml       # Docker Compose 启动 Dex
├── README.md                # 本文件
├── .env.example             # 环境变量模板
└── control-plane/           # Control Plane 最小参考实现
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts         # Express 应用入口
        ├── config.ts        # 配置管理（支持 Dex / Google 切换）
        ├── oidc.ts          # OIDC 客户端（openid-client）
        ├── users.ts         # 内部用户与租户映射
        ├── session.ts       # Session 类型定义
        └── routes/
            ├── auth.ts      # 登录、回调、登出
            └── api.ts       # 受保护的 API（演示授权）
```

## 快速开始

### 1. 启动 Dex（本地 OIDC Provider）

```bash
cd examples/04
docker compose up -d
```

验证 Dex 正常运行：

```bash
# 健康检查
curl http://localhost:5556/dex/healthz

# 查看 OIDC 发现文档
curl http://localhost:5556/dex/.well-known/openid-configuration

# 查看 JWKS（公钥）
curl http://localhost:5556/dex/keys
```

### 2. 启动 Control Plane

```bash
cd examples/04/control-plane
npm install
npm run dev
```

默认监听 `http://localhost:3000`。

### 3. 完成登录

1. 浏览器打开 `http://localhost:3000`
2. 点击 "Login via OIDC"
3. 跳转到 Dex 登录页面（`http://localhost:5556/dex`）
4. 选择 "Email Password" 连接器
5. 使用以下测试账号登录：

| 用户 | 邮箱 | 密码 | 租户 |
|------|------|------|------|
| Alice | alice@example.com | password | tenant-acme-001 |
| Bob | bob@example.com | password | tenant-acme-001 |
| Carol | carol@otherorg.com | password | tenant-other-002 |

### 4. 验证授权

登录后，尝试访问：

- `GET /api/me` — 查看当前用户信息
- `GET /api/tenant/tenant-acme-001/sandbox` — Alice/Bob 可访问
- `GET /api/tenant/tenant-other-002/sandbox` — Alice/Bob 应被拒绝（403）

使用 Carol 登录后，反过来验证：Carol 不能访问 `tenant-acme-001`。

### 5. 切换到 Google OIDC（生产环境示例）

设置环境变量即可切换，无需修改业务代码：

```bash
export OIDC_ISSUER_URL=https://accounts.google.com
export OIDC_CLIENT_ID=your-google-client-id
export OIDC_CLIENT_SECRET=your-google-client-secret
export OIDC_REDIRECT_URI=https://your-domain.com/auth/callback
export SESSION_SECRET=your-production-session-secret
npm run dev
```

## 安全说明

- Dex 的静态密码 **仅用于本地开发**，不得用于生产环境。
- `dex-config.yaml` 中的 Client Secret 是开发用占位符。生产环境必须通过 Vault、KMS 或云平台密钥管理工具注入。
- `.env.example` 提供了环境变量模板，不要提交真实凭证到仓库。
- Control Plane 的 Session store 使用内存（express-session 默认），生产环境应切换为 Redis。

## 停止与清理

```bash
cd examples/04
docker compose down
```

## 故障排查

### Dex 无法启动

```bash
docker compose logs dex
```

常见原因：
- 端口 5556 被占用
- `dex-config.yaml` 语法错误（检查 YAML 缩进）

### 登录后回到首页，仍然显示未认证

- 检查浏览器 Cookie 是否被阻止
- 检查 `httpOnly` Cookie 是否正确设置（开发者工具 → Application → Cookies）

### 回调失败，报 "Invalid state"

- 确认 Dex 的 `redirectURIs` 与 `OIDC_REDIRECT_URI` 一致
- 检查是否在 5 分钟内完成了登录

### 登录后被拒绝，报 "Unknown identity"

- 这是预期行为：`users.ts` 中的 `devUsers` 只包含 Alice、Bob、Carol
- 未知邮箱的用户会被拒绝访问
- 生产环境应改为引导到注册/绑定流程
