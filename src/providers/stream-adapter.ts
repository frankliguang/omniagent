/**
 * StreamAdapter（L3-M1 §2.2.4 + §3.2.2）
 *
 * 把 provider 原始 SSE 事件 → 统一 ChatChunk 流。
 * 职责：
 *  1. 字段映射（OpenAI/Anthropic/Bedrock 事件结构差异 → 统一 ChatChunk 8 种类型）
 *  2. 流分片合并（OpenAI tool_call 的 arguments JSON 跨多个 delta 分片到达，需累积后解析）
 *  3. stop_reason 归一（provider 自有终止原因 → OmniAgent StopReason 11 种枚举）
 *
 * M1 迭代 1：仅实现 OpenAI 归一化。
 * M1 迭代 2：补 Anthropic + Bedrock（L3-M1 §3.2.2 后半）。
 */

import type {
  ChatChunk,
  Message,
  StopReason,
  TokenUsage,
  ToolInput,
  ToolUseId,
} from '../types/index.js';

import type { SSEEvent } from './sse-parser.js';

/**
 * ToolUse 分片累积器。
 * OpenAI 的 tool_call arguments 是 JSON 字符串分片（如 `{"city":"` + `SF"` + `}`），
 * 需先拼成完整字符串再 JSON.parse。
 */
class ToolUseBuilder {
  private argumentsBuffer = '';

  constructor(
    public readonly id: string,
    public readonly name: string,
  ) {}

  appendArguments(fragment: string | undefined): void {
    if (fragment) {
      this.argumentsBuffer += fragment;
    }
  }

  /** 解析累积的 arguments JSON 字符串为 ToolInput 对象 */
  getArguments(): ToolInput {
    if (!this.argumentsBuffer) {
      return {};
    }
    try {
      return JSON.parse(this.argumentsBuffer) as ToolInput;
    } catch {
      // JSON 不完整或格式错：返回原始字符串作为 _raw 字段，避免整条流转废
      return { _raw: this.argumentsBuffer, _parseError: true };
    }
  }
}

export class StreamAdapter {
  /** index → ToolUseBuilder（OpenAI 用 tool_calls[].index 关联分片，不是 id） */
  private readonly pendingToolUse = new Map<number, ToolUseBuilder>();
  /** 是否已发出 message_start（OpenAI 第一个 chunk 带 role 字段时发出） */
  private messageStarted = false;

  /**
   * 把 provider 原始 SSE 事件流归一为统一 ChatChunk 流。
   *
   * 注意：本方法是 stateful 的（pendingToolUse / messageStarted），
   * 一个实例只能用于一次 message 的归一，复用前需 reset()。
   *
   * events 既可以是 sync Iterable 也可以是 AsyncIterable（for await...of 同时支持）。
   */
  async *normalize(
    providerId: string,
    events: Iterable<SSEEvent> | AsyncIterable<SSEEvent>,
  ): AsyncIterable<ChatChunk> {
    this.reset();
    if (providerId === 'openai') {
      yield* this.normalizeOpenAI(events);
    } else if (providerId === 'anthropic') {
      yield* this.normalizeAnthropic(events);
    } else {
      yield {
        type: 'error',
        error: {
          code: 'PROVIDER_5XX',
          message: `StreamAdapter: provider ${providerId} not supported in M1 iteration 2`,
          module: 'M1',
          retryable: false,
        },
      };
    }
  }

  reset(): void {
    this.pendingToolUse.clear();
    this.messageStarted = false;
  }

  // ------------------------------------------------------------
  // OpenAI 归一化（L3-M1 §3.2.2 OpenAI 分支）
  // ------------------------------------------------------------

  private async *normalizeOpenAI(
    events: Iterable<SSEEvent> | AsyncIterable<SSEEvent>,
  ): AsyncIterable<ChatChunk> {
    let lastUsage: TokenUsage | undefined;

    for await (const event of events) {
      // OpenAI 以 data: [DONE] 作为流结束标记
      if (event.data === '[DONE]') {
        // 若未收到 finish_reason（异常截断），补一个 message_end
        if (this.messageStarted) {
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            tokenUsage: lastUsage ?? { inputTokens: 0, outputTokens: 0 },
          };
        }
        return;
      }

      let data: OpenAIStreamChunk;
      try {
        data = JSON.parse(event.data) as OpenAIStreamChunk;
      } catch (err) {
        yield {
          type: 'error',
          error: {
            code: 'PROVIDER_5XX',
            message: `StreamAdapter: failed to parse OpenAI chunk JSON: ${(err as Error).message}`,
            module: 'M1',
            retryable: false,
            cause: err,
          },
        };
        return;
      }

      const choice = data.choices?.[0];
      if (!choice) {
        // usage-only chunk（OpenAI stream_options.include_usage=true 时最后一个 chunk 只有 usage）
        if (data.usage) {
          lastUsage = this.mapOpenAIUsage(data.usage);
        }
        continue;
      }

      const delta = choice.delta;

      // 首个带 role 的 delta：发出 message_start
      if (!this.messageStarted && delta?.role === 'assistant') {
        const message: Message = {
          role: 'assistant',
          content: [],
        };
        this.messageStarted = true;
        yield { type: 'message_start', message };
      }

      // text 内容分片
      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content };
      }

      // tool_call 分片累积
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          let builder = this.pendingToolUse.get(index);
          if (!builder) {
            // 首次出现的 tool_call：带 id + function.name，发出 tool_use_start
            const id = tc.id ?? `call_${index}`;
            const name = tc.function?.name ?? '';
            builder = new ToolUseBuilder(id, name);
            this.pendingToolUse.set(index, builder);
            yield { type: 'tool_use_start', id: id as ToolUseId, name };
          }
          // arguments 是 JSON 字符串分片，累积到 builder
          if (tc.function?.arguments) {
            builder.appendArguments(tc.function.arguments);
          }
        }
      }

      // usage（若 chunk 带 usage，暂存到 lastUsage，最终合并到 message_end）
      if (data.usage) {
        lastUsage = this.mapOpenAIUsage(data.usage);
      }

      // finish_reason：归一所有 pending tool_use，然后发 message_end
      if (choice.finish_reason) {
        // 发出每个 pending tool 的 delta（完整 input）+ end
        for (const builder of this.pendingToolUse.values()) {
          yield {
            type: 'tool_use_delta',
            id: builder.id as ToolUseId,
            input: builder.getArguments(),
          };
          yield { type: 'tool_use_end', id: builder.id as ToolUseId };
        }
        this.pendingToolUse.clear();

        const stopReason = this.mapOpenAIFinishReason(choice.finish_reason);
        yield {
          type: 'message_end',
          stopReason,
          tokenUsage: lastUsage ?? { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
    }

    // 流耗尽但未收到 finish_reason 也没有 [DONE]：补一个 end_turn（防御性）
    if (this.messageStarted) {
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        tokenUsage: lastUsage ?? { inputTokens: 0, outputTokens: 0 },
      };
    }
  }

  // ------------------------------------------------------------
  // Anthropic 归一化（L3-M1 §3.2.3 Anthropic 分支）
  // ------------------------------------------------------------

  private async *normalizeAnthropic(
    events: Iterable<SSEEvent> | AsyncIterable<SSEEvent>,
  ): AsyncIterable<ChatChunk> {
    let lastUsage: TokenUsage | { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined;
    /** Anthropic 用 content_block.index 关联分片，不是 id */
    const blockBuilders = new Map<number, ToolUseBuilder>();
    /** 当前 content_block 的 input JSON 累积（Anthropic tool_use 的 input 是 partial JSON） */
    const inputBuffers = new Map<number, string>();
    let finalStopReason: StopReason | undefined;

    for await (const event of events) {
      if (event.data === '[DONE]') {
        return;
      }
      let data: AnthropicStreamEvent;
      try {
        data = JSON.parse(event.data) as AnthropicStreamEvent;
      } catch (err) {
        yield {
          type: 'error',
          error: {
            code: 'PROVIDER_5XX',
            message: `StreamAdapter: failed to parse Anthropic chunk JSON: ${(err as Error).message}`,
            module: 'M1',
            retryable: false,
            cause: err,
          },
        };
        return;
      }

      switch (data.type) {
        case 'message_start': {
          // 第一个事件：发 message_start
          const usage = data.message?.usage;
          lastUsage = {
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: usage?.cache_read_input_tokens,
            cacheCreationTokens: usage?.cache_creation_input_tokens,
          };
          const message: Message = {
            role: 'assistant',
            content: [],
          };
          this.messageStarted = true;
          yield { type: 'message_start', message };
          break;
        }
        case 'content_block_start': {
          const block = data.content_block;
          const idx = data.index ?? 0;
          if (block?.type === 'tool_use') {
            const id = block.id ?? `toolu_${idx}`;
            const name = block.name ?? '';
            blockBuilders.set(idx, new ToolUseBuilder(id, name));
            inputBuffers.set(idx, '');
            yield { type: 'tool_use_start', id: id as ToolUseId, name };
          }
          // text block 不需要发 start 事件，text_delta 直接发
          break;
        }
        case 'content_block_delta': {
          const delta = data.delta;
          const idx = data.index ?? 0;
          if (delta?.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text ?? '' };
          } else if (delta?.type === 'input_json_delta') {
            // tool_use input 分片累积
            const buf = inputBuffers.get(idx);
            const fragment = delta.partial_json ?? '';
            inputBuffers.set(idx, (buf ?? '') + fragment);
          }
          break;
        }
        case 'content_block_stop': {
          // 若是 tool_use block：发 tool_use_delta（完整 input）+ tool_use_end
          const idx = data.index ?? 0;
          const builder = blockBuilders.get(idx);
          if (builder) {
            const buf = inputBuffers.get(idx) ?? '';
            // 设置累积的 arguments
            builder.appendArguments(buf);
            yield {
              type: 'tool_use_delta',
              id: builder.id as ToolUseId,
              input: builder.getArguments(),
            };
            yield { type: 'tool_use_end', id: builder.id as ToolUseId };
            blockBuilders.delete(idx);
            inputBuffers.delete(idx);
          }
          break;
        }
        case 'message_delta': {
          // 更新 stop_reason + usage
          if (data.delta?.stop_reason) {
            finalStopReason = this.mapAnthropicStopReason(data.delta.stop_reason);
          }
          if (data.usage?.output_tokens !== undefined) {
            lastUsage = {
              ...(lastUsage ?? { inputTokens: 0, outputTokens: 0 }),
              outputTokens: data.usage.output_tokens,
            };
          }
          break;
        }
        case 'message_stop': {
          yield {
            type: 'message_end',
            stopReason: finalStopReason ?? 'end_turn',
            tokenUsage: lastUsage ?? { inputTokens: 0, outputTokens: 0 },
          };
          return;
        }
        case 'error': {
          yield {
            type: 'error',
            error: {
              code: 'PROVIDER_5XX',
              message: `Anthropic stream error: ${data.error?.message ?? 'unknown'}`,
              module: 'M1',
              retryable: false,
              cause: data.error,
            },
          };
          return;
        }
        default:
          // ping 等事件忽略
          break;
      }
    }

    // 流耗尽但未收到 message_stop：补一个 end_turn（防御性）
    if (this.messageStarted) {
      yield {
        type: 'message_end',
        stopReason: finalStopReason ?? 'end_turn',
        tokenUsage: lastUsage ?? { inputTokens: 0, outputTokens: 0 },
      };
    }
  }

  // ------------------------------------------------------------
  // 映射函数
  // ------------------------------------------------------------

  private mapAnthropicStopReason(reason: string): StopReason {
    switch (reason) {
      case 'end_turn': return 'end_turn';
      case 'tool_use': return 'tool_use';
      case 'max_tokens': return 'max_output_tokens';
      case 'stop_sequence': return 'end_turn';
      default: return 'end_turn';
    }
  }

  private mapOpenAIFinishReason(reason: string): StopReason {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_output_tokens';
      case 'content_filter':
        // OpenAI content_filter：被安全过滤截断，无完美映射，归到 end_turn
        return 'end_turn';
      case 'function_call':
        // legacy function_call（已废弃，统一映射为 tool_use）
        return 'tool_use';
      default:
        return 'end_turn';
    }
  }

  private mapOpenAIUsage(usage: OpenAIUsage): TokenUsage {
    return {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
    };
  }
}

// ============================================================
// OpenAI 流式响应类型（仅 StreamAdapter 内部用，不导出）
// ============================================================

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIDelta {
  role?: string;
  content?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

// ============================================================
// Anthropic 流式响应类型（仅 StreamAdapter 内部用）
// ============================================================

interface AnthropicStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'error'
    | 'ping';
  index?: number;
  message?: {
    id?: string;
    role?: 'assistant';
    content?: unknown[];
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: {
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type?: 'text_delta' | 'input_json_delta' | 'message_delta';
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: {
    output_tokens?: number;
  };
  error?: {
    type?: string;
    message?: string;
  };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: OpenAIDelta;
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}
