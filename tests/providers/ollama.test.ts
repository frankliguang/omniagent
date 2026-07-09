import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OllamaProvider } from '../../src/providers/ollama.js';
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

test('OllamaProvider.authenticate: 200 成功', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/api/tags'),
      response: { status: 200, json: { models: [{ name: 'llama3' }] } },
    },
  ]);
  const provider = new OllamaProvider({ fetchImpl });
  const result = await provider.authenticate({ type: 'api_key', apiKey: 'unused', providerId: 'ollama' });
  assert.equal(result.success, true);
  assert.equal(result.providerId, 'ollama');
});

test('OllamaProvider.authenticate: 500 失败', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/api/tags'),
      response: { status: 500, body: 'internal error' },
    },
  ]);
  const provider = new OllamaProvider({ fetchImpl });
  const result = await provider.authenticate({ type: 'api_key', apiKey: 'unused', providerId: 'ollama' });
  assert.equal(result.success, false);
  assert.equal(result.error, 'PROVIDER_5XX');
});

test('OllamaProvider.authenticate: 网络错误 → PROVIDER_TIMEOUT', async () => {
  const fetchImpl = (async () => {
    throw new Error('connection refused');
  }) as FetchImpl;
  const provider = new OllamaProvider({ fetchImpl });
  const result = await provider.authenticate({ type: 'api_key', apiKey: 'unused', providerId: 'ollama' });
  assert.equal(result.success, false);
  assert.equal(result.error, 'PROVIDER_TIMEOUT');
});

test('OllamaProvider: 无需 API key，oauth 凭证也接受', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/api/tags'),
      response: { status: 200, json: { models: [] } },
    },
  ]);
  const provider = new OllamaProvider({ fetchImpl });
  const result = await provider.authenticate({
    type: 'oauth',
    accessToken: 'unused',
    expiresAt: '2026-12-31T00:00:00Z' as never,
    providerId: 'ollama',
  });
  assert.equal(result.success, true);
});

// ============================================================
// chatStream — 纯文本流（NDJSON）
// ============================================================

test('OllamaProvider.chatStream: 纯文本 NDJSON 流', async () => {
  // Ollama 流式响应：每行一个 JSON 对象
  const ndjson = [
    '{"model":"llama3","created_at":"2026-01-01T00:00:00Z","message":{"role":"assistant","content":"Hello"},"done":false}',
    '{"model":"llama3","created_at":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":" world"},"done":false}',
    '{"model":"llama3","created_at":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":""},"done":true,"total_duration":1000,"prompt_eval_count":5,"eval_count":2}',
  ].join('\n');

  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/api/tags'),
      response: { status: 200, json: { models: [{ name: 'llama3' }] } },
    },
    {
      match: (url) => url.endsWith('/api/chat'),
      response: {
        status: 200,
        body: makeStream(ndjson),
        headers: { 'Content-Type': 'application/x-ndjson' },
      },
    },
  ]);
  const provider = new OllamaProvider({ fetchImpl });
  await provider.authenticate({ type: 'api_key', apiKey: 'unused', providerId: 'ollama' });

  const req: ChatRequest = {
    model: 'llama3',
    messages: [userMessage('hi')],
  };
  const chunks = await collect(provider.chatStream(req));

  // 应有 message_start
  assert.ok(chunks.some(c => c.type === 'message_start'), '应有 message_start');

  // 应有 2 个 text_delta
  const textDeltas = chunks.filter(c => c.type === 'text_delta') as Array<{ type: 'text_delta'; text: string }>;
  assert.equal(textDeltas.length, 2);
  assert.equal(textDeltas[0].text, 'Hello');
  assert.equal(textDeltas[1].text, ' world');

  // 应有 message_end
  const end = chunks.find(c => c.type === 'message_end') as { type: 'message_end'; stopReason: string; tokenUsage: { inputTokens: number; outputTokens: number } } | undefined;
  assert.ok(end, '应有 message_end');
  assert.equal(end?.stopReason, 'end_turn');
  assert.equal(end?.tokenUsage.inputTokens, 5);
  assert.equal(end?.tokenUsage.outputTokens, 2);
});

test('OllamaProvider.chatStream: tool_use 流', async () => {
  const ndjson = [
    '{"model":"llama3","message":{"role":"assistant","content":"Let me check","tool_calls":[{"function":{"name":"get_weather","arguments":{"city":"SF"}}}]},"done":false}',
    '{"model":"llama3","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":15}',
  ].join('\n');

  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/api/tags'),
      response: { status: 200, json: { models: [] } },
    },
    {
      match: (url) => url.endsWith('/api/chat'),
      response: {
        status: 200,
        body: makeStream(ndjson),
      },
    },
  ]);
  const provider = new OllamaProvider({ fetchImpl });
  await provider.authenticate({ type: 'api_key', apiKey: 'unused', providerId: 'ollama' });

  const req: ChatRequest = {
    model: 'llama3',
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
  const start = chunks.find(c => c.type === 'tool_use_start');
  assert.ok(start, '应有 tool_use_start');
  assert.equal((start as { name: string }).name, 'get_weather');

  const delta = chunks.find(c => c.type === 'tool_use_delta') as { type: 'tool_use_delta'; input: Record<string, unknown> } | undefined;
  assert.ok(delta, '应有 tool_use_delta');
  assert.deepEqual(delta?.input, { city: 'SF' });

  const end = chunks.find(c => c.type === 'tool_use_end');
  assert.ok(end, '应有 tool_use_end');

  const msgEnd = chunks.find(c => c.type === 'message_end') as { stopReason: string } | undefined;
  assert.equal(msgEnd?.stopReason, 'tool_use');
});

test('OllamaProvider.chatStream: 未认证抛错', async () => {
  const provider = new OllamaProvider();
  await assert.rejects(
    () => collect(provider.chatStream({ model: 'llama3', messages: [userMessage('hi')] })),
    (err: { code?: string }) => err.code === 'PROVIDER_AUTH_FAILED',
  );
});

test('OllamaProvider.chatStream: HTTP 500 → PROVIDER_5XX', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/api/tags'),
      response: { status: 200, json: { models: [] } },
    },
    {
      match: (url) => url.endsWith('/api/chat'),
      response: { status: 500, body: 'model not found' },
    },
  ]);
  const provider = new OllamaProvider({ fetchImpl, breakerConfig: { ...DEFAULT_BREAKER_CONFIG, maxConsecutive: 100 } });
  await provider.authenticate({ type: 'api_key', apiKey: 'unused', providerId: 'ollama' });
  await assert.rejects(
    () => collect(provider.chatStream({ model: 'nonexistent', messages: [userMessage('hi')] })),
    (err: { code?: string }) => err.code === 'PROVIDER_5XX',
  );
});

// ============================================================
// chat（非流式）
// ============================================================

test('OllamaProvider.chat: 纯文本响应', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/api/tags'),
      response: { status: 200, json: { models: [] } },
    },
    {
      match: (url) => url.endsWith('/api/chat'),
      response: {
        status: 200,
        json: {
          model: 'llama3',
          created_at: '2026-01-01T00:00:00Z',
          message: { role: 'assistant', content: 'Hello there' },
          done: true,
          total_duration: 1000,
          prompt_eval_count: 5,
          eval_count: 2,
        },
      },
    },
  ]);
  const provider = new OllamaProvider({ fetchImpl });
  await provider.authenticate({ type: 'api_key', apiKey: 'unused', providerId: 'ollama' });

  const req: ChatRequest = {
    model: 'llama3',
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

test('OllamaProvider.chat: tool_use 响应', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/api/tags'),
      response: { status: 200, json: { models: [] } },
    },
    {
      match: (url) => url.endsWith('/api/chat'),
      response: {
        status: 200,
        json: {
          model: 'llama3',
          message: {
            role: 'assistant',
            content: 'Let me check',
            tool_calls: [
              { function: { name: 'get_weather', arguments: { city: 'SF' } } },
            ],
          },
          done: true,
          prompt_eval_count: 10,
          eval_count: 15,
        },
      },
    },
  ]);
  const provider = new OllamaProvider({ fetchImpl });
  await provider.authenticate({ type: 'api_key', apiKey: 'unused', providerId: 'ollama' });

  const req: ChatRequest = {
    model: 'llama3',
    messages: [userMessage('weather')],
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

test('OllamaProvider.chat: 401 → PROVIDER_AUTH_FAILED', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/api/tags'),
      response: { status: 200, json: { models: [] } },
    },
    {
      match: (url) => url.endsWith('/api/chat'),
      response: { status: 401, body: 'unauthorized' },
    },
  ]);
  const provider = new OllamaProvider({ fetchImpl });
  await provider.authenticate({ type: 'api_key', apiKey: 'unused', providerId: 'ollama' });
  await assert.rejects(
    () => provider.chat({ model: 'llama3', messages: [userMessage('hi')] }),
    (err: { code?: string }) => err.code === 'PROVIDER_AUTH_FAILED',
  );
});

// ============================================================
// countTokens
// ============================================================

test('OllamaProvider.countTokens: 4 字符/token 估算', async () => {
  const provider = new OllamaProvider();
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'a'.repeat(40) }] },
  ];
  const count = await provider.countTokens(msgs);
  assert.equal(count.inputTokens, 10);
  assert.equal(count.accuracy, 'estimated');
});

// ============================================================
// estimateCost（本地推理，0 成本）
// ============================================================

test('OllamaProvider.estimateCost: 本地推理 0 成本', () => {
  const provider = new OllamaProvider();
  const cost = provider.estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost.usd, 0);
});

// ============================================================
// Capabilities
// ============================================================

test('OllamaProvider.capabilities: 字段正确', () => {
  const provider = new OllamaProvider();
  assert.equal(provider.id, 'ollama');
  assert.equal(provider.displayName, 'Ollama');
  assert.equal(provider.capabilities.supportsStreaming, true);
  assert.equal(provider.capabilities.supportsToolCalling, true);
  assert.equal(provider.capabilities.supportsPromptCaching, false);
  assert.equal(provider.capabilities.supportsRiskClassification, false);
});

// ============================================================
// baseUrl 自定义
// ============================================================

test('OllamaProvider: 自定义 baseUrl', async () => {
  let calledUrl = '';
  const fetchImpl = (async (url: string | URL | Request) => {
    calledUrl = typeof url === 'string' ? url : url.toString();
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  }) as FetchImpl;
  const provider = new OllamaProvider({ baseUrl: 'http://my-host:8080', fetchImpl });
  await provider.authenticate({ type: 'api_key', apiKey: 'unused', providerId: 'ollama' });
  assert.equal(calledUrl, 'http://my-host:8080/api/tags');
});
