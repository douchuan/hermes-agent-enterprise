# 第 4 章配套示例：身份认证与授权

本目录包含第 4 章「企业身份认证与授权」的可运行参考实现。

## 目录结构

```
examples/04/
├── k8s/                     # Dex Kubernetes 部署配置
│   ├── namespace.yaml       # hermes-dev Namespace
│   ├── configmap.yaml       # Dex 配置 ConfigMap
│   ├── deployment.yaml      # Dex Deployment（含健康检查、资源限制）
│   ├── service.yaml         # Dex ClusterIP Service
│   └── kustomization.yaml   # Kustomize 编排
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

## 前置条件

- Kubernetes 集群（本地开发推荐 kind、minikube 或 Docker Desktop 内置 k8s）
- `kubectl` 已安装并配置好上下文
- Node.js 22+（运行 Control Plane）

## 快速开始

### 1. 确认集群上下文

```bash
kubectl cluster-info
kubectl config current-context
```

如果本地没有可用集群，可以使用 kind 快速创建：

```bash
kind create cluster --name hermes-dev
```

### 2. 部署 Dex

```bash
kubectl apply -k examples/04/k8s/
```

等待 Pod 就绪：

```bash
kubectl -n hermes-dev rollout status deployment/dex --timeout=60s
```

检查 Pod 和 Service 状态：

```bash
kubectl -n hermes-dev get pods
kubectl -n hermes-dev get svc dex
```

### 3. 本地访问 Dex（port-forward）

Dex 的 Service 类型为 ClusterIP，仅在集群内部可访问。
本地开发通过 `kubectl port-forward` 暴露到 localhost：

```bash
kubectl -n hermes-dev port-forward svc/dex 5556:5556 &
```

> **注意**：port-forward 仅用于本地开发，不是生产环境的网络入口方案。
> Dex 的 `issuer` 配置为 `http://localhost:5556/dex`，与 port-forward 访问地址一致，
> 确保浏览器、发现文档和 ID Token 中的 `iss` 声明相互匹配。

验证 Dex 正常运行：

```bash
# 健康检查
curl http://localhost:5556/dex/healthz

# OIDC 发现文档
curl http://localhost:5556/dex/.well-known/openid-configuration

# JWKS（公钥）
curl http://localhost:5556/dex/keys
```

### 4. 启动 Control Plane

```bash
cd examples/04/control-plane
npm install
npm run dev
```

默认监听 `http://localhost:3000`。

### 5. 完成登录

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

### 6. 验证授权

登录后，尝试访问：

- `GET /api/me` — 查看当前用户信息
- `GET /api/tenant/tenant-acme-001/sandbox` — Alice/Bob 可访问
- `GET /api/tenant/tenant-other-002/sandbox` — Alice/Bob 应被拒绝（403）

使用 Carol 登录后，反过来验证：Carol 不能访问 `tenant-acme-001`。

### 7. 切换到 Google OIDC（生产环境示例）

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
- ConfigMap 中的 Client Secret 是开发用占位符。生产环境必须通过 Kubernetes Secret 和外部 Secret Manager（Vault、云 KMS）注入。
- `.env.example` 提供了环境变量模板，不要提交真实凭证到仓库。
- Control Plane 的 Session store 使用内存（express-session 默认），生产环境应切换为 Redis。

## 清理

```bash
# 停止 port-forward
kill %1 2>/dev/null || true

# 删除所有 Kubernetes 资源
kubectl delete -k examples/04/k8s/

# 如果使用 kind，删除集群
kind delete cluster --name hermes-dev
```

## 故障排查

### Dex Pod 无法启动

```bash
kubectl -n hermes-dev describe pod -l app=dex
kubectl -n hermes-dev logs -l app=dex
```

常见原因：
- 镜像拉取失败（网络问题）
- ConfigMap 未创建（先执行 `kubectl apply -k`）

### 健康检查失败

```bash
kubectl -n hermes-dev get endpoints dex
```

确认 Service 正确关联到 Dex Pod。

### OIDC Issuer 不匹配

如果 ID Token 中的 `iss` 与应用的 `OIDC_ISSUER_URL` 不一致，登录将失败。
Dex 的 `issuer` 配置为 `http://localhost:5556/dex`，与 `OIDC_ISSUER_URL` 环境变量默认值一致。

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
