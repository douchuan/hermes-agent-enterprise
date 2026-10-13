// Tool Gateway — Tool Definitions
//
// 定义每个工具的名称、操作、参数 schema 和风险等级。
//
// 安全原则：
// - 工具定义只描述"如何做"，不定义"是否允许做"（授权在 Gateway 执行）
// - 参数 schema 用于输入校验，不是授权检查
// - 风险等级用于决定是否需要审批

export interface ToolDefinition {
  name: string;
  actions: ActionDefinition[];
}

export interface ActionDefinition {
  name: string;
  description: string;
  parameters: ParameterDefinition[];
  riskLevel: "low" | "medium" | "high";
}

export interface ParameterDefinition {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  required: boolean;
  description: string;
}

// GitHub 工具定义
export const githubTool: ToolDefinition = {
  name: "github",
  actions: [
    {
      name: "read_issue",
      description: "读取 GitHub Issue 详情",
      parameters: [
        { name: "repo", type: "string", required: true, description: "仓库名 (org/repo)" },
        { name: "issue_number", type: "number", required: true, description: "Issue 编号" },
      ],
      riskLevel: "low",
    },
    {
      name: "create_pr",
      description: "创建 Pull Request",
      parameters: [
        { name: "repo", type: "string", required: true, description: "仓库名 (org/repo)" },
        { name: "title", type: "string", required: true, description: "PR 标题" },
        { name: "body", type: "string", required: false, description: "PR 描述" },
        { name: "head", type: "string", required: true, description: "源分支" },
        { name: "base", type: "string", required: true, description: "目标分支" },
      ],
      riskLevel: "medium",
    },
    {
      name: "delete_repo",
      description: "删除 GitHub 仓库（高风险、不可逆）",
      parameters: [
        { name: "repo", type: "string", required: true, description: "仓库名 (org/repo)" },
      ],
      riskLevel: "high",
    },
  ],
};

// 财务工具定义
export const financeTool: ToolDefinition = {
  name: "finance",
  actions: [
    {
      name: "get_expense_report",
      description: "查询费用报告",
      parameters: [
        { name: "report_id", type: "string", required: false, description: "报告 ID（不指定则返回列表）" },
      ],
      riskLevel: "low",
    },
    {
      name: "submit_expense_report",
      description: "提交费用报销申请",
      parameters: [
        { name: "amount", type: "number", required: true, description: "金额" },
        { name: "category", type: "string", required: true, description: "费用类别" },
        { name: "description", type: "string", required: true, description: "费用说明" },
      ],
      riskLevel: "medium",
    },
    {
      name: "approve_expense_report",
      description: "批准或拒绝费用报销（高风险）",
      parameters: [
        { name: "report_id", type: "string", required: true, description: "报告 ID" },
        { name: "decision", type: "string", required: true, description: "approved 或 rejected" },
      ],
      riskLevel: "high",
    },
  ],
};

// 会议室预订工具定义
export const calendarTool: ToolDefinition = {
  name: "calendar",
  actions: [
    {
      name: "check_room_availability",
      description: "查询会议室在指定时间段的空闲状态",
      parameters: [
        { name: "date", type: "string", required: true, description: "日期 (YYYY-MM-DD)" },
        { name: "start_time", type: "string", required: true, description: "开始时间 (HH:MM)" },
        { name: "end_time", type: "string", required: true, description: "结束时间 (HH:MM)" },
      ],
      riskLevel: "low",
    },
    {
      name: "create_room_booking",
      description: "预订会议室",
      parameters: [
        { name: "room_id", type: "string", required: true, description: "会议室 ID" },
        { name: "date", type: "string", required: true, description: "日期 (YYYY-MM-DD)" },
        { name: "start_time", type: "string", required: true, description: "开始时间 (HH:MM)" },
        { name: "end_time", type: "string", required: true, description: "结束时间 (HH:MM)" },
        { name: "purpose", type: "string", required: false, description: "预订用途" },
      ],
      riskLevel: "medium",
    },
    {
      name: "cancel_room_booking",
      description: "取消已预订的会议室",
      parameters: [
        { name: "booking_id", type: "string", required: true, description: "预订 ID" },
      ],
      riskLevel: "high",  // 取消他人的预订需要审批
    },
  ],
};

// 所有已注册的工具
export const allTools: ToolDefinition[] = [githubTool, financeTool, calendarTool];
