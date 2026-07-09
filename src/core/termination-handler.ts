/**
 * TerminationHandler（L3-M2 §3.3 — 11 种 stop_reason 全分支处理）
 *
 * PRD mod-02 §4.1 列出 11 种终止条件。本节补每个分支的实施细节：
 *
 * | # | stop_reason        | 处理                     | 跳转                          |
 * |---|--------------------|-------------------------|-------------------------------|
 * | 1 | end_turn           | 正常结束                 | END_TURN                       |
 * | 2 | tool_use           | 执行工具（M4→M3）         | TOOL_EXECUTE                   |
 * | 3 | max_output_tokens  | 两阶段升级（slot→context）| CALL_LLM                       |
 * | 4 | ptl                | 紧急降级三步（M7）        | PTL_DEGRADE                    |
 * | 5 | user_interrupt     | 保留状态                 | END_TURN（可 resume）          |
 * | 6 | stall_passive_30s  | 同 model 重发            | CALL_LLM                       |
 * | 7 | stall_active_90s   | 切非流式                  | CALL_LLM（用 chat() 替代）     |
 * | 8 | provider_5xx       | 降级 5 步                | CALL_LLM（切 fallbackModel）   |
 * | 9 | provider_429       | 退避重试                  | CALL_LLM（指数退避）           |
 * | 10| tool_execution_error| tool_result 标 is_error  | CALL_LLM（回注 LLM 决策）      |
 * | 11| budget_exceeded    | 软提醒                    | END_TURN（让用户确认）         |
 *
 * 关键设计：
 * - 不无限重试（IterationLimiter 强制上限）
 * - 不臆造结果（降级失败明确报错）
 * - 保留可 resume（user_interrupt 保留 messages）
 *
 * M1 迭代 2 stub：
 * - 实现 handle() 返回 next state + action
 * - PTL 降级（#4）委托 M7（M1 迭代 3 交付完整实现，此处留 hook）
 * - max_output_tokens 两阶段升级（#3）M1 stub：仅返回 CALL_LLM + 提示
 */

import type { StopReason, TokenUsage } from '../types/index.js';
import type { ModelDegrader, DegraderAction, DegraderContext } from './degrader.js';

/** ReActLoop 的下一状态（与 react-loop.ts ReActState 对齐） */
export type NextState =
  | 'END_TURN'
  | 'TOOL_EXECUTE'
  | 'CALL_LLM'
  | 'PTL_DEGRADE';

/** TerminationHandler 返回的决策 */
export interface TerminationDecision {
  stopReason: StopReason;
  nextState: NextState;
  /** 副作用描述（ReActLoop 侧执行） */
  action: TerminationAction;
}

export type TerminationAction =
  /** 正常结束：写 transcript + 通知 UI */
  | { kind: 'end_turn'; tokenUsage: TokenUsage }
  /** 执行工具：提取 tool_use 块 → M4 五层拦截 → M3 工具执行 */
  | { kind: 'execute_tools'; tokenUsage: TokenUsage }
  /** 两阶段升级：slot 优化 / context window 升级（M1 stub 仅返回 CALL_LLM） */
  | { kind: 'escalate_max_output'; tokenUsage: TokenUsage; reason: 'slot_optimize' | 'context_window_upgrade' }
  /** PTL 降级：委托 M7 collapse_drain → reactive_compact → error */
  | { kind: 'ptl_degrade'; tokenUsage: TokenUsage }
  /** 用户中断：保留状态，可 resume */
  | { kind: 'user_interrupt'; reason: string }
  /** stall_passive：同 model 重发 */
  | { kind: 'retry_stall_passive'; tokenUsage: TokenUsage }
  /** stall_active：切非流式 */
  | { kind: 'switch_to_non_streaming'; tokenUsage: TokenUsage }
  /** 5xx 降级：切 fallbackModel + 清 partial */
  | { kind: 'degrade_5xx'; degraderAction: DegraderAction }
  /** 429 退避 */
  | { kind: 'retry_429'; degraderAction: DegraderAction }
  /** tool_execution_error：tool_result 标 is_error 回注 */
  | { kind: 'tool_execution_error'; tokenUsage: TokenUsage }
  /** 预算超限：软提醒让用户确认 */
  | { kind: 'budget_exceeded'; remaining: number }
  /** 降级失败：END_TURN + 用户提示 */
  | { kind: 'fail'; reason: string };

export interface TerminationHandlerContext {
  degrader: ModelDegrader;
  degraderCtx: DegraderContext;
}

export interface TerminationHandlerParams {
  stopReason: StopReason;
  tokenUsage: TokenUsage;
  ctx: TerminationHandlerContext;
  /** 429 时的 retry-after（ms） */
  retryAfterMs?: number;
  /** 当前 429 attempt 序号 */
  current429Attempt?: number;
  /** budget 剩余（USD），budget_exceeded 时填 */
  budgetRemaining?: number;
  /** abort 触发原因（user_interrupt 时填） */
  abortReason?: string;
}

/**
 * TerminationHandler — 纯函数决策
 *
 * ReActLoop 在 EVAL_STOP_REASON 状态调用 handle()，根据返回的 nextState + action 推进 FSM。
 */
export class TerminationHandler {
  handle(params: TerminationHandlerParams): TerminationDecision {
    const { stopReason, tokenUsage, ctx } = params;

    switch (stopReason) {
      case 'end_turn':
        return {
          stopReason,
          nextState: 'END_TURN',
          action: { kind: 'end_turn', tokenUsage },
        };

      case 'tool_use':
        return {
          stopReason,
          nextState: 'TOOL_EXECUTE',
          action: { kind: 'execute_tools', tokenUsage },
        };

      case 'max_output_tokens':
        // M1 stub：直接回 CALL_LLM（slot 优化算法 M1 迭代 3 交付）
        return {
          stopReason,
          nextState: 'CALL_LLM',
          action: { kind: 'escalate_max_output', tokenUsage, reason: 'slot_optimize' },
        };

      case 'ptl':
        // 委托 M7（M1 迭代 3 交付完整 PTL 三步降级，此处仅转 PTL_DEGRADE 状态）
        return {
          stopReason,
          nextState: 'PTL_DEGRADE',
          action: { kind: 'ptl_degrade', tokenUsage },
        };

      case 'user_interrupt':
        return {
          stopReason,
          nextState: 'END_TURN',
          action: { kind: 'user_interrupt', reason: params.abortReason ?? 'user requested interrupt' },
        };

      case 'stall_passive_30s': {
        const degraderAction = ctx.degrader.handleStallPassive(ctx.degraderCtx);
        if (degraderAction.kind === 'fail') {
          return {
            stopReason,
            nextState: 'END_TURN',
            action: { kind: 'fail', reason: degraderAction.message },
          };
        }
        return {
          stopReason,
          nextState: 'CALL_LLM',
          action: { kind: 'retry_stall_passive', tokenUsage },
        };
      }

      case 'stall_active_90s': {
        const degraderAction = ctx.degrader.handleStallActive(ctx.degraderCtx);
        if (degraderAction.kind === 'fail') {
          return {
            stopReason,
            nextState: 'END_TURN',
            action: { kind: 'fail', reason: degraderAction.message },
          };
        }
        return {
          stopReason,
          nextState: 'CALL_LLM',
          action: { kind: 'switch_to_non_streaming', tokenUsage },
        };
      }

      case 'provider_5xx': {
        const degraderAction = ctx.degrader.handle5xx(ctx.degraderCtx);
        if (degraderAction.kind === 'fail') {
          return {
            stopReason,
            nextState: 'END_TURN',
            action: { kind: 'fail', reason: degraderAction.message },
          };
        }
        return {
          stopReason,
          nextState: 'CALL_LLM',
          action: { kind: 'degrade_5xx', degraderAction },
        };
      }

      case 'provider_429': {
        const degraderAction = ctx.degrader.handle429(ctx.degraderCtx, {
          attempt: params.current429Attempt ?? 0,
          retryAfterMs: params.retryAfterMs,
        });
        if (degraderAction.kind === 'fail') {
          return {
            stopReason,
            nextState: 'END_TURN',
            action: { kind: 'fail', reason: degraderAction.message },
          };
        }
        return {
          stopReason,
          nextState: 'CALL_LLM',
          action: { kind: 'retry_429', degraderAction },
        };
      }

      case 'tool_execution_error':
        // tool_result 标 is_error 后回注 LLM，让 LLM 决策（如重试 / 切工具 / 报错给用户）
        return {
          stopReason,
          nextState: 'CALL_LLM',
          action: { kind: 'tool_execution_error', tokenUsage },
        };

      case 'budget_exceeded':
        // 软提醒：END_TURN + 让用户确认是否继续
        return {
          stopReason,
          nextState: 'END_TURN',
          action: { kind: 'budget_exceeded', remaining: params.budgetRemaining ?? 0 },
        };

      // exhaustiveness check（TS 编译时保证 11 种全覆盖）
      default: {
        // 编译期 exhaustiveness 已保证，运行时兜底（防 provider 返回未知 stop_reason）
        const _exhaustive: never = stopReason;
        return {
          stopReason: 'end_turn',
          nextState: 'END_TURN',
          action: { kind: 'fail', reason: `unknown stop_reason: ${_exhaustive as string}` },
        };
      }
    }
  }
}
