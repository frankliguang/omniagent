import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolUsePairGuard } from '../../src/core/pairing-guard.js';
import type { Message, ToolResult } from '../../src/types/index.js';

function makeAssistant( toolUses: { id: string; name: string }[]): Message {
  return {
    role: 'assistant',
    content: toolUses.map(tu => ({
      type: 'tool_use' as const,
      id: tu.id as never,
      name: tu.name,
      input: {},
    })),
  };
}

function makeToolMessage( results: { id: string; isError?: boolean }[]): Message {
  return {
    role: 'tool',
    content: results.map(r => ({
      type: 'tool_result' as const,
      tool_use_id: r.id as never,
      content: [{ type: 'text' as const, text: 'result' }],
      is_error: r.isError ?? false,
    })),
  };
}

test('ToolUsePairGuard: 正常配对（1 tool_use + 1 tool_result）', () => {
  const guard = new ToolUsePairGuard();
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'do x' }] },
    makeAssistant([{ id: 'tu_1', name: 'read_file' }]),
    makeToolMessage([{ id: 'tu_1' }]),
  ];
  const result = guard.checkAllToolUsesPaired(messages);
  assert.equal(result.ok, true);
  assert.equal(result.orphanToolUseIds.length, 0);
  assert.equal(result.orphanToolResultIds.length, 0);
});

test('ToolUsePairGuard: 多对配对', () => {
  const guard = new ToolUsePairGuard();
  const messages: Message[] = [
    makeAssistant([
      { id: 'tu_1', name: 'read_file' },
      { id: 'tu_2', name: 'edit_file' },
      { id: 'tu_3', name: 'grep' },
    ]),
    makeToolMessage([
      { id: 'tu_1' },
      { id: 'tu_2' },
      { id: 'tu_3' },
    ]),
  ];
  const result = guard.checkAllToolUsesPaired(messages);
  assert.equal(result.ok, true);
});

test('ToolUsePairGuard: orphan tool_result（无配对 tool_use）', () => {
  const guard = new ToolUsePairGuard();
  const messages: Message[] = [
    makeAssistant([{ id: 'tu_1', name: 'read_file' }]),
    makeToolMessage([
      { id: 'tu_1' },
      { id: 'tu_orphan' },  // 无配对 tool_use
    ]),
  ];
  const result = guard.checkAllToolUsesPaired(messages);
  assert.equal(result.ok, false);
  assert.equal(result.orphanToolResultIds.length, 1);
  assert.ok(result.orphanToolResultIds.includes('tu_orphan' as never));
  assert.match(result.error ?? '', /orphan tool_result/);
});

test('ToolUsePairGuard: orphan tool_use（无配对 tool_result）', () => {
  const guard = new ToolUsePairGuard();
  const messages: Message[] = [
    makeAssistant([
      { id: 'tu_1', name: 'read_file' },
      { id: 'tu_orphan', name: 'edit_file' },  // 无 tool_result
    ]),
    makeToolMessage([{ id: 'tu_1' }]),
  ];
  const result = guard.checkAllToolUsesPaired(messages);
  assert.equal(result.ok, false);
  assert.equal(result.orphanToolUseIds.length, 1);
  assert.ok(result.orphanToolUseIds.includes('tu_orphan' as never));
  assert.match(result.error ?? '', /orphan tool_use/);
});

test('ToolUsePairGuard: 单 tool_result 配对检查', () => {
  const guard = new ToolUsePairGuard();
  const messages: Message[] = [
    makeAssistant([{ id: 'tu_1', name: 'read_file' }]),
  ];
  const result: ToolResult = {
    tool_use_id: 'tu_1' as never,
    content: [{ type: 'text', text: 'ok' }],
    is_error: false,
    metadata: { duration_ms: 0 },
  };
  assert.equal(guard.checkToolResultHasPairing(result, messages), true);

  const orphanResult: ToolResult = {
    tool_use_id: 'tu_missing' as never,
    content: [{ type: 'text', text: 'ok' }],
    is_error: false,
    metadata: { duration_ms: 0 },
  };
  assert.equal(guard.checkToolResultHasPairing(orphanResult, messages), false);
});

test('ToolUsePairGuard: extractToolUses 提取 tool_use 块', () => {
  const guard = new ToolUsePairGuard();
  const msg: Message = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I will read the file.' },
      { type: 'tool_use', id: 'tu_1' as never, name: 'read_file', input: { file_path: '/x' } },
      { type: 'tool_use', id: 'tu_2' as never, name: 'grep', input: { pattern: 'foo' } },
    ],
  };
  const toolUses = guard.extractToolUses(msg);
  assert.equal(toolUses.length, 2);
  assert.equal(toolUses[0].name, 'read_file');
  assert.equal(toolUses[1].name, 'grep');
});

test('ToolUsePairGuard: 无 tool_use 的 message 返回空', () => {
  const guard = new ToolUsePairGuard();
  const msg: Message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'just text' }],
  };
  const toolUses = guard.extractToolUses(msg);
  assert.equal(toolUses.length, 0);
});
