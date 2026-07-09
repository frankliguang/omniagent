import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkingMemory } from '../../src/memory/working-memory.js';
import type { Message } from '../../src/types/index.js';

function textMessage(role: Message['role'], text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

function toolUseMessage(id: string, name: string, input: Record<string, unknown>): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: id as never, name, input }],
  };
}

function toolResultMessage(toolUseId: string, content: string): Message {
  return {
    role: 'tool',
    content: [{ type: 'tool_result', tool_use_id: toolUseId as never, content: [{ type: 'text', text: content }], is_error: false }],
  };
}

test('WorkingMemory: 初始为空', () => {
  const mem = new WorkingMemory();
  assert.equal(mem.isEmpty(), true);
  assert.equal(mem.size(), 0);
  assert.deepEqual(mem.getMessages(), []);
});

test('WorkingMemory: addMessage + getMessages 全量注入', () => {
  const mem = new WorkingMemory();
  mem.addMessage(textMessage('user', 'hello'));
  mem.addMessage(textMessage('assistant', 'hi'));

  const msgs = mem.getMessages();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
});

test('WorkingMemory: getMessages 返回副本（修改不影响内部）', () => {
  const mem = new WorkingMemory();
  mem.addMessage(textMessage('user', 'hello'));
  const msgs = mem.getMessages();
  msgs.push(textMessage('user', 'injected'));
  assert.equal(mem.size(), 1, '内部消息不应被外部 push 影响');
});

test('WorkingMemory: addMessages 批量追加', () => {
  const mem = new WorkingMemory();
  mem.addMessages([
    textMessage('user', 'a'),
    textMessage('assistant', 'b'),
    textMessage('user', 'c'),
  ]);
  assert.equal(mem.size(), 3);
});

test('WorkingMemory: getRecentMessages 返回最近 N 条', () => {
  const mem = new WorkingMemory();
  for (let i = 0; i < 10; i++) {
    mem.addMessage(textMessage('user', `msg-${i}`));
  }
  const recent = mem.getRecentMessages(3);
  assert.equal(recent.length, 3);
  assert.equal((recent[0].content[0] as { text: string }).text, 'msg-7');
  assert.equal((recent[2].content[0] as { text: string }).text, 'msg-9');
});

test('WorkingMemory: getRecentMessages(0) 返回空', () => {
  const mem = new WorkingMemory();
  mem.addMessage(textMessage('user', 'a'));
  assert.deepEqual(mem.getRecentMessages(0), []);
});

test('WorkingMemory: getRecentMessages 超过总数返回全部', () => {
  const mem = new WorkingMemory();
  mem.addMessage(textMessage('user', 'a'));
  mem.addMessage(textMessage('user', 'b'));
  const recent = mem.getRecentMessages(10);
  assert.equal(recent.length, 2);
});

test('WorkingMemory: getMessagesByRole 按角色筛选', () => {
  const mem = new WorkingMemory();
  mem.addMessage(textMessage('user', 'u1'));
  mem.addMessage(textMessage('assistant', 'a1'));
  mem.addMessage(textMessage('user', 'u2'));
  const userMsgs = mem.getMessagesByRole('user');
  assert.equal(userMsgs.length, 2);
  const assistantMsgs = mem.getMessagesByRole('assistant');
  assert.equal(assistantMsgs.length, 1);
});

test('WorkingMemory: getLastMessage 返回最后一条', () => {
  const mem = new WorkingMemory();
  mem.addMessage(textMessage('user', 'a'));
  mem.addMessage(textMessage('assistant', 'b'));
  const last = mem.getLastMessage();
  assert.equal(last?.role, 'assistant');
});

test('WorkingMemory: getLastMessage 空时返回 undefined', () => {
  const mem = new WorkingMemory();
  assert.equal(mem.getLastMessage(), undefined);
});

test('WorkingMemory: clear 清空', () => {
  const mem = new WorkingMemory();
  mem.addMessage(textMessage('user', 'a'));
  mem.addMessage(textMessage('user', 'b'));
  mem.clear();
  assert.equal(mem.isEmpty(), true);
  assert.equal(mem.size(), 0);
});

test('WorkingMemory: addMessage 拒绝无效消息', () => {
  const mem = new WorkingMemory();
  // @ts-expect-error 测试无效 role
  assert.throws(() => mem.addMessage({ role: '', content: [] }), /role is required/);
  // @ts-expect-error 测试无效 content
  assert.throws(() => mem.addMessage({ role: 'user', content: null }), /content must be an array/);
});

test('WorkingMemory: tool_use + tool_result 全量注入', () => {
  const mem = new WorkingMemory();
  mem.addMessage(textMessage('user', 'list files'));
  mem.addMessage(toolUseMessage('call_1', 'list_files', { path: '/tmp' }));
  mem.addMessage(toolResultMessage('call_1', 'file1\nfile2'));
  mem.addMessage(textMessage('assistant', 'Found 2 files.'));

  const msgs = mem.getMessages();
  assert.equal(msgs.length, 4);
  assert.equal(msgs[1].content[0].type, 'tool_use');
  assert.equal(msgs[2].content[0].type, 'tool_result');
  assert.equal(msgs[2].role, 'tool');
});

test('WorkingMemory: estimateTokenCount 估算（4 char/token）', () => {
  const mem = new WorkingMemory();
  // 'hello world' = 11 chars → 3 tokens
  mem.addMessage(textMessage('user', 'hello world'));
  assert.equal(mem.estimateTokenCount(), 3);

  // 再加 9 chars → 20 chars total → 5 tokens
  mem.addMessage(textMessage('assistant', '123456789'));
  assert.equal(mem.estimateTokenCount(), 5);
});

test('WorkingMemory: getCreatedAt 返回创建时间', () => {
  const before = Date.now();
  const mem = new WorkingMemory();
  const after = Date.now();
  assert.ok(mem.getCreatedAt() >= before);
  assert.ok(mem.getCreatedAt() <= after);
});
