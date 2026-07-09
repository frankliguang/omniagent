import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIProvider } from '../../src/providers/openai.js';
import { DEFAULT_BREAKER_CONFIG } from '../../src/providers/circuit-breaker.js';
import type { ChatChunk, ChatRequest, Message } from '../../src/types/index.js';

// ------------------------------------------------------------
// Mock fetch helpers
// ------------------------------------------------------------

type FetchImpl = typeof fetch;

/** 把字符串转为 ReadableStream<Uint8Array> */
function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** 构造一个 mock fetch：按 URL path 返回不同响应 */
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

// ------------------------------------------------------------
// 测试用例
// ------------------------------------------------------------

test('OpenAIProvider.authenticate: 200 成功', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/models'),
      response: { status: 200, json: { data: [{ id: 'gpt-4o' }] } },
    },
  ]);
  const provider = new OpenAIProvider({ fetchImpl, apiKey: 'sk-test' });
  const result = await provider.authenticate({ type: 'api_key', apiKey: 'sk-test', providerId: 'openai' });
  assert.equal(result.success, true);
  assert.equal(result.providerId, 'openai');
});

test('OpenAIProvider.authenticate: 401 失败', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/models'),
      response: { status: 401, body: 'Unauthorized' },
    },
  ]);
  const provider = new OpenAIProvider({ fetchImpl, apiKey: 'sk-bad' });
  const result = await provider.authenticate({ type: 'api_key', apiKey: 'sk-bad', providerId: 'openai' });
  assert.equal(result.success, false);
  assert.equal(result.error, 'PROVIDER_AUTH_FAILED');
});

test('OpenAIProvider.chatStream: 纯文本流', async () => {
  const sseBody = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    'data: [DONE]',
    '',
  ].join('\n\n');

  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/chat/completions'),
      response: {
        status: 200,
        body: makeStream(sseBody),
        headers: { 'Content-Type': 'text/event-stream' },
      },
    },
  ]);
  const provider = new OpenAIProvider({ fetchImpl, apiKey: 'sk-test' });
  const req: ChatRequest = {
    model: 'gpt-4o',
    messages: [userMessage('hi')],
  };
  const chunks = await collect(provider.chatStream(req));

  assert.equal(chunks[0].type, 'message_start');
  assert.equal(chunks[1].type, 'text_delta');
  assert.equal((chunks[1] as { text: string }).text, 'Hello');
  assert.equal(chunks[2].type, 'text_delta');
  assert.equal((chunks[2] as { text: string }).text, ' world');
  const end = chunks[3] as { type: string; stopReason: string; tokenUsage: { inputTokens: number; outputTokens: number } };
  assert.equal(end.type, 'message_end');
  assert.equal(end.stopReason, 'end_turn');
  assert.equal(end.tokenUsage.inputTokens, 3);
  assert.equal(end.tokenUsage.outputTokens, 2);
});

test('OpenAIProvider.chatStream: tool_call 流式', async () => {
  const sseBody = [
    'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SF\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n');

  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/chat/completions'),
      response: { status: 200, body: makeStream(sseBody), headers: { 'Content-Type': 'text/event-stream' } },
    },
  ]);
  const provider = new OpenAIProvider({ fetchImpl, apiKey: 'sk-test' });
  const req: ChatRequest = {
    model: 'gpt-4o',
    messages: [userMessage('SF weather?')],
  };
  const chunks = await collect(provider.chatStream(req));

  const start = chunks.find(c => c.type === 'tool_use_start') as { id: string; name: string };
  assert.ok(start);
  assert.equal(start.id, 'call_1');
  assert.equal(start.name, 'get_weather');

  const delta = chunks.find(c => c.type === 'tool_use_delta') as { input: { city: string } };
  assert.ok(delta);
  assert.deepEqual(delta.input, { city: 'SF' });

  const end = chunks.find(c => c.type === 'message_end') as { stopReason: string };
  assert.equal(end.stopReason, 'tool_use');
});

test('OpenAIProvider.chat: 非流式文本响应', async () => {
  const respJson = {
    id: 'chatcmpl-1',
    model: 'gpt-4o',
    choices: [{
      message: { role: 'assistant', content: 'Hello!' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  };
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/chat/completions'),
      response: { status: 200, json: respJson },
    },
  ]);
  const provider = new OpenAIProvider({ fetchImpl, apiKey: 'sk-test' });
  const req: ChatRequest = {
    model: 'gpt-4o',
    messages: [userMessage('hi')],
  };
  const result = await provider.chat(req);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.message.content[0].type, 'text');
  assert.equal((result.message.content[0] as { text: string }).text, 'Hello!');
  assert.equal(result.tokenUsage.inputTokens, 5);
  assert.equal(result.tokenUsage.outputTokens, 2);
});

test('OpenAIProvider.chat: 非流式 tool_use 响应', async () => {
  const respJson = {
    id: 'chatcmpl-2',
    model: 'gpt-4o',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"SF"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/chat/completions'),
      response: { status: 200, json: respJson },
    },
  ]);
  const provider = new OpenAIProvider({ fetchImpl, apiKey: 'sk-test' });
  const req: ChatRequest = {
    model: 'gpt-4o',
    messages: [userMessage('SF weather?')],
  };
  const result = await provider.chat(req);
  assert.equal(result.stopReason, 'tool_use');
  const toolUse = result.message.content.find(b => b.type === 'tool_use') as { id: string; name: string; input: { city: string } };
  assert.ok(toolUse);
  assert.equal(toolUse.name, 'get_weather');
  assert.deepEqual(toolUse.input, { city: 'SF' });
});

test('OpenAIProvider.chat: HTTP 429 → PROVIDER_429', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/chat/completions'),
      response: { status: 429, body: 'rate limited' },
    },
  ]);
  const provider = new OpenAIProvider({
    fetchImpl,
    apiKey: 'sk-test',
    retryConfig: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
    breakerConfig: { ...DEFAULT_BREAKER_CONFIG, maxConsecutive: 100, maxTotal: 100 },
  });
  const req: ChatRequest = {
    model: 'gpt-4o',
    messages: [userMessage('hi')],
  };
  await assert.rejects(
    provider.chat(req),
    (err: { code?: string }) => err.code === 'PROVIDER_429',
  );
});

test('OpenAIProvider.chat: HTTP 500 → PROVIDER_5XX', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.endsWith('/chat/completions'),
      response: { status: 500, body: 'internal error' },
    },
  ]);
  const provider = new OpenAIProvider({
    fetchImpl,
    apiKey: 'sk-test',
    retryConfig: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
    breakerConfig: { ...DEFAULT_BREAKER_CONFIG, maxConsecutive: 100, maxTotal: 100 },
  });
  const req: ChatRequest = {
    model: 'gpt-4o',
    messages: [userMessage('hi')],
  };
  await assert.rejects(
    provider.chat(req),
    (err: { code?: string }) => err.code === 'PROVIDER_5XX',
  );
});

test('OpenAIProvider.chat: 未认证抛 PROVIDER_AUTH_FAILED', async () => {
  const fetchImpl = makeMockFetch([]);
  const provider = new OpenAIProvider({ fetchImpl });
  const req: ChatRequest = {
    model: 'gpt-4o',
    messages: [userMessage('hi')],
  };
  await assert.rejects(
    provider.chat(req),
    (err: { code?: string }) => err.code === 'PROVIDER_AUTH_FAILED',
  );
});

test('OpenAIProvider.chat: systemPromptBlocks 映射为 system 消息', async () => {
  let capturedBody: unknown;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(init.body as string) : null;
    return new Response(
      JSON.stringify({
        id: '1',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200 },
    );
  }) as FetchImpl;
  const provider = new OpenAIProvider({ fetchImpl, apiKey: 'sk-test' });
  const req: ChatRequest = {
    model: 'gpt-4o',
    messages: [userMessage('hi')],
    systemPromptBlocks: ['You are a helpful assistant.'],
  };
  await provider.chat(req);
  const body = capturedBody as { messages: Array<{ role: string; content: string }> };
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'You are a helpful assistant.');
  assert.equal(body.messages[1].role, 'user');
});

test('OpenAIProvider.countTokens: M1 stub 估算', async () => {
  const fetchImpl = makeMockFetch([]);
  const provider = new OpenAIProvider({ fetchImpl, apiKey: 'sk-test' });
  const result = await provider.countTokens([userMessage('hello world')]);
  assert.equal(result.accuracy, 'estimated');
  // 'hello world' = 11 chars → ceil(11/4) = 3 tokens
  assert.equal(result.inputTokens, 3);
});

test('OpenAIProvider.estimateCost: 价格表查询', async () => {
  const fetchImpl = makeMockFetch([]);
  const provider = new OpenAIProvider({ fetchImpl, apiKey: 'sk-test' });
  const cost = provider.estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  // openai 价格：input $2.5/M + output $10/M = $12.5
  assert.equal(cost.usd, 12.5);
  assert.ok(cost.basis);
});
