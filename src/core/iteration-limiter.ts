/**
 * IterationLimiter（L3-M2 §3.11 — 重试预算）
 *
 * 每个有重试的终止分支（5xx/429/stall_passive/stall_active）都有强制上限。
 * 不无限重试：超限后报错（END_TURN + 用户提示），不臆造结果。
 *
 * 重试预算按"轮"算（非按 token），避免长会话累积失控。
 *
 * M1 迭代 2 stub：仅记账 + 超限检测，不与 ModelDegrader 深度耦合。
 */

export type RetryReason =
  | '5xx'
  | '429'
  | 'stall_passive'
  | 'stall_active'
  | 'ptl'
  | 'max_output_tokens';

export interface IterationLimiterConfig {
  /** 5xx 降级最多 1 次（同 provider 内切 fallbackModel） */
  max5xx: number;
  /** 429 退避最多 3 次（1s/2s/4s 指数退避，上限 8s） */
  max429: number;
  /** stall_passive 30s 无 chunk 最多重发 1 次（同 model） */
  maxStallPassive: number;
  /** stall_active 90s 流未结束最多切非流式 1 次 */
  maxStallActive: number;
  /** PTL 降级最多 3 次（circuit breaker 阈值） */
  maxPtl: number;
  /** max_output_tokens 两阶段升级最多 1 次 */
  maxMaxOutputTokens: number;
}

export const DEFAULT_ITERATION_LIMITS: IterationLimiterConfig = {
  max5xx: 1,
  max429: 3,
  maxStallPassive: 1,
  maxStallActive: 1,
  maxPtl: 3,
  maxMaxOutputTokens: 1,
};

export interface RetrySnapshot {
  reason: RetryReason;
  consumed: number;
  limit: number;
  remaining: number;
  exceeded: boolean;
}

export class IterationLimiter {
  private readonly config: IterationLimiterConfig;
  private readonly consumed: Map<RetryReason, number> = new Map();

  constructor(config?: Partial<IterationLimiterConfig>) {
    this.config = { ...DEFAULT_ITERATION_LIMITS, ...config };
  }

  /** 记账一次重试，返回是否仍可重试 */
  consumeRetry(reason: RetryReason): boolean {
    const current = this.consumed.get(reason) ?? 0;
    const next = current + 1;
    this.consumed.set(reason, next);
    return next <= this.getLimit(reason);
  }

  /** 检查是否已超限（不记账） */
  canRetry(reason: RetryReason): boolean {
    const current = this.consumed.get(reason) ?? 0;
    return current < this.getLimit(reason);
  }

  /** 报告某 reason 已达上限（仅记审计，不抛异常） */
  reportFailure(reason: RetryReason): RetrySnapshot {
    const consumed = this.consumed.get(reason) ?? this.getLimit(reason);
    const limit = this.getLimit(reason);
    return {
      reason,
      consumed,
      limit,
      remaining: Math.max(0, limit - consumed),
      exceeded: consumed >= limit,
    };
  }

  /** 获取某 reason 的当前快照 */
  snapshot(reason: RetryReason): RetrySnapshot {
    const consumed = this.consumed.get(reason) ?? 0;
    const limit = this.getLimit(reason);
    return {
      reason,
      consumed,
      limit,
      remaining: Math.max(0, limit - consumed),
      exceeded: consumed >= limit,
    };
  }

  /** 全量快照（审计用） */
  snapshotAll(): RetrySnapshot[] {
    const reasons: RetryReason[] = ['5xx', '429', 'stall_passive', 'stall_active', 'ptl', 'max_output_tokens'];
    return reasons.map(r => this.snapshot(r));
  }

  /** 重置（新 turn 开始时） */
  reset(): void {
    this.consumed.clear();
  }

  private getLimit(reason: RetryReason): number {
    switch (reason) {
      case '5xx': return this.config.max5xx;
      case '429': return this.config.max429;
      case 'stall_passive': return this.config.maxStallPassive;
      case 'stall_active': return this.config.maxStallActive;
      case 'ptl': return this.config.maxPtl;
      case 'max_output_tokens': return this.config.maxMaxOutputTokens;
    }
  }
}
