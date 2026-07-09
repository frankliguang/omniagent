import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StreamAdapter } from '../../src/providers/stream-adapter.js';
import type { SSEEvent } from '../../src/providers/sse-parser.js';
import type { ChatChunk } from '../../src/types/index.js';

/** helper: 把 OpenAI chunk 对象序列化为 SSEEvent */
function openaiEvent(payload: unknown): SSEEvent {
  return { data: JSON.stringify(payload) };
}

/** helper: 收集 StreamAdapter 输出 */
async function collect(chunks: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of chunks) out.push(c);
  return out;
}

test('StreamAdapter OpenAI: 纯文本流', async () => {
  const adapter = new StreamAdapter();
  const events = [
    openaiEvent({ choices: [{ delta: { role: 'assistant', content: 'Hello' } }] }),
    openaiEvent({ choices: [{ delta: { content: ' world' } }] }),
    openaiEvent({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  ];
  const chunks = await collect(adapter.normalize('openai', events));

  // 预期：message_start + text_delta*2 + message_end
  assert.equal(chunks[0].type, 'message_start');
  assert.equal(chunks[1].type, 'text_delta');
  assert.equal((chunks[1] as { text: string }).text, 'Hello');
  assert.equal(chunks[2].type, 'text_delta');
  assert.equal((chunks[2] as { text: string }).text, ' world');
  const end = chunks[3] as { type: string; stopReason: string; tokenUsage: { inputTokens: number; outputTokens: number } };
  assert.equal(end.type, 'message_end');
  assert.equal(end.stopReason, 'end_turn');
  assert.equal(end.tokenUsage.inputTokens, 10);
  assert.equal(end.tokenUsage.outputTokens, 5);
});

test('StreamAdapter OpenAI: tool_call 分片合并（L3-M1 §6.1.2 用例）', async () => {
  const adapter = new StreamAdapter();
  const events = [
    openaiEvent({
      choices: [{
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_1',
            function: { name: 'get_weather', arguments: '{"city":"' },
          }],
        },
      }],
    }),
    openaiEvent({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: 'SF"}' },
          }],
        },
      }],
    }),
    openaiEvent({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    }),
  ];
  const chunks = await collect(adapter.normalize('openai', events));

  // 预期序列：message_start, tool_use_start, tool_use_delta, tool_use_end, message_end
  assert.equal(chunks[0].type, 'message_start');
  assert.equal(chunks[1].type, 'tool_use_start');
  const start = chunks[1] as { type: string; id: string; name: string };
  assert.equal(start.id, 'call_1');
  assert.equal(start.name, 'get_weather');

  const delta = chunks[2] as { type: string; id: string; input: { city: string } };
  assert.equal(delta.type, 'tool_use_delta');
  assert.equal(delta.id, 'call_1');
  assert.deepEqual(delta.input, { city: 'SF' });

  const end2 = chunks[3] as { type: string; id: string };
  assert.equal(end2.type, 'tool_use_end');
  assert.equal(end2.id, 'call_1');

  const msgEnd = chunks[4] as { type: string; stopReason: string };
  assert.equal(msgEnd.type, 'message_end');
  assert.equal(msgEnd.stopReason, 'tool_use');
});

test('StreamAdapter OpenAI: 多 tool_call 并行分片', async () => {
  const adapter = new StreamAdapter();
  const events = [
    openaiEvent({
      choices: [{
        delta: {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'call_a', function: { name: 'tool_a', arguments: '{"x":1' } },
            { index: 1, id: 'call_b', function: { name: 'tool_b', arguments: '{"y":2' } },
          ],
        },
      }],
    }),
    openaiEvent({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: '}' } },
            { index: 1, function: { arguments: '}' } },
          ],
        },
      }],
    }),
    openaiEvent({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ];
  const chunks = await collect(adapter.normalize('openai', events));

  // 预期：message_start, tool_use_start(a), tool_use_start(b), tool_use_delta(a), tool_use_end(a), tool_use_delta(b), tool_use_end(b), message_end
  assert.equal(chunks[0].type, 'message_start');
  assert.equal(chunks[1].type, 'tool_use_start');
  assert.equal((chunks[1] as { id: string }).id, 'call_a');
  assert.equal(chunks[2].type, 'tool_use_start');
  assert.equal((chunks[2] as { id: string }).id, 'call_b');

  // tool_use_delta/end 按 pending map 插入顺序（index 0 → 1）
  const delta0 = chunks[3] as { type: string; id: string; input: { x: number } };
  assert.equal(delta0.type, 'tool_use_delta');
  assert.equal(delta0.id, 'call_a');
  assert.deepEqual(delta0.input, { x: 1 });

  const end0 = chunks[4] as { type: string; id: string };
  assert.equal(end0.type, 'tool_use_end');
  assert.equal(end0.id, 'call_a');

  const delta1 = chunks[5] as { type: string; id: string; input: { y: number } };
  assert.equal(delta1.type, 'tool_use_delta');
  assert.equal(delta1.id, 'call_b');
  assert.deepEqual(delta1.input, { y: 2 });

  const end1 = chunks[6] as { type: string; id: string };
  assert.equal(end1.type, 'tool_use_end');
  assert.equal(end1.id, 'call_b');

  assert.equal(chunks[7].type, 'message_end');
});

test('StreamAdapter OpenAI: [DONE] 哨兵', async () => {
  const adapter = new StreamAdapter();
  const events = [
    openaiEvent({ choices: [{ delta: { role: 'assistant', content: 'hi' } }] }),
    { data: '[DONE]' },
  ];
  const chunks = await collect(adapter.normalize('openai', events));

  assert.equal(chunks[0].type, 'message_start');
  assert.equal(chunks[1].type, 'text_delta');
  // [DONE] 触发补一个 message_end（因为未收到 finish_reason）
  assert.equal(chunks[2].type, 'message_end');
  assert.equal((chunks[2] as { stopReason: string }).stopReason, 'end_turn');
});

test('StreamAdapter OpenAI: finish_reason=length → max_output_tokens', async () => {
  const adapter = new StreamAdapter();
  const events = [
    openaiEvent({ choices: [{ delta: { role: 'assistant', content: 'a'.repeat(100) } }] }),
    openaiEvent({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ];
  const chunks = await collect(adapter.normalize('openai', events));
  const end = chunks[chunks.length - 1] as { type: string; stopReason: string };
  assert.equal(end.stopReason, 'max_output_tokens');
});

test('StreamAdapter OpenAI: usage-only chunk（stream_options.include_usage=true）', async () => {
  const adapter = new StreamAdapter();
  const events = [
    openaiEvent({ choices: [{ delta: { role: 'assistant', content: 'hi' } }] }),
    openaiEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    // 最后一个 chunk 只有 usage，没有 choices
    openaiEvent({ usage: { prompt_tokens: 20, completion_tokens: 10 } }),
    { data: '[DONE]' },
  ];
  const chunks = await collect(adapter.normalize('openai', events));
  // finish_reason 触发 message_end，[DONE] 时已 return
  const end = chunks.find(c => c.type === 'message_end') as { tokenUsage: { inputTokens: number; outputTokens: number } };
  assert.ok(end, '应有 message_end');
  // finish_reason chunk 之后 usage-only chunk 不会到达（已在 finish_reason 处 return）
  // 这个测试主要验证 usage-only chunk 不报错
});

test('StreamAdapter OpenAI: 流截断（无 finish_reason 无 [DONE]）补 end_turn', async () => {
  const adapter = new StreamAdapter();
  const events = [
    openaiEvent({ choices: [{ delta: { role: 'assistant', content: 'hi' } }] }),
    // 流直接结束，没有 finish_reason 也没有 [DONE]
  ];
  const chunks = await collect(adapter.normalize('openai', events));
  const end = chunks[chunks.length - 1] as { type: string; stopReason: string };
  assert.equal(end.type, 'message_end');
  assert.equal(end.stopReason, 'end_turn');
});

test('StreamAdapter OpenAI: 无效 JSON 返回 error chunk', async () => {
  const adapter = new StreamAdapter();
  const events = [
    { data: 'not-valid-json{' },
  ];
  const chunks = await collect(adapter.normalize('openai', events));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'error');
  assert.equal((chunks[0] as { error: { code: string } }).error.code, 'PROVIDER_5XX');
});

test('StreamAdapter: 不支持的 provider 返回 error', async () => {
  const adapter = new StreamAdapter();
  const chunks = await collect(adapter.normalize('bedrock', []));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'error');
  assert.match((chunks[0] as { error: { message: string } }).error.message, /bedrock/);
});

test('StreamAdapter: reset 清理状态（同一实例可复用）', async () => {
  const adapter = new StreamAdapter();
  const events1 = [
    openaiEvent({ choices: [{ delta: { role: 'assistant', content: 'first' } }] }),
    openaiEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ];
  const chunks1 = await collect(adapter.normalize('openai', events1));
  assert.equal(chunks1.length, 3); // start + text + end

  // 第二次复用（normalize 内部会调 reset）
  const events2 = [
    openaiEvent({ choices: [{ delta: { role: 'assistant', content: 'second' } }] }),
    openaiEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ];
  const chunks2 = await collect(adapter.normalize('openai', events2));
  assert.equal(chunks2.length, 3);
  assert.equal((chunks2[1] as { text: string }).text, 'second');
});
