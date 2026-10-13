# 第 2 章：Hermes Agent 的运行机制与安全边界

## 本章目标

建立理解后续部署和治理设计所需的 Hermes 运行时模型。重点回答以下问题：

- Hermes Agent 的核心组件如何协同工作？
- 它负责哪些能力，又将哪些责任留给外部环境？
- 从企业安全视角看，Hermes 的信任边界在哪里？
- 企业部署需要在 Hermes 之上叠加哪些额外的治理层？

## Hermes 是什么

Hermes Agent 由 [Nous Research](https://github.com/NousResearch/hermes-agent) 开源，是一个可以长期运行的个人 AI Agent。它的核心特征可以用两句话概括[^what-is-hermes]：

> **每个会话使用同一个 Agent 核心，运行在多种界面（CLI、消息平台、TUI、Desktop）上；能力来自插件和 Skill，而不是核心本身的膨胀。**

[^what-is-hermes]: 参见 Hermes Agent 仓库的 [AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md) 中 "What Hermes Is" 部分。

这意味着 Hermes 本身是一个"窄核心"（narrow waist）——模型交互、工具调用和会话管理由核心提供，具体的平台适配（Telegram、Slack、Discord 等）、工具后端（本地终端、Docker、SSH、云端沙箱）、技能扩展和记忆存储都由边缘模块实现。

### Hermes 提供的运行时能力

| 能力 | 说明 |
|------|------|
| **Agent Loop** | 持续调用模型 API，执行工具调用，处理返回结果，循环推进任务 |
| **Memory** | 将对话和工作方法提取为持久化的 Markdown 记忆文件 |
| **Skills** | 以 `SKILL.md` 文件形式封装工作方法，支持创建、调用和自动归档 |
| **Tool Execution** | 通过内置工具集和 MCP 连接执行 Shell、文件操作、浏览器、代码执行等 |
| **Session 管理** | 维护多会话状态、消息历史和上下文压缩 |
| **Gateway** | 作为后台进程持续运行，连接多种消息平台，处理会话路由 |
| **Cron 调度** | 定时任务执行，独立于用户会话 |
| **Delegation** | 派生子 Agent 执行子任务，支持并发和深度限制 |

### Hermes **不**提供的能力

理解 Hermes 不负责什么，与理解它负责什么同样重要：

- **不提供多租户隔离**——Hermes 的 Profile 机制用于区分不同的个人配置和凭据，但不提供企业级租户隔离、网络隔离或资源配额。
- **不提供身份认证**——Gateway 接受消息平台侧的入站消息，自身不实现 OIDC、SAML 等企业身份认证协议。
- **不提供企业工具授权**——工具调用依赖本地凭据（`.env` 文件或系统环境变量），没有服务端授权层来决定"谁可以在什么条件下调用什么"。
- **不提供网络策略**——Hermes 进程拥有其运行用户的完整网络访问权限，不会自行限制出站目标。
- **不提供审计日志**——虽然 Hermes 记录运行日志，但没有结构化的审计事件输出，无法直接对接企业的 SIEM 系统。
- **不提供凭证轮换**——API Key 和 Token 在配置文件中长期有效，没有自动轮换或短期凭证机制。

这些缺口正是本书后续章节要逐一填补的。

## 运行时架构：核心组件与数据流

### 2.1 Agent Loop：任务的执行引擎

Hermes 的核心执行循环是一个**同步的、带预算控制的工具调用循环**。它的简化流程如下：

```python
while (api_call_count < self.max_iterations and self.iteration_budget.remaining > 0) \
        or self._budget_grace_call:
    if self._interrupt_requested: break
    response = client.chat.completions.create(
        model=model, messages=messages, tools=tool_schemas
    )
    if response.tool_calls:
        for tc in response.tool_calls:
            messages.append(
                tool_result_message(
                    handle_function_call(tc.name, tc.args, task_id)
                )
            )
        api_call_count += 1
    else:
        return response.content  # 模型返回最终文本回答
```

完整的循环实现位于 `agent/conversation_loop.py`，每一步（阶段）都有独立的"兄弟模块"处理[^turn-phases]：

[^turn-phases]: 参见 `agent/AGENTS.md` 中对 turn 阶段拆分的设计说明。

| 阶段 | 模块 | 职责 |
|------|------|------|
| 预检 | `turn_preflight*` | 会话状态检查、预算计算 |
| API 请求组装 | `turn_request_assembly` | 构建模型请求（消息、工具 Schema） |
| API 调用 | `turn_api_call` | 发送请求到模型 API |
| 工具执行 | `turn_tool_round` / `turn_tool_validation` | 处理工具调用，执行工具 |
| 响应处理 | `turn_response_intake` | 解析模型返回，处理流式输出 |
| 溢出处理 | `turn_overflow` / `turn_truncation` | 上下文窗口超限时截断 |
| 上下文压缩 | `turn_context_compaction` | 必要时触发对话压缩 |
| 恢复 | `turn_recovery` | API 错误、限流后的重试 |
| 最终响应 | `turn_final_response` | 组装并返回最终回答 |

**对企业的含义：** Agent Loop 是 Hermes 最活跃的部分。每一次模型调用都会将完整的工具列表（Schema）发送给模型，模型可以选择其中任何一个。这意味着：
1. **暴露给模型的工具，模型就有可能调用。** 不需要的工具应该通过 `disabled_toolsets` 显式禁用。
2. **工具调用的授权必须在执行端强制，不能依赖模型的判断。** Hermes 的 `check_fn` 机制只决定工具是否对当前 Profile 可见，不决定单次调用是否被授权。

### 2.2 工具调用系统

Hermes 的工具系统由三个层次组成[^tools]：

[^tools]: 参见 `tools/AGENTS.md`。

**1. 工具注册表（`tools/registry.py`）**

每个工具文件在导入时通过 `registry.register()` 注册自己的 Schema、Handler 和可用性检查函数。注册表负责：
- 收集工具 Schema
- 分发工具调用（`handle_function_call()`）
- 执行 TTL 缓存的可用性检查（`check_fn`）

**2. 工具集（`toolsets.py`）**

工具被组织到不同的 Toolset 中：`browser`、`code_execution`、`delegation`、`file`、`memory`、`search`、`skills`、`terminal`、`web` 等。`_HERMES_CORE_TOOLS` 是所有平台默认继承的基础工具集。

**3. 工具执行后端（`tools/environments/`）**

终端类工具有多种后端：本地（local）、Docker、SSH、Modal、Daytona、Singularity。后端决定了工具实际运行的环境。

**关键安全特征：**

- **所有工具 Handler 返回 JSON 字符串**（除多模态工具外）。工具的执行结果直接作为消息的一部分返回给模型，进入下一轮对话。
- **Shell 执行是内置能力。** `terminal` 工具允许 Agent 在宿主系统上执行任意 Shell 命令。这是 Hermes 强大的原因，也是最大的安全风险。
- **`check_fn` 决定可见性，不决定授权。** 它检查的是"这个 Profile 是否有能力使用这个工具"（如是否有某个 API Key），而不是"这次调用是否被允许"。
- **MCP 工具独立注册。** 通过 `tools/mcp_tool_*.py` 处理 MCP Server 的发现、传输和注册，MCP 工具的信任由 Profile 级别记录。

**企业需要关注的关键点：**

Hermes 的工具执行环境**取决于部署方式**：
- 在本地 CLI 模式下，Agent 以运行用户的权限执行命令。
- 在 Gateway 模式下，Agent 同样以运行 Gateway 进程的用户身份执行命令。
- 工具后端可以选择 Docker 隔离，但默认是本地执行。

**这意味着 Hermes 自身不提供执行环境的沙箱化。沙箱必须由外部平台提供。**

### 2.3 Memory：持久化记忆系统

Hermes 的记忆系统由以下组件驱动[^memory]：

[^memory]: 参见 `agent/AGENTS.md` 中 Memory 和 `agent/memory_provider.py` 的设计。

**存储格式：** 记忆以 Markdown 文件形式持久化存储（如 `~/.hermes/memories/MEMORY.md` 和 `USER.md`），在每次会话启动时自动加载到系统提示中。

**架构：**
- `agent/memory_provider.py` — 抽象基类，定义记忆提供者接口
- `agent/memory_manager.py` — 编排器，协调不同记忆提供者的操作
- 记忆提供者以插件形式实现，支持不同后端

**生命周期：**
- **加载**：会话启动时，记忆文件被读取并注入系统提示。
- **提取**：会话结束时，`on_session_end` 触发记忆提取逻辑，由模型识别对话中值得持久化的信息。
- **写入**：提取的结果写入记忆文件，供后续会话使用。
- **Profile 隔离**：不同 Profile 的记忆文件存储在各自的 `HERMES_HOME` 下，互不共享。

**Curator（技能管理者）：** 独立于记忆系统，后台维护 Agent 创建的 Skill，定期审查和归档不活跃的技能。

**对企业的含义：**

- 记忆是**个人级别**的。每个 Profile 的记忆独立存储，没有内置的跨用户共享机制。
- 记忆的加载发生在系统提示中。如果记忆内容被不可信数据污染（如从恶意网页提取的信息被存入记忆），可能影响后续所有会话——这就是**间接 Prompt Injection** 的攻击路径。
- 记忆的提取由模型判断。不是所有工作经验都会被捕获，也不是所有被捕获的信息都有价值。
- 在 Cron 会话中，记忆提取默认不运行（`skip_memory=True`）。

### 2.4 Skills：可复用的工作方法

Skill 是 Hermes 中封装工作方法的核心机制[^skills]：

[^skills]: 参见 `skills/AGENTS.md` 和官方文档关于 [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) 的介绍。

**结构：** 每个 Skill 以一个 `SKILL.md` 文件为核心，包含 YAML frontmatter 和 Markdown 正文：

```yaml
---
name: github-workflow
description: 管理 GitHub PR 和 Workflow.
version: 1.0.0
author: "Hermes Agent"
platforms: [linux, macos]
metadata:
  hermes:
    tags: [github, pr, workflow]
    category: devops
---

# GitHub Workflow Skill
...
```

**发现与加载：**
- 内置 Skill 位于 `skills/` 目录，按类别组织
- 可选 Skill 位于 `optional-skills/` 目录，需手动安装
- 用户自定义 Skill 通过 Plugin 系统注册
- 加载后 Skill 作为工具集的一部分提供给模型

**Curator 自动维护：**
- 后台进程（约每 10 轮对话后）可能创建新的 Skill
- 定期审查和归档不活跃的 Agent 创建 Skill
- 归档目录：`~/.hermes/skills/.archive/`，可恢复
- 不删除——归档是最大操作
- 内置和 Hub 安装的 Skill 不受 Curator 影响

**安全考量：**
- Skill 文件中的脚本可能被 Agent 执行。如果 Skill 来源不可信（如从互联网安装），其内容可能包含恶意代码。
- Skill 可以引用其他工具。Skill 中的 `Prerequisites` 部分列出了所需的 MCP Server 或 API 凭据。
- 没有内置的沙箱或权限限制。Skill 执行的命令拥有 Agent 进程的完整权限。

### 2.5 Gateway：多平台消息网关

Gateway 是 Hermes 作为后台进程持续运行的模式[^gateway]：

[^gateway]: 参见 `gateway/AGENTS.md` 和官方文档关于 [Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview) 的介绍。

**核心职责：**
- 连接多种消息平台（Telegram、Discord、Slack、WhatsApp 等 ~20 个平台）
- 管理入站消息的路由和会话键（session key）
- 维护一个 Session → AIAgent 的缓存（默认最大 128 个，空闲 1 小时淘汰）
- 处理 Slash 命令（`/stop`、`/new`、`/status`、`/approve`、`/deny` 等）
- 管理后台进程通知（`terminal(background=true, notify_on_complete=true)`）
- 执行上下文压缩（85% 阈值时的会话卫生压缩）

**关键架构特征：**

```
消息平台 (Telegram/Slack/Discord/...)
        |
        v
   Gateway 进程 (asyncio 事件循环)
        |
        +-- 会话 A → AIAgent (Profile: alice)
        +-- 会话 B → AIAgent (Profile: bob)
        +-- 会话 C → AIAgent (Profile: charlie)
        |
        +-- Cron 调度器
```

- Gateway 以**单进程**运行一个 asyncio 事件循环
- 每秒检查一次 Cron 定时任务
- 每个会话对应一个 AIAgent 实例（缓存在内存中）
- 支持**多 Profile** 模式（`multiplex_profiles`），一个 Gateway 进程可以为多个 Profile 提供服务

**Profile Scope 机制：**

当 Gateway 以多 Profile 模式运行时，**一个进程为多个 Profile 服务**。这引入了一个关键安全问题：`os.environ` 持有启动 Profile 的值，而不是当前处理请求的 Profile 的值。Hermes 通过 `agent/secret_scope.py` 中的 Secret Scope 机制解决了这个问题——每个 Profile 活动（turn、回调、驱逐、tick）都绑定自己的 Scope，凭据读取通过 Scope 进行，而非直接读 `os.environ`[^profile-scope]。

[^profile-scope]: 参见 `gateway/AGENTS.md` § Profile scope。这是 Hermes 中为数不多的多租户意识设计，但它的目标是 Profile 隔离（不同个人配置），不是企业级租户隔离。

**安全含义：**
- Gateway 进程以运行它的用户身份执行所有操作
- 所有连接到 Gateway 的会话共享同一个进程的网络命名空间和文件系统权限
- Profile Scope 解决的是凭据隔离，不是执行环境隔离

## Hermes 的安全边界

理解 Hermes 的安全边界，是设计企业部署架构的前提。以下分析基于 Hermes 源码的实际实现。

### 信任边界图

```
                    ┌──────────────────────────────────────┐
                    │         Hermes Agent 运行时           │
                    │                                      │
  ┌─────────┐       │  ┌────────────────────────────────┐  │
  │  用户    │       │  │         Agent Loop             │  │   ┌──────────────┐
  │  输入    │──────>│  │  模型 API ←→ 工具注册表        │  │   │  模型 API     │
  │(消息/CLI)│       │  │         ↓                      │  │   │ (OpenAI/     │
  └─────────┘       │  │    工具执行 (本地/Docker/SSH)   │  │──>│  Anthropic/  │
                    │  │         ↓                      │  │   │  其他)       │
                    │  │    Memory / Skills 加载与写入    │  │   └──────────────┘
                    │  │         ↓                      │  │
                    │  │    Session 状态 (SQLite)       │  │
                    │  └────────────────────────────────┘  │
                    │         ↓                            │
  ┌─────────┐       │  ┌────────────────────────────────┐  │   ┌──────────────┐
  │  本地    │       │  │         Gateway               │  │   │  消息平台    │
  │  文件    │<─────>│  │  (Telegram/Slack/Discord/...) │  │<──│ (外部服务)   │
  │  系统    │       │  └────────────────────────────────┘  │   └──────────────┘
  └─────────┘       │         ↓                            │
                    │  ┌────────────────────────────────┐  │   ┌──────────────┐
                    │  │         Cron 调度器            │  │   │  企业工具    │
                    │  │  (定时任务)                     │  │   │ (API 服务)   │
                    │  └────────────────────────────────┘  │──>│  外部 API    │
                    │                                      │   │  互联网      │
                    └──────────────────────────────────────┘   └──────────────┘
                              │
                              v
                    ┌─────────────────────┐
                    │  操作系统 (Linux/   │
                    │  macOS/Windows)     │
                    │  - 文件系统访问      │
                    │  - 网络访问          │
                    │  - 进程执行          │
                    └─────────────────────┘
```

### 2.6 Hermes 的信任模型

Hermes 的信任模型可以用以下层级来理解：

**第一层：模型 API 的信任**

Hermes 信任模型 API 返回的内容。模型返回的工具调用会被执行，模型返回的文本会被传递给用户。Hermes 不验证模型返回的内容是否"安全"——它执行所有模型请求的工具调用。

**第二层：工具调用的信任**

工具调用的授权由 `check_fn` 决定可见性，但不在调用时执行额外的服务端授权检查。一旦工具对当前 Profile 可见，模型就可以调用它。

**第三层：消息平台的信任**

Gateway 接受来自已配置消息平台的入站消息。平台侧的身份验证（如 Telegram Bot Token、Slack App Token）由 Gateway 验证，但**Hermes 不执行额外的用户身份认证**。`GATEWAY_ALLOW_ALL_USERS` 环境变量控制是否接受所有用户消息。

**第四层：文件系统的信任**

Hermes 读写本地文件（记忆、Skill、配置文件、会话状态）。它信任文件系统的完整性——如果攻击者可以修改记忆文件或 Skill 文件，就可以影响 Agent 的行为。

**第五层：网络的信任**

Hermes 进程拥有运行用户的完整网络访问权限。它不自行限制出站连接目标。工具可以连接到任意外部 API、网页服务或其他网络端点。

### Hermes 的固有安全特征

| 特征 | 状态 | 说明 |
|------|------|------|
| 执行环境隔离 | 无 | 默认本地执行，可选 Docker/SSH 后端但不强制 |
| 网络出站限制 | 无 | 进程拥有完整网络访问权限 |
| 工具调用授权 | Profile 级可见性 | `check_fn` 决定工具是否可见，不限制单次调用 |
| 文件系统隔离 | Profile 级 | 不同 Profile 的 `HERMES_HOME` 不同 |
| 用户身份认证 | 消息平台侧 | 依赖平台的身份验证，无独立认证层 |
| 审计日志 | 无结构化输出 | 运行日志存在，但无结构化审计事件 |
| 凭证管理 | 静态配置 | `.env` 文件和 `config.yaml` 中的凭据长期有效 |
| 多租户 | 不支持 | Profile 是个人级别的，不是企业级租户 |
| Prompt Injection 防护 | 部分 | 系统提示包含安全指令，但不足以防范所有注入攻击 |
| Memory 隔离 | Profile 级 | 不同 Profile 的记忆文件独立存储 |
| Skill 来源控制 | 部分 | 内置 Skill 受仓库控制，Hub 安装的 Skill 需要用户自行判断 |

## 企业部署的启示

### Hermes 能做什么

1. **作为 Agent 运行时**——执行模型推理、工具调用、记忆管理和 Skill 调用。
2. **提供多种交互界面**——CLI、消息平台、TUI、Desktop 和 Web Dashboard。
3. **持久化工作经验**——通过 Memory 和 Skill 积累和复用工作方法。
4. **后台持续运行**——通过 Gateway 模式和 Cron 调度，提供 7×24 的自动执行能力。
5. **子 Agent 委派**——通过 Delegation 工具派生子 Agent 执行并行任务。

### Hermes 不能做什么（企业视角）

1. **不能隔离不同员工的执行环境**——Hermes 的 Profile 机制不提供企业级的租户隔离。
2. **不能控制工具调用的授权**——没有服务端授权层来决定"谁在什么条件下可以调用什么"。
3. **不能限制网络出站**——进程拥有完整的网络访问权限。
4. **不能生成结构化审计事件**——无法直接对接企业的 SIEM 系统。
5. **不能管理凭证的生命周期**——凭据在配置文件中长期有效。
6. **不能验证模型返回的工具调用是否安全**——它执行所有模型请求的工具调用。

### 企业需要在 Hermes 之上构建的层

基于上述分析，企业部署需要在 Hermes Agent 之上构建以下治理层：

| 治理层 | 解决的问题 | 本书章节 |
|--------|-----------|---------|
| **Web Console 与身份认证** | 员工入口、OIDC 登录、Session 管理 | 第 4 章 |
| **Control Plane** | 身份映射、权限计算、Sandbox 编排 | 第 3、5 章 |
| **Per-employee Sandbox** | 每位员工独立的 Agent 运行环境 | 第 5 章 |
| **网络策略** | 限制 Agent 的出站连接 | 第 6 章 |
| **Tool Gateway** | 统一企业工具调用的授权、审批和审计 | 第 7 章 |
| **Credential Broker** | 临时凭证和资源级 Token | 第 8 章 |
| **审批引擎** | 高风险操作的策略判定和审批 | 第 9 章 |
| **可观测性** | 全链路追踪、日志和审计事件 | 第 10 章 |
| **安全治理** | Prompt Injection、Memory 和 Skills 的安全控制 | 第 11 章 |

**核心论点：Hermes 提供了强大的个人 Agent 能力，但企业部署需要在其之上构建完整的身份、授权、隔离、审计和治理层。** Hermes 是企业 Agent 平台的**运行时引擎**，不是完整的平台。

## 本章小结

Hermes Agent 是一个设计精良的个人 AI Agent 运行时。它的核心特征——持续记忆、技能系统、工具调用能力和多平台支持——为个人工作效率提升提供了坚实的基础。

但同时，Hermes 的安全模型是围绕**个人使用**设计的。它信任运行环境的完整性、依赖 Profile 级别的凭据隔离、不强制执行网络限制、不生成结构化审计事件。这些选择在个人部署中是合理的——一个人运行自己的 Agent，没有跨用户隔离的需求，也没有企业合规的要求。

企业部署的核心挑战，就是在这个强大的个人引擎之上，构建一个可信的多租户平台。这就是本书后续章节的主题。

## 参考资料

- [Hermes Agent 官方文档](https://hermes-agent.nousresearch.com/)
- [Hermes Agent GitHub 仓库](https://github.com/NousResearch/hermes-agent)
- [AGENTS.md — Hermes 开发指南](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)
- [Gateway 内部机制](https://github.com/NousResearch/hermes-agent/blob/main/gateway/AGENTS.md)
- [Agent Loop 内部机制](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)
- [工具系统内部机制](https://github.com/NousResearch/hermes-agent/blob/main/tools/AGENTS.md)
- [Skill 系统内部机制](https://github.com/NousResearch/hermes-agent/blob/main/skills/AGENTS.md)
- [Razorpay 工程实践参考](https://engineering.razorpay.com/running-hermes-at-razorpay-a-network-isolated-self-improving-second-brain-for-every-employee-f91d56bea3f1)
