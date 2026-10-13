// Memory 敏感信息分类器 — 第一阶段：规则 + 元数据驱动
//
// 设计决策：
// - 第一阶段采用确定性规则分类，不使用 LLM
// - 基于来源元数据、关键词规则和部门绑定
// - 无法确定时采取保守策略（限制访问）
// - 分类结果与访问控制解耦：分类不替代授权检查
//
// 为什么不用 LLM 作为第一阶段？
// - 推理成本和延迟高
// - 分类结果不稳定、不可重复
// - 敏感内容可能需要外发到模型
// - 难以审计"为什么这样分类"
// - LLM 可能被 Memory 中的恶意指令影响

// 敏感级别
export type SensitivityLevel =
  | "public"        // 公开信息
  | "internal"      // 内部信息，部门内可见
  | "confidential"  // 机密信息，需要特别授权
  | "restricted"    // 受限信息，默认限制访问
  | "unknown";      // 无法分类，保守处理

// Memory 条目
export interface MemoryEntry {
  id: string;
  content: string;
  // 来源元数据
  sourceType: "conversation" | "document" | "tool_result" | "web_scrape" | "skill_output" | "manual";
  sourceId?: string;          // 原始文档/工具/会话 ID
  sourceDepartment?: string;  // 来源部门（如有）
  sourceUrl?: string;         // 来源 URL（如来自网页）
  createdAt: string;
  employeeId: string;
  departmentAtCreation: string;  // 创建时员工所属部门
  // 分类结果
  sensitivity: SensitivityLevel;
  classificationReason: string;
  classificationVersion: string;  // 规则版本号
}

// 分类规则
interface ClassificationRule {
  id: string;
  name: string;
  // 匹配条件
  matchKeywords?: RegExp[];
  matchSourceType?: string[];
  matchDepartment?: string[];
  matchUrlPatterns?: RegExp[];
  // 分类结果
  sensitivity: SensitivityLevel;
  reason: string;
}

// 规则版本号
export const RULE_VERSION = "1.0.0";

// 敏感关键词规则（示例）
const SENSITIVE_KEYWORDS: ClassificationRule = {
  id: "sensitive-keywords",
  name: "敏感关键词匹配",
  matchKeywords: [
    /password|passwd|secret|token|api[_-]?key|access[_-]?token|private[_-]?key/i,
    /credential|auth[_-]?token|bearer\s+[a-zA-Z0-9]{20,}/i,
    /\b(?:ghp_|gho_|ghs_|github_pat_)[a-zA-Z0-9]{20,}/i,  // GitHub tokens
    /\bxox[bprs]-[a-zA-Z0-9-]+/i,  // Slack tokens
    /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
  ],
  sensitivity: "confidential",
  reason: "Contains credential or secret patterns",
};

// 部门敏感规则
const DEPARTMENT_SENSITIVE: ClassificationRule = {
  id: "department-sensitive",
  name: "部门敏感内容",
  matchKeywords: [
    /salary|薪酬|compensation|payroll/i,
    /layoff|裁员|termination/i,
    /internal[_-]?audit|内部审计|合规审查/i,
    /merger|acquisition|并购|收购/i,
    /security[_-]?incident|安全事件|breach|漏洞/i,
    /performance[_-]?review|绩效考核/i,
  ],
  sensitivity: "confidential",
  reason: "Contains department-sensitive content patterns",
};

// 来源类型规则
const SOURCE_TYPE_RULES: ClassificationRule[] = [
  {
    id: "tool-credential-source",
    name: "工具结果中的凭证",
    matchSourceType: ["tool_result"],
    matchKeywords: [/token|key|secret|password|credential/i],
    sensitivity: "confidential",
    reason: "Credential pattern in tool result",
  },
  {
    id: "web-scrape-internal",
    name: "内部网页抓取",
    matchSourceType: ["web_scrape"],
    matchUrlPatterns: [/^https?:\/\/(localhost|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01]))/i],
    sensitivity: "internal",
    reason: "Scraped from internal network address",
  },
];

// 默认规则：无来源元数据的 Memory 保守处理
const UNKNOWN_SOURCE_RULE: ClassificationRule = {
  id: "unknown-source",
  name: "来源不明内容",
  matchSourceType: [],  // 匹配所有
  sensitivity: "restricted",
  reason: "No source metadata — conservative default",
};

// 分类规则列表（按优先级排序）
const CLASSIFICATION_RULES: ClassificationRule[] = [
  SENSITIVE_KEYWORDS,       // 最高优先级：凭证匹配
  DEPARTMENT_SENSITIVE,     // 部门敏感
  ...SOURCE_TYPE_RULES,     // 来源类型规则
];

// 匹配单条规则
function matchesRule(entry: MemoryEntry, rule: ClassificationRule): boolean {
  // 如果规则指定了来源类型，必须匹配
  if (rule.matchSourceType && rule.matchSourceType.length > 0) {
    if (!rule.matchSourceType.includes(entry.sourceType)) {
      return false;
    }
  }

  // 如果规则指定了关键词，至少匹配一个
  if (rule.matchKeywords && rule.matchKeywords.length > 0) {
    const hasMatch = rule.matchKeywords.some(regex => regex.test(entry.content));
    if (!hasMatch) {
      return false;
    }
  }

  // 如果规则指定了 URL 模式，至少匹配一个
  if (rule.matchUrlPatterns && rule.matchUrlPatterns.length > 0) {
    if (!entry.sourceUrl) return false;
    const url = entry.sourceUrl;
    const hasMatch = rule.matchUrlPatterns.some(regex => regex.test(url));
    if (!hasMatch) {
      return false;
    }
  }

  return true;
}

// 分类单条 Memory
export function classifyMemory(entry: Omit<MemoryEntry, "sensitivity" | "classificationReason" | "classificationVersion">): MemoryEntry {
  // 按优先级匹配规则
  for (const rule of CLASSIFICATION_RULES) {
    if (matchesRule(entry as MemoryEntry, rule)) {
      return {
        ...entry,
        sensitivity: rule.sensitivity,
        classificationReason: `${rule.id}: ${rule.reason}`,
        classificationVersion: RULE_VERSION,
      };
    }
  }

  // 检查部门绑定：如果 Memory 创建时的部门与当前评估部门不同
  // 且没有明确匹配任何规则，标记为内部
  // 注意：这里不传入当前部门，因为这应该在访问控制层处理
  // 分类层只负责判断内容敏感度，不负责判断当前用户是否有权访问

  // 无规则匹配 → 保守默认
  return {
    ...entry,
    sensitivity: "restricted",
    classificationReason: `${UNKNOWN_SOURCE_RULE.id}: ${UNKNOWN_SOURCE_RULE.reason}`,
    classificationVersion: RULE_VERSION,
  };
}

// 批量分类（转岗时重新评估）
export function reclassifyForTransfer(
  entries: Omit<MemoryEntry, "sensitivity" | "classificationReason" | "classificationVersion">[],
  newDepartment: string
): { classified: MemoryEntry[]; restricted: MemoryEntry[]; reasons: string[] } {
  const classified: MemoryEntry[] = [];
  const restricted: MemoryEntry[] = [];
  const reasons: string[] = [];

  for (const entry of entries) {
    const classifiedEntry = classifyMemory(entry);
    classified.push(classifiedEntry);

    // 如果来源部门与新部门不同，且敏感级别 >= confidential
    if (
      entry.sourceDepartment &&
      entry.sourceDepartment !== newDepartment &&
      (classifiedEntry.sensitivity === "confidential" || classifiedEntry.sensitivity === "restricted")
    ) {
      restricted.push(classifiedEntry);
      reasons.push(
        `Memory ${entry.id}: source dept=${entry.sourceDepartment}, target dept=${newDepartment}, ` +
        `sensitivity=${classifiedEntry.sensitivity} → restricted access`
      );
    }
  }

  return { classified, restricted, reasons };
}

// 判断员工是否有权访问某条 Memory
// 注意：这是独立的访问控制检查，不是分类的一部分
export function canAccessMemory(
  memory: MemoryEntry,
  currentEmployeeDepartment: string
): { allowed: boolean; reason: string } {
  switch (memory.sensitivity) {
    case "public":
      return { allowed: true, reason: "public" };
    case "internal":
      // 内部信息：来源部门或当前部门匹配即可
      const relevantDept = memory.sourceDepartment || memory.departmentAtCreation;
      return {
        allowed: relevantDept === currentEmployeeDepartment,
        reason: relevantDept === currentEmployeeDepartment
          ? "same department"
          : `different department (${relevantDept} vs ${currentEmployeeDepartment})`,
      };
    case "confidential":
      // 机密信息：需要来源部门匹配 + 特别授权
      // 实际授权检查在 Tool Gateway 执行，这里只做初步判断
      if (memory.departmentAtCreation !== currentEmployeeDepartment) {
        return { allowed: false, reason: "confidential: different department" };
      }
      return { allowed: true, reason: "confidential: same department (requires explicit authorization)" };
    case "restricted":
      // 受限信息：默认拒绝，需要显式授权
      return { allowed: false, reason: "restricted: requires explicit authorization" };
    case "unknown":
      // 未知分类：保守拒绝
      return { allowed: false, reason: "unknown classification: denied by default" };
    default:
      return { allowed: false, reason: `unknown sensitivity level: ${memory.sensitivity}` };
  }
}
