/**
 * OllamaProvider（L3-M1 §2.2.2 + §3.2.4）
 *
 * 调用本地 Ollama HTTP API（/api/chat）。
 *
 * 与 OpenAI/Anthropic 的差异：
 *  - 无认证：本地服务，"authenticate" 只 ping /api/tags 确认服务在跑
 *  - 流式响应是 NDJSON（每行一个 JSON 对象），不是 SSE
 *  - 工具调用：message.tool_calls 数组（与 OpenAI 类似但字段更简单）
 *  - token 计数：在最终响应中返回 prompt_eval_count / eval_count
 *  - thinking 字段：M3 接入（reasoning model 支持）
 *
 * 职责：
 *  1. 认证：GET /api/tags 确认 Ollama 服务可达
 *  2. chatStream：POST stream=true，NDJSON 流解析 → ChatChunk
 *  3. chat：POST stream=false，直接映射响应
 *  4. countTokens：4 字符/token 估算（Ollama 无独立 count 端点）
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
  ToolInput,
  ToolUseBlock,
  ToolUseId,
} from '../types/index.js';
import type { Capabilities } from '../types/index.js';

import { BaseProvider, registerPrice } from './base.js';
import { DEFAULT_RETRY_CONFIG, DEFAULT_BREAKER_CONFIG } from './circuit-breaker.js';
import type { BreakerConfig, RetryConfig } from './circuit-breaker.js';

const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3';
const REQUEST_TIMEOUT_MS = 300_000;  // 本地推理可能慢，给 5 分钟

const OLLAMA_CAPABILITIES: Capabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsPromptCaching: false,  // Ollama 本地推理无 prompt cache
  supportsMultiModal: true,  // llava 等多模态模型支持
  supportsRiskClassification: false,
  maxContextWindow: 128_000,  // llama3 默认；具体模型可覆盖
  maxOutputTokens: 4_096,
  tokenCountAccuracy: 'estimated',
};

// 本地推理无成本（用户自付电费），但保留接口
registerPrice('ollama', { inputPerMillion: 0, outputPerMillion: 0 });

type FetchImpl = typeof fetch;

export class OllamaProvider extends BaseProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama';
  readonly capabilities = OLLAMA_CAPABILITIES;

  protected readonly retryConfig: RetryConfig;
  protected readonly breakerConfig: BreakerConfig;

  private baseUrl: string;
  private authenticated = false;
  private readonly fetchImpl: FetchImpl;

  constructor(opts?: {
    baseUrl?: string;
    fetchImpl?: FetchImpl;
    retryConfig?: RetryConfig;
    breakerConfig?: BreakerConfig;
  }) {
    super();
    this.baseUrl = opts?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL;
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retryConfig = opts?.retryConfig ?? DEFAULT_RETRY_CONFIG;
    this.breakerConfig = opts?.breakerConfig ?? DEFAULT_BREAKER_CONFIG;
  }

  // ------------------------------------------------------------
  // 认证（无 API key，只 ping /api/tags 确认服务在跑）
  // ------------------------------------------------------------

  protected async authenticateImpl(credentials: Credentials): Promise<AuthResult> {
    // Ollama 无认证；任何 credentials 都接受（包括 undefined / oauth）
    // 但 ping /api/tags 确认服务可达
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) {
        return {
          success: false,
          providerId: credentials.providerId,
          error: 'PROVIDER_5XX',
          errorMessage: `Ollama service unhealthy: HTTP ${resp.status}`,
        };
      }
      this.authenticated = true;
      return { success: true, providerId: credentials.providerId };
    } catch (err) {
      return {
        success: false,
        providerId: credentials.providerId,
        error: 'PROVIDER_TIMEOUT',
        errorMessage: `Ollama service unreachable: ${(err as Error).message}`,
      };
    }
  }

  // ------------------------------------------------------------
  // chatStream — NDJSON 流
  // ------------------------------------------------------------

  protected async *chatStreamImpl(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.requireAuthed();
    const body = this.buildRequestBody(req, true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (req.abortSignal) {
      req.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw this.mapHttpError(resp.status, await resp.text().catch(() => ''));
      }
      if (!resp.body) {
        throw this.makeError('PROVIDER_5XX', 'Ollama stream response has no body');
      }

      // NDJSON 流：每行一个 JSON 对象
      yield* this.parseNDJSONStream(resp.body, req.model);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------------
  // chat（非流式）
  // ------------------------------------------------------------

  protected async chatImpl(req: ChatRequest): Promise<ChatResponse> {
    this.requireAuthed();
    const body = this.buildRequestBody(req, false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (req.abortSignal) {
      req.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw this.mapHttpError(resp.status, await resp.text().catch(() => ''));
      }
      const data = (await resp.json()) as OllamaChatResponse;
      return this.mapChatResponse(data, req.model);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------------
  // countTokens
  // ------------------------------------------------------------

  protected async countTokensImpl(messages: Message[]): Promise<TokenCount> {
    // Ollama 无独立 count 端点；4 字符/token 估算
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

  private requireAuthed(): void {
    if (!this.authenticated) {
      throw this.makeError('PROVIDER_AUTH_FAILED', 'Ollama provider not authenticated — call authenticate() first');
    }
  }

  /** OmniAgent ChatRequest → Ollama /api/chat 请求体 */
  private buildRequestBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages: unknown[] = [];

    // Ollama 支持 system role 作为 messages 首条
    if (req.systemPromptBlocks?.length) {
      messages.push({
        role: 'system',
        content: req.systemPromptBlocks.join('\n\n'),
      });
    }

    for (const m of req.messages) {
      messages.push(this.mapMessage(m));
    }

    const body: Record<string, unknown> = {
      model: req.model ?? DEFAULT_MODEL,
      messages,
      stream,
    };

    if (req.tools?.length) {
      body.tools = req.tools.map(t => this.mapTool(t));
    }
    if (req.temperature !== undefined) {
      body.options = { temperature: req.temperature };
    }
    return body;
  }

  /** OmniAgent Message → Ollama message */
  private mapMessage(m: Message): unknown {
    // tool role → tool role with content
    if (m.role === 'tool') {
      const text = m.content
        .filter(b => b.type === 'tool_result')
        .map(b => this.contentBlocksToText((b as { content: ContentBlock[] }).content))
        .join('\n');
      return { role: 'tool', content: text };
    }

    // assistant: text + tool_calls
    if (m.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            function: {
              name: block.name,
              arguments: block.input,
            },
          });
        }
      }
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: textParts.join('\n'),
      };
      if (toolCalls.length) {
        msg.tool_calls = toolCalls;
      }
      return msg;
    }

    // user: text + image (multi-modal)
    if (m.role === 'user') {
      const textParts: string[] = [];
      const images: string[] = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'image' && block.source.type === 'base64') {
          images.push(block.source.data);
        } else if (block.type === 'tool_result') {
          // tool_result 在 user role 内（与 Anthropic 类似）
          textParts.push(this.contentBlocksToText(block.content));
        }
      }
      const msg: Record<string, unknown> = {
        role: 'user',
        content: textParts.join('\n'),
      };
      if (images.length) {
        msg.images = images;
      }
      return msg;
    }

    // system
    return {
      role: m.role,
      content: m.content
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('\n'),
    };
  }

  /** OmniAgent Tool → Ollama tool spec（OpenAI 兼容格式） */
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

  /** 解析 NDJSON 流并产生 ChatChunk */
  private async *parseNDJSONStream(
    body: ReadableStream<Uint8Array>,
    model: string,
  ): AsyncIterable<ChatChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let messageStarted = false;
    /** 累积 tool_calls 的 arguments JSON 分片（Ollama 在每个 chunk 都返回完整 arguments 对象） */
    const emittedToolUse = new Set<string>();
    /** 整个流是否出现过 tool_calls（用于推断 stop_reason） */
    let sawToolCalls = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // flush 剩余 buffer
          if (buffer.trim()) {
            const chunks = this.parseNDJSONLine(buffer, model, messageStarted, emittedToolUse);
            if (chunks) {
              for (const c of chunks) {
                if (c.type === 'message_start') messageStarted = true;
                if (c.type === 'tool_use_start') sawToolCalls = true;
                if (c.type === 'message_end') {
                  c.stopReason = this.inferStopReasonFromStream(c.stopReason, sawToolCalls);
                }
                yield c;
              }
            }
          }
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // NDJSON：以 \n 分隔
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const chunks = this.parseNDJSONLine(line, model, messageStarted, emittedToolUse);
          if (chunks) {
            for (const c of chunks) {
              if (c.type === 'message_start') messageStarted = true;
              if (c.type === 'tool_use_start') sawToolCalls = true;
              // 重写 message_end 的 stopReason（基于全流是否含 tool_use）
              if (c.type === 'message_end') {
                c.stopReason = this.inferStopReasonFromStream(c.stopReason, sawToolCalls);
              }
              yield c;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** 流式 stop_reason 推断：若出现过 tool_use 则 tool_use */
  private inferStopReasonFromStream(originalReason: StopReason, sawToolCalls: boolean): StopReason {
    if (sawToolCalls) return 'tool_use';
    return originalReason;
  }

  /** 解析单行 NDJSON → ChatChunk[]（可能多个：message_start + text_delta） */
  private parseNDJSONLine(
    line: string,
    model: string,
    messageStarted = false,
    emittedToolUse?: Set<string>,
  ): ChatChunk[] | undefined {
    let data: OllamaChatResponse;
    try {
      data = JSON.parse(line) as OllamaChatResponse;
    } catch {
      // 损坏行跳过
      return undefined;
    }

    const chunks: ChatChunk[] = [];
    const content = data.message?.content ?? '';
    const toolCalls = data.message?.tool_calls ?? [];

    // 首个非空 chunk：发 message_start
    if (!messageStarted && (content || toolCalls.length || data.done)) {
      const message: Message = {
        role: 'assistant',
        content: [],
        metadata: { model, provider: this.id },
      };
      chunks.push({ type: 'message_start', message });
    }

    // text_delta
    if (content) {
      chunks.push({ type: 'text_delta', text: content });
    }

    // tool_use（Ollama 每个 chunk 都可能含 tool_calls 的部分字段）
    for (const tc of toolCalls) {
      const id = `toolu_${tc.function.name}_${Math.random().toString(36).slice(2, 8)}` as ToolUseId;
      if (emittedToolUse && emittedToolUse.has(id)) continue;
      if (emittedToolUse) emittedToolUse.add(id);
      chunks.push({
        type: 'tool_use_start',
        id,
        name: tc.function.name,
      });
      chunks.push({
        type: 'tool_use_delta',
        id,
        input: (tc.function.arguments ?? {}) as ToolInput,
      });
      chunks.push({
        type: 'tool_use_end',
        id,
      });
    }

    // done=true → message_end
    if (data.done) {
      const stopReason = this.inferStopReason(data, toolCalls.length > 0);
      const usage: TokenUsage = {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      };
      chunks.push({
        type: 'message_end',
        stopReason,
        tokenUsage: usage,
      });
    }

    return chunks;
  }

  /** Ollama 非流式响应 → OmniAgent ChatResponse */
  private mapChatResponse(data: OllamaChatResponse, model: string): ChatResponse {
    const content: ContentBlock[] = [];
    if (data.message?.content) {
      content.push({ type: 'text', text: data.message.content });
    }
    if (data.message?.tool_calls?.length) {
      for (const tc of data.message.tool_calls) {
        const id = `toolu_${tc.function.name}_${Math.random().toString(36).slice(2, 8)}` as ToolUseId;
        const block: ToolUseBlock = {
          type: 'tool_use',
          id,
          name: tc.function.name,
          input: (tc.function.arguments ?? {}) as Record<string, unknown>,
        };
        content.push(block);
      }
    }

    const stopReason = this.inferStopReason(data, (data.message?.tool_calls?.length ?? 0) > 0);
    const usage: TokenUsage = {
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
    };

    const message: Message = {
      role: 'assistant',
      content,
      metadata: {
        model,
        provider: this.id,
        stop_reason: stopReason,
        tokenUsage: usage,
      },
    };

    return {
      message,
      stopReason,
      tokenUsage: usage,
      providerMetadata: {
        model: data.model,
        total_duration: data.total_duration,
        load_duration: data.load_duration,
        prompt_eval_duration: data.prompt_eval_duration,
        eval_duration: data.eval_duration,
      },
    };
  }

  private inferStopReason(data: OllamaChatResponse, hasToolCalls: boolean): StopReason {
    if (hasToolCalls) return 'tool_use';
    if (data.done_reason === 'length' || data.done_reason === 'max_output_tokens') {
      return 'max_output_tokens';
    }
    return 'end_turn';
  }

  private mapHttpError(status: number, body: string): OmniAgentError {
    let code: OmniAgentErrorCode;
    if (status === 401) code = 'PROVIDER_AUTH_FAILED';
    else if (status === 429) code = 'PROVIDER_429';
    else if (status >= 500) code = 'PROVIDER_5XX';
    else code = 'PROVIDER_5XX';

    return {
      code,
      message: `Ollama HTTP ${status}: ${body.slice(0, 500)}`,
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
// Ollama 响应类型（内部用）
// ============================================================

interface OllamaChatResponse {
  model: string;
  created_at?: string;
  message?: {
    role: string;
    content?: string;
    tool_calls?: Array<{
      function: { name: string; arguments?: Record<string, unknown> };
    }>;
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}
