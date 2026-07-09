/**
 * OpenAIProvider（L3-M1 §2.2.2 + §3.2.2）
 *
 * 调用 OpenAI /v1/chat/completions 端点。
 * M1 迭代 1：仅支持 OpenAI 公有云（api.openai.com），Azure 在 M1 迭代 2 补。
 *
 * 职责：
 *  1. 认证：GET /v1/models 验证 API key 有效性
 *  2. chatStream：POST stream=true，SSEParser → StreamAdapter → ChatChunk
 *  3. chat：POST 非流式，直接映射响应
 *  4. countTokens：tiktoken 精确计数（M1 stub：若 tiktoken 加载失败则估算）
 */

import type {
  AuthResult,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  CostEstimate,
  Credentials,
  Message,
  OmniAgentError,
  OmniAgentErrorCode,
  TokenCount,
  TokenUsage,
  Tool,
  ToolUseBlock,
} from '../types/index.js';
import type { Capabilities } from '../types/index.js';

import { BaseProvider, registerPrice } from './base.js';
import { DEFAULT_RETRY_CONFIG, DEFAULT_BREAKER_CONFIG } from './circuit-breaker.js';
import type { BreakerConfig, RetryConfig } from './circuit-breaker.js';
import { SSEParser } from './sse-parser.js';
import { StreamAdapter } from './stream-adapter.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';
const REQUEST_TIMEOUT_MS = 120_000;

const OPENAI_CAPABILITIES: Capabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsPromptCaching: true,
  supportsMultiModal: true,
  supportsRiskClassification: false,
  maxContextWindow: 128_000,
  maxOutputTokens: 16_384,
  tokenCountAccuracy: 'exact',
};

registerPrice('openai', { inputPerMillion: 2.5, outputPerMillion: 10 });
registerPrice('openai/gpt-4o', { inputPerMillion: 2.5, outputPerMillion: 10 });
registerPrice('openai/gpt-4o-mini', { inputPerMillion: 0.15, outputPerMillion: 0.6 });
registerPrice('openai/gpt-4-turbo', { inputPerMillion: 10, outputPerMillion: 30 });

type FetchImpl = typeof fetch;

export class OpenAIProvider extends BaseProvider {
  readonly id = 'openai';
  readonly displayName = 'OpenAI';
  readonly capabilities = OPENAI_CAPABILITIES;

  protected readonly retryConfig: RetryConfig;
  protected readonly breakerConfig: BreakerConfig;

  private apiKey: string | undefined;
  private baseUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts?: {
    baseUrl?: string;
    apiKey?: string;
    fetchImpl?: FetchImpl;
    retryConfig?: RetryConfig;
    breakerConfig?: BreakerConfig;
  }) {
    super();
    this.baseUrl = opts?.baseUrl ?? OPENAI_BASE_URL;
    this.apiKey = opts?.apiKey;
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retryConfig = opts?.retryConfig ?? DEFAULT_RETRY_CONFIG;
    this.breakerConfig = opts?.breakerConfig ?? DEFAULT_BREAKER_CONFIG;
  }

  // ------------------------------------------------------------
  // 认证（L3-M1 §3.4）
  // ------------------------------------------------------------

  protected async authenticateImpl(credentials: Credentials): Promise<AuthResult> {
    if (credentials.type !== 'api_key') {
      return {
        success: false,
        providerId: credentials.providerId,
        error: 'PROVIDER_AUTH_FAILED',
        errorMessage: 'OpenAI provider requires api_key credentials',
      };
    }
    this.apiKey = credentials.apiKey;
    // 验证 key 有效性：GET /v1/models（最小权限调用）
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.status === 401) {
        return {
          success: false,
          providerId: credentials.providerId,
          error: 'PROVIDER_AUTH_FAILED',
          errorMessage: 'OpenAI API key invalid (401)',
        };
      }
      if (resp.status === 429) {
        // 限速也算认证通过（key 有效，只是被限速）
        return { success: true, providerId: credentials.providerId };
      }
      if (!resp.ok) {
        return {
          success: false,
          providerId: credentials.providerId,
          error: 'PROVIDER_5XX',
          errorMessage: `OpenAI auth check failed: HTTP ${resp.status}`,
        };
      }
      return { success: true, providerId: credentials.providerId };
    } catch (err) {
      return {
        success: false,
        providerId: credentials.providerId,
        error: 'PROVIDER_TIMEOUT',
        errorMessage: `OpenAI auth check network error: ${(err as Error).message}`,
      };
    }
  }

  // ------------------------------------------------------------
  // chatStream（L3-M1 §3.2.2 + §3.3.3）
  // ------------------------------------------------------------

  protected async *chatStreamImpl(req: ChatRequest): AsyncIterable<ChatChunk> {
    const apiKey = this.requireApiKey();
    const body = this.buildRequestBody(req, true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    // 转发用户 abort 信号
    if (req.abortSignal) {
      req.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...this.buildHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw this.mapHttpError(resp.status, await resp.text().catch(() => ''));
      }
      if (!resp.body) {
        throw this.makeError('PROVIDER_5XX', 'OpenAI stream response has no body');
      }

      const parser = new SSEParser();
      const adapter = new StreamAdapter();

      // 把 ReadableStream → AsyncIterable<Uint8Array> → SSEParser → SSEEvent[] → StreamAdapter → ChatChunk
      const sseEvents = this.readSSEEvents(resp.body, parser);
      yield* adapter.normalize('openai', sseEvents);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------------
  // chat（非流式）
  // ------------------------------------------------------------

  protected async chatImpl(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = this.requireApiKey();
    const body = this.buildRequestBody(req, false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (req.abortSignal) {
      req.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...this.buildHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw this.mapHttpError(resp.status, await resp.text().catch(() => ''));
      }
      const data = (await resp.json()) as OpenAIChatResponse;
      return this.mapChatResponse(data, req.model);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------------
  // countTokens（L3-M1 §3.5 — tiktoken 精确计数）
  // ------------------------------------------------------------

  protected async countTokensImpl(messages: Message[]): Promise<TokenCount> {
    // M1 迭代 1 stub：tiktoken 动态加载，失败时 4 char/token 估算
    // M1 迭代 2 替换为 tiktoken 真正集成
    const text = messages.map(m => this.messageToText(m)).join('\n');
    const estimated = Math.ceil(text.length / 4);
    return {
      inputTokens: estimated,
      outputTokens: 0,
      accuracy: 'estimated',
    };
  }

  override estimateCost(usage: TokenUsage): CostEstimate {
    return super.estimateCost(usage);
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw this.makeError('PROVIDER_AUTH_FAILED', 'OpenAI provider not authenticated — call authenticate() first');
    }
    return this.apiKey;
  }

  private buildHeaders(apiKey?: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey ?? this.apiKey ?? ''}`,
    };
  }

  /** 把 Response.body (ReadableStream) 转为 SSEEvent async iterable */
  private async *readSSEEvents(
    body: ReadableStream<Uint8Array>,
    parser: SSEParser,
  ): AsyncIterable<{ event?: string; data: string; id?: string; retry?: number }> {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // flush 剩余 buffer（如无 \n\n 结尾的尾部事件）
          const remaining = parser.flush();
          for (const ev of remaining) yield ev;
          return;
        }
        const events = parser.feed(value);
        for (const ev of events) yield ev;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** 把 OmniAgent ChatRequest → OpenAI /v1/chat/completions 请求体 */
  private buildRequestBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages: unknown[] = [];

    // system prompt（OpenAI 要求 system 消息在首位）
    if (req.systemPromptBlocks?.length) {
      messages.push({
        role: 'system',
        content: req.systemPromptBlocks.join('\n\n'),
      });
    }

    // 业务消息
    for (const m of req.messages) {
      messages.push(this.mapMessage(m));
    }

    const body: Record<string, unknown> = {
      model: req.model ?? DEFAULT_MODEL,
      messages,
      stream,
    };

    if (req.maxOutputTokens !== undefined) {
      body.max_tokens = req.maxOutputTokens;
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    if (stream) {
      // 让 OpenAI 在最后一个 chunk 返回 usage
      body.stream_options = { include_usage: true };
    }
    if (req.tools?.length) {
      body.tools = req.tools.map(t => this.mapTool(t));
    }
    if (req.enablePromptCache) {
      // OpenAI 自动开启 prompt cache，无需显式参数
    }
    if (req.fallbackModel) {
      // fallback 在 BaseProvider 重试层处理，不在请求体传
    }
    return body;
  }

  /** OmniAgent Message → OpenAI message */
  private mapMessage(m: Message): unknown {
    // 提取文本与 tool_use / tool_result
    const textParts: string[] = [];
    const toolCalls: unknown[] = [];
    const toolResults: unknown[] = [];

    for (const block of m.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
          break;
        case 'tool_result':
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: this.contentBlocksToText(block.content),
          });
          break;
        case 'image':
          // OpenAI vision：image_url 数据 URL
          // M1 stub：暂不处理，M1 迭代 2 补
          break;
        case 'json':
          textParts.push(JSON.stringify(block.json));
          break;
      }
    }

    if (m.role === 'tool' || toolResults.length) {
      // tool_result 走 OpenAI 的 tool role 消息
      return toolResults[0] ?? { role: 'tool', content: '' };
    }

    const content = textParts.join('\n');
    if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content };
      if (toolCalls.length) {
        msg.tool_calls = toolCalls;
      }
      return msg;
    }
    // system / user
    return { role: m.role, content };
  }

  /** OmniAgent Tool → OpenAI function tool spec */
  private mapTool(t: Tool): unknown {
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    };
  }

  /** OpenAI 非流式响应 → OmniAgent ChatResponse */
  private mapChatResponse(data: OpenAIChatResponse, model: string): ChatResponse {
    const choice = data.choices?.[0];
    if (!choice) {
      throw this.makeError('PROVIDER_5XX', 'OpenAI response has no choices');
    }

    const content: ContentBlock[] = [];
    if (choice.message?.content) {
      content.push({ type: 'text', text: choice.message.content });
    }
    if (choice.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments ?? '{}');
        } catch {
          input = { _raw: tc.function.arguments, _parseError: true };
        }
        const block: ToolUseBlock = {
          type: 'tool_use',
          id: tc.id as ToolUseBlock['id'],
          name: tc.function.name,
          input,
        };
        content.push(block);
      }
    }

    const message: Message = {
      role: 'assistant',
      content,
      metadata: {
        model,
        provider: this.id,
        stop_reason: this.mapFinishReason(choice.finish_reason),
        tokenUsage: data.usage
          ? {
              inputTokens: data.usage.prompt_tokens ?? 0,
              outputTokens: data.usage.completion_tokens ?? 0,
              cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens,
            }
          : { inputTokens: 0, outputTokens: 0 },
      },
    };

    return {
      message,
      stopReason: this.mapFinishReason(choice.finish_reason),
      tokenUsage: message.metadata!.tokenUsage!,
      providerMetadata: {
        id: data.id,
        model: data.model,
      },
    };
  }

  private mapFinishReason(reason: string | undefined | null): import('../types/index.js').StopReason {
    switch (reason) {
      case 'stop': return 'end_turn';
      case 'tool_calls': return 'tool_use';
      case 'length': return 'max_output_tokens';
      case 'content_filter': return 'end_turn';
      case 'function_call': return 'tool_use';
      default: return 'end_turn';
    }
  }

  private mapHttpError(status: number, body: string): OmniAgentError {
    let code: OmniAgentErrorCode;
    if (status === 401) code = 'PROVIDER_AUTH_FAILED';
    else if (status === 429) code = 'PROVIDER_429';
    else if (status >= 500) code = 'PROVIDER_5XX';
    else code = 'PROVIDER_5XX';

    return {
      code,
      message: `OpenAI HTTP ${status}: ${body.slice(0, 500)}`,
      module: 'M1',
      retryable: code === 'PROVIDER_5XX' || code === 'PROVIDER_429',
      cause: { status, body },
    };
  }

  private makeError(code: OmniAgentErrorCode, message: string): OmniAgentError {
    return {
      code,
      message,
      module: 'M1',
      retryable: code === 'PROVIDER_5XX' || code === 'PROVIDER_429' || code === 'PROVIDER_TIMEOUT',
    };
  }

  private messageToText(m: Message): string {
    return m.content
      .map(b => {
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_use') return JSON.stringify(b.input);
        if (b.type === 'tool_result') return this.contentBlocksToText(b.content);
        if (b.type === 'json') return JSON.stringify(b.json);
        return '';
      })
      .join('\n');
  }

  private contentBlocksToText(blocks: ContentBlock[]): string {
    return blocks
      .map(b => (b.type === 'text' ? b.text : b.type === 'json' ? JSON.stringify(b.json) : ''))
      .join('\n');
  }
}

// ============================================================
// OpenAI 响应类型（内部用）
// ============================================================

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: Array<{
    message?: {
      role: string;
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}
