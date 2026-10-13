# 第 8 章：凭证管理与权限最小化

## 本章目标

避免 Agent 直接持有不必要的长期凭证，并降低凭证泄露后的影响范围。通过本章，读者将理解：

- 为什么不能把企业 API Token 直接注入 Agent 环境
- KMS 与凭证管理的职责边界（存储加密 KMS vs 凭证管理 KMS）
- 如何通过工作负载身份（Workload Identity / IRSA）避免静态凭证
- 临时凭证与长期凭证的选择策略
- 令牌轮换、吊销与泄露响应流程

## 问题背景与使用场景

考虑以下场景：

1. **环境变量泄露**：Agent Pod 的环境变量中包含 GitHub API Token。任何能读取环境变量的进程（包括被 Prompt Injection 诱导的恶意代码）都能获取该 Token。
2. **日志泄露**：Agent 在执行工具时将 Token 打印到日志中。日志收集系统（如 Elasticsearch）存储了明文 Token。
3. **过度授权**：一个用于读取 Jira 工单的 Token 同时拥有写入和删除权限。
4. **长期凭证**：一个 API Token 创建后三年未轮换，期间员工多次调岗，Token 仍然有效。

这些问题的根源不是技术选型错误，而是**凭证生命周期管理的缺失**。

## 威胁模型与设计目标

### 威胁模型

| 威胁 | 来源 | 影响 |
|------|------|------|
| Agent 环境变量中的 Token 被读取 | Pod 内进程、kubectl exec | 企业 API 被未授权访问 |
| Token 被记录到日志 | Agent 错误配置、调试输出 | Token 通过日志系统泄露 |
| 长期 Token 被离职员工使用 | 未吊销的凭证 | 持续未授权访问 |
| 宽泛权限的 Token 被滥用 | Token 权限 > 实际需要的权限 | 超出预期的操作被执行 |
| KMS 密钥被未授权使用 | 错误的 KMS 策略 | 存储加密失效或密钥被滥用 |

### 设计目标

1. **Agent 不持有企业 API 凭证**：所有工具调用通过 Tool Gateway 执行，由 Tool Gateway 持有和管理凭证。
2. **最小权限**：每个凭证只拥有完成特定操作所需的最小权限。
3. **自动轮换**：凭证有明确的过期时间和轮换策略。
4. **KMS 职责分离**：存储加密 KMS 与凭证管理 KMS 的职责必须清晰区分。
5. **可审计**：每次凭证使用和轮换都有记录。

## 架构与工作机制

### 8.1 两种 KMS 的职责边界

本章讨论的 KMS 与第 5 章的存储加密 KMS 是**同一个技术组件（如 AWS KMS）但在架构上承担不同角色**：

| 角色 | 存储加密 KMS（第 5 章） | 凭证管理 KMS（本章） |
|------|------------------------|---------------------|
| 保护对象 | PVC/EBS 卷的静态数据 | 应用层加密的凭证（如数据库密码、API Token） |
| 调用者 | 存储后端（EBS CSI Driver） | 应用程序（Tool Gateway、Control Plane） |
| 操作 | `GenerateDataKey`、`Decrypt` | `Decrypt`（解密受保护的凭证） |
| 频率 | 每次磁盘读写（透明） | 凭证加载时（低频） |
| Agent 是否接触 | 否（对 Agent 完全透明） | 否（Agent 不接触凭证） |

**关键区分**：

- **存储加密 KMS**：由存储后端调用，透明加解密落盘数据。Hermes Agent 不需要知道 KMS 的存在。
- **凭证管理 KMS**：如果需要用它加密应用凭证（如数据库连接字符串），调用方是 Tool Gateway 或 Control Plane，不是 Agent。
- **不要混淆两者**：存储加密 KMS 的密钥策略（谁能加密/解密 PVC 数据）与凭证 KMS 的密钥策略（谁能解密存储的 API Token）应该独立配置。

### 8.2 Agent 不持有企业凭证

这是本章的核心原则。

```
┌─────────────────────────────────────────┐
│  Agent Sandbox                           │
│                                          │
│  Hermes Agent                            │
│  - 不持有 GitHub Token                   │
│  - 不持有 Jira API Key                   │
│  - 不持有 Slack Bot Token                │
│  - 环境变量只有 employee_id、tenant_id   │
│                                          │
│  工具调用请求 → Tool Gateway             │
└──────────────────┬───────────────────────┘
                   │
                   v
┌─────────────────────────────────────────┐
│  Tool Gateway                            │
│                                          │
│  1. 验证调用方身份（mTLS / Workload ID） │
│  2. 查找该员工对应的权限策略              │
│  3. 从 Vault / Secret Manager 获取凭证    │
│  4. 执行实际操作                          │
│  5. 记录审计日志                          │
│                                          │
│  [凭证不离开 Tool Gateway 进程]           │
└─────────────────────────────────────────┘
```

如果 Agent 持有凭证：
- Agent 被 Prompt Injection 诱导后，攻击者直接使用凭证访问企业系统。
- Pod 日志、内存 dump、环境变量都可能泄露凭证。
- 凭证轮换需要更新每个 Agent Sandbox。

如果 Tool Gateway 持有凭证：
- Agent 只能请求 Tool Gateway 执行操作。
- Tool Gateway 执行服务端授权检查。
- 凭证轮换只影响 Tool Gateway，不影响 Agent。

### 8.3 Workload Identity：避免向 Agent 注入静态云凭证

如果 Tool Gateway 需要访问 AWS 服务（如 S3、DynamoDB），它需要 AWS 凭证。**不能**通过环境变量注入长期的 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`。

**推荐方案：IRSA（IAM Roles for Service Accounts）**

IRSA 允许 Kubernetes ServiceAccount 映射到 AWS IAM Role。Pod 启动时自动获取临时 STS 凭证，无需静态密钥。

```yaml
# examples/08/tool-gateway-service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tool-gateway
  namespace: hermes-systems
  annotations:
    # IRSA 注解：将 K8s ServiceAccount 映射到 AWS IAM Role
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/hermes-tool-gateway-role
automountServiceAccountToken: true  # Tool Gateway 需要 K8s Token 来换取 STS 凭证
---
# examples/08/tool-gateway-iam-policy.json
# Tool Gateway 的 IAM Policy（最小权限）
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": [
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:hermes/github-token-*",
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:hermes/jira-token-*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt"
      ],
      "Resource": [
        "arn:aws:kms:us-east-1:123456789012:key/xxx"  # 凭证加密密钥
      ]
    }
  ]
}
```

IRSA 的工作原理：
1. EKS 向 ServiceAccount 注入 OIDC Token。
2. Tool Gateway 使用该 Token 调用 AWS STS `AssumeRoleWithWebIdentity`。
3. STS 返回临时凭证（默认 1 小时过期）。
4. Tool Gateway 使用临时凭证访问 Secrets Manager 和 KMS。
5. 临时凭证过期后，自动重新获取。

**与存储加密 KMS 的对比**：

- Tool Gateway 的 IAM Role 拥有 `kms:Decrypt` 权限，用于解密存储在 Secrets Manager 中的应用凭证。
- 存储加密 KMS 的 `kms:GenerateDataKey` / `kms:Decrypt` 权限由 EBS CSI Driver 的服务角色持有。
- 两者的密钥可以是同一个 KMS CMK，但 IAM Policy 应该独立定义。

### 8.4 Vault 与云 Secret Manager

如果企业使用 HashiCorp Vault 或云 Secret Manager（如 AWS Secrets Manager、GCP Secret Manager），凭证存储和访问流程如下：

```
Tool Gateway 启动
    ↓
使用 Workload Identity 认证（IRSA / GKE Workload Identity）
    ↓
向 Vault / Secrets Manager 请求凭证
    ↓
返回受管凭证（可能经过 KMS 加密）
    ↓
Tool Gateway 在内存中持有凭证，不写入磁盘
    ↓
Agent 请求工具调用 → Tool Gateway 使用凭证执行操作
```

**关键配置**：

```bash
# AWS Secrets Manager 存储 GitHub Token
aws secretsmanager create-secret \
  --name "hermes/github-token" \
  --description "GitHub PAT for Hermes Agent tool calls" \
  --secret-string '{"token":"ghp_xxx"}'

# 设置自动轮换（例如每 30 天）
aws secretsmanager rotate-secret \
  --secret-id "hermes/github-token" \
  --rotation-lambda-arn "arn:aws:lambda:...:function:github-token-rotation" \
  --rotation-rules '{"AutomaticallyAfterDays":30}'
```

### 8.5 临时凭证 vs 长期凭证

| 凭证类型 | 示例 | 过期时间 | 适用场景 |
|----------|------|----------|----------|
| 临时凭证 | AWS STS Token | 15 分钟 - 12 小时 | 云 API 访问 |
| 短期 Token | OIDC Access Token | 1 小时 | 员工登录会话 |
| 可轮换长期凭证 | GitHub PAT、Jira Token | 由轮换策略控制 | 第三方系统 API |
| 长期凭证（不推荐） | 永不过期的 API Key | 永不过期 | 遗留系统，应逐步替换 |

**原则**：

1. 优先使用临时凭证（STS、OIDC Exchange）。
2. 对必须使用长期凭证的场景，实施自动轮换。
3. 不使用永不过期的凭证。
4. 每次轮换后，旧凭证应在短时间内失效（如 5 分钟宽限期）。

### 8.6 防止凭证泄露到日志和 Memory

Agent 和 Tool Gateway 必须避免将凭证写入日志或持久化存储：

```typescript
// 错误示例：将 Token 打印到日志
async function callGitHub(token: string) {
  logger.info(`Using token: ${token}`);  // ❌ Token 进入日志
  // ...
}

// 正确示例：使用 Token 但不记录
async function callGitHub(token: string) {
  const response = await fetch("https://api.github.com/repos/...", {
    headers: { Authorization: `Bearer ${token}` },
  });
  logger.info(`GitHub API call: status=${response.status}`);  // ✓ 只记录状态码
}
```

在 OpenTelemetry Trace 中也应避免记录凭证：

```typescript
// 错误：Span 属性中包含 Token
span.setAttribute("github.token", token);

// 正确：只记录元数据
span.setAttribute("github.endpoint", "/repos/owner/repo");
span.setAttribute("github.method", "GET");
span.setAttribute("github.status_code", response.status);
```

第 10 章详细讨论了可观测性中的敏感数据处理。

### 8.7 外部服务委托授权的凭证管理

当员工通过 OAuth 委托 Agent 访问外部服务时（第 7 章），凭证管理有以下特殊要求：

**凭证与员工、租户的绑定**：

```typescript
interface DelegatedCredential {
  id: string;               // connection_id
  employeeId: string;       // 属于哪个员工
  tenantId: string;         // 属于哪个租户
  provider: string;         // "github", "jira", "slack"
  mode: "oauth" | "enterprise_app";
  accessToken: string;      // 加密存储
  refreshToken?: string;    // 加密存储（如 OAuth 支持刷新）
  scopes: string[];         // 授权范围
  expiresAt: Date;          // Token 过期时间
  status: "active" | "expired" | "revoked" | "disabled";
  // 审计字段
  createdAt: Date;
  revokedAt?: Date;
  revokedBy?: string;       // 员工主动断开 / 平台禁用 / 安全事件
  revokedReason?: string;
}
```

**凭证不能进入 Agent 环境**：

- OAuth Access Token 存储在 Credential Store（如 Vault 或云 Secret Manager），加密存储。
- Tool Gateway 需要执行操作时，从 Credential Store 获取 Token，使用后释放。
- Token 不注入 Agent Pod 的环境变量、ConfigMap 或任何 Agent 可访问的存储。
- Token 不进入 Prompt、Memory、Skills 或任何可能被模型输出的上下文。

**最小权限原则应用于每个委托连接**：

- OAuth scope 应尽量缩小。例如 `repo` scope 授予仓库读写权限，`public_repo` 只授予公共仓库权限。
- 企业策略可以进一步限制：即使员工授权了 `delete_repo` scope，平台策略可以拒绝该操作。
- 企业应用身份（如 GitHub App）的权限由 IT 管理员配置，不依赖员工个人授权。

**Token 安全存储**：

```
┌─────────────────────────────────────────┐
│  Credential Store                       │
│  (Vault / AWS Secrets Manager)          │
│                                         │
│  Path: hermes/oauth/alice/github        │
│  Value: { access_token: "gho_...",     │
│           refresh_token: "...",         │
│           scopes: ["repo"],             │
│           expires_at: "2025-..." }      │
│                                         │
│  加密：KMS 密钥                         │
│  访问：仅 Tool Gateway 的 Workload ID   │
│  审计：每次读取有记录                    │
└─────────────────────────────────────────┘
         ▲
         │ 按需获取，不持久持有
         │
┌────────┴────────────────────────────────┐
│  Tool Gateway                           │
│  - 启动时不预加载所有 Token              │
│  - 需要时从 Credential Store 获取        │
│  - 使用后不在内存中长期保留              │
└─────────────────────────────────────────┘
```

### 8.8 员工转岗与离职时的凭证回收

**转岗时的凭证处理**：

当 Alice 从研发部调到市场部：

1. **平台侧立即禁用**：Control Plane 将不再适用的授权连接标记为 `disabled`，Tool Gateway 拒绝使用这些凭证的新请求。
2. **评估每个连接的适用性**：
   - 研发部专属 GitHub 团队的凭证 → 不再需要，标记 `revoked`。
   - 企业 GitHub App 的凭证 → 如果市场部也需要使用，保留但重新评估权限。
   - 员工个人 GitHub OAuth 连接 → 由员工决定是否保持连接（企业策略可能要求断开）。
3. **第三方撤销**：
   - 调用 GitHub API 撤销不再需要的 Token（如支持）。
   - 从 GitHub Team 中移除 Alice 的成员关系。
   - **注意**：第三方撤销可能有延迟或 API 限制，平台侧禁用是即时生效的第一道防线。
4. **清理运行环境中可能残留的凭证**：
   - 确认 Agent Sandbox 中没有环境变量、配置文件或 Skill 定义包含旧凭证。
   - Agent 不直接持有凭证（第 8.2 节），但仍需检查 Skill 定义中是否固化了过时的资源标识。

**离职时的凭证处理**：

当员工离职：

1. **立即禁用所有授权连接**：标记所有 `DelegatedCredential` 为 `revoked`。
2. **删除本地凭证**：从 Credential Store 中删除该员工的所有凭证记录。
3. **第三方撤销**：
   - 撤销所有 OAuth Token。
   - 从所有 GitHub Team、Slack Workspace、Jira Project 中移除成员关系。
   - 吊销 GitHub App 的 Installation Access Token（如由企业统一管理）。
4. **记录审计事件**：记录所有凭证回收操作，包括成功、失败和重试状态。

**重要工程事实**：

- **不能仅删除内部数据库角色就声称第三方权限已撤销。** 需要根据第三方 API 能力同步变更、禁用凭证或执行撤销。
- **对于无法即时撤销的外部授权**（如第三方 API 限流、不支持撤销），通过凭证禁用、Gateway 拒绝、持续重试和告警降低风险。
- **Agent 运行实例重建后**，Credential Store 中已被禁用的凭证不会被重新加载，新的 Agent 实例只加载当前有效的凭证。

## 实现步骤

### 8.1 Tool Gateway 凭证获取流程

```typescript
// examples/08/tool-gateway-credentials.ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secretsClient = new SecretsManagerClient({
  // 使用 IRSA 自动认证，不需要配置 accessKeyId/secretAccessKey
});

interface ToolCredential {
  toolName: string;
  secretId: string;
}

const CREDENTIAL_MAP: ToolCredential[] = [
  { toolName: "github", secretId: "hermes/github-token" },
  { toolName: "jira", secretId: "hermes/jira-token" },
  { toolName: "slack", secretId: "hermes/slack-bot-token" },
];

// 启动时加载凭证
async function loadCredentials(): Promise<Map<string, string>> {
  const credentials = new Map<string, string>();

  for (const { toolName, secretId } of CREDENTIAL_MAP) {
    const command = new GetSecretValueCommand({ SecretId: secretId });
    const response = await secretsClient.send(command);
    if (response.SecretString) {
      const parsed = JSON.parse(response.SecretString);
      credentials.set(toolName, parsed.token);
    }
  }

  return credentials;
}

// 定期刷新凭证（轮换后自动获取新凭证）
function scheduleCredentialRefresh(intervalMs = 3600000): void {
  setInterval(async () => {
    try {
      const newCreds = await loadCredentials();
      // 原子替换凭证映射
      credentialMap.clear();
      newCreds.forEach((v, k) => credentialMap.set(k, v));
      logger.info("Credentials refreshed successfully");
    } catch (err) {
      logger.error("Failed to refresh credentials", { error: err });
    }
  }, intervalMs);
}
```

### 8.2 KMS 密钥策略：最小权限

```json
{
  "Version": "2012-10-17",
  "Id": "hermes-storage-key-policy",
  "Statement": [
    {
      "Sid": "AllowRootAccountAccess",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:root"
      },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "AllowEBSServiceToUseKey",
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowToolGatewayToDecryptCredentials",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/hermes-tool-gateway-role"
      },
      "Action": [
        "kms:Decrypt",
        "kms:DescribeKey"
      ],
      "Resource": "*"
    }
  ]
}
```

**说明**：
- `AllowRootAccountAccess`：AWS 根账户拥有完全权限（所有 KMS 密钥默认策略）。
- `AllowEBSServiceToUseKey`：EBS 服务可以使用该密钥进行存储加密。
- `AllowToolGatewayToDecryptCredentials`：Tool Gateway 可以解密密文凭证。
- 没有 `kms:DisableKey`、`kms:ScheduleKeyDeletion` 权限的 IAM 角色不能禁用或删除密钥。

### 8.3 凭证轮换与吊销流程

```
正常轮换（每 30 天）：
1. Secrets Manager 触发轮换 Lambda
2. Lambda 创建新的 API Token
3. Lambda 更新 Secrets Manager 中的密钥值
4. Tool Gateway 下次刷新时获取新凭证
5. 旧 Token 在第三方系统中失效

紧急吊销（凭证泄露）：
1. 安全团队确认泄露
2. 在第三方系统（如 GitHub）中吊销 Token
3. 在 Secrets Manager 中更新凭证
4. 强制 Tool Gateway 立即刷新凭证
5. 审计日志中检查泄露期间的所有操作
6. 评估是否需要通知受影响的用户
```

```typescript
// examples/08/credential-rotation.ts
async function emergencyRevokeCredential(toolName: string): Promise<void> {
  // 1. 在第三方系统吊销 Token（伪代码）
  await revokeInExternalSystem(toolName);

  // 2. 更新 Secrets Manager
  const newToken = await generateNewToken(toolName);
  await secretsManager.updateSecret({
    SecretId: `hermes/${toolName}-token`,
    SecretString: JSON.stringify({ token: newToken }),
  });

  // 3. 强制立即刷新
  await loadCredentials();

  // 4. 记录审计事件
  await auditLog({
    action: "EMERGENCY_CREDENTIAL_REVOCATION",
    tool: toolName,
    timestamp: new Date().toISOString(),
    initiatedBy: "security-team",
  });
}
```

## 安全边界、取舍与剩余风险

### 本章方案能防范什么

| 威胁 | 防范机制 | 有效性 |
|------|----------|--------|
| Agent 持有企业 API Token | 凭证只存在于 Tool Gateway | 强 |
| 环境变量中的 Token 泄露 | 不使用环境变量注入凭证 | 强 |
| 凭证被记录到日志 | 日志脱敏 + 审计规则 | 强 |
| 长期凭证未轮换 | 自动轮换策略 | 强 |
| 凭证泄露后持续可用 | 紧急吊销流程 | 中（依赖第三方系统的吊销速度） |
| 未授权使用 KMS 密钥 | KMS 最小权限策略 | 强 |

### 本章方案不能防范什么

| 威胁 | 需要补充的措施 |
|------|----------------|
| Tool Gateway 本身被攻破 | Tool Gateway 的容器安全加固、网络隔离（第 5、6 章） |
| 第三方系统（如 GitHub）的安全事件 | 第三方系统的独立安全评估 |
| 员工通过合法权限直接访问企业系统（不通过 Agent） | 企业系统的独立访问控制 |
| KMS 管理员禁用或删除密钥 | KMS 访问审计、变更审批流程 |

### 取舍

1. **IRSA vs 静态凭证**：IRSA 消除了静态密钥的管理开销，但需要 EKS 和 IAM 的正确配置。非 AWS 环境使用类似的工作负载身份机制（如 GKE Workload Identity、Vault Kubernetes Auth）。
2. **共享 KMS 密钥 vs 每工具独立密钥**：参考实现中，存储加密和凭证加密可能使用同一 KMS CMK。如果合规要求独立密钥，需为每个工具创建独立的 KMS 密钥和 IAM Policy。
3. **凭证轮换频率**：过于频繁的轮换（如每小时）增加 API 调用成本和失败风险。30 天是平衡点，敏感凭证可以缩短到 7 天。

## 本章小结

1. **Agent 不持有企业凭证**：所有工具调用通过 Tool Gateway，凭证由 Tool Gateway 管理和使用。
2. **Workload Identity 替代静态凭证**：使用 IRSA 或等效机制，避免向 Pod 注入长期云凭证。
3. **KMS 职责分离**：存储加密 KMS 保护落盘数据，凭证管理 KMS 保护应用凭证。两者使用相同的 KMS 技术，但策略独立。
4. **自动轮换**：所有凭证有明确的轮换策略，不使用永不过期的 Token。
5. **紧急吊销**：凭证泄露时有快速吊销和审计流程。
6. **防止日志泄露**：日志和 Trace 中不记录明文凭证。

## 参考资料

- AWS IRSA 文档：https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html
- AWS Secrets Manager 轮换：https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html
- HashiCorp Vault Kubernetes Auth：https://developer.hashicorp.com/vault/docs/auth/kubernetes
- GKE Workload Identity：https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity
- Kubernetes Secrets 安全最佳实践：https://kubernetes.io/docs/concepts/security/secrets-good-practices/
