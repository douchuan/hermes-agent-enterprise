# 第 10 章：建立 Agent 全链路可观测性与审计

## 本章目标

能够解释一次 Agent 执行发生了什么、为什么发生，以及哪些策略参与了决策。

## 为什么传统应用日志不足以解释 Agent 行为

传统 Web 应用的日志通常包含：请求路径、响应状态、延迟、错误信息。这些足以排查大多数问题，因为 Web 应用的行为是确定性的——相同的请求通常得到相同的响应。

Agent 不同：

1. **非确定性**：相同的用户输入可能触发不同的模型回复、工具调用和后续行为。
2. **多阶段执行**：一次用户输入可能引发多次模型调用、多次工具调用和多次策略判定。
3. **策略参与**：Tool Gateway 授权、审批引擎、网络策略都可能改变执行路径。
4. **存储与密钥操作**：PVC 创建、挂载、快照、KMS 密钥操作也需要可审计。

因此，Agent 平台需要比传统应用更丰富的可观测性模型。

## 可观测性架构

### Trace、Metric 与 Log 的分工

| 类型 | 用途 | 示例 |
|------|------|------|
| Trace | 追踪一次请求的完整链路 | 用户输入 → 模型调用 → 工具调用 → 策略判定 → 结果 |
| Metric | 聚合指标和告警 | QPS、Token 用量、PVC 使用率、失败率 |
| Log | 详细事件记录 | 工具调用详情、策略拒绝原因、PVC 创建事件 |
| Audit Event | 安全审计记录 | 密钥策略变更、凭证轮换、员工权限变更 |

### 统一关联 ID

每个关联维度都需要一个 ID 来串联事件：

```
correlation_id: "req-abc-123"          ← 一次用户请求的唯一 ID
├── employee_id: "alice"
├── tenant_id: "acme-corp"
├── session_id: "sess-xyz-456"
├── model_call_id: "mc-001", "mc-002"
├── tool_call_id: "tc-001"
├── policy_decision_id: "pd-001"
└── approval_id: "apr-001"             ← 如果触发了审批
```

### Trace 示例：一次完整的 Agent 执行

```
Trace: req-abc-123
│
├─ Span: web-console.receive        [Web Console 收到用户输入]
│   └─ attributes: employee=alice, session_id=sess-xyz-456
│
├─ Span: control-plane.route        [Control Plane 路由到 Alice 的 Sandbox]
│   └─ attributes: sandbox_ns=hermes-agent-alice
│
├─ Span: agent.process              [Agent Sandbox 处理输入]
│   ├─ Span: agent.model_call       [调用模型服务]
│   │   └─ attributes: model=gpt-4, tokens=1200, cost=0.036
│   │
│   ├─ Span: agent.tool_call        [Agent 请求工具调用]
│   │   └─ attributes: tool=github, action=create_pr
│   │   │
│   │   └─ Span: tool-gateway.auth  [Tool Gateway 执行授权]
│   │       ├─ attributes: employee=alice, tool=github, action=create_pr
│   │       ├─ attributes: policy_result=ALLOW
│   │       └─ Span: vault.get-secret  [获取 GitHub 凭证]
│   │
│   └─ Span: agent.model_call       [Agent 根据工具结果生成回复]
│       └─ attributes: model=gpt-4, tokens=800, cost=0.024
│
└─ Span: control-plane.audit        [记录审计事件]
    └─ attributes: action=create_pr, status=success, employee=alice
```

### 存储层可观测性

除了 Agent 执行链路，还需要监控存储基础设施的健康状态：

```
├─ Span: control-plane.create-pvc   [Control Plane 为员工创建加密 PVC]
│   ├─ attributes: employee=alice, namespace=hermes-agent-alice
│   ├─ attributes: storage_class=encrypted-ssd, size=20Gi
│   └─ attributes: encrypted=true, kms_key=alias/hermes-agent-ebs
│
├─ Metric: pvc_utilization        [PVC 存储使用率]
│   └─ per-employee, 告警阈值: > 80%
│
├─ Metric: pvc_encryption_status  [PVC 加密状态]
│   └─ 所有 PVC 应显示 "encrypted=true"
│
├─ Span: csi.create-snapshot      [创建 PVC 快照]
│   ├─ attributes: pvc=agent-data, snapshot=agent-data-snapshot
│   └─ attributes: encrypted=true
│
├─ Metric: kms_api_latency        [KMS API 延迟]
│   └─ 延迟升高可能影响存储挂载速度
│
└─ Audit: kms_key_policy_change   [KMS 密钥策略变更]
    └─ 记录谁在什么时候修改了密钥策略
```

## 实现步骤

### OpenTelemetry 配置

```typescript
// examples/10/otel-config.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: "hermes-control-plane",
    [SemanticResourceAttributes.SERVICE_VERSION]: "1.0.0",
    environment: "production",
  }),
  traceExporter: new OTLPTraceExporter({
    url: "http://otel-collector.hermez-systems.svc:4318/v1/traces",
  }),
  metricExporter: new OTLPMetricExporter({
    url: "http://otel-collector.hermez-systems.svc:4318/v1/metrics",
  }),
});

sdk.start();
```

### Tool Gateway 中的 Trace 传播

```typescript
// examples/10/tool-gateway-tracing.ts
import { trace, SpanStatusCode } from "@opentelemetry/api";

async function handleToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
  const tracer = trace.getTracer("tool-gateway");

  return tracer.startActiveSpan("tool-gateway.execute", async (span) => {
    span.setAttribute("employee_id", request.employeeId);
    span.setAttribute("tool_name", request.toolName);
    span.setAttribute("action", request.action);

    try {
      // 1. 验证调用方身份
      await verifyCaller(request);
      span.addEvent("caller_verified");

      // 2. 执行授权检查
      const authResult = await checkAuthorization(request);
      span.setAttribute("auth_result", authResult);

      if (authResult === "DENY") {
        span.setAttribute("deny_reason", getDenyReason(request));
        throw new AuthorizationDeniedError("Access denied");
      }

      // 3. 检查是否需要审批
      if (requiresApproval(request)) {
        const approval = await requestApproval(request);
        span.addEvent("approval_requested", { approvalId: approval.id });
        if (!approval.approved) {
          throw new ApprovalRequiredError("Approval pending");
        }
      }

      // 4. 获取凭证（不记录凭证值）
      const credentials = await getCredentials(request.toolName);
      span.addEvent("credentials_obtained"); // 不记录凭证内容

      // 5. 执行实际操作
      const result = await execute(request, credentials);
      span.setAttribute("operation_status", result.status);

      // 6. 记录审计事件
      await logAuditEvent({
        correlationId: request.correlationId,
        employeeId: request.employeeId,
        tool: request.toolName,
        action: request.action,
        status: result.status,
      });

      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

### 敏感数据脱敏

```typescript
// examples/10/otel-sanitization.ts
const SENSITIVE_PATTERNS = [
  /token["\s:=]+\S+/gi,
  /password["\s:=]+\S+/gi,
  /secret["\s:=]+\S+/gi,
  /key["\s:=]+\S+/gi,
  /Authorization["\s:=]+\S+/gi,
  /AWS_ACCESS_KEY_ID["\s:=]+\S+/gi,
  /AWS_SECRET_ACCESS_KEY["\s:=]+\S+/gi,
];

function sanitizeForLogging(data: unknown): unknown {
  const json = JSON.stringify(data);
  let sanitized = json;

  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      const keyPart = match.split(/["\s:=]+/)[0];
      return `${keyPart}="[REDACTED]"`;
    });
  }

  return JSON.parse(sanitized);
}

// 使用示例
span.setAttribute("github.response", sanitizeForLogging(response));
// 输出: {"status":200,"headers":{"Authorization":"[REDACTED]"},"data":{...}}
```

### 存储层审计事件

```typescript
// examples/10/storage-audit-events.ts
interface StorageAuditEvent {
  eventType:
    | "PVC_CREATED"
    | "PVC_DELETED"
    | "SNAPSHOT_CREATED"
    | "SNAPSHOT_DELETED"
    | "SNAPSHOT_RESTORED"
    | "KMS_KEY_POLICY_CHANGED"
    | "KMS_KEY_DISABLED"
    | "KMS_KEY_DELETED"
    | "CREDENTIAL_ROTATED"
    | "CREDENTIAL_REVOKED"
    | "EMPLOYEE_OFFBOARDED";
  employeeId?: string;
  namespace?: string;
  pvcName?: string;
  snapshotName?: string;
  kmsKeyId?: string;
  initiatedBy: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

async function emitStorageAuditEvent(event: StorageAuditEvent): Promise<void> {
  // 写入独立的审计存储（如 S3、独立的数据库表）
  // 不写入普通日志系统
  await auditStore.write(event);
}

// 使用示例：PVC 创建
await emitStorageAuditEvent({
  eventType: "PVC_CREATED",
  employeeId: "alice",
  namespace: "hermes-agent-alice",
  pvcName: "agent-data",
  initiatedBy: "control-plane",
  timestamp: new Date().toISOString(),
  details: {
    storageClass: "encrypted-ssd",
    encrypted: true,
    kmsKeyId: "alias/hermes-agent-ebs",
    size: "20Gi",
  },
});
```

## 运营指标

### 基础指标

| 指标 | 类型 | 告警条件 |
|------|------|----------|
| Agent 请求延迟（P50/P95/P99） | Metric | P99 > 30s |
| 模型调用失败率 | Metric | > 5% in 5min |
| Token 用量/成本 | Metric | 日成本 > 预算阈值 |
| PVC 存储使用率 | Metric | > 80% |
| Tool Gateway 授权拒绝率 | Metric | 突然升高 |
| 审批通过率/拒绝率 | Metric | 异常波动 |
| KMS API 延迟 | Metric | > 1s |
| 凭证轮换成功率 | Metric | < 99% |

### PVC 存储使用率监控

```yaml
# examples/10/pvc-alerting.yaml
# Prometheus 告警规则
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hermes-storage-alerts
  namespace: hermez-systems
spec:
  groups:
    - name: hermes.pvc
      rules:
        - alert: PVCUsageHigh
          expr: |
            kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes > 0.8
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "PVC 使用率超过 80%"
            description: "Namespace {{ $labels.namespace }} 的 PVC {{ $labels.persistentvolumeclaim }} 使用率 {{ $value | humanizePercentage }}"

        - alert: PVCEncryptionNotEnabled
          expr: |
            hermes_pvc_encryption_status{encrypted="false"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "发现未加密的 PVC"
            description: "Namespace {{ $labels.namespace }} 的 PVC {{ $labels.persistentvolumeclaim }} 未启用加密"

        - alert: SnapshotCreationFailed
          expr: |
            increase(hermes_snapshot_creation_failures_total[1h]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PVC 快照创建失败"
            description: "过去 1 小时内有 {{ $value }} 次快照创建失败"
```

## 排查示例：Agent 为什么调用某个工具

场景：员工投诉 Agent 执行了不应该执行的 GitHub PR 合并操作。

排查步骤：

```bash
# 1. 通过员工 ID 和日期范围搜索 Trace
curl -s "http://jaeger.hermez-systems.svc:16686/api/traces?service=hermes-agent&tags=employee_id=alice&start=1698000000000000&end=1698100000000000"

# 2. 找到目标 Trace，查看工具调用的 Span
# 3. 检查 Tool Gateway 的授权 Span：
#    - 授权结果是什么？（ALLOW / DENY / APPROVAL_REQUIRED）
#    - 使用了哪条策略？
#    - 审批记录是否存在？
# 4. 检查审计事件：
curl -s "http://audit-service.hermez-systems.svc:8080/events?employee=alice&tool=github&date=2024-01-15"
```

如果授权结果显示 ALLOW，说明策略配置允许该操作——需要检查策略定义。
如果授权结果显示 APPROVAL_REQUIRED 但操作被执行了，说明审批流程被绕过——这是安全事件。

## 安全边界、取舍与剩余风险

### 本章方案能防范什么

| 威胁 | 防范机制 |
|------|----------|
| 无法追踪 Agent 行为 | 全链路 Trace |
| 无法知道策略决策原因 | 策略判定记录为 Span 属性 |
| 无法知道谁修改了 KMS 密钥 | 独立审计事件 |
| 无法知道 PVC 是否加密 | PVC 加密状态 Metric |

### 本章方案不能防范什么

| 威胁 | 需要补充的措施 |
|------|----------------|
| 审计日志被篡改或删除 | 审计日志的 WORM 存储、访问控制 |
| 模型输出的不当内容 | Prompt 安全治理（第 11 章） |
| Agent 执行了合法但有害的操作 | 审批策略、操作幂等性 |

## 本章小结

1. **Agent 需要比传统应用更丰富的可观测性**：非确定性执行、多阶段操作、策略参与。
2. **Trace + Metric + Log + Audit Event** 四类数据各司其职。
3. **统一关联 ID** 串联一次请求中的所有事件。
4. **敏感数据脱敏**是必须的——日志和 Trace 中不出现明文凭证或 Memory 内容。
5. **存储层可观测性**：PVC 使用率、加密状态、快照状态、KMS 延迟都需要监控和告警。
6. **审计事件独立存储**：不写入普通日志系统，确保完整性和可追溯性。

## 参考资料

- OpenTelemetry 官方文档：https://opentelemetry.io/docs/
- OpenTelemetry Semantic Conventions：https://opentelemetry.io/docs/reference/specification/trace/semantic_conventions/
- Jaeger 分布式追踪：https://www.jaegertracing.io/docs/
- Prometheus 告警规则：https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/
- kube-state-metrics：https://github.com/kubernetes/kube-state-metrics
