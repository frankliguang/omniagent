import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IterationLimiter, DEFAULT_ITERATION_LIMITS } from '../../src/core/iteration-limiter.js';

test('IterationLimiter: 默认配置', () => {
  const limiter = new IterationLimiter();
  assert.equal(limiter.snapshot('5xx').limit, DEFAULT_ITERATION_LIMITS.max5xx);
  assert.equal(limiter.snapshot('429').limit, DEFAULT_ITERATION_LIMITS.max429);
  assert.equal(limiter.snapshot('stall_passive').limit, DEFAULT_ITERATION_LIMITS.maxStallPassive);
  assert.equal(limiter.snapshot('stall_active').limit, DEFAULT_ITERATION_LIMITS.maxStallActive);
  assert.equal(limiter.snapshot('ptl').limit, DEFAULT_ITERATION_LIMITS.maxPtl);
});

test('IterationLimiter: 5xx 最多 1 次重试', () => {
  const limiter = new IterationLimiter();
  assert.ok(limiter.canRetry('5xx'));
  assert.ok(limiter.consumeRetry('5xx'));  // 第 1 次
  assert.ok(!limiter.canRetry('5xx'));     // 已耗尽
  assert.ok(!limiter.consumeRetry('5xx')); // 第 2 次拒绝
});

test('IterationLimiter: 429 最多 3 次重试', () => {
  const limiter = new IterationLimiter();
  assert.ok(limiter.consumeRetry('429'));   // attempt 0 → consumed=1
  assert.ok(limiter.consumeRetry('429'));   // attempt 1 → consumed=2
  assert.ok(limiter.consumeRetry('429'));   // attempt 2 → consumed=3
  assert.ok(!limiter.canRetry('429'));      // 耗尽
  assert.ok(!limiter.consumeRetry('429'));  // attempt 3 拒绝（但仍 increment 到 4）
  assert.equal(limiter.snapshot('429').consumed, 4);  // 实际记账 4 次（含被拒的 1 次）
  assert.equal(limiter.snapshot('429').exceeded, true);
});

test('IterationLimiter: 不同 reason 独立记账', () => {
  const limiter = new IterationLimiter();
  limiter.consumeRetry('5xx');
  limiter.consumeRetry('429');
  assert.equal(limiter.snapshot('5xx').consumed, 1);
  assert.equal(limiter.snapshot('429').consumed, 1);
  assert.equal(limiter.snapshot('stall_passive').consumed, 0);
});

test('IterationLimiter: reset 清空所有计数', () => {
  const limiter = new IterationLimiter();
  limiter.consumeRetry('5xx');
  limiter.consumeRetry('429');
  limiter.consumeRetry('429');
  limiter.reset();
  assert.equal(limiter.snapshot('5xx').consumed, 0);
  assert.equal(limiter.snapshot('429').consumed, 0);
  assert.ok(limiter.canRetry('5xx'));
});

test('IterationLimiter: 自定义配置覆盖默认', () => {
  const limiter = new IterationLimiter({ max429: 1, max5xx: 0 });
  assert.equal(limiter.snapshot('429').limit, 1);
  assert.equal(limiter.snapshot('5xx').limit, 0);
  assert.ok(!limiter.canRetry('5xx'));  // 0 上限即不可重试
});

test('IterationLimiter: reportFailure 标记超限', () => {
  const limiter = new IterationLimiter();
  limiter.consumeRetry('5xx');
  const snap = limiter.reportFailure('5xx');
  assert.equal(snap.reason, '5xx');
  assert.equal(snap.consumed, 1);
  assert.equal(snap.limit, 1);
  assert.equal(snap.exceeded, true);
  assert.equal(snap.remaining, 0);
});

test('IterationLimiter: snapshotAll 返回全部 6 个 reason', () => {
  const limiter = new IterationLimiter();
  const all = limiter.snapshotAll();
  assert.equal(all.length, 6);
  const reasons = all.map(s => s.reason);
  assert.ok(reasons.includes('5xx'));
  assert.ok(reasons.includes('429'));
  assert.ok(reasons.includes('stall_passive'));
  assert.ok(reasons.includes('stall_active'));
  assert.ok(reasons.includes('ptl'));
  assert.ok(reasons.includes('max_output_tokens'));
});
