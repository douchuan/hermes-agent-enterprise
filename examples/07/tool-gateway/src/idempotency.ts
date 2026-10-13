// Tool Gateway — Idempotency Handler
//
// 防止 Agent 重试导致重复操作（如重复创建采购申请、重复预订会议室）。
//
// 工作原理：
// 1. 客户端（Agent 或 Adapter）在请求中提供 idempotency_key
// 2. Gateway 检查该 key 是否已有处理结果
// 3. 如果有，直接返回缓存的结果（不重新执行操作）
// 4. 如果没有，执行操作并缓存结果

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyResult | null>;
  set(key: string, result: IdempotencyResult): Promise<void>;
}

export interface IdempotencyResult {
  status: "success" | "failed" | "denied";
  result?: unknown;
  createdAt: string;
}

// 内存存储（测试用，生产环境需要持久化存储如 Redis）
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, IdempotencyResult>();
  private readonly ttlMs: number;

  constructor(ttlMs = 3_600_000) { // 默认 1 小时 TTL
    this.ttlMs = ttlMs;
  }

  async get(key: string): Promise<IdempotencyResult | null> {
    const result = this.store.get(key);
    if (!result) return null;

    // 检查是否过期
    const age = Date.now() - new Date(result.createdAt).getTime();
    if (age > this.ttlMs) {
      this.store.delete(key);
      return null;
    }

    return result;
  }

  async set(key: string, result: IdempotencyResult): Promise<void> {
    this.store.set(key, result);
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * 生成幂等性 key
 *
 * 由员工 ID、工具名、操作和关键参数组合而成，确保相同请求生成相同 key。
 */
export function generateIdempotencyKey(
  employeeId: string,
  toolName: string,
  action: string,
  parameters: Record<string, unknown>,
): string {
  // 简化实现：用分隔符拼接
  // 生产环境应使用 SHA-256 等哈希
  const paramStr = JSON.stringify(parameters, Object.keys(parameters).sort());
  return `${employeeId}:${toolName}:${action}:${paramStr}`;
}
