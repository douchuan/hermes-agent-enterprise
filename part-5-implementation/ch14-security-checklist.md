# 第 14 章：安全验收与生产部署检查清单

## 本章目标

提供可执行的验收标准，判断平台是否达到基本的企业部署要求。

## 验收项目

### 身份与隔离

- [ ] Alice 和 Bob 的 Agent 运行在不同的 Namespace 中
- [ ] Alice 和 Bob 的 Agent 拥有各自独立的加密 PVC
- [ ] 从 Bob 的 Pod 无法访问 Alice 的 Namespace 中的任何服务
- [ ] Alice 和 Bob 的工作目录和 Memory 存储相互隔离
- [ ] 每位员工绑定一个稳定的 Agent 身份（`agentId`），不因 Pod 重建而改变

### 身份认证与授权

- [ ] OIDC Token 在服务端完整验证（签名、Issuer、Audience、Nonce、有效期）
- [ ] 无法通过修改参数伪造身份或扩大工具权限
- [ ] 员工身份到 Agent Sandbox 的映射由服务端维护，不信任 Agent 的自报身份
- [ ] 员工与部门、角色关联，用于 Tool Gateway 授权策略

### 个人 Agent 绑定

- [ ] 员工登录后自动分配或恢复对应的 Agent 身份
- [ ] Agent 身份在 Pod 重建后保持不变
- [ ] 多个并发 Session 共享同一个 Agent 身份

### 委托授权（外部服务）

- [ ] 员工可以主动连接 GitHub 等第三方服务（OAuth 流程）
- [ ] OAuth Token 不暴露在 Agent 环境、日志、Memory 或 Prompt 中
- [ ] Tool Gateway 执行时授权检查，不因 OAuth 存在就放行所有操作
- [ ] 已撤销的 OAuth 连接不能继续用于新的工具调用
- [ ] 高风险操作（如删除仓库）即使有 OAuth 授权也需要审批

### 网络策略

- [ ] Agent 无法绕过网络策略直接访问被禁止的外部目标
- [ ] 正向测试：Agent 可以访问 Tool Gateway 和 Egress Proxy
- [ ] 负向测试：Agent 不能直连外部 API（如 api.github.com）
- [ ] DNS 查询也被限制在允许的域名范围内

### 凭证管理

- [ ] Agent Pod 环境变量中不包含任何企业 API Token
- [ ] Agent 无法读取不应访问的凭证
- [ ] Tool Gateway 使用 Workload Identity（如 IRSA）而非静态云凭证
- [ ] 凭证有自动轮换策略
- [ ] 凭证轮换后旧凭证在短时间内失效

### 存储加密

- [ ] 所有 PVC 使用加密 StorageClass
- [ ] 通过云平台 API 验证底层卷确实启用了加密（如 AWS `describe-volumes` 返回 `Encrypted: true`）
- [ ] PVC 的加密密钥由 KMS 管理
- [ ] KMS 密钥策略遵循最小权限原则

### KMS 权限

- [ ] 无权管理密钥的身份不能修改关键密钥策略或执行未授权的密钥管理操作
- [ ] 存储加密 KMS 与凭证管理 KMS 的权限独立配置
- [ ] KMS 管理操作有审计日志

### Prompt Injection 防护

- [ ] Agent 被注入恶意 Prompt 时，无法直接突破工具授权边界
- [ ] Tool Gateway 不信任 Agent 传来的 `employee_id`、`tenant_id` 等参数
- [ ] Skills 来源经过控制，未经审核的 Skill 不会被加载

### 审批与审计

- [ ] 高风险操作可以被拦截、审批和追溯
- [ ] 审批绑定具体操作、目标和参数，无法通过参数篡改绕过
- [ ] 一次请求的模型调用、工具执行和策略判定可以通过关联 ID 串联
- [ ] 日志和 Trace 中不包含明文凭证或 Memory 内容
- [ ] 关键操作有审计证据，但日志不包含明文密钥

### 备份与恢复

- [ ] PVC 备份/快照创建成功，且继承加密状态
- [ ] 可以从快照恢复 PVC 数据，恢复后数据完整
- [ ] 恢复操作不会将数据交给错误的员工或租户

### 员工生命周期

- [ ] 员工离职后，Sandbox 被暂停，相关访问权限被及时撤销
- [ ] 离职员工的数据按保留策略处理（保留或销毁）
- [ ] 保留期结束后，PVC 和底层加密卷被销毁
- [ ] 审计日志归档到加密长期存储

### 员工转岗

- [ ] 从可信 HR 系统接收组织关系变更
- [ ] 保留原 Agent 身份，重新计算权限
- [ ] 不再允许的部门级工具调用被阻断
- [ ] 旧部门的外部授权连接被禁用或撤销
- [ ] Memory 和 Skills 中的部门敏感信息被评估和处理
- [ ] 所有变更生成可追踪的审计记录
- [ ] 第三方撤销失败时有重试和告警机制

### 平台运维

- [ ] 平台具备基本的容量监控、故障恢复和安全事件响应能力
- [ ] Agent 镜像使用 Digest 固定或经过签名验证
- [ ] 镜像漏洞扫描在部署前执行
- [ ] Pod 重建后，持久化数据不丢失

### 可观测性

- [ ] PVC 存储使用率有监控和告警
- [ ] PVC 加密状态可监控
- [ ] KMS API 延迟有监控
- [ ] 快照创建失败有告警

## 安全验收测试计划

以下测试应在预生产环境中执行。

### T1：隔离验证

| 测试 | 步骤 | 预期结果 |
|------|------|----------|
| T1.1 | `kubectl get all -n hermes-agent-alice` | 只看到 Alice 的资源 |
| T1.2 | `kubectl get all -n hermes-agent-bob` | 只看到 Bob 的资源 |
| T1.3 | 从 Bob 的 Pod curl Alice 的服务 | 连接被拒绝 |

### T2：加密验证

| 测试 | 步骤 | 预期结果 |
|------|------|----------|
| T2.1 | `kubectl get pvc agent-data -n hermes-agent-alice -o jsonpath='{.spec.storageClassName}'` | 输出加密 StorageClass 名称 |
| T2.2 | 通过云平台 API 查询卷加密状态 | `Encrypted: true` |
| T2.3 | 在 Alice 的 Pod 写入文件，从 Bob 的 Pod 读取 | 文件不存在 |

### T3：凭证安全验证

| 测试 | 步骤 | 预期结果 |
|------|------|----------|
| T3.1 | `kubectl exec -n hermes-agent-alice agent -- env` | 不包含任何 API Token |
| T3.2 | Agent 尝试直接调用 GitHub API | 调用失败（无 Token） |
| T3.3 | Agent 通过 Tool Gateway 调用 GitHub API | 调用成功（Tool Gateway 持有凭证） |

### T4：KMS 权限验证

| 测试 | 步骤 | 预期结果 |
|------|------|----------|
| T4.1 | 使用普通员工 IAM 角色尝试 `kms:DisableKey` | AccessDeniedException |
| T4.2 | 使用普通员工 IAM 角色尝试 `kms:PutKeyPolicy` | AccessDeniedException |
| T4.3 | 使用管理员 IAM 角色执行 `kms:DescribeKey` | 成功返回密钥信息 |

### T5：审批验证

| 测试 | 步骤 | 预期结果 |
|------|------|----------|
| T5.1 | Agent 尝试执行高风险操作 | 操作被拦截，触发审批 |
| T5.2 | 审批人批准 | 操作被执行 |
| T5.3 | 修改审批后的请求参数 | 拒绝执行（参数不匹配） |

### T6：离职流程验证

| 测试 | 步骤 | 预期结果 |
|------|------|----------|
| T6.1 | 触发员工离职流程 | Sandbox 暂停，权限撤销 |
| T6.2 | 尝试以该员工身份登录 | 身份映射已撤销 |
| T6.3 | 等待保留期结束后 | PVC 被删除 |
| T6.4 | 通过云平台 API 验证 EBS 卷已销毁 | 卷不存在 |

### T7：委托授权验证

| 测试 | 步骤 | 预期结果 |
|------|------|----------|
| T7.1 | Alice 连接 GitHub OAuth | 授权连接状态为 `active` |
| T7.2 | Alice 的 Agent 调用允许的 GitHub 操作 | 通过授权检查 |
| T7.3 | Alice 的 Agent 调用未授权的 GitHub 操作 | 被拒绝 |
| T7.4 | Alice 断开 GitHub 连接 | 新工具调用被拒绝 |
| T7.5 | Bob 尝试访问 Alice 的授权连接 | 跨用户拒绝 |

### T8：转岗流程验证

| 测试 | 步骤 | 预期结果 |
|------|------|----------|
| T8.1 | Alice 从研发部调到市场部 | 部门更新，Agent 身份保留 |
| T8.2 | Alice 的 Agent 尝试使用 GitHub 工具 | 被拒绝（非研发部） |
| T8.3 | 检查 Alice 的 GitHub OAuth 连接 | 状态为 `disabled` |
| T8.4 | Alice 尝试访问旧部门资源 | 被拒绝 |
| T8.5 | 检查审计日志 | 包含 ORGANIZATION_CHANGED、PERMISSION_RECALCULATED、EXTERNAL_AUTH_DISABLED 事件 |

### T9：Memory 与 Skills 不等于权限

| 测试 | 步骤 | 预期结果 |
|------|------|----------|
| T9.1 | 转岗后 Memory 中仍有旧仓库 URL | 工具调用仍被拒绝 |
| T9.2 | Skill 中定义了 `delete_repo` 步骤 | 高风险操作触发审批 |
| T9.3 | 检查日志和审计事件 | 不包含 Token 值 |

## 已知风险与剩余风险说明

即使通过所有验收测试，以下风险仍然存在：

| 剩余风险 | 说明 | 缓解方向 |
|----------|------|----------|
| 容器内核逃逸 | 标准容器共享宿主机内核 | gVisor / Kata Containers |
| KMS 提供商安全事件 | KMS 服务本身被攻破 | 多 KMS 提供商、本地加密 |
| 零日漏洞 | 新发现的软件漏洞 | 快速补丁流程、入侵检测 |
| 内部威胁 | 有权限的管理员滥用职权 | 访问审计、最小权限、双人审批 |
| 第三方系统风险 | GitHub、Jira 等系统自身的安全问题 | 供应商安全评估、最小授权 |
| 供应链攻击 | CI/CD 流水线或依赖包被篡改 | 镜像签名、SBOM、依赖锁定 |
| 社交工程 | 攻击者通过欺骗员工间接获取访问权限 | 员工培训、审批流程 |
| 配置漂移 | 生产环境的配置随时间偏离预期 | GitOps、定期审计 |

## 本章小结

本章提供了可执行的安全验收清单和测试计划，覆盖身份认证、存储加密、KMS 权限、凭证管理、网络策略、审批流程、备份恢复和员工生命周期。

验收测试应定期执行（建议每季度一次），特别是在以下事件后：
- 平台组件升级
- 存储后端变更
- KMS 密钥轮换
- 安全事件发生后修复验证

**最高优先级**：身份隔离、存储加密、凭证管理、网络策略。
**次优先级**：审批流程、备份恢复、可观测性。
**持续改进**：已知风险的缓解措施随平台成熟度逐步加强。
