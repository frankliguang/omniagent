/**
 * AbortCoordinator（L3-M2 §3.6 — 信号传播 + 3 种竞态处理）
 *
 * 3 种 abort 竞态场景：
 * - 场景 A：LLM 已返回但工具未完成时 abort
 *   → abort 信号传给工具（通过 ToolContext.abortSignal），工具返回 is_error="aborted by user"
 * - 场景 B：abort 与 tool_result 配对完整性冲突
 *   → tool_result 已在队列则丢弃（不回注 LLM），transcript 中 tool_use/tool_result 都标 aborted=true
 * - 场景 C：多 agent 中 abort 一个
 *   → 每个 agent 独立 AbortController，主 agent abort 不自动传给 teammate
 *   → teammate 通过 M5 shutdown_request 通知（四步握手，不强杀）
 *
 * M1 迭代 2 stub：
 * - 实现 AbortController 包装 + abortAll + 场景 A 处理
 * - 场景 B 的 pendingToolResults 丢弃（M2 自己维护队列）
 * - 场景 C 不实现（M5 在 M2 阶段交付）
 */

import type { AgentId, OmniAgentError, ToolUseId } from '../types/index.js';

export interface AbortContext {
  agentId: AgentId;
  /** 触发原因（user / budget / timeout / crash） */
  reason: 'user' | 'budget' | 'timeout' | 'crash';
  /** 人类可读的细节 */
  detail?: string;
}

export interface AbortResult {
  /** 已 abort 的 tool_use IDs（场景 A：工具正在执行被中断） */
  abortedToolUseIds: ToolUseId[];
  /** 丢弃的 pending tool_result IDs（场景 B：已完成但未回注 LLM） */
  discardedToolResultIds: ToolUseId[];
  /** abort 时刻（用于审计 + transcript 标记） */
  timestamp: string;
}

/**
 * 每个 agent 一个 AbortCoordinator 实例。
 * 主 agent 与 teammate 各自独立，不共享信号。
 */
export class AbortCoordinator {
  private controller: AbortController = new AbortController();
  private readonly agentId: AgentId;
  private aborted = false;
  private abortContext?: AbortContext;

  /** pending tool_results 队列（场景 B 用）：toolUseId → 是否已完成 */
  private readonly pendingToolResults: Set<ToolUseId> = new Set();

  constructor(agentId: AgentId) {
    this.agentId = agentId;
  }

  /** 获取 AbortSignal（传给 LLMProvider.chatStream / tool.call） */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 是否已 abort */
  get isAborted(): boolean {
    return this.aborted;
  }

  /** 获取 abort 上下文（审计用） */
  get context(): AbortContext | undefined {
    return this.abortContext;
  }

  /**
   * 触发 abort（场景 A + B 合并实现）
   *
   * @param ctx abort 上下文
   * @param inFlightToolUseIds 当前正在执行的工具 tool_use IDs（场景 A）
   * @returns abort 结果，含被丢弃的 pending tool_result IDs
   */
  async abortAll(
    ctx: AbortContext,
    inFlightToolUseIds: ToolUseId[] = [],
  ): Promise<AbortResult> {
    if (this.aborted) {
      // 已 abort，幂等返回
      return {
        abortedToolUseIds: [],
        discardedToolResultIds: [],
        timestamp: new Date().toISOString(),
      };
    }

    this.aborted = true;
    this.abortContext = ctx;

    // 场景 A：abort 信号传给正在执行的工具
    // 工具通过 ToolContext.abortSignal 监听，fetch 等长请求自动中断
    this.controller.abort();

    // 场景 B：丢弃 pending tool_results（不回注 LLM）
    const discardedToolResultIds: ToolUseId[] = [];
    for (const id of this.pendingToolResults) {
      discardedToolResultIds.push(id);
    }
    this.pendingToolResults.clear();

    return {
      abortedToolUseIds: inFlightToolUseIds,
      discardedToolResultIds,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 标记某 tool_result 已完成但尚未回注（场景 B 检测用）
   *
   * 场景 B 时间线：
   *   T0: 工具执行完成返回 tool_result
   *   T1: 同时刻用户 Ctrl+C
   *   T2: abort 信号到达，tool_result 已在 pendingToolResults
   *
   * 调用时机：工具执行完成时，立即标记（即使还没回注 LLM）
   * 丢弃时机：abortAll 时统一丢弃
   */
  markToolResultPending(toolUseId: ToolUseId): void {
    if (this.aborted) {
      // 已 abort，不再标记（直接丢弃）
      return;
    }
    this.pendingToolResults.add(toolUseId);
  }

  /**
   * 标记某 tool_result 已回注 LLM（从 pending 移除）
   *
   * 调用时机：tool_result 写入 transcript 后
   */
  clearToolResultPending(toolUseId: ToolUseId): void {
    this.pendingToolResults.delete(toolUseId);
  }

  /**
   * 重置（新 turn 或 resume 时）
   *
   * 注意：AbortController 一旦 abort 不可重用，需新建
   */
  reset(): void {
    this.controller = new AbortController();
    this.aborted = false;
    this.abortContext = undefined;
    this.pendingToolResults.clear();
  }

  /** 把 abort 包装成 OmniAgentError（供 ReActLoop 抛错 / 标 stop_reason=user_interrupt） */
  toOmniAgentError(): OmniAgentError {
    const ctx = this.abortContext ?? { reason: 'user' as const, agentId: this.agentId };
    return {
      code: 'USER_INTERRUPT',
      message: `aborted by ${ctx.reason}${ctx.detail ? `: ${ctx.detail}` : ''}`,
      module: 'M2',
      retryable: false,
    };
  }
}
