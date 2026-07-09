import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BedrockProvider } from '../../src/providers/bedrock.js';
import { signSigV4, type SigV4Credentials, type SigV4Request, type SigV4SignResult } from '../../src/providers/bedrock-sigv4.js';
import { BedrockEventStreamParser } from '../../src/providers/bedrock-event-stream.js';
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

function makeBinaryStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface MockResponse {
  status?: number;
  body?: string | ReadableStream<Uint8Array> | Uint8Array;
  headers?: Record<string, string>;
  json?: unknown;
}

function makeMockFetch(responses: Array<{ match: (url: string, init?: RequestInit) => boolean; response: MockResponse }>): FetchImpl {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const { match, response } of responses) {
      if (match(urlStr, init)) {
        let bodyStream: ReadableStream<Uint8Array>;
        if (response.body instanceof Uint8Array) {
          bodyStream = makeBinaryStream(response.body);
        } else if (typeof response.body === 'string') {
          bodyStream = makeStream(response.body);
        } else if (response.body instanceof ReadableStream) {
          bodyStream = response.body;
        } else if (response.json !== undefined) {
          bodyStream = makeStream(JSON.stringify(response.json));
        } else {
          bodyStream = makeStream('');
        }
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

test('BedrockProvider.authenticate: 有效凭证成功', async () => {
  const provider = new BedrockProvider({
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+GbJEfUeXPbHkQEXAMPLE',
  });
  const result = await provider.authenticate({
    type: 'api_key',
    apiKey: 'AKIDEXAMPLE:wJalrXUtnFEMI/K7MDENG+GbJEfUeXPbHkQEXAMPLE',
    providerId: 'bedrock',
  });
  assert.equal(result.success, true);
  assert.equal(result.providerId, 'bedrock');
});

test('BedrockProvider.authenticate: 凭证格式错误失败', async () => {
  const provider = new BedrockProvider();
  const result = await provider.authenticate({
    type: 'api_key',
    apiKey: 'just-api-key-no-colon',
    providerId: 'bedrock',
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'PROVIDER_AUTH_FAILED');
  assert.match(result.errorMessage ?? '', /accessKeyId:secretAccessKey/);
});

test('BedrockProvider.authenticate: oauth 凭证拒绝', async () => {
  const provider = new BedrockProvider();
  const result = await provider.authenticate({
    type: 'oauth',
    accessToken: 'token',
    expiresAt: '2026-12-31T00:00:00Z' as never,
    providerId: 'bedrock',
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'PROVIDER_AUTH_FAILED');
});

test('BedrockProvider.authenticate: 含 sessionToken 的临时凭证', async () => {
  const provider = new BedrockProvider();
  const result = await provider.authenticate({
    type: 'api_key',
    apiKey: 'AKID:secret:session-token-123',
    providerId: 'bedrock',
  });
  assert.equal(result.success, true);
});

test('BedrockProvider.authenticate: 空 accessKeyId 失败', async () => {
  const provider = new BedrockProvider();
  const result = await provider.authenticate({
    type: 'api_key',
    apiKey: ':secret-only',
    providerId: 'bedrock',
  });
  assert.equal(result.success, false);
});

// ============================================================
// chat（非流式）
// ============================================================

test('BedrockProvider.chat: 纯文本响应', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.includes('/invoke'),
      response: {
        status: 200,
        json: {
          id: 'msg_b1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello from Bedrock' }],
          model: 'anthropic.claude-3-5-sonnet-20241022-v1:0',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    },
  ]);
  const provider = new BedrockProvider({
    fetchImpl,
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  });
  await provider.authenticate({
    type: 'api_key',
    apiKey: 'AKID:secret',
    providerId: 'bedrock',
  });

  const req: ChatRequest = {
    model: 'anthropic.claude-3-5-sonnet-20241022-v1:0',
    messages: [userMessage('hi')],
  };
  const resp = await provider.chat(req);
  assert.equal(resp.stopReason, 'end_turn');
  assert.equal(resp.tokenUsage.inputTokens, 10);
  assert.equal(resp.tokenUsage.outputTokens, 5);
  const textBlock = resp.message.content.find(b => b.type === 'text');
  assert.ok(textBlock);
  assert.equal((textBlock as { text: string }).text, 'Hello from Bedrock');
});

test('BedrockProvider.chat: tool_use 响应', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.includes('/invoke'),
      response: {
        status: 200,
        json: {
          content: [
            { type: 'text', text: 'Checking' },
            { type: 'tool_use', id: 'toolu_b1', name: 'get_weather', input: { city: 'SF' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 15 },
        },
      },
    },
  ]);
  const provider = new BedrockProvider({
    fetchImpl,
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  });
  await provider.authenticate({
    type: 'api_key',
    apiKey: 'AKID:secret',
    providerId: 'bedrock',
  });

  const req: ChatRequest = {
    model: 'anthropic.claude-3-haiku-20240307-v1:0',
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

test('BedrockProvider.chat: 401 → PROVIDER_AUTH_FAILED', async () => {
  const fetchImpl = makeMockFetch([
    { match: (url) => url.includes('/invoke'), response: { status: 403, body: 'forbidden' } },
  ]);
  const provider = new BedrockProvider({
    fetchImpl,
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
    breakerConfig: { ...DEFAULT_BREAKER_CONFIG, maxConsecutive: 100 },
  });
  await provider.authenticate({ type: 'api_key', apiKey: 'AKID:secret', providerId: 'bedrock' });
  await assert.rejects(
    () => provider.chat({ model: 'anthropic.claude-3-5-sonnet-20241022-v1:0', messages: [userMessage('hi')] }),
    (err: { code?: string }) => err.code === 'PROVIDER_AUTH_FAILED',
  );
});

test('BedrockProvider.chat: 500 → PROVIDER_5XX', async () => {
  const fetchImpl = makeMockFetch([
    { match: (url) => url.includes('/invoke'), response: { status: 500, body: 'server error' } },
  ]);
  const provider = new BedrockProvider({
    fetchImpl,
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
    breakerConfig: { ...DEFAULT_BREAKER_CONFIG, maxConsecutive: 100 },
  });
  await provider.authenticate({ type: 'api_key', apiKey: 'AKID:secret', providerId: 'bedrock' });
  await assert.rejects(
    () => provider.chat({ model: 'anthropic.claude-3-5-sonnet-20241022-v1:0', messages: [userMessage('hi')] }),
    (err: { code?: string }) => err.code === 'PROVIDER_5XX',
  );
});

test('BedrockProvider.chat: 未认证抛错', async () => {
  const provider = new BedrockProvider();
  await assert.rejects(
    () => provider.chat({ model: 'anthropic.claude-3-5-sonnet-20241022-v1:0', messages: [userMessage('hi')] }),
    (err: { code?: string }) => err.code === 'PROVIDER_AUTH_FAILED',
  );
});

// ============================================================
// chatStream（EventStream 二进制流）
// ============================================================

/** 构造 Bedrock EventStream chunk 事件帧（payload.bytes base64 编码 JSON） */
function makeChunkFrame(payloadJson: unknown): Uint8Array {
  // Bedrock 把 Anthropic 事件包在 { bytes: base64(JSON) } 里
  const jsonStr = JSON.stringify(payloadJson);
  const base64Str = Buffer.from(jsonStr, 'utf8').toString('base64');
  const wrapper = { bytes: base64Str };

  // 构造 EventStream 帧
  const parser = new BedrockEventStreamParser();
  // 反向构造：用 makeFrame 风格
  const headers: Array<[string, number, Uint8Array]> = [
    [':event-type', 1, new TextEncoder().encode('chunk')],
    [':message-type', 1, new TextEncoder().encode('event')],
    [':content-type', 1, new TextEncoder().encode('application/json')],
  ];
  let headersBytes = new Uint8Array(0);
  for (const [name, valueType, value] of headers) {
    const nameBytes = new TextEncoder().encode(name);
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + value.length);
    let offset = 0;
    part[offset++] = nameBytes.length;
    part.set(nameBytes, offset);
    offset += nameBytes.length;
    part[offset++] = valueType;
    part[offset++] = (value.length >> 8) & 0xff;
    part[offset++] = value.length & 0xff;
    part.set(value, offset);
    const newHeaders = new Uint8Array(headersBytes.length + part.length);
    newHeaders.set(headersBytes, 0);
    newHeaders.set(part, headersBytes.length);
    headersBytes = newHeaders;
  }
  const payloadBytes = new TextEncoder().encode(JSON.stringify(wrapper));
  const totalLength = 8 + headersBytes.length + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLength);
  let offset = 0;
  frame[offset++] = (totalLength >> 24) & 0xff;
  frame[offset++] = (totalLength >> 16) & 0xff;
  frame[offset++] = (totalLength >> 8) & 0xff;
  frame[offset++] = totalLength & 0xff;
  frame[offset++] = (headersBytes.length >> 24) & 0xff;
  frame[offset++] = (headersBytes.length >> 16) & 0xff;
  frame[offset++] = (headersBytes.length >> 8) & 0xff;
  frame[offset++] = headersBytes.length & 0xff;
  frame.set(headersBytes, offset);
  offset += headersBytes.length;
  frame.set(payloadBytes, offset);
  void parser; // unused
  return frame;
}

test('BedrockProvider.chatStream: 纯文本流', async () => {
  const frames = [
    makeChunkFrame({ type: 'message_start', message: { id: 'msg_s1', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } }),
    makeChunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    makeChunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    makeChunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } }),
    makeChunkFrame({ type: 'content_block_stop', index: 0 }),
    makeChunkFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    makeChunkFrame({ type: 'message_stop' }),
  ];
  const combined = new Uint8Array(frames.reduce((sum, f) => sum + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    combined.set(f, offset);
    offset += f.length;
  }

  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.includes('/invoke-with-response-stream'),
      response: { status: 200, body: combined },
    },
  ]);
  const provider = new BedrockProvider({
    fetchImpl,
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  });
  await provider.authenticate({ type: 'api_key', apiKey: 'AKID:secret', providerId: 'bedrock' });

  const req: ChatRequest = {
    model: 'anthropic.claude-3-5-sonnet-20241022-v1:0',
    messages: [userMessage('hi')],
  };
  const chunks = await collect(provider.chatStream(req));

  assert.ok(chunks.some(c => c.type === 'message_start'));
  const textDeltas = chunks.filter(c => c.type === 'text_delta') as Array<{ type: 'text_delta'; text: string }>;
  assert.equal(textDeltas.length, 2);
  assert.equal(textDeltas[0].text, 'Hello');
  assert.equal(textDeltas[1].text, ' world');
  const end = chunks.find(c => c.type === 'message_end') as { stopReason: string } | undefined;
  assert.ok(end);
  assert.equal(end?.stopReason, 'end_turn');
});

test('BedrockProvider.chatStream: tool_use 流', async () => {
  const frames = [
    makeChunkFrame({ type: 'message_start', message: { id: 'msg_s2', role: 'assistant', content: [], usage: { input_tokens: 5 } } }),
    makeChunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_b2', name: 'get_weather', input: {} } }),
    makeChunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"' } }),
    makeChunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'SF"}' } }),
    makeChunkFrame({ type: 'content_block_stop', index: 0 }),
    makeChunkFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }),
    makeChunkFrame({ type: 'message_stop' }),
  ];
  const combined = new Uint8Array(frames.reduce((sum, f) => sum + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    combined.set(f, offset);
    offset += f.length;
  }

  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.includes('/invoke-with-response-stream'),
      response: { status: 200, body: combined },
    },
  ]);
  const provider = new BedrockProvider({
    fetchImpl,
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  });
  await provider.authenticate({ type: 'api_key', apiKey: 'AKID:secret', providerId: 'bedrock' });

  const req: ChatRequest = {
    model: 'anthropic.claude-3-5-sonnet-20241022-v1:0',
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

  const start = chunks.find(c => c.type === 'tool_use_start');
  assert.ok(start, '应有 tool_use_start');
  assert.equal((start as { name: string }).name, 'get_weather');

  const delta = chunks.find(c => c.type === 'tool_use_delta') as { input: Record<string, unknown> } | undefined;
  assert.ok(delta);
  assert.deepEqual(delta?.input, { city: 'SF' });

  const end = chunks.find(c => c.type === 'tool_use_end');
  assert.ok(end, '应有 tool_use_end');

  const msgEnd = chunks.find(c => c.type === 'message_end') as { stopReason: string } | undefined;
  assert.equal(msgEnd?.stopReason, 'tool_use');
});

test('BedrockProvider.chatStream: 未认证抛错', async () => {
  const provider = new BedrockProvider();
  await assert.rejects(
    () => collect(provider.chatStream({ model: 'anthropic.claude-3-5-sonnet-20241022-v1:0', messages: [userMessage('hi')] })),
    (err: { code?: string }) => err.code === 'PROVIDER_AUTH_FAILED',
  );
});

// ============================================================
// SigV4 签名注入（用于测试调用方确实传了 Authorization header）
// ============================================================

test('BedrockProvider.chat: 调用方注入 Authorization header', async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 });
  }) as FetchImpl;

  const provider = new BedrockProvider({
    fetchImpl,
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  });
  await provider.authenticate({ type: 'api_key', apiKey: 'AKID:secret', providerId: 'bedrock' });
  await provider.chat({ model: 'anthropic.claude-3-5-sonnet-20241022-v1:0', messages: [userMessage('hi')] });

  const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
  assert.ok(headers.authorization, '应有 authorization header');
  assert.match(headers.authorization, /AWS4-HMAC-SHA256/);
  assert.ok(headers['x-amz-date'], '应有 x-amz-date header');
  assert.equal(headers['x-amz-content-sha256'] !== undefined, true);
});

test('BedrockProvider: 自定义 region', async () => {
  let capturedUrl = '';
  const fetchImpl = (async (url: string | URL | Request) => {
    capturedUrl = typeof url === 'string' ? url : url.toString();
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 });
  }) as FetchImpl;

  const provider = new BedrockProvider({
    fetchImpl,
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
    region: 'eu-west-1',
  });
  await provider.authenticate({ type: 'api_key', apiKey: 'AKID:secret', providerId: 'bedrock' });
  await provider.chat({ model: 'anthropic.claude-3-5-sonnet-20241022-v1:0', messages: [userMessage('hi')] });
  assert.match(capturedUrl, /bedrock-runtime\.eu-west-1\.amazonaws\.com/);
});

// ============================================================
// 自定义 signer 注入（测试可注入性）
// ============================================================

test('BedrockProvider: 自定义 signer 被调用', async () => {
  let signerCalled = false;
  const customSigner = (creds: SigV4Credentials, region: string, req: SigV4Request): SigV4SignResult => {
    signerCalled = true;
    // 调用真实 signer 确保格式合法
    return signSigV4(creds, region, req);
  };

  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.includes('/invoke'),
      response: {
        status: 200,
        json: {
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    },
  ]);
  const provider = new BedrockProvider({
    fetchImpl,
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
    signer: customSigner,
  });
  await provider.authenticate({ type: 'api_key', apiKey: 'AKID:secret', providerId: 'bedrock' });
  await provider.chat({ model: 'anthropic.claude-3-5-sonnet-20241022-v1:0', messages: [userMessage('hi')] });
  assert.ok(signerCalled, '自定义 signer 应被调用');
});

// ============================================================
// countTokens + estimateCost
// ============================================================

test('BedrockProvider.countTokens: 4 字符/token 估算', async () => {
  const provider = new BedrockProvider({
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  });
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'a'.repeat(40) }] },
  ];
  const count = await provider.countTokens(msgs);
  assert.equal(count.inputTokens, 10);
  assert.equal(count.accuracy, 'estimated');
});

test('BedrockProvider.estimateCost: bedrock 价格表注册', () => {
  const provider = new BedrockProvider({
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  });
  const cost = provider.estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  // bedrock fallback: $0.25 input + $1.25 output = $1.5
  assert.ok(cost.usd > 0);
});

// ============================================================
// Capabilities
// ============================================================

test('BedrockProvider.capabilities: 字段正确', () => {
  const provider = new BedrockProvider();
  assert.equal(provider.id, 'bedrock');
  assert.equal(provider.displayName, 'AWS Bedrock');
  assert.equal(provider.capabilities.supportsStreaming, true);
  assert.equal(provider.capabilities.supportsToolCalling, true);
  assert.equal(provider.capabilities.supportsPromptCaching, true);
  assert.equal(provider.capabilities.supportsRiskClassification, false);
  assert.ok(provider.capabilities.maxContextWindow >= 200_000);
});
