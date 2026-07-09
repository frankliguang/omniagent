/**
 * ReActLoop（L3-M2 §3.1 — 主循环状态机）
 *
 * M1 迭代 1：6 状态简化版（IDLE → BUILD_CONTEXT → CALL_LLM → STREAM_RENDER → EVAL_STOP_REASON → END_TURN）
 * M1 迭代 2：集成 TerminationHandler + ModelDegrader + AbortCoordinator + IterationLimiter + ToolUsePairGuard
 *           11 种 stop_reason 全分支处理（含降级 / 退避 / 中断 / 预算）
 *
 * 状态转换：
 *  - IDLE → BUILD_CONTEXT: 用户输入
 *  - BUILD_CONTEXT → CALL_LLM: WorkingMemory 全量注入
 *  - CALL_LLM → STREAM_RENDER: provider.chatStream() 首个 chunk
 *  - STREAM_RENDER → EVAL_STOP_REASON: message_end chunk
 *  - EVAL_STOP_REASON → END_TURN: end_turn / user_interrupt / budget_exceeded / fail
 *  - EVAL_STOP_REASON → TOOL_EXECUTE: tool_use / tool_execution_error
 *  - EVAL_STOP_REASON → CALL_LLM: max_output_tokens / stall_passive / stall_active / 5xx / 429（重试）
 *  - EVAL_STOP_REASON → PTL_DEGRADE: ptl（M1 stub：直接 END_TURN）
 *  - TOOL_EXECUTE → BUILD_CONTEXT: tool_result 回注，下一轮
 *
 * M1 迭代 3 待补：PTL 三步降级 / stall 双定时器 / shouldAutoCompact 调用
 */

import type {
  ChatRequest,
  ContentBlock,
  LLMProvider,
  Message,
  StopReason,
  TextBlock,
  Tool,
  ToolInput,
  ToolResult,
  ToolUseBlock,
  ToolUseId,
  TokenUsage,
} from '../types/index.js';

import type { WorkingMemory } from '../memory/working-memory.js';

import { AbortCoordinator } from './abort.js';
import { IterationLimiter } from './iteration-limiter.js';
import { ModelDegrader } from './degrader.js';
import { TerminationHandler, type TerminationDecision } from './termination-handler.js';
import { ToolUsePairGuard } from './pairing-guard.js';

// ============================================================
// 类型定义
// ============================================================

export type ReActState =
  | 'IDLE'
  | 'BUILD_CONTEXT'
  | 'CALL_LLM'
  | 'STREAM_RENDER'
  | 'EVAL_STOP_REASON'
  | 'TOOL_EXECUTE'
  | 'PTL_DEGRADE'
  | 'END_TURN';

/** 单轮结果 */
export interface TurnResult {
  stopReason: StopReason;
  tokenUsage: TokenUsage;
  iterations: number;
  /** 累计的 assistant 消息（含 tool_use） */
  messages: Message[];
}

/** 流式渲染器接口（UI 层注入，headless 模式可选） */
export interface StreamRenderer {
  onMessageStart?(message: Message): void;
  onTextDelta?(text: string): void;
  onToolUseStart?(id: string, name: string): void;
  onToolUseDelta?(id: string, input: ToolInput): void;
  onToolUseEnd?(id: string): void;
  onMessageEnd?(stopReason: StopReason, tokenUsage: TokenUsage): void;
  onError?(error: { code: string; message: string }): void;
}

/** 工具执行上下文（M2 传给 M3 tool.call） */
export interface ReActToolContext {
  cwd: string;
  permissionMode: import('../types/index.js').PermissionMode;
  agentId: import('../types/index.js').AgentId;
  abortSignal: AbortSignal;
  agentRole: import('../types/index.js').AgentRole;
  toolUseId: ToolUseId;
}

// ============================================================
// ReActLoop
// ============================================================

export interface ReActLoopOptions {
  provider: LLMProvider;
  tools?: Tool[];
  memory: WorkingMemory;
  renderer?: StreamRenderer;
  model?: string;
  fallbackModel?: string;
  cwd?: string;
  systemPrompt?: string;
  maxIterations?: number;
  /** M2 组件（可选，默认创建） */
  limiter?: IterationLimiter;
  degrader?: ModelDegrader;
  terminationHandler?: TerminationHandler;
  pairGuard?: ToolUsePairGuard;
  abortCoordinator?: AbortCoordinator;
}

export class ReActLoop {
  private readonly provider: LLMProvider;
  private readonly tools: Map<string, Tool>;
  private readonly memory: WorkingMemory;
  private readonly renderer?: StreamRenderer;
  private readonly model: string;
  private readonly fallbackModel?: string;
  private readonly cwd: string;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;

  // M2 组件
  private readonly limiter: IterationLimiter;
  private readonly degrader: ModelDegrader;
  private readonly terminationHandler: TerminationHandler;
  private readonly pairGuard: ToolUsePairGuard;
  private readonly abortCoord: AbortCoordinator;

  private state: ReActState = 'IDLE';
  /** 当前实际使用的模型（5xx 降级后切换） */
  private currentModel: string;
  /** 是否切到非流式（stall_active 触发） */
  private nonStreaming = false;
  /** 429 attempt 计数 */
  private current429Attempt = 0;

  constructor(opts: ReActLoopOptions) {
    this.provider = opts.provider;
    this.tools = new Map((opts.tools ?? []).map(t => [t.name, t]));
    this.memory = opts.memory;
    this.renderer = opts.renderer;
    this.model = opts.model ?? 'gpt-4o';
    this.fallbackModel = opts.fallbackModel;
    this.cwd = opts.cwd ?? process.cwd();
    this.systemPrompt = opts.systemPrompt ?? 'You are a helpful assistant.';
    this.maxIterations = opts.maxIterations ?? 10;

    this.limiter = opts.limiter ?? new IterationLimiter();
    this.degrader = opts.degrader ?? new ModelDegrader();
    this.terminationHandler = opts.terminationHandler ?? new TerminationHandler();
    this.pairGuard = opts.pairGuard ?? new ToolUsePairGuard();
    this.abortCoord = opts.abortCoordinator ?? new AbortCoordinator('main' as never);

    this.currentModel = this.model;
  }

  /** 当前 FSM 状态（调试/测试用） */
  getState(): ReActState {
    return this.state;
  }

  /** 触发 abort（用户 Ctrl+C / 预算超限 / timeout） */
  async abort(reason: 'user' | 'budget' | 'timeout' | 'crash', detail?: string): Promise<void> {
    await this.abortCoord.abortAll(
      { agentId: 'main' as never, reason, detail },
      [],
    );
  }

  /** 单轮入口：用户输入 → END_TURN */
  async runTurn(userInput: string): Promise<TurnResult> {
    // IDLE → BUILD_CONTEXT
    this.state = 'BUILD_CONTEXT';
    this.memory.addMessage({
      role: 'user',
      content: [{ type: 'text', text: userInput }],
    });

    // 新 turn 重置 IterationLimiter（按"轮"算预算）
    this.limiter.reset();
    this.current429Attempt = 0;

    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const assistantMessages: Message[] = [];

    for (let iter = 0; iter < this.maxIterations; iter++) {
      // BUILD_CONTEXT → CALL_LLM
      this.state = 'CALL_LLM';

      const chatReq: ChatRequest = {
        model: this.currentModel,
        messages: this.memory.getMessages(),
        systemPromptBlocks: [this.systemPrompt],
        tools: this.tools.size > 0 ? [...this.tools.values()] : undefined,
        fallbackModel: this.fallbackModel,
        abortSignal: this.abortCoord.signal,
      };

      // CALL_LLM + STREAM_RENDER: 消费 ChatChunk 流
      this.state = 'STREAM_RENDER';
      let streamResult: { assistantMessage: Message; stopReason: StopReason; tokenUsage: TokenUsage };
      try {
        // stall_active 触发后切非流式（用 chat() 替代 chatStream()）
        if (this.nonStreaming) {
          streamResult = await this.consumeNonStream(chatReq);
        } else {
          streamResult = await this.consumeStream(chatReq);
        }
      } catch (err) {
        // 流式调用抛错（abort / 网络）：转 user_interrupt 或 provider_5xx
        const errMsg = (err as Error).message ?? '';
        if (this.abortCoord.isAborted || errMsg.includes('abort')) {
          return this.endTurn('user_interrupt', totalUsage, iter + 1, assistantMessages);
        }
        // 其他错误视为 5xx
        streamResult = {
          assistantMessage: { role: 'assistant', content: [{ type: 'text', text: '' }] },
          stopReason: 'provider_5xx',
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };
      }

      const { assistantMessage, stopReason, tokenUsage } = streamResult;

      totalUsage = {
        inputTokens: totalUsage.inputTokens + tokenUsage.inputTokens,
        outputTokens: totalUsage.outputTokens + tokenUsage.outputTokens,
        cacheReadTokens: (totalUsage.cacheReadTokens ?? 0) + (tokenUsage.cacheReadTokens ?? 0),
      };

      this.memory.addMessage(assistantMessage);
      assistantMessages.push(assistantMessage);

      // STREAM_RENDER → EVAL_STOP_REASON
      this.state = 'EVAL_STOP_REASON';

      // 用 TerminationHandler 决策
      const decision = this.terminationHandler.handle({
        stopReason,
        tokenUsage,
        ctx: {
          degrader: this.degrader,
          degraderCtx: {
            currentModel: this.currentModel,
            fallbackModel: this.fallbackModel,
            limiter: this.limiter,
          },
        },
        current429Attempt: this.current429Attempt,
      });

      // 根据决策推进 FSM
      const nextIter = await this.applyDecision(decision, iter, assistantMessages);
      if (nextIter.done) {
        return {
          stopReason: nextIter.stopReason ?? decision.stopReason,
          tokenUsage: totalUsage,
          iterations: iter + 1,
          messages: assistantMessages,
        };
      }
      // 否则继续下一轮循环（TOOL_EXECUTE → BUILD_CONTEXT 已完成）
    }

    // 超过 maxIterations：硬上限
    this.state = 'END_TURN';
    return {
      stopReason: 'max_output_tokens',
      tokenUsage: totalUsage,
      iterations: this.maxIterations,
      messages: assistantMessages,
    };
  }

  /**
   * 应用 TerminationHandler 的决策，推进 FSM
   *
   * @returns done=true 表示 END_TURN（终止循环），done=false 表示继续
   */
  private async applyDecision(
    decision: TerminationDecision,
    _iter: number,
    assistantMessages: Message[],
  ): Promise<{ done: boolean; stopReason?: StopReason }> {
    const action = decision.action;

    switch (action.kind) {
      case 'end_turn':
        this.state = 'END_TURN';
        return { done: true };

      case 'execute_tools': {
        // EVAL_STOP_REASON → TOOL_EXECUTE
        this.state = 'TOOL_EXECUTE';
        const lastAssistant = assistantMessages[assistantMessages.length - 1];
        const toolUses = this.pairGuard.extractToolUses(lastAssistant);
        const toolResults = await this.executeTools(toolUses);

        // tool_result 配对检查（不变量 #3）
        for (const result of toolResults) {
          if (!this.pairGuard.checkToolResultHasPairing(result, this.memory.getMessages())) {
            // orphan tool_result：fail-closed，拒绝写入 transcript
            this.state = 'END_TURN';
            return { done: true, stopReason: 'tool_execution_error' };
          }
          this.memory.addMessage({
            role: 'tool',
            content: [{
              type: 'tool_result',
              tool_use_id: result.tool_use_id,
              content: result.content,
              is_error: result.is_error,
            }],
          });
        }

        // 检查所有 tool_use 是否都有配对 tool_result（TOOL_EXECUTE → CALL_LLM 转换前）
        const pairingCheck = this.pairGuard.checkAllToolUsesPaired(this.memory.getMessages());
        if (!pairingCheck.ok && pairingCheck.orphanToolUseIds.length > 0) {
          // orphan tool_use：不进 CALL_LLM（避免 LLM 困惑），fail-closed
          this.state = 'END_TURN';
          return { done: true, stopReason: 'tool_execution_error' };
        }

        // 回到 BUILD_CONTEXT 继续下一轮
        this.state = 'BUILD_CONTEXT';
        return { done: false };
      }

      case 'escalate_max_output':
        // M1 stub：直接回 CALL_LLM 重发（slot 优化算法 M1 迭代 3 交付）
        this.state = 'BUILD_CONTEXT';
        return { done: false };

      case 'ptl_degrade':
        // M1 stub：PTL 三步降级委托 M7（迭代 3 交付），此处直接 END_TURN
        this.state = 'END_TURN';
        return { done: true };

      case 'user_interrupt':
        // 保留状态，可 resume
        this.state = 'END_TURN';
        return { done: true };

      case 'retry_stall_passive':
        // 同 model 重发
        this.limiter.consumeRetry('stall_passive');
        this.state = 'BUILD_CONTEXT';
        return { done: false };

      case 'switch_to_non_streaming':
        // 切非流式
        this.limiter.consumeRetry('stall_active');
        this.nonStreaming = true;
        this.state = 'BUILD_CONTEXT';
        return { done: false };

      case 'degrade_5xx': {
        // 5xx 降级：切 fallbackModel + 清 partial
        this.limiter.consumeRetry('5xx');
        if (action.degraderAction.kind === 'degrade_5xx') {
          this.currentModel = action.degraderAction.toModel;
        }
        // 清 partial：移除最后一条 assistant message（避免 partial 输出污染下一模型）
        const msgs = this.memory.getMessages();
        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
          this.memory.removeLastMessage();
          assistantMessages.pop();
        }
        this.state = 'BUILD_CONTEXT';
        return { done: false };
      }

      case 'retry_429': {
        // 429 退避：等 backoffMs 后回 CALL_LLM
        this.limiter.consumeRetry('429');
        if (action.degraderAction.kind === 'retry_429') {
          await sleep(action.degraderAction.backoffMs);
          this.current429Attempt += 1;
        }
        this.state = 'BUILD_CONTEXT';
        return { done: false };
      }

      case 'tool_execution_error':
        // tool_result 已标 is_error 并回注，回 CALL_LLM 让 LLM 决策
        this.state = 'BUILD_CONTEXT';
        return { done: false };

      case 'budget_exceeded':
        // 软提醒：END_TURN
        this.state = 'END_TURN';
        return { done: true };

      case 'fail':
        // 降级失败：END_TURN + 用户提示
        this.state = 'END_TURN';
        return { done: true };
    }
  }

  /** 消费 ChatChunk 流，组装 assistant Message */
  private async consumeStream(chatReq: ChatRequest): Promise<{
    assistantMessage: Message;
    stopReason: StopReason;
    tokenUsage: TokenUsage;
  }> {
    const textParts: string[] = [];
    const toolUses: ToolUseBlock[] = [];
    let stopReason: StopReason = 'end_turn';
    let tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of this.provider.chatStream(chatReq)) {
      switch (chunk.type) {
        case 'message_start':
          this.renderer?.onMessageStart?.(chunk.message);
          break;
        case 'text_delta':
          textParts.push(chunk.text);
          this.renderer?.onTextDelta?.(chunk.text);
          break;
        case 'tool_use_start':
          toolUses.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: {} });
          this.renderer?.onToolUseStart?.(chunk.id, chunk.name);
          break;
        case 'tool_use_delta': {
          const tu = toolUses.find(t => t.id === chunk.id);
          if (tu) {
            tu.input = chunk.input;
            this.renderer?.onToolUseDelta?.(chunk.id, chunk.input);
          }
          break;
        }
        case 'tool_use_end':
          this.renderer?.onToolUseEnd?.(chunk.id);
          break;
        case 'message_end':
          stopReason = chunk.stopReason;
          tokenUsage = chunk.tokenUsage;
          this.renderer?.onMessageEnd?.(chunk.stopReason, chunk.tokenUsage);
          break;
        case 'error':
          this.renderer?.onError?.(chunk.error);
          throw new Error(`${chunk.error.code}: ${chunk.error.message}`);
        case 'message_delta':
          // metadata 更新（M1 stub：忽略，message_end 会带最终 usage）
          break;
      }
    }

    // 组装 assistant Message
    const content: ContentBlock[] = [];
    if (textParts.length) {
      content.push({ type: 'text', text: textParts.join('') } as TextBlock);
    }
    for (const tu of toolUses) {
      content.push(tu);
    }

    const assistantMessage: Message = {
      role: 'assistant',
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      metadata: {
        model: this.currentModel,
        provider: this.provider.id,
        stop_reason: stopReason,
        tokenUsage,
      },
    };

    return { assistantMessage, stopReason, tokenUsage };
  }

  /** 非流式调用（stall_active 触发后用 chat() 替代 chatStream()） */
  private async consumeNonStream(chatReq: ChatRequest): Promise<{
    assistantMessage: Message;
    stopReason: StopReason;
    tokenUsage: TokenUsage;
  }> {
    const response = await this.provider.chat(chatReq);
    // 渲染：把完整 message 的 text 与 tool_use 块逐个发到 renderer
    this.renderer?.onMessageStart?.(response.message);
    for (const block of response.message.content) {
      if (block.type === 'text') {
        this.renderer?.onTextDelta?.(block.text);
      } else if (block.type === 'tool_use') {
        this.renderer?.onToolUseStart?.(block.id, block.name);
        this.renderer?.onToolUseDelta?.(block.id, block.input);
        this.renderer?.onToolUseEnd?.(block.id);
      }
    }
    this.renderer?.onMessageEnd?.(response.stopReason, response.tokenUsage);
    return {
      assistantMessage: response.message,
      stopReason: response.stopReason,
      tokenUsage: response.tokenUsage,
    };
  }

  /** 执行所有 tool_use 块，返回 tool_result 列表 */
  private async executeTools(toolUses: ToolUseBlock[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const tu of toolUses) {
      // abort 检查
      if (this.abortCoord.isAborted) {
        results.push({
          tool_use_id: tu.id,
          content: [{ type: 'text', text: 'aborted by user' }],
          is_error: true,
          metadata: { duration_ms: 0 },
        });
        continue;
      }

      const tool = this.tools.get(tu.name);
      if (!tool) {
        results.push({
          tool_use_id: tu.id,
          content: [{ type: 'text', text: `tool not found: ${tu.name}` }],
          is_error: true,
          metadata: { duration_ms: 0 },
        });
        continue;
      }

      const ctx: ReActToolContext = {
        cwd: this.cwd,
        permissionMode: 'bypassPermissions',
        agentId: 'main' as never,
        abortSignal: this.abortCoord.signal,
        agentRole: 'main',
        toolUseId: tu.id,
      };

      try {
        // M1 stub：跳过 M4 拦截链，直接调 tool.call()
        // M1 迭代 2：补 M4 五层拦截（M3 阶段交付）
        const result = await tool.call(tu.input, ctx);
        results.push(result);
      } catch (err) {
        const errMsg = (err as Error).message ?? 'unknown error';
        const isAbort = this.abortCoord.isAborted || errMsg.toLowerCase().includes('abort');
        results.push({
          tool_use_id: tu.id,
          content: [{ type: 'text', text: isAbort ? 'aborted by user' : `tool execution failed: ${errMsg}` }],
          is_error: true,
          metadata: { duration_ms: 0 },
        });
      }
    }

    return results;
  }

  /** 终止 turn（辅助方法） */
  private endTurn(
    stopReason: StopReason,
    tokenUsage: TokenUsage,
    iterations: number,
    messages: Message[],
  ): TurnResult {
    this.state = 'END_TURN';
    return { stopReason, tokenUsage, iterations, messages };
  }

  /** 重置（新会话） */
  reset(): void {
    this.state = 'IDLE';
    this.memory.clear();
    this.limiter.reset();
    this.abortCoord.reset();
    this.currentModel = this.model;
    this.nonStreaming = false;
    this.current429Attempt = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
