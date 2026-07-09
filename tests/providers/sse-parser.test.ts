import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SSEParser } from '../../src/providers/sse-parser.js';

test('SSEParser: 单事件完整解析', () => {
  const parser = new SSEParser();
  const events = parser.feed('event: message\ndata: {"text":"hello"}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'message');
  assert.equal(events[0].data, '{"text":"hello"}');
});

test('SSEParser: 多事件一次 feed', () => {
  const parser = new SSEParser();
  const events = parser.feed(
    'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'a');
  assert.equal(events[0].data, '1');
  assert.equal(events[1].event, 'b');
  assert.equal(events[1].data, '2');
});

test('SSEParser: 跨 chunk 缓冲（事件被切分到多个 chunk）', () => {
  const parser = new SSEParser();
  // 第一个 chunk 不完整（无 \n\n 终止）
  const ev1 = parser.feed('event: message\ndata: {"text":"hel');
  assert.equal(ev1.length, 0, '不完整事件应留在 buffer，不产出');

  // 第二个 chunk 补完
  const ev2 = parser.feed('lo"}\n\n');
  assert.equal(ev2.length, 1);
  assert.equal(ev2[0].event, 'message');
  assert.equal(ev2[0].data, '{"text":"hello"}');
});

test('SSEParser: data 多行拼接', () => {
  const parser = new SSEParser();
  const events = parser.feed('data: line1\ndata: line2\ndata: line3\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, 'line1\nline2\nline3');
});

test('SSEParser: 注释行与空行跳过', () => {
  const parser = new SSEParser();
  const events = parser.feed(': heartbeat\n\nevent: ping\ndata: 1\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'ping');
  assert.equal(events[0].data, '1');
});

test('SSEParser: id 与 retry 字段', () => {
  const parser = new SSEParser();
  const events = parser.feed('id: 42\nretry: 5000\ndata: hello\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].id, '42');
  assert.equal(events[0].retry, 5000);
  assert.equal(events[0].data, 'hello');
});

test('SSEParser: flush 返回 buffer 剩余事件', () => {
  const parser = new SSEParser();
  // 喂入无 \n\n 结尾的事件
  parser.feed('event: end\ndata: trailing');
  const flushed = parser.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].event, 'end');
  assert.equal(flushed[0].data, 'trailing');
});

test('SSEParser: flush 空缓冲返回空数组', () => {
  const parser = new SSEParser();
  const flushed = parser.flush();
  assert.equal(flushed.length, 0);
});

test('SSEParser: reset 清空缓冲', () => {
  const parser = new SSEParser();
  parser.feed('event: a\ndata: 1');
  parser.reset();
  const flushed = parser.flush();
  assert.equal(flushed.length, 0);
});

test('SSEParser: Uint8Array 输入（Web Streams API 兼容）', () => {
  const parser = new SSEParser();
  const encoder = new TextEncoder();
  const bytes = encoder.encode('data: hello\n\n');
  const events = parser.feed(bytes);
  assert.equal(events.length, 1);
  assert.equal(events[0].data, 'hello');
});

test('SSEParser: CRLF 行尾（\\r\\n）兼容', () => {
  const parser = new SSEParser();
  const events = parser.feed('event: msg\r\ndata: hi\r\n\r\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'msg');
  assert.equal(events[0].data, 'hi');
});
