// Tool Gateway — Core Gateway
//
// 完整的工具调用处理链路：
// 1. 验证调用方身份（通过 mTLS / 内部 Token，此处简化为函数参数）
// 2. 授权检查（多维度）
// 3. 幂等性检查（防止重试导致重复操作）
// 4. 审批处理（高风险操作）
// 5. 凭证获取（通过 Credential Broker）
// 6. 执行操作（通过 Tool Adapter）
// 7. 记录审计事件
//
// 这是参考实现/待实现设计，尚未在真实第三方服务上验证。

import type { CallerIdentity, ToolCallRequest, AuthorizationDecision, ExternalAuthConnection } from "./authorization.js";
import { checkAuthorization, hashParameters } from "./authorization.js";
import type { AuditEvent } from "./audit.js";
import { InMemoryAuditStore } from "./audit.js";
import type { IdempotencyStore, IdempotencyResult } from "./idempotency.js";
import { InMemoryIdempotencyStore } from "./idempotency.js";

// 审批请求
export interface ApprovalRequest {
  id: string;
  correlationId: string;
  employeeId: string;
  agentId: string;
  tenantId: string;
  toolName: string;
  action: string;
  resource?: string;
  parameters: Record<string, unknown>;
  parametersHash: string;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
}

// 审批存储
export interface ApprovalStore {
  create(request: Omit<ApprovalRequest, "id" | "status">): Promise<ApprovalRequest>;
  get(id: string): Promise<ApprovalRequest | null>;
  respond(id: string, approved: boolean, responderId: string): Promise<ApprovalRequest>;
}

// 内存审批存储（测试用）
export class InMemoryApprovalStore implements ApprovalStore {
  private store = new Map<string, ApprovalRequest>();
  private counter = 0;

  async create(request: Omit<ApprovalRequest, "id" | "status">): Promise<ApprovalRequest> {
    this.counter++;
    const approval: ApprovalRequest = {
      ...request,
      id: `apr-${this.counter}`,
      status: "pending",
    };
    this.store.set(approval.id, approval);
    return approval;
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    return this.store.get(id) ?? null;
  }

  async respond(id: string, approved: boolean, responderId: string): Promise<ApprovalRequest> {
    const approval = this.store.get(id);
    if (!approval) throw new Error(`Approval request ${id} not found`);

    approval.status = approved ? "approved" : "denied";
    approval.respondedBy = responderId;
    approval.respondedAt = new Date().toISOString();
    this.store.set(id, approval);
    return approval;
  }
}

// 工具执行结果
export interface ToolCallResult {
  status: "success" | "denied" | "approval_pending" | "error";
  result?: unknown;
  reason?: string;
  approvalId?: string;
}

// 模拟的 Credential Broker
export interface CredentialBroker {
  getCredentials(employeeId: string, toolName: string, connectionId: string): Promise<unknown>;
}

// 模拟的 Tool Adapter
export interface ToolAdapter {
  execute(toolName: string, action: string, parameters: Record<string, unknown>, credentials: unknown): Promise<unknown>;
}

// Gateway 主类
export class ToolGateway {
  private auditStore: InMemoryAuditStore;
  private idempotencyStore: InMemoryIdempotencyStore;
  private approvalStore: InMemoryApprovalStore;
  private credentialBroker: CredentialBroker;
  private toolAdapter: ToolAdapter;
  private getConnection: (employeeId: string, toolName: string) => Promise<ExternalAuthConnection | null>;
  private evaluatePolicy: (caller: CallerIdentity, request: ToolCallRequest) => Promise<"ALLOW" | "DENY" | "REQUIRE_APPROVAL">;

  constructor(
    auditStore: InMemoryAuditStore,
    idempotencyStore: InMemoryIdempotencyStore,
    approvalStore: InMemoryApprovalStore,
    credentialBroker: CredentialBroker,
    toolAdapter: ToolAdapter,
    getConnection: (employeeId: string, toolName: string) => Promise<ExternalAuthConnection | null>,
    evaluatePolicy: (caller: CallerIdentity, request: ToolCallRequest) => Promise<"ALLOW" | "DENY" | "REQUIRE_APPROVAL">,
  ) {
    this.auditStore = auditStore;
    this.idempotencyStore = idempotencyStore;
    this.approvalStore = approvalStore;
    this.credentialBroker = credentialBroker;
    this.toolAdapter = toolAdapter;
    this.getConnection = getConnection;
    this.evaluatePolicy = evaluatePolicy;
  }

  /**
   * 处理工具调用
   *
   * 这是 Gateway 的核心入口。
   * 调用方身份（caller）通过 mTLS / Workload Identity 独立验证，
   * 不信任 ToolCallRequest 中的任何身份参数。
   */
  async handleToolCall(
    caller: CallerIdentity,
    request: ToolCallRequest,
    correlationId: string,
  ): Promise<ToolCallResult> {
    // 步骤 1：记录收到请求
    await this.auditStore.write({
      eventType: "TOOL_CALL_RECEIVED",
      correlationId,
      employeeId: caller.employeeId,
      agentId: caller.agentId,
      tenantId: caller.tenantId,
      toolName: request.toolName,
      action: request.action,
      resource: request.resource,
      parameterKeys: Object.keys(request.parameters),
      initiatedBy: caller.agentId,
      timestamp: new Date().toISOString(),
    });

    // 步骤 2：授权检查
    const authDecision: AuthorizationDecision = await checkAuthorization(
      caller,
      request,
      this.getConnection,
      this.evaluatePolicy,
    );

    await this.auditStore.write({
      eventType: "AUTHORIZATION_CHECKED",
      correlationId,
      employeeId: caller.employeeId,
      agentId: caller.agentId,
      tenantId: caller.tenantId,
      toolName: request.toolName,
      action: request.action,
      resource: request.resource,
      authorizationDecision: authDecision.result,
      authorizationReason: authDecision.reason,
      externalAuthConnectionId: authDecision.connectionId,
      initiatedBy: caller.agentId,
      timestamp: new Date().toISOString(),
    });

    // 拒绝 → 直接返回
    if (authDecision.result === "DENY") {
      await this.auditStore.write({
        eventType: "TOOL_CALL_DENIED",
        correlationId,
        employeeId: caller.employeeId,
        agentId: caller.agentId,
        tenantId: caller.tenantId,
        toolName: request.toolName,
        action: request.action,
        authorizationReason: authDecision.reason,
        initiatedBy: caller.agentId,
        timestamp: new Date().toISOString(),
      });

      return { status: "denied", reason: authDecision.reason };
    }

    // 需要审批 → 创建审批请求
    if (authDecision.result === "REQUIRE_APPROVAL") {
      const paramsHash = await hashParameters(request.parameters);
      const approval = await this.approvalStore.create({
        correlationId,
        employeeId: caller.employeeId,
        agentId: caller.agentId,
        tenantId: caller.tenantId,
        toolName: request.toolName,
        action: request.action,
        resource: request.resource,
        parameters: request.parameters,
        parametersHash: paramsHash,
        approverId: "manager-placeholder",  // 生产环境由 Control Plane 决定
        approverRole: "department_manager",
      });

      await this.auditStore.write({
        eventType: "APPROVAL_REQUESTED",
        correlationId,
        employeeId: caller.employeeId,
        agentId: caller.agentId,
        tenantId: caller.tenantId,
        toolName: request.toolName,
        action: request.action,
        approvalId: approval.id,
        initiatedBy: caller.agentId,
        timestamp: new Date().toISOString(),
      });

      return { status: "approval_pending", reason: authDecision.reason, approvalId: approval.id };
    }

    // 步骤 3：幂等性检查
    const idempotencyKey = `${caller.employeeId}:${request.toolName}:${request.action}:${JSON.stringify(request.parameters)}`;
    const cachedResult = await this.idempotencyStore.get(idempotencyKey);
    if (cachedResult) {
      // 返回缓存结果，不重新执行操作
      return {
        status: cachedResult.status,
        result: cachedResult.result,
        reason: cachedResult.status === "denied" ? "Cached denial" : undefined,
      };
    }

    // 步骤 4：获取凭证
    if (authDecision.connectionId) {
      const credentials = await this.credentialBroker.getCredentials(
        caller.employeeId,
        request.toolName,
        authDecision.connectionId,
      );

      await this.auditStore.write({
        eventType: "CREDENTIAL_ACQUIRED",
        correlationId,
        employeeId: caller.employeeId,
        agentId: caller.agentId,
        tenantId: caller.tenantId,
        toolName: request.toolName,
        action: request.action,
        externalAuthConnectionId: authDecision.connectionId,
        credentialSource: "oauth_delegated",
        initiatedBy: caller.agentId,
        timestamp: new Date().toISOString(),
      });

      // 步骤 5：执行操作
      try {
        const result = await this.toolAdapter.execute(
          request.toolName,
          request.action,
          request.parameters,
          credentials,
        );

        // 缓存幂等性结果
        const idempotencyResult: IdempotencyResult = {
          status: "success",
          result,
          createdAt: new Date().toISOString(),
        };
        await this.idempotencyStore.set(idempotencyKey, idempotencyResult);

        // 步骤 6：记录审计
        await this.auditStore.write({
          eventType: "TOOL_CALL_EXECUTED",
          correlationId,
          employeeId: caller.employeeId,
          agentId: caller.agentId,
          tenantId: caller.tenantId,
          toolName: request.toolName,
          action: request.action,
          resource: request.resource,
          parameterKeys: Object.keys(request.parameters),
          authorizationDecision: "ALLOW",
          externalAuthConnectionId: authDecision.connectionId,
          operationStatus: "success",
          credentialSource: "oauth_delegated",
          adapterName: `${request.toolName}-adapter`,
          initiatedBy: caller.agentId,
          timestamp: new Date().toISOString(),
        });

        return { status: "success", result };
      } catch (error) {
        const idempotencyResult: IdempotencyResult = {
          status: "failed",
          createdAt: new Date().toISOString(),
        };
        await this.idempotencyStore.set(idempotencyKey, idempotencyResult);

        return {
          status: "error",
          reason: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }

    return { status: "error", reason: "No connection ID from authorization" };
  }

  /**
   * 处理审批响应
   *
   * 审批人批准后，验证参数哈希是否匹配，然后执行操作。
   */
  async handleApprovalResponse(
    approvalId: string,
    approved: boolean,
    responderId: string,
  ): Promise<ToolCallResult> {
    const approval = await this.approvalStore.get(approvalId);
    if (!approval) {
      return { status: "error", reason: `Approval request ${approvalId} not found` };
    }

    const response = await this.approvalStore.respond(approvalId, approved, responderId);

    await this.auditStore.write({
      eventType: "APPROVAL_RESPONDED",
      correlationId: approval.correlationId,
      employeeId: approval.employeeId,
      agentId: approval.agentId,
      tenantId: approval.tenantId,
      toolName: approval.toolName,
      action: approval.action,
      approvalId: approval.id,
      operationStatus: approved ? "success" : "denied",
      initiatedBy: responderId,
      timestamp: new Date().toISOString(),
    });

    if (!approved) {
      return { status: "denied", reason: "Approval denied", approvalId };
    }

    // 审批通过 → 验证参数哈希并执行
    const currentHash = await hashParameters(approval.parameters);
    if (currentHash !== approval.parametersHash) {
      await this.auditStore.write({
        eventType: "PARAMETER_HASH_MISMATCH",
        correlationId: approval.correlationId,
        employeeId: approval.employeeId,
        agentId: approval.agentId,
        tenantId: approval.tenantId,
        toolName: approval.toolName,
        action: approval.action,
        approvalId: approval.id,
        errorReason: "Parameters changed after approval",
        initiatedBy: responderId,
        timestamp: new Date().toISOString(),
      });

      return {
        status: "denied",
        reason: "Parameters were modified after approval. Please resubmit for approval.",
        approvalId,
      };
    }

    // 参数匹配 → 执行操作
    const credentials = await this.credentialBroker.getCredentials(
      approval.employeeId,
      approval.toolName,
      "approval-connection",
    );

    try {
      const result = await this.toolAdapter.execute(
        approval.toolName,
        approval.action,
        approval.parameters,
        credentials,
      );

      await this.auditStore.write({
        eventType: "TOOL_CALL_EXECUTED",
        correlationId: approval.correlationId,
        employeeId: approval.employeeId,
        agentId: approval.agentId,
        tenantId: approval.tenantId,
        toolName: approval.toolName,
        action: approval.action,
        approvalId: approval.id,
        operationStatus: "success",
        initiatedBy: responderId,
        timestamp: new Date().toISOString(),
      });

      return { status: "success", result, approvalId };
    } catch (error) {
      return {
        status: "error",
        reason: error instanceof Error ? error.message : "Execution failed",
        approvalId,
      };
    }
  }
}
