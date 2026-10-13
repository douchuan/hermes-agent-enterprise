# 示例：Credential Broker（凭证代理）

对应书籍：第 7 章 / 第 8 章 — 凭证管理与权限最小化

## 目的

演示 Credential Broker 如何为 Tool Gateway 提供临时凭证和资源级 Token，实现授权与凭证持有的分离。

## 原理

Credential Broker 承担以下职责：

1. 从外部凭证存储（如 AWS Secrets Manager）读取原始凭证（如 GitHub App Private Key）。
2. 按需提供临时凭证（如 GitHub Installation Access Token），设置合理的过期时间。
3. 记录凭证获取和使用的审计事件。
4. 不向 Agent 直接暴露长期凭证。

第一阶段作为 Tool Gateway 的内部模块部署，不作为独立服务。保持清晰的内部模块边界（独立接口、独立审计、独立错误处理）。拆分条件见代码头部注释。

## 目录结构

| 文件 | 说明 |
|------|------|
| `index.ts` | Credential Broker 核心实现（TypeScript 源码） |
| `index.js` | 编译后的 JavaScript（可运行） |
| `index.test.ts` | 测试源码 |
| `index.test.js` | 编译后的测试（可运行） |
| `package.json` | 依赖声明 |

## 运行方式

```bash
cd examples/07/credential-broker
npm install
npm test
```

需要 Node.js 18+。测试不依赖外部服务（使用 mock）。

## 预期结果

测试应全部通过，展示：
- 凭证获取流程（读取 Secret → 生成临时 Token → 返回）
- 凭证过期处理
- 审计事件记录

## 关键设计

- **凭证获取与使用分离**：Tool Gateway 调用 Credential Broker 获取临时凭证，而非直接持有长期密钥。
- **临时 Token 过期**：GitHub Installation Access Token 默认 1 小时过期，减少泄露窗口。
- **审计记录**：每次凭证获取和使用都记录到独立审计存储。
- **内部模块而非独立服务**：第一阶段不需要独立扩缩，减少网络暴露面。拆分条件在代码注释中明确列出。

## 安全边界

- 本示例使用 AWS Secrets Manager 作为外部凭证存储的 mock，不实际调用 AWS API。
- 示例中的密钥 ID、KMS Key 等均为占位符，需要按实际环境替换。
- Credential Broker 本身信任 Tool Gateway 的调用方身份（通过 mTLS 或 Workload Identity），这在实际部署中需要严格配置。
- 示例未实现 Token Exchange（RFC 8693）等复杂凭证流转。

## 生产差距

生产环境需要补充：

- 真实的 AWS Secrets Manager / Vault 集成。
- 凭证缓存策略（减少对外部存储的调用频率）。
- 凭证轮换触发机制（当检测到泄露时自动轮换）。
- 独立的审计日志存储和告警。
- 如果拆分为独立服务：mTLS 双向认证、网络策略、独立的 RBAC。
