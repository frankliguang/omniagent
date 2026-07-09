/**
 * Circuit Breaker（L3-M1 §3.3.2）
 *
 * 每个 provider 独立 circuit breaker，状态机：
 * - closed：正常，记录 consecutive/total failures
 * - open：超过阈值，直接拒绝请求
 * - half-open：resetTimeoutMs 后尝试一个请求
 */

import type { OmniAgentErrorCode } from '../types/index.js';

export interface BreakerConfig {
  maxConsecutive: number;
  maxTotal: number;
  resetTimeoutMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  maxConsecutive: 3,
  maxTotal: 10,
  resetTimeoutMs: 60_000,
};

type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private lastFailureTime = 0;

  constructor(private readonly config: BreakerConfig = DEFAULT_BREAKER_CONFIG) {}

  isOpen(): boolean {
    return this.state === 'open';
  }

  attemptHalfOpen(): boolean {
    if (this.state !== 'open') {
      return false;
    }
    const elapsed = Date.now() - this.lastFailureTime;
    if (elapsed < this.config.resetTimeoutMs) {
      return false;
    }
    this.state = 'half-open';
    return true;
  }

  recordSuccess(): void {
    this.totalSuccesses++;
    this.consecutiveFailures = 0;
    if (this.state === 'half-open') {
      this.state = 'closed';
    }
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();
    if (
      this.consecutiveFailures >= this.config.maxConsecutive ||
      this.totalFailures >= this.config.maxTotal
    ) {
      this.state = 'open';
    }
  }

  getStats(): { state: BreakerState; consecutiveFailures: number; totalFailures: number; totalSuccesses: number } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
    };
  }
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors: OmniAgentErrorCode[];
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  retryableErrors: ['PROVIDER_5XX', 'PROVIDER_429', 'PROVIDER_TIMEOUT'],
};
