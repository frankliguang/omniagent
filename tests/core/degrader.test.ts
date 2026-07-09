import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ModelDegrader, compute429Backoff } from '../../src/core/degrader.js';
import { IterationLimiter } from '../../src/core/iteration-limiter.js';
import type { DegraderContext } from '../../src/core/degrader.js';

function makeCtx(opts: { currentModel: string; fallbackModel?: string }): DegraderContext {
  return {
    currentModel: opts.currentModel,
    fallbackModel: opts.fallbackModel,
    limiter: new IterationLimiter(),
  };
}

test('ModelDegrader: 5xx — 切 fallbackModel + 清 partial', () => {
  const degrader = new ModelDegrader();
  const ctx = makeCtx({ currentModel: 'gpt-4o', fallbackModel: 'gpt-4o-mini' });
  const action = degrader.handle5xx(ctx);
  assert.equal(action.kind, 'degrade_5xx');
  if (action.kind === 'degrade_5xx') {
    assert.equal(action.fromModel, 'gpt-4o');
    assert.equal(action.toModel, 'gpt-4o-mini');
    assert.equal(action.clearPartial, true);
  }
});

test('ModelDegrader: 5xx — 无 fallbackModel 报错', () => {
  const degrader = new ModelDegrader();
  const ctx = makeCtx({ currentModel: 'gpt-4o' });
  const action = degrader.handle5xx(ctx);
  assert.equal(action.kind, 'fail');
  if (action.kind === 'fail') {
    assert.match(action.message, /fallbackModel/);
  }
});

test('ModelDegrader: 5xx — fallbackModel == currentModel 报错', () => {
  const degrader = new ModelDegrader();
  const ctx = makeCtx({ currentModel: 'gpt-4o', fallbackModel: 'gpt-4o' });
  const action = degrader.handle5xx(ctx);
  assert.equal(action.kind, 'fail');
  if (action.kind === 'fail') {
    assert.match(action.message, /identical/);
  }
});

test('ModelDegrader: 5xx — 重试预算耗尽报错', () => {
  const degrader = new ModelDegrader();
  const limiter = new IterationLimiter();
  // 用完 5xx 预算（默认 1 次）
  limiter.consumeRetry('5xx');
  const ctx: DegraderContext = {
    currentModel: 'gpt-4o',
    fallbackModel: 'gpt-4o-mini',
    limiter,
  };
  const action = degrader.handle5xx(ctx);
  assert.equal(action.kind, 'fail');
  if (action.kind === 'fail') {
    assert.match(action.message, /budget exhausted/);
  }
});

test('ModelDegrader: 429 — 指数退避 1s/2s/4s', () => {
  const degrader = new ModelDegrader();
  const ctx = makeCtx({ currentModel: 'gpt-4o' });

  // handle429 只检查不消费，需手动 consume 模拟预算耗尽
  const a0 = degrader.handle429(ctx, { attempt: 0 });
  assert.equal(a0.kind, 'retry_429');
  if (a0.kind === 'retry_429') assert.equal(a0.backoffMs, 1000);
  ctx.limiter.consumeRetry('429');

  const a1 = degrader.handle429(ctx, { attempt: 1 });
  if (a1.kind === 'retry_429') assert.equal(a1.backoffMs, 2000);
  ctx.limiter.consumeRetry('429');

  const a2 = degrader.handle429(ctx, { attempt: 2 });
  if (a2.kind === 'retry_429') assert.equal(a2.backoffMs, 4000);
  ctx.limiter.consumeRetry('429');

  // 3 次耗尽后，第 4 次（attempt 3）应 fail
  const a3 = degrader.handle429(ctx, { attempt: 3 });
  assert.equal(a3.kind, 'fail');
});

test('ModelDegrader: 429 — retry-after 优先于指数退避', () => {
  const degrader = new ModelDegrader();
  const ctx = makeCtx({ currentModel: 'gpt-4o' });
  const action = degrader.handle429(ctx, { attempt: 0, retryAfterMs: 5000 });
  if (action.kind === 'retry_429') {
    assert.equal(action.backoffMs, 5000);
  }
});

test('ModelDegrader: 429 — retry-after 上限 60s', () => {
  const degrader = new ModelDegrader();
  const ctx = makeCtx({ currentModel: 'gpt-4o' });
  const action = degrader.handle429(ctx, { attempt: 0, retryAfterMs: 120_000 });
  if (action.kind === 'retry_429') {
    assert.equal(action.backoffMs, 60_000);
  }
});

test('ModelDegrader: stall_passive — 同 model 重发', () => {
  const degrader = new ModelDegrader();
  const ctx = makeCtx({ currentModel: 'gpt-4o' });
  const action = degrader.handleStallPassive(ctx);
  assert.equal(action.kind, 'retry_stall_passive');
  if (action.kind === 'retry_stall_passive') {
    assert.equal(action.fromModel, 'gpt-4o');
  }
});

test('ModelDegrader: stall_passive — 预算耗尽报错', () => {
  const degrader = new ModelDegrader();
  const limiter = new IterationLimiter();
  limiter.consumeRetry('stall_passive');
  const ctx: DegraderContext = { currentModel: 'gpt-4o', limiter };
  const action = degrader.handleStallPassive(ctx);
  assert.equal(action.kind, 'fail');
});

test('ModelDegrader: stall_active — 切非流式', () => {
  const degrader = new ModelDegrader();
  const ctx = makeCtx({ currentModel: 'gpt-4o' });
  const action = degrader.handleStallActive(ctx);
  assert.equal(action.kind, 'switch_to_non_streaming');
});

test('ModelDegrader: stall_active — 预算耗尽报错', () => {
  const degrader = new ModelDegrader();
  const limiter = new IterationLimiter();
  limiter.consumeRetry('stall_active');
  const ctx: DegraderContext = { currentModel: 'gpt-4o', limiter };
  const action = degrader.handleStallActive(ctx);
  assert.equal(action.kind, 'fail');
});

test('compute429Backoff: 指数退避算法', () => {
  assert.equal(compute429Backoff({ attempt: 0 }), 1000);
  assert.equal(compute429Backoff({ attempt: 1 }), 2000);
  assert.equal(compute429Backoff({ attempt: 2 }), 4000);
  assert.equal(compute429Backoff({ attempt: 3 }), 8000);
  assert.equal(compute429Backoff({ attempt: 4 }), 8000);  // 上限
});

test('compute429Backoff: retry-after 优先', () => {
  assert.equal(compute429Backoff({ attempt: 0, retryAfterMs: 3000 }), 3000);
  assert.equal(compute429Backoff({ attempt: 0, retryAfterMs: 90_000 }), 60_000);  // 上限 60s
});
