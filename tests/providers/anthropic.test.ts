import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { DEFAULT_BREAKER_CONFIG } from '../../src/providers/circuit-breaker.js';
import type { ChatChunk, ChatRequest, Message } from '../../src/types/index.js';

// ------------------------------------------------------------
// Mock fetch helpers
// ------------------------------------------------------------

type FetchImpl = typeof fetch;

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

interface MockResponse {
  status?: number;
  body?: string | ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
  json?: unknown;
}

function makeMockFetch(responses: Array<{ match: (url: string, init?: RequestInit) => boolean; response: MockResponse }>): FetchImpl {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const { match, response } of responses) {
      if (match(urlStr, init)) {
        const body = response.body ?? (response.json !== undefined ? JSON.stringify(response.json) : '');
        const bodyStream = typeof body === 'string' ? makeStream(body) : body;
        return new Response(bodyStream, {
          status: response.status ?? 200,
          headers: response.headers,
        });
      }
    }
    return new Response('not mocked', { status: 599 });
  }) as FetchImpl;
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

// ============================================================
// 认证
// ============================================================

test('AnthropicProvider.authenticate: 200 成功', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/models'),
      response: { status: 200, json: { data: [{ id: 'claude-sonnet-4-5' }] } },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-ant-test' });
  const result = await provider.authenticate({ type: 'api_key', apiKey: 'sk-ant-test', providerId: 'anthropic' });
  assert.equal(result.success, true);
  assert.equal(result.providerId, 'anthropic');
});

test('AnthropicProvider.authenticate: 401 失败', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/models'),
      response: { status: 401, body: 'Unauthorized' },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-bad' });
  const result = await provider.authenticate({ type: 'api_key', apiKey: 'sk-bad', providerId: 'anthropic' });
  assert.equal(result.success, false);
  assert.equal(result.error, 'PROVIDER_AUTH_FAILED');
});

test('AnthropicProvider.authenticate: 非 api_key 凭证失败', async () => {
  const provider = new AnthropicProvider({ apiKey: 'sk-test' });
  const result = await provider.authenticate({
    type: 'oauth',
    accessToken: 'token',
    expiresAt: '2026-12-31T00:00:00Z' as never,
    providerId: 'anthropic',
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'PROVIDER_AUTH_FAILED');
});

test('AnthropicProvider.authenticate: 429 视为认证通过（key 有效）', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/models'),
      response: { status: 429, body: 'rate limited' },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-test' });
  const result = await provider.authenticate({ type: 'api_key', apiKey: 'sk-test', providerId: 'anthropic' });
  assert.equal(result.success, true);
});

test('AnthropicProvider.authenticate: 网络错误 → PROVIDER_TIMEOUT', async () => {
  const fetchImpl = (async () => {
    throw new Error('network down');
  }) as FetchImpl;
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-test' });
  const result = await provider.authenticate({ type: 'api_key', apiKey: 'sk-test', providerId: 'anthropic' });
  assert.equal(result.success, false);
  assert.equal(result.error, 'PROVIDER_TIMEOUT');
});

// ============================================================
// chatStream — 纯文本流
// ============================================================

test('AnthropicProvider.chatStream: 纯文本流', async () => {
  // Anthropic SSE 事件序列：message_start → content_block_start → content_block_delta × 2 → content_block_stop → message_delta → message_stop
  const sseBody = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    '',
  ].join('\n\n');

  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/messages'),
      response: {
        status: 200,
        body: makeStream(sseBody),
        headers: { 'Content-Type': 'text/event-stream' },
      },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-ant-test' });
  const req: ChatRequest = {
    model: 'claude-sonnet-4-5',
    messages: [userMessage('hi')],
  };
  const chunks = await collect(provider.chatStream(req));

  // 第一个应是 message_start
  assert.equal(chunks[0].type, 'message_start');
  // 中间应是两个 text_delta
  const textDeltas = chunks.filter(c => c.type === 'text_delta') as Array<{ type: 'text_delta'; text: string }>;
  assert.equal(textDeltas.length, 2);
  assert.equal(textDeltas[0].text, 'Hello');
  assert.equal(textDeltas[1].text, ' world');
  // 最后应是 message_end
  const end = chunks[chunks.length - 1];
  assert.equal(end.type, 'message_end');
  assert.equal((end as { stopReason: string }).stopReason, 'end_turn');
});

// ============================================================
// chatStream — tool_use 流
// ============================================================

test('AnthropicProvider.chatStream: tool_use 流', async () => {
  // tool_use input 是分片 JSON：{"city":"SF"} 拆为 {"city":" + SF"}
  const sseBody = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","role":"assistant","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    '',
  ].join('\n\n');

  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/messages'),
      response: {
        status: 200,
        body: makeStream(sseBody),
        headers: { 'Content-Type': 'text/event-stream' },
      },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-ant-test' });
  const req: ChatRequest = {
    model: 'claude-sonnet-4-5',
    messages: [userMessage('weather in SF')],
    tools: [{
      name: 'get_weather',
      description: 'Get weather',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      call: async () => ({ content: [{ type: 'text', text: 'sunny' }] }),
      checkPermissions: () => ({ decision: 'allow' as const }),
    }],
  };
  const chunks = await collect(provider.chatStream(req));

  // 应有 tool_use_start / tool_use_delta / tool_use_end
  const start = chunks.find(c => c.type === 'tool_use_start') as { type: 'tool_use_start'; id: string; name: string } | undefined;
  assert.ok(start, '应有 tool_use_start');
  assert.equal(start?.name, 'get_weather');

  const delta = chunks.find(c => c.type === 'tool_use_delta') as { type: 'tool_use_delta'; id: string; input: Record<string, unknown> } | undefined;
  assert.ok(delta, '应有 tool_use_delta');
  assert.deepEqual(delta?.input, { city: 'SF' });

  const end = chunks.find(c => c.type === 'tool_use_end') as { type: 'tool_use_end'; id: string } | undefined;
  assert.ok(end, '应有 tool_use_end');

  const msgEnd = chunks.find(c => c.type === 'message_end') as { type: 'message_end'; stopReason: string } | undefined;
  assert.equal(msgEnd?.stopReason, 'tool_use');
});

// ============================================================
// chat（非流式）
// ============================================================

test('AnthropicProvider.chat: 纯文本响应', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/messages'),
      response: {
        status: 200,
        json: {
          id: 'msg_3',
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello there' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-ant-test' });
  const req: ChatRequest = {
    model: 'claude-sonnet-4-5',
    messages: [userMessage('hi')],
  };
  const resp = await provider.chat(req);
  assert.equal(resp.stopReason, 'end_turn');
  assert.equal(resp.tokenUsage.inputTokens, 5);
  assert.equal(resp.tokenUsage.outputTokens, 2);
  const textBlock = resp.message.content.find(b => b.type === 'text');
  assert.ok(textBlock);
  assert.equal((textBlock as { text: string }).text, 'Hello there');
});

test('AnthropicProvider.chat: tool_use 响应', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/messages'),
      response: {
        status: 200,
        json: {
          id: 'msg_4',
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: { city: 'SF' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 15 },
        },
      },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-ant-test' });
  const req: ChatRequest = {
    model: 'claude-sonnet-4-5',
    messages: [userMessage('weather in SF')],
    tools: [{
      name: 'get_weather',
      description: 'Get weather',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      call: async () => ({ content: [{ type: 'text', text: 'sunny' }] }),
      checkPermissions: () => ({ decision: 'allow' as const }),
    }],
  };
  const resp = await provider.chat(req);
  assert.equal(resp.stopReason, 'tool_use');
  const toolUse = resp.message.content.find(b => b.type === 'tool_use');
  assert.ok(toolUse);
  assert.equal((toolUse as { name: string }).name, 'get_weather');
  assert.deepEqual((toolUse as { input: Record<string, unknown> }).input, { city: 'SF' });
});

test('AnthropicProvider.chat: max_tokens stop_reason', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/messages'),
      response: {
        status: 200,
        json: {
          id: 'msg_5',
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'truncated' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 5, output_tokens: 100 },
        },
      },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-ant-test' });
  const req: ChatRequest = {
    model: 'claude-sonnet-4-5',
    messages: [userMessage('long text')],
    maxOutputTokens: 100,
  };
  const resp = await provider.chat(req);
  assert.equal(resp.stopReason, 'max_output_tokens');
});

// ============================================================
// 错误映射
// ============================================================

test('AnthropicProvider.chat: 401 → PROVIDER_AUTH_FAILED', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/messages'),
      response: { status: 401, body: 'invalid api key' },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-bad' });
  await assert.rejects(
    () => provider.chat({ model: 'claude-sonnet-4-5', messages: [userMessage('hi')] }),
    (err: { code?: string }) => err.code === 'PROVIDER_AUTH_FAILED',
  );
});

test('AnthropicProvider.chat: 429 → PROVIDER_429', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/messages'),
      response: { status: 429, body: 'rate limited' },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-test', breakerConfig: { ...DEFAULT_BREAKER_CONFIG, maxConsecutive: 100 } });
  await assert.rejects(
    () => provider.chat({ model: 'claude-sonnet-4-5', messages: [userMessage('hi')] }),
    (err: { code?: string }) => err.code === 'PROVIDER_429',
  );
});

test('AnthropicProvider.chat: 500 → PROVIDER_5XX', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/v1/messages'),
      response: { status: 500, body: 'server error' },
    },
  ]);
  const provider = new AnthropicProvider({ fetchImpl, apiKey: 'sk-test', breakerConfig: { ...DEFAULT_BREAKER_CONFIG, maxConsecutive: 100 } });
  await assert.rejects(
    () => provider.chat({ model: 'claude-sonnet-4-5', messages: [userMessage('hi')] }),
    (err: { code?: string }) => err.code === 'PROVIDER_5XX',
  );
});

test('AnthropicProvider.chatStream: 未认证抛错', async () => {
  const provider = new AnthropicProvider({ apiKey: undefined as unknown as string });
  await assert.rejects(
    () => collect(provider.chatStream({ model: 'claude-sonnet-4-5', messages: [userMessage('hi')] })),
    (err: { code?: string }) => err.code === 'PROVIDER_AUTH_FAILED',
  );
});

// ============================================================
// countTokens
// ============================================================

test('AnthropicProvider.countTokens: 4 字符/token 估算', async () => {
  const provider = new AnthropicProvider({ apiKey: 'sk-test' });
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'a'.repeat(40) }] },  // 40 字符 → 10 token
  ];
  const count = await provider.countTokens(msgs);
  assert.equal(count.inputTokens, 10);
  assert.equal(count.accuracy, 'estimated');
});

// ============================================================
// estimateCost
// ============================================================

test('AnthropicProvider.estimateCost: 简单调用', () => {
  const provider = new AnthropicProvider({ apiKey: 'sk-test' });
  const cost = provider.estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  // anthropic: $3 input + $15 output per million
  assert.ok(cost.usd > 0);
  assert.ok(cost.basis?.inputPerMillion === 3 || cost.basis?.inputPerMillion === 15);
});

// ============================================================
// Capabilities
// ============================================================

test('AnthropicProvider.capabilities: 字段正确', () => {
  const provider = new AnthropicProvider({ apiKey: 'sk-test' });
  assert.equal(provider.id, 'anthropic');
  assert.equal(provider.displayName, 'Anthropic');
  assert.equal(provider.capabilities.supportsStreaming, true);
  assert.equal(provider.capabilities.supportsToolCalling, true);
  assert.equal(provider.capabilities.supportsRiskClassification, true);
  assert.ok(provider.capabilities.maxContextWindow >= 200_000);
});
