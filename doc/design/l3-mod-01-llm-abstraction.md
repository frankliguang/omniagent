# OmniAgent CLI — L3 模块设计：M1 模型抽象层 (LLM Abstraction)

> 文档层次：L3 模块级（PRD 是 L1 产品级，L2 是 L2 技术级，L4 是代码）
> 模块 ID: M1
> 主负责角色: 架构师
> 阻塞里程碑: M1（Walking Skeleton）
> 状态: 草稿（待评审冻结）
> 依据：PRD `omniagent-prd-mod-01-model-abstraction.md` + L2 `omniagent-system-design.md` §3/§6/§9/§11 + 类型契约 `omniagent-types.ts` §4/§5

---

## 文档定位与不重复原则

本文件是 PRD mod-01 与 L2 整体设计在 M1 模块上的**实施级细化**：

- PRD 已有的产品级描述（范围/边界/设计目标/NFR/不变量/冻结决策/评测集引用）——**不复制**，仅引用并补实施细节
- L2 已有的跨模块共享内容（类型契约/错误码枚举/测试分层/CI 矩阵/里程碑交付物）——**不复制**，仅引用并补模块内部结构
- 本文件补：**组件清单 + 类/函数级详细设计 + 调用图 + 模块内错误处理 + 测试用例骨架 + 里程碑迭代对齐**

**引用约定**：本文件引用 PRD 章节时格式为"PRD §X"（指 mod-01），引用总体 PRD 为"总体 §X"，引用 L2 为"L2 §X"，引用类型契约为"`omniagent-types.ts` §N"。

---

## 1. 模块概述

### 1.1 范围（引用 PRD §1.1，不重复）

本模块实施范围：

- `LLMProvider` 标准接口实现（接口本身已定义在 `omniagent-types.ts` §5）
- 6 个 provider 实现类（M1 三个 + M2-M4 三个）
- 流适配器（Stream Adapter）：归一化 SSE/EventStream/HTTP 为统一 `ChatChunk`
- 认证管理（API Key + OAuth 2.0，含 keychain 集成）
- Token 计数（per provider）
- 成本估算（per provider 价格表）
- Fallback chain（同 provider 内降级，决策 C1）

### 1.2 边界（引用 PRD §1.2，不重复）

- **不实现** ReAct 状态机（M2 负责）
- **不实现** 工具调用执行（M3 负责）
- **不实现** Risk Classifier 决策逻辑（M4 负责）
- **不实现** 上下文压缩策略（M7 负责），仅提供 `countTokens()` 原语

### 1.3 在整体架构中的位置（引用 L2 §1，不重复）

模型抽象层是 harness 层与 LLM 后端的**唯一桥梁**。L2 §1 部署形态中，本模块位于 LLM 层，被 harness 层（M2 ReAct Loop）调用。所有 provider 实现位于 `src/providers/` 目录（L2 §2.6 brand neutrality 检查白名单）。

---

## 2. 组件清单

### 2.1 组件总览

| # | 组件 | 类型 | 文件路径 | 职责 |
|---|------|------|---------|------|
| 1 | `LLMProvider` | interface | `omniagent-types.ts` §5 | 标准接口（已定义） |
| 2 | `Capabilities` | interface | `omniagent-types.ts` §5 | 能力声明（已定义） |
| 3 | `BaseProvider` | abstract class | `src/providers/base.ts` | 公共逻辑（认证/重试/超时） |
| 4 | `OpenAIProvider` | class | `src/providers/openai.ts` | OpenAI + Azure OpenAI |
| 5 | `AnthropicProvider` | class | `src/providers/anthropic.ts` | Anthropic 直接 API |
| 6 | `BedrockProvider` | class | `src/providers/bedrock.ts` | AWS Bedrock（含 Claude/Gemini/Llama） |
| 7 | `OllamaProvider` | class | `src/providers/ollama.ts` | 本地 Ollama |
| 8 | `DeepSeekProvider` | class | `src/providers/deepseek.ts` | DeepSeek（OpenAI 兼容协议） |
| 9 | `VertexAIProvider` | class | `src/providers/vertexai.ts` | Google Vertex AI |
| 10 | `ProviderRegistry` | class | `src/providers/registry.ts` | provider 注册与查找 |
| 11 | `CredentialsStore` | class | `src/providers/credentials.ts` | 凭证管理（keychain + env + config） |
| 12 | `SSEParser` | class | `src/providers/sse-parser.ts` | SSE/EventStream 解析 |
| 13 | `StreamAdapter` | class | `src/providers/stream-adapter.ts` | chunk 归一化与流分片合并 |
| 14 | `TokenCounter` | class | `src/providers/token-counter.ts` | per provider token 计数 |
| 15 | `CostEstimator` | class | `src/providers/cost-estimator.ts` | 成本估算 |
| 16 | `FallbackChain` | class | `src/providers/fallback-chain.ts` | 同 provider 内降级 |

### 2.2 公共接口签名

#### 2.2.1 `BaseProvider`（抽象基类）

```typescript
abstract class BaseProvider implements LLMProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly capabilities: Capabilities;

  protected abstract authenticateImpl(credentials: Credentials): Promise<AuthResult>;
  protected abstract chatStreamImpl(req: ChatRequest): AsyncIterable<ChatChunk>;
  protected abstract chatImpl(req: ChatRequest): Promise<ChatResponse>;
  protected abstract countTokensImpl(messages: Message[]): Promise<TokenCount>;

  // 公共逻辑：重试、超时、circuit breaker、tracing 埋点
  async authenticate(credentials: Credentials): Promise<AuthResult> {
    return this.withCircuitBreaker('authenticate', () => this.authenticateImpl(credentials));
  }
  async *chatStream(req: ChatRequest): AsyncIterable<ChatChunk> {
    yield* this.withRetryAndTracing('chatStream', req, () => this.chatStreamImpl(req));
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    return this.withRetryAndTracing('chat', req, () => this.chatImpl(req));
  }
  async countTokens(messages: Message[]): Promise<TokenCount> {
    return this.withCircuitBreaker('countTokens', () => this.countTokensImpl(messages));
  }
  estimateCost(usage: TokenUsage): CostEstimate {
    return CostEstimator.estimate(this.id, usage);  // 委托给静态 CostEstimator
  }

  // 公共重试与 circuit breaker 模板方法（详见 §3.3）
  protected abstract readonly retryConfig: RetryConfig;
  protected abstract readonly breakerConfig: BreakerConfig;
}
```

#### 2.2.2 `ProviderRegistry`

```typescript
class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private credentialsStore: CredentialsStore;

  static create(): ProviderRegistry { /* 加载已注册 provider */ }

  register(provider: LLMProvider): void { /* 启动期注册 */ }
  get(id: string): LLMProvider { /* 查找，未注册抛 PROVIDER_NOT_FOUND */ }
  list(): LLMProvider[] { /* 全量列表 */ }
  listByCapability(cap: keyof Capabilities): LLMProvider[] { /* 按 capability 筛选 */ }

  // Risk Classifier 选型用（M4 调用）
  getRiskClassifierProvider(): LLMProvider | undefined {
    return this.listByCapability('supportsRiskClassification')[0];
  }
}
```

#### 2.2.3 `CredentialsStore`

```typescript
class CredentialsStore {
  private keychain: KeychainBackend;  // keytar 封装

  async get(providerId: string): Promise<Credentials | undefined> {
    // 优先级：CLI flag > env > .omniagent/credentials.json > keychain
    // 详细优先级表见 §3.4
  }
  async set(providerId: string, credentials: Credentials): Promise<void> { /* 写 keychain */ }
  async delete(providerId: string): Promise<void> { /* 删 keychain */ }
  async listAvailable(): Promise<string[]> { /* 列已配置 provider */ }
}
```

#### 2.2.4 `SSEParser` 与 `StreamAdapter`

```typescript
class SSEParser {
  // 解析 raw SSE 字节流为事件对象
  parse(chunk: Buffer): SSEEvent[] { /* 按 \n\n 分块解析 event:/data: 字段 */ }
}

class StreamAdapter {
  private pendingToolUse: Map<string, ToolUseBuilder> = new Map();

  // 把 provider 原始事件 → 统一 ChatChunk
  *normalize(providerId: string, events: Iterable<SSEEvent>): Iterable<ChatChunk> {
    // 字段映射 + 流分片合并 + stop_reason 归一
  }
}
```

#### 2.2.5 `TokenCounter` 与 `CostEstimator`

```typescript
class TokenCounter {
  private static estimators: Record<string, (messages: Message[]) => Promise<TokenCount>> = {};

  static register(providerId: string, fn: (m: Message[]) => Promise<TokenCount>): void { /* 注册 */ }
  static async count(providerId: string, messages: Message[]): Promise<TokenCount> { /* 调度 */ }
}

class CostEstimator {
  private static priceTable: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {};

  static registerPrice(providerId: string, price: { inputPerMillion: number; outputPerMillion: number }): void { /* 注册 */ }
  static estimate(providerId: string, usage: TokenUsage): CostEstimate { /* 计算 */ }
}
```

#### 2.2.6 `FallbackChain`

```typescript
class FallbackChain {
  constructor(private primary: LLMProvider, private fallback?: LLMProvider) {}

  async *chatStream(req: ChatRequest): AsyncIterable<ChatChunk> {
    try {
      yield* this.primary.chatStream(req);
    } catch (err) {
      if (this.isRecoverable(err) && this.fallback) {
        metrics.increment('fallback.invoked', { primary: this.primary.id, fallback: this.fallback.id });
        // 重发到 fallback（决策 C1：同 provider 内降级）
        yield* this.fallback.chatStream(req);
      } else {
        throw err;
      }
    }
  }

  private isRecoverable(err: unknown): boolean {
    // 5xx / 429 / TIMEOUT 可降级；AUTH_FAILED 不降级（提示用户重认证）
    const code = (err as { code?: OmniAgentErrorCode }).code;
    return code === 'PROVIDER_5XX' || code === 'PROVIDER_429' || code === 'PROVIDER_TIMEOUT';
  }
}
```

---

## 3. 详细设计

### 3.1 Provider 实现矩阵

| Provider | endpoint | 认证 | 流式协议 | tool_call 字段 | stop_reason 映射 | token 计数 |
|----------|----------|------|---------|----------------|------------------|-----------|
| OpenAI | `api.openai.com/v1/chat/completions` | Bearer API Key | SSE `data:` 行 | `tool_calls[].function.arguments` (JSON string) | `finish_reason: stop/tool_calls/length/content_filter` → `end_turn/tool_use/max_tokens/ptl` | tiktoken（精确） |
| Azure OpenAI | `<resource>.openai.azure.com/openai/deployments/<deployment>` | `api-key` header | 同 OpenAI | 同 OpenAI | 同 OpenAI | 同 OpenAI |
| Anthropic | `api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version` | SSE `event:` 类型化 | `content[].type=tool_use` + `input` 对象 | `stop_reason: end_turn/tool_use/max_tokens/stop_sequence` → `end_turn/tool_use/max_tokens/ptl` | 估算（4 char/token 近似） |
| AWS Bedrock | `bedrock-runtime.<region>.amazonaws.com` | AWS SigV4 | EventStream 二进制 | 同 Anthropic（Claude） | 同 Anthropic | 调用方提供（响应含 `usage`） |
| Ollama | `localhost:11434/api/chat` | 无 | HTTP chunked `stream: true` | `tool_calls` 兼容 OpenAI | 同 OpenAI | `count_tokens` API（精确） |
| DeepSeek | `api.deepseek.com/v1/chat/completions` | Bearer API Key | 同 OpenAI | 同 OpenAI | 同 OpenAI | tiktoken 近似（中文偏多估算） |
| Vertex AI | `<region>-aiplatform.googleapis.com` | OAuth 2.0 (gcloud) | SSE `data:` 行 | `functionCall` 对象 | `finishReason: STOP/MAX_TOKENS/SAFETY` → `end_turn/max_tokens/ptl` | 估算 |

### 3.2 流适配器核心算法

#### 3.2.1 SSE 解析（`SSEParser`）

```typescript
interface SSEEvent {
  event?: string;   // event: 字段（Anthropic 用）
  data: string;     // data: 字段（合并多行）
  id?: string;      // id: 字段（Last-Event-ID 重连）
  retry?: number;   // retry: 字段（重连间隔建议）
}

class SSEParser {
  private buffer = '';

  parse(chunk: Buffer): SSEEvent[] {
    this.buffer += chunk.toString('utf8');
    const events: SSEEvent[] = [];

    // SSE 事件以 \n\n 分隔
    let separatorIndex: number;
    while ((separatorIndex = this.buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + 2);
      const event = this.parseEvent(rawEvent);
      if (event) events.push(event);
    }
    return events;
  }

  private parseEvent(raw: string): SSEEvent | null {
    const event: SSEEvent = { data: '' };
    const dataLines: string[] = [];

    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue;  // 注释
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const field = line.slice(0, colonIdx);
      let value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);  // 去前导空格

      switch (field) {
        case 'event': event.event = value; break;
        case 'data': dataLines.push(value); break;
        case 'id': event.id = value; break;
        case 'retry': event.retry = parseInt(value, 10); break;
      }
    }
    event.data = dataLines.join('\n');
    return event.data ? event : null;
  }
}
```

#### 3.2.2 chunk 归一化（`StreamAdapter.normalize`）

不同 provider 的 SSE event 结构差异映射：

**OpenAI**（无 event 字段，data 是 JSON）：
```typescript
case 'openai': {
  const data = JSON.parse(event.data);
  if (data.choices?.[0]?.delta?.content) {
    yield { type: 'text_delta', text: data.choices[0].delta.content };
  }
  if (data.choices?.[0]?.delta?.tool_calls) {
    for (const tc of data.choices[0].delta.tool_calls) {
      const builder = this.pendingToolUse.get(tc.id) ?? new ToolUseBuilder(tc.id, tc.function.name);
      builder.appendArguments(tc.function.arguments);  // 分片 JSON 字符串拼接
      this.pendingToolUse.set(tc.id, builder);
    }
  }
  if (data.choices?.[0]?.finish_reason) {
    if (this.pendingToolUse.size > 0) {
      for (const builder of this.pendingToolUse.values()) {
        yield { type: 'tool_use', id: builder.id, name: builder.name, input: JSON.parse(builder.getArguments()) };
      }
      this.pendingToolUse.clear();
    }
    yield { type: 'stop', stop_reason: this.mapOpenAIFinishReason(data.choices[0].finish_reason) };
  }
  break;
}
```

**Anthropic**（event 字段区分类型）：
```typescript
case 'anthropic': {
  switch (event.event) {
    case 'content_block_start':
      if (JSON.parse(event.data).content_block.type === 'tool_use') {
        const { id, name } = JSON.parse(event.data).content_block;
        this.pendingToolUse.set(id, new ToolUseBuilder(id, name));
      }
      break;
    case 'content_block_delta':
      const delta = JSON.parse(event.data).delta;
      if (delta.type === 'text_delta') yield { type: 'text_delta', text: delta.text };
      if (delta.type === 'input_json_delta') {
        // 分片 JSON 累积
        const { index } = JSON.parse(event.data);
        const builder = [...this.pendingToolUse.values()][index];
        builder.appendArguments(delta.partial_json);
      }
      break;
    case 'message_stop':
      const stopData = JSON.parse(event.data);
      for (const builder of this.pendingToolUse.values()) {
        yield { type: 'tool_use', id: builder.id, name: builder.name, input: JSON.parse(builder.getArguments()) };
      }
      this.pendingToolUse.clear();
      yield { type: 'stop', stop_reason: this.mapAnthropicStopReason(stopData.delta.stop_reason) };
      break;
  }
  break;
}
```

**AWS Bedrock**（EventStream 二进制，需先解码）：
```typescript
case 'bedrock': {
  // Bedrock EventStream 是二进制格式，每条事件含 headers + payload
  const decoded = BedrockEventStreamDecoder.decode(event.data);
  // 解码后结构与 Anthropic 一致（Bedrock 的 Claude 模型）
  yield* this.normalizeAnthropicLike(decoded);
  break;
}
```

#### 3.2.3 stop_reason 映射表

| Provider 原始值 | 映射到 `StopReason` |
|----------------|---------------------|
| OpenAI `stop` / Anthropic `end_turn` / Bedrock `end_turn` / Ollama `stop` | `end_turn` |
| OpenAI `tool_calls` / Anthropic `tool_use` / Bedrock `tool_use` / Ollama `tool_calls` | `tool_use` |
| OpenAI `length` / Anthropic `max_tokens` / Bedrock `max_tokens` / Ollama `length` | `max_tokens` |
| OpenAI `content_filter` / Anthropic `stop_sequence` | `ptl`（content filter 触发 prompt 负载过大） |
| 用户 Ctrl+C / abort | `interrupted` |

### 3.3 公共逻辑（`BaseProvider`）

#### 3.3.1 重试策略

```typescript
interface RetryConfig {
  maxRetries: number;        // 默认 3
  baseDelayMs: number;       // 默认 1000
  maxDelayMs: number;        // 默认 30000
  retryableErrors: OmniAgentErrorCode[];  // 默认 [PROVIDER_5XX, PROVIDER_429, PROVIDER_TIMEOUT]
}

protected async withRetryAndTracing<T>(
  operation: string,
  req: ChatRequest,
  fn: () => Promise<T> | AsyncIterable<T>
): Promise<T> | AsyncIterable<T> {
  const span = tracer.startSpan(`provider.${this.id}.${operation}`, {
    tags: { model: req.model, message_count: req.messages.length },
  });

  for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
    try {
      const result = await fn();
      span.finish({ tags: { attempt, success: true } });
      return result;
    } catch (err) {
      const code = (err as { code?: OmniAgentErrorCode }).code;
      if (!code || !this.retryConfig.retryableErrors.includes(code) || attempt === this.retryConfig.maxRetries) {
        span.finish({ tags: { attempt, success: false, error: code } });
        throw err;
      }
      const delay = Math.min(this.retryConfig.baseDelayMs * 2 ** attempt, this.retryConfig.maxDelayMs);
      await sleep(delay);
      metrics.increment('provider.retry', { provider: this.id, attempt, error: code });
    }
  }
}
```

#### 3.3.2 Circuit Breaker

每个 provider 独立 circuit breaker（L2 §6.3 `CircuitBreaker` 类）：

```typescript
interface BreakerConfig {
  maxConsecutive: number;  // 默认 3
  maxTotal: number;        // 默认 10
  resetTimeoutMs: number;  // 默认 60000（1 分钟后 half-open）
}

protected async withCircuitBreaker<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const breaker = this.getBreaker(operation);
  if (breaker.isOpen()) {
    // half-open 状态尝试一个请求，closed 状态直接拒绝
    if (!breaker.attemptHalfOpen()) {
      const err: OmniAgentError = { code: 'PROVIDER_5XX', message: 'circuit breaker open' };
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
```

#### 3.3.3 超时

```typescript
// chatStream 的超时通过 AbortController 实现
protected async *chatStreamImpl(req: ChatRequest): AsyncIterable<ChatChunk> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 30000);
  try {
    yield* this.doChatStream(req, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}
```

### 3.4 认证管理（`CredentialsStore`）

#### 3.4.1 凭证优先级（高 → 低）

| 优先级 | 来源 | 用途 |
|--------|------|------|
| 1 | CLI flag `--api-key` | 临时覆盖（CI / 一次性调用） |
| 2 | 环境变量 `OMNIAGENT_<PROVIDER>_API_KEY` | CI / 容器 |
| 3 | `.omniagent/credentials.json` | 项目级配置（git ignored） |
| 4 | 系统 keychain（keytar） | 用户级持久化（推荐） |

```typescript
async get(providerId: string): Promise<Credentials | undefined> {
  // 1. CLI flag
  if (this.cliFlags[providerId]) {
    return { type: 'api_key', apiKey: this.cliFlags[providerId], providerId };
  }
  // 2. env
  const envKey = process.env[`OMNIAGENT_${providerId.toUpperCase()}_API_KEY`];
  if (envKey) {
    return { type: 'api_key', apiKey: envKey, providerId };
  }
  // 3. config file
  const configCred = this.configFileCredentials[providerId];
  if (configCred) return configCred;
  // 4. keychain
  const keychainCred = await this.keychain.get(`omniagent-${providerId}`);
  if (keychainCred) return { type: 'api_key', apiKey: keychainCred, providerId };
  return undefined;
}
```

#### 3.4.2 OAuth 2.0 流程（Vertex AI）

```typescript
async authenticateOAuth(providerId: string): Promise<AuthResult> {
  // PKCE 流程
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const authUrl = buildAuthUrl(providerId, codeChallenge, this.redirectUri);

  // 启动本地回调 server 接收 code
  const code = await this.waitForCallback(authUrl);
  const token = await this.exchangeCodeForToken(code, codeVerifier);

  await this.keychain.set(`omniagent-${providerId}`, JSON.stringify(token));
  return { success: true, providerId };
}
```

#### 3.4.3 认证失败处理

```typescript
async authenticate(credentials: Credentials): Promise<AuthResult> {
  const result = await this.validate(credentials);
  if (!result.success) {
    // fail-closed：认证失败不进入运行态（PRD §4.2）
    return {
      success: false,
      providerId: credentials.providerId,
      error: 'PROVIDER_AUTH_FAILED',
      errorMessage: `Authentication failed for ${credentials.providerId}. Please run \`omniagent auth login ${credentials.providerId}\` to re-authenticate.`,
    };
  }
  return result;
}
```

### 3.5 Token 计数（`TokenCounter`）

#### 3.5.1 per provider 实现

| Provider | 实现 | accuracy |
|----------|------|---------|
| OpenAI / Azure / DeepSeek | tiktoken（`cl100k_base` / `o200k_base`） | exact |
| Anthropic | 估算（4 char/token，中英文混合按字符数加权） | estimated |
| Bedrock | 响应 `usage` 字段返回（无法预计算 input） | exact（仅 output） |
| Ollama | `POST /api/tokenize` 调用本地 tokenize | exact |
| Vertex AI | 估算（按字符数 + 模型 multiplier） | estimated |

```typescript
class OpenAITokenCounter {
  static async count(messages: Message[]): Promise<TokenCount> {
    const encoder = await getEncoder('cl100k_base');
    let inputTokens = 0;
    for (const msg of messages) {
      inputTokens += 4;  // 每 message 4 token overhead
      for (const block of msg.content) {
        if (block.type === 'text') inputTokens += encoder.encode(block.text).length;
        if (block.type === 'tool_use') inputTokens += encoder.encode(JSON.stringify(block.input)).length + 8;
        if (block.type === 'tool_result') inputTokens += encoder.encode(block.content).length + 4;
      }
    }
    return { inputTokens, outputTokens: 0, accuracy: 'exact' };
  }
}
```

#### 3.5.2 M7 调用契约

M7 的 `shouldAutoCompact()` 调用 `TokenCounter.count()` 判断上下文体积：

```typescript
// M7 调用 M1（跨模块契约）
const tokenCount = await provider.countTokens(messages);
const ratio = tokenCount.inputTokens / provider.capabilities.maxContextWindow;
if (ratio > 0.8) return { shouldCompact: true, triggerLayer: 'L1_micro' };
```

### 3.6 成本估算（`CostEstimator`）

#### 3.6.1 价格表

```typescript
// src/providers/price-table.ts
export const PRICE_TABLE: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'openai:gpt-4': { inputPerMillion: 30, outputPerMillion: 60 },
  'openai:gpt-4o': { inputPerMillion: 5, outputPerMillion: 15 },
  'openai:gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'anthropic:claude-3-opus': { inputPerMillion: 15, outputPerMillion: 75 },
  'anthropic:claude-3-sonnet': { inputPerMillion: 3, outputPerMillion: 15 },
  'anthropic:claude-3-haiku': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  'bedrock:claude-3-haiku': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  'ollama:llama3-70b': { inputPerMillion: 0, outputPerMillion: 0 },  // 本地模型
  // ...
};
```

#### 3.6.2 估算逻辑

```typescript
static estimate(providerId: string, usage: TokenUsage): CostEstimate {
  const key = `${providerId}:${currentModel()}`;
  const price = PRICE_TABLE[key] ?? { inputPerMillion: 0, outputPerMillion: 0 };
  const usd =
    (usage.inputTokens / 1_000_000) * price.inputPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputPerMillion;
  return { usd, basis: price };
}
```

价格表每月 1 号由 CI 跑 `scripts/update-price-table.ts` 自动更新（从各 provider 官网爬取）。

### 3.7 Fallback Chain（决策 C1：同 provider 内降级）

#### 3.7.1 配置

```jsonc
// .omniagent/config.json
{
  "providers": {
    "openai": {
      "primaryModel": "gpt-4",
      "fallbackModel": "gpt-4o-mini"  // 同 provider 内单值（C1 决策：跨 provider 延后 M2）
    }
  }
}
```

#### 3.7.2 降级触发条件

| 错误码 | 降级 | 重试 | 备注 |
|--------|------|------|------|
| `PROVIDER_5XX` | 是（重试 3 次后） | 是（指数退避 1s/2s/4s） | 服务端临时故障 |
| `PROVIDER_429` | 是（重试 5 次后） | 是（5s/10s/30s/60s/120s） | 限流 |
| `PROVIDER_TIMEOUT` | 是（立即） | 否 | 30s 超时 |
| `PROVIDER_AUTH_FAILED` | 否 | 否 | 提示用户重认证 |
| `TOOL_EXECUTION_ERROR` | 否 | 否 | 工具错误，不降级 |
| `PTL_ERROR` | 否 | 否 | PTL 走 M7 三步降级 |

#### 3.7.3 跨 provider fallback（v2.x）

```jsonc
// v2.x 配置（决策 C1 延后项）
{
  "providers": {
    "openai": {
      "fallbackChain": ["openai:gpt-4", "bedrock:claude-3-sonnet", "ollama:llama3-70b"]
    }
  }
}
```

v1.0 不实现，跨 provider 涉及多 provider 认证状态管理（OAuth token 刷新、API key 验证），复杂度高。

---

## 4. 与其他模块的交互

### 4.1 调用图

```
┌─────────────────────────────────────────────────────────────┐
│                      M2 ReAct Loop                          │
│  CALL_LLM state → provider.chatStream(req)                 │
│  EVAL_STOP_REASON state ← ChatChunk{type:'stop', reason}   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              M1 LLM Abstraction (本模块)                    │
│  ProviderRegistry.get(providerId) → LLMProvider             │
│  FallbackChain.chatStream() → primary or fallback           │
│  BaseProvider.withRetryAndTracing() → chatStreamImpl()      │
└──────┬──────────────┬──────────────┬───────────────────────┘
       │              │              │
       ▼              ▼              ▼
┌──────────┐  ┌────────────┐  ┌────────────┐
│ OpenAI   │  │ Anthropic  │  │ Bedrock    │  ... 其他 provider
│ Provider │  │ Provider   │  │ Provider   │
└────┬─────┘  └─────┬──────┘  └─────┬──────┘
     │              │               │
     ▼              ▼               ▼
┌──────────────────────────────────────────┐
│  SSEParser → StreamAdapter → ChatChunk   │
│  TokenCounter.count()                    │
│  CostEstimator.estimate()                │
└──────────────────────────────────────────┘
       ▲
       │ M7 调用 countTokens() 做上下文压缩判断
       │
┌──────┴───────────────────────────────────┐
│  M7 Context & Memory Engine              │
│  shouldAutoCompact() → countTokens()     │
└──────────────────────────────────────────┘

       M4 Risk Classifier 调用本模块
       │
       ▼
┌──────────────────────────────────────────┐
│  M4 Risk Classifier                      │
│  classify(command) → thinkingProvider    │
│    .chat(req) → JSON{riskScore,...}       │
│  provider 筛选：capabilities.supportsRiskClassification=true │
└──────────────────────────────────────────┘
```

### 4.2 数据流

**输入流**（M2 → M1）：
- `ChatRequest`：`messages: Message[]` + `model: string` + `maxOutputTokens: number` + `tools?: Tool[]` + `abortSignal?: AbortSignal`
- 流式调用 `chatStream()` 返回 `AsyncIterable<ChatChunk>`

**输出流**（M1 → M2）：
- `ChatChunk` 流：`text_delta` / `tool_use` / `tool_result` / `stop` / `error`
- `stop_reason` 决定 M2 状态机分支：`end_turn → END_TURN` / `tool_use → TOOL_EXECUTE` / `max_tokens → END_TURN` / `ptl → PTL_DEGRADE` / `interrupted → END_TURN`

### 4.3 控制流（引用 L2 §4，不重复）

L2 §4.2.1 时序图"正常一轮"覆盖 M1 在 ReAct Loop 中的调用位置。L2 §4.2.2 "PTL 降级"覆盖 stop_reason=ptl 时的跨模块流程。

### 4.4 与各模块的接口契约

| 模块 | 调用方 | 被调用接口 | 契约 |
|------|--------|-----------|------|
| M2 | M2 → M1 | `provider.chatStream(req)` | 输入 `ChatRequest`，输出 `AsyncIterable<ChatChunk>`，`stop_reason` 必须是 5 种枚举之一 |
| M2 | M2 → M1（降级） | `provider.chat(req)` | 非流式调用，PTL 三步降级的第三步用 |
| M4 | M4 → M1 | `registry.getRiskClassifierProvider()` | 返回 `supportsRiskClassification=true` 的 provider，未配置返回 undefined（M4 走 fail-closed ask） |
| M7 | M7 → M1 | `provider.countTokens(messages)` | 返回 `TokenCount`，`accuracy` 字段告知精确度（M7 §4.4 逃逸条件 6） |
| M7 | M7 → M1 | `provider.capabilities.maxContextWindow` | M7 据此计算上下文压缩触发比例 |

---

## 5. 错误处理与降级

### 5.1 错误码映射（引用 L2 §6，不重复）

本模块可能产生的错误码（L2 `OmniAgentErrorCode` 枚举）：

| 错误码 | 触发条件 | 处理策略 | 是否降级 fallback |
|--------|---------|---------|------------------|
| `PROVIDER_5XX` | provider 返回 5xx | 重试 3 次指数退避，仍失败降级 fallback | 是 |
| `PROVIDER_429` | provider 返回 429 | 重试 5 次（5s/10s/30s/60s/120s），仍失败降级 fallback | 是 |
| `PROVIDER_TIMEOUT` | 30s 无响应 | 立即降级 fallback | 是 |
| `PROVIDER_AUTH_FAILED` | API key 无效 / OAuth token 过期 | 不重试不降级，提示用户重认证 | 否 |
| `TOOL_EXECUTION_ERROR` | 工具调用失败（非 provider 错误） | 不降级，M3 处理 | 否 |
| `PTL_ERROR` | stop_reason=ptl | 不降级，走 M7 PTL 三步降级 | 否 |
| `BUDGET_EXCEEDED` | 成本超预算 | 不降级，M4 Layer 5 拦截 | 否 |
| `USER_INTERRUPT` | 用户 Ctrl+C | 不降级，AbortController 传播 | 否 |

### 5.2 fail-closed 策略

**核心原则**：所有 provider 都失败后，不臆造响应，返回错误让 M2 走 `user_interrupt` 分支。

```typescript
// FallbackChain 的最终兜底
async *chatStream(req: ChatRequest): AsyncIterable<ChatChunk> {
  if (this.fallback) {
    try {
      yield* this.primary.chatStream(req);
      return;
    } catch (err) {
      if (this.isRecoverable(err)) {
        metrics.increment('fallback.invoked', { primary: this.primary.id });
        yield* this.fallback.chatStream(req);
        return;
      }
      throw err;
    }
  } else {
    // 无 fallback，直接调用 primary
    yield* this.primary.chatStream(req);
  }
}
```

### 5.3 circuit breaker 状态

每个 provider × operation 维护独立 circuit breaker：

| 状态 | 触发 | 行为 |
|------|------|------|
| `closed` | 默认 | 正常调用 |
| `open` | 连续 3 次失败或累计 10 次失败 | 直接拒绝，返回 `PROVIDER_5XX`（提示 circuit breaker open） |
| `half-open` | open 后 60s | 允许一个请求尝试，成功 → closed，失败 → open |

### 5.4 错误呈现

| 错误码 | 用户提示 | 日志级别 | 审计记录 |
|--------|---------|---------|---------|
| `PROVIDER_5XX` | "Provider 暂时不可用，已自动重试/降级" | WARN | 是（含 provider/model/attempt） |
| `PROVIDER_429` | "Provider 限流，已自动重试/降级" | WARN | 是 |
| `PROVIDER_TIMEOUT` | "Provider 响应超时，已降级到 fallback model" | WARN | 是 |
| `PROVIDER_AUTH_FAILED` | "认证失败，请运行 `omniagent auth login <provider>` 重新登录" | ERROR | 是（含 provider，不含 apiKey） |
| circuit breaker open | "Provider 暂时不可用（circuit breaker open），请稍后重试" | ERROR | 是 |

审计日志不含 API key 与 OAuth token 等敏感字段。

---

## 6. 测试用例骨架

### 6.1 单元测试

#### 6.1.1 `SSEParser`

```typescript
describe('SSEParser', () => {
  test('单事件解析', () => {
    const parser = new SSEParser();
    const events = parser.parse(Buffer.from('data: {"hello":"world"}\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"hello":"world"}');
  });

  test('多行 data 合并', () => {
    const parser = new SSEParser();
    const events = parser.parse(Buffer.from('data: line1\ndata: line2\n\n'));
    expect(events[0].data).toBe('line1\nline2');
  });

  test('event 字段解析（Anthropic）', () => {
    const parser = new SSEParser();
    const events = parser.parse(Buffer.from('event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n'));
    expect(events[0].event).toBe('content_block_delta');
  });

  test('跨 chunk 事件缓冲', () => {
    const parser = new SSEParser();
    expect(parser.parse(Buffer.from('data: '))).toHaveLength(0);
    expect(parser.parse(Buffer.from('{"a":1}\n\n'))).toHaveLength(1);
  });

  test('注释行忽略', () => {
    const parser = new SSEParser();
    const events = parser.parse(Buffer.from(': this is a comment\ndata: {"x":1}\n\n'));
    expect(events).toHaveLength(1);
  });
});
```

#### 6.1.2 `StreamAdapter`（流分片合并）

```typescript
describe('StreamAdapter - OpenAI tool_call 分片合并', () => {
  test('tool_call 分多个 chunk 到达', async () => {
    const adapter = new StreamAdapter();
    const chunks: ChatChunk[] = [];
    const events = [
      { data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"' } }] } }] }) }) },
      { data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: 'SF' } }] } }] }) }) },
      { data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"}' } }] } }] }) }) },
      { data: JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }) }) },
    ];
    for await (const chunk of adapter.normalize('openai', events)) chunks.push(chunk);
    expect(chunks).toContainEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } });
    expect(chunks[chunks.length - 1]).toEqual({ type: 'stop', stop_reason: 'tool_use' });
  });
});
```

#### 6.1.3 `CredentialsStore` 优先级

```typescript
describe('CredentialsStore 优先级', () => {
  test('CLI flag > env > config > keychain', async () => {
    process.env.OMNIAGENT_OPENAI_API_KEY = 'env-key';
    const store = new CredentialsStore({ cliFlags: { openai: 'cli-key' }, /* ... */ });
    const cred = await store.get('openai');
    expect(cred?.apiKey).toBe('cli-key');
  });

  test('无凭证返回 undefined（fail-closed）', async () => {
    const store = new CredentialsStore();
    const cred = await store.get('openai');
    expect(cred).toBeUndefined();
  });
});
```

#### 6.1.4 `FallbackChain`

```typescript
describe('FallbackChain', () => {
  test('primary 5xx → fallback 调用', async () => {
    const primary = mockProvider({ throwOn: { code: 'PROVIDER_5XX' } });
    const fallback = mockProvider({ chunks: [{ type: 'text_delta', text: 'ok' }] });
    const chain = new FallbackChain(primary, fallback);
    const chunks = [];
    for await (const c of chain.chatStream(mockReq())) chunks.push(c);
    expect(fallback.chatStream).toHaveBeenCalled();
    expect(chunks[0].text).toBe('ok');
  });

  test('AUTH_FAILED 不降级', async () => {
    const primary = mockProvider({ throwOn: { code: 'PROVIDER_AUTH_FAILED' } });
    const fallback = mockProvider({});
    const chain = new FallbackChain(primary, fallback);
    await expect(async () => {
      for await (const _ of chain.chatStream(mockReq())) {}
    }).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    expect(fallback.chatStream).not.toHaveBeenCalled();
  });
});
```

### 6.2 集成测试（mock provider API）

用 `msw` 拦截 HTTP 请求：

```typescript
describe('OpenAIProvider 集成测试', () => {
  test('chatStream 完整流', async () => {
    server.use(
      rest.post('https://api.openai.com/v1/chat/completions', (req, res, ctx) => {
        return res(
          ctx.set('Content-Type', 'text/event-stream'),
          ctx.body([
            'data: {"choices":[{"delta":{"content":"Hello"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":", world"}}]}',
            '',
            'data: {"choices":[{"finish_reason":"stop"}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'))
        );
      })
    );
    const provider = new OpenAIProvider();
    const chunks = [];
    for await (const c of provider.chatStream({ model: 'gpt-4', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(3);  // 2 text_delta + 1 stop
    expect(chunks[2]).toEqual({ type: 'stop', stop_reason: 'end_turn' });
  });
});
```

### 6.3 多 provider 行为一致性测试（不变量 #18）

引用 L2 §9.6 的 5 任务 × 3 provider = 15 组合测试：

```typescript
describe('跨 provider 行为一致性（不变量 #18）', () => {
  const tasks = [
    { name: '代码生成', prompt: '写一个快排的 TypeScript 实现' },
    { name: '工具调用', prompt: '使用 read_file 工具读取 /tmp/test.txt' },
    { name: '多轮对话', prompt: '...（3 轮上下文）' },
    { name: '长上下文', prompt: '...（10K token 输入）' },
    { name: '错误恢复', prompt: '...（模拟 PROVIDER_5XX 后恢复）' },
  ];
  const providers = ['openai', 'anthropic', 'bedrock'];

  for (const task of tasks) {
    for (const providerId of providers) {
      test(`${task.name} @ ${providerId}`, async () => {
        const provider = registry.get(providerId);
        const response = await runTask(provider, task);
        // 断言：所有 provider 应能完成 task（不抛错）
        expect(response.stop_reason).not.toBe('error');
        // 容忍 token 数差异（±50%）
        // 容忍具体文字差异（语义一致即可）
      });
    }
  }
});
```

### 6.4 不变量测试

#### 6.4.1 不变量 #17（harness 代码不含供应商专有名词）

```typescript
describe('不变量 #17 - brand neutrality', () => {
  test('src/ 下除 src/providers/ 外无供应商名', () => {
    const vendorPattern = /\b(openai|bedrock|anthropic|claude|azure|vertex|ollama|deepseek|qwen|glm|grok|vllm)\b/i;
    const harnessFiles = glob.sync('src/**/*.ts', { ignore: 'src/providers/**' });
    for (const file of harnessFiles) {
      const content = fs.readFileSync(file, 'utf8');
      // 允许在注释/字符串中出现（如示例配置），但禁止在类型名/函数名/变量名
      expect(content).not.toMatch(vendorPattern);
    }
  });
});
```

#### 6.4.2 不变量 #18（跨 provider 行为一致性）

见 §6.3。

---

## 7. 里程碑对齐

引用 L2 §11.2 M1 三个迭代，本模块各迭代交付：

### 7.1 M1 迭代 1（2 周）

| 组件 | 交付物 | 验收 |
|------|--------|------|
| `LLMProvider` 接口 | 已在 `omniagent-types.ts` §5 定义 | 编译通过 |
| `BaseProvider` 抽象基类 | `src/providers/base.ts` | 重试/circuit breaker 单元测试 PASS |
| `OpenAIProvider` | `src/providers/openai.ts` | chat + chatStream + tool_use + stop_reason 集成测试 PASS |
| `SSEParser` | `src/providers/sse-parser.ts` | 单元测试 PASS（含跨 chunk 缓冲） |
| `StreamAdapter` | `src/providers/stream-adapter.ts` | OpenAI tool_call 分片合并测试 PASS |
| `CredentialsStore` | `src/providers/credentials.ts` | 4 级优先级测试 PASS |
| `TokenCounter`（OpenAI） | tiktoken 集成 | 精确 token 计数测试 PASS |
| `ProviderRegistry` | `src/providers/registry.ts` | 注册/查找/筛选测试 PASS |

### 7.2 M1 迭代 2（2 周）

| 组件 | 交付物 | 验收 |
|------|--------|------|
| `BedrockProvider` | `src/providers/bedrock.ts` | EventStream 二进制解码 + Claude 模型测试 PASS |
| `OllamaProvider` | `src/providers/ollama.ts` | 本地模型 chat + tool_use 测试 PASS |
| `AnthropicProvider` | `src/providers/anthropic.ts` | 直接 API（非 Bedrock）chat + tool_use 测试 PASS |
| `StreamAdapter` 扩展 | Anthropic + Bedrock 事件类型 | 字段映射测试 PASS |
| `CostEstimator` | `src/providers/cost-estimator.ts` | 价格表 + 估算测试 PASS |

### 7.3 M1 迭代 3（2 周）

| 组件 | 交付物 | 验收 |
|------|--------|------|
| `FallbackChain` | `src/providers/fallback-chain.ts` | 5xx/429/TIMEOUT 降级 + AUTH_FAILED 不降级测试 PASS |
| `DeepSeekProvider` | `src/providers/deepseek.ts` | OpenAI 兼容协议测试 PASS |
| `VertexAIProvider` | `src/providers/vertexai.ts` | OAuth 2.0 PKCE 流程测试 PASS |
| 跨 provider 一致性测试集 | `tests/integration/provider-consistency.test.ts` | 5 任务 × 3 provider = 15 组合 PASS |
| 价格表自动化 | `scripts/update-price-table.ts` | CI 每月 1 号自动更新 |

### 7.4 M3 前置（不阻塞 M1）

| 组件 | 交付物 | 验收 |
|------|--------|------|
| `supportsRiskClassification` 实际使用 | M4 Risk Classifier 调用 `registry.getRiskClassifierProvider()` | 返回符合条件的 provider |
| Risk Classifier provider 选型 | 决策 A2 待定具体模型 | M3 启动前确认（如 GPT-4o-mini / Claude Haiku / DeepSeek-V3-lite） |

---

## 8. 开放问题

### 8.1 v2.x 演进项（引用 PRD §8.4，不重复）

- 跨 provider fallback chain（决策 C1 延后项）
- Risk Classifier 本地小模型（`OMNIAGENT_RISK_CLASSIFIER_LOCAL=1`）
- findRelevantMemories 本地 embedding（合规场景数据不出内网）
- Windows NAPI 支持（决策 B1 延后项）

### 8.2 待定决策

| # | 问题 | 选项 | 决策时机 |
|---|------|------|---------|
| 1 | Risk Classifier 具体 provider | GPT-4o-mini / Claude Haiku / DeepSeek-V3-lite | M3 启动前（决策 A2） |
| 2 | DeepSeek SSE 格式差异 | 实测后确认（理论上兼容 OpenAI，但 reasoning_content 字段差异） | M1 迭代 3 |
| 3 | Bedrock 跨模型 tool_call 字段差异 | Claude 同 Anthropic / Llama 同 OpenAI / Gemini 独立 | M1 迭代 2 |
| 4 | Azure OpenAI deployment name 映射 | 用户配置 vs 自动发现 | M2 启动前 |
| 5 | 价格表更新频率 | 每月 1 号 / 每周 / 实时 | M1 迭代 3 |
| 6 | OAuth token 刷新时机 | 主动刷新（到期前 5 分钟） vs 被动刷新（401 时） | M1 迭代 3 |

### 8.3 依赖其他模块的交付物

- M2 ReAct Loop：消费 `ChatChunk` 流，`stop_reason` 必须与 M2 状态机分支匹配（M1 完成后 M2 才能集成）
- M4 Risk Classifier：调用 `getRiskClassifierProvider()`，要求 M1 已注册至少一个 `supportsRiskClassification=true` 的 provider（M3 启动前）
- M7 Context & Memory：调用 `countTokens()`，要求 M1 提供精确或估算的 token 计数（M1 迭代 1 完成后可用）

---

## 附录 A：与本模块相关的 L2/PRD 章节映射

| 本 L3 章节 | 引用 PRD 章节 | 引用 L2 章节 | 补充内容 |
|-----------|-------------|------------|---------|
| §1 模块概述 | PRD §1 | L2 §1 | 不重复，仅引用 |
| §2 组件清单 | PRD §3.1 | L2 §3 + `omniagent-types.ts` §5 | 补 16 个组件清单 + 类/函数签名 |
| §3 详细设计 | PRD §3 + §4 | L2 §2/§3/§5 | 补 provider 矩阵 + SSE 解析 + 认证 + token 计数 + 成本 + fallback |
| §4 与其他模块的交互 | PRD §5 | L2 §4 | 补调用图 + 数据流 + 接口契约表 |
| §5 错误处理与降级 | PRD §6 | L2 §6 | 补错误码映射 + fail-closed + circuit breaker + 错误呈现 |
| §6 测试用例骨架 | PRD §7 | L2 §9 | 补单元/集成/一致性/不变量测试骨架 |
| §7 里程碑对齐 | PRD §8 | L2 §11.2 | 补 3 迭代 × 组件级交付物 + 验收标准 |
| §8 开放问题 | PRD §8.4 | — | 补 v2.x 演进 + 6 项待定决策 |

---

## 附录 B：L3-M1 文档不变量

| # | 不变量 | 守护机制 |
|---|--------|---------|
| L3-M1-1 | 不引入 PRD/L2 未定义的新类型 | 所有类型引用 `omniagent-types.ts` |
| L3-M1-2 | 不重复 PRD/L2 已有内容 | 每节开头"引用：..."声明 |
| L3-M1-3 | 组件清单与 L2 §11.2 M1 交付物一致 | §7 表格逐项对应 |
| L3-M1-4 | 错误码使用 L2 `OmniAgentErrorCode` 枚举 | 不发明新错误码 |
| L3-M1-5 | 不引入新供应商专有名词作为依赖 | provider 实现限于 `src/providers/`，harness 代码无供应商名 |

---

*本文件是 OmniAgent CLI L3 模块设计的第一份，与 PRD mod-01 + L2 整体设计配套使用。L3-M1 冻结后才能进 M1 迭代 1 开发。后续 L3-M7 / L3-M2 / L3-M3 / L3-M5 / L3-M6 / L3-M4 按关键路径串行撰写。*
