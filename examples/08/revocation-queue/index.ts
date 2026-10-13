// 第三方授权撤销重试队列 — Tool Gateway 内置模块
//
// 架构决策：
// - 平台侧先阻断（撤销连接后 Tool Gateway 立刻拒绝调用）
// - 第三方撤销是异步后续动作，不阻塞员工转岗/离职流程
// - 采用持久化队列（模拟 PostgreSQL-backed），进程重启不丢失
// - 指数退避 + 随机抖动，区分错误类型
// - 429: 遵守 Retry-After 头（如有）
// - 5xx/超时: 继续重试
// - 401/403: 可能已撤销，停止重试，标记成功
// - 不可恢复错误: 转人工
// - 最大尝试 10 次 或 24 小时截止时间
// - 队列积压时触发告警
//
// 这些是参考参数，需要根据供应商 API 调整。

import {
  type RevocationTask,
  type RevocationConfig,
  type RevocationAuditEvent,
  type RevocationStatus,
  type ErrorType,
  DEFAULT_REVOCATION_CONFIG,
  calculateNextRetry,
  classifyHttpError,
  shouldRetry,
} from "./types.js";

// ── 持久化存储接口 ──

export interface RevocationStore {
  save(task: RevocationTask): Promise<void>;
  load(id: string): Promise<RevocationTask | undefined>;
  listDue(now?: Date): Promise<RevocationTask[]>;
  listByStatus(status: RevocationStatus): Promise<RevocationTask[]>;
  countByStatus(status: RevocationStatus): Promise<number>;
}

// 内存存储（用于测试，生产环境替换为 PostgreSQL-backed）
export class InMemoryRevocationStore implements RevocationStore {
  private tasks = new Map<string, RevocationTask>();

  async save(task: RevocationTask): Promise<void> {
    this.tasks.set(task.id, { ...task });
  }

  async load(id: string): Promise<RevocationTask | undefined> {
    return this.tasks.get(id);
  }

  async listDue(now = new Date()): Promise<RevocationTask[]> {
    const nowMs = now.getTime();
    return Array.from(this.tasks.values()).filter(task => {
      if (task.status !== "pending" && task.status !== "retrying") return false;
      return new Date(task.nextRetryAt).getTime() <= nowMs;
    });
  }

  async listByStatus(status: RevocationStatus): Promise<RevocationTask[]> {
    return Array.from(this.tasks.values()).filter(t => t.status === status);
  }

  async countByStatus(status: RevocationStatus): Promise<number> {
    return Array.from(this.tasks.values()).filter(t => t.status === status).length;
  }

  // 测试辅助：清空所有数据
  clear(): void {
    this.tasks.clear();
  }

  // 测试辅助：模拟重启（返回数据快照，再创建新实例模拟恢复）
  snapshot(): RevocationTask[] {
    return Array.from(this.tasks.values()).map(t => ({ ...t }));
  }
}

// ── HTTP 撤销客户端接口 ──

export interface RevokeClient {
  revoke(
    endpoint: string,
    accessToken: string,
    connectionId: string
  ): Promise<{ success: boolean; httpStatus: number; body?: string; retryAfterMs?: number }>;
}

// 模拟客户端（用于测试）
export class MockRevokeClient implements RevokeClient {
  private behavior: "success" | "rate_limited" | "server_error" | "timeout" | "auth_error" | "not_found" | "irrecoverable" = "success";
  private retryAfterMs?: number;

  setBehavior(behavior: typeof this.behavior, retryAfterMs?: number) {
    this.behavior = behavior;
    this.retryAfterMs = retryAfterMs;
  }

  async revoke(
    _endpoint: string,
    _accessToken: string,
    _connectionId: string
  ): Promise<{ success: boolean; httpStatus: number; body?: string; retryAfterMs?: number }> {
    switch (this.behavior) {
      case "success":
        return { success: true, httpStatus: 200 };
      case "rate_limited":
        return { success: false, httpStatus: 429, body: "rate_limited", retryAfterMs: this.retryAfterMs || 10_000 };
      case "server_error":
        return { success: false, httpStatus: 503, body: "service_unavailable" };
      case "timeout":
        throw new Error("Request timeout");
      case "auth_error":
        return { success: false, httpStatus: 401, body: "invalid_token" };
      case "not_found":
        return { success: false, httpStatus: 404, body: "token_not_found" };
      case "irrecoverable":
        return { success: false, httpStatus: 422, body: "invalid_request_format" };
      default:
        return { success: false, httpStatus: 500, body: "unknown" };
    }
  }
}

// ── 告警接口 ──

export interface AlertChannel {
  alert(message: string, metadata: Record<string, unknown>): Promise<void>;
}

export class ConsoleAlertChannel implements AlertChannel {
  async alert(message: string, metadata: Record<string, unknown>): Promise<void> {
    console.warn(`[REVOCATION-ALERT] ${message}`, JSON.stringify(metadata));
  }
}

// ── 撤销队列 ──

export class RevocationQueue {
  private store: RevocationStore;
  private revokeClient: RevokeClient;
  private alertChannel: AlertChannel;
  private config: RevocationConfig;
  private auditCallback: (event: RevocationAuditEvent) => Promise<void>;
  private running = false;

  constructor(
    store: RevocationStore,
    revokeClient: RevokeClient,
    alertChannel: AlertChannel,
    auditCallback: (event: RevocationAuditEvent) => Promise<void>,
    config: RevocationConfig = DEFAULT_REVOCATION_CONFIG
  ) {
    this.store = store;
    this.revokeClient = revokeClient;
    this.alertChannel = alertChannel;
    this.auditCallback = auditCallback;
    this.config = config;
  }

  // 创建新任务（员工转岗/离职时调用）
  async enqueue(task: Omit<RevocationTask, "createdAt" | "nextRetryAt" | "retryCount" | "status" | "maxRetries" | "initialBackoffMs" | "maxBackoffMs" | "deadlineAt">): Promise<RevocationTask> {
    const now = new Date();
    const deadline = new Date(now.getTime() + this.config.deadlineHours * 60 * 60 * 1000);

    const fullTask: RevocationTask = {
      ...task,
      createdAt: now.toISOString(),
      nextRetryAt: now.toISOString(),  // 立即可以重试
      retryCount: 0,
      status: "pending",
      maxRetries: this.config.maxRetries,
      initialBackoffMs: this.config.initialBackoffMs,
      maxBackoffMs: this.config.maxBackoffMs,
      deadlineAt: deadline.toISOString(),
    };

    await this.store.save(fullTask);

    await this.auditCallback({
      eventType: "REVOCATION_ATTEMPT",
      taskId: fullTask.id,
      employeeId: fullTask.employeeId,
      agentId: fullTask.agentId,
      tenantId: fullTask.tenantId,
      provider: fullTask.provider,
      connectionId: fullTask.connectionId,
      retryCount: 0,
      status: "pending",
      timestamp: now.toISOString(),
    });

    return fullTask;
  }

  // 处理单个任务
  private async processTask(task: RevocationTask, now: Date): Promise<void> {

    // 检查是否应该重试
    const { retry, reason } = shouldRetry(task, now);

    if (!retry) {
      // Terminal status 处理
      if (task.status === "pending" || task.status === "retrying") {
        if (task.lastErrorType === "not_found") {
          // Token 已不存在，视为成功
          task.status = "succeeded";
          task.lastError = "Token already revoked or not found";
          await this.store.save(task);
          await this.auditCallback({
            eventType: "REVOCATION_SUCCEEDED",
            taskId: task.id,
            employeeId: task.employeeId,
            agentId: task.agentId,
            tenantId: task.tenantId,
            provider: task.provider,
            connectionId: task.connectionId,
            retryCount: task.retryCount,
            status: "succeeded",
            timestamp: now.toISOString(),
          });
          return;
        }

        if (task.lastErrorType === "irrecoverable") {
          // 不可恢复 → 转人工
          task.status = "manual_review";
          await this.store.save(task);
          await this.auditCallback({
            eventType: "REVOCATION_MANUAL_REVIEW",
            taskId: task.id,
            employeeId: task.employeeId,
            agentId: task.agentId,
            tenantId: task.tenantId,
            provider: task.provider,
            connectionId: task.connectionId,
            retryCount: task.retryCount,
            status: "manual_review",
            errorType: "irrecoverable",
            errorMessage: task.lastError,
            timestamp: now.toISOString(),
          });
          await this.alertChannel.alert(
            `Revocation requires manual review: ${task.id}`,
            { taskId: task.id, employeeId: task.employeeId, provider: task.provider }
          );
          return;
        }

        // 达到最大次数或截止时间 → 失败
        if (task.retryCount >= task.maxRetries || now >= new Date(task.deadlineAt)) {
          task.status = "failed";
          await this.store.save(task);
          await this.auditCallback({
            eventType: "REVOCATION_FAILED",
            taskId: task.id,
            employeeId: task.employeeId,
            agentId: task.agentId,
            tenantId: task.tenantId,
            provider: task.provider,
            connectionId: task.connectionId,
            retryCount: task.retryCount,
            status: "failed",
            errorType: task.lastErrorType,
            httpStatus: task.lastHttpStatus,
            errorMessage: task.lastError,
            timestamp: now.toISOString(),
          });
          await this.alertChannel.alert(
            `Revocation failed after ${task.retryCount} attempts: ${task.id}`,
            { taskId: task.id, employeeId: task.employeeId, provider: task.provider }
          );
          return;
        }
      }

      return;  // 不需要处理
    }

    // 执行撤销
    task.status = "retrying";
    task.retryCount++;

    try {
      const result = await this.revokeClient.revoke(
        task.revokeEndpoint,
        task.accessToken || "",
        task.connectionId
      );

      if (result.success) {
        // 成功
        task.status = "succeeded";
        await this.store.save(task);
        await this.auditCallback({
          eventType: "REVOCATION_SUCCEEDED",
          taskId: task.id,
          employeeId: task.employeeId,
          agentId: task.agentId,
          tenantId: task.tenantId,
          provider: task.provider,
          connectionId: task.connectionId,
          retryCount: task.retryCount,
          status: "succeeded",
          timestamp: now.toISOString(),
        });
      } else {
        // HTTP 错误
        const errorType = classifyHttpError(result.httpStatus, result.body);
        task.lastError = result.body;
        task.lastErrorType = errorType;
        task.lastHttpStatus = result.httpStatus;

        if (errorType === "not_found") {
          // Token 已不存在，视为成功
          task.status = "succeeded";
          task.lastError = "Token already revoked or not found";
          await this.store.save(task);
          await this.auditCallback({
            eventType: "REVOCATION_SUCCEEDED",
            taskId: task.id,
            employeeId: task.employeeId,
            agentId: task.agentId,
            tenantId: task.tenantId,
            provider: task.provider,
            connectionId: task.connectionId,
            retryCount: task.retryCount,
            status: "succeeded",
            timestamp: now.toISOString(),
          });
        } else if (errorType === "auth_error") {
          // 401/403 → 可能已撤销
          task.status = "succeeded";
          task.lastError = `Auth error (${result.httpStatus}) — assuming already revoked`;
          await this.store.save(task);
          await this.auditCallback({
            eventType: "REVOCATION_SUCCEEDED",
            taskId: task.id,
            employeeId: task.employeeId,
            agentId: task.agentId,
            tenantId: task.tenantId,
            provider: task.provider,
            connectionId: task.connectionId,
            retryCount: task.retryCount,
            status: "succeeded",
            timestamp: now.toISOString(),
          });
        } else {
          // 继续重试，计算下一次时间
          const nextRetry = calculateNextRetry(task.retryCount, this.config, result.retryAfterMs);
          task.nextRetryAt = nextRetry.toISOString();
          task.status = "retrying";

          await this.store.save(task);
          await this.auditCallback({
            eventType: "REVOCATION_ATTEMPT",
            taskId: task.id,
            employeeId: task.employeeId,
            agentId: task.agentId,
            tenantId: task.tenantId,
            provider: task.provider,
            connectionId: task.connectionId,
            retryCount: task.retryCount,
            status: task.status,
            errorType: task.lastErrorType,
            httpStatus: task.lastHttpStatus,
            errorMessage: task.lastError,
            timestamp: now.toISOString(),
          });
        }
      }
    } catch (error) {
      // 网络超时或其他异常
      const isTimeout = error instanceof Error && error.message.toLowerCase().includes("timeout");
      const errorType: ErrorType = isTimeout ? "timeout" : "server_error";

      task.lastError = error instanceof Error ? error.message : String(error);
      task.lastErrorType = errorType;

      const nextRetry = calculateNextRetry(task.retryCount, this.config);
      task.nextRetryAt = nextRetry.toISOString();
      task.status = "retrying";

      await this.store.save(task);
      await this.auditCallback({
        eventType: "REVOCATION_ATTEMPT",
        taskId: task.id,
        employeeId: task.employeeId,
        agentId: task.agentId,
        tenantId: task.tenantId,
        provider: task.provider,
        connectionId: task.connectionId,
        retryCount: task.retryCount,
        status: "retrying",
        errorType,
        errorMessage: task.lastError,
        timestamp: now.toISOString(),
      });
    }
  }

  // 处理所有到期任务
  async processDueTasks(now = new Date()): Promise<void> {
    const dueTasks = await this.store.listDue(now);

    // 并发安全：逐个处理，避免并发撤销同一个任务
    for (const task of dueTasks) {
      await this.processTask(task, now);
    }
  }

  // 启动后台循环（模拟）
  start(intervalMs = 30_000): void {
    if (this.running) return;
    this.running = true;

    const loop = async () => {
      while (this.running) {
        try {
          await this.processDueTasks();
          // 检查积压
          const pendingCount = await this.store.countByStatus("pending");
          const retryingCount = await this.store.countByStatus("retrying");
          if (pendingCount + retryingCount > 10) {
            await this.alertChannel.alert(
              `Revocation queue backlog: ${pendingCount + retryingCount} tasks`,
              { pending: pendingCount, retrying: retryingCount }
            );
          }
        } catch (error) {
          console.error("[revocation-queue] Loop error:", error);
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
    };

    loop();
  }

  stop(): void {
    this.running = false;
  }

  // 获取队列统计
  async getStats(): Promise<Record<string, number>> {
    return {
      pending: await this.store.countByStatus("pending"),
      retrying: await this.store.countByStatus("retrying"),
      succeeded: await this.store.countByStatus("succeeded"),
      failed: await this.store.countByStatus("failed"),
      manual_review: await this.store.countByStatus("manual_review"),
    };
  }
}
