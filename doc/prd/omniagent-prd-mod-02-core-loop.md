# OmniAgent CLI — 模块 2：核心循环引擎 (Core Loop / ReAct) PRD

> 模块 ID: M2
> 主负责角色: 架构师
> 阻塞里程碑: M1（Walking Skeleton）
> 源章节: 总体 PRD §3.3
> 状态: M0 已冻结

---

## 1. 模块概述

### 范围（in scope）

- 定义 ReAct Loop 有限状态机（FSM）：IDLE → BUILD_CONTEXT → CALL_LLM → STREAM_RENDER → EVAL_STOP_REASON → TOOL_EXECUTE / PTL_DEGRADE → END_TURN
- 处理 10+ 种终止条件（end_turn / tool_use / max_tokens / ptl / user_interrupt / stall / 5xx / 429 / tool_error / budget_exceeded）
- 模型降级 5 步（同 provider 内 fallback）
- 流式 stall 检测（被动 30s + 主动 90s）
- abort 信号传播（用户中断时不留僵尸进程）
- tool_use/tool_result 配对完整性守护

### 边界（out of scope）

- **LLM 调用本身**：由 M1 模型抽象层负责，本模块只调用 `LLMProvider.chatStream()`
- **工具执行细节**：由 M3 通用工具系统负责，本模块只负责在 TOOL_EXECUTE 状态触发权限/沙箱/Plan/Hooks 链
- **上下文压缩与 PTL 降级策略**：由 M7 上下文与记忆引擎负责，本模块只识别 `ptl` stop_reason 并转 PTL_DEGRADE 分支
- **权限/沙箱/Hooks 链**：由 M4 权限与拦截系统负责，本模块在 TOOL_EXECUTE 状态调用 M4 的拦截链

### 在整体架构中的位置

ReAct Loop 是 harness 层的**心脏**，定义了"模型推理 → 工具调用 → 结果回注 → 再推理"的闭环。所有交互模式（终端/Headless/IDE/Remote）共享同一套状态机，派生模式只是 UI 呈现不同，循环逻辑一致。

---

## 2. 设计目标

1. **状态机明确**：每个状态有明确的进入条件、不变量、退出条件，不允许"中间态"
2. **终止条件全覆盖**：10+ 种终止条件每种有明确决策，无"未处理"分支
3. **降级可控**：5xx/429/ptl 各有明确降级路径，不无限重试，不臆造结果
4. **stall 检测**：被动 30s + 主动 90s 双重检测，触发后切非流式降级
5. **abort 可传播**：用户中断时 AbortController 信号传播到 LLMProvider + 工具执行 + 子 agent

---

## 3. 核心概念与接口

### 3.1 状态机定义

```
                  ┌──────────────────────┐
                  │  IDLE (等待用户输入)  │
                  └──────────┬───────────┘
                             │ user_input
                             ▼
                  ┌──────────────────────┐
                  │  BUILD_CONTEXT        │  ← 加载 system prompt + memory + tool 池
                  └──────────┬───────────┘
                             │ context_ready
                             ▼
                  ┌──────────────────────┐
        ┌─────────│  CALL_LLM            │  ← LLMProvider.chatStream()
        │         └──────────┬───────────┘
        │                    │ chunk_received
        │                    ▼
        │         ┌──────────────────────┐
        │         │  STREAM_RENDER       │  ← 流式渲染到 UI
        │         └──────────┬───────────┘
        │                    │ stream_end
        │                    ▼
        │         ┌──────────────────────┐
        │         │  EVAL_STOP_REASON    │  ← 判断终止条件
        │         └──┬──────┬──────┬─────┘
        │            │      │      │
   tool_use       end_turn  max_tokens  ptl
        │            │      │      │
        ▼            │      │      ▼
┌──────────────┐    │      │   ┌──────────────────┐
│ TOOL_EXECUTE │    │      │   │ PTL_DEGRADE      │ ← 紧急降级三步
│ (权限→沙箱→  │    │      │   │ (collapse→react  │
│  Plan→Hooks) │    │      │   │  →error)         │
└──────┬───────┘    │      │   └──────────────────┘
       │ tool_result│      │
       └────────────┘      │
                           ▼
                  ┌──────────────────────┐
                  │  END_TURN            │  ← 等待下一轮 user_input
                  └──────────────────────┘
```

### 3.2 状态职责

| 状态 | 职责 | 退出条件 |
|------|------|---------|
| IDLE | 等待用户输入，不消耗 LLM | user_input 到达 |
| BUILD_CONTEXT | 加载 system prompt + memory 召回 + tool 池组装 | context_ready |
| CALL_LLM | 调用 `LLMProvider.chatStream()` | 第一个 chunk 到达 / stall / error |
| STREAM_RENDER | 流式渲染 chunk 到 UI | stream_end |
| EVAL_STOP_REASON | 判断 stop_reason 分支 | 匹配到 10+ 种终止条件之一 |
| TOOL_EXECUTE | 执行工具（经 M4 五层拦截链） | tool_result 返回 |
| PTL_DEGRADE | 紧急降级三步（委托 M7） | 降级完成 / 报错 |
| END_TURN | 等待下一轮 | user_input 到达 → IDLE |

### 3.3 abort 信号传播

用户中断时，`AbortController` 信号同步传播到：
- LLMProvider 的 `chatStream()`（终止流式响应）
- 工具执行（终止 `tool.call()`）
- 子 agent（通过 M5 编排引擎传播）

不留僵尸进程，不留 partial 输出。

---

## 4. 功能详述

### 4.1 终止条件处理（10+ 种）

> [M0 冻结决策 C1 更新] `provider_5xx` / `provider_429` 的降级策略明确为"同 provider 内自动降级"（v1.0），跨 provider 降级延后到 M2。配置文件 schema 新增 `fallbackModel` 字段（单值，同 provider 内）。

`EVAL_STOP_REASON` 状态必须处理以下终止条件，每种有明确决策：

| 终止条件 | 处理 |
|---------|------|
| `end_turn` | 正常结束，转 IDLE |
| `tool_use` | 执行工具，回 CALL_LLM |
| `max_output_tokens` | 两阶段升级（slot 优化 → 升级 context window） |
| `ptl`（Prompt Too Long） | 紧急降级三步（委托 M7 上下文与记忆引擎） |
| `user_interrupt` | 保留当前状态，转 IDLE，可 resume |
| `stall_passive_30s` | 被动 stall 检测，重发请求 |
| `stall_active_90s` | 主动 stall 检测，切非流式降级 |
| `provider_5xx` | 模型降级 5 步：清空 assistant → 切 `fallbackModel`（同 provider 内） → 重发，最多重试 1 次 |
| `provider_429` | 退避重试（指数退避，最多 3 次） |
| `tool_execution_error` | 工具结果标记 is_error，回 CALL_LLM 让模型决策 |
| `budget_exceeded` | 软提醒，让用户确认是否继续 |

### 4.2 模型降级 5 步（同 provider 内，v1.0）

1. 检测 provider 返回 5xx 或连续 stall
2. 清空当前 assistant 消息（避免 partial 输出污染下一模型）
3. 切换到 `fallbackModel`（同 provider 内的更便宜/更稳定模型，配置于 settings.json）
4. 重新发送请求
5. 若仍失败，明确报错并提示用户，不无限重试

**配置 schema 示例**：
```jsonc
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4",
    "fallbackModel": "gpt-4o-mini"   // [C1 新增] 同 provider 内 fallback
  }
}
```

**跨 provider 降级**（M2 后补）：v2.x 评估支持 `fallbackChain: ["openai:gpt-4", "bedrock:claude", "ollama:llama3"]`，涉及多 provider 认证状态管理。

### 4.3 流式 stall 检测

- **被动 stall 检测**：30s 内无任何 chunk 到达，重发请求
- **主动 stall 检测**：90s 内流未结束，切非流式降级（`chat()` 替代 `chatStream()`）
- stall 率护栏：≤ 1%（stall_count / total_streams）

### 4.4 tool_use/tool_result 配对完整性

每个 `tool_use` 必须有对应的 `tool_result`，否则 `adjustIndexToPreserveAPIInvariants()` 强制修正：
- 压缩时不能截断 `tool_use`/`tool_result` 对
- 无法修正则报错而非破坏配对
- 该不变量同时守护 M7 上下文压缩与 M2 状态机

**`adjustIndexToPreserveAPIInvariants()` 接口签名**（跨模块函数，M2/M7 共享）：

```typescript
// M7 实现，M2 调用
function adjustIndexToPreserveAPIInvariants(params: {
  messages: Message[];                   // 待压缩的消息数组
  compactRange: { start: number; end: number };  // 压缩区间（索引）
}): {
  adjustedRange: { start: number; end: number };  // 调整后的压缩区间
  corrections: { type: 'remove_orphan_tool_use' | 'extend_to_include_pair'; index: number; reason: string }[];
  error?: { reason: string; index: number };  // 无法修正时报错（不破坏配对）
}
```

- 若 `tool_use` 在保留区而配对的 `tool_result` 在压缩区（或反之），自动扩展压缩区间以包含配对，记入 corrections。
- 若配对无法恢复（如 `tool_result` 已丢失），填 error 字段，调用方走报错路径。
- M2 EVAL_STOP_REASON 状态在分发到 TOOL_EXECUTE 或 PTL_DEGRADE 前不调用此函数；仅 M7 压缩时调用。

**`shouldAutoCompact()` 接口签名**（跨模块函数，M7 实现/M2 调用）：

```typescript
// M7 实现，M2 每轮结束后调用
function shouldAutoCompact(ctx: {
  messages: Message[];                   // 当前消息数组
  tokenCount: number;                    // M1 countTokens 估算
  maxContextWindow: number;              // M1 capabilities.maxContextWindow
  compacting: boolean;                   // 是否正在压缩中（防重入）
  hasCompacted: boolean;                 // 本 turn 是否已压缩过
  inCollapse: boolean;                   // 是否在 PTL collapse 处理中
  budgetContinuation: boolean;           // 是否在 budget continuation 模式
  providerSupportsExactTokenCount: boolean;  // 第三方 provider 是否有精确 token 计数
  userDisabledAutoCompact: boolean;      // 用户是否 /compact off
}): {
  shouldCompact: boolean;
  reason: 'approaching_limit' | 'skip_user_disabled' | 'skip_compacting' | 'skip_already_compacted' | 'skip_in_collapse' | 'skip_budget_continuation' | 'skip_conservative_estimate';
  triggerLayer?: 'L1_micro' | 'L2_session' | 'L3_api_summary';  // 触发哪一层压缩
}
```

- 6 个逃逸条件按短路求值：user_disabled → compacting → has_compacted → in_collapse → budget_continuation → conservative_estimate（无精确 token 计数则提前压缩）。
- 触发层级由 token 用量决定：< 70% 不触发 / 70-85% L1 MicroCompact / 85-95% L2 SessionMemory / > 95% L3 API 摘要。
- M2 收到 `shouldCompact=true` 后转 PTL_DEGRADE 状态（或直接触发压缩，视 reason 而定）。

---

## 5. 与其他模块的交互

| 交互模块 | 交互方式 | 数据/控制流 |
|---------|---------|------------|
| M1 模型抽象层 | 调用 | M2 CALL_LLM 状态调用 `LLMProvider.chatStream()`，消费 `ChatChunk` 流；`stop_reason` 决定 M2 分支 |
| M1 模型抽象层（降级） | 调用 | M2 检测 5xx/连续 stall 时，触发本模块降级 5 步，切换 `fallbackModel` 重发 |
| M3 通用工具系统 | 调用 | M2 TOOL_EXECUTE 状态触发工具调用（经 M4 拦截链），消费 `tool_result` |
| M4 权限与拦截系统 | 调用 | M2 TOOL_EXECUTE 状态先过 M4 五层纵深防御链（System Prompt → 权限 → 沙箱 → Plan → Hooks/预算），任一层 deny 则不执行 |
| M5 多 Agent 编排引擎 | 调用 | M2 通过 `agent_router` 工具触发 M5 路由（sync/async/fork/teammate/remote） |
| M7 上下文与记忆引擎 | 被调用 | M2 BUILD_CONTEXT 状态调用 M7 加载 system prompt + memory 召回 + tool 池；`ptl` stop_reason 委托 M7 PTL 紧急降级三步 |
| M7 上下文与记忆引擎（压缩） | 被调用 | M2 每轮结束后调用 M7 `shouldAutoCompact()` 判断是否触发压缩 |

---

## 6. 模块级非功能性需求

从总体 PRD §5 抽取与本模块相关的 NFR：

### 6.1 性能指标（摘自 §5.2.1）

| 指标 | 目标值 | 测量方式 |
|------|-------|---------|
| TTFT（首 token） | ≤ 2s | LLMProvider 埋点（M2 CALL_LLM → STREAM_RENDER 首 chunk） |
| 流式 stall 率 | ≤ 1% | stall_count / total_streams |
| 工具调用平均延迟（除 Bash/Web） | ≤ 1s | tool.call() 埋点（M2 TOOL_EXECUTE 状态） |

### 6.2 可靠性指标（摘自 §5.2.2）

| NFR | 目标值 |
|-----|-------|
| API 5xx 重试成功率（含 fallback model 降级） | ≥ 95% |
| PTL 紧急降级成功率 | 100% |
| autocompact 连续失败 circuit breaker | 3 次触发 |

### 6.3 护栏指标（摘自 §5.2.3）

| 护栏 | 目标值 | 为什么是护栏 |
|------|-------|------------|
| 流式 stall 率 | ≤ 1% | stall = 用户感知卡顿 |
| autocompact 连续失败 | ≤ 3 次 | 连续失败 = PTL 风险 |

---

## 7. 模块级不变量

从附录 A 18 项不变量中抽取与本模块相关的条目：

| # | 不变量 | 守护机制 |
|---|--------|---------|
| 3 | tool_use/tool_result 配对完整性 | `adjustIndexToPreserveAPIInvariants()` 强制修正；压缩时不能截断配对；无法修正则报错 |

**关联不变量**（由其他模块守护但本模块依赖）：
- #11 autocompact circuit breaker 3 次触发（M7 守护，M2 触发压缩时依赖）
- #12 PTL 紧急降级三步必走完（M7 守护，M2 识别 `ptl` 后委托 M7）

---

## 8. 开放问题与依赖

### 8.1 已冻结决策（M0）

| 决策 | 内容 | 影响 |
|------|------|------|
| C1 | Fallback model 链策略：同 provider 内自动降级（v1.0） | 本模块实现降级 5 步，`fallbackModel` 为单值字段；跨 provider chain 延后到 v2.x |

### 8.2 依赖其他模块的交付物

- M1 模型抽象层：`LLMProvider.chatStream()` 接口必须就绪，`stop_reason` 输出必须与本模块状态机分支匹配
- M7 上下文与记忆引擎：PTL 紧急降级三步实现（本模块识别 `ptl` 后委托 M7 执行 collapse_drain → reactive_compact → error）
- M4 权限与拦截系统：五层拦截链必须就绪，本模块 TOOL_EXECUTE 状态调用 M4 拦截链

### 8.3 评测集引用

本模块无直接评测集依赖。涉及 ReAct Loop 行为的验收（如 stall 率、PTL 降级成功率、降级 5 步重试成功率）通过 M1/M7 的端到端测试覆盖，不单独建评测集。

### 8.4 v2.x 演进项

- 跨 provider fallback chain：`fallbackChain` 数组，涉及多 provider 认证状态管理
- 主动 stall 检测的自适应阈值（根据历史 stall 率动态调整 90s 阈值）

---

## 9. 参考链接

- 总体 PRD：`omniagent-prd.md` §3.3
- 冻结决策记录：`omniagent-prd-decisions.md`（决策 C1）
- 相关模块：M1 模型抽象层、M3 通用工具系统、M4 权限与拦截系统、M5 多 Agent 编排引擎、M7 上下文与记忆引擎
- 里程碑：M1 Walking Skeleton（ReAct Loop 状态机必须就绪）
