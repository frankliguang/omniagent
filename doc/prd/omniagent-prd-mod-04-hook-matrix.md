# OmniAgent CLI PRD mod-04 附件 A：Hook 27 事件 × 6 类型支持矩阵

> **文档级别**：PRD 附件（M3 开工前补全前置文档 #2，L2 §11 里程碑交付物清单）
>
> **状态**：草稿 → 评审 → 冻结
>
> **维护责任方**：安全工程师
>
> **依赖**：PRD mod-04 §4.2（已冻结）+ L3-M4 §3.5（已冻结）+ omniagent-types.ts §13（已冻结）

## 1. 文档定位与不重复原则

### 1.1 文档定位

PRD mod-04 §4.2 已定 Hook 中间件机制骨架（27 事件 × 6 类型 + HookResponse schema + 关键事件 payload 契约 + 防死循环 + async hook），但**显式将完整支持矩阵 defer 到本文档**：

> "**事件×类型矩阵**：27 事件 × 6 类型并非全自由组合，部分事件对类型有限制（如 `Crash` 事件不支持 `function` 类型，因进程已崩；`Shutdown` 事件不支持 `prompt` 类型，因无下一轮注入）。完整支持矩阵见 `omniagent-prd-mod-04-hook-matrix.md`（M3 开工前由安全工程师补全）。"

本文档补全 27 × 6 = 162 格支持矩阵，每格标注 `✓` / `△` / `−` + 约束理由 + 默认 HookResponse 语义 + 可改写字段 + sync/async 模式 + 超时默认 + DenialTracker 交互 + 测试要点。

### 1.2 不重复原则

以下内容已在引用文档中完整定义，本文档**不复制**，仅引用：

| 已有内容 | 引用源 | 本文档引用方式 |
|---------|-------|--------------|
| 27 事件名清单（按 7 大类别分组） | PRD mod-04 §4.2 + types.ts §13 `HookEventName` | §3 矩阵表按 7 类分组，引用 §4-§10 详目 |
| 6 类型名清单 + 语义 | PRD mod-04 §4.2 + types.ts §13 `HookType` | §2.2 公共规则引用 |
| `HookResponse` 4 字段 schema | types.ts §13 | §2.6 默认值与可改写字段引用 |
| `Hook` 定义（event/type/target/async/timeoutMs） | types.ts §13 | §2.5 链顺序引用 |
| `HookPayload` 联合类型（7 类显式 + Generic） | types.ts §13 | §4-§10 每事件 payload 字段引用 |
| `HookScheduler` 调度逻辑 + 防死循环 maxConsecutive=3 / maxTotal=20 | L3-M4 §2.2.9 + §3.5.3 | §2.7 DenialTracker 交互引用 |
| `HookExecutor` 6 类型分发 | L3-M4 §2.2.10 + §3.5.2 | §2.2 公共规则引用 |
| 6 类型 Handler 代码骨架（Command/Prompt/Agent/Http/Callback/Function） | L3-M4 §2.2.11 + §2.2.12（已给 Command + Function 骨架，其余 4 个 L3-M4 标注"代码骨架同模式"） | §4-§10 每事件"6 类型支持"引用 |
| function 类型 v1.0 仅内置（决策 A4） | PRD mod-04 §4.2 + §8.1 A4 + omniagent-prd-decisions.md §A4 | §2.2 公共规则 + §12 不变量 N2 |
| async hook 首行 `{"async":true}` 检测 + asyncRewake 退出码 2 | PRD mod-04 §4.2 + L3-M4 §3.5.4 | §2.4 sync/async 模式引用 |
| 7 类显式 payload schema（PreToolUse/PostToolUse/CompactBoundary/UserPromptSubmit/AssistantResponse/PermissionDeny/Shutdown） | types.ts §13 | §4-§10 每事件"payload 引用"指向 mod-04-hook-payloads.md（M3 开工前补全 #3） |
| 其余 20 事件 payload（GenericHookPayload） | types.ts §13 `GenericHookPayload` | §4-§10 每事件"payload 引用"标注"Generic" |
| 审计日志 `AuditLogEntry` schema + 失败兜底 | L3-M4 §2.2.19 + §3.8 + types.ts §19 | §11 测试用例引用 |

### 1.3 引用文档清单

- **PRD mod-04 §4.2**：Hook 中间件机制（27 事件 + 6 类型 + HookResponse schema + 关键事件 payload + 防死循环 + async hook）
- **PRD mod-04 §4.1**：DenialTracking 语义统一（K19：两上下文机制同名行为不同）
- **PRD mod-04 §8.1 A4**：Hooks function 边界（v1.0 仅内置）
- **L3-M4 §2.2.9**：`HookScheduler` 代码骨架
- **L3-M4 §2.2.10**：`HookExecutor` 6 类型分发
- **L3-M4 §2.2.11**：`CommandHookHandler` 代码骨架
- **L3-M4 §2.2.12**：`FunctionHookHandler` 代码骨架 + `BUILTIN_FUNCTIONS` 白名单
- **L3-M4 §3.5**：Hook 中间件 27 事件 × 6 类型（引用 PRD §4.2）
- **L3-M4 §3.5.3**：防死循环（DenialTracker hooks 上下文，maxConsecutive=3 / maxTotal=20，degrade_to_ask）
- **L3-M4 §3.5.4**：async hook（首行 `{"async":true}` 检测，asyncRewake 退出码 2）
- **L3-M4 §3.9**：DenialTracker 双上下文统一（risk_classifier / hooks 均统一 degrade_to_ask，自审 C7 修正原 bypass_with_warning fail-OPEN）
- **types.ts §13**：`HookEventName` / `HookType` / `HookPayload` / `HookResponse` / `Hook` / 7 类显式 payload + `GenericHookPayload`
- **types.ts §19**：`AuditLogEntry`
- **mod-04-hook-payloads.md**（M3 开工前补全 #3）：27 事件完整 payload schema

## 2. 矩阵标记与公共规则

### 2.1 标记说明

矩阵每格使用三态标记：

| 标记 | 含义 | 注册行为 | 测试要求 |
|------|------|---------|---------|
| `✓` | 完全支持 | 注册成功，按 HookResponse 语义执行 | ≥ 1 正向测试 + ≥ 1 crash 测试 |
| `△` | 有限支持 | 注册成功，但有约束（递归深度 / 异步风险 / 仅信息性等） | ≥ 1 约束测试 |
| `−` | 不支持 | 注册时 reject（`HookRegistry.register()` 抛 `HOOK_TYPE_NOT_SUPPORTED`） | ≥ 1 拒绝测试 |

### 2.2 公共规则（适用所有 162 格）

以下规则**逐格适用**，§4-§10 详目不重复说明，仅在例外格标注：

1. **function 类型 v1.0 仅内置**（决策 A4）：所有 27 事件的 `function` 类型格在 v1.0 仅支持 `FunctionHookHandler.BUILTIN_FUNCTIONS` 白名单（L3-M4 §2.2.12 已给 `execCommandHook` / `logAuditHook` 2 个内置函数）。用户配置文件中 `type: function` 注册请求一律 reject（返回 `HOOK_FUNCTION_USER_CONFIG_REJECTED`，fail-closed）。
2. **Hook 链按注册顺序执行**：`HookRegistry.listByEvent(eventName)` 返回按注册顺序排序的 Hook 数组，`HookScheduler.schedule()` 顺序执行，遇 `response.continue === false` 终止后续 Hook。
3. **HookResponse.permissionDecision 默认 `allow`**：Hook 未显式返回时默认 `allow`；Hook 可改写为 `deny` / `ask`。**仅 `PreToolUse` 事件的 permissionDecision 生效**（影响工具是否执行）；其余 26 事件的 permissionDecision 字段被忽略（事件已发生或与工具无关）。
4. **HookResponse.updatedInput 仅 `PreToolUse` 生效**：Hook 可改写工具输入；其余 26 事件的 updatedInput 字段被忽略（工具已执行或与工具无关）。
5. **HookResponse.additionalContext 所有事件生效**：注入到下一轮上下文（经 M7 `SystemPromptBuilder` priority=4 'custom' 层，与 Skills inline 模式同层）。例外：`Shutdown` / `Crash` / `AgentStop` / `SubagentExit` / `SessionEnd` 事件的 additionalContext 被忽略（无下一轮注入）。
6. **HookResponse.continue 所有事件生效**：`false` 时终止后续 Hook 链。
7. **Hook crash → fail-closed deny**（PRD mod-04 §3.1 N5）：`HookExecutor.execute()` 抛异常时 `HookScheduler` 捕获，记入 DenialTracker，返回 `{ continue: false, permissionDecision: 'deny' }`。
8. **Hook 超时 → fail-closed deny**：超过 `hook.timeoutMs` 时同 crash 处理。
9. **DenialTracker hooks 上下文触发后 degrade_to_ask**（自审 C7 修正）：`maxConsecutive=3` / `maxTotal=20`，达上限后 `HookScheduler.schedule()` 立即返回 `{ continue: false, permissionDecision: 'ask' }`，不再执行后续 Hook。
10. **Hook 不可跨事件注册**：一个 `Hook` 实例的 `event` 字段在注册时绑定，不可变；同一 Hook 实例不可注册到多个事件。
11. **Hook 不可跨类型注册**：`type` 字段同样注册时绑定不可变。
12. **async hook 仅 `command` / `http` / `agent` 类型支持**：`prompt` / `callback` / `function` 类型是同步的，async 字段被忽略。

### 2.3 超时默认值

`Hook.timeoutMs` 未显式配置时按类型取默认值（L3-M4 §2.2.11 `CommandHookHandler` 已给 `5s` 默认，其余 5 类型同模式）：

| 类型 | 默认超时 | 理由 |
|------|---------|------|
| `command` | 5000ms（5s） | shell 命令通常 < 1s，5s 覆盖 99 分位 |
| `prompt` | 1000ms（1s） | 注入是字符串拼接，< 10ms，1s 兜底 |
| `agent` | 60000ms（60s） | 子 agent 跑一轮 ReAct，M2 单轮预算 30s，60s 兜底 |
| `http` | 10000ms（10s） | HTTP 请求通常 < 3s，10s 覆盖慢端点 |
| `callback` | 5000ms（5s） | 内置回调通常 < 100ms，5s 兜底 |
| `function` | 5000ms（5s） | 内置函数通常 < 100ms，5s 兜底 |

超时阈值可通过 `OMNIAGENT_HOOK_TIMEOUT_OVERRIDE_MS` 环境变量全局覆盖（仅 root 用户 / 容器内可设，普通用户配置文件中 `timeoutMs` 字段上限 60000ms，超过则 clamp + 告警）。

### 2.4 sync/async 模式

| 类型 | 默认 | async 支持 | async 检测机制 |
|------|------|-----------|--------------|
| `command` | sync | ✓ | stdout 首行 `{"async":true}` 检测（L3-M4 §2.2.11 step 3） |
| `prompt` | sync | − | 注入是同步操作 |
| `agent` | sync | ✓ | 子 agent 通过 `asyncRewake` 退出码 2 标记（M5 agent_router 协议） |
| `http` | sync | ✓ | HTTP 响应 body 首行 `{"async":true}` 检测 |
| `callback` | sync | − | 内置回调是同步函数 |
| `function` | sync | − | 内置函数是同步函数（v1.0） |

async hook 结果在下一轮 `UserPromptSubmit` 事件前注入（经 M7 `SystemPromptBuilder` priority=4 'custom' 层），与同步 additionalContext 同层。

### 2.5 Hook 链顺序与 continue 语义

`HookScheduler.schedule()` 流程（L3-M4 §2.2.9 已给代码骨架）：

1. `registry.listByEvent(eventName)` 返回按注册顺序排序的 Hook 数组（注册时 `push`，不重排）。
2. 数组为空 → 返回 `{ continue: true, permissionDecision: 'allow' }`。
3. 顺序执行每个 Hook：
   - DenialTracker 检查（shouldTrigger）→ 触发则返回 `{ continue: false, permissionDecision: 'ask' }`。
   - `executor.execute(hook, payload, ctx)` 调度到对应 Handler。
   - `response.permissionDecision === 'deny'` → `denialTracker.record()`。
   - `response.continue === false` → break，返回 lastResponse。
   - Handler 抛异常 → `denialTracker.record({ reason: 'hook crash' })` + 返回 `{ continue: false, permissionDecision: 'deny' }`。
4. 全部 Hook 执行完 → 返回 lastResponse。

**continue 语义边界**：

- `continue: true`：继续执行后续 Hook（默认值，Hook 未显式返回时取此值）。
- `continue: false`：终止后续 Hook，lastResponse 作为最终响应返回给事件源。
- continue 字段不可被后续 Hook 改写（每 Hook 独立返回，scheduler 决定是否 break）。

### 2.6 HookResponse 默认值与可改写字段

| HookResponse 字段 | 默认值 | 可改写事件 | 改写效果 |
|------------------|-------|-----------|---------|
| `permissionDecision` | `'allow'` | 仅 `PreToolUse` | Hook 返回 `deny` → 工具不执行；`ask` → 触发权限弹窗 |
| `updatedInput` | `undefined` | 仅 `PreToolUse` | Hook 返回的 input 替换原 input，传入工具 |
| `additionalContext` | `undefined` | 24 事件（除 `Shutdown` / `Crash` / `AgentStop` / `SubagentExit` / `SessionEnd` / ... 例外见 §2.2 规则 5） | 注入下一轮上下文 |
| `continue` | `true` | 全部 27 事件 | `false` 终止后续 Hook 链 |

**字段忽略矩阵**（27 事件 × 4 字段，标注 `✓` 生效 / `−` 忽略）：

| 事件类别 | permissionDecision | updatedInput | additionalContext | continue |
|---------|-------------------|--------------|-------------------|---------|
| 工具事件（PreToolUse） | ✓ | ✓ | ✓ | ✓ |
| 工具事件（PostToolUse / ToolError / ToolResultFiltered / ToolPoolChanged） | − | − | ✓ | ✓ |
| Agent 事件（AgentStart / SubagentSpawn） | − | − | ✓ | ✓ |
| Agent 事件（AgentStop / SubagentExit） | − | − | − | ✓ |
| 会话事件（SessionStart / CompactBoundary / Resume） | − | − | ✓ | ✓ |
| 会话事件（SessionEnd） | − | − | − | ✓ |
| 消息事件（UserPromptSubmit / AssistantResponse） | − | − | ✓ | ✓ |
| 权限事件（4 个） | − | − | ✓ | ✓ |
| 模型事件（4 个） | − | − | ✓ | ✓ |
| 系统事件（Shutdown / Crash） | − | − | − | ✓ |
| 系统事件（BudgetExceeded / ScheduleTriggered） | − | − | ✓ | ✓ |

### 2.7 DenialTracker 交互

`HookScheduler` 与 `DenialTrackerImpl`（hooks 上下文）的交互（L3-M4 §2.2.9 + §3.9 已给代码骨架）：

1. **每次 Hook deny → `denialTracker.record()`**：`response.permissionDecision === 'deny'` 时记录一条 denial。
2. **每次 Hook crash → `denialTracker.record()`**：Handler 抛异常时记录一条 denial（reason: `hook crash: ${err.message}`）。
3. **每次 Hook 超时 → `denialTracker.record()`**：超时同样记一条 denial（reason: `hook timeout`）。
4. **`shouldTrigger()` 触发条件**：`maxConsecutive >= 3`（连续 3 次 denial）或 `maxTotal >= 20`（本 turn 累计 20 次 denial）。
5. **触发后动作**：立即返回 `{ continue: false, permissionDecision: 'ask' }`，**不再执行后续 Hook**（fail-closed degrade_to_ask，自审 C7 修正原 bypass_with_warning fail-OPEN）。
6. **审计日志区分**：每条 denial 记录 `context=hooks` 字段，与 risk_classifier 上下文的 denial 区分（L3-M4 §3.9.2）。
7. **重置时机**：每个 `UserPromptSubmit` 事件触发时重置 `maxConsecutive` 计数（不重置 `maxTotal`）。

## 3. 完整 27 × 6 矩阵表

下表为 27 事件 × 6 类型的支持矩阵汇总。每格标记 `✓` / `△` / `−`，详细理由见 §4-§10 对应详目。

| # | 事件 | command | prompt | agent | http | callback | function | 例外理由（若非全 ✓） |
|---|------|---------|--------|-------|------|---------|---------|---------------------|
| 1 | `PreToolUse` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 2 | `PostToolUse` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 3 | `ToolError` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 4 | `ToolResultFiltered` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§4.4） |
| 5 | `ToolPoolChanged` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§4.5） |
| 6 | `AgentStart` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§5.1） |
| 7 | `AgentStop` | ✓ | − | − | ✓ | ✓ | ✓ | 无下一轮注入 + agent 已停止（§5.2） |
| 8 | `SubagentSpawn` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§5.3） |
| 9 | `SubagentExit` | ✓ | − | − | ✓ | ✓ | ✓ | 无下一轮注入 + 父 agent 可能已退出（§5.4） |
| 10 | `SessionStart` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§6.1） |
| 11 | `SessionEnd` | ✓ | − | − | ✓ | ✓ | ✓ | 无下一轮注入 + 会话已结束（§6.2） |
| 12 | `CompactBoundary` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 13 | `Resume` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§6.4） |
| 14 | `UserPromptSubmit` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 15 | `AssistantResponse` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 16 | `PermissionDeny` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§8.1） |
| 17 | `PermissionAllow` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§8.2） |
| 18 | `PermissionAsk` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§8.3） |
| 19 | `PermissionEscalation` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§8.4） |
| 20 | `ModelSwitch` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§9.1） |
| 21 | `ProviderError` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§9.2） |
| 22 | `FallbackTriggered` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§9.3） |
| 23 | `StallDetected` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§9.4） |
| 24 | `Shutdown` | ✓ | − | − | △ | ✓ | ✓ | 无下一轮注入 + agent 不可 spawn + http 风险（§10.1） |
| 25 | `Crash` | − | − | − | − | − | − | 进程已崩，Hook 系统不可用（§10.2） |
| 26 | `BudgetExceeded` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§10.3） |
| 27 | `ScheduleTriggered` | ✓ | ✓ | △ | ✓ | ✓ | ✓ | agent 递归风险（§10.4） |

**矩阵汇总统计**：

| 标记 | 格数 | 占比 |
|------|------|------|
| `✓` 完全支持 | 131 | 80.9% |
| `△` 有限支持 | 17 | 10.5% |
| `−` 不支持 | 14 | 8.6% |
| **合计** | **162** | **100%** |

**`−` 不支持格明细**（14 格）：

| 事件 | 类型 | 理由 |
|------|------|------|
| `AgentStop` | prompt | 无下一轮注入（agent 已停止） |
| `AgentStop` | agent | 不可 spawn（agent 已停止） |
| `SubagentExit` | prompt | 无下一轮注入（subagent 已退出） |
| `SubagentExit` | agent | 不可 spawn（父 agent 可能已退出） |
| `SessionEnd` | prompt | 无下一轮注入（会话已结束） |
| `SessionEnd` | agent | 不可 spawn（会话已结束） |
| `Shutdown` | prompt | 无下一轮注入（进程关闭中） |
| `Shutdown` | agent | 不可 spawn（进程关闭中） |
| `Crash` | command | 进程已崩，shell 不可执行 |
| `Crash` | prompt | 进程已崩，无下一轮注入 |
| `Crash` | agent | 进程已崩，不可 spawn |
| `Crash` | http | 进程已崩，HTTP 不可发 |
| `Crash` | callback | 进程已崩，JS 运行时不可用 |
| `Crash` | function | 进程已崩，JS 运行时不可用 |

> 注：Crash 事件 6 类型全 `−`，Crash 必须由 OS 级信号处理器（`process.on('SIGINT' / 'SIGTERM' / 'uncaughtException')`）捕获并写崩溃日志，不经过 Hook 系统。

**`△` 有限支持格明细**（17 格）：

| 模式 | 格数 | 约束 |
|------|------|------|
| `agent` 类型递归风险 | 16 | `ToolResultFiltered` / `ToolPoolChanged` / `AgentStart` / `SubagentSpawn` / `SessionStart` / `Resume` / 4 个权限事件（`PermissionDeny` / `PermissionAllow` / `PermissionAsk` / `PermissionEscalation`）/ 4 个模型事件（`ModelSwitch` / `ProviderError` / `FallbackTriggered` / `StallDetected`）/ `BudgetExceeded` / `ScheduleTriggered` 等 16 个事件的 `agent` 类型格，递归深度上限 2（防 agent 无限 spawn） |
| `Shutdown` × `http` | 1 | HTTP 请求可能未完成即退出，仅适合"尽力通知"语义（fire-and-forget，不等待响应，超时降至 2s） |

## 4. 工具事件（5）详目

工具事件由 M2 `ReActLoop` 在工具调用生命周期触发。事件源：M2 `FSMController`。

### 4.1 `PreToolUse`

**触发时机**（PRD §4.2）：工具调用前，五层拦截链 Layer 1-4 通过后、Layer 5 Hooks 调度时。

**事件源**：M2 `FSMController` 进入 `TOOL_EXECUTE` 状态前。

**payload 引用**：types.ts §13 `PreToolUsePayload`（`tool_name` / `input` / `agent_id` / `cwd`），完整 schema 见 mod-04-hook-payloads.md §1。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` | ✓ | 解析 stdout 为 HookResponse JSON，可改写 `permissionDecision` + `updatedInput` |
| `prompt` | ✓ | 注入 "PreToolUse hook 触发" 上下文到下一轮 |
| `agent` | ✓ | spawn 子 agent 决策是否放行（递归深度 +1，上限 2） |
| `http` | ✓ | POST payload 到外部端点，解析响应为 HookResponse |
| `callback` | ✓ | 内置回调函数决策 |
| `function` | ✓ | v1.0 仅 `execCommandHook` / `logAuditHook` 2 个内置函数 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`。

**可改写字段**：`permissionDecision`（`allow` / `deny` / `ask`）+ `updatedInput`（替换工具 input）+ `additionalContext`（注入下一轮）+ `continue`（终止后续 Hook）。

**sync/async 模式**：默认 sync（在 `TOOL_EXECUTE` 前阻塞）；async hook 在下一轮注入 additionalContext（不影响本次工具执行）。

**超时默认**：command 5s / prompt 1s / agent 60s / http 10s / callback 5s / function 5s。

**DenialTracker 交互**：Hook 返回 `deny` → `record()`；Hook crash → `record()`；触发 `shouldTrigger()` → 返回 `{ continue: false, permissionDecision: 'ask' }`（degrade_to_ask）。

**测试要点**：

- 正向：command hook 返回 `{ permissionDecision: 'deny' }` → 工具不执行（断言 `TOOL_EXECUTE` 状态不进入）。
- 正向：command hook 返回 `{ updatedInput: { ... } }` → 工具收到改写后的 input。
- 正向：agent hook spawn 子 agent 决策 → 递归深度从 0 增到 1。
- crash：command hook 抛异常 → fail-closed deny + `record()` + 审计日志 `context=hooks`。
- 超时：command hook 超过 5s → fail-closed deny。
- async：command hook stdout 首行 `{"async":true}` → 本次放行 + 下一轮注入 additionalContext。
- 链顺序：3 个 hook 按 [A, B, C] 顺序注册，B 返回 `continue: false` → C 不执行。
- function：用户配置 `type: function` → reject `HOOK_FUNCTION_USER_CONFIG_REJECTED`。

**依赖**：M2 `FSMController`（事件源）+ M3 `ToolPool`（工具 input 校验）+ M7 `SystemPromptBuilder`（additionalContext 注入）+ M5 `agent_router`（agent 类型 spawn）+ L3-M4 `HookScheduler` / `HookExecutor` / 6 Handler。

### 4.2 `PostToolUse`

**触发时机**（PRD §4.2）：工具调用后，结果返回 M2 前。

**事件源**：M2 `FSMController` 退出 `TOOL_EXECUTE` 状态后。

**payload 引用**：types.ts §13 `PostToolUsePayload`（`tool_name` / `input` / `result` / `duration_ms`），完整 schema 见 mod-04-hook-payloads.md §2。

**6 类型支持**：全 `✓`（同 §4.1，但 `updatedInput` 字段被忽略——工具已执行）。

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision 字段被忽略）。

**可改写字段**：`additionalContext`（注入下一轮）+ `continue`（终止后续 Hook）。**`permissionDecision` + `updatedInput` 字段被忽略**（工具已执行，不可改写）。

**sync/async 模式**：默认 sync；async hook 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：Hook 返回 `deny` 时 `record()`（但 deny 不影响已执行的工具，仅记入 DenialTracker 计数）。

**测试要点**：

- 正向：command hook 收到 `result` 字段 → 解析 `result.is_error` 决策 additionalContext。
- 字段忽略：hook 返回 `{ updatedInput: { ... } }` → 字段被忽略（断言工具 input 未变）。
- crash：同 §4.1。

**依赖**：同 §4.1（除 M3 `ToolPool` input 校验外）。

### 4.3 `ToolError`

**触发时机**（PRD §4.2）：工具异常（`ToolError` 抛出或 `result.is_error === true` 且 error_type 不可恢复）。

**事件源**：M2 `FSMController` 捕获工具异常后。

**payload 引用**：types.ts §13 `GenericHookPayload`（未显式定义，用 Generic），完整 schema 见 mod-04-hook-payloads.md §3（建议字段：`tool_name` / `input` / `error` / `error_type`）。

**6 类型支持**：全 `✓`（同 §4.2，`updatedInput` 被忽略）。

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：同 §4.2。

**测试要点**：

- 正向：command hook 收到 `error` 字段 → 注入 "工具异常，建议重试或换路径" additionalContext。
- 字段忽略：hook 返回 `{ permissionDecision: 'deny' }` → 字段被忽略（工具已异常，不可改写）。

**依赖**：同 §4.2。

### 4.4 `ToolResultFiltered`

**触发时机**（PRD §4.2）：工具结果被压缩或过滤（M7 `COMPACTABLE_TOOLS` 白名单内的工具结果在 autocompact 时被过滤）。

**事件源**：M7 `AutoCompactChecker` 触发压缩后。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §4（建议字段：`tool_name` / `original_size` / `filtered_size` / `filter_strategy`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | 信息性事件，Hook 可注入 additionalContext 提示用户结果被过滤 |
| `agent` | △ | 递归风险：压缩后立即 spawn 子 agent 可能再次触发压缩。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：同 §4.2。

**测试要点**：

- 正向：command hook 收到 `filter_strategy` 字段 → 注入 "工具结果已压缩，原 size=X，压后 size=Y" additionalContext。
- agent 递归：agent hook spawn 子 agent → 递归深度从 0 增到 1；递归深度 2 时拒绝再 spawn（返回 `{ continue: true, permissionDecision: 'allow' }` 放行）。
- crash：同 §4.1。

**依赖**：M7 `AutoCompactChecker`（事件源）+ 其余同 §4.2。

### 4.5 `ToolPoolChanged`

**触发时机**（PRD §4.2）：工具池变化（MCP 连接 / 断开，Skills 热加载 / 卸载，Custom Agent 装载 / 卸载）。

**事件源**：M3 `ToolPool`（写时复制后触发）+ M3 `MCPClient`（连接 / 断开）+ M6 `SkillHotReloader`（chokidar watch 触发）。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §5（建议字段：`change_type`：'add' / 'remove' / 'reload' / `tool_name` / `source`：'mcp' / 'skill' / 'custom_agent'）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | 信息性事件，Hook 可注入 additionalContext 提示工具池变化 |
| `agent` | △ | 递归风险：子 agent 可能再次触发 ToolPoolChanged（如装载新 Skill）。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：同 §4.2。

**测试要点**：

- 正向：MCP 连接 → command hook 收到 `{ change_type: 'add', source: 'mcp', tool_name: 'mcp_foo' }` payload。
- agent 递归：agent hook spawn 子 agent → 子 agent 装载 Skill → 再次触发 ToolPoolChanged → 递归深度从 1 增到 2 → 拒绝再 spawn。
- crash：同 §4.1。

**依赖**：M3 `ToolPool` + `MCPClient`（事件源）+ M6 `SkillHotReloader`（事件源）+ 其余同 §4.2。

## 5. Agent 事件（4）详目

Agent 事件由 M2 `ReActLoop` 与 M5 `Orchestrator` 协同触发。事件源：M2（AgentStart / AgentStop）+ M5（SubagentSpawn / SubagentExit）。

### 5.1 `AgentStart`

**触发时机**（PRD §4.2）：Agent 生命周期开始（M2 `ReActLoop` 进入 `BUILD_CONTEXT` 状态前）。

**事件源**：M2 `ReActLoop` 启动时 / M5 `Orchestrator.route` 返回新 agent 时。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §6（建议字段：`agent_id` / `agent_type`：'main' / 'coordinator' / 'worker' / 'teammate' / 'fork' / `parent_agent_id` / `session_id`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 初始化 agent |
| `agent` | △ | 递归风险：spawn 子 agent 处理 AgentStart 可能无限递归。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：同 §4.2。

**测试要点**：

- 正向：main agent 启动 → command hook 收到 `{ agent_type: 'main' }` payload → 注入 "main agent started" additionalContext。
- coordinator agent 启动 → command hook 收到 `{ agent_type: 'coordinator', parent_agent_id: 'a1' }` payload。
- agent 递归：agent hook spawn 子 agent → 子 agent AgentStart → 递归深度从 1 增到 2 → 拒绝再 spawn。
- crash：同 §4.1。

**依赖**：M2 `ReActLoop`（事件源）+ M5 `Orchestrator`（事件源）+ 其余同 §4.2。

### 5.2 `AgentStop`

**触发时机**（PRD §4.2）：Agent 生命周期结束（M2 `TerminationHandler` 触发后）。

**事件源**：M2 `TerminationHandler` / M5 `Orchestrator` 子 agent 退出时。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §7（建议字段：`agent_id` / `agent_type` / `stop_reason`：'completed' / 'aborted' / 'error' / 'budget_exceeded' / `duration_ms`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` | ✓ | shell 命令在 agent 退出前执行 |
| `prompt` | − | 无下一轮注入（agent 已停止，additionalContext 无目标） |
| `agent` | − | 不可 spawn（agent 已停止，M5 `Orchestrator` 拒绝新 spawn） |
| `http` | ✓ | 通知外部端点 agent 已退出 |
| `callback` | ✓ | 内置回调清理资源 |
| `function` | ✓ | v1.0 仅内置函数 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput + additionalContext 全部被忽略——无下一轮注入）。

**可改写字段**：仅 `continue`（终止后续 Hook 链）。

**sync/async 模式**：默认 sync；async 不支持（无下一轮注入，async 字段被忽略）。

**超时默认**：同 §4.1，但 agent 类型格不可用。

**DenialTracker 交互**：Hook deny 仍 `record()`（计入 DenialTracker），但不影响 agent 退出流程。

**测试要点**：

- 正向：command hook 收到 `{ stop_reason: 'completed' }` payload → 写审计日志。
- prompt 拒绝：用户配置 `event: AgentStop, type: prompt` → `HookRegistry.register()` reject `HOOK_TYPE_NOT_SUPPORTED`。
- agent 拒绝：用户配置 `event: AgentStop, type: agent` → reject。
- additionalContext 忽略：hook 返回 `{ additionalContext: '...' }` → 字段被忽略（无下一轮）。
- crash：同 §4.1。

**依赖**：M2 `TerminationHandler`（事件源）+ M5 `Orchestrator`（事件源）+ 其余同 §4.2。

### 5.3 `SubagentSpawn`

**触发时机**（PRD §4.2）：子 agent spawn（M5 `Orchestrator.route` 返回 `fork` / `teammate` / `remote` 路径）。

**事件源**：M5 `Orchestrator.route` 调用 `ForkAgentSpawner` / `SwarmTeam` / `RemoteAgentClient` 时。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §8（建议字段：`parent_agent_id` / `child_agent_id` / `route`：'fork' / 'teammate' / 'remote' / `prompt` / `tools_whitelist`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可改写 `tools_whitelist`（updatedInput 字段，注意：updatedInput 仅 PreToolUse 生效——SubagentSpawn 不是工具调用，故 updatedInput 仍被忽略；改写 tools_whitelist 须用 additionalContext 提示 M5） |
| `agent` | △ | 递归风险：spawn 子 agent 处理 SubagentSpawn 可能无限递归。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略——SubagentSpawn 不是工具调用）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在子 agent 下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：同 §4.2。

**测试要点**：

- 正向：fork 路径 → command hook 收到 `{ route: 'fork', parent_agent_id: 'a1', child_agent_id: 'a2' }` payload。
- 字段忽略：hook 返回 `{ updatedInput: { tools_whitelist: ['Read'] } }` → 字段被忽略（updatedInput 仅 PreToolUse 生效）。
- agent 递归：agent hook spawn 子 agent → 子 agent SubagentSpawn → 递归深度从 1 增到 2 → 拒绝再 spawn。
- crash：同 §4.1。

**依赖**：M5 `Orchestrator` + `ForkAgentSpawner` / `SwarmTeam` / `RemoteAgentClient`（事件源）+ 其余同 §4.2。

### 5.4 `SubagentExit`

**触发时机**（PRD §4.2）：子 agent 退出（M5 `Orchestrator` 收到子 agent 终止信号）。

**事件源**：M5 `Orchestrator` 子 agent `TerminationHandler` 触发时。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §9（建议字段：`parent_agent_id` / `child_agent_id` / `exit_reason`：'completed' / 'aborted' / 'error' / `duration_ms`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` | ✓ | shell 命令在子 agent 退出后执行 |
| `prompt` | − | 无下一轮注入（子 agent 已退出；父 agent 可能继续，但 additionalContext 目标不明） |
| `agent` | − | 不可 spawn（父 agent 可能已退出，spawn 不可达） |
| `http` | ✓ | 通知外部端点 |
| `callback` | ✓ | 内置回调清理资源 |
| `function` | ✓ | v1.0 仅内置函数 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput + additionalContext 被忽略）。

**可改写字段**：仅 `continue`。

**sync/async 模式**：默认 sync；async 不支持。

**超时默认**：同 §4.1，但 agent 类型格不可用。

**DenialTracker 交互**：同 §5.2。

**测试要点**：

- 正向：fork 子 agent 退出 → command hook 收到 `{ exit_reason: 'completed' }` payload → 写审计日志。
- prompt 拒绝：用户配置 `event: SubagentExit, type: prompt` → reject。
- agent 拒绝：同上。
- additionalContext 忽略：同 §5.2。
- crash：同 §4.1。

**依赖**：M5 `Orchestrator`（事件源）+ 其余同 §4.2。

## 6. 会话事件（4）详目

会话事件由 M7 `SessionManager` 与 M2 `ReActLoop` 协同触发。事件源：M7（SessionStart / SessionEnd / Resume / CompactBoundary）。

### 6.1 `SessionStart`

**触发时机**（PRD §4.2）：会话开始（M7 `SessionManager.createNewSession()` 调用后）。

**事件源**：M7 `SessionManager`。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §10（建议字段：`session_id` / `cwd` / `user` / `permission_mode`：'default' / 'acceptEdits' / 'plan' / 'bypassPermissions' / 'auto' / 'dontAsk'）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 初始化会话 |
| `agent` | △ | 递归风险：spawn 子 agent 处理 SessionStart 可能触发 AgentStart → 递归。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在第一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：DenialTracker 计数在 SessionStart 时重置（`maxConsecutive = 0`，`maxTotal = 0`）。

**测试要点**：

- 正向：新会话启动 → command hook 收到 `{ session_id: 's1', permission_mode: 'default' }` payload → 注入 "session started" additionalContext。
- DenialTracker 重置：前一会话 DenialTracker 触发后，新会话 SessionStart → 计数归零。
- agent 递归：同 §5.1。
- crash：同 §4.1。

**依赖**：M7 `SessionManager`（事件源）+ 其余同 §4.2。

### 6.2 `SessionEnd`

**触发时机**（PRD §4.2）：会话结束（用户 `/exit` 命令 / `SIGINT` / 预算耗尽 / `Shutdown` 事件前）。

**事件源**：M7 `SessionManager.endSession()`。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §11（建议字段：`session_id` / `end_reason`：'user_exit' / 'sigint' / 'budget_exceeded' / 'shutdown' / `duration_ms` / `turns_count`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` | ✓ | shell 命令在会话结束前执行 |
| `prompt` | − | 无下一轮注入（会话已结束） |
| `agent` | − | 不可 spawn（会话已结束） |
| `http` | ✓ | 通知外部端点 |
| `callback` | ✓ | 内置回调清理资源 |
| `function` | ✓ | v1.0 仅内置函数 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput + additionalContext 被忽略）。

**可改写字段**：仅 `continue`。

**sync/async 模式**：默认 sync；async 不支持。

**超时默认**：同 §4.1，但 agent 类型格不可用。

**DenialTracker 交互**：Hook deny 仍 `record()`，但不影响会话结束。

**测试要点**：

- 正向：用户 `/exit` → command hook 收到 `{ end_reason: 'user_exit' }` payload → 写审计日志。
- prompt 拒绝：用户配置 `event: SessionEnd, type: prompt` → reject。
- agent 拒绝：同上。
- additionalContext 忽略：同 §5.2。
- crash：同 §4.1。

**依赖**：M7 `SessionManager`（事件源）+ 其余同 §4.2。

### 6.3 `CompactBoundary`

**触发时机**（PRD §4.2）：上下文压缩点（M7 `AutoCompactChecker` 触发压缩 + `CompactBoundary` 元数据写入 transcript 后）。

**事件源**：M7 `AutoCompactChecker` + `CompactBoundary` 标记。

**payload 引用**：types.ts §13 `CompactBoundaryPayload`（`boundary_id` / `compact_range` / `tokens_before` / `tokens_after`），完整 schema 见 mod-04-hook-payloads.md §12。

**6 类型支持**：全 `✓`（同 §4.1，但 `updatedInput` 被忽略——CompactBoundary 不是工具调用）。

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext`（注入压缩后摘要）+ `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：同 §4.2。

**测试要点**：

- 正向：压缩触发 → command hook 收到 `{ boundary_id: 'b1', tokens_before: 100000, tokens_after: 30000 }` payload → 注入 "context compacted, 70% reduction" additionalContext。
- 字段忽略：hook 返回 `{ updatedInput: { ... } }` → 字段被忽略。
- crash：同 §4.1。

**依赖**：M7 `AutoCompactChecker` + `CompactBoundary`（事件源）+ 其余同 §4.2。

### 6.4 `Resume`

**触发时机**（PRD §4.2）：会话恢复（M7 `SessionManager.resumeSession()` 调用后）。

**事件源**：M7 `SessionManager`。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §13（建议字段：`session_id` / `resumed_from_turn` / `compact_boundary_id` / `cwd`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 提示恢复点 |
| `agent` | △ | 递归风险：spawn 子 agent 处理 Resume 可能触发 AgentStart → 递归。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在第一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：DenialTracker 计数在 Resume 时重置（同 §6.1）。

**测试要点**：

- 正向：会话恢复 → command hook 收到 `{ session_id: 's1', resumed_from_turn: 42 }` payload → 注入 "resumed from turn 42" additionalContext。
- DenialTracker 重置：同 §6.1。
- agent 递归：同 §5.1。
- crash：同 §4.1。

**依赖**：M7 `SessionManager`（事件源）+ 其余同 §4.2。

## 7. 消息事件（2）详目

消息事件由 M2 `ReActLoop` 在用户输入与 LLM 响应边界触发。事件源：M2 `FSMController`。

### 7.1 `UserPromptSubmit`

**触发时机**（PRD §4.2）：用户输入提交（M2 `ReActLoop` 收到用户输入后、`BUILD_CONTEXT` 状态前）。

**事件源**：M2 `FSMController` 进入 `BUILD_CONTEXT` 状态前。

**payload 引用**：types.ts §13 `UserPromptSubmitPayload`（`prompt` / `session_id`），完整 schema 见 mod-04-hook-payloads.md §14。

**6 类型支持**：全 `✓`（同 §4.1，但 `updatedInput` 被忽略——UserPromptSubmit 不是工具调用）。

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext`（注入本轮上下文）+ `continue`。

**sync/async 模式**：默认 sync（在 LLM 调用前阻塞）；async hook 在下一轮注入（本轮不等待）。

**超时默认**：同 §4.1。

**DenialTracker 交互**：DenialTracker `maxConsecutive` 计数在 UserPromptSubmit 时重置（同 §2.7 规则 7）。`maxTotal` 不重置。

**测试要点**：

- 正向：用户输入 "hello" → command hook 收到 `{ prompt: 'hello', session_id: 's1' }` payload → 注入 additionalContext。
- DenialTracker 重置：前一轮 DenialTracker 触发 `maxConsecutive=3`，下一轮 UserPromptSubmit → `maxConsecutive` 归零。
- async：command hook stdout 首行 `{"async":true}` → 本轮放行 + 下一轮注入。
- crash：同 §4.1。

**依赖**：M2 `FSMController`（事件源）+ 其余同 §4.2。

### 7.2 `AssistantResponse`

**触发时机**（PRD §4.2）：LLM 响应结束（M2 `ReActLoop` 收到完整 LLM 响应后、`EVAL_STOP_REASON` 状态前）。

**事件源**：M2 `FSMController` 退出 `STREAM_RENDER` 状态后。

**payload 引用**：types.ts §13 `AssistantResponsePayload`（`response` / `stop_reason` / `tokens`），完整 schema 见 mod-04-hook-payloads.md §15。

**6 类型支持**：全 `✓`（同 §4.1，但 `updatedInput` 被忽略）。

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext`（注入下一轮上下文）+ `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：同 §4.2。

**测试要点**：

- 正向：LLM 响应 "I'll read the file" → command hook 收到 `{ response: '...', stop_reason: 'tool_use', tokens: { input: 1000, output: 50 } }` payload → 注入 additionalContext。
- 字段忽略：hook 返回 `{ updatedInput: { ... } }` → 字段被忽略。
- crash：同 §4.1。

**依赖**：M2 `FSMController`（事件源）+ M1 `LLMProvider`（响应来源）+ 其余同 §4.2。

## 8. 权限事件（4）详目

权限事件由 M4 `PermissionEngine` 在权限决策边界触发。事件源：M4 `PermissionEngine` + `FiveLayerInterceptor`。

### 8.1 `PermissionDeny`

**触发时机**（PRD §4.2）：权限拒绝（五层拦截链任一层返回 `deny`）。

**事件源**：M4 `FiveLayerInterceptor` 任一层 deny 后。

**payload 引用**：types.ts §13 `PermissionDenyPayload`（`tool_name` / `matched_rule` / `layer`），完整 schema 见 mod-04-hook-payloads.md §16。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 提示用户拒绝原因 |
| `agent` | △ | 递归风险：spawn 子 agent 处理 PermissionDeny 可能再次触发工具调用 → 再次 PermissionDeny → 递归。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略——权限已拒绝，不可改写）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：PermissionDeny 事件本身**不**调 `denialTracker.record()`（PermissionDeny 是结果事件，不是 Hook deny）；但 Hook 返回 `deny` 时仍 `record()`。

**测试要点**：

- 正向：Layer 2 deny bash → command hook 收到 `{ tool_name: 'bash', matched_rule: 'rule_42', layer: 2 }` payload → 注入 "bash denied by rule 42" additionalContext。
- agent 递归：agent hook spawn 子 agent → 子 agent 调 bash → PermissionDeny → 递归深度从 1 增到 2 → 拒绝再 spawn。
- 字段忽略：hook 返回 `{ permissionDecision: 'allow' }` → 字段被忽略（权限已拒绝）。
- crash：同 §4.1。

**依赖**：M4 `FiveLayerInterceptor`（事件源）+ 其余同 §4.2。

### 8.2 `PermissionAllow`

**触发时机**（PRD §4.2）：权限放行（五层拦截链全部通过）。

**事件源**：M4 `FiveLayerInterceptor` 全部 layer 通过后。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §17（建议字段：`tool_name` / `matched_rule` / `layer`：5 / `decision_source`：'rule' / 'risk_classifier' / 'auto_mode'）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 记录放行 |
| `agent` | △ | 递归风险：同 §8.1。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：不调 `record()`（PermissionAllow 是结果事件）。

**测试要点**：

- 正向：Layer 5 allow → command hook 收到 `{ tool_name: 'read_file', decision_source: 'rule' }` payload。
- agent 递归：同 §8.1。
- crash：同 §4.1。

**依赖**：同 §8.1。

### 8.3 `PermissionAsk`

**触发时机**（PRD §4.2）：权限弹窗 ask（五层拦截链返回 `ask`，触发权限弹窗）。

**事件源**：M4 `FiveLayerInterceptor` 任一层返回 `ask` 后。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §18（建议字段：`tool_name` / `matched_rule` / `layer` / `ask_reason`：'rule' / 'risk_classifier_low_confidence' / 'denial_tracker_degraded'）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 提示用户 |
| `agent` | △ | 递归风险：同 §8.1。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入（弹窗已显示，async 结果在用户选择后注入）。

**超时默认**：同 §4.1。

**DenialTracker 交互**：不调 `record()`。

**测试要点**：

- 正向：Risk Classifier confidence < 0.80 → command hook 收到 `{ ask_reason: 'risk_classifier_low_confidence' }` payload。
- DenialTracker 降级：DenialTracker 触发后 → command hook 收到 `{ ask_reason: 'denial_tracker_degraded' }` payload。
- agent 递归：同 §8.1。
- crash：同 §4.1。

**依赖**：同 §8.1 + M4 `RiskClassifier`（ask 触发源之一）。

### 8.4 `PermissionEscalation`

**触发时机**（PRD §4.2）：权限模式切换（用户 `/mode acceptEdits` 命令 / Risk Classifier 自动升级 / DenialTracker degrade_to_ask）。

**事件源**：M4 `PermissionEngine.setMode()` + M2 `/mode` 命令处理器。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §19（建议字段：`from_mode` / `to_mode` / `escalation_reason`：'user_command' / 'risk_classifier' / 'denial_tracker' / `tool_name`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 提示模式切换 |
| `agent` | △ | 递归风险：同 §8.1。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：不调 `record()`。

**测试要点**：

- 正向：用户 `/mode acceptEdits` → command hook 收到 `{ from_mode: 'default', to_mode: 'acceptEdits', escalation_reason: 'user_command' }` payload。
- DenialTracker 降级：DenialTracker 触发后 → command hook 收到 `{ to_mode: 'dontAsk', escalation_reason: 'denial_tracker' }` payload。
- agent 递归：同 §8.1。
- crash：同 §4.1。

**依赖**：同 §8.1 + M2 `/mode` 命令（事件源）。

## 9. 模型事件（4）详目

模型事件由 M1 `LLMProvider` 与 M2 `FSMController` 协同触发。事件源：M1 `LLMProvider`（ModelSwitch / ProviderError / FallbackTriggered）+ M2 `StallDetector`（StallDetected）。

### 9.1 `ModelSwitch`

**触发时机**（PRD §4.2）：模型切换（用户 `/model` 命令 / M1 自动切换 / fallback chain 触发切换）。

**事件源**：M1 `LLMProvider.switchModel()` + M2 `/model` 命令处理器。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §20（建议字段：`from_model` / `to_model` / `switch_reason`：'user_command' / 'fallback' / 'auto' / `provider`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 提示模型切换 |
| `agent` | △ | 递归风险：spawn 子 agent 处理 ModelSwitch 可能触发 LLM 调用 → 再次 ModelSwitch → 递归。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：ModelSwitch 事件本身**不**调 `denialTracker.record()`（结果事件）；但 Hook 返回 `deny` 时仍 `record()`。

**测试要点**：

- 正向：用户 `/model sonnet` → command hook 收到 `{ from_model: 'opus', to_model: 'sonnet', switch_reason: 'user_command' }` payload → 注入 "model switched to sonnet" additionalContext。
- fallback 触发：M1 fallback chain 触发 → command hook 收到 `{ switch_reason: 'fallback' }` payload。
- agent 递归：agent hook spawn 子 agent → 子 agent LLM 调用 → ModelSwitch → 递归深度从 1 增到 2 → 拒绝再 spawn。
- crash：同 §4.1。

**依赖**：M1 `LLMProvider`（事件源）+ M2 `/mode` / `/model` 命令处理器（事件源）+ 其余同 §4.2。

### 9.2 `ProviderError`

**触发时机**（PRD §4.2）：LLM 调用异常（`PROVIDER_5XX` / `PROVIDER_429` / `PROVIDER_TIMEOUT` / `PROVIDER_AUTH_FAILED`）。

**事件源**：M1 `LLMProvider.chat()` 抛异常后。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §21（建议字段：`provider` / `error_type`：'5xx' / '429' / 'timeout' / 'auth_failed' / `error_message` / `retry_count` / `model`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 提示 provider 异常 + 建议重试或换 provider |
| `agent` | △ | 递归风险：spawn 子 agent 处理 ProviderError 可能触发 LLM 调用 → 再次 ProviderError → 递归。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：ProviderError 事件本身**不**调 `denialTracker.record()`（结果事件）；但 Hook 返回 `deny` 时仍 `record()`。

**测试要点**：

- 正向：provider 返回 5xx → command hook 收到 `{ provider: 'openai', error_type: '5xx', error_message: 'internal server error', retry_count: 0 }` payload → 注入 "provider error, retrying" additionalContext。
- 429 限流：provider 返回 429 → command hook 收到 `{ error_type: '429' }` payload。
- agent 递归：同 §9.1。
- crash：同 §4.1。

**依赖**：M1 `LLMProvider`（事件源）+ 其余同 §4.2。

### 9.3 `FallbackTriggered`

**触发时机**（PRD §4.2）：fallback model 降级触发（M1 fallback chain 在主 model 重试耗尽后切换到 fallback model）。

**事件源**：M1 `FallbackChain.trigger()`。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §22（建议字段：`primary_model` / `fallback_model` / `trigger_reason`：'5xx' / '429' / 'timeout' / 'auth_failed' / `retry_count` / `provider`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 提示 fallback 降级 |
| `agent` | △ | 递归风险：spawn 子 agent 处理 FallbackTriggered 可能触发 LLM 调用 → 再次 fallback → 递归。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：FallbackTriggered 事件本身**不**调 `denialTracker.record()`（结果事件）；但 Hook 返回 `deny` 时仍 `record()`。

**测试要点**：

- 正向：主 model 5xx 重试耗尽 → command hook 收到 `{ primary_model: 'opus', fallback_model: 'sonnet', trigger_reason: '5xx', retry_count: 3 }` payload → 注入 "fallback to sonnet" additionalContext。
- 429 触发 fallback：主 model 429 → command hook 收到 `{ trigger_reason: '429' }` payload。
- agent 递归：同 §9.1。
- crash：同 §4.1。

**依赖**：M1 `FallbackChain`（事件源，L3-M1 §2.2.X fallback chain 实施）+ 其余同 §4.2。

### 9.4 `StallDetected`

**触发时机**（PRD §4.2）：流式 stall 检测（M2 双定时器：passive 30s 重置 / active 90s 不重置）。

**事件源**：M2 `StallDetector`（L3-M2 §2.2.X 双定时器 stall 检测）。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §23（建议字段：`stall_type`：'passive' / 'active' / `stall_duration_ms` / `agent_id` / `session_id`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 提示 stall 检测 + 建议重试或 abort |
| `agent` | △ | 递归风险：spawn 子 agent 处理 StallDetected 可能触发 LLM 调用 → 再次 stall → 递归。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：StallDetected 事件本身**不**调 `denialTracker.record()`（结果事件）；但 Hook 返回 `deny` 时仍 `record()`。

**测试要点**：

- 正向：passive timer 30s 无 chunk → command hook 收到 `{ stall_type: 'passive', stall_duration_ms: 30000 }` payload → 注入 "stall detected, retrying" additionalContext。
- active timer：active timer 90s 无 chunk → command hook 收到 `{ stall_type: 'active', stall_duration_ms: 90000 }` payload。
- agent 递归：同 §9.1。
- crash：同 §4.1。

**依赖**：M2 `StallDetector`（事件源，L3-M2 §2.2.X 双定时器）+ M1 `LLMProvider`（流式响应来源）+ 其余同 §4.2。

## 10. 系统事件（4）详目

系统事件由进程级信号与预算追踪触发。事件源：M2 `AbortCoordinator` + `BudgetGuard` + M1 `LLMProvider` + cron 调度器。

### 10.1 `Shutdown`

**触发时机**（PRD §4.2）：进程关闭（用户 `/exit` / `SIGTERM` / `SIGINT` / 预算耗尽触发 shutdown）。

**事件源**：M2 `AbortCoordinator` + `process.on('SIGINT' / 'SIGTERM')`。

**payload 引用**：types.ts §13 `ShutdownPayload`（`reason` / `session_id`），完整 schema 见 mod-04-hook-payloads.md §24。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` | ✓ | shell 命令在进程退出前执行（同步等待完成） |
| `prompt` | − | 无下一轮注入（进程关闭中，additionalContext 无目标） |
| `agent` | − | 不可 spawn（进程关闭中，M5 `Orchestrator` 拒绝新 spawn） |
| `http` | △ | HTTP 请求可能未完成即退出；仅适合"尽力通知"语义（fire-and-forget，不等待响应，超时阈值降至 2s） |
| `callback` | ✓ | 内置回调清理资源（如 flush 日志、写审计日志） |
| `function` | ✓ | v1.0 仅内置函数 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput + additionalContext 全部被忽略——无下一轮注入）。

**可改写字段**：仅 `continue`。

**sync/async 模式**：默认 sync；async 不支持（无下一轮注入）。

**超时默认**：command 5s / http 2s（降低，因进程即将退出）/ callback 5s / function 5s。prompt / agent 不可用。

**DenialTracker 交互**：Hook deny 仍 `record()`，但不影响 shutdown 流程。

**测试要点**：

- 正向：用户 `/exit` → command hook 收到 `{ reason: 'user' }` payload → 写审计日志 + 清理临时文件。
- prompt 拒绝：用户配置 `event: Shutdown, type: prompt` → reject。
- agent 拒绝：同上。
- http fire-and-forget：http hook 发请求 → 不等待响应 → 进程退出（断言请求已发出，不 assert 响应）。
- additionalContext 忽略：同 §5.2。
- crash：同 §4.1，但 shutdown 流程不中断（Hook crash 后继续后续 Hook）。

**依赖**：M2 `AbortCoordinator`（事件源）+ Node.js `process` API（信号处理）+ 其余同 §4.2。

### 10.2 `Crash`

**触发时机**（PRD §4.2）：进程崩溃（`uncaughtException` / `unhandledRejection` / `SIGSEGV` / `SIGABRT`）。

**事件源**：Node.js `process.on('uncaughtException' / 'unhandledRejection')` + OS 信号处理器。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §25（建议字段：`error` / `stack` / `session_id` / `agent_id`）。

**6 类型支持**：全 `−`（进程已崩，Hook 系统不可用）。

| 类型 | 支持 | 理由 |
|------|------|------|
| `command` | − | shell 不可执行（JS 运行时已崩） |
| `prompt` | − | 无下一轮注入 |
| `agent` | − | 不可 spawn |
| `http` | − | HTTP 不可发 |
| `callback` | − | JS 运行时不可用 |
| `function` | − | JS 运行时不可用 |

**替代机制**：Crash 事件**不经过 Hook 系统**，由 OS 级信号处理器独立处理：

1. `process.on('uncaughtException')` 捕获 → 写崩溃日志到 `~/.omniagent/logs/crash-${timestamp}.log`（含 error / stack / session_id / agent_id）。
2. `process.on('unhandledRejection')` 同上。
3. `process.on('SIGSEGV' / 'SIGABRT')` 由 libuv 捕获 → 同上。
4. 崩溃日志写入后，进程退出（exit code 1）。

**测试要点**：

- 注册拒绝：用户配置 `event: Crash, type: <any>` → `HookRegistry.register()` reject `HOOK_TYPE_NOT_SUPPORTED`。
- 崩溃日志：手动 throw `uncaughtException` → 断言 `~/.omniagent/logs/crash-${ts}.log` 存在 + 含 stack 字段。
- 独立机制：Crash 不经过 `HookScheduler.schedule()`（断言 `HookScheduler.schedule('Crash', ...)` 永不被调用——通过 code grep 确认无 `schedule('Crash', ...)` 调用点）。

**依赖**：Node.js `process` API + OS 信号处理器（独立于 M4 Hook 系统）。

### 10.3 `BudgetExceeded`

**触发时机**（PRD §4.2）：预算超限（M4 `BudgetGuard.check()` 返回 `exceeded: true`）。

**事件源**：M4 `BudgetGuard` + M1 `CostTracker`。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §26（建议字段：`budget_type`：'per_turn' / 'total' / `current_cost` / `budget_limit` / `exceeded_by`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 提示用户预算超限 |
| `agent` | △ | 递归风险：spawn 子 agent 处理 BudgetExceeded 可能再次消耗预算 → 递归。递归深度 +1，上限 2。子 agent 预算从父 agent 预算扣（不额外增加）。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：不调 `record()`（BudgetExceeded 是结果事件，不是 Hook deny）。

**测试要点**：

- 正向：`max_per_turn` 超限 → command hook 收到 `{ budget_type: 'per_turn', current_cost: 5.2, budget_limit: 5.0, exceeded_by: 0.2 }` payload → 注入 "budget exceeded, please wrap up" additionalContext。
- agent 递归：agent hook spawn 子 agent → 子 agent 消耗预算 → 递归深度从 1 增到 2 → 拒绝再 spawn。
- crash：同 §4.1。

**依赖**：M4 `BudgetGuard`（事件源）+ M1 `CostTracker`（预算追踪）+ 其余同 §4.2。

### 10.4 `ScheduleTriggered`

**触发时机**（PRD §4.2）：定时任务触发（cron 调度器触发预设任务）。

**事件源**：cron 调度器（`CronCreate` 工具创建的定时任务）。

**payload 引用**：types.ts §13 `GenericHookPayload`，完整 schema 见 mod-04-hook-payloads.md §27（建议字段：`cron_id` / `cron_schedule` / `prompt` / `triggered_at`）。

**6 类型支持**：

| 类型 | 支持 | 约束 |
|------|------|------|
| `command` / `prompt` / `http` / `callback` / `function` | ✓ | Hook 可注入 additionalContext 提示定时任务触发 |
| `agent` | △ | 递归风险：spawn 子 agent 处理 ScheduleTriggered 可能再次触发 cron → 递归。递归深度 +1，上限 2。 |

**默认 HookResponse**：`{ continue: true, permissionDecision: 'allow' }`（permissionDecision + updatedInput 被忽略）。

**可改写字段**：`additionalContext` + `continue`。

**sync/async 模式**：默认 sync；async 在下一轮注入。

**超时默认**：同 §4.1。

**DenialTracker 交互**：DenialTracker 计数在 ScheduleTriggered 时重置（同 §6.1，因这是新的一轮）。

**测试要点**：

- 正向：cron `*/5 * * * *` 触发 → command hook 收到 `{ cron_id: 'c1', cron_schedule: '*/5 * * * *', prompt: 'check deploy' }` payload → 注入 "cron triggered" additionalContext。
- DenialTracker 重置：同 §6.1。
- agent 递归：同 §10.3。
- crash：同 §4.1。

**依赖**：cron 调度器（事件源）+ 其余同 §4.2。

## 11. 跨事件测试要点

### 11.1 矩阵级 contract test（162 格）

每格至少 1 个 contract test（CR-MXXX 格编号），断言：

- ✓ 格：注册成功 + Hook 触发 + HookResponse 字段生效（按 §2.6 字段忽略矩阵）。
- △ 格：注册成功 + 约束生效（递归深度上限 / async 风险 / 字段忽略）。
- − 格：注册 reject `HOOK_TYPE_NOT_SUPPORTED`。

contract test 代码骨架（位于 `tests/permission/hook-matrix.contract.test.ts`）：

```typescript
describe('Hook Matrix Contract (27 events × 6 types = 162 cells)', () => {
  const MATRIX: Array<[HookEventName, HookType, '✓' | '△' | '−', string?]> = [
    // 工具事件（5）
    ['PreToolUse', 'command', '✓'],
    ['PreToolUse', 'prompt', '✓'],
    // ... 162 行
    ['Crash', 'function', '−', 'process crashed'],
  ];

  for (const [event, type, expected, reason] of MATRIX) {
    it(`${event} × ${type} → ${expected}${reason ? ` (${reason})` : ''}`, async () => {
      if (expected === '−') {
        await expect(registry.register({ event, type, target: '...' }))
          .rejects.toThrow('HOOK_TYPE_NOT_SUPPORTED');
      } else {
        const hook = await registry.register({ event, type, target: '...' });
        const response = await scheduler.schedule(event, payloadFor(event), ctx);
        expect(response.continue).toBe(true);
        // 按 §2.6 字段忽略矩阵断言
      }
    });
  }
});
```

### 11.2 矩阵级不变量测试（N1-N11）

| 不变量 | 描述 | 测试断言 |
|-------|------|---------|
| N1 | 矩阵覆盖完整（162 格） | `MATRIX.length === 162` + 27 事件 × 6 类型全枚举 |
| N2 | function 类型 v1.0 仅内置 | 用户配置 `type: function` → reject `HOOK_FUNCTION_USER_CONFIG_REJECTED`（27 事件全测） |
| N3 | Crash 事件 6 类型全 − | `HookRegistry.register({ event: 'Crash', type: <any> })` 全 reject |
| N4 | 生命周期结束事件 × (prompt + agent) − = 8 格 | `Shutdown` / `AgentStop` / `SubagentExit` / `SessionEnd` × `prompt` + `agent` 全 reject（共 8 格） |
| N5 | Hook 链顺序稳定 | 3 个 hook [A, B, C] 注册，B `continue: false` → C 不执行；3 个 hook [A, B, C] 注册，全 `continue: true` → 执行顺序 A→B→C |
| N6 | DenialTracker hooks 上下文 maxConsecutive=3 / maxTotal=20 | 模拟 3 次连续 deny → 第 4 次 `shouldTrigger()` 返回 true；模拟 20 次累计 deny → 第 21 次 `shouldTrigger()` 返回 true |
| N7 | Hook crash → fail-closed deny | Handler 抛异常 → `schedule()` 返回 `{ continue: false, permissionDecision: 'deny' }` + `record()` 调用 |
| N8 | async hook 仅 command / http / agent | prompt / callback / function 类型的 `async` 字段被忽略（断言 hook 同步返回） |
| N9 | 字段忽略矩阵（27 × 4）生效 | `PostToolUse` hook 返回 `{ updatedInput: { ... } }` → 字段被忽略（工具 input 不变）；`AgentStop` hook 返回 `{ additionalContext: '...' }` → 字段被忽略（无下一轮注入） |
| N10 | 递归深度上限 2 | `SubagentSpawn` × `agent` 类型 spawn 子 agent → 递归深度 1；子 agent `SubagentSpawn` → 递归深度 2；再 spawn → reject `HOOK_RECURSION_DEPTH_EXCEEDED` |
| N11 | `Shutdown` × `http` △（fire-and-forget） | Shutdown 触发 → http hook 发请求 → 不等待响应 → 进程退出（断言请求已发出，不 assert 响应）+ 超时降至 2s |

### 11.3 跨事件集成测试

| 测试 | 场景 | 断言 |
|------|------|------|
| IE-1 | PreToolUse command hook deny → PermissionDeny 事件触发 | `HookScheduler.schedule('PreToolUse', ...)` 返回 deny → 紧接着 `schedule('PermissionDeny', ...)` 被调用 |
| IE-2 | UserPromptSubmit → DenialTracker 重置 | 前一轮 `maxConsecutive=3`，UserPromptSubmit 触发 → `maxConsecutive=0`，`maxTotal` 不重置 |
| IE-3 | CompactBoundary → additionalContext 注入下一轮 | `CompactBoundary` hook 返回 `{ additionalContext: 'compacted' }` → 下一轮 `SystemPromptBuilder` 包含 'compacted' |
| IE-4 | SessionStart → DenialTracker 全重置 | `maxConsecutive=3` + `maxTotal=20`，SessionStart 触发 → 两者归零 |
| IE-5 | Shutdown → http fire-and-forget | Shutdown 触发 → http hook 发请求 → 不等待响应 → 进程退出（断言请求已发出，不 assert 响应） |
| IE-6 | Crash → 不经过 Hook 系统 | `HookScheduler.schedule('Crash', ...)` 永不被调用（code grep 确认无调用点） |
| IE-7 | SubagentSpawn → agent 递归深度 | `SubagentSpawn` × `agent` 类型 → 递归深度 1；子 agent SubagentSpawn → 递归深度 2；再 spawn → reject `HOOK_RECURSION_DEPTH_EXCEEDED` |
| IE-8 | ToolPoolChanged × agent → 递归 | 同 IE-7 |
| IE-9 | BudgetExceeded × agent → 递归 | 同 IE-7，且子 agent 预算从父 agent 扣 |
| IE-10 | AgentStop × prompt → reject | `HookRegistry.register({ event: 'AgentStop', type: 'prompt' })` → reject `HOOK_TYPE_NOT_SUPPORTED` |

### 11.4 性能测试

| 测试 | 场景 | 断言 |
|------|------|------|
| P-1 | Hook 链 10 个 command hook，每个 100ms | 总耗时 ≤ 1100ms（含 100ms × 10 + 100ms 调度开销） |
| P-2 | Hook 链 0 个 hook | `schedule()` 耗时 ≤ 1ms（提前返回） |
| P-3 | async hook 5 个并发 | 5 个 async hook 并发执行，下一轮注入 5 个 additionalContext |
| P-4 | DenialTracker 触发后 | 触发后 `schedule()` 耗时 ≤ 1ms（立即返回） |

## 12. 矩阵级不变量

### 12.1 不变量清单

| # | 不变量 | 守护机制 | 测试用例 |
|---|-------|---------|---------|
| N1 | 矩阵覆盖完整（162 格） | §3 矩阵表 + §11.1 contract test | CR-M001 至 CR-M162 |
| N2 | function 类型 v1.0 仅内置 | L3-M4 §2.2.12 `BUILTIN_FUNCTIONS` 白名单 + §2.2 规则 1 | 27 事件 × `type: function` 用户配置全 reject |
| N3 | Crash 事件 6 类型全 − | §10.2 + `HookRegistry.register()` reject + OS 级信号处理器独立机制 | CR-M145 至 CR-M150（Crash × 6 类型） |
| N4 | 生命周期结束事件（`Shutdown` / `AgentStop` / `SubagentExit` / `SessionEnd`）× (`prompt` + `agent`) − = 8 格 | §5.2 / §5.4 / §6.2 / §10.1 + `HookRegistry.register()` reject（无下一轮注入 + 不可 spawn） | CR-M038 + CR-M039（AgentStop）+ CR-M050 + CR-M051（SubagentExit）+ CR-M062 + CR-M063（SessionEnd）+ CR-M140 + CR-M141（Shutdown） |
| N5 | Hook 链顺序稳定 | §2.5 + `HookRegistry.listByEvent()` 按注册顺序返回 | §11.2 N5 测试 |
| N6 | DenialTracker hooks 上下文 maxConsecutive=3 / maxTotal=20 | L3-M4 §2.2.9 + §3.5.3 + §3.9.1 | §11.2 N6 测试 |
| N7 | Hook crash → fail-closed deny | §2.2 规则 7 + L3-M4 §2.2.9 catch 块 | §11.2 N7 测试 |
| N8 | async hook 仅 command / http / agent | §2.4 + §2.2 规则 12 | §11.2 N8 测试 |
| N9 | 字段忽略矩阵（27 × 4）生效 | §2.6 + `HookScheduler.schedule()` 字段过滤 | §4-§10 每事件"字段忽略"测试 |
| N10 | 递归深度上限 2 | §4.4 / §4.5 / §5.1 / §5.3 / §6.1 / §6.4 / §8.1-§8.4 / §9.1-§9.4 / §10.3 / §10.4 的 `agent` 类型格 | §11.3 IE-7 / IE-8 / IE-9 |
| N11 | `Shutdown` × `http` △（fire-and-forget） | §10.1 + 超时降至 2s + 不等待响应 | CR-M142（Shutdown × http） |

### 12.2 不变量与附录 A 18 项全局不变量的映射

本文档矩阵级不变量 N1-N11 是附录 A 18 项全局不变量中与本模块相关的子集的细化：

| 矩阵级不变量 | 对应全局不变量 | 备注 |
|------------|--------------|------|
| N2 | #8 五层独立拦截 | function 类型在 Layer 5 内，受全局 #8 约束 |
| N6 | #14 DenialTracking maxConsecutive=3 / maxTotal=20 | 全局 #14 直接对应 |
| N7 | #5 单层失效 fail-closed | 全局 #5 在 Layer 5 的具体化 |
| N9 | — | 本文档新增（字段忽略矩阵），不对应全局不变量 |
| N10 | — | 本文档新增（递归深度上限），不对应全局不变量 |
| N11 | — | 本文档新增（Shutdown × http fire-and-forget），不对应全局不变量 |

## 13. 开放问题与 v2.x 演进

### 13.1 v1.0 已冻结决策

| 决策 | 内容 | 引用 |
|------|------|------|
| A4 | Hooks function 边界：v1.0 仅内置 function | PRD mod-04 §8.1 A4 + omniagent-prd-decisions.md §A4 + 本文 §2.2 规则 1 + §12 N2 |

### 13.2 v2.x 演进项

| 演进项 | 描述 | 影响矩阵格 |
|-------|------|-----------|
| function 类型对用户放开 | v2.x 评估 GPG 签名 + 白名单机制 | 27 事件 × `function` 类型格（v1.0 `✓` 仅内置，v2.x `✓` 用户可用） |
| Crash 事件支持 | v2.x 评估通过 OS 级独立进程（daemon）捕获 Crash 并触发 Hook | `Crash` × 6 类型格（v1.0 全 `−`，v2.x 可能 `✓` 或 `△`） |
| 新增事件类型 | v2.x 评估新增 `ToolCallAborted`（abort 传播时）/ `McpReconnect`（MCP 重连）等事件 | 矩阵从 27 × 6 扩展到 28+ × 6 |
| 新增 Hook 类型 | v2.x 评估新增 `webhook`（双向 webhook）/ `graphql`（GraphQL 查询）等类型 | 矩阵从 27 × 6 扩展到 27 × 7+ |
| async hook 扩展 | v2.x 评估 `prompt` / `callback` / `function` 类型支持 async（需重构同步语义） | §2.4 表 + N8 |
| 递归深度上限可配 | v2.x 评估 `OMNIAGENT_HOOK_RECURSION_DEPTH` 环境变量（默认 2，上限 5） | N10 + 所有 `△` 格的 `agent` 类型约束 |

### 13.3 开放问题

| 问题 | 描述 | 责任方 | 目标里程碑 |
|------|------|-------|-----------|
| Q1 | `ScheduleTriggered` × `agent` 类型 spawn 子 agent 是否应继承 cron 的 `permission_mode`？ | 安全工程师 + M2 工程师 | M3 开工前 |
| Q2 | `BudgetExceeded` × `agent` 类型子 agent 预算从父 agent 扣，但若父 agent 已无预算，子 agent 是否立即退出？ | M1 工程师（CostTracker）+ M4 工程师 | M3 开工前 |
| Q3 | `Shutdown` × `http` 类型 fire-and-forget 超时 2s 是否过短？CI 实测后调整。 | 安全工程师 | M3 迭代 1 |
| Q4 | `Crash` 事件不经过 Hook 系统，但崩溃日志是否应作为 `Crash` 事件的 "post-hook" 写入审计日志？ | 安全工程师 + 合规工程师 | M3 开工前 |
| Q5 | `PermissionEscalation` × `agent` 类型 spawn 子 agent 决策是否允许升级——这是否违反"权限不可自动升级"原则？ | 安全工程师 | M3 开工前（高优先级） |

## 14. 参考链接

### 14.1 PRD 体系

- **PRD mod-04 §4.2**：Hook 中间件机制（27 事件 + 6 类型 + HookResponse schema + 关键事件 payload + 防死循环 + async hook）
- **PRD mod-04 §4.1**：DenialTracking 语义统一（K19：两上下文机制同名行为不同 → 自审 C7 修正为统一 degrade_to_ask）
- **PRD mod-04 §8.1 A4**：Hooks function 边界（v1.0 仅内置）
- **PRD mod-04 §8.4**：v2.x 演进项（function 签名机制）
- **omniagent-prd-decisions.md §A4**：决策详情

### 14.2 L2 设计文档

- **L2 §8.1 Layer 5**：Hooks + 预算拦截层

### 14.3 L3 模块设计文档

- **L3-M4 §2.2.9**：`HookScheduler` 代码骨架
- **L3-M4 §2.2.10**：`HookExecutor` 6 类型分发
- **L3-M4 §2.2.11**：`CommandHookHandler` 代码骨架
- **L3-M4 §2.2.12**：`FunctionHookHandler` 代码骨架 + `BUILTIN_FUNCTIONS` 白名单
- **L3-M4 §3.5**：Hook 中间件 27 事件 × 6 类型（引用 PRD §4.2）
- **L3-M4 §3.5.3**：防死循环（DenialTracker hooks 上下文）
- **L3-M4 §3.5.4**：async hook
- **L3-M4 §3.9**：DenialTracker 双上下文统一

### 14.4 类型契约

- **omniagent-types.ts §13**：`HookEventName` / `HookType` / `HookPayload` / `HookResponse` / `Hook` / 7 类显式 payload（`PreToolUsePayload` / `PostToolUsePayload` / `CompactBoundaryPayload` / `UserPromptSubmitPayload` / `AssistantResponsePayload` / `PermissionDenyPayload` / `ShutdownPayload`）+ `GenericHookPayload`
- **omniagent-types.ts §19**：`AuditLogEntry`

### 14.5 关联前置文档

- **omniagent-prd-mod-04-hook-payloads.md**（M3 开工前补全 #3）：27 事件完整 payload schema（本文 §4-§10 每事件"payload 引用"指向）
- **omniagent-prd-mod-03-tools-catalog.md**（已冻结）：60+ 工具登记表（PreToolUse / PostToolUse 事件的 `tool_name` 字段取值范围）
- **omniagent-eval/prompt-injection-shadow/**（M3 开工前补全 #4）：≥ 50 条红队样本（与 Hook 矩阵无直接关联，但 Hook 系统是 4 道防线中 Layer 5 的实施基础）

### 14.6 代码附件（M3 开发阶段产出）

- `src/permission/layer5/hook-registry.ts`：`HookRegistry`（27 × 6 矩阵注册校验）
- `src/permission/layer5/hook-scheduler.ts`：`HookScheduler`（调度 + 防死循环）
- `src/permission/layer5/hook-executor.ts`：`HookExecutor`（6 类型分发）
- `src/permission/layer5/handlers/command.ts`：`CommandHookHandler`
- `src/permission/layer5/handlers/prompt.ts`：`PromptHookHandler`
- `src/permission/layer5/handlers/agent.ts`：`AgentHookHandler`
- `src/permission/layer5/handlers/http.ts`：`HttpHookHandler`
- `src/permission/layer5/handlers/callback.ts`：`CallbackHookHandler`
- `src/permission/layer5/handlers/function.ts`：`FunctionHookHandler`
- `tests/permission/hook-matrix.contract.test.ts`：162 格 contract test
- `tests/permission/hook-invariants.test.ts`：N1-N11 不变量测试
