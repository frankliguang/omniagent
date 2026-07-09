/**
 * AnthropicProvider（L3-M1 §2.2.2 + §3.2.3）
 *
 * 直接调用 Anthropic Messages API（/v1/messages），不走 OpenAI 兼容层。
 *
 * 职责：
 *  1. 认证：GET /v1/models 验证 API key 有效性
 *  2. chatStream：POST stream=true，SSEParser → StreamAdapter → ChatChunk
 *  3. chat：POST 非流式，直接映射响应
 *  4. countTokens：4 字符/token 估算（M1 stub；M3 替换为 /v1/messages/count_tokens 精确计数）
 *
 * Anthropic 与 OpenAI 的差异：
 *  - system prompt 是 top-level 字段（不是 messages 数组首条）
 *  - tool_use 在 content block 数组中（stop_reason: "tool_use"）
 *  - tool_result 是 user role 的 content block（type: "tool_result"）
 *  - stream 事件类型多（message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop）
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
import type { Capabilities, StopReason } from '../types/index.js';

import { BaseProvider, registerPrice } from './base.js';
import { DEFAULT_RETRY_CONFIG, DEFAULT_BREAKER_CONFIG } from './circuit-breaker.js';
import type { BreakerConfig, RetryConfig } from './circuit-breaker.js';
import { SSEParser } from './sse-parser.js';
import { StreamAdapter } from './stream-adapter.js';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const REQUEST_TIMEOUT_MS = 120_000;

const ANTHROPIC_CAPABILITIES: Capabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsPromptCaching: true,
  supportsMultiModal: true,
  supportsRiskClassification: true,
  maxContextWindow: 200_000,
  maxOutputTokens: 8_192,
  tokenCountAccuracy: 'exact',
};

// M1 价格表（每百万 token，USD）
registerPrice('anthropic', { inputPerMillion: 3, outputPerMillion: 15 });
registerPrice('anthropic/claude-sonnet-4-5', { inputPerMillion: 3, outputPerMillion: 15 });
registerPrice('anthropic/claude-haiku-4-5', { inputPerMillion: 0.8, outputPerMillion: 4 });
registerPrice('anthropic/claude-opus-4-7', { inputPerMillion: 15, outputPerMillion: 75 });

type FetchImpl = typeof fetch;

export class AnthropicProvider extends BaseProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly capabilities = ANTHROPIC_CAPABILITIES;

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
    this.baseUrl = opts?.baseUrl ?? ANTHROPIC_BASE_URL;
    this.apiKey = opts?.apiKey;
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retryConfig = opts?.retryConfig ?? DEFAULT_RETRY_CONFIG;
    this.breakerConfig = opts?.breakerConfig ?? DEFAULT_BREAKER_CONFIG;
  }

  // ------------------------------------------------------------
  // 认证
  // ------------------------------------------------------------

  protected async authenticateImpl(credentials: Credentials): Promise<AuthResult> {
    if (credentials.type !== 'api_key') {
      return {
        success: false,
        providerId: credentials.providerId,
        error: 'PROVIDER_AUTH_FAILED',
        errorMessage: 'Anthropic provider requires api_key credentials',
      };
    }
    this.apiKey = credentials.apiKey;
    // 验证 key 有效性：GET /v1/models（Anthropic 2024+ 支持此端点）
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.status === 401) {
        return {
          success: false,
          providerId: credentials.providerId,
          error: 'PROVIDER_AUTH_FAILED',
          errorMessage: 'Anthropic API key invalid (401)',
        };
      }
      if (resp.status === 429) {
        return { success: true, providerId: credentials.providerId };
      }
      if (!resp.ok) {
        return {
          success: false,
          providerId: credentials.providerId,
          error: 'PROVIDER_5XX',
          errorMessage: `Anthropic auth check failed: HTTP ${resp.status}`,
        };
      }
      return { success: true, providerId: credentials.providerId };
    } catch (err) {
      return {
        success: false,
        providerId: credentials.providerId,
        error: 'PROVIDER_TIMEOUT',
        errorMessage: `Anthropic auth check network error: ${(err as Error).message}`,
      };
    }
  }

  // ------------------------------------------------------------
  // chatStream
  // ------------------------------------------------------------

  protected async *chatStreamImpl(req: ChatRequest): AsyncIterable<ChatChunk> {
    const apiKey = this.requireApiKey();
    const body = this.buildRequestBody(req, true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (req.abortSignal) {
      req.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { ...this.buildHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw this.mapHttpError(resp.status, await resp.text().catch(() => ''));
      }
      if (!resp.body) {
        throw this.makeError('PROVIDER_5XX', 'Anthropic stream response has no body');
      }

      const parser = new SSEParser();
      const adapter = new StreamAdapter();

      const sseEvents = this.readSSEEvents(resp.body, parser);
      yield* adapter.normalize('anthropic', sseEvents);
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
      const resp = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { ...this.buildHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw this.mapHttpError(resp.status, await resp.text().catch(() => ''));
      }
      const data = (await resp.json()) as AnthropicMessagesResponse;
      return this.mapChatResponse(data, req.model);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------------
  // countTokens
  // ------------------------------------------------------------

  protected async countTokensImpl(messages: Message[]): Promise<TokenCount> {
    // M1 stub：Anthropic /v1/messages/count_tokens 端点未集成
    // 4 字符/token 估算
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
      throw this.makeError('PROVIDER_AUTH_FAILED', 'Anthropic provider not authenticated — call authenticate() first');
    }
    return this.apiKey;
  }

  private buildHeaders(apiKey?: string): Record<string, string> {
    return {
      'x-api-key': apiKey ?? this.apiKey ?? '',
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  private async *readSSEEvents(
    body: ReadableStream<Uint8Array>,
    parser: SSEParser,
  ): AsyncIterable<{ event?: string; data: string; id?: string; retry?: number }> {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
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

  /** OmniAgent ChatRequest → Anthropic /v1/messages 请求体 */
  private buildRequestBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model ?? DEFAULT_MODEL,
      messages: req.messages.map(m => this.mapMessage(m)),
      stream,
    };

    // system prompt 是 top-level 字段
    if (req.systemPromptBlocks?.length) {
      body.system = req.systemPromptBlocks.join('\n\n');
    }

    if (req.maxOutputTokens !== undefined) {
      body.max_tokens = req.maxOutputTokens;
    } else {
      body.max_tokens = ANTHROPIC_CAPABILITIES.maxOutputTokens;
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    if (req.tools?.length) {
      body.tools = req.tools.map(t => this.mapTool(t));
    }
    if (stream) {
      // 让 Anthropic 在最后返回 usage
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  /** OmniAgent Message → Anthropic message */
  private mapMessage(m: Message): unknown {
    // tool role → user role with tool_result content block
    if (m.role === 'tool') {
      const toolResults = m.content
        .filter(b => b.type === 'tool_result')
        .map(b => ({
          type: 'tool_result' as const,
          tool_use_id: (b as { tool_use_id: string }).tool_use_id,
          content: this.contentBlocksToText((b as { content: ContentBlock[] }).content),
          is_error: (b as { is_error: boolean }).is_error,
        }));
      return { role: 'user', content: toolResults };
    }

    // assistant / user / system
    const content: unknown[] = [];
    for (const block of m.content) {
      switch (block.type) {
        case 'text':
          content.push({ type: 'text', text: block.text });
          break;
        case 'tool_use':
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
          break;
        case 'tool_result':
          // user role 内的 tool_result
          content.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: this.contentBlocksToText(block.content),
            is_error: block.is_error,
          });
          break;
        case 'image':
          // Anthropic vision: base64 source
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.source.media_type,
              data: block.source.data,
            },
          });
          break;
        case 'json':
          content.push({ type: 'text', text: JSON.stringify(block.json) });
          break;
      }
    }
    return { role: m.role, content };
  }

  /** OmniAgent Tool → Anthropic tool spec */
  private mapTool(t: Tool): unknown {
    return {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    };
  }

  /** Anthropic 非流式响应 → OmniAgent ChatResponse */
  private mapChatResponse(data: AnthropicMessagesResponse, model: string): ChatResponse {
    if (!data.content?.length) {
      throw this.makeError('PROVIDER_5XX', 'Anthropic response has no content');
    }

    const content: ContentBlock[] = [];
    for (const block of data.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        const toolUseBlock: ToolUseBlock = {
          type: 'tool_use',
          id: block.id as ToolUseBlock['id'],
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        };
        content.push(toolUseBlock);
      }
    }

    const message: Message = {
      role: 'assistant',
      content,
      metadata: {
        model,
        provider: this.id,
        stop_reason: this.mapStopReason(data.stop_reason),
        tokenUsage: data.usage
          ? {
              inputTokens: data.usage.input_tokens ?? 0,
              outputTokens: data.usage.output_tokens ?? 0,
              cacheReadTokens: data.usage.cache_read_input_tokens,
              cacheCreationTokens: data.usage.cache_creation_input_tokens,
            }
          : { inputTokens: 0, outputTokens: 0 },
      },
    };

    return {
      message,
      stopReason: this.mapStopReason(data.stop_reason),
      tokenUsage: message.metadata!.tokenUsage!,
      providerMetadata: {
        id: data.id,
        model: data.model,
      },
    };
  }

  private mapStopReason(reason: string | undefined | null): StopReason {
    switch (reason) {
      case 'end_turn': return 'end_turn';
      case 'tool_use': return 'tool_use';
      case 'max_tokens': return 'max_output_tokens';
      case 'stop_sequence': return 'end_turn';
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
      message: `Anthropic HTTP ${status}: ${body.slice(0, 500)}`,
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
// Anthropic 响应类型（内部用）
// ============================================================

interface AnthropicMessagesResponse {
  id: string;
  model: string;
  role: 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input?: unknown }
  >;
  stop_reason?: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}
