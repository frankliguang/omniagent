import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BedrockEventStreamParser } from '../../src/providers/bedrock-event-stream.js';

// ============================================================
// 帧构造辅助（生成 Bedrock EventStream 二进制帧）
// ============================================================

/** 构造一个 Bedrock EventStream frame */
function makeFrame(
  eventType: string,
  payloadJson: unknown,
  messageType: string = 'event',
): Uint8Array {
  const headers: Array<[string, number, Uint8Array]> = [];
  // :event-type
  headers.push([':event-type', 1, new TextEncoder().encode(eventType)]);
  // :message-type
  headers.push([':message-type', 1, new TextEncoder().encode(messageType)]);
  // :content-type
  headers.push([':content-type', 1, new TextEncoder().encode('application/json')]);

  // 编码 headers
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

  const payloadStr = JSON.stringify(payloadJson);
  const payloadBytes = new TextEncoder().encode(payloadStr);

  // total-length = 4 + 4 + headers.length + payload.length + 4 (CRC)
  const totalLength = 8 + headersBytes.length + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLength);
  let offset = 0;
  // total-length (BE uint32)
  frame[offset++] = (totalLength >> 24) & 0xff;
  frame[offset++] = (totalLength >> 16) & 0xff;
  frame[offset++] = (totalLength >> 8) & 0xff;
  frame[offset++] = totalLength & 0xff;
  // headers-length (BE uint32)
  frame[offset++] = (headersBytes.length >> 24) & 0xff;
  frame[offset++] = (headersBytes.length >> 16) & 0xff;
  frame[offset++] = (headersBytes.length >> 8) & 0xff;
  frame[offset++] = headersBytes.length & 0xff;
  // headers
  frame.set(headersBytes, offset);
  offset += headersBytes.length;
  // payload
  frame.set(payloadBytes, offset);
  offset += payloadBytes.length;
  // CRC32 (用 0 占位，解析器不校验 CRC)
  frame[offset++] = 0;
  frame[offset++] = 0;
  frame[offset++] = 0;
  frame[offset++] = 0;
  return frame;
}

// ============================================================
// 解析
// ============================================================

test('BedrockEventStreamParser: 单帧解析', () => {
  const parser = new BedrockEventStreamParser();
  const frame = makeFrame('chunk', { type: 'message_start', message: { id: 'msg1' } });
  const events = parser.feed(frame);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'chunk');
  assert.equal(events[0].messageType, 'event');
  assert.deepEqual(events[0].payload, { type: 'message_start', message: { id: 'msg1' } });
});

test('BedrockEventStreamParser: 多帧一次性 feed', () => {
  const parser = new BedrockEventStreamParser();
  const f1 = makeFrame('chunk', { type: 'message_start' });
  const f2 = makeFrame('chunk', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } });
  const f3 = makeFrame('chunk', { type: 'message_stop' });
  const combined = new Uint8Array(f1.length + f2.length + f3.length);
  combined.set(f1, 0);
  combined.set(f2, f1.length);
  combined.set(f3, f1.length + f2.length);
  const events = parser.feed(combined);
  assert.equal(events.length, 3);
  assert.equal(events[0].payload.type, 'message_start');
  assert.equal(events[1].payload.type, 'content_block_delta');
  assert.equal(events[2].payload.type, 'message_stop');
});

test('BedrockEventStreamParser: 分片到达（一帧拆两次 feed）', () => {
  const parser = new BedrockEventStreamParser();
  const frame = makeFrame('chunk', { type: 'text_delta', text: 'hi' });
  const half = Math.floor(frame.length / 2);
  // 第一次 feed 半帧
  const e1 = parser.feed(frame.slice(0, half));
  assert.equal(e1.length, 0, '半帧不应解析出事件');
  // 第二次 feed 剩余
  const e2 = parser.feed(frame.slice(half));
  assert.equal(e2.length, 1);
  assert.equal(e2[0].payload.type, 'text_delta');
});

test('BedrockEventStreamParser: flush 剩余 buffer', () => {
  const parser = new BedrockEventStreamParser();
  const f1 = makeFrame('chunk', { type: 'message_start' });
  const f2 = makeFrame('chunk', { type: 'message_stop' });
  const combined = new Uint8Array(f1.length + f2.length);
  combined.set(f1, 0);
  combined.set(f2, f1.length);
  // 模拟流结束前未完全到达：只 feed f1
  const e1 = parser.feed(f1);
  assert.equal(e1.length, 1);
  // 然后 flush（虽然 buffer 应已空，但验证不崩）
  const e2 = parser.flush();
  assert.equal(e2.length, 0);
});

test('BedrockEventStreamParser: 损坏帧跳过', () => {
  const parser = new BedrockEventStreamParser();
  // 损坏帧：total-length = 0xFFFFFFFF（明显异常）
  const bad = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
  const e1 = parser.feed(bad);
  assert.equal(e1.length, 0, '损坏帧应被跳过');
  // 后续正常帧仍能解析
  const f = makeFrame('chunk', { type: 'text_delta', text: 'ok' });
  const e2 = parser.feed(f);
  assert.equal(e2.length, 1);
});

test('BedrockEventStreamParser: payload 非空时 JSON 解析', () => {
  const parser = new BedrockEventStreamParser();
  const payload = { key: 'value', nested: { n: 42 }, arr: [1, 2, 3] };
  const f = makeFrame('chunk', payload);
  const events = parser.feed(f);
  assert.deepEqual(events[0].payload, payload);
});

test('BedrockEventStreamParser: 空 payload', () => {
  const parser = new BedrockEventStreamParser();
  // 构造空 payload 的帧
  const headersBytes = new TextEncoder().encode('\x0b:event-type\x01\x00\x05chunk');
  const totalLength = 8 + headersBytes.length + 0 + 4;
  const frame = new Uint8Array(totalLength);
  // total-length
  frame[0] = (totalLength >> 24) & 0xff;
  frame[1] = (totalLength >> 16) & 0xff;
  frame[2] = (totalLength >> 8) & 0xff;
  frame[3] = totalLength & 0xff;
  // headers-length
  frame[4] = (headersBytes.length >> 24) & 0xff;
  frame[5] = (headersBytes.length >> 16) & 0xff;
  frame[6] = (headersBytes.length >> 8) & 0xff;
  frame[7] = headersBytes.length & 0xff;
  frame.set(headersBytes, 8);
  const events = parser.feed(frame);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload, undefined);
});

test('BedrockEventStreamParser: 多帧分片混合', () => {
  const parser = new BedrockEventStreamParser();
  const f1 = makeFrame('chunk', { type: 'message_start' });
  const f2 = makeFrame('chunk', { type: 'text_delta', text: 'a' });
  const f3 = makeFrame('chunk', { type: 'text_delta', text: 'b' });
  const f4 = makeFrame('chunk', { type: 'message_stop' });
  // 全部拼接
  const totalLen = f1.length + f2.length + f3.length + f4.length;
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const f of [f1, f2, f3, f4]) {
    combined.set(f, offset);
    offset += f.length;
  }
  // 拆 3 段 feed
  const p1 = combined.slice(0, Math.floor(totalLen / 3));
  const p2 = combined.slice(Math.floor(totalLen / 3), Math.floor(totalLen * 2 / 3));
  const p3 = combined.slice(Math.floor(totalLen * 2 / 3));
  const e1 = parser.feed(p1);
  const e2 = parser.feed(p2);
  const e3 = parser.feed(p3);
  const allEvents = [...e1, ...e2, ...e3];
  assert.equal(allEvents.length, 4);
});
