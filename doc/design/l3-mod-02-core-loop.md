# OmniAgent CLI — L3 模块设计：M2 核心循环引擎 (Core Loop / ReAct)

> 模块 ID: M2
> 主负责角色: 架构师
> 阻塞里程碑: M1（Walking Skeleton）
> 源章节: 总体 PRD §3.3 + mod-02 PRD + L2 §4 + omniagent-types.ts §3/§11
> 状态: 草稿（2026-07-08）
> 文档定位: L3 模块级（PRD 是 L1 产品级，L2 是 L2 技术级，L3 是 L2 的细化到类/函数级）

---

## 文档定位与不重复原则

本文档是 M2 核心循环引擎的 L3 模块设计，**不重复** PRD mod-02 与 L2 §4 的已有内容，仅引用并补到类/函数级实施粒度：

- **PRD mod-02 §3.1 的 8 状态 ASCII 图** → 本文 §3.1 引用，补 FSMController 类实现 + 状态转换守卫代码
- **PRD mod-02 §4.1 的 11 种终止条件表** → 本文 §3.3 引用，补 TerminationHandler 类 + 每个分支的代码骨架
- **PRD mod-02 §4.2 的降级 5 步** → 本文 §3.4 引用，补 ModelDegrader 类 + 重试预算字段
- **PRD mod-02 §4.3 的 stall 检测** → 本文 §3.5 引用，补 StallDetector 类 + 双定时器实现
- **PRD mod-02 §3.3 的 abort 传播** → 本文 §3.6 引用 + L2 §4.3 的 3 种竞态场景
- **L2 §4.1.1 的状态转换表** → 本文 §3.2 引用，补 FSMController.transition() 代码
- **L2 §4.2 的 6 个时序图** → 本文不复制，仅在 §3 各小节标注"对应 L2 §4.2.x"
- **L2 §4.3 的 abort 竞态处理** → 本文 §3.6 引用，补 AbortCoordinator 类 + 3 种场景代码
- **L2 §6 的 26 个错误码** → 本文 §5.1 引用，补 M2 触发的错误码子集 + 降级路径
- **L2 §11 的 M1 三迭代交付物** → 本文 §7 引用，补 M2 在每迭代交付的组件

---

## 1. 模块概述

### 1.1 范围（引用 PRD §1.1，不重复）

M2 负责定义并实现 ReAct Loop 有限状态机，覆盖 PRD mod-02 §1.1 列出的 6 项 in-scope：

1. 8 状态 FSM（IDLE / BUILD_CONTEXT / CALL_LLM / STREAM_RENDER / EVAL_STOP_REASON / TOOL_EXECUTE / PTL_DEGRADE / END_TURN）
2. 11 种终止条件处理（end_turn / tool_use / max_output_tokens / ptl / user_interrupt / stall_passive_30s / stall_active_90s / provider_5xx / provider_429 / tool_execution_error / budget_exceeded）
3. 模型降级 5 步（同 provider 内 fallback，决策 C1）
4. 流式 stall 检测（被动 30s + 主动 90s）
5. abort 信号传播（用户中断时不留僵尸进程）
6. tool_use/tool_result 配对完整性守护（不变量 #3，M2 触发 + M7 修正）

### 1.2 边界（引用 PRD §1.2，不重复）

M2 只做"循环调度"，不做具体执行。边界严格遵循 PRD mod-02 §1.2：

- **LLM 调用本身** → M1 LLMProvider.chatStream()，M2 只消费 ChatChunk 流 + stop_reason
- **工具执行细节** → M3 通用工具系统，M2 在 TOOL_EXECUTE 状态触发 M4 拦截链后调 M3 tool.call()
- **上下文压缩 + PTL 降级策略** → M7 上下文与记忆引擎；M2 只识别 `ptl` stop_reason 并转 PTL_DEGRADE 分支委托 M7
- **权限/沙箱/Hooks 链** → M4 权限与拦截系统，M2 在 TOOL_EXECUTE 状态调 M4.intercept() 链
- **agent_router spawn/teammate 管理** → M5 编排引擎；M2 把 `agent_router` 工具调用当普通 tool_use 走 TOOL_EXECUTE

### 1.3 在整体架构中的位置（引用 L2 §1，不重复）

ReAct Loop 是 harness 层的**心脏**，所有交互模式（终端 Ink / Headless / IDE / Remote Server）共享同一套状态机。L2 §1 已部署形态全景图与进程模型，本文不复制。

M2 在四层解耦架构中的位置：

| 层 | 模块 | 职责 |
|----|------|------|
| UI 层 | M6 Skills 中的交互类 skill + Ink 渲染层 | 用户输入捕获、流式渲染 |
| **Harness 层** | **M2 Core Loop** | **ReAct FSM + 终止条件 + 降级 + stall + abort** |
| LLM 层 | M1 LLM Abstraction | provider 适配 + SSE 解析 + chunk 归一化 |
| Tool 层 | M3/M4/M5/M6/M7 | 工具执行 + 权限 + 编排 + Skills + 记忆 |

---

## 2. 组件清单

### 2.1 组件总览

| # | 组件 | 类型 | 文件路径 | 职责 |
|---|------|------|---------|------|
| 1 | `ReActState` | enum | `omniagent-types.ts` §3 | 8 状态枚举（**本文新增**，见 §2.2.1） |
| 2 | `StopReason` | type | `omniagent-types.ts` §3 | 11 种终止原因（已定义） |
| 3 | `Message` / `ContentBlock` / `ToolUseBlock` / `ToolResultBlock` | interface | `omniagent-types.ts` §3 | 消息格式（已定义） |
| 4 | `ChatRequest` / `ChatChunk` / `ChatResponse` | interface | `omniagent-types.ts` §3 | LLM 调用接口（已定义） |
| 5 | `LLMProvider` / `Capabilities` | interface | `omniagent-types.ts` §5 | provider 接口（M1 定义，M2 消费） |
| 6 | `ToolContext` / `Tool` / `ToolResult` | interface | `omniagent-types.ts` §7 | 工具接口（M3 定义，M2 消费） |
| 7 | `ShouldAutoCompactFn` | type | `omniagent-types.ts` §11 | 压缩判断跨模块函数（M7 实现/M2 调用） |
| 8 | `AdjustIndexToPreserveAPIInvariantsFn` | type | `omniagent-types.ts` §11 | 配对保护跨模块函数（M7 实现/M2 调用） |
| 9 | `OmniAgentError` / `OmniAgentErrorCode` | interface/type | `omniagent-types.ts` §19 | 错误模型（已定义） |
| 10 | `ReActLoop` | class | `src/core/react-loop.ts` | 主循环 orchestrator（一轮对话的入口） |
| 11 | `FSMController` | class | `src/core/fsm.ts` | 状态机控制器（状态转换 + 守卫条件） |
| 12 | `TerminationHandler` | class | `src/core/termination.ts` | 11 种 stop_reason 分支处理 |
| 13 | `ModelDegrader` | class | `src/core/degrader.ts` | 5 步降级（C1 同 provider fallback） |
| 14 | `StallDetector` | class | `src/core/stall.ts` | 被动 30s + 主动 90s 双定时器 |
| 15 | `AbortCoordinator` | class | `src/core/abort.ts` | abort 信号传播 + 3 种竞态处理 |
| 16 | `BudgetGuard` | class | `src/core/budget.ts` | 预算跟踪 + budget_exceeded 终止 |
| 17 | `StreamRenderer` | interface | `src/core/renderer.ts` | 渲染契约（UI 层实现） |
| 18 | `ReActLoopContext` | interface | `src/core/context.ts` | 单轮上下文（messages、pending tool_results、traceId） |
| 19 | `IterationLimiter` | class | `src/core/iteration-limiter.ts` | 重试预算（429 最多 3 次 / 5xx 降级最多 1 次） |
| 20 | `ToolUsePairGuard` | class | `src/core/pairing-guard.ts` | M2 侧配对完整性守护（调 M7 adjust） |
| 21 | `AutoCompactChecker` | class | `src/core/autocompact-checker.ts` | M2 侧压缩判断（调 M7 shouldAutoCompact） |
| 22 | `TaskRunner` | class | `src/core/runner.ts` | 顶层入口（CLI/Remote/Daemon 共用） |

### 2.2 公共接口签名

#### 2.2.1 `ReActState`（**本文新增到 types.ts §3**）

```typescript
// ============================================================
// 3.x ReAct Loop 状态（mod-02 §3.1，本文新增到 types.ts §3 末尾）
// ============================================================

/** ReAct Loop 8 状态（mod-02 §3.1） */
export type ReActState =
  | 'IDLE'              // 等待用户输入
  | 'BUILD_CONTEXT'     // 加载 system prompt + memory + tool 池
  | 'CALL_LLM'          // 调用 LLMProvider.chatStream()
  | 'STREAM_RENDER'     // 流式渲染 chunk 到 UI
  | 'EVAL_STOP_REASON'  // 判断 stop_reason 分支
  | 'TOOL_EXECUTE'      // 执行工具（经 M4 五层拦截链）
  | 'PTL_DEGRADE'       // PTL 紧急降级三步（委托 M7）
  | 'END_TURN';         // 等待下一轮 user_input

/** 状态转换触发事件（FSMController.transition 入参） */
export type ReActEvent =
  | { type: 'user_input'; text: string; traceId: TraceId }
  | { type: 'context_ready'; systemPrompt: string[]; tools: Tool[]; recalledMemories: Memory[] }
  | { type: 'context_error'; error: OmniAgentError }
  | { type: 'first_chunk'; chunk: ChatChunk }
  | { type: 'stall_passive_30s' }
  | { type: 'stall_active_90s' }
  | { type: 'provider_5xx'; retryAfterMs?: number }
  | { type: 'provider_429'; retryAfterMs?: number }
  | { type: 'stream_end'; message: Message; stopReason: StopReason; tokenUsage: TokenUsage }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'permission_deny'; layer: 1 | 2 | 3 | 4 | 5 | 'm3_security'; reason: string }
  | { type: 'abort_signal'; reason: string }
  | { type: 'budget_exceeded'; remaining: number }
  | { type: 'degrade_success'; compactedBoundaryId?: BoundaryId }
  | { type: 'degrade_failed'; reason: string };

/** 状态转换守卫条件检查结果 */
export interface GuardCheckResult {
  ok: boolean;
  /** 守卫失败时走 fallback 分支（不进入"中间态"） */
  fallback?: { event: ReActEvent; reason: string };
  /** 记入审计日志的错误（如有） */
  auditError?: { code: OmniAgentErrorCode; message: string };
}
```

#### 2.2.2 `ReActLoop`

```typescript
class ReActLoop {
  constructor(
    private provider: LLMProvider,           // M1 注入
    private toolPool: ToolPool,               // M3 注入（mergeAndFilterTools 由 M3 实现）
    private interception: InterceptionChain, // M4 注入（五层拦截链）
    private memoryEngine: MemoryEngine,      // M7 注入（system prompt + 召回 + 压缩 + PTL）
    private orchestrator: Orchestrator,      // M5 注入（agent_router spawn）
    private renderer: StreamRenderer,        // UI 层注入
    private budgetGuard: BudgetGuard,
    private iterLimiter: IterationLimiter,
    private pairGuard: ToolUsePairGuard,
    private autoCompactChecker: AutoCompactChecker,
    private abortCoord: AbortCoordinator,
    private fsm: FSMController,
    private termination: TerminationHandler,
    private degrader: ModelDegrader,
    private stallDetector: StallDetector,
  ) {}

  /** 单轮入口（用户输入 → END_TURN） */
  async runTurn(input: { text: string; sessionId: SessionId; traceId: TraceId }): Promise<TurnResult> {
    // 1. IDLE → BUILD_CONTEXT
    // 2. BUILD_CONTEXT → CALL_LLM（M7 加载 + M3 工具池）
    // 3. CALL_LLM → STREAM_RENDER（M1 流式 + StallDetector 启动）
    // 4. STREAM_RENDER → EVAL_STOP_REASON（M1 message_end）
    // 5. EVAL_STOP_REASON 分发（11 种 stop_reason 分支）
    // 6. TOOL_EXECUTE → CALL_LLM（tool_result 回注 + shouldAutoCompact 检查）
    // 7. PTL_DEGRADE → CALL_LLM（M7 三步降级成功）或 END_TURN（失败）
    // 8. END_TURN → 等下一轮
  }

  /** 用户中断（Ctrl+C / /exit / budget 软提醒取消） */
  async handleUserInterrupt(reason: string): Promise<void> {
    await this.abortCoord.abortAll(reason);
  }
}

interface TurnResult {
  stopReason: StopReason;
  finalMessage?: Message;
  /** 本轮 tool_use 数量 */
  toolUseCount: number;
  /** 本轮 token 用量 */
  tokenUsage: TokenUsage;
  /** 本轮成本估算 */
  costEstimate: CostEstimate;
  /** 是否被中断 */
  interrupted: boolean;
  /** 是否触发了压缩 */
  compactedBoundaryId?: BoundaryId;
}
```

#### 2.2.3 `FSMController`

```typescript
class FSMController {
  private currentState: ReActState = 'IDLE';
  private transitionLog: Array<{ from: ReActState; to: ReActState; event: ReActEvent; ts: ISO8601Timestamp }> = [];

  /** 当前状态（只读） */
  get state(): ReActState { return this.currentState; }

  /**
   * 状态转换（带守卫条件检查）
   * 引用 L2 §4.1.1 状态转换表
   */
  async transition(event: ReActEvent): Promise<ReActState> {
    const guard = this.checkGuard(this.currentState, event);
    if (!guard.ok && guard.fallback) {
      this.audit(guard.auditError);
      return this.transition(guard.fallback.event);
    }
    if (!guard.ok) {
      // 不应发生（fallback 必须提供），fail-closed 到 END_TURN
      this.currentState = 'END_TURN';
      this.logTransition(event, 'END_TURN', 'guard_failed_no_fallback');
      return 'END_TURN';
    }
    const next = this.nextState(this.currentState, event);
    this.logTransition(event, next);
    this.currentState = next;
    return next;
  }

  /** 守卫条件检查（L2 §4.1.2） */
  private checkGuard(from: ReActState, event: ReActEvent): GuardCheckResult {
    switch (from) {
      case 'BUILD_CONTEXT':
        if (event.type === 'context_ready') {
          // 守卫：systemPrompt.length > 0 && tools.length > 0
          if (event.systemPrompt.length === 0 || event.tools.length === 0) {
            return { ok: false, fallback: { event: { type: 'context_error', error: {/*...*/} }, reason: 'empty_context' } };
          }
        }
        return { ok: true };
      case 'CALL_LLM':
        if (event.type === 'first_chunk') {
          // 守卫：首 chunk 在 30s 内到达（StallDetector 已检查）
          return { ok: true };
        }
        return { ok: true };
      case 'EVAL_STOP_REASON':
        if (event.type === 'stream_end' && event.stopReason === 'tool_use') {
          // 守卫：至少 1 个 tool_use 块
          const hasToolUse = event.message.content.some(c => c.type === 'tool_use');
          if (!hasToolUse) {
            return { ok: false, fallback: { event: { type: 'stream_end', message: event.message, stopReason: 'end_turn' as StopReason, tokenUsage: event.tokenUsage }, reason: 'no_tool_use_block' } };
          }
        }
        return { ok: true };
      case 'TOOL_EXECUTE':
        if (event.type === 'tool_result') {
          // 守卫：tool_result.tool_use_id 必须配对（不变量 #3，M2 侧检查）
          // M7 侧 adjustIndexToPreserveAPIInvariants 在压缩时调用
          if (!this.pairGuard.checkPairing(event.result)) {
            return { ok: false, auditError: { code: 'INVARIANT_VIOLATION_TOOL_USE_PAIRING', message: 'tool_result without matching tool_use' } };
          }
        }
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  private nextState(from: ReActState, event: ReActEvent): ReActState {
    // 实现 L2 §4.1.1 状态转换表的 next_state 列
    // ...
  }

  private logTransition(event: ReActEvent, to: ReActState, reason?: string): void {
    this.transitionLog.push({ from: this.currentState, to, event, ts: new Date().toISOString() });
    // 同时记 tracing span（operation: `react_loop.${from}.${to}`）
  }

  private audit(error?: { code: OmniAgentErrorCode; message: string }): void { /* ... */ }
}
```

#### 2.2.4 `TerminationHandler`

```typescript
class TerminationHandler {
  constructor(
    private degrader: ModelDegrader,
    private pairGuard: ToolUsePairGuard,
    private autoCompactChecker: AutoCompactChecker,
    private memoryEngine: MemoryEngine,  // PTL 委托
    private budgetGuard: BudgetGuard,
    private abortCoord: AbortCoordinator,
  ) {}

  /**
   * 处理 11 种 stop_reason（PRD mod-02 §4.1）
   * @returns 下一个状态（CALL_LLM / TOOL_EXECUTE / PTL_DEGRADE / END_TURN）
   */
  async handle(params: {
    stopReason: StopReason;
    message: Message;
    tokenUsage: TokenUsage;
    ctx: ReActLoopContext;
  }): Promise<{ nextState: ReActState; sideEffect?: () => Promise<void> }> {
    switch (params.stopReason) {
      case 'end_turn':
        return { nextState: 'END_TURN' };

      case 'tool_use':
        return { nextState: 'TOOL_EXECUTE' };

      case 'max_output_tokens':
        // 两阶段升级：slot 优化 → context window
        await this.handleMaxOutputTokens(params.ctx);
        return { nextState: 'CALL_LLM' };

      case 'ptl':
        // 委托 M7 PTL 三步
        return { nextState: 'PTL_DEGRADE' };

      case 'user_interrupt':
        // 保留状态，可 resume
        return { nextState: 'END_TURN', sideEffect: async () => this.abortCoord.markAborted(params.ctx) };

      case 'stall_passive_30s':
        // 重发请求（同 model）
        return { nextState: 'CALL_LLM' };

      case 'stall_active_90s':
        // 切非流式 chat() 降级
        await this.degrader.switchToNonStreaming(params.ctx);
        return { nextState: 'CALL_LLM' };

      case 'provider_5xx':
        // 降级 5 步（同 provider fallback，最多重试 1 次）
        const degraded = await this.degrader.degrade5xx(params.ctx);
        return degraded ? { nextState: 'CALL_LLM' } : { nextState: 'END_TURN' };

      case 'provider_429':
        // 退避重试（指数退避，最多 3 次）
        const retried = await this.degrader.retry429(params.ctx);
        return retried ? { nextState: 'CALL_LLM' } : { nextState: 'END_TURN' };

      case 'tool_execution_error':
        // tool_result 标 is_error，回注 LLM 决策
        return { nextState: 'CALL_LLM' };

      case 'budget_exceeded':
        // 软提醒，让用户确认是否继续
        await this.budgetGuard.notifyUser(params.ctx);
        return { nextState: 'END_TURN' };
    }
  }

  private async handleMaxOutputTokens(ctx: ReActLoopContext): Promise<void> { /* 两阶段升级 */ }
}
```

#### 2.2.5 `ModelDegrader`

```typescript
class ModelDegrader {
  constructor(
    private provider: LLMProvider,
    private iterLimiter: IterationLimiter,
  ) {}

  /**
   * 5xx 降级 5 步（PRD mod-02 §4.2，决策 C1）
   * 1. 检测 5xx 或连续 stall
   * 2. 清空当前 assistant 消息
   * 3. 切换 fallbackModel（同 provider）
   * 4. 重新发送
   * 5. 若仍失败，报错（不无限重试）
   */
  async degrade5xx(ctx: ReActLoopContext): Promise<boolean> {
    if (!this.iterLimiter.canRetry('5xx')) {
      this.iterLimiter.reportFailure('5xx_max_retry_exceeded');
      return false;
    }
    // Step 2: 清空 partial assistant 消息
    ctx.clearPartialAssistant();
    // Step 3: 切 fallbackModel（同 provider）
    if (!ctx.fallbackModel) {
      this.iterLimiter.reportFailure('no_fallback_model');
      return false;
    }
    ctx.switchToModel(ctx.fallbackModel);
    // Step 4: 重发由 ReActLoop 重新进入 CALL_LLM 状态完成
    this.iterLimiter.consumeRetry('5xx');
    return true;
  }

  /** 429 退避重试（指数退避，最多 3 次） */
  async retry429(ctx: ReActLoopContext, retryAfterMs?: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.iterLimiter.canRetry('429')) return false;
      const delay = retryAfterMs ?? Math.min(1000 * Math.pow(2, attempt), 8000);
      await sleep(delay);
      this.iterLimiter.consumeRetry('429');
      // 重发由 ReActLoop 重新进入 CALL_LLM 完成
      return true;
    }
    return false;
  }

  /** 90s stall 后切非流式降级 */
  async switchToNonStreaming(ctx: ReActLoopContext): Promise<void> {
    ctx.switchToNonStreaming();
  }
}
```

#### 2.2.6 `StallDetector`

```typescript
class StallDetector {
  private passiveTimer?: NodeJS.Timeout;  // 30s 无 chunk
  private activeTimer?: NodeJS.Timeout;   // 90s 流未结束
  private lastChunkAt?: ISO8601Timestamp;
  private streamStartedAt?: ISO8601Timestamp;
  private stallCount = 0;
  private totalStreams = 0;

  /** 启动流式 stall 检测（CALL_LLM 进入时） */
  start(abortSignal: AbortSignal, onPassiveStall: () => void, onActiveStall: () => void): void {
    this.streamStartedAt = new Date().toISOString();
    this.lastChunkAt = this.streamStartedAt;
    this.totalStreams++;

    this.passiveTimer = setTimeout(() => {
      // 30s 内无任何 chunk
      onPassiveStall();
      this.stallCount++;
    }, 30_000);

    this.activeTimer = setTimeout(() => {
      // 90s 内流未结束
      onActiveStall();
      this.stallCount++;
    }, 90_000);

    abortSignal.addEventListener('abort', () => this.stop());
  }

  /** 收到 chunk 时更新 lastChunkAt（重置 passive 定时器） */
  touch(): void {
    this.lastChunkAt = new Date().toISOString();
    if (this.passiveTimer) {
      clearTimeout(this.passiveTimer);
      this.passiveTimer = setTimeout(() => { /* onPassiveStall */ }, 30_000);
    }
  }

  /** 流结束 / abort 时停止检测 */
  stop(): void {
    if (this.passiveTimer) clearTimeout(this.passiveTimer);
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.passiveTimer = undefined;
    this.activeTimer = undefined;
  }

  /** stall 率（≤ 1% 护栏，PRD mod-02 §6.1） */
  get stallRate(): number {
    return this.totalStreams === 0 ? 0 : this.stallCount / this.totalStreams;
  }
}
```

#### 2.2.7 `AbortCoordinator`

```typescript
class AbortCoordinator {
  private controller: AbortController = new AbortController();
  private aborted = false;
  private abortReason?: string;

  /** 用户中断（Ctrl+C / /exit / budget 软提醒取消） */
  async abortAll(reason: string): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;
    this.controller.abort();
    // 信号同步传给：
    // - LLMProvider.chatStream()（通过 ChatRequest.abortSignal）
    // - M3 tool.call()（通过 ToolContext.abortSignal）
    // - M5 agent_router spawn 的子 agent（通过 spawn 参数）
    // **不传给**：其他独立 teammate（需经 M5 shutdown_request 四步握手，L2 §4.3.2 场景 C）
  }

  /** 获取信号（注入到 LLMProvider / 工具 / 子 agent） */
  get signal(): AbortSignal { return this.controller.signal; }

  get isAborted(): boolean { return this.aborted; }
  get reason(): string | undefined { return this.abortReason; }

  /**
   * 处理 3 种竞态场景（L2 §4.3）
   */
  async handleRace(params: {
    scenario: 'A' | 'B' | 'C';
    ctx: ReActLoopContext;
    pendingToolResult?: ToolResult;
    teammateId?: AgentId;
  }): Promise<void> {
    switch (params.scenario) {
      case 'A':
        // LLM 已返回但工具未完成时 abort
        // abort 信号传给工具（已结束的 LLM no-op）
        // 工具返回 is_error=true + "aborted by user"
        // M2 走 user_interrupt 分支，不回注 LLM
        params.ctx.markPendingToolAsAborted();
        break;
      case 'B':
        // abort 与 tool_result 配对完整性冲突
        // 已在队列：丢弃；未在队列：等待后丢弃
        // 不变量 #3 不破坏（transcript 中 tool_use 与 tool_result 都标记 aborted=true）
        if (params.pendingToolResult) {
          params.ctx.discardPendingToolResult(params.pendingToolResult.tool_use_id);
        }
        break;
      case 'C':
        // 多 agent 中 abort 一个
        // 主 agent 的 abort 不自动传给 teammate
        // 主 agent 通过 M5 shutdown_request 通知 teammate（四步握手，不强杀）
        if (params.teammateId) {
          await this.orchestrator.sendShutdownRequest(params.teammateId, params.ctx);
        }
        break;
    }
  }

  /** 重置（下一轮 runTurn 开始时） */
  reset(): void {
    this.controller = new AbortController();
    this.aborted = false;
    this.abortReason = undefined;
  }
}
```

#### 2.2.8 `ToolUsePairGuard`（M2 侧配对完整性守护，不变量 #3）

```typescript
class ToolUsePairGuard {
  constructor(
    // M7 实现的跨模块函数（types.ts §11）
    private adjustFn: AdjustIndexToPreserveAPIInvariantsFn,
  ) {}

  /**
   * M2 侧配对检查（每次 tool_result 进入 transcript 前）
   * 注意：M2 不做"修正"，只做"检查 + 拒绝"
   * 修正（adjustIndexToPreserveAPIInvariants）只在 M7 压缩时调用
   */
  checkPairing(toolResult: ToolResult, ctx: ReActLoopContext): boolean {
    const matchingToolUse = ctx.findToolUseById(toolResult.tool_use_id);
    if (!matchingToolUse) {
      // 不变量 #3 违反：tool_result 无配对 tool_use
      // fail-closed：拒绝写入 transcript，报错
      this.auditViolation(toolResult.tool_use_id);
      return false;
    }
    return true;
  }

  /**
   * M2 压缩前调用 M7 adjust（确保压缩区间不破坏配对）
   * 此方法仅在 M2 触发 shouldAutoCompact=true 后、调 M7 压缩前调用
   */
  async adjustBeforeCompact(messages: Message[], compactRange: { start: number; end: number }) {
    const result = this.adjustFn({ messages, compactRange });
    if (result.error) {
      // 无法修正：fail-closed 报错
      throw new OmniAgentError({
        code: 'INVARIANT_VIOLATION_TOOL_USE_PAIRING',
        message: result.error.reason,
      });
    }
    return result;
  }

  private auditViolation(toolUseId: ToolUseId): void { /* 记审计日志 */ }
}
```

#### 2.2.9 `AutoCompactChecker`（M2 侧压缩判断）

```typescript
class AutoCompactChecker {
  constructor(
    // M7 实现的跨模块函数（types.ts §11）
    private shouldAutoCompactFn: ShouldAutoCompactFn,
    private provider: LLMProvider,
  ) {}

  /**
   * 每轮结束后调用（PRD mod-02 §4.4）
   * @returns shouldCompact + triggerLayer
   */
  check(ctx: ReActLoopContext): ShouldAutoCompactResult {
    const tokenCount = ctx.estimateTokenCount(this.provider);
    return this.shouldAutoCompactFn({
      messages: ctx.messages,
      tokenCount: tokenCount.inputTokens,
      maxContextWindow: this.provider.capabilities.maxContextWindow,
      compacting: ctx.compacting,
      hasCompacted: ctx.hasCompactedThisTurn,
      inCollapse: ctx.inCollapse,
      budgetContinuation: ctx.budgetContinuation,
      providerSupportsExactTokenCount: this.provider.capabilities.tokenCountAccuracy === 'exact',
      userDisabledAutoCompact: ctx.userDisabledAutoCompact,
    });
  }

  /**
   * M2 收到 shouldCompact=true 后的处理：
   * - reason='approaching_limit' → 转 PTL_DEGRADE 或直接触发 M7 压缩
   * - reason='skip_*' → 不压缩，继续 CALL_LLM
   */
  shouldTransitionToPtlDegrade(result: ShouldAutoCompactResult): boolean {
    return result.shouldCompact && result.reason === 'approaching_limit';
  }
}
```

#### 2.2.10 `BudgetGuard`

```typescript
class BudgetGuard {
  private spentUsd = 0;
  private tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(
    private limitUsd: number,        // 用户配置的预算上限
    private warnThresholdUsd: number, // 软提醒阈值（默认 80%）
    private provider: LLMProvider,
  ) {}

  /** 记录本轮成本（runTurn 结束时调用） */
  record(usage: TokenUsage): void {
    this.tokenUsage.inputTokens += usage.inputTokens;
    this.tokenUsage.outputTokens += usage.outputTokens;
    const cost = this.provider.estimateCost(usage);
    this.spentUsd += cost.usd;
  }

  /** 检查是否超预算（EVAL_STOP_REASON 状态调用） */
  check(): { exceeded: boolean; remaining: number; warning: boolean } {
    const remaining = this.limitUsd - this.spentUsd;
    return {
      exceeded: this.spentUsd >= this.limitUsd,
      remaining,
      warning: this.spentUsd >= this.warnThresholdUsd,
    };
  }

  /** 软提醒（不强制终止，让用户确认） */
  async notifyUser(ctx: ReActLoopContext): Promise<void> {
    // 通过 renderer 输出软提醒
    ctx.renderer.renderBudgetWarning(this.spentUsd, this.limitUsd);
  }
}
```

#### 2.2.11 `StreamRenderer`（渲染契约）

```typescript
/**
 * UI 层实现的渲染契约（终端 Ink / Headless / IDE / Remote 都实现此接口）
 * M2 不关心具体渲染方式，只关心契约
 */
interface StreamRenderer {
  /** 渲染文本 chunk（STREAM_RENDER 状态） */
  renderTextDelta(text: string): void;
  /** 渲染 tool_use 开始（STREAM_RENDER 状态，工具调用块开始） */
  renderToolUseStart(id: ToolUseId, name: string): void;
  /** 渲染 tool_use 输入流（STREAM_RENDER 状态，工具调用块输入） */
  renderToolUseDelta(id: ToolUseId, input: ToolInput): void;
  /** 渲染 tool_use 结束（STREAM_RENDER 状态） */
  renderToolUseEnd(id: ToolUseId): void;
  /** 渲染错误（任意状态） */
  renderError(error: OmniAgentError): void;
  /** 渲染预算软提醒（budget_exceeded 终止时） */
  renderBudgetWarning(spentUsd: number, limitUsd: number): void;
  /** 渲染中断（abort_signal 终止时） */
  renderInterrupted(reason: string): void;
}
```

#### 2.2.12 `ReActLoopContext`（单轮上下文）

```typescript
interface ReActLoopContext {
  sessionId: SessionId;
  traceId: TraceId;
  messages: Message[];                    // 当前消息数组（含 user/assistant/tool）
  systemPromptBlocks: string[];           // M7 buildSystemPromptBlocks 输出
  tools: Tool[];                          // M3 mergeAndFilterTools 输出
  model: string;                          // 当前模型 ID
  fallbackModel?: string;                 // 同 provider fallback（C1 决策）
  compacting: boolean;                    // 是否正在压缩（防重入）
  hasCompactedThisTurn: boolean;
  inCollapse: boolean;                    // 是否在 PTL collapse 处理中
  budgetContinuation: boolean;
  userDisabledAutoCompact: boolean;
  renderer: StreamRenderer;
  /** partial assistant 消息（stall/abort 时用于清理） */
  partialAssistant?: Message;
  /** pending tool_results（abort 与 tool_result 竞态时用） */
  pendingToolResults: Map<ToolUseId, ToolResult>;

  // 方法
  clearPartialAssistant(): void;
  switchToModel(model: string): void;
  switchToNonStreaming(): void;
  markPendingToolAsAborted(): void;
  discardPendingToolResult(toolUseId: ToolUseId): void;
  findToolUseById(id: ToolUseId): ToolUseBlock | undefined;
  estimateTokenCount(provider: LLMProvider): TokenCount;
}
```

#### 2.2.13 `IterationLimiter`

```typescript
class IterationLimiter {
  private readonly limits = {
    '5xx': 1,     // 5xx 降级最多重试 1 次（PRD mod-02 §4.2）
    '429': 3,     // 429 退避重试最多 3 次
    'stall_passive': 1,  // 被动 stall 重发最多 1 次
    'stall_active': 1,   // 主动 stall 切非流式最多 1 次
  };
  private consumed: Record<string, number> = { '5xx': 0, '429': 0, stall_passive: 0, stall_active: 0 };

  canRetry(kind: keyof typeof this.limits): boolean {
    return this.consumed[kind] < this.limits[kind];
  }

  consumeRetry(kind: keyof typeof this.limits): void {
    this.consumed[kind]++;
  }

  /** 每轮 runTurn 开始时重置（重试预算按"轮"算，不跨轮累积） */
  reset(): void {
    this.consumed = { '5xx': 0, '429': 0, stall_passive: 0, stall_active: 0 };
  }

  reportFailure(reason: string): void {
    // 记审计日志 + tracing span
  }
}
```

#### 2.2.14 `TaskRunner`

```typescript
/**
 * 顶层入口（CLI / Remote Server / Daemon 三种部署形态共用）
 * 负责 session 生命周期管理 + 多轮 ReActLoop 调度
 */
class TaskRunner {
  constructor(
    private reactLoop: ReActLoop,
    private memoryEngine: MemoryEngine,    // 加载 session transcript + resume
    private budgetGuard: BudgetGuard,
    private iterLimiter: IterationLimiter,
    private abortCoord: AbortCoordinator,
  ) {}

  /**
   * 运行一个完整 session（多轮）
   * @param sessionId 可选，若提供则从 transcript resume
   */
  async runSession(params: {
    sessionId?: SessionId;
    initialInput: string;
    permissionMode: PermissionMode;
    budgetUsd: number;
  }): Promise<void> {
    let sessionId = params.sessionId;
    if (!sessionId) {
      sessionId = await this.memoryEngine.createSession();
    } else {
      await this.memoryEngine.resumeSession(sessionId);
    }

    let userInput = params.initialInput;
    while (true) {
      this.iterLimiter.reset();
      this.abortCoord.reset();

      const traceId = generateTraceId();
      const result = await this.reactLoop.runTurn({
        text: userInput,
        sessionId,
        traceId,
      });

      this.budgetGuard.record(result.tokenUsage);

      if (result.stopReason === 'end_turn' || result.interrupted) {
        // 等下一轮 user_input
        userInput = await this.waitForNextInput();
        if (!userInput) break;  // 用户 /exit
      } else {
        // 异常终止（如 budget_exceeded 用户拒绝继续）
        break;
      }
    }

    await this.memoryEngine.flushSession(sessionId);
  }

  private async waitForNextInput(): Promise<string | undefined> { /* ... */ }
}
```

---

## 3. 详细设计

### 3.1 ReActLoop 主循环（引用 PRD §3.1 + L2 §4.1，不重复）

PRD mod-02 §3.1 给出 8 状态的 ASCII 图，L2 §4.1.1 给出形式化的状态转换表（26 条转换规则）。本节补 ReActLoop.runTurn() 的代码骨架，把 FSM + 11 种终止条件 + 5 步降级 + stall + abort + 配对保护串起来。

#### 3.1.1 runTurn 主流程

```typescript
async runTurn(input: { text: string; sessionId: SessionId; traceId: TraceId }): Promise<TurnResult> {
  const ctx = this.createContext(input);
  let result: TurnResult;

  // 状态机循环
  while (this.fsm.state !== 'END_TURN') {
    switch (this.fsm.state) {
      case 'IDLE':
        await this.fsm.transition({ type: 'user_input', text: input.text, traceId: input.traceId });
        break;

      case 'BUILD_CONTEXT':
        await this.handleBuildContext(ctx);
        break;

      case 'CALL_LLM':
        await this.handleCallLlm(ctx);
        break;

      case 'STREAM_RENDER':
        await this.handleStreamRender(ctx);
        break;

      case 'EVAL_STOP_REASON':
        await this.handleEvalStopReason(ctx);
        break;

      case 'TOOL_EXECUTE':
        await this.handleToolExecute(ctx);
        break;

      case 'PTL_DEGRADE':
        await this.handlePtlDegrade(ctx);
        break;
    }

    if (this.abortCoord.isAborted) {
      // 用户中断：保留状态，转 END_TURN
      await this.fsm.transition({ type: 'abort_signal', reason: this.abortCoord.reason ?? 'unknown' });
    }
  }

  result = this.collectTurnResult(ctx);
  this.budgetGuard.record(result.tokenUsage);
  return result;
}
```

#### 3.1.2 BUILD_CONTEXT 处理

```typescript
private async handleBuildContext(ctx: ReActLoopContext): Promise<void> {
  try {
    // M7 加载 system prompt + memory 召回
    const { systemPromptBlocks, recalledMemories } = await this.memoryEngine.buildContext({
      query: ctx.userInput,
      tools: ctx.tools,
      sessionId: ctx.sessionId,
    });
    // M3 工具池组装
    const filteredTools = this.toolPool.mergeAndFilterTools({
      role: 'main',
      permissionMode: ctx.permissionMode,
    });
    ctx.systemPromptBlocks = systemPromptBlocks;
    ctx.tools = filteredTools.tools;
    await this.fsm.transition({
      type: 'context_ready',
      systemPrompt: systemPromptBlocks,
      tools: filteredTools.tools,
      recalledMemories,
    });
  } catch (err) {
    await this.fsm.transition({
      type: 'context_error',
      error: this.toOmniAgentError(err),
    });
  }
}
```

#### 3.1.3 CALL_LLM 处理（含 stall 检测启动）

```typescript
private async handleCallLlm(ctx: ReActLoopContext): Promise<void> {
  this.stallDetector.start(
    this.abortCoord.signal,
    () => this.fsm.transition({ type: 'stall_passive_30s' }),
    () => this.fsm.transition({ type: 'stall_active_90s' }),
  );

  try {
    const stream = this.provider.chatStream({
      messages: ctx.messages,
      systemPromptBlocks: ctx.systemPromptBlocks,
      tools: ctx.tools,
      model: ctx.model,
      fallbackModel: ctx.fallbackModel,
      abortSignal: this.abortCoord.signal,
      traceId: ctx.traceId,
    });

    let firstChunkReceived = false;
    for await (const chunk of stream) {
      if (!firstChunkReceived) {
        firstChunkReceived = true;
        await this.fsm.transition({ type: 'first_chunk', chunk });
        // 进入 STREAM_RENDER 状态
      }
      this.stallDetector.touch();
      await this.handleChunk(chunk, ctx);
    }
  } catch (err) {
    if (err.code === 'PROVIDER_5XX') {
      await this.fsm.transition({ type: 'provider_5xx', retryAfterMs: err.retryAfterMs });
    } else if (err.code === 'PROVIDER_429') {
      await this.fsm.transition({ type: 'provider_429', retryAfterMs: err.retryAfterMs });
    } else {
      throw err;
    }
  } finally {
    this.stallDetector.stop();
  }
}
```

#### 3.1.4 STREAM_RENDER 处理（chunk 分发）

```typescript
private async handleChunk(chunk: ChatChunk, ctx: ReActLoopContext): Promise<void> {
  switch (chunk.type) {
    case 'text_delta':
      ctx.renderer.renderTextDelta(chunk.text);
      ctx.appendPartialAssistant({ type: 'text', text: chunk.text });
      break;
    case 'tool_use_start':
      ctx.renderer.renderToolUseStart(chunk.id, chunk.name);
      ctx.startToolUse(chunk.id, chunk.name);
      break;
    case 'tool_use_delta':
      ctx.renderer.renderToolUseDelta(chunk.id, chunk.input);
      ctx.appendToolUseInput(chunk.id, chunk.input);
      break;
    case 'tool_use_end':
      ctx.renderer.renderToolUseEnd(chunk.id);
      ctx.finalizeToolUse(chunk.id);
      break;
    case 'message_end':
      ctx.appendMessageEnd(chunk.stopReason, chunk.tokenUsage);
      await this.fsm.transition({
        type: 'stream_end',
        message: ctx.currentMessage,
        stopReason: chunk.stopReason,
        tokenUsage: chunk.tokenUsage,
      });
      break;
    case 'error':
      ctx.renderer.renderError(chunk.error);
      throw new OmniAgentError(chunk.error);
  }
}
```

#### 3.1.5 EVAL_STOP_REASON 处理（11 种分支）

```typescript
private async handleEvalStopReason(ctx: ReActLoopContext): Promise<void> {
  // 预算检查
  const budget = this.budgetGuard.check();
  if (budget.exceeded) {
    await this.fsm.transition({ type: 'budget_exceeded', remaining: budget.remaining });
    return;
  }

  // 委托 TerminationHandler 处理 11 种 stop_reason
  const result = await this.termination.handle({
    stopReason: ctx.currentMessage.metadata?.stop_reason ?? 'end_turn',
    message: ctx.currentMessage,
    tokenUsage: ctx.currentMessage.metadata?.tokenUsage ?? { inputTokens: 0, outputTokens: 0 },
    ctx,
  });

  if (result.sideEffect) await result.sideEffect();
  // 根据 nextState 推进 FSM
  // （TerminationHandler 返回 nextState，FSMController 根据 stopReason 推进）
}
```

#### 3.1.6 TOOL_EXECUTE 处理（M4 五层拦截 → M3 工具执行）

```typescript
private async handleToolExecute(ctx: ReActLoopContext): Promise<void> {
  for (const toolUse of ctx.pendingToolUses) {
    try {
      // M4 五层拦截链
      const decision = await this.interception.intercept({
        tool: toolUse.name,
        input: toolUse.input,
        ctx: { cwd: ctx.cwd, permissionMode: ctx.permissionMode, agentId: ctx.agentId },
      });
      if (decision.decision === 'deny') {
        await this.fsm.transition({
          type: 'permission_deny',
          layer: decision.layer ?? 2,
          reason: decision.reason ?? 'permission denied',
        });
        // tool_result 标 is_error，回注 LLM
        ctx.appendToolResult({
          tool_use_id: toolUse.id,
          is_error: true,
          content: [{ type: 'text', text: `permission denied: ${decision.reason}` }],
        });
        continue;
      }

      // M3 工具执行
      const tool = this.toolPool.getTool(toolUse.name);
      const toolResult = await tool.call(toolUse.input, {
        cwd: ctx.cwd,
        permissionMode: ctx.permissionMode,
        agentId: ctx.agentId,
        abortSignal: this.abortCoord.signal,
      });

      // M2 侧配对检查（不变量 #3）
      if (!this.pairGuard.checkPairing(toolResult, ctx)) {
        // fail-closed：拒绝写入 transcript，记审计
        continue;
      }

      ctx.appendToolResult(toolResult);
      await this.fsm.transition({ type: 'tool_result', result: toolResult });
    } catch (err) {
      if (err.code === 'TOOL_TIMEOUT' || err.code === 'TOOL_EXECUTION_ERROR') {
        ctx.appendToolResult({
          tool_use_id: toolUse.id,
          is_error: true,
          content: [{ type: 'text', text: err.message }],
        });
        await this.fsm.transition({ type: 'tool_result', result: /* is_error 的 result */ });
      } else {
        throw err;
      }
    }
  }

  // TOOL_EXECUTE 完成后：检查 shouldAutoCompact
  const compactCheck = this.autoCompactChecker.check(ctx);
  if (this.autoCompactChecker.shouldTransitionToPtlDegrade(compactCheck)) {
    await this.fsm.transition({ type: 'degrade_success' });  // 转 PTL_DEGRADE
  } else {
    // 回到 CALL_LLM 继续（tool_result 回注）
  }
}
```

#### 3.1.7 PTL_DEGRADE 处理（委托 M7）

```typescript
private async handlePtlDegrade(ctx: ReActLoopContext): Promise<void> {
  try {
    const result = await this.memoryEngine.handlePtl({
      messages: ctx.messages,
      sessionId: ctx.sessionId,
      traceId: ctx.traceId,
    });
    if (result.success) {
      await this.fsm.transition({ type: 'degrade_success', compactedBoundaryId: result.boundaryId });
    } else {
      await this.fsm.transition({ type: 'degrade_failed', reason: result.reason });
      ctx.renderer.renderError(new OmniAgentError({
        code: 'AUTOCOMPACT_CIRCUIT_BREAKER',
        message: 'PTL degrade failed 3 times, please /compact manually',
      }));
    }
  } catch (err) {
    await this.fsm.transition({ type: 'degrade_failed', reason: err.message });
  }
}
```

### 3.2 FSMController 状态转换（引用 L2 §4.1.1，不重复）

L2 §4.1.1 给出 26 条状态转换规则的形式化表。本节补 FSMController 的实现细节：

#### 3.2.1 状态转换实现

`FSMController.transition()` 的工作流程：

1. **检查守卫条件**（`checkGuard`）：验证当前状态 + 事件是否合法
2. **守卫失败**：走 fallback 分支（不进入"中间态"），fallback 必经 END_TURN 或 CALL_LLM 重新求值
3. **守卫通过**：根据 nextState 映射表计算下一状态
4. **记 tracing span**：`react_loop.{from}.{to}` + tags（stop_reason / tool_name / layer / duration_ms）
5. **更新 currentState**

#### 3.2.2 守卫条件形式化（引用 L2 §4.1.2）

L2 §4.1.2 列出 4 个关键守卫：

- **BUILD_CONTEXT → CALL_LLM**：`systemPrompt.length > 0 && tools.length > 0`
- **CALL_LLM → STREAM_RENDER**：`first_chunk.received_at - request.sent_at <= 30s`
- **EVAL_STOP_REASON → TOOL_EXECUTE**：`message.content.filter(c => c.type === 'tool_use').length > 0`
- **TOOL_EXECUTE → CALL_LLM**：`tool_result.tool_use_id === tool_use.id`（配对完整性，不变量 #3）

守卫失败处理：**不进入"中间态"**，走 fallback 分支（记审计日志 + 走 fallback event）。所有 fallback 路径必经 END_TURN 或 CALL_LLM 重新求值，避免循环卡死。

#### 3.2.3 不允许的转换（防中间态）

以下转换**不允许**直接发生，必须经中间状态：

- IDLE → CALL_LLM（必须经 BUILD_CONTEXT 加载上下文）
- STREAM_RENDER → TOOL_EXECUTE（必须经 EVAL_STOP_REASON 判断 stop_reason）
- TOOL_EXECUTE → END_TURN（必须经 CALL_LLM 让模型消化 tool_result 后判断 end_turn）
- PTL_DEGRADE → END_TURN（仅在 degrade_failed 时直接转，degrade_success 必须回 CALL_LLM 重发）

#### 3.2.4 状态转换的审计与可观测（引用 L2 §4.4）

每个状态转换记入 tracing span：

- **span operation**：`react_loop.{from_state}.{to_state}`
- **tags**：`stop_reason` / `tool_name` / `layer` / `duration_ms`
- **父 span**：trace_id（跨模块同 trace_id，便于跨模块追踪一轮对话）

L2 §7 已设计完整可观测性方案（日志格式 + metrics API + tracing + 审计 schema），本文不重复。

### 3.3 TerminationHandler 11 种终止条件（引用 PRD §4.1，不重复）

PRD mod-02 §4.1 列出 11 种终止条件与处理方式。本节补每个分支的实施细节：

| # | stop_reason | 处理 | 副作用 | 跳转 |
|---|------------|------|--------|------|
| 1 | `end_turn` | 正常结束 | 记 transcript | END_TURN |
| 2 | `tool_use` | 执行工具 | 触发 M4 五层拦截 → M3 工具执行 | TOOL_EXECUTE |
| 3 | `max_output_tokens` | 两阶段升级 | slot 优化 → context window 升级 | CALL_LLM |
| 4 | `ptl` | 紧急降级三步 | 委托 M7 collapse_drain → reactive_compact → error | PTL_DEGRADE |
| 5 | `user_interrupt` | 保留状态 | 记 abort 原因；可 resume | END_TURN |
| 6 | `stall_passive_30s` | 重发请求 | stall_count++；同 model 重发 | CALL_LLM |
| 7 | `stall_active_90s` | 切非流式 | 切 `chat()` 替代 `chatStream()` | CALL_LLM |
| 8 | `provider_5xx` | 降级 5 步 | 清 assistant → 切 fallbackModel → 重发（最多 1 次） | CALL_LLM / END_TURN |
| 9 | `provider_429` | 退避重试 | 指数退避（1s/2s/4s/8s 上限），最多 3 次 | CALL_LLM / END_TURN |
| 10 | `tool_execution_error` | tool_result 标 is_error | 回注 LLM 决策 | CALL_LLM |
| 11 | `budget_exceeded` | 软提醒 | 让用户确认是否继续 | END_TURN |

**关键设计**：

- **不无限重试**：每个有重试的分支（5xx/429/stall）都有 IterationLimiter 强制上限
- **不臆造结果**：降级失败时明确报错（END_TURN + 用户提示），不让模型继续生成错误结果
- **保留可 resume**：`user_interrupt` 分支保留当前 messages 状态，下次 `--resume <sessionId>` 可继续

### 3.4 ModelDegrader 5 步降级（引用 PRD §4.2，决策 C1）

PRD mod-02 §4.2 + 决策 C1 已定：**v1.0 同 provider 内自动降级**（fallbackModel 单值字段），跨 provider chain 延后到 v2.x。本节补 5 步的实施细节：

#### 3.4.1 5 步流程

```
Step 1: 检测 5xx 或连续 stall
  ↓
Step 2: 清空当前 assistant 消息（避免 partial 输出污染下一模型）
  ↓
Step 3: 切换到 fallbackModel（同 provider 内）
  ↓
Step 4: 重新发送请求
  ↓
Step 5: 若仍失败，明确报错（不无限重试）
```

**Step 2 实施要点**：

- 清空 `ctx.partialAssistant`，避免 partial 输出被下一模型当 context
- 同步在 transcript 标记该 message 为 `aborted=true`（不变量 #3 不破坏，配对的 tool_use/tool_result 都标 aborted）

**Step 3 实施要点**：

- `ctx.switchToModel(ctx.fallbackModel)` 切换模型 ID
- 若 `ctx.fallbackModel` 为空（用户未配置），直接跳 Step 5 报错
- 不跨 provider，沿用同一 LLMProvider 实例

**Step 4 实施要点**：

- 不直接重发，而是回到 CALL_LLM 状态由 ReActLoop 重新发起 chatStream
- IterationLimiter.consumeRetry('5xx') 记账，最多 1 次

**Step 5 实施要点**：

- IterationLimiter.reportFailure('5xx_max_retry_exceeded')
- 转 END_TURN + 用户提示"模型降级失败，请稍后重试或检查 provider 状态"
- 不抛异常（避免进程崩溃），让 TaskRunner 进入下一轮等用户输入

#### 3.4.2 429 退避重试

```
attempt 0: 等 1s → 重发
attempt 1: 等 2s → 重发
attempt 2: 等 4s → 重发
attempt 3: 失败，报错
```

- 指数退避：`Math.min(1000 * Math.pow(2, attempt), 8000)`，上限 8s
- 若 provider 返回 `retry-after` header，优先用 provider 的 `retryAfterMs`
- 最多 3 次重试（IterationLimiter `'429': 3`）

#### 3.4.3 stall 切非流式降级

```
stall_active_90s 触发
  ↓
ctx.switchToNonStreaming()  // 标记后续用 chat() 替代 chatStream()
  ↓
回到 CALL_LLM 状态
  ↓
ReActLoop 检测 ctx.nonStreaming=true，调 provider.chat() 而非 chatStream()
```

- 非流式调用一次性返回完整 message，无流式 stall 问题
- 但失去流式渲染体验（用户感知"卡顿"），仅在 stall 时降级

#### 3.4.4 v2.x 演进项（引用 PRD §8.4，不重复）

- 跨 provider fallback chain：`fallbackChain: ["openai:gpt-4", "bedrock:claude", "ollama:llama3"]`
- 涉及多 provider 认证状态管理（M1 CredentialsStore 需扩展）
- v2.x 评估支持

### 3.5 StallDetector 双重检测（引用 PRD §4.3，不重复）

PRD mod-02 §4.3 已定：被动 30s + 主动 90s 双重检测，stall 率护栏 ≤ 1%。本节补双定时器实施细节：

#### 3.5.1 双定时器实现

```
启动流式调用时：
  - passiveTimer = setTimeout(onPassiveStall, 30_000)
  - activeTimer = setTimeout(onActiveStall, 90_000)
  - lastChunkAt = streamStartedAt

收到每个 chunk 时（touch）：
  - lastChunkAt = now
  - 重置 passiveTimer（clearTimeout + 重新 setTimeout 30s）
  - **不重置 activeTimer**（90s 是流总时长上限）

流结束 / abort 时（stop）：
  - clearTimeout(passiveTimer)
  - clearTimeout(activeTimer)
```

#### 3.5.2 触发后的动作

**被动 stall（30s 无 chunk）**：

- `stall_count++`
- 转 `stall_passive_30s` 事件 → TerminationHandler → 同 model 重发
- IterationLimiter.consumeRetry('stall_passive')（最多 1 次）

**主动 stall（90s 流未结束）**：

- `stall_count++`
- 转 `stall_active_90s` 事件 → TerminationHandler → 切非流式降级
- IterationLimiter.consumeRetry('stall_active')（最多 1 次）

#### 3.5.3 stall 率护栏

- `stallRate = stallCount / totalStreams`
- 目标：≤ 1%（PRD mod-02 §6.1）
- 超过 1% 时记 CRITICAL 日志 + 上报 metrics（L2 §7 可观测性）
- 不强制终止进程（允许继续运行，但提示开发者排查 provider 或网络）

#### 3.5.4 stall 检测与 abort 的协同

- 若用户在 stall 期间 abort，StallDetector.stop() 立即清理定时器
- abort 信号优先于 stall 触发（避免 stall 触发后又被 abort 中断的竞态）
- 竞态场景 A（LLM 已返回但工具未完成时 abort）见 §3.6.1

### 3.6 AbortCoordinator 信号传播 + 3 种竞态（引用 L2 §4.3，不重复）

L2 §4.3 已设计 3 种 abort 竞态场景与处理策略。本节补 AbortCoordinator 类的实施细节：

#### 3.6.1 场景 A：LLM 已返回但工具未完成时 abort

**时间线**：

```
T0: chatStream() 返回 message_end
T1: M2 进入 EVAL_STOP_REASON
T2: 用户 Ctrl+C
T3: M2 已分发 tool_use 到 TOOL_EXECUTE
T4: 工具正在执行（如 web_fetch 长请求）
```

**处理**：

- abort 信号同时传给 LLMProvider（已结束，no-op）和 M3 tool.call()（通过 `ToolContext.abortSignal`）
- 工具实现必须监听 `abortSignal`，`web_fetch` 等长请求用 `AbortSignal` 传给底层 fetch
- 工具返回 `ToolResult` 标 `is_error=true` + content 含 "aborted by user"
- M2 走 `stop_reason=user_interrupt` 分支，不回注 LLM

**实施**：

```typescript
// 工具实现示例（web_fetch）
async call(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
  try {
    const response = await fetch(input.url, { signal: ctx.abortSignal });
    // ...
  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        tool_use_id: ctx.toolUseId,
        is_error: true,
        content: [{ type: 'text', text: 'aborted by user' }],
      };
    }
    throw err;
  }
}
```

#### 3.6.2 场景 B：abort 与 tool_result 配对完整性冲突

**时间线**：

```
T0: 工具执行完成返回 tool_result
T1: 同时刻用户 Ctrl+C
T2: M2 收到 abort 信号但 tool_result 已在队列中
```

**处理**：

- abort 信号到达时检查 `tool_result` 是否已在队列
- 已在队列：**丢弃**（不回注 LLM），走 `user_interrupt` 分支
- 未在队列：等待 `tool_result` 到达后丢弃
- 不变量 #3（tool_use/tool_result 配对完整性）的"配对"指 transcript 中的配对，丢弃已完成的 tool_result 不破坏配对（transcript 中 tool_use 与 tool_result 都标记为 `aborted=true`）

**实施**：

```typescript
async handleUserInterrupt(reason: string): Promise<void> {
  await this.abortCoord.abortAll(reason);
  // 场景 B 处理
  if (this.ctx.pendingToolResults.size > 0) {
    for (const [id, result] of this.ctx.pendingToolResults) {
      this.ctx.discardPendingToolResult(id);
      // transcript 中 tool_use 与 tool_result 都标记 aborted=true
      this.ctx.markAborted(id);
    }
  }
}
```

#### 3.6.3 场景 C：多 agent 中 abort 一个

**时间线**：

```
T0: 主 agent spawn 3 个 teammate（A/B/C）
T1: 用户 abort teammate A
T2: B/C 仍运行
```

**处理**：

- 每个 agent 有独立的 `AbortController`
- 主 agent 的 abort 不自动传给 teammate（teammate 是独立 agent，有自己的生命周期）
- 主 agent 通过 M5 `shutdown_request` 通知 teammate（四步握手，不强杀）
- teammate 收到 shutdown_request 后自行决定 approve/reject

**实施**：

```typescript
// 主 agent 不会自动传 abort 给 teammate
async abortAll(reason: string): Promise<void> {
  // 信号传给：LLMProvider + M3 tool.call() + M5 spawn 的子 agent
  // **不传给**：其他独立 teammate
  this.controller.abort();
}

// 主 agent 通过 M5 shutdown_request 通知 teammate
async shutdownTeammate(teammateId: AgentId): Promise<void> {
  await this.orchestrator.sendShutdownRequest(teammateId, this.ctx);
  // 等待 shutdown_response（四步握手）
}
```

### 3.7 ToolUsePairGuard 配对保护（不变量 #3）

不变量 #3（附录 A）：**tool_use/tool_result 配对完整性**。M2 侧负责"检查 + 拒绝"，M7 侧负责"压缩时修正"（adjustIndexToPreserveAPIInvariants）。

#### 3.7.1 M2 侧检查时机

- **TOOL_EXECUTE 状态**：每次 tool_result 进入 transcript 前，`pairGuard.checkPairing()` 检查是否有配对的 tool_use
- **EVAL_STOP_REASON 状态**：stream_end 时检查 message.content 中 tool_use/tool_result 配对（不应出现 orphan tool_result）
- **TOOL_EXECUTE → CALL_LLM 转换前**：检查所有 pending tool_use 是否都有 tool_result（无配对则 fail-closed 报错）

#### 3.7.2 M2 侧 fail-closed 策略

- 检查到 orphan tool_result（无配对 tool_use）：**拒绝写入 transcript** + 记审计日志 + 抛 `INVARIANT_VIOLATION_TOOL_USE_PAIRING` 错误
- 检查到 orphan tool_use（无配对 tool_result）：**不进入 CALL_LLM**（避免 LLM 看到 orphan tool_use 而困惑）+ 走 fallback 分支（重新触发工具执行）

#### 3.7.3 M2 侧调用 M7 adjust（仅压缩前）

M2 在触发 shouldAutoCompact=true 后、调 M7 压缩前，先调 M7 `adjustIndexToPreserveAPIInvariants()` 确保压缩区间不破坏配对：

```typescript
async adjustBeforeCompact(messages: Message[], compactRange: { start: number; end: number }) {
  const result = this.adjustFn({ messages, compactRange });
  if (result.error) {
    // 无法修正：fail-closed 报错
    throw new OmniAgentError({
      code: 'INVARIANT_VIOLATION_TOOL_USE_PAIRING',
      message: result.error.reason,
    });
  }
  return result;
}
```

#### 3.7.4 不变量 #3 的端到端测试用例

§6.3 列出不变量 #3 的端到端测试用例（含正常配对 / 压缩破坏配对 / orphan tool_use / orphan tool_result 4 个场景）。

### 3.8 AutoCompactChecker 压缩判断（引用 PRD §4.4，不重复）

PRD mod-02 §4.4 + L2 §3.11 已定义 `shouldAutoCompact()` 跨模块函数签名（M7 实现/M2 调用）。本节补 M2 侧调用时机与处理逻辑：

#### 3.8.1 调用时机

- **TOOL_EXECUTE 完成后**：每次 tool_result 回注前，调 `autoCompactChecker.check()`
- **PTL_DEGRADE 之前**：识别 `ptl` stop_reason 后，先调 `autoCompactChecker.check()`，若 `shouldCompact=true` 且 `reason='approaching_limit'`，则转 PTL_DEGRADE；否则直接触发 M7 压缩
- **不在其他状态调用**：BUILD_CONTEXT / CALL_LLM / STREAM_RENDER / EVAL_STOP_REASON 都不调

#### 3.8.2 6 逃逸条件处理（引用 PRD §4.4，不重复）

PRD mod-02 §4.4 列出 6 个逃逸条件，按短路求值：

1. `user_disabled_auto_compact` → `skip_user_disabled`
2. `compacting` → `skip_compacting`（防重入）
3. `has_compacted_this_turn` → `skip_already_compacted`（一轮最多压一次）
4. `in_collapse` → `skip_in_collapse`（PTL collapse 中不再触发压缩）
5. `budget_continuation` → `skip_budget_continuation`（budget 续命模式不压缩）
6. `provider_supports_exact_token_count=false` → `skip_conservative_estimate`（无精确 token 计数则提前压缩）

M2 收到 `skip_*` reason 时不压缩，继续 CALL_LLM。

#### 3.8.3 触发层级与 token 用量

PRD mod-02 §4.4 已定触发层级：

- `< 70%` 不触发
- `70-85%` L1 MicroCompact（M7 单条工具结果截断到 50KB）
- `85-95%` L2 SessionMemory（M7 工具结果累计摘要，COMPACTABLE_TOOLS + retain 窗口）
- `> 95%` L3 API 摘要（M7 LLM 整体摘要）

M2 收到 `shouldCompact=true` + `triggerLayer` 后，调 M7 `compact(triggerLayer)`，M7 返回 `compactedBoundaryId` 记入 TurnResult。

### 3.9 BudgetGuard 预算守护（引用 PRD §4.1，不重复）

PRD mod-02 §4.1 列出 `budget_exceeded` 终止条件 + 软提醒策略。本节补 BudgetGuard 类实施细节：

#### 3.9.1 预算跟踪

- 每轮 runTurn 结束时调 `budgetGuard.record(tokenUsage)` 累计
- `provider.estimateCost(usage)` 计算美元成本
- `spentUsd += cost.usd` 累加

#### 3.9.2 检查时机

- **EVAL_STOP_REASON 状态**：每次进入该状态时调 `budgetGuard.check()`
- 若 `exceeded=true` → 转 `budget_exceeded` 分支 → 软提醒 + END_TURN
- 若 `warning=true` 但 `exceeded=false` → 仅记日志，不中断

#### 3.9.3 软提醒策略

- `budget_exceeded` 不强制终止（与 `user_interrupt` 类似的"软"语义）
- 通过 `renderer.renderBudgetWarning(spentUsd, limitUsd)` 输出提醒
- 用户确认继续 → 重置 `budgetContinuation=true`，回到 CALL_LLM
- 用户拒绝 → END_TURN，进入下一轮等输入

#### 3.9.4 budget_continuation 与 autocompact 的协同

- `budget_continuation=true` 时，`shouldAutoCompact` 的逃逸条件 5 触发 → 不压缩
- 这是为了避免"预算续命后又触发压缩"的级联失败
- 用户若想强制压缩，可手动 `/compact`

### 3.10 StreamRenderer 渲染契约

M2 不实现具体渲染逻辑，只定义契约（`StreamRenderer` interface）。UI 层（M6 Skills 中的交互类 skill + Ink 渲染层）实现此接口。

#### 3.10.1 多模式共享

- **终端 Ink**：流式渲染到 stdout，支持 Ctrl+C 捕获
- **Headless**：渲染到内存 buffer，供测试断言
- **IDE 协议接入**：渲染到 LSP 窗口
- **Remote Server**：渲染到 WebSocket 推送

四种模式实现同一 `StreamRenderer` 接口，M2 不感知具体模式。

#### 3.10.2 错误渲染策略

- `renderError(error)`：渲染 OmniAgentError 到 UI
- 简短可读消息（用户可见）+ 技术细节仅日志（stderr 或文件）
- 不显示敏感信息（如 API key / OAuth token）

#### 3.10.3 中断渲染策略

- `renderInterrupted(reason)`：渲染中断原因
- 显示"已中断，可 /resume 续命"提示

### 3.11 IterationLimiter 重试预算

PRD mod-02 §4.1 + §4.2 列出多个重试上限。IterationLimiter 统一管理：

| 重试类型 | 上限 | 备注 |
|---------|------|------|
| 5xx 降级 | 1 次 | C1 决策：同 provider fallback，最多重试 1 次 |
| 429 退避 | 3 次 | 指数退避 1s/2s/4s |
| stall_passive | 1 次 | 同 model 重发 |
| stall_active | 1 次 | 切非流式降级 |

#### 3.11.1 重试预算按"轮"算

- 每轮 runTurn 开始时 `iterLimiter.reset()`
- 不跨轮累积（避免一轮的失败影响下一轮）
- 但跨轮的 stall 率统计在 StallDetector 中累计（用于护栏指标）

#### 3.11.2 超限处理

- `canRetry(kind)` 返回 false 时，调 `iterLimiter.reportFailure(reason)`
- reportFailure 记审计日志 + tracing span
- 走 END_TURN 分支，让用户决定是否重试

### 3.12 TaskRunner 顶层入口

TaskRunner 是 M2 的最外层入口，负责 session 生命周期管理 + 多轮 ReActLoop 调度。

#### 3.12.1 三种部署形态共用

- **CLI 模式**：用户在终端启动 `omniagent` 命令，TaskRunner.runSession() 直接运行
- **Remote Server 模式**：Cloudflare Worker / Deno Deploy 接收 HTTP 请求，转 TaskRunner.runSession()
- **Daemon 模式**：后台进程，TaskRunner.runSession() 由 IPC 触发

三种模式共用 TaskRunner，差异仅在 `waitForNextInput()` 的实现（CLI 用 stdin / Remote 用 HTTP 长连接 / Daemon 用 IPC）。

#### 3.12.2 session 生命周期

```
启动 session（无 sessionId）→ 创建新 session → runTurn 循环 → flushSession → 退出
启动 session（有 sessionId）→ resume session → runTurn 循环 → flushSession → 退出
```

- `memoryEngine.createSession()` 创建新 session（M7 实现）
- `memoryEngine.resumeSession(sessionId)` 从 transcript 恢复 messages
- `memoryEngine.flushSession(sessionId)` 持久化最终状态（M7 drainWriteQueue flush）

#### 3.12.3 多轮调度

```typescript
while (true) {
  this.iterLimiter.reset();
  this.abortCoord.reset();
  const traceId = generateTraceId();
  const result = await this.reactLoop.runTurn({ text: userInput, sessionId, traceId });
  this.budgetGuard.record(result.tokenUsage);
  if (result.stopReason === 'end_turn' || result.interrupted) {
    userInput = await this.waitForNextInput();
    if (!userInput) break;  // 用户 /exit
  } else {
    break;  // 异常终止
  }
}
```

---

## 4. 与其他模块的交互

### 4.1 调用图

```
                  ┌──────────────┐
                  │  TaskRunner  │
                  └──────┬───────┘
                         │
                         ▼
                ┌────────────────┐
                │   ReActLoop    │
                └────┬───────┬───┘
        ┌───────────┘       └───────────┐
        ▼                               ▼
  ┌──────────┐                    ┌──────────┐
  │FSMControl│                    │Termination│
  │  ler     │                    │  Handler │
  └────┬─────┘                    └────┬─────┘
       │                               │
       │  ┌────────────────────────────┼────────────────────────────┐
       │  │                            │                            │
       ▼  ▼                            ▼                            ▼
  ┌──────────┐              ┌──────────────┐              ┌──────────────┐
  │ModelDegr │              │StallDetector │              │AbortCoordinator│
  │  ader    │              └──────────────┘              └──────────────┘
  └────┬─────┘
       │
       ▼
  ┌─────────────────────────────────────────────────────┐
  │  跨模块调用（M2 → M1/M3/M4/M5/M7）                  │
  ├─────────────────────────────────────────────────────┤
  │  M1 LLMProvider.chatStream() / chat() / countTokens │
  │  M3 ToolPool.mergeAndFilterTools() / tool.call()    │
  │  M4 InterceptionChain.intercept()（五层拦截链）     │
  │  M5 Orchestrator.sendShutdownRequest()（四步握手）  │
  │  M7 MemoryEngine.buildContext() / handlePtl() /     │
  │     shouldAutoCompact() / adjustIndexToPreserve... │
  └─────────────────────────────────────────────────────┘
```

### 4.2 数据流

```
用户输入
  │
  ▼
TaskRunner.runSession()
  │
  ▼
ReActLoop.runTurn()
  │
  ▼
[FSM IDLE → BUILD_CONTEXT]
  │
  ▼
M7 MemoryEngine.buildContext() → systemPrompt + recalledMemories + tools
  │
  ▼
M3 ToolPool.mergeAndFilterTools() → filteredTools
  │
  ▼
[FSM BUILD_CONTEXT → CALL_LLM]
  │
  ▼
M1 LLMProvider.chatStream() → ChatChunk 流
  │
  ▼
[FSM CALL_LLM → STREAM_RENDER]（首个 chunk 到达）
  │
  ▼
StreamRenderer.renderTextDelta() / renderToolUseStart() / ...
  │
  ▼
[FSM STREAM_RENDER → EVAL_STOP_REASON]（message_end）
  │
  ▼
TerminationHandler.handle(stopReason)
  │
  ├──tool_use──▶ [FSM EVAL_STOP_REASON → TOOL_EXECUTE]
  │              │
  │              ▼
  │              M4 InterceptionChain.intercept() → decision
  │              │
  │              ├──allow──▶ M3 tool.call() → ToolResult
  │              │              │
  │              │              ▼
  │              │              ToolUsePairGuard.checkPairing() → ok
  │              │              │
  │              │              ▼
  │              │              AutoCompactChecker.check() → shouldCompact
  │              │              │
  │              │              ├──shouldCompact=true──▶ M7 compact() → compactedBoundaryId
  │              │              │
  │              │              ▼
  │              │              [FSM TOOL_EXECUTE → CALL_LLM]（tool_result 回注）
  │              │
  │              └──deny──▶ tool_result 标 is_error → [FSM TOOL_EXECUTE → CALL_LLM]
  │
  ├──ptl──▶ [FSM EVAL_STOP_REASON → PTL_DEGRADE]
  │         │
  │         ▼
  │         M7 MemoryEngine.handlePtl() → success / failed
  │         │
  │         ├──success──▶ [FSM PTL_DEGRADE → CALL_LLM]（重发）
  │         │
  │         └──failed──▶ [FSM PTL_DEGRADE → END_TURN]（报错）
  │
  ├──end_turn──▶ [FSM EVAL_STOP_REASON → END_TURN]
  │
  └──...（其他 8 种 stop_reason）
```

### 4.3 接口契约表

| M2 接口 | 调用方 | 被调方 | 契约（types.ts 章节） |
|---------|--------|--------|---------------------|
| `ReActLoop.runTurn()` | TaskRunner | M2 | §3（本文新增 ReActState） |
| `LLMProvider.chatStream()` | M2 ReActLoop | M1 | §5 LLMProvider |
| `LLMProvider.chat()` | M2 ModelDegrader | M1 | §5 LLMProvider（非流式降级） |
| `LLMProvider.countTokens()` | M2 AutoCompactChecker | M1 | §5 LLMProvider |
| `LLMProvider.estimateCost()` | M2 BudgetGuard | M1 | §5 LLMProvider |
| `ToolPool.mergeAndFilterTools()` | M2 ReActLoop | M3 | §7 MergeAndFilterToolsFn |
| `Tool.call()` | M2 ReActLoop（TOOL_EXECUTE） | M3 | §7 Tool |
| `InterceptionChain.intercept()` | M2 ReActLoop（TOOL_EXECUTE） | M4 | §6 PermissionDecision |
| `Orchestrator.sendShutdownRequest()` | M2 AbortCoordinator | M5 | §8 MailboxMessage |
| `MemoryEngine.buildContext()` | M2 ReActLoop（BUILD_CONTEXT） | M7 | §17 FindRelevantMemoriesFn |
| `MemoryEngine.handlePtl()` | M2 ReActLoop（PTL_DEGRADE） | M7 | §11 PtlHandler |
| `ShouldAutoCompactFn()` | M2 AutoCompactChecker | M7 | §11 ShouldAutoCompactFn |
| `AdjustIndexToPreserveAPIInvariantsFn()` | M2 ToolUsePairGuard | M7 | §11 AdjustIndexToPreserveAPIInvariantsFn |
| `StreamRenderer.*` | M2 ReActLoop（STREAM_RENDER） | UI 层（M6） | §3（本文新增 StreamRenderer） |

### 4.4 澄清契约（PRD §5）

PRD mod-02 §5 已列出 7 项交互。本节补澄清：

- **M2 与 M1 的 stop_reason 契约**：M1 LLMProvider.chatStream() 必须输出 `stop_reason` 字段（11 种之一），M2 EVAL_STOP_REASON 状态依赖此字段分支。M1 若输出未知 stop_reason，M2 fail-closed 当 `end_turn` 处理 + 记审计日志。
- **M2 与 M7 的 adjust/shouldAutoCompact 契约**：M2 只调用，不实现；M7 在 `omniagent-types.ts §11` 已定义跨模块函数签名，M2 通过依赖注入获取实例。
- **M2 与 M4 的拦截契约**：M2 在 TOOL_EXECUTE 状态调 `InterceptionChain.intercept()`，M4 返回 `PermissionDecision`。M4 返回 `deny` 时 M2 不调 M3 tool.call()，直接标 tool_result is_error 回注 LLM。
- **M2 与 M5 的 shutdown 契约**：M2 AbortCoordinator 场景 C 中调 `Orchestrator.sendShutdownRequest()`，M5 通过 mailbox 四步握手通知 teammate，**不强杀**。

---

## 5. 错误处理与降级

### 5.1 错误码映射（引用 L2 §6，不重复）

L2 §6 已定义 26 个 OmniAgentErrorCode。M2 触发的错误码子集：

| 错误码 | 触发场景 | M2 处理 | 用户呈现 |
|--------|---------|---------|---------|
| `PROVIDER_5XX` | LLMProvider.chatStream() 抛 5xx | ModelDegrader.degrade5xx() 降级 5 步 | "模型服务异常，已切换 fallbackModel" |
| `PROVIDER_429` | LLMProvider.chatStream() 抛 429 | ModelDegrader.retry429() 退避重试 | "限流，正在重试..." |
| `PROVIDER_TIMEOUT` | StallDetector 触发 30s/90s | ModelDegrader 切非流式降级 | "响应超时，已切换非流式模式" |
| `TOOL_EXECUTION_ERROR` | M3 tool.call() 抛错 | tool_result 标 is_error 回注 LLM | "工具执行失败：{message}" |
| `TOOL_TIMEOUT` | M3 tool.call() 超时 | tool_result 标 is_error 回注 LLM | "工具执行超时" |
| `TOOL_PERMISSION_DENIED` | M4.intercept() 返回 deny | tool_result 标 is_error 回注 LLM | "权限拒绝：{reason}" |
| `PTL_ERROR` | M7 handlePtl() 抛错 | 转 END_TURN + 用户提示 | "上下文过长，请 /compact" |
| `AUTOCOMPACT_CIRCUIT_BREAKER` | M7 PTL 三步 3 次失败 | 转 END_TURN + 用户提示 | "自动压缩失败，请手动 /compact" |
| `BUDGET_EXCEEDED` | BudgetGuard.check() 返回 exceeded | 软提醒 + END_TURN | "预算超限，已用 ${spent}/${limit}" |
| `USER_INTERRUPT` | abortCoordinator.abortAll() | 保留状态 + END_TURN | "已中断，可 /resume 续命" |
| `INVARIANT_VIOLATION_TOOL_USE_PAIRING` | ToolUsePairGuard 检查失败 | fail-closed 报错 + END_TURN | "内部错误：tool_use/tool_result 配对破坏" |

### 5.2 fail-closed 策略

M2 的 fail-closed 场景：

1. **配对完整性破坏**（不变量 #3）：ToolUsePairGuard.checkPairing() 返回 false 时，**拒绝写入 transcript** + 抛 `INVARIANT_VIOLATION_TOOL_USE_PAIRING`
2. **守卫条件失败无 fallback**：FSMController.transition() 找不到 fallback 时，直接转 END_TURN（不进入"中间态"）
3. **LLMProvider 输出未知 stop_reason**：fail-closed 当 `end_turn` 处理 + 记审计日志（不让 FSM 卡在 EVAL_STOP_REASON）
4. **IterationLimiter 超限**：直接 END_TURN + 用户提示（不无限重试，不臆造结果）
5. **M7 PTL 三步全失败**：直接 END_TURN + 用户提示"请手动 /compact"（不让 LLM 继续在过长 context 上生成错误结果）
6. **budget_exceeded 用户拒绝继续**：直接 END_TURN（不强制续命）

### 5.3 错误呈现

- **简短可读消息**：用户可见（通过 StreamRenderer.renderError）
- **技术细节**：仅日志（stderr 或文件，L2 §7 日志格式规范）
- **审计日志**：合规审计（L2 §7 审计 schema，含 command / cwd / permission_decision / layer / risk_classifier_context / denial_tracker_context）
- **不显示敏感信息**：API key / OAuth token / 用户隐私数据

---

## 6. 测试用例骨架

### 6.1 单元测试

#### 6.1.1 FSMController 状态转换测试

```typescript
describe('FSMController', () => {
  it('IDLE + user_input → BUILD_CONTEXT', async () => {
    const fsm = new FSMController(/* ... */);
    expect(fsm.state).toBe('IDLE');
    await fsm.transition({ type: 'user_input', text: 'hello', traceId: 't1' });
    expect(fsm.state).toBe('BUILD_CONTEXT');
  });

  it('BUILD_CONTEXT + context_ready（empty systemPrompt）→ fallback to context_error', async () => {
    const fsm = new FSMController(/* ... */);
    // 守卫失败：systemPrompt.length === 0
    await fsm.transition({ type: 'user_input', text: 'hello', traceId: 't1' });
    await fsm.transition({ type: 'context_ready', systemPrompt: [], tools: [], recalledMemories: [] });
    expect(fsm.state).toBe('END_TURN');  // fallback 走 context_error → END_TURN
  });

  it('EVAL_STOP_REASON + stream_end(tool_use) 但无 tool_use 块 → fallback to end_turn', async () => {
    const fsm = new FSMController(/* ... */);
    // 守卫失败：no tool_use block
    const message: Message = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] };
    await fsm.transition({ type: 'stream_end', message, stopReason: 'tool_use', tokenUsage: { inputTokens: 0, outputTokens: 0 } });
    // fallback：当 end_turn 处理
    expect(fsm.state).toBe('END_TURN');
  });

  it('不允许的转换（IDLE → CALL_LLM 直接）→ fail-closed END_TURN', async () => {
    const fsm = new FSMController(/* ... */);
    // 直接事件 first_chunk 在 IDLE 状态不合法
    await fsm.transition({ type: 'first_chunk', chunk: { type: 'text_delta', text: 'x' } });
    expect(fsm.state).toBe('END_TURN');
  });

  // 26 条状态转换规则每条一个测试用例（L2 §4.1.1）
});
```

#### 6.1.2 TerminationHandler 11 种 stop_reason 测试

```typescript
describe('TerminationHandler', () => {
  it('end_turn → END_TURN', async () => { /* ... */ });
  it('tool_use → TOOL_EXECUTE', async () => { /* ... */ });
  it('max_output_tokens → 两阶段升级 → CALL_LLM', async () => { /* ... */ });
  it('ptl → PTL_DEGRADE', async () => { /* ... */ });
  it('user_interrupt → END_TURN + 保留状态', async () => { /* ... */ });
  it('stall_passive_30s → 同 model 重发 → CALL_LLM', async () => { /* ... */ });
  it('stall_active_90s → 切非流式 → CALL_LLM', async () => { /* ... */ });
  it('provider_5xx → 降级 5 步 → CALL_LLM（fallbackModel 已配置）', async () => { /* ... */ });
  it('provider_5xx → 降级 5 步失败（无 fallbackModel）→ END_TURN', async () => { /* ... */ });
  it('provider_429 → 退避重试 3 次 → CALL_LLM', async () => { /* ... */ });
  it('provider_429 重试 3 次仍失败 → END_TURN', async () => { /* ... */ });
  it('tool_execution_error → tool_result is_error → CALL_LLM', async () => { /* ... */ });
  it('budget_exceeded → 软提醒 → END_TURN', async () => { /* ... */ });
});
```

#### 6.1.3 ModelDegrader 5 步降级测试

```typescript
describe('ModelDegrader', () => {
  it('Step 2: 清空 partial assistant', async () => {
    const ctx = createMockContext({ partialAssistant: { role: 'assistant', content: [/* ... */] } });
    const degrader = new ModelDegrader(/* ... */);
    await degrader.degrade5xx(ctx);
    expect(ctx.partialAssistant).toBeUndefined();
    expect(ctx.messages.find(m => m.metadata?.aborted === true)).toBeDefined();
  });

  it('Step 3: 切换 fallbackModel', async () => {
    const ctx = createMockContext({ model: 'gpt-4', fallbackModel: 'gpt-4o-mini' });
    const degrader = new ModelDegrader(/* ... */);
    await degrader.degrade5xx(ctx);
    expect(ctx.model).toBe('gpt-4o-mini');
  });

  it('Step 5: 无 fallbackModel → 报错', async () => {
    const ctx = createMockContext({ model: 'gpt-4', fallbackModel: undefined });
    const degrader = new ModelDegrader(/* ... */);
    const result = await degrader.degrade5xx(ctx);
    expect(result).toBe(false);
  });

  it('IterationLimiter 5xx 上限 1 次', async () => {
    const limiter = new IterationLimiter();
    expect(limiter.canRetry('5xx')).toBe(true);
    limiter.consumeRetry('5xx');
    expect(limiter.canRetry('5xx')).toBe(false);
  });

  it('429 退避重试指数退避：1s/2s/4s/8s 上限', async () => {
    const delays: number[] = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((cb: any, ms?: number) => { delays.push(ms ?? 0); return {} as any; });
    const degrader = new ModelDegrader(/* ... */);
    const ctx = createMockContext({});
    for (let i = 0; i < 3; i++) await degrader.retry429(ctx);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('429 retry-after header 优先于指数退避', async () => {
    const delays: number[] = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((cb: any, ms?: number) => { delays.push(ms ?? 0); return {} as any; });
    const degrader = new ModelDegrader(/* ... */);
    const ctx = createMockContext({});
    await degrader.retry429(ctx, 5000);  // provider 返回 retry-after: 5s
    expect(delays).toEqual([5000]);
  });
});
```

#### 6.1.4 StallDetector 双定时器测试

```typescript
describe('StallDetector', () => {
  it('30s 无 chunk → 触发 passive stall', async () => {
    const detector = new StallDetector();
    const onPassiveStall = jest.fn();
    const onActiveStall = jest.fn();
    detector.start(new AbortController().signal, onPassiveStall, onActiveStall);
    jest.advanceTimersByTime(30_000);
    expect(onPassiveStall).toHaveBeenCalled();
    expect(onActiveStall).not.toHaveBeenCalled();
  });

  it('收到 chunk 重置 passive 定时器，但不重置 active', async () => {
    const detector = new StallDetector();
    const onPassiveStall = jest.fn();
    const onActiveStall = jest.fn();
    detector.start(new AbortController().signal, onPassiveStall, onActiveStall);
    jest.advanceTimersByTime(29_000);
    detector.touch();  // 重置 passive
    jest.advanceTimersByTime(29_000);
    expect(onPassiveStall).not.toHaveBeenCalled();
    jest.advanceTimersByTime(32_000);  // 累计 90s
    expect(onActiveStall).toHaveBeenCalled();
  });

  it('stop() 清理两个定时器', async () => {
    const detector = new StallDetector();
    const onPassiveStall = jest.fn();
    const onActiveStall = jest.fn();
    detector.start(new AbortController().signal, onPassiveStall, onActiveStall);
    detector.stop();
    jest.advanceTimersByTime(120_000);
    expect(onPassiveStall).not.toHaveBeenCalled();
    expect(onActiveStall).not.toHaveBeenCalled();
  });

  it('abort 信号优先于 stall 触发', async () => {
    const ac = new AbortController();
    const detector = new StallDetector();
    const onPassiveStall = jest.fn();
    detector.start(ac.signal, onPassiveStall, () => {});
    ac.abort();
    jest.advanceTimersByTime(30_000);
    expect(onPassiveStall).not.toHaveBeenCalled();
  });

  it('stallRate 计算', async () => {
    const detector = new StallDetector();
    // 模拟 100 次流，1 次 stall
    // ...
    expect(detector.stallRate).toBeLessThanOrEqual(0.01);
  });
});
```

#### 6.1.5 AbortCoordinator 3 种竞态测试

```typescript
describe('AbortCoordinator', () => {
  it('场景 A：LLM 已返回但工具未完成时 abort', async () => {
    const coord = new AbortCoordinator();
    const ctx = createMockContext({ pendingToolUse: 'tool_use_1' });
    // 模拟工具执行中 abort
    const toolCallPromise = someTool.call({}, { abortSignal: coord.signal } as any);
    await coord.abortAll('user Ctrl+C');
    const result = await toolCallPromise;
    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('aborted by user');
  });

  it('场景 B：abort 与 tool_result 配对完整性冲突', async () => {
    const coord = new AbortCoordinator();
    const ctx = createMockContext({
      pendingToolResults: new Map([['tool_use_1', { tool_use_id: 'tool_use_1', is_error: false, content: [] }]]),
    });
    await coord.abortAll('user Ctrl+C');
    await coord.handleRace({ scenario: 'B', ctx, pendingToolResult: ctx.pendingToolResults.get('tool_use_1') });
    expect(ctx.pendingToolResults.size).toBe(0);
    // transcript 中 tool_use 与 tool_result 都标记 aborted=true
    expect(ctx.messages.find(m => m.metadata?.aborted === true)).toBeDefined();
  });

  it('场景 C：多 agent 中 abort 一个，不传给其他 teammate', async () => {
    const coord = new AbortCoordinator();
    const orchestrator = { sendShutdownRequest: jest.fn() };
    await coord.abortAll('user Ctrl+C');
    expect(orchestrator.sendShutdownRequest).not.toHaveBeenCalled();  // 不自动传给 teammate
    await coord.handleRace({ scenario: 'C', ctx: createMockContext({}), teammateId: 'agent_A' as any });
    expect(orchestrator.sendShutdownRequest).toHaveBeenCalledWith('agent_A', expect.anything());
  });
});
```

#### 6.1.6 ToolUsePairGuard 配对保护测试

```typescript
describe('ToolUsePairGuard', () => {
  it('正常配对：tool_result 有配对 tool_use → 通过', async () => {
    const guard = new ToolUsePairGuard(/* adjustFn mock */);
    const ctx = createMockContext({
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: {} }] },
      ],
    });
    const result = guard.checkPairing(
      { tool_use_id: 'tu1', is_error: false, content: [] },
      ctx,
    );
    expect(result).toBe(true);
  });

  it('orphan tool_result：无配对 tool_use → fail-closed', async () => {
    const guard = new ToolUsePairGuard(/* adjustFn mock */);
    const ctx = createMockContext({ messages: [] });
    const result = guard.checkPairing(
      { tool_use_id: 'tu1', is_error: false, content: [] },
      ctx,
    );
    expect(result).toBe(false);
    // 应记审计日志
  });

  it('压缩前调 M7 adjust：corrections 非空时调整 compactRange', async () => {
    const adjustFn = jest.fn().mockReturnValue({
      adjustedRange: { start: 0, end: 5 },
      corrections: [{ type: 'extend_to_include_pair', index: 3, reason: 'tool_use 在保留区，配对的 tool_result 在压缩区' }],
    });
    const guard = new ToolUsePairGuard(adjustFn);
    const result = await guard.adjustBeforeCompact([], { start: 0, end: 3 });
    expect(result.adjustedRange).toEqual({ start: 0, end: 5 });
  });

  it('压缩前调 M7 adjust：error 时 fail-closed 抛错', async () => {
    const adjustFn = jest.fn().mockReturnValue({
      adjustedRange: { start: 0, end: 3 },
      corrections: [],
      error: { reason: 'tool_result 已丢失，无法修正', index: 2 },
    });
    const guard = new ToolUsePairGuard(adjustFn);
    await expect(guard.adjustBeforeCompact([], { start: 0, end: 3 }))
      .rejects.toThrow('INVARIANT_VIOLATION_TOOL_USE_PAIRING');
  });
});
```

#### 6.1.7 AutoCompactChecker 测试

```typescript
describe('AutoCompactChecker', () => {
  it('shouldCompact=true + reason=approaching_limit → 转 PTL_DEGRADE', async () => {
    const checker = new AutoCompactChecker(/* shouldAutoCompactFn mock */);
    const result = { shouldCompact: true, reason: 'approaching_limit' as const, triggerLayer: 'L2_session' as const };
    expect(checker.shouldTransitionToPtlDegrade(result)).toBe(true);
  });

  it('shouldCompact=false + reason=skip_user_disabled → 不压缩', async () => {
    const checker = new AutoCompactChecker(/* ... */);
    const result = { shouldCompact: false, reason: 'skip_user_disabled' as const };
    expect(checker.shouldTransitionToPtlDegrade(result)).toBe(false);
  });

  it('6 逃逸条件短路求值顺序', async () => {
    // 测试 6 个逃逸条件的优先级
  });

  it('触发层级由 token 用量决定：< 70% 不触发 / 70-85% L1 / 85-95% L2 / > 95% L3', async () => {
    // 测试 4 个 token 用量区间
  });
});
```

#### 6.1.8 BudgetGuard 测试

```typescript
describe('BudgetGuard', () => {
  it('record() 累计成本', async () => {
    const provider = { estimateCost: jest.fn().mockReturnValue({ usd: 0.5 }) } as any;
    const guard = new BudgetGuard(10, 8, provider);
    guard.record({ inputTokens: 1000, outputTokens: 500 });
    guard.record({ inputTokens: 1000, outputTokens: 500 });
    expect(guard['spentUsd']).toBe(1.0);
  });

  it('check() 超预算 → exceeded=true', async () => {
    const provider = { estimateCost: jest.fn().mockReturnValue({ usd: 11 }) } as any;
    const guard = new BudgetGuard(10, 8, provider);
    guard.record({ inputTokens: 1000, outputTokens: 500 });
    const result = guard.check();
    expect(result.exceeded).toBe(true);
    expect(result.remaining).toBe(-1);
  });

  it('软提醒阈值 80% → warning=true 但 exceeded=false', async () => {
    const provider = { estimateCost: jest.fn().mockReturnValue({ usd: 8.5 }) } as any;
    const guard = new BudgetGuard(10, 8, provider);
    guard.record({ inputTokens: 1000, outputTokens: 500 });
    const result = guard.check();
    expect(result.warning).toBe(true);
    expect(result.exceeded).toBe(false);
  });
});
```

#### 6.1.9 IterationLimiter 测试

```typescript
describe('IterationLimiter', () => {
  it('5xx 上限 1 次', () => { /* ... */ });
  it('429 上限 3 次', () => { /* ... */ });
  it('stall_passive 上限 1 次', () => { /* ... */ });
  it('stall_active 上限 1 次', () => { /* ... */ });
  it('reset() 清零所有计数', () => { /* ... */ });
  it('canRetry 超限返回 false', () => { /* ... */ });
});
```

### 6.2 集成测试

#### 6.2.1 正常一轮端到端（引用 L2 §4.2.1 时序图）

```typescript
describe('ReActLoop 正常一轮（user_input → tool_use → tool_result → 下一轮）', () => {
  it('完整流程：read_file 工具调用', async () => {
    // mock M1 LLMProvider.chatStream() 返回：
    //   1. text_delta("Reading package.json...")
    //   2. tool_use_start(id='tu1', name='read_file')
    //   3. tool_use_delta(id='tu1', input={path:'package.json'})
    //   4. tool_use_end(id='tu1')
    //   5. message_end(stop_reason='tool_use')
    // 然后下一轮 chatStream() 返回：
    //   1. text_delta("package.json 的内容是...")
    //   2. message_end(stop_reason='end_turn')
    const loop = createReActLoopWithMocks();
    const result = await loop.runTurn({ text: '读 package.json', sessionId: 's1', traceId: 't1' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.toolUseCount).toBe(1);
  });
});
```

#### 6.2.2 PTL 降级端到端（引用 L2 §4.2.2 时序图）

```typescript
describe('ReActLoop PTL 降级', () => {
  it('第一次 chatStream 返回 ptl → M7 collapse_drain → 第二次成功', async () => {
    // mock M1 第一次返回 stop_reason='ptl'
    // mock M7 handlePtl() 返回 success
    // mock M1 第二次返回 stop_reason='end_turn'
    const loop = createReActLoopWithMocks();
    const result = await loop.runTurn({ text: '...', sessionId: 's1', traceId: 't1' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.compactedBoundaryId).toBeDefined();
  });

  it('PTL 三步全失败 → circuit breaker 触发 → END_TURN + 用户提示', async () => {
    // mock M1 三次都返回 ptl
    // mock M7 handlePtl() 返回 failed（circuit breaker 3 次失败）
    const loop = createReActLoopWithMocks();
    const result = await loop.runTurn({ text: '...', sessionId: 's1', traceId: 't1' });
    expect(result.stopReason).toBe('ptl');
    // renderer 应渲染错误提示
  });
});
```

#### 6.2.3 abort 传播端到端（引用 L2 §4.2.3 时序图）

```typescript
describe('ReActLoop abort 传播', () => {
  it('用户 Ctrl+C → LLMProvider + 工具 + 子 agent 都收到 abort', async () => {
    const loop = createReActLoopWithMocks();
    const turnPromise = loop.runTurn({ text: 'long task', sessionId: 's1', traceId: 't1' });
    await wait(100);  // 让循环进入 CALL_LLM 或 TOOL_EXECUTE
    await loop.handleUserInterrupt('user Ctrl+C');
    const result = await turnPromise;
    expect(result.interrupted).toBe(true);
    expect(result.stopReason).toBe('user_interrupt');
    // 验证 LLMProvider.chatStream() 的 abortSignal 已触发
    // 验证工具的 abortSignal 已触发
  });
});
```

#### 6.2.4 agent_router fork 端到端（引用 L2 §4.2.4 时序图）

```typescript
describe('ReActLoop agent_router fork', () => {
  it('tool_use(agent_router, route=fork) → M5 spawn 子 agent → 结果回注', async () => {
    // mock M1 返回 tool_use(agent_router, {route:'fork', prompt:'...'})
    // mock M5 spawn 子 agent 返回 result
    const loop = createReActLoopWithMocks();
    const result = await loop.runTurn({ text: 'fork a subtask', sessionId: 's1', traceId: 't1' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.toolUseCount).toBe(1);  // agent_router 算 1 个 tool_use
  });
});
```

#### 6.2.5 五层拦截失败端到端（引用 L2 §4.2.5 时序图）

```typescript
describe('ReActLoop 五层拦截失败', () => {
  it('bash "rm -rf /" → Layer 2 权限规则 deny → tool_result is_error 回注', async () => {
    // mock M1 返回 tool_use(bash, {command:'rm -rf /'})
    // mock M4.intercept() 返回 deny(layer=2, reason='command blacklist')
    const loop = createReActLoopWithMocks();
    const result = await loop.runTurn({ text: 'rm -rf /', sessionId: 's1', traceId: 't1' });
    expect(result.stopReason).toBe('end_turn');
    // 验证 tool_result 标 is_error=true
  });
});
```

#### 6.2.6 Shutdown 四步握手端到端（引用 L2 §4.2.6 时序图）

```typescript
describe('ReActLoop Shutdown 四步握手', () => {
  it('主 agent Ctrl+C → shutdown_request → teammate approve → 清理退出', async () => {
    // mock M5 spawn 了 teammate A
    // mock M5 sendShutdownRequest() → teammate 返回 approve=true
    const loop = createReActLoopWithMocks();
    // ...
  });
});
```

### 6.3 不变量测试

#### 6.3.1 不变量 #3：tool_use/tool_result 配对完整性

```typescript
describe('不变量 #3: tool_use/tool_result 配对完整性', () => {
  it('正常配对：每个 tool_use 有对应 tool_result', async () => {
    // 跑 100 轮 ReActLoop，每轮验证 messages 中所有 tool_use 都有配对 tool_result
  });

  it('压缩不破坏配对：压缩后所有 tool_use 仍有配对 tool_result', async () => {
    // 跑 ReActLoop 触发 autocompact，验证压缩后配对完整
  });

  it('orphan tool_result：M2 侧拒绝写入 transcript', async () => {
    // 模拟 M3 返回未配对的 tool_result，验证 ToolUsePairGuard 拒绝
  });

  it('orphan tool_use：M2 不进入 CALL_LLM（避免 LLM 困惑）', async () => {
    // 模拟 stream_end 时有 tool_use 但无 tool_result（不应发生，但测守卫）
  });

  it('adjust 修正：压缩区间破坏配对时自动扩展', async () => {
    // 模拟压缩区间只含 tool_use 不含 tool_result，验证 adjust 自动扩展
  });

  it('adjust 失败：tool_result 已丢失时 fail-closed 报错', async () => {
    // 模拟 tool_result 已丢失，验证 adjust 抛错
  });
});
```

#### 6.3.2 关联不变量 #11：autocompact circuit breaker 3 次触发

```typescript
describe('关联不变量 #11: autocompact circuit breaker', () => {
  it('PTL 三步连续 3 次失败 → circuit breaker 触发 → END_TURN', async () => {
    // mock M1 三次返回 ptl
    // 验证 M7 PtlHandler 的 circuit breaker 触发
  });

  it('circuit breaker 触发后用户提示手动 /compact', async () => {
    // 验证 renderer.renderError 输出提示
  });
});
```

#### 6.3.3 关联不变量 #12：PTL 三步必走完

```typescript
describe('关联不变量 #12: PTL 三步必走完', () => {
  it('Step 1 collapse_drain 失败 → 继续 Step 2 reactive_compact', async () => {
    // mock M7 handlePtl() 第一步失败
    // 验证继续走第二步
  });

  it('Step 2 reactive_compact 失败 → 继续 Step 3 error', async () => {
    // mock M7 handlePtl() 第二步失败
    // 验证走第三步报错
  });

  it('不跳步：不直接从 Step 1 跳到 Step 3', async () => {
    // 验证三步顺序执行
  });
});
```

### 6.4 性能基准测试（引用 L2 §9.4，不重复）

M2 相关性能指标（PRD mod-02 §6.1）：

| 指标 | 目标值 | 测量方式 |
|------|-------|---------|
| TTFT（首 token） | ≤ 2s | LLMProvider 埋点（M2 CALL_LLM → STREAM_RENDER 首 chunk） |
| 流式 stall 率 | ≤ 1% | stall_count / total_streams |
| 工具调用平均延迟（除 Bash/Web） | ≤ 1s | tool.call() 埋点（M2 TOOL_EXECUTE 状态） |
| API 5xx 重试成功率（含 fallback model 降级） | ≥ 95% | ModelDegrader 埋点 |
| PTL 紧急降级成功率 | 100% | PtlHandler 埋点 |
| autocompact 连续失败 circuit breaker | 3 次触发 | CircuitBreaker 埋点 |

L2 §9.4 已设计完整性能基准测试方案（CI runner 规格 + 基线数据 + 容忍波动 ±10%），本文不重复。

---

## 7. 里程碑对齐

### 7.1 M1 迭代 1（2 周）

M2 在 M1 迭代 1 交付：

| 组件 | 文件路径 | 验收标准 |
|------|---------|---------|
| `FSMController`（8 状态 + 26 条转换） | `src/core/fsm.ts` | 26 条转换规则每条一个测试用例 PASS |
| `ReActLoop.runTurn()`（主流程骨架） | `src/core/react-loop.ts` | 正常一轮端到端（read_file 工具）PASS |
| `TerminationHandler`（11 种 stop_reason 分支） | `src/core/termination.ts` | 11 种分支每条一个测试用例 PASS |
| `StreamRenderer` 接口（终端 Ink 实现） | `src/core/renderer.ts` + `src/ui/ink-renderer.ts` | text_delta / tool_use_start / tool_use_end / message_end 4 个 chunk 类型渲染 PASS |
| `ReActLoopContext` | `src/core/context.ts` | 单轮上下文字段完整 |

引用 L2 §11.1 M1 迭代 1 交付物，本文不重复。

### 7.2 M1 迭代 2（2 周）

M2 在 M1 迭代 2 交付：

| 组件 | 文件路径 | 验收标准 |
|------|---------|---------|
| `ModelDegrader`（5 步降级 + 429 退避） | `src/core/degrader.ts` | 5xx 降级 5 步 PASS / 429 退避 3 次指数退避 PASS |
| `StallDetector`（被动 30s + 主动 90s） | `src/core/stall.ts` | 双定时器 PASS / abort 优先级 PASS / stallRate ≤ 1% PASS |
| `AbortCoordinator`（3 种竞态处理） | `src/core/abort.ts` | 场景 A/B/C 各一个测试用例 PASS |
| `IterationLimiter` | `src/core/iteration-limiter.ts` | 5xx/429/stall_passive/stall_active 上限 PASS |
| `ToolUsePairGuard`（M2 侧配对检查） | `src/core/pairing-guard.ts` | 正常配对 / orphan tool_result / adjust 修正 3 个场景 PASS |

引用 L2 §11.2 M1 迭代 2 交付物，本文不重复。

### 7.3 M1 迭代 3（2 周）

M2 在 M1 迭代 3 交付：

| 组件 | 文件路径 | 验收标准 |
|------|---------|---------|
| `AutoCompactChecker`（M7 shouldAutoCompact 调用） | `src/core/autocompact-checker.ts` | 6 逃逸条件 PASS / 4 触发层级 PASS |
| `BudgetGuard` | `src/core/budget.ts` | 超预算 / 软提醒 / budget_continuation 协同 PASS |
| `TaskRunner`（多轮调度 + session resume） | `src/core/runner.ts` | 多轮调度 PASS / resume 续命 PASS |
| PTL 降级端到端（M7 集成） | `src/core/react-loop.ts` | PTL 三步端到端 PASS / circuit breaker 触发 PASS |

引用 L2 §11.3 M1 迭代 3 交付物，本文不重复。

### 7.4 M1 退出标准（引用 L2 §11.9，不重复）

L2 §11.9 已设计 M1 退出标准量化清单。M2 相关：

- TTFT ≤ 2s 实测
- resume 成功率 ≥ 95% 实测
- 5 个典型用户场景端到端跑通（read_file / edit_file / bash / glob / grep）
- 不变量 #3 / #11 / #12 相关测试全 PASS
- 流式 stall 率 ≤ 1% 实测
- API 5xx 重试成功率 ≥ 95% 实测

---

## 8. 开放问题

### 8.1 v2.x 演进项（引用 PRD §8.4，不重复）

PRD mod-02 §8.4 已列 v2.x 演进项：

- **跨 provider fallback chain**：`fallbackChain: ["openai:gpt-4", "bedrock:claude", "ollama:llama3"]`，涉及多 provider 认证状态管理（M1 CredentialsStore 需扩展）
- **主动 stall 检测的自适应阈值**：根据历史 stall 率动态调整 90s 阈值（高 stall 率 provider 缩短到 60s，低 stall 率 provider 延长到 120s）

### 8.2 v3.x 演进项

- **ReAct Loop 可视化**：在 IDE 协议接入模式下，实时显示 FSM 状态转换图（调试用）
- **多模态 ReAct**：支持 image / audio chunk 的流式渲染（M1 Capabilities.supportsMultiModal 已声明，但 M2 尚未实现多模态 chunk 的渲染契约）
- **自适应重试预算**：根据 provider 历史错误率动态调整 IterationLimiter 上限（高错误率 provider 放宽到 5xx 2 次 / 429 5 次）

### 8.3 待定决策

| # | 待定项 | 评估时间 | 影响 |
|---|--------|---------|------|
| 1 | stall_passive 重发是否切换 fallbackModel（v1.0 同 model 重发） | M1 迭代 2 | 若同 model 重发失败率高，需评估切换 fallbackModel |
| 2 | budget_exceeded 软提醒的 UX 形式（弹窗 / inline / 命令行提示） | M1 迭代 3 | 影响用户续命决策 |
| 3 | max_output_tokens 两阶段升级的具体 slot 优化策略 | M1 迭代 2 | 当前仅"slot 优化 → context window 升级"两步，未细化 slot 优化算法 |

### 8.4 依赖其他模块的交付物

M2 开工前需就绪的交付物：

- **M1 LLMProvider 接口**：`chatStream()` / `chat()` / `countTokens()` / `estimateCost()` 必须就绪，`stop_reason` 输出必须与 M2 状态机分支匹配（11 种之一）
- **M7 PTL 三步实现**：`handlePtl()` / `shouldAutoCompact()` / `adjustIndexToPreserveAPIInvariants()` 必须就绪
- **M4 五层拦截链**：`InterceptionChain.intercept()` 必须就绪，返回 `PermissionDecision`
- **M3 工具池**：`ToolPool.mergeAndFilterTools()` + `Tool.call()` 必须就绪
- **omniagent-types.ts §3 / §11**：`ReActState`（本文新增）/ `StopReason` / `ShouldAutoCompactFn` / `AdjustIndexToPreserveAPIInvariantsFn` 必须定义

### 8.5 评测集依赖

本模块无直接评测集依赖（PRD mod-02 §8.3 已说明）。涉及 ReAct Loop 行为的验收（stall 率、PTL 降级成功率、降级 5 步重试成功率）通过 M1/M7 的端到端测试覆盖。

---

## 附录 A：与本模块相关的 L2/PRD 章节映射

| L3 章节 | 引用 PRD 章节 | 引用 L2 章节 | 补充内容 |
|---------|-------------|------------|---------|
| §1 模块概述 | mod-02 §1 | L2 §1 | 范围 / 边界 / 架构位置引用 |
| §2 组件清单 | mod-02 §3 | L2 §3 + types.ts §3/§11 | 22 个组件 + ReActState 新增 |
| §3.1 ReActLoop 主循环 | mod-02 §3.1 | L2 §4.1.1 | runTurn 代码骨架 |
| §3.2 FSMController | mod-02 §3.2 | L2 §4.1.1 + §4.1.2 + §4.4 | 状态转换 + 守卫 + 审计 |
| §3.3 TerminationHandler | mod-02 §4.1 | — | 11 种 stop_reason 分支表 |
| §3.4 ModelDegrader | mod-02 §4.2 + §4.1 | — | 5 步降级 + 429 退避 + stall 切非流式 |
| §3.5 StallDetector | mod-02 §4.3 | — | 双定时器 + stallRate 护栏 |
| §3.6 AbortCoordinator | mod-02 §3.3 | L2 §4.3 | 3 种竞态处理代码 |
| §3.7 ToolUsePairGuard | mod-02 §4.4 | L2 §3.11 | M2 侧配对检查 + M7 adjust 调用 |
| §3.8 AutoCompactChecker | mod-02 §4.4 | L2 §3.11 | M2 侧压缩判断 + 6 逃逸条件 |
| §3.9 BudgetGuard | mod-02 §4.1 | — | 预算跟踪 + 软提醒 |
| §3.10 StreamRenderer | mod-02 §3.1 | L2 §1 | 渲染契约（多模式共享） |
| §3.11 IterationLimiter | mod-02 §4.1 + §4.2 | — | 重试预算表 |
| §3.12 TaskRunner | mod-02 §3.1 | L2 §1 | 顶层入口 + 三种部署形态 |
| §4 与其他模块的交互 | mod-02 §5 | L2 §4.2 | 调用图 + 数据流 + 契约表 |
| §5 错误处理与降级 | mod-02 §4.1 | L2 §6 | 11 个错误码映射 + fail-closed |
| §6 测试用例骨架 | mod-02 §7 | L2 §9 | 单元 + 集成 + 不变量 + 性能 |
| §7 里程碑对齐 | mod-02 §8 | L2 §11 | M1 三迭代组件级交付物 |
| §8 开放问题 | mod-02 §8.4 | — | v2.x/v3.x 演进 + 待定决策 |

---

## 附录 B：L3-M2 文档不变量

1. **不重复 PRD**：PRD mod-02 已有的 8 状态 ASCII 图、11 种终止条件表、5 步降级列表、stall 检测描述、abort 传播描述，本文仅引用不复制
2. **不重复 L2**：L2 §4.1.1 状态转换表、§4.2 6 个时序图、§4.3 3 种竞态场景，本文仅引用不复制
3. **类型契约一致**：本文新增的 `ReActState` / `ReActEvent` / `GuardCheckResult` 与 omniagent-types.ts §3 风格一致（branded type + union type + interface）
4. **接口签名一致**：本文引用的 `LLMProvider` / `Tool` / `PermissionDecision` / `ShouldAutoCompactFn` / `AdjustIndexToPreserveAPIInvariantsFn` 签名与 omniagent-types.ts 一致
5. **错误码一致**：本文引用的 11 个错误码（PROVIDER_5XX / PROVIDER_429 / PROVIDER_TIMEOUT / TOOL_EXECUTION_ERROR / TOOL_TIMEOUT / TOOL_PERMISSION_DENIED / PTL_ERROR / AUTOCOMPACT_CIRCUIT_BREAKER / BUDGET_EXCEEDED / USER_INTERRUPT / INVARIANT_VIOLATION_TOOL_USE_PAIRING）与 L2 §6 + omniagent-types.ts §19 一致
6. **里程碑一致**：本文 M1 三迭代交付物与 L2 §11.1/§11.2/§11.3 一致
7. **不变量一致**：本文守护的不变量 #3（tool_use/tool_result 配对完整性）与附录 A 18 项不变量一致；关联不变量 #11（autocompact circuit breaker）+ #12（PTL 三步必走完）与 M7 共同守护
8. **决策一致**：本文实现的 5 步降级（同 provider fallback，决策 C1）与 PRD mod-02 §8.1 决策 C1 一致
9. **不引入新供应商专有名词**：示例用 openai/bedrock/ollama/anthropic/deepseek/vertexai 等已有 provider，不新增
