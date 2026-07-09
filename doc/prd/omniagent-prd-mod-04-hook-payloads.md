# OmniAgent PRD 模块 4 附件 B：Hook 事件 Payload Schema 规范

> **文档级别**：PRD 附件（M3 开工前补全前置文档 #3，L2 §11 里程碑交付物清单）
> **状态**：草稿 → 评审 → 冻结
> **依赖**：PRD mod-04 §4.2（已冻结）+ mod-04-hook-matrix.md（草稿，正评审）+ omniagent-types.ts §13（已冻结）+ L3-M4 §2.2.9-§2.2.12 + §3.5（已冻结）
> **用途**：为 27 个 Hook 事件的 payload 提供完整 schema 规范，供 Hook 开发者（command/prompt/agent/http/callback/function 6 类型）与 HookScheduler 实现者（L3-M4 §2.2.9）共同遵循

---

## 0. 文档定位与公共规则

### 0.1 文档定位

本文档是 PRD mod-04 §4.2 的 payload 附件，补全 27 个 Hook 事件的 payload schema。mod-04-hook-matrix.md 定义"哪些事件 × 哪些类型支持 Hook"，本文档定义"每个事件的 payload 长什么样"。

### 0.2 不重复原则

本文档不重复以下内容（仅引用）：

| 已有内容 | 来源 | 本文引用方式 |
|---------|------|------------|
| 27 事件名清单 + 7 类别分组 | types.ts §13 `HookEventName` + mod-04-hook-matrix §3 | §1-§27 按事件顺序排列 |
| 7 类显式 payload 定义 | types.ts §13 | §1/§2/§12/§14/§15/§16/§24 引用 types.ts §13 原文 |
| `HookResponse` 4 字段 schema | types.ts §13 + mod-04-hook-matrix §2.6 | §0.5 引用 |
| `Hook` 定义（event/type/target/async/timeoutMs） | types.ts §13 | §0.6 引用 |
| Hook 调度逻辑（注册/链顺序/超时/异步/递归） | L3-M4 §2.2.9-§2.2.12 + mod-04-hook-matrix §2 | 不重复，仅 payload 字段引用 |
| 矩阵支持标记（✓/△/−） | mod-04-hook-matrix §3 | 不重复，每事件"6 类型支持"一行引用 §3 矩阵行号 |
| `ToolInput` / `ToolResult` / `AgentId` / `SessionId` / `BoundaryId` / `PermissionMode` / `StopReason` | types.ts 各自 § | payload 字段类型引用 |

### 0.3 引用文档清单

- **PRD mod-04 §4.2**（已冻结）：27 事件 + 6 类型 + HookResponse + 关键 payload 契约
- **mod-04-hook-matrix.md**（草稿）：27 × 6 = 162 格支持矩阵 + 每事件详目（§4-§10）
- **omniagent-types.ts §13**（已冻结）：`HookEventName` / `HookType` / `HookPayload` / `HookResponse` / `Hook` + 7 类显式 payload + `GenericHookPayload`
- **L3-M4 §2.2.9-§2.2.12**（已冻结）：HookScheduler / HookExecutor / CommandHookHandler / FunctionHookHandler 实现
- **L3-M4 §3.5**（已冻结）：Hook 调度时序
- **PRD mod-04 §4.5**（已冻结）：审计日志 `AuditLogEntry` schema（payload 字段会进入审计日志的 `hook_payload` 字段）

### 0.4 公共字段说明

每个 payload 都包含一个 `event` 字段（字面量类型，用于运行时判别联合），其余字段为事件特定字段。Hook 系统在调度时还会附加以下 **envelope 元数据**（不在 payload 内，由 HookScheduler 在 dispatch 时注入 Hook 执行上下文）：

| Envelope 字段 | 类型 | 说明 |
|--------------|------|------|
| `timestamp` | string（ISO 8601） | 事件触发时间（HookScheduler 调用 `Date.now()` 生成） |
| `hook_id` | string | 本次 Hook 调用的唯一 ID（用于审计日志串联） |
| `chain_index` | number | 当前 Hook 在链中的位置（0-based，按 `HookRegistry.listByEvent()` 注册顺序） |
| `trace_id` | string | OpenTelemetry trace ID（跨模块/跨进程追踪） |
| `agent_id` | AgentId | 触发事件的 agent ID（若 payload 已含 `agent_id`，则 envelope 与 payload 一致） |
| `session_id` | SessionId | 触发事件的 session ID（若 payload 已含 `session_id`，则 envelope 与 payload 一致） |

> **注**：envelope 元数据通过 `HookContext` 对象传递给 Hook 处理器（L3-M4 §2.2.9 `HookScheduler.dispatch()` 签名），不序列化进 payload JSON。command 类型 Hook 通过环境变量 `OMNIAGENT_HOOK_CONTEXT` 读取（JSON 编码），http 类型通过 `X-OmniAgent-Trace-Id` 等 header 读取。

### 0.5 HookResponse 可改写字段

payload 的某些字段可被 Hook 响应改写（通过 `HookResponse` 的 4 字段）。改写规则见 mod-04-hook-matrix §2.6，本文档每事件列出"Hook 可访问字段"表，标注哪些字段可被 `permissionDecision` / `updatedInput` / `additionalContext` / `continue` 改写。

| HookResponse 字段 | 改写效果 | 适用事件 |
|------------------|---------|---------|
| `permissionDecision` | 改写工具调用的权限决策（allow/deny/ask） | 仅 `PreToolUse`（其余事件忽略此字段） |
| `updatedInput` | 改写工具调用的输入参数 | 仅 `PreToolUse`（其余事件忽略此字段） |
| `additionalContext` | 向下一轮 LLM 上下文注入文本 | 有"下一轮注入"的事件（见 mod-04-hook-matrix §2.6 表） |
| `continue` | 是否继续执行后续 Hook 与主流程 | 全部 27 事件（lifecycle-end 事件仅此字段生效） |

### 0.6 Generic → Explicit 提升路径

types.ts §13 当前显式定义 7 类 payload（`PreToolUse` / `PostToolUse` / `CompactBoundary` / `UserPromptSubmit` / `AssistantResponse` / `PermissionDeny` / `Shutdown`），其余 20 事件用 `GenericHookPayload`（`[key: string]: unknown`）。

本文档为 20 个 Generic 事件 **建议** schema（字段名 + 类型 + 含义），但 types.ts 不立即提升为 explicit（避免在 M1 开工前频繁改 types.ts）。M3 开发阶段实现 HookScheduler 时，根据本文档建议 schema 在 types.ts 补 explicit interface（提升标准见 §A.1）。

> **决策**：v1.0 types.ts §13 保持当前 7 类显式 + Generic，本文档作为"建议 schema"供实现参考；v1.1 或 v2.x 根据实现经验决定哪些 Generic 提升 explicit。

### 0.7 payload 版本化策略

- payload schema 随 types.ts §13 版本化（git commit hash + semver tag）
- Hook 处理器应 **防御性解析**：忽略未知字段（forward compat），对必填字段缺失 fail-closed（详见 mod-04-hook-matrix §2.2 规则 7）
- payload 字段新增（不删除/不改类型）视为兼容变更，无需 bump major version
- payload 字段删除或类型改变视为 breaking change，必须 bump major version + 在 PRD mod-04 §8 冻结决策表登记

---

## 1. PreToolUsePayload

> **事件类别**：工具事件（5 之 1）
> **触发时机**：用户/agent 触发工具调用，经五层拦截链通过后、执行工具前
> **事件源**：M3 ToolRouter（在 `Layer 5 Hooks` 阶段调用 `HookScheduler.dispatch('PreToolUse', payload)`）
> **types.ts 状态**：✅ explicit（types.ts §13 `PreToolUsePayload`）
> **引用**：types.ts §13 + mod-04-hook-matrix §4.1 + PRD mod-04 §4.2

### 1.1 Schema

```typescript
export interface PreToolUsePayload {
  event: 'PreToolUse';
  tool_name: string;
  input: ToolInput;
  agent_id: AgentId;
  cwd: string;
}
```

### 1.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'PreToolUse'` | 是 | 字面量，用于运行时判别联合 |
| `tool_name` | string | 是 | 工具名（如 `read` / `write` / `bash` / `grep`），对应 M3 工具池 `Tool.name` |
| `input` | `ToolInput` | 是 | 工具输入参数（JSON 对象，schema 由 `Tool.inputSchema` 定义） |
| `agent_id` | `AgentId` | 是 | 触发工具调用的 agent ID（main / coordinator / worker / teammate / fork） |
| `cwd` | string | 是 | 当前工作目录（影响文件工具的路径解析） |

### 1.3 示例

```json
{
  "event": "PreToolUse",
  "tool_name": "write",
  "input": { "file_path": "/Users/liguang/test.txt", "content": "hello" },
  "agent_id": "agent-main-001",
  "cwd": "/Users/liguang/ccwork"
}
```

### 1.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 改写权限决策（`allow` 覆盖五层拦截链结论 / `deny` 强制拒绝 / `ask` 升级为交互确认） |
| `updatedInput` | 替换 `input` 字段（如 sanitize 路径、追加默认参数） |
| `additionalContext` | 向工具执行结果注入上下文（作为 `tool_result` 前缀） |
| `continue` | `false` 则中止工具调用 + 下一轮 LLM（fail-closed） |

---

## 2. PostToolUsePayload

> **事件类别**：工具事件（5 之 2）
> **触发时机**：工具执行完成（成功或失败）后、`tool_result` 注入 LLM 上下文前
> **事件源**：M3 ToolRouter（在工具返回 `ToolResult` 后调用 `HookScheduler.dispatch('PostToolUse', payload)`）
> **types.ts 状态**：✅ explicit（types.ts §13 `PostToolUsePayload`）
> **引用**：types.ts §13 + mod-04-hook-matrix §4.2 + PRD mod-04 §4.2

### 2.1 Schema

```typescript
export interface PostToolUsePayload {
  event: 'PostToolUse';
  tool_name: string;
  input: ToolInput;
  result: ToolResult;
  duration_ms: number;
}
```

### 2.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'PostToolUse'` | 是 | 字面量 |
| `tool_name` | string | 是 | 工具名 |
| `input` | `ToolInput` | 是 | 工具输入（同 PreToolUse） |
| `result` | `ToolResult` | 是 | 工具执行结果（含 `output` / `error` / `is_error` 字段，见 types.ts `ToolResult`） |
| `duration_ms` | number | 是 | 工具执行耗时（毫秒，从 ToolRouter 调用工具到工具返回） |

### 2.3 示例

```json
{
  "event": "PostToolUse",
  "tool_name": "write",
  "input": { "file_path": "/Users/liguang/test.txt", "content": "hello" },
  "result": { "output": "File written successfully", "is_error": false },
  "duration_ms": 12
}
```

### 2.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略（工具已执行，无法回滚） |
| `updatedInput` | 忽略（同上） |
| `additionalContext` | 向下一轮 LLM 上下文注入文本（追加在 `tool_result` 之后） |
| `continue` | `false` 则中止下一轮 LLM 调用（如检测到敏感数据泄露，强制停止） |

---

## 3. ToolErrorPayload

> **事件类别**：工具事件（5 之 3）
> **触发时机**：工具执行抛出异常或返回 `is_error: true` 时
> **事件源**：M3 ToolRouter（在 catch 块或 `result.is_error === true` 分支调用）
> **types.ts 状态**：🔸 Generic（types.ts §13 未显式定义，用 `GenericHookPayload`；本文档建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §4.3 + PRD mod-04 §4.2

### 3.1 建议 Schema

```typescript
export interface ToolErrorPayload {
  event: 'ToolError';
  tool_name: string;
  input: ToolInput;
  error: string;
  error_type: 'timeout' | 'permission_denied' | 'execution_error' | 'sandbox_violation' | 'other';
  agent_id: AgentId;
  cwd: string;
}
```

### 3.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'ToolError'` | 是 | 字面量 |
| `tool_name` | string | 是 | 工具名 |
| `input` | `ToolInput` | 是 | 工具输入 |
| `error` | string | 是 | 错误消息（`Error.message` 或 `ToolResult.error`） |
| `error_type` | enum | 是 | 错误分类（`timeout`：超过 `timeoutMs` / `permission_denied`：Layer 2 拒绝 / `execution_error`：工具内部异常 / `sandbox_violation`：Layer 3 沙箱拒绝 / `other`：未分类） |
| `agent_id` | `AgentId` | 是 | 触发工具的 agent |
| `cwd` | string | 是 | 当前工作目录 |

### 3.3 示例

```json
{
  "event": "ToolError",
  "tool_name": "bash",
  "input": { "command": "rm -rf /" },
  "error": "Sandbox violation: destructive operation blocked",
  "error_type": "sandbox_violation",
  "agent_id": "agent-main-001",
  "cwd": "/Users/liguang/ccwork"
}
```

### 3.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向下一轮 LLM 注入错误处理建议（如"建议改用 `rm -rf` 限定路径"） |
| `continue` | `false` 则中止下一轮 LLM（如连续 3 次 `timeout`，强制停止 agent） |

---

## 4. ToolResultFilteredPayload

> **事件类别**：工具事件（5 之 4）
> **触发时机**：M7 findRelevantMemories 或 ToolRouter 对 `tool_result` 做截断/摘要/丢块后
> **事件源**：M7（context filter）或 M3 ToolRouter（result filter）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §4.4 + PRD mod-04 §4.2

### 4.1 建议 Schema

```typescript
export interface ToolResultFilteredPayload {
  event: 'ToolResultFiltered';
  tool_name: string;
  original_size: number;
  filtered_size: number;
  filter_strategy: 'truncate' | 'summarize' | 'drop_blocks';
}
```

### 4.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'ToolResultFiltered'` | 是 | 字面量 |
| `tool_name` | string | 是 | 工具名 |
| `original_size` | number | 是 | 原始 `tool_result` 字节数或 token 数 |
| `filtered_size` | number | 是 | 过滤后字节数或 token 数 |
| `filter_strategy` | enum | 是 | 过滤策略（`truncate`：截断尾部 / `summarize`：摘要替换 / `drop_blocks`：丢弃某些 ContentBlock） |

### 4.3 示例

```json
{
  "event": "ToolResultFiltered",
  "tool_name": "read",
  "original_size": 128000,
  "filtered_size": 32000,
  "filter_strategy": "drop_blocks"
}
```

### 4.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 注入过滤说明（如"已截断 96KB，完整结果见 transcript"） |
| `continue` | `false` 则中止下一轮（如过滤后仍超预算，强制 compact） |

---

## 5. ToolPoolChangedPayload

> **事件类别**：工具事件（5 之 5）
> **触发时机**：M3 工具池新增/移除/重载工具后（如 MCP server 连接、Skill 加载、Custom Agent 注册）
> **事件源**：M3 ToolRegistry（在 `add` / `remove` / `reload` 方法中调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §4.5 + PRD mod-04 §4.2

### 5.1 建议 Schema

```typescript
export interface ToolPoolChangedPayload {
  event: 'ToolPoolChanged';
  change_type: 'add' | 'remove' | 'reload';
  tool_name: string;
  source: 'mcp' | 'skill' | 'custom_agent';
}
```

### 5.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'ToolPoolChanged'` | 是 | 字面量 |
| `change_type` | enum | 是 | 变更类型（`add`：新增 / `remove`：移除 / `reload`：重载，如 MCP 重连后重新 enumerate tools） |
| `tool_name` | string | 是 | 受影响的工具名（`reload` 时为重载的工具集合的第一个，或 `*` 表示全部） |
| `source` | enum | 是 | 工具来源（`mcp`：MCP server / `skill`：M6 Skills / `custom_agent`：用户自定义 agent） |

### 5.3 示例

```json
{
  "event": "ToolPoolChanged",
  "change_type": "add",
  "tool_name": "mcp__slack__send_message",
  "source": "mcp"
}
```

### 5.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 注入工具池变更说明（向 LLM 告知"新增工具 X，可调用"） |
| `continue` | `false` 则中止下一轮（如检测到恶意 MCP 注入危险工具，强制停止） |

---

## 6. AgentStartPayload

> **事件类别**：Agent 事件（4 之 1）
> **触发时机**：M2 ReAct Loop 启动新 agent（main/coordinator/worker/teammate/fork）时
> **事件源**：M2 AgentRunner（在 `start()` 方法首行调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §5.1 + PRD mod-04 §4.2

### 6.1 建议 Schema

```typescript
export interface AgentStartPayload {
  event: 'AgentStart';
  agent_id: AgentId;
  agent_type: 'main' | 'coordinator' | 'worker' | 'teammate' | 'fork';
  parent_agent_id?: AgentId;
  session_id: SessionId;
}
```

### 6.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'AgentStart'` | 是 | 字面量 |
| `agent_id` | `AgentId` | 是 | 新 agent 的 ID（格式：`agent-{type}-{uuid8}`） |
| `agent_type` | enum | 是 | agent 类型（`main`：用户主 agent / `coordinator`：M5 协调者 / `worker`：M5 工作者 / `teammate`：M5 队友 / `fork`：M2 agent_router fork 出的子 agent） |
| `parent_agent_id` | `AgentId` | 否 | 父 agent ID（`main` 类型无父 agent，其余类型必有） |
| `session_id` | `SessionId` | 是 | 所属 session |

### 6.3 示例

```json
{
  "event": "AgentStart",
  "agent_id": "agent-fork-a1b2c3d4",
  "agent_type": "fork",
  "parent_agent_id": "agent-main-001",
  "session_id": "sess-2026-07-09-001"
}
```

### 6.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向 agent 首轮 LLM 上下文注入文本（如加载 user preferences） |
| `continue` | `false` 则中止 agent 启动（如检测到 fork 深度超限，强制停止） |

---

## 7. AgentStopPayload

> **事件类别**：Agent 事件（4 之 2）
> **触发时机**：agent 退出（正常完成/abort/错误/预算超限）时
> **事件源**：M2 AgentRunner（在 `stop()` 方法末尾调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §5.2 + PRD mod-04 §4.2

### 7.1 建议 Schema

```typescript
export interface AgentStopPayload {
  event: 'AgentStop';
  agent_id: AgentId;
  agent_type: 'main' | 'coordinator' | 'worker' | 'teammate' | 'fork';
  stop_reason: 'completed' | 'aborted' | 'error' | 'budget_exceeded';
  duration_ms: number;
}
```

### 7.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'AgentStop'` | 是 | 字面量 |
| `agent_id` | `AgentId` | 是 | 退出的 agent ID |
| `agent_type` | enum | 是 | agent 类型 |
| `stop_reason` | enum | 是 | 退出原因（`completed`：正常完成 / `aborted`：用户 Ctrl+C 或父 agent abort / `error`：未捕获异常 / `budget_exceeded`：预算超限） |
| `duration_ms` | number | 是 | agent 运行总耗时（从 `AgentStart` 到 `AgentStop`） |

### 7.3 示例

```json
{
  "event": "AgentStop",
  "agent_id": "agent-fork-a1b2c3d4",
  "agent_type": "fork",
  "stop_reason": "completed",
  "duration_ms": 45000
}
```

### 7.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 忽略（agent 已停止，无下一轮注入；详见 mod-04-hook-matrix §2.6 lifecycle-end 事件表） |
| `continue` | `false` 则中止后续 Hook 链（如 cleanup Hook 失败，跳过剩余 cleanup） |

> **注**：`AgentStop` 是 lifecycle-end 事件，`additionalContext` 字段被忽略（无下一轮 LLM 注入）。`prompt` / `agent` 类型不支持（详见 mod-04-hook-matrix §3 矩阵行 7）。

---

## 8. SubagentSpawnPayload

> **事件类别**：Agent 事件（4 之 3）
> **触发时机**：M2 agent_router 或 M5 Coordinator 决定 spawn 子 agent 时
> **事件源**：M2 agent_router 或 M5 Coordinator（在 `spawnSubagent()` 方法首行调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §5.3 + PRD mod-04 §4.2

### 8.1 建议 Schema

```typescript
export interface SubagentSpawnPayload {
  event: 'SubagentSpawn';
  parent_agent_id: AgentId;
  child_agent_id: AgentId;
  route: 'fork' | 'teammate' | 'remote';
  prompt: string;
  tools_whitelist?: string[];
}
```

### 8.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'SubagentSpawn'` | 是 | 字面量 |
| `parent_agent_id` | `AgentId` | 是 | 父 agent ID |
| `child_agent_id` | `AgentId` | 是 | 子 agent ID（尚未启动，`AgentStart` 紧随其后） |
| `route` | enum | 是 | spawn 路径（`fork`：M2 agent_router fork，共享父 transcript / `teammate`：M5 mailbox 异步通信 / `remote`：M5 Remote Server 跨进程） |
| `prompt` | string | 是 | 子 agent 的初始 prompt（含 task description） |
| `tools_whitelist` | string[] | 否 | 子 agent 可用工具白名单（未指定则继承父 agent 工具池） |

### 8.3 示例

```json
{
  "event": "SubagentSpawn",
  "parent_agent_id": "agent-main-001",
  "child_agent_id": "agent-fork-a1b2c3d4",
  "route": "fork",
  "prompt": "Research the OmniAgent Hook system and report payload schemas for 4 model events",
  "tools_whitelist": ["read", "grep", "glob"]
}
```

### 8.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 注入子 agent 初始上下文（追加在 `prompt` 之后） |
| `continue` | `false` 则中止 spawn（如检测到递归深度超限，阻止 fork） |

---

## 9. SubagentExitPayload

> **事件类别**：Agent 事件（4 之 4）
> **触发时机**：子 agent 退出（完成/abort/错误）时
> **事件源**：M2 agent_router 或 M5 Coordinator（在子 agent `AgentStop` 后调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §5.4 + PRD mod-04 §4.2

### 9.1 建议 Schema

```typescript
export interface SubagentExitPayload {
  event: 'SubagentExit';
  parent_agent_id: AgentId;
  child_agent_id: AgentId;
  exit_reason: 'completed' | 'aborted' | 'error';
  duration_ms: number;
}
```

### 9.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'SubagentExit'` | 是 | 字面量 |
| `parent_agent_id` | `AgentId` | 是 | 父 agent ID（若父 agent 已退出，则为 `agent-unknown`） |
| `child_agent_id` | `AgentId` | 是 | 子 agent ID |
| `exit_reason` | enum | 是 | 退出原因（同 `AgentStopPayload.stop_reason`，但无 `budget_exceeded`，因预算超限由父 agent 处理） |
| `duration_ms` | number | 是 | 子 agent 运行耗时 |

### 9.3 示例

```json
{
  "event": "SubagentExit",
  "parent_agent_id": "agent-main-001",
  "child_agent_id": "agent-fork-a1b2c3d4",
  "exit_reason": "completed",
  "duration_ms": 45000
}
```

### 9.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 忽略（lifecycle-end 事件） |
| `continue` | `false` 则中止后续 Hook 链 |

> **注**：`SubagentExit` 是 lifecycle-end 事件，`prompt` / `agent` 类型不支持（详见 mod-04-hook-matrix §3 矩阵行 9）。

---

## 10. SessionStartPayload

> **事件类别**：会话事件（4 之 1）
> **触发时机**：用户启动新 session（`omniagent` 命令首次执行）时
> **事件源**：M2 SessionManager（在 `start()` 方法首行调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §6.1 + PRD mod-04 §4.2

### 10.1 建议 Schema

```typescript
export interface SessionStartPayload {
  event: 'SessionStart';
  session_id: SessionId;
  cwd: string;
  user: string;
  permission_mode: PermissionMode;
}
```

### 10.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'SessionStart'` | 是 | 字面量 |
| `session_id` | `SessionId` | 是 | session ID（格式：`sess-{YYYY-MM-DD}-{uuid8}`） |
| `cwd` | string | 是 | 启动时的工作目录 |
| `user` | string | 是 | 当前 OS 用户（`process.env.USER`） |
| `permission_mode` | `PermissionMode` | 是 | 初始权限模式（`default` / `acceptEdits` / `plan` / `bypassPermissions` / `auto` / `dontAsk`） |

### 10.3 示例

```json
{
  "event": "SessionStart",
  "session_id": "sess-2026-07-09-001",
  "cwd": "/Users/liguang/ccwork",
  "user": "liguang",
  "permission_mode": "default"
}
```

### 10.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向首轮 LLM 上下文注入文本（如加载 CLAUDE.md / user preferences） |
| `continue` | `false` 则中止 session 启动（如检测到不安全 `permission_mode`，强制降级） |

---

## 11. SessionEndPayload

> **事件类别**：会话事件（4 之 2）
> **触发时机**：session 结束（用户退出/Ctrl+C/预算超限/Shutdown）时
> **事件源**：M2 SessionManager（在 `end()` 方法首行调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §6.2 + PRD mod-04 §4.2

### 11.1 建议 Schema

```typescript
export interface SessionEndPayload {
  event: 'SessionEnd';
  session_id: SessionId;
  end_reason: 'user_exit' | 'sigint' | 'budget_exceeded' | 'shutdown';
  duration_ms: number;
  turns_count: number;
}
```

### 11.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'SessionEnd'` | 是 | 字面量 |
| `session_id` | `SessionId` | 是 | session ID |
| `end_reason` | enum | 是 | 结束原因（`user_exit`：用户主动退出 `/exit` / `sigint`：Ctrl+C / `budget_exceeded`：预算超限 / `shutdown`：系统关闭） |
| `duration_ms` | number | 是 | session 总耗时 |
| `turns_count` | number | 是 | session 总轮数（ReAct Loop 完成次数） |

### 11.3 示例

```json
{
  "event": "SessionEnd",
  "session_id": "sess-2026-07-09-001",
  "end_reason": "user_exit",
  "duration_ms": 1800000,
  "turns_count": 24
}
```

### 11.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 忽略（lifecycle-end 事件） |
| `continue` | `false` 则中止后续 Hook 链 |

> **注**：`SessionEnd` 是 lifecycle-end 事件，`prompt` / `agent` 类型不支持（详见 mod-04-hook-matrix §3 矩阵行 11）。

---

## 12. CompactBoundaryPayload

> **事件类别**：会话事件（4 之 3）
> **触发时机**：M7 compact 在 transcript 中标记压缩边界后
> **事件源**：M7 CompactService（在 `markBoundary()` 方法末尾调用）
> **types.ts 状态**：✅ explicit（types.ts §13 `CompactBoundaryPayload`）
> **引用**：types.ts §13 + mod-04-hook-matrix §6.3 + PRD mod-04 §4.2

### 12.1 Schema

```typescript
export interface CompactBoundaryPayload {
  event: 'CompactBoundary';
  boundary_id: BoundaryId;
  compact_range: { start: number; end: number };
  tokens_before: number;
  tokens_after: number;
}
```

### 12.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'CompactBoundary'` | 是 | 字面量 |
| `boundary_id` | `BoundaryId` | 是 | 边界 ID（格式：`boundary-{uuid8}`，用于 `Resume` 时定位） |
| `compact_range` | `{ start: number; end: number }` | 是 | 压缩的 transcript 行范围（0-based，`[start, end)`） |
| `tokens_before` | number | 是 | 压缩前 token 数 |
| `tokens_after` | number | 是 | 压缩后 token 数（摘要 + 保留的最近 N 轮） |

### 12.3 示例

```json
{
  "event": "CompactBoundary",
  "boundary_id": "boundary-a1b2c3d4",
  "compact_range": { "start": 0, "end": 120 },
  "tokens_before": 96000,
  "tokens_after": 18000
}
```

### 12.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向下一轮 LLM 注入摘要补充（如保留关键决策点） |
| `continue` | `false` 则中止 compact（如检测到摘要丢失关键信息，触发 reactive_compact 重做） |

---

## 13. ResumePayload

> **事件类别**：会话事件（4 之 4）
> **触发时机**：用户 `omniagent --resume <session_id>` 启动后、加载 transcript 完成时
> **事件源**：M2 SessionManager（在 `resume()` 方法末尾调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §6.4 + PRD mod-04 §4.2

### 13.1 建议 Schema

```typescript
export interface ResumePayload {
  event: 'Resume';
  session_id: SessionId;
  resumed_from_turn: number;
  compact_boundary_id?: BoundaryId;
  cwd: string;
}
```

### 13.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'Resume'` | 是 | 字面量 |
| `session_id` | `SessionId` | 是 | 恢复的 session ID |
| `resumed_from_turn` | number | 是 | 恢复后从第几轮继续（0-based） |
| `compact_boundary_id` | `BoundaryId` | 否 | 若恢复点在 compact boundary 之后，则标注 boundary ID（用于 LLM 上下文重建） |
| `cwd` | string | 是 | 恢复时的工作目录（可能与 session 启动时不同） |

### 13.3 示例

```json
{
  "event": "Resume",
  "session_id": "sess-2026-07-09-001",
  "resumed_from_turn": 24,
  "compact_boundary_id": "boundary-a1b2c3d4",
  "cwd": "/Users/liguang/ccwork"
}
```

### 13.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向首轮 LLM 注入恢复说明（如"上次进行到第 24 轮，已压缩前 120 行"） |
| `continue` | `false` 则中止恢复（如检测到 transcript 损坏，阻止启动） |

---

## 14. UserPromptSubmitPayload

> **事件类别**：消息事件（2 之 1）
> **触发时机**：用户提交 prompt（终端输入回车 / API `ChatRequest` 到达）后、BUILD_CONTEXT 前
> **事件源**：M2 ReAct Loop（在 `handleUserPrompt()` 方法首行调用）
> **types.ts 状态**：✅ explicit（types.ts §13 `UserPromptSubmitPayload`）
> **引用**：types.ts §13 + mod-04-hook-matrix §7.1 + PRD mod-04 §4.2

### 14.1 Schema

```typescript
export interface UserPromptSubmitPayload {
  event: 'UserPromptSubmit';
  prompt: string;
  session_id: SessionId;
}
```

### 14.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'UserPromptSubmit'` | 是 | 字面量 |
| `prompt` | string | 是 | 用户输入的 prompt 原文（未做任何预处理） |
| `session_id` | `SessionId` | 是 | 所属 session |

### 14.3 示例

```json
{
  "event": "UserPromptSubmit",
  "prompt": "Write a Hook for PreToolUse that blocks bash rm -rf",
  "session_id": "sess-2026-07-09-001"
}
```

### 14.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略（非工具调用） |
| `updatedInput` | 忽略 |
| `additionalContext` | 向 LLM 上下文注入文本（如加载 memory 召回结果） |
| `continue` | `false` 则中止本轮（如检测到 prompt injection，拒绝处理） |

> **注**：`UserPromptSubmit` 是 prompt injection 检测的主要 Hook 点（mod-04 §4.4 6 类判定规则可在此 Hook 中实现）。

---

## 15. AssistantResponsePayload

> **事件类别**：消息事件（2 之 2）
> **触发时机**：LLM 流式输出完成（`stop_reason` 触发）后、EVAL_STOP_REASON 前
> **事件源**：M2 ReAct Loop（在 `STREAM_RENDER` 状态末尾调用）
> **types.ts 状态**：✅ explicit（types.ts §13 `AssistantResponsePayload`）
> **引用**：types.ts §13 + mod-04-hook-matrix §7.2 + PRD mod-04 §4.2

### 15.1 Schema

```typescript
export interface AssistantResponsePayload {
  event: 'AssistantResponse';
  response: string;
  stop_reason: StopReason;
  tokens: { input: number; output: number };
}
```

### 15.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'AssistantResponse'` | 是 | 字面量 |
| `response` | string | 是 | LLM 输出的文本（已拼接流式 chunk） |
| `stop_reason` | `StopReason` | 是 | 停止原因（types.ts §13 `StopReason` 11 值：`end_turn` / `tool_use` / `max_output_tokens` / `ptl` / `user_interrupt` / `stall_passive_30s` / `stall_active_90s` / `provider_5xx` / `provider_429` / `tool_execution_error` / `budget_exceeded`） |
| `tokens` | `{ input: number; output: number }` | 是 | 本轮 token 消耗（input = prompt tokens，output = completion tokens） |

### 15.3 示例

```json
{
  "event": "AssistantResponse",
  "response": "I'll write a Hook to block bash rm -rf. First, let me check the Hook system...",
  "stop_reason": "tool_use",
  "tokens": { "input": 3200, "output": 180 }
}
```

### 15.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向下一轮 LLM 注入文本（如审计日志说明） |
| `continue` | `false` 则中止下一轮（如检测到 LLM 输出敏感数据，强制停止） |

---

## 16. PermissionDenyPayload

> **事件类别**：权限事件（4 之 1）
> **触发时机**：五层拦截链任一层返回 `deny` 后
> **事件源**：M4 PermissionGate（在 `deny()` 方法末尾调用）
> **types.ts 状态**：✅ explicit（types.ts §13 `PermissionDenyPayload`）
> **引用**：types.ts §13 + mod-04-hook-matrix §8.1 + PRD mod-04 §4.2

### 16.1 Schema

```typescript
export interface PermissionDenyPayload {
  event: 'PermissionDeny';
  tool_name: string;
  matched_rule: string;
  layer: 1 | 2 | 3 | 4 | 5;
}
```

### 16.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'PermissionDeny'` | 是 | 字面量 |
| `tool_name` | string | 是 | 被拒绝的工具名 |
| `matched_rule` | string | 是 | 命中的规则 ID（如 `hard-banned-rm-rf` / `soft-denied-curl` / `risk-classifier-strict`） |
| `layer` | 1 \| 2 \| 3 \| 4 \| 5 | 是 | 拒绝发生的拦截层（1 System Prompt / 2 权限规则 / 3 沙箱 / 4 Plan Mode / 5 Hooks/预算） |

### 16.3 示例

```json
{
  "event": "PermissionDeny",
  "tool_name": "bash",
  "matched_rule": "hard-banned-rm-rf",
  "layer": 2
}
```

### 16.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略（决策已做出，Hook 仅观察） |
| `updatedInput` | 忽略 |
| `additionalContext` | 向下一轮 LLM 注入拒绝说明（如"bash rm -rf 被硬禁用，请改用 trash"） |
| `continue` | `false` 则中止下一轮（如连续 3 次 deny 同一工具，触发 degrade_to_ask） |

> **注**：`PermissionDeny` 是 DenialTracker hooks 上下文触发点（mod-04-hook-matrix §2.7 + L3-M4 §3.5.3），Hook 可读取 DenialTracker 状态决定是否 degrade。

---

## 17. PermissionAllowPayload

> **事件类别**：权限事件（4 之 2）
> **触发时机**：五层拦截链全部通过、工具调用被允许后
> **事件源**：M4 PermissionGate（在 `allow()` 方法末尾调用，早于 `PreToolUse`）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §8.2 + PRD mod-04 §4.2

### 17.1 建议 Schema

```typescript
export interface PermissionAllowPayload {
  event: 'PermissionAllow';
  tool_name: string;
  matched_rule: string;
  layer: 1 | 2 | 3 | 4 | 5;
  decision_source: 'rule' | 'risk_classifier' | 'auto_mode';
}
```

### 17.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'PermissionAllow'` | 是 | 字面量 |
| `tool_name` | string | 是 | 被允许的工具名 |
| `matched_rule` | string | 是 | 命中的规则 ID（`auto-allow-read` / `risk-classifier-pass` / `auto-mode-bypass` 等） |
| `layer` | 1 \| 2 \| 3 \| 4 \| 5 | 是 | 允许发生的拦截层 |
| `decision_source` | enum | 是 | 决策来源（`rule`：权限规则匹配 / `risk_classifier`：Risk Classifier 通过 / `auto_mode`：Auto Mode 自动允许） |

### 17.3 示例

```json
{
  "event": "PermissionAllow",
  "tool_name": "read",
  "matched_rule": "auto-allow-read",
  "layer": 2,
  "decision_source": "rule"
}
```

### 17.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 忽略（允许决策不注入 LLM） |
| `continue` | `false` 则回滚允许为 deny（如 Hook 检测到 risk_classifier 误判，强制升级为 ask） |

> **注**：`PermissionAllow` 的 `continue: false` 是唯一的"Hook 否决 allow"路径（将 allow 降级为 deny 或 ask），用于 Hook 兜底 risk_classifier 误判。

---

## 18. PermissionAskPayload

> **事件类别**：权限事件（4 之 3）
> **触发时机**：五层拦截链返回 `ask`（如 risk_classifier 低置信度 / DenialTracker degrade_to_ask）后
> **事件源**：M4 PermissionGate（在 `ask()` 方法末尾调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §8.3 + PRD mod-04 §4.2

### 18.1 建议 Schema

```typescript
export interface PermissionAskPayload {
  event: 'PermissionAsk';
  tool_name: string;
  matched_rule: string;
  layer: 1 | 2 | 3 | 4 | 5;
  ask_reason: 'rule' | 'risk_classifier_low_confidence' | 'denial_tracker_degraded';
}
```

### 18.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'PermissionAsk'` | 是 | 字面量 |
| `tool_name` | string | 是 | 待确认的工具名 |
| `matched_rule` | string | 是 | 命中的规则 ID |
| `layer` | 1 \| 2 \| 3 \| 4 \| 5 | 是 | 触发 ask 的拦截层 |
| `ask_reason` | enum | 是 | ask 原因（`rule`：规则匹配 ask / `risk_classifier_low_confidence`：Risk Classifier 置信度 < 阈值 / `denial_tracker_degraded`：DenialTracker 触发降级） |

### 18.3 示例

```json
{
  "event": "PermissionAsk",
  "tool_name": "bash",
  "matched_rule": "risk-classifier-low-confidence",
  "layer": 5,
  "ask_reason": "risk_classifier_low_confidence"
}
```

### 18.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略（ask 已触发交互，Hook 仅观察） |
| `updatedInput` | 忽略 |
| `additionalContext` | 向交互提示注入说明（如"此命令含网络访问，建议确认"） |
| `continue` | `false` 则中止工具调用（如检测到 ask 风暴，强制 deny） |

---

## 19. PermissionEscalationPayload

> **事件类别**：权限事件（4 之 4）
> **触发时机**：权限模式切换（用户命令 `/auto` / risk_classifier 升级 / DenialTracker degrade）后
> **事件源**：M4 PermissionGate（在 `escalate()` 方法末尾调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §8.4 + PRD mod-04 §4.2

### 19.1 建议 Schema

```typescript
export interface PermissionEscalationPayload {
  event: 'PermissionEscalation';
  from_mode: PermissionMode;
  to_mode: PermissionMode;
  escalation_reason: 'user_command' | 'risk_classifier' | 'denial_tracker';
  tool_name?: string;
}
```

### 19.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'PermissionEscalation'` | 是 | 字面量 |
| `from_mode` | `PermissionMode` | 是 | 切换前模式 |
| `to_mode` | `PermissionMode` | 是 | 切换后模式 |
| `escalation_reason` | enum | 是 | 切换原因（`user_command`：用户 `/auto` 等命令 / `risk_classifier`：Risk Classifier 升级 / `denial_tracker`：DenialTracker 触发降级或升级） |
| `tool_name` | string | 否 | 触发升级的工具名（仅 `risk_classifier` / `denial_tracker` 原因时填充） |

### 19.3 示例

```json
{
  "event": "PermissionEscalation",
  "from_mode": "auto",
  "to_mode": "default",
  "escalation_reason": "denial_tracker",
  "tool_name": "bash"
}
```

### 19.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向下一轮 LLM 注入模式切换说明（如"已从 auto 降级为 default，后续工具调用需确认"） |
| `continue` | `false` 则中止模式切换（如检测到非法降级，回滚） |

---

## 20. ModelSwitchPayload

> **事件类别**：模型事件（4 之 1）
> **触发时机**：LLM 模型切换（用户 `/model` 命令 / fallback / auto 切换）后
> **事件源**：M1 LLMProvider（在 `switchModel()` 方法末尾调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §9.1 + PRD mod-04 §4.2

### 20.1 建议 Schema

```typescript
export interface ModelSwitchPayload {
  event: 'ModelSwitch';
  from_model: string;
  to_model: string;
  switch_reason: 'user_command' | 'fallback' | 'auto';
  provider: string;
}
```

### 20.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'ModelSwitch'` | 是 | 字面量 |
| `from_model` | string | 是 | 切换前模型 ID（如 `claude-sonnet-4-6`） |
| `to_model` | string | 是 | 切换后模型 ID |
| `switch_reason` | enum | 是 | 切换原因（`user_command`：用户 `/model` / `fallback`：fallback 链触发 / `auto`：Auto Mode 自动切换） |
| `provider` | string | 是 | provider 名（`anthropic` / `openai` / `bedrock` / `ollama`） |

### 20.3 示例

```json
{
  "event": "ModelSwitch",
  "from_model": "claude-sonnet-4-6",
  "to_model": "claude-haiku-4-5",
  "switch_reason": "fallback",
  "provider": "anthropic"
}
```

### 20.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向下一轮 LLM 注入模型切换说明（如"已切换至 haiku-4-5，能力减弱"） |
| `continue` | `false` 则中止切换（如检测到降级到不安全模型，回滚） |

---

## 21. ProviderErrorPayload

> **事件类别**：模型事件（4 之 2）
> **触发时机**：LLM provider 返回错误（5xx / 429 / timeout / auth_failed）后
> **事件源**：M1 LLMProvider（在 `callLLM()` 的 catch 块调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §9.2 + PRD mod-04 §4.2

### 21.1 建议 Schema

```typescript
export interface ProviderErrorPayload {
  event: 'ProviderError';
  provider: string;
  error_type: '5xx' | '429' | 'timeout' | 'auth_failed';
  error_message: string;
  retry_count: number;
  model: string;
}
```

### 21.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'ProviderError'` | 是 | 字面量 |
| `provider` | string | 是 | provider 名 |
| `error_type` | enum | 是 | 错误分类（`5xx`：服务器错误 / `429`：限流 / `timeout`：请求超时 / `auth_failed`：鉴权失败） |
| `error_message` | string | 是 | 错误消息原文（provider 返回的 `error.message`） |
| `retry_count` | number | 是 | 已重试次数（0 表示首次失败） |
| `model` | string | 是 | 失败时使用的模型 ID |

### 21.3 示例

```json
{
  "event": "ProviderError",
  "provider": "anthropic",
  "error_type": "429",
  "error_message": "Rate limit exceeded",
  "retry_count": 2,
  "model": "claude-sonnet-4-6"
}
```

### 21.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向下一轮 LLM 注入错误说明（如"provider 限流，已重试 2 次"） |
| `continue` | `false` 则中止重试（如检测到 auth_failed，阻止后续重试） |

---

## 22. FallbackTriggeredPayload

> **事件类别**：模型事件（4 之 3）
> **触发时机**：fallback 链触发（主模型连续失败后切到 fallback 模型）后
> **事件源**：M1 FallbackManager（在 `triggerFallback()` 方法末尾调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §9.3 + PRD mod-04 §4.2

### 22.1 建议 Schema

```typescript
export interface FallbackTriggeredPayload {
  event: 'FallbackTriggered';
  primary_model: string;
  fallback_model: string;
  trigger_reason: '5xx' | '429' | 'timeout' | 'auth_failed';
  retry_count: number;
  provider: string;
}
```

### 22.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'FallbackTriggered'` | 是 | 字面量 |
| `primary_model` | string | 是 | 主模型 ID |
| `fallback_model` | string | 是 | fallback 模型 ID |
| `trigger_reason` | enum | 是 | 触发原因（同 `ProviderErrorPayload.error_type`） |
| `retry_count` | number | 是 | 主模型失败次数（达到阈值后触发 fallback） |
| `provider` | string | 是 | provider 名（主与 fallback 通常同 provider） |

### 22.3 示例

```json
{
  "event": "FallbackTriggered",
  "primary_model": "claude-sonnet-4-6",
  "fallback_model": "claude-haiku-4-5",
  "trigger_reason": "429",
  "retry_count": 3,
  "provider": "anthropic"
}
```

### 22.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向下一轮 LLM 注入 fallback 说明（如"主模型限流，已切到 haiku-4-5"） |
| `continue` | `false` 则中止 fallback（如检测到 fallback 模型不安全，阻止切换） |

---

## 23. StallDetectedPayload

> **事件类别**：模型事件（4 之 4）
> **触发时机**：M2 stall 检测器发现 agent 停滞（passive: 无输出超时 / active: 输出但无工具调用循环）后
> **事件源**：M2 StallDetector（在 `detect()` 方法末尾调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §9.4 + PRD mod-04 §4.2

### 23.1 建议 Schema

```typescript
export interface StallDetectedPayload {
  event: 'StallDetected';
  stall_type: 'passive' | 'active';
  stall_duration_ms: number;
  agent_id: AgentId;
  session_id: SessionId;
}
```

### 23.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'StallDetected'` | 是 | 字面量 |
| `stall_type` | enum | 是 | 停滞类型（`passive`：无输出超时（默认 30s）/ `active`：有输出但无 tool_use 循环（默认 3 轮）） |
| `stall_duration_ms` | number | 是 | 停滞持续时长（passive: 从最后输出到现在的时长 / active: 循环开始到现在的时长） |
| `agent_id` | `AgentId` | 是 | 停滞的 agent ID |
| `session_id` | `SessionId` | 是 | 所属 session |

### 23.3 示例

```json
{
  "event": "StallDetected",
  "stall_type": "passive",
  "stall_duration_ms": 45000,
  "agent_id": "agent-main-001",
  "session_id": "sess-2026-07-09-001"
}
```

### 23.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向下一轮 LLM 注入停滞恢复提示（如"检测到停滞，请尝试不同方法"） |
| `continue` | `false` 则中止 agent（如连续 3 次 stall，强制停止） |

---

## 24. ShutdownPayload

> **事件类别**：系统事件（4 之 1）
> **触发时机**：系统关闭（用户 `/exit` / Crash / 预算超限）开始时
> **事件源**：M2 SessionManager（在 `shutdown()` 方法首行调用）
> **types.ts 状态**：✅ explicit（types.ts §13 `ShutdownPayload`）
> **引用**：types.ts §13 + mod-04-hook-matrix §10.1 + PRD mod-04 §4.2

### 24.1 Schema

```typescript
export interface ShutdownPayload {
  event: 'Shutdown';
  reason: 'user' | 'crash' | 'budget';
  session_id: SessionId;
}
```

### 24.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'Shutdown'` | 是 | 字面量 |
| `reason` | enum | 是 | 关闭原因（`user`：用户主动退出 / `crash`：未捕获异常触发关闭 / `budget`：预算超限触发关闭） |
| `session_id` | `SessionId` | 是 | 关闭的 session |

### 24.3 示例

```json
{
  "event": "Shutdown",
  "reason": "user",
  "session_id": "sess-2026-07-09-001"
}
```

### 24.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 忽略（lifecycle-end 事件，无下一轮注入） |
| `continue` | `false` 则中止后续 Hook 链（如 cleanup Hook 失败，跳过剩余 cleanup） |

> **注**：`Shutdown` 是 lifecycle-end 事件，`prompt` / `agent` 类型不支持，`http` 类型为 `△`（fire-and-forget，超时降至 2s，详见 mod-04-hook-matrix §3 矩阵行 24 + §10.1）。

---

## 25. CrashPayload

> **事件类别**：系统事件（4 之 2）
> **触发时机**：进程崩溃（`uncaughtException` / `SIGSEGV`）时
> **事件源**：OS 级信号处理器（`process.on('uncaughtException')` / `process.on('SIGTERM')`）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §10.2 + PRD mod-04 §4.2

### 25.1 建议 Schema

```typescript
export interface CrashPayload {
  event: 'Crash';
  error: string;
  stack: string;
  session_id: SessionId;
  agent_id?: AgentId;
}
```

### 25.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'Crash'` | 是 | 字面量 |
| `error` | string | 是 | 错误消息（`Error.message`） |
| `stack` | string | 是 | 调用栈（`Error.stack`） |
| `session_id` | `SessionId` | 是 | 崩溃时的 session |
| `agent_id` | `AgentId` | 否 | 崩溃时正在执行的 agent（可能未填充） |

### 25.3 示例

```json
{
  "event": "Crash",
  "error": "Cannot read property 'name' of undefined",
  "stack": "TypeError: Cannot read property 'name' of undefined\n    at Object.validateToolName (file:///...)",
  "session_id": "sess-2026-07-09-001",
  "agent_id": "agent-main-001"
}
```

### 25.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 忽略 |
| `continue` | 忽略 |

> **注**：`Crash` 事件 6 类型全 `−`（详见 mod-04-hook-matrix §3 矩阵行 25 + §10.2）。Crash 必须由 OS 级信号处理器捕获并写崩溃日志（`~/.omniagent/logs/crash-{timestamp}.log`），**不经过 Hook 系统**。本文档定义 schema 仅供崩溃日志格式参考，v2.x 评估通过独立 daemon 进程捕获 Crash 并触发 Hook。

---

## 26. BudgetExceededPayload

> **事件类别**：系统事件（4 之 3）
> **触发时机**：预算追踪器检测到超限（per-turn 或 total）后
> **事件源**：M2 BudgetTracker（在 `check()` 方法末尾，超限时调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §10.3 + PRD mod-04 §4.2

### 26.1 建议 Schema

```typescript
export interface BudgetExceededPayload {
  event: 'BudgetExceeded';
  budget_type: 'per_turn' | 'total';
  current_cost: number;
  budget_limit: number;
  exceeded_by: number;
}
```

### 26.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'BudgetExceeded'` | 是 | 字面量 |
| `budget_type` | enum | 是 | 预算类型（`per_turn`：单轮预算（默认 $1）/ `total`：session 总预算（默认 $10）） |
| `current_cost` | number | 是 | 当前花费（USD） |
| `budget_limit` | number | 是 | 预算上限（USD） |
| `exceeded_by` | number | 是 | 超出额度（`current_cost - budget_limit`，正数） |

### 26.3 示例

```json
{
  "event": "BudgetExceeded",
  "budget_type": "per_turn",
  "current_cost": 1.24,
  "budget_limit": 1.0,
  "exceeded_by": 0.24
}
```

### 26.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向下一轮 LLM 注入预算说明（如"本轮已超限 $0.24，请精简输出"） |
| `continue` | `false` 则中止 agent（强制 Shutdown，reason=`budget`） |

---

## 27. ScheduleTriggeredPayload

> **事件类别**：系统事件（4 之 4）
> **触发时机**：Cron 调度器触发预设 prompt 后
> **事件源**：M2 CronScheduler（在 `trigger()` 方法首行调用）
> **types.ts 状态**：🔸 Generic（建议 schema 见下）
> **引用**：types.ts §13 `GenericHookPayload` + mod-04-hook-matrix §10.4 + PRD mod-04 §4.2

### 27.1 建议 Schema

```typescript
export interface ScheduleTriggeredPayload {
  event: 'ScheduleTriggered';
  cron_id: string;
  cron_schedule: string;
  prompt: string;
  triggered_at: string;  // ISO 8601
}
```

### 27.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `'ScheduleTriggered'` | 是 | 字面量 |
| `cron_id` | string | 是 | Cron 任务 ID（用户在 `~/.omniagent/schedules.json` 定义） |
| `cron_schedule` | string | 是 | Cron 表达式（如 `0 9 * * 1-5`：工作日 9 点） |
| `prompt` | string | 是 | 触发的 prompt 原文 |
| `triggered_at` | string | 是 | 触发时间（ISO 8601，UTC） |

### 27.3 示例

```json
{
  "event": "ScheduleTriggered",
  "cron_id": "daily-standup-reminder",
  "cron_schedule": "0 9 * * 1-5",
  "prompt": "Check the daily standup notes and summarize blockers",
  "triggered_at": "2026-07-09T01:00:00.000Z"
}
```

### 27.4 Hook 可访问字段

| HookResponse 字段 | 改写效果 |
|------------------|---------|
| `permissionDecision` | 忽略 |
| `updatedInput` | 忽略 |
| `additionalContext` | 向首轮 LLM 注入调度说明（如"由 Cron 触发，任务 ID: daily-standup-reminder"） |
| `continue` | `false` 则中止触发（如检测到恶意 Cron，阻止执行） |

---

## A. 演进路径与开放问题

### A.1 Generic → Explicit 提升标准

20 个 Generic 事件在 v1.0 用 `GenericHookPayload`（`[key: string]: unknown`），本文档为它们建议 schema。提升为 explicit 的标准：

| 标准 | 阈值 |
|------|------|
| 字段使用频率 | ≥ 3 个独立 Hook 实现依赖某字段 |
| 审计需求 | 该事件进入 `AuditLogEntry`（mod-04 §4.5）且需结构化查询 |
| 跨 provider 一致性 | 字段在 OpenAI/Bedrock/Ollama 下含义一致 |
| 测试覆盖 | contract test 覆盖该事件 schema |

满足 ≥ 2 项则提升为 explicit（在 types.ts §13 补 `export interface XxxPayload`，加入 `HookPayload` 联合类型）。

### A.2 v2.x payload 扩展项

| 扩展项 | 描述 | 影响 |
|-------|------|------|
| Crash 事件支持 | v2.x 通过独立 daemon 捕获 Crash，schema 已定义（§25.1），需补 Hook 调度逻辑 | types.ts §13 `HookPayload` 联合加入 `CrashPayload` |
| 新增事件 | `ToolCallAborted`（abort 传播时）/ `McpReconnect`（MCP 重连）等 | 新增 §28+ schema |
| payload 字段版本化 | v2.x 评估加 `schema_version: number` 字段，支持向后兼容 | 全部 27 schema 加字段 |
| envelope 标准化 | v2.x 评估将 `timestamp` / `trace_id` 等从 envelope 提升为 payload 字段 | 全部 27 schema 加字段 |

### A.3 开放问题

| 问题 | 描述 | 状态 |
|------|------|------|
| `PostToolUsePayload` 缺 `agent_id` | 与 `PreToolUsePayload` 不一致（前者有 `agent_id` + `cwd`，后者无），是否补齐？ | 待 M3 开发阶段决定 |
| `AssistantResponsePayload` 缺 `agent_id` / `session_id` | 同上，LLM 输出可能来自 fork 子 agent，需补 `agent_id`？ | 待 M2 开发阶段决定 |
| `PermissionDenyPayload` 缺 `agent_id` | 同上 | 待 M4 开发阶段决定 |
| `ShutdownPayload` 缺 `agent_id` | Shutdown 可能由子 agent 触发，需补？ | 待 M2 开发阶段决定 |
| `CompactBoundaryPayload` 缺 `agent_id` / `session_id` | compact 可能由 fork 子 agent 触发 | 待 M7 开发阶段决定 |

> **决策**：v1.0 保持 types.ts §13 现有 7 类显式 schema 不变（已冻结），本文档建议 schema 的 20 个 Generic 事件在 M3 开发阶段实现 HookScheduler 时根据实际需求决定是否提升 explicit。

---

## B. 参考链接

### B.1 PRD 体系

- `omniagent-prd-mod-04-permission.md` §4.2（27 事件 + 6 类型 + HookResponse + 关键 payload 契约）
- `omniagent-prd-mod-04-hook-matrix.md`（27 × 6 = 162 格支持矩阵 + 每事件详目 §4-§10）
- `omniagent-prd-decisions.md` §A4（function 类型 v1.0 仅内置）

### B.2 L2 设计文档

- `omniagent-system-design.md` §3（跨模块类型契约）+ §7（可观测性：审计日志 schema）+ §11（里程碑交付物）

### B.3 L3 模块设计文档

- `l3-mod-04-permission.md` §2.2.9（HookScheduler）+ §2.2.10（HookExecutor）+ §2.2.11（CommandHookHandler）+ §2.2.12（FunctionHookHandler）+ §3.5（Hook 调度时序）+ §3.5.3（async hook）+ §3.5.4（递归深度）+ §3.9（DenialTracker）

### B.4 类型契约

- `omniagent-types.ts` §13（`HookEventName` / `HookType` / `HookPayload` / `HookResponse` / `Hook` + 7 类显式 payload + `GenericHookPayload`）

### B.5 关联前置文档

- `omniagent-prd-mod-03-tools-catalog.md`（M1 开工前已补全，60+ 工具清单，Hook 在 `PreToolUse` / `PostToolUse` 阶段拦截）
- `omniagent-eval/prompt-injection-shadow/`（M3 开工前补全 #4，≥ 50 条红队样本，`UserPromptSubmit` Hook 的检测规则集测试集）

### B.6 代码附件（M3 开发阶段产出）

- `src/m4/hook-payloads.ts`（27 个 payload interface 的 TypeScript 实现，从本文档 §1-§27 提升）
- `src/m4/hook-scheduler.ts`（HookScheduler 实现，含 envelope 元数据注入）
- `src/m4/hook-executor.ts`（HookExecutor 实现，含 6 类型分发）
- `test/m4/hook-payload-contract.test.ts`（27 payload schema 的 contract test）
