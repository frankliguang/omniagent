/**
 * ModelDegrader（L3-M2 §3.4 — 5 步降级 + 429 退避，决策 C1）
 *
 * v1.0 决策 C1：同 provider 内自动降级（fallbackModel 单值字段），跨 provider chain 延后到 v2.x。
 *
 * 5 步流程（5xx 或连续 stall 触发）：
 *   Step 1: 检测 5xx 或连续 stall
 *   Step 2: 清空当前 assistant 消息（避免 partial 输出污染下一模型）
 *   Step 3: 切换到 fallbackModel（同 provider 内，无则跳 Step 5）
 *   Step 4: 重新发送请求（回到 CALL_LLM，IterationLimiter 记账，最多 1 次）
 *   Step 5: 若仍失败，明确报错（不无限重试，END_TURN + 用户提示）
 *
 * 429 退避重试（指数退避 1s/2s/4s，上限 8s，最多 3 次）：
 *   attempt 0: 等 1s → 重发
 *   attempt 1: 等 2s → 重发
 *   attempt 2: 等 4s → 重发
 *   attempt 3: 失败，报错
 *
 * stall 切非流式降级（M1 迭代 3 交付 stub 接口，本文仅留 hook）：
 *   stall_active_90s 触发 → 标记 nonStreaming=true → 回 CALL_LLM → 调 chat() 替代 chatStream()
 */

import type { IterationLimiter, RetryReason } from './iteration-limiter.js';

export interface DegraderContext {
  /** 当前模型 ID */
  currentModel: string;
  /** 同 provider 内 fallback 模型（C1 冻结，单值） */
  fallbackModel?: string;
  /** IterationLimiter 实例（记账重试预算） */
  limiter: IterationLimiter;
}

export type DegraderAction =
  /** 5xx 降级：切 fallbackModel + 回 CALL_LLM */
  | { kind: 'degrade_5xx'; fromModel: string; toModel: string; clearPartial: true }
  /** 429 退避：等待 backoffMs 后回 CALL_LLM（同 model） */
  | { kind: 'retry_429'; backoffMs: number; attempt: number }
  /** stall_passive：同 model 重发（回到 CALL_LLM） */
  | { kind: 'retry_stall_passive'; fromModel: string }
  /** stall_active：切非流式（回到 CALL_LLM 但用 chat() 而非 chatStream()） */
  | { kind: 'switch_to_non_streaming'; fromModel: string }
  /** 降级失败：END_TURN + 用户提示（不臆造结果） */
  | { kind: 'fail'; reason: RetryReason; message: string }
  /** 不降级（如 fallbackModel 为空时直接 fail） */
  | { kind: 'noop'; reason: string };

export interface BackoffOptions {
  /** provider 返回的 retry-after 头（ms），优先于指数退避 */
  retryAfterMs?: number;
  /** 当前 attempt 序号（0-based） */
  attempt: number;
}

/** 429 退避算法（L3-M2 §3.4.2） */
export function compute429Backoff(opts: BackoffOptions): number {
  if (opts.retryAfterMs !== undefined && opts.retryAfterMs > 0) {
    // provider 给了 retry-after，优先用（上限 60s）
    return Math.min(opts.retryAfterMs, 60_000);
  }
  // 指数退避：1s / 2s / 4s / 8s，上限 8s
  return Math.min(1000 * Math.pow(2, opts.attempt), 8_000);
}

/**
 * ModelDegrader — 纯函数实现（无副作用，ReActLoop 根据返回的 action 执行）
 *
 * 状态由 ReActLoop 持有（currentModel / fallbackModel / partialAssistant 等），
 * ModelDegrader 仅决策"下一步该做什么"。
 */
export class ModelDegrader {
  /**
   * 处理 5xx 错误（5 步降级）
   *
   * @param ctx 当前上下文
   * @returns 降级动作
   */
  handle5xx(ctx: DegraderContext): DegraderAction {
    // Step 4 前置检查：IterationLimiter 是否还有 5xx 重试预算
    if (!ctx.limiter.canRetry('5xx')) {
      // Step 5：超限报错
      return {
        kind: 'fail',
        reason: '5xx',
        message: `model degradation failed: 5xx retry budget exhausted (limit ${ctx.limiter.snapshot('5xx').limit}). Please retry later or check provider status.`,
      };
    }

    // Step 3：检查 fallbackModel
    if (!ctx.fallbackModel) {
      // 用户未配置 fallbackModel，直接 Step 5
      return {
        kind: 'fail',
        reason: '5xx',
        message: 'model degradation failed: no fallbackModel configured. Set llm.fallbackModel in settings to enable auto-degradation.',
      };
    }

    if (ctx.fallbackModel === ctx.currentModel) {
      // fallbackModel 与 currentModel 相同，降级无意义
      return {
        kind: 'fail',
        reason: '5xx',
        message: 'model degradation failed: fallbackModel is identical to currentModel (no point switching).',
      };
    }

    // Step 2 + 3 + 4：清 partial + 切模型 + 重发（IterationLimiter 记账在 ReActLoop 侧）
    return {
      kind: 'degrade_5xx',
      fromModel: ctx.currentModel,
      toModel: ctx.fallbackModel,
      clearPartial: true,
    };
  }

  /**
   * 处理 429 错误（退避重试）
   *
   * @param ctx 当前上下文
   * @param opts 退避选项
   * @returns 退避动作
   */
  handle429(ctx: DegraderContext, opts: BackoffOptions): DegraderAction {
    if (!ctx.limiter.canRetry('429')) {
      return {
        kind: 'fail',
        reason: '429',
        message: `rate limit retry budget exhausted (limit ${ctx.limiter.snapshot('429').limit}). Please wait and retry later.`,
      };
    }

    const backoffMs = compute429Backoff(opts);
    return {
      kind: 'retry_429',
      backoffMs,
      attempt: opts.attempt,
    };
  }

  /**
   * 处理 stall_passive_30s（同 model 重发）
   */
  handleStallPassive(ctx: DegraderContext): DegraderAction {
    if (!ctx.limiter.canRetry('stall_passive')) {
      return {
        kind: 'fail',
        reason: 'stall_passive',
        message: `stall_passive retry budget exhausted (limit ${ctx.limiter.snapshot('stall_passive').limit}). Provider may be unresponsive.`,
      };
    }
    return {
      kind: 'retry_stall_passive',
      fromModel: ctx.currentModel,
    };
  }

  /**
   * 处理 stall_active_90s（切非流式）
   */
  handleStallActive(ctx: DegraderContext): DegraderAction {
    if (!ctx.limiter.canRetry('stall_active')) {
      return {
        kind: 'fail',
        reason: 'stall_active',
        message: `stall_active retry budget exhausted (limit ${ctx.limiter.snapshot('stall_active').limit}). Provider stream stuck > 90s.`,
      };
    }
    return {
      kind: 'switch_to_non_streaming',
      fromModel: ctx.currentModel,
    };
  }
}
