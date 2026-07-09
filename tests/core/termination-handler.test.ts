import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TerminationHandler } from '../../src/core/termination-handler.js';
import { ModelDegrader } from '../../src/core/degrader.js';
import { IterationLimiter } from '../../src/core/iteration-limiter.js';
import type { TerminationHandlerContext } from '../../src/core/termination-handler.js';

function makeCtx(): TerminationHandlerContext {
  return {
    degrader: new ModelDegrader(),
    degraderCtx: {
      currentModel: 'gpt-4o',
      fallbackModel: 'gpt-4o-mini',
      limiter: new IterationLimiter(),
    },
  };
}

const USAGE = { inputTokens: 10, outputTokens: 20 };

test('TerminationHandler: end_turn → END_TURN', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({ stopReason: 'end_turn', tokenUsage: USAGE, ctx: makeCtx() });
  assert.equal(d.stopReason, 'end_turn');
  assert.equal(d.nextState, 'END_TURN');
  assert.equal(d.action.kind, 'end_turn');
});

test('TerminationHandler: tool_use → TOOL_EXECUTE', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({ stopReason: 'tool_use', tokenUsage: USAGE, ctx: makeCtx() });
  assert.equal(d.stopReason, 'tool_use');
  assert.equal(d.nextState, 'TOOL_EXECUTE');
  assert.equal(d.action.kind, 'execute_tools');
});

test('TerminationHandler: max_output_tokens → CALL_LLM (slot_optimize)', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({ stopReason: 'max_output_tokens', tokenUsage: USAGE, ctx: makeCtx() });
  assert.equal(d.stopReason, 'max_output_tokens');
  assert.equal(d.nextState, 'CALL_LLM');
  assert.equal(d.action.kind, 'escalate_max_output');
  if (d.action.kind === 'escalate_max_output') {
    assert.equal(d.action.reason, 'slot_optimize');
  }
});

test('TerminationHandler: ptl → PTL_DEGRADE', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({ stopReason: 'ptl', tokenUsage: USAGE, ctx: makeCtx() });
  assert.equal(d.stopReason, 'ptl');
  assert.equal(d.nextState, 'PTL_DEGRADE');
  assert.equal(d.action.kind, 'ptl_degrade');
});

test('TerminationHandler: user_interrupt → END_TURN (可 resume)', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({
    stopReason: 'user_interrupt',
    tokenUsage: USAGE,
    ctx: makeCtx(),
    abortReason: 'Ctrl+C',
  });
  assert.equal(d.stopReason, 'user_interrupt');
  assert.equal(d.nextState, 'END_TURN');
  assert.equal(d.action.kind, 'user_interrupt');
  if (d.action.kind === 'user_interrupt') {
    assert.match(d.action.reason, /Ctrl\+C/);
  }
});

test('TerminationHandler: stall_passive_30s → CALL_LLM (retry)', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({ stopReason: 'stall_passive_30s', tokenUsage: USAGE, ctx: makeCtx() });
  assert.equal(d.stopReason, 'stall_passive_30s');
  assert.equal(d.nextState, 'CALL_LLM');
  assert.equal(d.action.kind, 'retry_stall_passive');
});

test('TerminationHandler: stall_active_90s → CALL_LLM (non-streaming)', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({ stopReason: 'stall_active_90s', tokenUsage: USAGE, ctx: makeCtx() });
  assert.equal(d.stopReason, 'stall_active_90s');
  assert.equal(d.nextState, 'CALL_LLM');
  assert.equal(d.action.kind, 'switch_to_non_streaming');
});

test('TerminationHandler: provider_5xx → CALL_LLM (degrade)', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({ stopReason: 'provider_5xx', tokenUsage: USAGE, ctx: makeCtx() });
  assert.equal(d.stopReason, 'provider_5xx');
  assert.equal(d.nextState, 'CALL_LLM');
  assert.equal(d.action.kind, 'degrade_5xx');
});

test('TerminationHandler: provider_5xx — 无 fallback → END_TURN + fail', () => {
  const handler = new TerminationHandler();
  const ctx = makeCtx();
  ctx.degraderCtx.fallbackModel = undefined;
  const d = handler.handle({ stopReason: 'provider_5xx', tokenUsage: USAGE, ctx });
  assert.equal(d.nextState, 'END_TURN');
  assert.equal(d.action.kind, 'fail');
});

test('TerminationHandler: provider_429 → CALL_LLM (retry_429)', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({
    stopReason: 'provider_429',
    tokenUsage: USAGE,
    ctx: makeCtx(),
    current429Attempt: 0,
  });
  assert.equal(d.stopReason, 'provider_429');
  assert.equal(d.nextState, 'CALL_LLM');
  assert.equal(d.action.kind, 'retry_429');
  if (d.action.kind === 'retry_429' && d.action.degraderAction.kind === 'retry_429') {
    assert.equal(d.action.degraderAction.backoffMs, 1000);
  }
});

test('TerminationHandler: provider_429 — 超限 → END_TURN + fail', () => {
  const handler = new TerminationHandler();
  const ctx = makeCtx();
  // 用完 429 预算（默认 3 次）
  ctx.degraderCtx.limiter.consumeRetry('429');
  ctx.degraderCtx.limiter.consumeRetry('429');
  ctx.degraderCtx.limiter.consumeRetry('429');
  const d = handler.handle({
    stopReason: 'provider_429',
    tokenUsage: USAGE,
    ctx,
    current429Attempt: 3,
  });
  assert.equal(d.nextState, 'END_TURN');
  assert.equal(d.action.kind, 'fail');
});

test('TerminationHandler: tool_execution_error → CALL_LLM (回注 LLM)', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({ stopReason: 'tool_execution_error', tokenUsage: USAGE, ctx: makeCtx() });
  assert.equal(d.stopReason, 'tool_execution_error');
  assert.equal(d.nextState, 'CALL_LLM');
  assert.equal(d.action.kind, 'tool_execution_error');
});

test('TerminationHandler: budget_exceeded → END_TURN (软提醒)', () => {
  const handler = new TerminationHandler();
  const d = handler.handle({
    stopReason: 'budget_exceeded',
    tokenUsage: USAGE,
    ctx: makeCtx(),
    budgetRemaining: 1.50,
  });
  assert.equal(d.stopReason, 'budget_exceeded');
  assert.equal(d.nextState, 'END_TURN');
  assert.equal(d.action.kind, 'budget_exceeded');
  if (d.action.kind === 'budget_exceeded') {
    assert.equal(d.action.remaining, 1.50);
  }
});
