import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AbortCoordinator } from '../../src/core/abort.js';

test('AbortCoordinator: 初始状态未 abort', () => {
  const coord = new AbortCoordinator('main' as never);
  assert.equal(coord.isAborted, false);
  assert.equal(coord.context, undefined);
  assert.equal(coord.signal.aborted, false);
});

test('AbortCoordinator: abortAll 后 signal aborted', async () => {
  const coord = new AbortCoordinator('main' as never);
  await coord.abortAll({ agentId: 'main' as never, reason: 'user', detail: 'Ctrl+C' });
  assert.equal(coord.isAborted, true);
  assert.equal(coord.signal.aborted, true);
  assert.equal(coord.context?.reason, 'user');
  assert.equal(coord.context?.detail, 'Ctrl+C');
});

test('AbortCoordinator: 幂等（重复 abort 不报错）', async () => {
  const coord = new AbortCoordinator('main' as never);
  await coord.abortAll({ agentId: 'main' as never, reason: 'user' });
  const result = await coord.abortAll({ agentId: 'main' as never, reason: 'user' });
  assert.equal(result.abortedToolUseIds.length, 0);
  assert.equal(result.discardedToolResultIds.length, 0);
});

test('AbortCoordinator: 场景 B — pending tool_result 丢弃', async () => {
  const coord = new AbortCoordinator('main' as never);
  // 标记 2 个 pending tool_result
  coord.markToolResultPending('tu_1' as never);
  coord.markToolResultPending('tu_2' as never);
  // abort
  const result = await coord.abortAll({ agentId: 'main' as never, reason: 'user' });
  assert.equal(result.discardedToolResultIds.length, 2);
  assert.ok(result.discardedToolResultIds.includes('tu_1' as never));
  assert.ok(result.discardedToolResultIds.includes('tu_2' as never));
});

test('AbortCoordinator: 场景 A — abort 后工具通过 signal 中断', async () => {
  const coord = new AbortCoordinator('main' as never);
  // 模拟工具正在执行（用 fetch + signal）
  const fetchPromise = new Promise((_, reject) => {
    coord.signal.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
  // abort
  await coord.abortAll(
    { agentId: 'main' as never, reason: 'user' },
    ['tu_inflight' as never],
  );
  // fetch 应被中断
  await assert.rejects(fetchPromise, /AbortError/);
});

test('AbortCoordinator: reset 新建 AbortController', async () => {
  const coord = new AbortCoordinator('main' as never);
  await coord.abortAll({ agentId: 'main' as never, reason: 'user' });
  assert.equal(coord.isAborted, true);
  coord.reset();
  assert.equal(coord.isAborted, false);
  assert.equal(coord.signal.aborted, false);
  assert.equal(coord.context, undefined);
});

test('AbortCoordinator: toOmniAgentError 生成 USER_INTERRUPT', async () => {
  const coord = new AbortCoordinator('main' as never);
  await coord.abortAll({ agentId: 'main' as never, reason: 'budget', detail: 'max $5 reached' });
  const err = coord.toOmniAgentError();
  assert.equal(err.code, 'USER_INTERRUPT');
  assert.equal(err.module, 'M2');
  assert.equal(err.retryable, false);
  assert.match(err.message, /budget/);
  assert.match(err.message, /max \$5 reached/);
});

test('AbortCoordinator: markToolResultPending 在 abort 后无效', async () => {
  const coord = new AbortCoordinator('main' as never);
  await coord.abortAll({ agentId: 'main' as never, reason: 'user' });
  // abort 后标记不应进 pending 队列
  coord.markToolResultPending('tu_late' as never);
  // 再次 abort 不会收到这个 id
  const result = await coord.abortAll({ agentId: 'main' as never, reason: 'user' });
  assert.ok(!result.discardedToolResultIds.includes('tu_late' as never));
});
