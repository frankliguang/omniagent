/**
 * BaseProvider 抽象基类（L3-M1 §2.2.1 + §3.3）
 *
 * 公共逻辑：重试、超时、circuit breaker、tracing 埋点。
 * 具体 provider（OpenAI/Bedrock/Ollama 等）继承此类并实现 *Impl 抽象方法。
 */

import type {
  AuthResult,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  CostEstimate,
  Credentials,
  LLMProvider,
  Message,
  TokenCount,
  TokenUsage,
} from '../types/index.js';
import type { OmniAgentErrorCode, OmniAgentError } from '../types/index.js';

import { CircuitBreaker, type BreakerConfig, type RetryConfig } from './circuit-breaker.js';
import { metrics, sleep, tracer } from '../utils/observability.js';

export abstract class BaseProvider implements LLMProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly capabilities: import('../types/index.js').Capabilities;

  protected abstract readonly retryConfig: RetryConfig;
  protected abstract readonly breakerConfig: BreakerConfig;

  private readonly breakers = new Map<string, CircuitBreaker>();

  protected abstract authenticateImpl(credentials: Credentials): Promise<AuthResult>;
  protected abstract chatStreamImpl(req: ChatRequest): AsyncIterable<ChatChunk>;
  protected abstract chatImpl(req: ChatRequest): Promise<ChatResponse>;
  protected abstract countTokensImpl(messages: Message[]): Promise<TokenCount>;

  async authenticate(credentials: Credentials): Promise<AuthResult> {
    return this.withCircuitBreaker('authenticate', () => this.authenticateImpl(credentials));
  }

  async *chatStream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const span = tracer.startSpan(`provider.${this.id}.chatStream`, {
      tags: { model: req.model, message_count: req.messages.length },
    });

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      const breaker = this.getBreaker('chatStream');
      if (breaker.isOpen()) {
        if (!breaker.attemptHalfOpen()) {
          const err: OmniAgentError = {
            code: 'PROVIDER_5XX',
            message: 'circuit breaker open for chatStream',
            module: 'M1',
            retryable: false,
          };
          span.finish({ tags: { attempt, success: false, error: err.code } });
          throw err;
        }
      }

      try {
        // 流式调用：重试只在创建流时进行，流消费过程中的错误不重试（已部分输出）
        const stream = this.chatStreamImpl(req);
        let yielded = false;
        for await (const chunk of stream) {
          yielded = true;
          yield chunk;
        }
        breaker.recordSuccess();
        span.finish({ tags: { attempt, success: true, yielded } });
        return;
      } catch (err) {
        breaker.recordFailure();
        lastError = err;
        const code = (err as { code?: OmniAgentErrorCode }).code;
        if (
          !code ||
          !this.retryConfig.retryableErrors.includes(code) ||
          attempt === this.retryConfig.maxRetries
        ) {
          span.finish({ tags: { attempt, success: false, error: code } });
          throw err;
        }
        const delay = Math.min(
          this.retryConfig.baseDelayMs * 2 ** attempt,
          this.retryConfig.maxDelayMs,
        );
        metrics.increment('provider.retry', {
          provider: this.id,
          attempt,
          error: code,
        });
        await sleep(delay);
      }
    }
    span.finish({ tags: { success: false } });
    throw lastError;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const span = tracer.startSpan(`provider.${this.id}.chat`, {
      tags: { model: req.model, message_count: req.messages.length },
    });

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const result = await this.withCircuitBreaker('chat', () => this.chatImpl(req));
        span.finish({ tags: { attempt, success: true } });
        return result;
      } catch (err) {
        lastError = err;
        const code = (err as { code?: OmniAgentErrorCode }).code;
        if (
          !code ||
          !this.retryConfig.retryableErrors.includes(code) ||
          attempt === this.retryConfig.maxRetries
        ) {
          span.finish({ tags: { attempt, success: false, error: code } });
          throw err;
        }
        const delay = Math.min(
          this.retryConfig.baseDelayMs * 2 ** attempt,
          this.retryConfig.maxDelayMs,
        );
        metrics.increment('provider.retry', {
          provider: this.id,
          attempt,
          error: code,
        });
        await sleep(delay);
      }
    }
    span.finish({ tags: { success: false } });
    throw lastError;
  }

  async countTokens(messages: Message[]): Promise<TokenCount> {
    return this.withCircuitBreaker('countTokens', () => this.countTokensImpl(messages));
  }

  estimateCost(usage: TokenUsage): CostEstimate {
    return estimateCostStatic(this.id, usage);
  }

  protected getBreaker(operation: string): CircuitBreaker {
    let breaker = this.breakers.get(operation);
    if (!breaker) {
      breaker = new CircuitBreaker(this.breakerConfig);
      this.breakers.set(operation, breaker);
    }
    return breaker;
  }

  protected async withCircuitBreaker<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const breaker = this.getBreaker(operation);
    if (breaker.isOpen()) {
      if (!breaker.attemptHalfOpen()) {
        const err: OmniAgentError = {
          code: 'PROVIDER_5XX',
          message: `circuit breaker open for ${operation}`,
          module: 'M1',
          retryable: false,
        };
        throw err;
      }
    }
    try {
      const result = await fn();
      breaker.recordSuccess();
      return result;
    } catch (err) {
      breaker.recordFailure();
      throw err;
    }
  }
}

/**
 * M1 stub：CostEstimator 静态方法。
 * M1 迭代 2 实现完整价格表（L3-M1 §2.2.5 + §3.6）。
 */
const PRICE_TABLE: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'openai/gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'openai/gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'openai/gpt-4-turbo': { inputPerMillion: 10, outputPerMillion: 30 },
};

export function registerPrice(
  providerId: string,
  price: { inputPerMillion: number; outputPerMillion: number },
): void {
  PRICE_TABLE[providerId] = price;
}

export function estimateCostStatic(
  providerId: string,
  usage: TokenUsage,
): CostEstimate {
  const price = PRICE_TABLE[providerId];
  if (!price) {
    return { usd: 0 };
  }
  const inputCost = (usage.inputTokens / 1_000_000) * price.inputPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * price.outputPerMillion;
  return {
    usd: inputCost + outputCost,
    basis: price,
  };
}
