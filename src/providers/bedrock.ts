/**
 * BedrockProvider（L3-M1 §2.2.2 + §3.2.2）
 *
 * 调用 AWS Bedrock Runtime API（InvokeModel / InvokeModelWithResponseStream）。
 *
 * 端点：
 *  - 非流式：POST /model/{modelId}/invoke
 *  - 流式：POST /model/{modelId}/invoke-with-response-stream
 *
 * 与 Anthropic 的差异：
 *  - 认证：AWS SigV4（非 Bearer token）
 *  - 流式协议：AWS EventStream 二进制（非 SSE）
 *  - 模型 ID 格式：anthropic.claude-3-5-sonnet-20241022-v1:0 / anthropic.claude-3-haiku-20240307-v1:0
 *  - 请求 body：模型相关，Claude 模型用 Anthropic 的 messages 格式（包在 body 里）
 *
 * 职责：
 *  1. 认证：验证 SigV4 凭证可用（不调远端，本地校验）
 *  2. chatStream：InvokeModelWithResponseStream → EventStream 解析 → ChatChunk
 *  3. chat：InvokeModel → JSON 响应映射
 *  4. countTokens：4 字符/token 估算（Bedrock 无独立 count 端点）
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
  StopReason,
  TokenCount,
  TokenUsage,
  Tool,
  ToolUseBlock,
  ToolUseId,
} from '../types/index.js';
import type { Capabilities } from '../types/index.js';

import { BaseProvider, registerPrice } from './base.js';
import { DEFAULT_RETRY_CONFIG, DEFAULT_BREAKER_CONFIG } from './circuit-breaker.js';
import type { BreakerConfig, RetryConfig } from './circuit-breaker.js';
import { BedrockEventStreamParser } from './bedrock-event-stream.js';
import { signSigV4, type SigV4Credentials, type SigV4SignResult } from './bedrock-sigv4.js';

const BEDROCK_DEFAULT_REGION = 'us-east-1';
const BEDROCK_DEFAULT_MODEL = 'anthropic.claude-3-5-sonnet-20241022-v1:0';
const REQUEST_TIMEOUT_MS = 300_000;

const BEDROCK_CAPABILITIES: Capabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsPromptCaching: true,  // Bedrock Claude 支持 prompt cache（与 Anthropic 同）
  supportsMultiModal: true,
  supportsRiskClassification: false,
  maxContextWindow: 200_000,
  maxOutputTokens: 8_192,
  tokenCountAccuracy: 'estimated',
};

// Bedrock 价格 stub（base PRICE_TABLE 用，仅 input/output；完整含 cache 价格在 cost-estimator.ts BUILTIN_PRICES）
registerPrice('bedrock', { inputPerMillion: 0.25, outputPerMillion: 1.25 });
registerPrice('bedrock/anthropic.claude-3-5-sonnet', { inputPerMillion: 3, outputPerMillion: 15 });
registerPrice('bedrock/anthropic.claude-3-haiku', { inputPerMillion: 0.25, outputPerMillion: 1.25 });
registerPrice('bedrock/anthropic.claude-3-opus', { inputPerMillion: 15, outputPerMillion: 75 });

type FetchImpl = typeof fetch;

/** SigV4 签名函数类型（可注入，便于测试） */
type SigV4Signer = (
  creds: SigV4Credentials,
  region: string,
  req: import('./bedrock-sigv4.js').SigV4Request,
  date?: Date,
) => SigV4SignResult;

export class BedrockProvider extends BaseProvider {
  readonly id = 'bedrock';
  readonly displayName = 'AWS Bedrock';
  readonly capabilities = BEDROCK_CAPABILITIES;

  protected readonly retryConfig: RetryConfig;
  protected readonly breakerConfig: BreakerConfig;

  private region: string;
  private creds: SigV4Credentials | undefined;
  private readonly fetchImpl: FetchImpl;
  private readonly signer: SigV4Signer;

  constructor(opts?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    fetchImpl?: FetchImpl;
    signer?: SigV4Signer;
    retryConfig?: RetryConfig;
    breakerConfig?: BreakerConfig;
  }) {
    super();
    this.region = opts?.region ?? BEDROCK_DEFAULT_REGION;
    if (opts?.accessKeyId && opts?.secretAccessKey) {
      this.creds = {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
      };
    }
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.signer = opts?.signer ?? signSigV4;
    this.retryConfig = opts?.retryConfig ?? DEFAULT_RETRY_CONFIG;
    this.breakerConfig = opts?.breakerConfig ?? DEFAULT_BREAKER_CONFIG;
  }

  // ------------------------------------------------------------
  // 认证
  // ------------------------------------------------------------

  protected async authenticateImpl(credentials: Credentials): Promise<AuthResult> {
    // Bedrock 用 SigV4，credentials.apiKey 实际是 "accessKeyId:secretAccessKey[:sessionToken]"
    // 但更推荐用环境变量 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
    if (credentials.type !== 'api_key') {
      return {
        success: false,
        providerId: credentials.providerId,
        error: 'PROVIDER_AUTH_FAILED',
        errorMessage: 'Bedrock provider requires api_key credentials (accessKeyId:secretAccessKey[:sessionToken])',
      };
    }

    const parts = credentials.apiKey.split(':');
    if (parts.length < 2) {
      return {
        success: false,
        providerId: credentials.providerId,
        error: 'PROVIDER_AUTH_FAILED',
        errorMessage: 'Bedrock api_key format: accessKeyId:secretAccessKey[:sessionToken]',
      };
    }
    const [accessKeyId, secretAccessKey, ...sessionParts] = parts;
    const sessionToken = sessionParts.length > 0 ? sessionParts.join(':') : undefined;

    if (!accessKeyId || !secretAccessKey) {
      return {
        success: false,
        providerId: credentials.providerId,
        error: 'PROVIDER_AUTH_FAILED',
        errorMessage: 'Bedrock credentials missing accessKeyId or secretAccessKey',
      };
    }

    this.creds = { accessKeyId, secretAccessKey, sessionToken };

    // 不调远端（Bedrock 无 GET 验证端点，发个最小请求代价大）
    // 本地校验凭证格式 + 签名能算出即可
    try {
      const testReq: import('./bedrock-sigv4.js').SigV4Request = {
        method: 'POST',
        path: '/model/test/invoke',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        host: this.host(),
      };
      this.signer(this.creds, this.region, testReq);
      return { success: true, providerId: credentials.providerId };
    } catch (err) {
      return {
        success: false,
        providerId: credentials.providerId,
        error: 'PROVIDER_AUTH_FAILED',
        errorMessage: `Bedrock SigV4 signing failed: ${(err as Error).message}`,
      };
    }
  }

  // ------------------------------------------------------------
  // chatStream（InvokeModelWithResponseStream）
  // ------------------------------------------------------------

  protected async *chatStreamImpl(req: ChatRequest): AsyncIterable<ChatChunk> {
    const creds = this.requireCreds();
    const modelId = req.model ?? BEDROCK_DEFAULT_MODEL;
    const body = this.buildRequestBody(req);
    const bodyStr = JSON.stringify(body);

    const path = `/model/${encodeURIComponent(modelId)}/invoke-with-response-stream`;
    const url = `https://${this.host()}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (req.abortSignal) {
      req.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const signResult = this.signer(creds, this.region, {
        method: 'POST',
        path,
        headers: {
          'content-type': 'application/json',
          'accept': 'application/vnd.amazon.eventstream',
        },
        body: bodyStr,
        host: this.host(),
      });

      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...signResult.signedHeaders,
          authorization: signResult.authorization,
        },
        body: bodyStr,
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw this.mapHttpError(resp.status, await resp.text().catch(() => ''));
      }
      if (!resp.body) {
        throw this.makeError('PROVIDER_5XX', 'Bedrock stream response has no body');
      }

      yield* this.parseEventStream(resp.body, modelId);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------------
  // chat（InvokeModel，非流式）
  // ------------------------------------------------------------

  protected async chatImpl(req: ChatRequest): Promise<ChatResponse> {
    const creds = this.requireCreds();
    const modelId = req.model ?? BEDROCK_DEFAULT_MODEL;
    const body = this.buildRequestBody(req);
    const bodyStr = JSON.stringify(body);

    const path = `/model/${encodeURIComponent(modelId)}/invoke`;
    const url = `https://${this.host()}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (req.abortSignal) {
      req.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const signResult = this.signer(creds, this.region, {
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json' },
        body: bodyStr,
        host: this.host(),
      });

      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...signResult.signedHeaders,
          authorization: signResult.authorization,
        },
        body: bodyStr,
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw this.mapHttpError(resp.status, await resp.text().catch(() => ''));
      }
      const data = (await resp.json()) as BedrockInvokeResponse;
      return this.mapChatResponse(data, modelId);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------------
  // countTokens
  // ------------------------------------------------------------

  protected async countTokensImpl(messages: Message[]): Promise<TokenCount> {
    const text = messages.map(m => this.messageToText(m)).join('\n');
    const estimated = Math.ceil(text.length / 4);
    return { inputTokens: estimated, outputTokens: 0, accuracy: 'estimated' };
  }

  override estimateCost(usage: TokenUsage): CostEstimate {
    return super.estimateCost(usage);
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  private requireCreds(): SigV4Credentials {
    if (!this.creds) {
      throw this.makeError('PROVIDER_AUTH_FAILED', 'Bedrock provider not authenticated — call authenticate() first');
    }
    return this.creds;
  }

  private host(): string {
    return `bedrock-runtime.${this.region}.amazonaws.com`;
  }

  /** 构造 Bedrock 请求 body（Claude 模型用 Anthropic 的 messages 格式） */
  private buildRequestBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      messages: req.messages.map(m => this.mapMessage(m)),
      max_tokens: req.maxOutputTokens ?? BEDROCK_CAPABILITIES.maxOutputTokens,
    };

    if (req.systemPromptBlocks?.length) {
      body.system = req.systemPromptBlocks.join('\n\n');
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    if (req.tools?.length) {
      body.tools = req.tools.map(t => this.mapTool(t));
    }
    return body;
  }

  /** OmniAgent Message → Bedrock message（同 Anthropic 格式） */
  private mapMessage(m: Message): unknown {
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

    const content: unknown[] = [];
    for (const block of m.content) {
      switch (block.type) {
        case 'text':
          content.push({ type: 'text', text: block.text });
          break;
        case 'tool_use':
          content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
          break;
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: this.contentBlocksToText(block.content),
            is_error: block.is_error,
          });
          break;
        case 'image':
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

  private mapTool(t: Tool): unknown {
    return { name: t.name, description: t.description, input_schema: t.inputSchema };
  }

  /** 解析 EventStream 二进制流 → ChatChunk */
  private async *parseEventStream(
    body: ReadableStream<Uint8Array>,
    model: string,
  ): AsyncIterable<ChatChunk> {
    const reader = body.getReader();
    const parser = new BedrockEventStreamParser();
    let messageStarted = false;
    /** tool_use 累积（Bedrock Claude chunk 与 Anthropic SSE 同结构，payload.bytes 是 base64 编码的 JSON） */
    const toolUseBuilders = new Map<number, { id: string; name: string; argsBuffer: string }>();
    /** message_delta 携带的 stop_reason + usage，到 message_stop 时发出 */
    let pendingStopReason: StopReason | undefined;
    let pendingUsage: TokenUsage | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          for (const ev of parser.flush()) {
            for (const c of this.eventToChunks(ev, model, {
              messageStarted,
              toolUseBuilders,
              get stopReason() { return pendingStopReason; },
              set stopReason(v: StopReason | undefined) { pendingStopReason = v; },
              get usage() { return pendingUsage; },
              set usage(v: TokenUsage | undefined) { pendingUsage = v; },
            })) {
              if (c.type === 'message_start') messageStarted = true;
              yield c;
            }
          }
          return;
        }
        for (const ev of parser.feed(value)) {
          for (const c of this.eventToChunks(ev, model, {
            messageStarted,
            toolUseBuilders,
            get stopReason() { return pendingStopReason; },
            set stopReason(v: StopReason | undefined) { pendingStopReason = v; },
            get usage() { return pendingUsage; },
            set usage(v: TokenUsage | undefined) { pendingUsage = v; },
          })) {
            if (c.type === 'message_start') messageStarted = true;
            yield c;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Bedrock EventStream event → ChatChunk[] */
  private eventToChunks(
    ev: import('./bedrock-event-stream.js').BedrockEvent,
    model: string,
    state: {
      messageStarted: boolean;
      toolUseBuilders: Map<number, { id: string; name: string; argsBuffer: string }>;
      stopReason: StopReason | undefined;
      usage: TokenUsage | undefined;
    },
  ): ChatChunk[] {
    const chunks: ChatChunk[] = [];
    const { toolUseBuilders } = state;
    // Bedrock Claude payload 在 ev.payload.bytes（base64 编码的 JSON）
    const payload = ev.payload as { bytes?: string; [k: string]: unknown } | undefined;
    if (!payload?.bytes) {
      // metadata 事件等无 bytes 字段，忽略
      return chunks;
    }

    let decoded: AnthropicStreamChunk;
    try {
      decoded = JSON.parse(Buffer.from(payload.bytes, 'base64').toString('utf8')) as AnthropicStreamChunk;
    } catch {
      return chunks;
    }

    // 复用 Anthropic 事件处理逻辑
    if (decoded.type === 'message_start') {
      const usage = decoded.message?.usage;
      const message: Message = {
        role: 'assistant',
        content: [],
        metadata: {
          model,
          provider: this.id,
          tokenUsage: {
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: usage?.cache_read_input_tokens,
            cacheCreationTokens: usage?.cache_creation_input_tokens,
          },
        },
      };
      chunks.push({ type: 'message_start', message });
    } else if (decoded.type === 'content_block_start') {
      const block = decoded.content_block;
      const idx = decoded.index ?? 0;
      if (block?.type === 'tool_use') {
        const id = block.id ?? `toolu_${idx}`;
        toolUseBuilders.set(idx, { id, name: block.name ?? '', argsBuffer: '' });
        chunks.push({ type: 'tool_use_start', id: id as ToolUseId, name: block.name ?? '' });
      }
    } else if (decoded.type === 'content_block_delta') {
      const delta = decoded.delta;
      const idx = decoded.index ?? 0;
      if (delta?.type === 'text_delta') {
        chunks.push({ type: 'text_delta', text: delta.text ?? '' });
      } else if (delta?.type === 'input_json_delta') {
        const builder = toolUseBuilders.get(idx);
        if (builder) {
          builder.argsBuffer += delta.partial_json ?? '';
        }
      }
    } else if (decoded.type === 'content_block_stop') {
      const idx = decoded.index ?? 0;
      const builder = toolUseBuilders.get(idx);
      if (builder) {
        let input: Record<string, unknown> = {};
        if (builder.argsBuffer) {
          try {
            input = JSON.parse(builder.argsBuffer);
          } catch {
            input = { _raw: builder.argsBuffer, _parseError: true };
          }
        }
        chunks.push({
          type: 'tool_use_delta',
          id: builder.id as ToolUseId,
          input,
        });
        chunks.push({ type: 'tool_use_end', id: builder.id as ToolUseId });
        toolUseBuilders.delete(idx);
      }
    } else if (decoded.type === 'message_delta') {
      // stop_reason + usage 在 message_delta 事件，message_stop 时才发 message_end
      const reason = decoded.delta?.stop_reason;
      if (reason) {
        state.stopReason = this.mapStopReason(reason);
      }
      const outTokens = decoded.usage?.output_tokens;
      if (outTokens !== undefined) {
        state.usage = { inputTokens: 0, outputTokens: outTokens };
      }
    } else if (decoded.type === 'message_stop') {
      const stopReason = state.stopReason ?? 'end_turn';
      const usage = state.usage ?? { inputTokens: 0, outputTokens: 0 };
      chunks.push({
        type: 'message_end',
        stopReason,
        tokenUsage: usage,
      });
    }

    return chunks;
  }

  /** Bedrock 非流式响应 → OmniAgent ChatResponse */
  private mapChatResponse(data: BedrockInvokeResponse, model: string): ChatResponse {
    const content: ContentBlock[] = [];
    if (data.content?.length) {
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
    }

    const stopReason = this.mapStopReason(data.stop_reason);
    const usage: TokenUsage = {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      cacheReadTokens: data.usage?.cache_read_input_tokens,
      cacheCreationTokens: data.usage?.cache_creation_input_tokens,
    };

    const message: Message = {
      role: 'assistant',
      content,
      metadata: { model, provider: this.id, stop_reason: stopReason, tokenUsage: usage },
    };

    return {
      message,
      stopReason,
      tokenUsage: usage,
      providerMetadata: {
        id: model,
        model,
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
    if (status === 401 || status === 403) code = 'PROVIDER_AUTH_FAILED';
    else if (status === 429) code = 'PROVIDER_429';
    else if (status >= 500) code = 'PROVIDER_5XX';
    else code = 'PROVIDER_5XX';

    return {
      code,
      message: `Bedrock HTTP ${status}: ${body.slice(0, 500)}`,
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
// Bedrock 响应类型（内部用）
// ============================================================

interface BedrockInvokeResponse {
  id?: string;
  type?: 'message';
  role?: 'assistant';
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input?: unknown }
  >;
  model?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Anthropic 流式 chunk 类型（Bedrock 复用 Anthropic 格式，包在 bytes 里） */
interface AnthropicStreamChunk {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'ping'
    | 'error';
  index?: number;
  message?: {
    id?: string;
    role?: 'assistant';
    content?: unknown[];
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
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
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}
