# 第 12 章：镜像供应链与平台生命周期

## 本章目标

将安全控制延伸到镜像构建、依赖更新、员工生命周期和平台运维。

## 镜像供应链

### Agent 镜像的构建与发布

```
开发者推送代码
    ↓
CI Pipeline 构建镜像
    ↓
扫描镜像漏洞（Trivy / Grype）
    ↓
生成 SBOM（Syft）
    ↓
签名镜像（Cosign）
    ↓
推送到镜像仓库（ECR / GHCR）
```

### 镜像 Digest 固定

```yaml
# 错误：使用 mutable tag
image: ghcr.io/example-org/hermes-agent:v1.2.3

# 正确：使用 digest 固定
image: ghcr.io/example-org/hermes-agent@sha256:abc123...
```

Digest 固定的好处：
- 防止 tag 被覆盖后部署不同内容的镜像。
- 即使 `v1.2.3` tag 被重新指向，digest 仍指向原始构建。

### SBOM 与签名验证

```bash
# 生成 SBOM
syft ghcr.io/example-org/hermes-agent:v1.2.3 -o spdx-json > sbom.json

# 签名镜像
cosign sign --key cosign.key ghcr.io/example-org/hermes-agent@sha256:abc123...

# 验证签名
cosign verify --key cosign.pub ghcr.io/example-org/hermes-agent@sha256:abc123...
```

## 员工生命周期

员工的生命周期管理直接影响 Sandbox、凭证、存储数据和审计数据的处理。

### 入职流程

```
HR 系统创建员工记录
    ↓
Control Plane 收到入职事件
    ↓
1. 创建 Namespace（hermes-agent-<employee-id>）
2. 创建加密 PVC（StorageClass: encrypted-ssd）
3. 创建 ServiceAccount
4. 创建 ConfigMap（Agent 配置）
5. 部署 Agent Pod（Deployment replicas: 1）
6. 应用 NetworkPolicy
7. 等待 Pod Ready
8. 更新员工 → Sandbox 映射
9. 记录审计事件：EMPLOYEE_ONBOARDED
```

### 调岗流程

员工调岗可能影响：
- **租户变更**：员工从一个租户调到另一个租户。需要重新创建 Sandbox（Namespace 级别隔离）。
- **权限变更**：员工在同一租户内的角色变更。更新 Tool Gateway 中的权限策略。
- **工具访问变更**：员工需要访问新工具或不再访问某些工具。更新 Tool Gateway 的工具可用列表。

```typescript
// examples/12/employee-transfer.ts
async function handleEmployeeTransfer(
  employeeId: string,
  newTenantId: string,
  oldTenantId: string
): Promise<void> {
  // 1. 暂停旧 Sandbox
  await pauseSandbox(employeeId, oldTenantId);

  // 2. 如果跨租户，创建新 Sandbox
  if (newTenantId !== oldTenantId) {
    await createSandbox({
      employeeId,
      tenantId: newTenantId,
      image: AGENT_IMAGE,
      storage: "20Gi",
      storageClass: "encrypted-ssd",
      cpuLimit: "2",
      memoryLimit: "4Gi",
    });
  }

  // 3. 更新权限策略
  await updateToolGatewayPolicies(employeeId, newTenantId);

  // 4. 记录审计事件
  await emitAuditEvent({
    eventType: "EMPLOYEE_TRANSFERRED",
    employeeId,
    oldTenant: oldTenantId,
    newTenant: newTenantId,
    timestamp: new Date().toISOString(),
  });
}
```

### 离职流程

离职流程是数据安全的关键环节。参考实现采用**保留期 + 渐进销毁**的策略：

```
HR 系统发送离职事件
    ↓
Control Plane 收到离职事件
    ↓
阶段 1：立即禁用（T+0）
  1. 暂停 Sandbox（Deployment replicas: 0）
  2. 撤销员工的 OIDC 身份映射
  3. 撤销 Tool Gateway 中的权限
  4. 记录审计事件：EMPLOYEE_DISABLED

阶段 2：数据保留期（T+0 ~ T+30 天）
  5. PVC 保留，标记 retain=true
  6. 如有合规需求，归档数据到加密长期存储
  7. 保留期间可由管理员挂载 PVC 审计

阶段 3：数据销毁（T+30 天）
  8. 删除 PVC（reclaimPolicy: Delete → EBS 卷销毁）
  9. 删除 Namespace（级联删除剩余资源）
  10. 归档审计日志到长期存储（按合规保留期）
  11. 记录审计事件：EMPLOYEE_OFFBOARDED
```

**关于 KMS 密钥**：

参考实现使用共享 KMS 密钥。离职员工的 PVC 使用与其他活跃员工相同的 KMS 密钥加密。因此：

- **不需要**在员工离职时禁用或轮换 KMS 密钥。
- 如果需要立即阻止离职员工的数据被解密（极端合规场景），且使用了每员工独立 KMS 密钥，可以禁用该员工的专属密钥。

**关于凭证**：

- 员工不直接持有企业凭证（第 8 章），因此离职时不需要轮换企业 API Token。
- 如果员工通过 Tool Gateway 访问的系统（如 GitHub）记录了员工的个人 Token（而非 Tool Gateway 的服务 Token），需要在该系统中吊销或转移这些 Token。

**关于审计数据**：

- 审计日志和会话记录在离职前已归档。
- 归档数据的保留期由合规要求决定（如 1-7 年）。
- 归档数据存储在加密长期存储中（如 S3 Glacier），访问受独立控制。

```typescript
// examples/12/employee-offboarding.ts
async function offboardEmployee(employeeId: string, options?: { immediate?: boolean }): Promise<void> {
  const ns = `hermes-agent-${employeeId}`;

  // === 阶段 1：立即禁用 ===

  // 1. 暂停 Sandbox
  await appsV1.patchNamespacedDeploymentScale(
    "agent", ns,
    { spec: { replicas: 0 } } as k8s.V1Deployment
  );

  // 2. 撤销身份映射
  await controlPlane.revokeIdentityMapping(employeeId);

  // 3. 撤销 Tool Gateway 权限
  await toolGateway.revokeEmployeePermissions(employeeId);

  await emitStorageAuditEvent({
    eventType: "EMPLOYEE_OFFBOARDED",
    employeeId,
    namespace: ns,
    initiatedBy: "hr-system",
    timestamp: new Date().toISOString(),
    details: { phase: "immediate_disable" },
  });

  if (options?.immediate) {
    // === 阶段 3：立即销毁 ===

    // 归档审计日志
    await archiveAuditLogs(employeeId);

    // 归档 PVC 数据（如果需要保留）
    if (needsRetention(employeeId)) {
      await archivePVCDataToS3(employeeId, ns);
    }

    // 删除 Namespace
    await coreV1.deleteNamespace(ns);

    await emitStorageAuditEvent({
      eventType: "EMPLOYEE_OFFBOARDED",
      employeeId,
      namespace: ns,
      initiatedBy: "hr-system",
      timestamp: new Date().toISOString(),
      details: { phase: "data_destroyed" },
    });
  } else {
    // === 阶段 2：保留数据 ===

    // 标记 PVC 保留
    await tagPVCForRetention(ns, "agent-data", {
      retain: "true",
      retentionUntil: calculateRetentionDate(employeeId),  // 30 天后
      employeeId,
    });

    // 删除 Namespace 中的其他资源（保留 PVC）
    await deleteNamespaceExceptPVCs(ns);

    // 调度 30 天后的自动销毁
    scheduleDataDestruction(employeeId, ns, 30);
  }
}
```

## Pod 重建与持久化数据

### 镜像更新与 Pod 重建的关系

当 Hermes Agent 镜像更新时：

1. Control Plane 更新 Deployment 的 `spec.template.spec.containers[0].image`。
2. Deployment 使用 `strategy.type: Recreate`，先终止旧 Pod，再创建新 Pod。
3. 新 Pod 挂载相同的 PVC（`agent-data`），数据不丢失。
4. 新 Pod 使用相同的加密卷，加密状态不变。

```
镜像更新 → Pod 重建 → 新镜像 + 旧数据
                              ↓
                    工作目录：保留
                    Memory：保留
                    会话历史：保留
                    配置：从 ConfigMap 重新加载
```

### 避免数据丢失

| 风险 | 防范 |
|------|------|
| PVC 误删 | `reclaimPolicy: Retain`（生产环境）或定期快照 |
| Pod 更新导致数据丢失 | 使用 PVC 而非 emptyDir 存储需要保留的数据 |
| 快照覆盖 | 快照命名包含时间戳，保留策略防止覆盖 |
| 镜像更新不兼容旧数据 | 数据迁移脚本、版本兼容性检查 |

## 平台升级与运维

### 控制平面升级

Control Plane 升级不应影响运行中的 Agent Sandbox：

1. 使用 Deployment 滚动更新 Control Plane。
2. 升级期间，Agent Sandbox 继续运行。
3. 升级完成后，Control Plane 重新加载员工 → Sandbox 映射。

### 存储后端维护

存储后端维护（如 EBS 快照、CSI Driver 更新）可能影响 PVC：

1. 维护前创建所有 PVC 的快照。
2. 维护期间，新创建的 PVC 可能延迟。
3. 维护后，验证 PVC 挂载和加密状态。

## 安全事件响应

### 事件分类

| 级别 | 示例 | 响应 |
|------|------|------|
| Critical | KMS 密钥泄露、Tool Gateway 被攻破 | 立即吊销凭证、暂停所有 Sandbox、审计所有操作 |
| High | 单个员工 Sandbox 被入侵、凭证泄露 | 暂停该员工 Sandbox、轮换凭证、审计操作 |
| Medium | PVC 使用率告警、快照创建失败 | 调查原因、扩容或修复 |
| Low | 镜像漏洞扫描警告（非运行时利用） | 计划修复、更新镜像 |

### 响应流程

```
安全事件检测
    ↓
1. 确认事件范围和影响
2. 执行遏制措施（暂停 Sandbox、吊销凭证等）
3. 收集取证（审计日志、Trace、日志）
4. 执行修复（轮换凭证、更新镜像、修复配置）
5. 验证修复有效性
6. 编写事件报告
7. 更新安全策略和自动化规则
```

## 安全边界、取舍与剩余风险

### 本章方案能防范什么

| 威胁 | 防范机制 |
|------|----------|
| 恶意镜像被部署 | 镜像签名验证、SBOM 扫描 |
| 离职员工仍能访问系统 | 身份映射撤销、权限吊销 |
| 离职员工数据未清理 | 保留期 + 自动销毁 |
| Pod 更新导致数据丢失 | PVC 持久化 + 快照备份 |

### 本章方案不能防范什么

| 威胁 | 需要补充的措施 |
|------|----------------|
| CI/CD 流水线被入侵 | CI/CD 的安全加固、最小权限 runner |
| 镜像仓库被入侵 | 镜像仓库的访问控制、审计 |
| 第三方系统（如 GitHub）中的员工个人凭证 | 第三方系统的独立凭证管理 |

### 取舍

1. **Digest 固定 vs Tag**：Digest 安全但更新需要修改配置。Tag 方便但不安全。折中：CI Pipeline 自动更新 digest。
2. **立即销毁 vs 保留期**：立即销毁最安全，但不支持审计恢复。保留期增加存储成本但满足合规。
3. **共享 KMS vs 每员工独立 KMS**：共享 KMS 管理简单，但离职员工的 PVC 与其他员工使用相同密钥。如果需要严格的密钥隔离，使用每员工独立 KMS。

## 本章小结

1. **镜像供应链安全**：构建 → 扫描 → SBOM → 签名 → Digest 固定。
2. **员工生命周期自动化**：入职自动创建 Sandbox，调岗更新权限，离职渐进销毁。
3. **数据保留策略**：30 天保留期 + 归档长期存储 + 自动销毁。
4. **Pod 重建与持久化数据**：镜像更新不丢失 PVC 数据。
5. **安全事件响应**：分级响应、取证、修复和报告。
6. **KMS 密钥在生命周期中的角色**：共享密钥下，员工离职不影响其他员工；独立密钥下，离职员工密钥可立即禁用。

## 参考资料

- Cosign 镜像签名：https://docs.sigstore.dev/cosign/
- Syft SBOM 生成：https://github.com/anchore/syft
- Kubernetes 员工生命周期最佳实践：https://kubernetes.io/docs/concepts/security/
- AWS KMS 密钥策略：https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html
- 数据保留合规要求：根据所在地区的法律法规确定
