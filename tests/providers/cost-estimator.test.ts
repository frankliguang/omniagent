import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CostEstimator } from '../../src/providers/cost-estimator.js';
import type { TokenUsage } from '../../src/types/index.js';

// ============================================================
// 基础估算
// ============================================================

test('CostEstimator.estimate: OpenAI gpt-4o 简单估算', () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  };
  const cost = CostEstimator.estimate('openai', usage, 'gpt-4o');
  // gpt-4o: $2.5 input + $10 output per million
  assert.equal(cost.usd, 12.5);
  assert.deepEqual(cost.basis, { inputPerMillion: 2.5, outputPerMillion: 10 });
});

test('CostEstimator.estimate: 无 token 0 成本', () => {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const cost = CostEstimator.estimate('openai', usage, 'gpt-4o');
  assert.equal(cost.usd, 0);
});

test('CostEstimator.estimate: 部分百万 token', () => {
  const usage: TokenUsage = {
    inputTokens: 500_000,   // 0.5M × $2.5 = $1.25
    outputTokens: 250_000,  // 0.25M × $10 = $2.5
  };
  const cost = CostEstimator.estimate('openai', usage, 'gpt-4o');
  assert.equal(cost.usd, 3.75);
});

// ============================================================
// 多 provider
// ============================================================

test('CostEstimator.estimate: Anthropic claude-sonnet-4-5', () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  };
  const cost = CostEstimator.estimate('anthropic', usage, 'claude-sonnet-4-5');
  // $3 input + $15 output = $18
  assert.equal(cost.usd, 18);
});

test('CostEstimator.estimate: Ollama 本地 0 成本', () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  };
  const cost = CostEstimator.estimate('ollama', usage, 'llama3');
  assert.equal(cost.usd, 0);
  assert.deepEqual(cost.basis, { inputPerMillion: 0, outputPerMillion: 0 });
});

// ============================================================
// Cache 折扣
// ============================================================

test('CostEstimator.estimateDetailed: Anthropic cache read 90% off', () => {
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,
  };
  const detailed = CostEstimator.estimateDetailed('anthropic', usage, 'claude-sonnet-4-5');
  // cacheReadPerMillion = 0.3 → 1M × $0.3 = $0.3
  // (相比 input 1M × $3 = $3，节省 90%)
  assert.equal(detailed.breakdown?.cacheReadCost, 0.3);
  assert.equal(detailed.usd, 0.3);
});

test('CostEstimator.estimateDetailed: Anthropic cache creation 25% extra', () => {
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 1_000_000,
  };
  const detailed = CostEstimator.estimateDetailed('anthropic', usage, 'claude-sonnet-4-5');
  // cacheCreationPerMillion = 3.75 → 1M × $3.75 = $3.75
  assert.equal(detailed.breakdown?.cacheCreationCost, 3.75);
  assert.equal(detailed.usd, 3.75);
});

test('CostEstimator.estimateDetailed: 默认 cache 折扣（OpenAI 无显式价格）', () => {
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,  // 默认 10% × $2.5 = $0.25
  };
  const detailed = CostEstimator.estimateDetailed('openai', usage, 'gpt-4o');
  assert.equal(detailed.breakdown?.cacheReadCost, 0.25);
});

// ============================================================
// Breakdown 分项
// ============================================================

test('CostEstimator.estimateDetailed: 分项总和 = 总成本', () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 200_000,
    cacheCreationTokens: 100_000,
  };
  const detailed = CostEstimator.estimateDetailed('anthropic', usage, 'claude-sonnet-4-5');
  const b = detailed.breakdown!;
  assert.ok(b);
  // input: 1M × $3 = $3
  assert.equal(b.inputCost, 3);
  // output: 0.5M × $15 = $7.5
  assert.equal(b.outputCost, 7.5);
  // cacheRead: 0.2M × $0.3 = $0.06
  assert.equal(b.cacheReadCost, 0.06);
  // cacheCreation: 0.1M × $3.75 = $0.375
  assert.equal(b.cacheCreationCost, 0.375);
  // total
  assert.equal(b.total, detailed.usd);
  assert.ok(b.total > 0);
});

// ============================================================
// 别名
// ============================================================

test('CostEstimator.registerAlias: 别名解析', () => {
  CostEstimator.registerAlias('my-custom-alias', 'openai/gpt-4o');
  const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 0 };
  const cost = CostEstimator.estimate('openai', usage, 'my-custom-alias');
  assert.equal(cost.usd, 2.5);  // 1M × $2.5 = $2.5
});

test('CostEstimator: 内置别名 gpt-4-0613 → openai/gpt-4', () => {
  const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 0 };
  const cost = CostEstimator.estimate('openai', usage, 'gpt-4-0613');
  // openai/gpt-4: $30 input
  assert.equal(cost.usd, 30);
});

// ============================================================
// 自定义价格注册
// ============================================================

test('CostEstimator.registerPrice: 覆盖内置价格', () => {
  CostEstimator.registerPrice('openai/gpt-4o', {
    inputPerMillion: 100,
    outputPerMillion: 200,
  });
  const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const cost = CostEstimator.estimate('openai', usage, 'gpt-4o');
  assert.equal(cost.usd, 300);  // 100 + 200
});

test('CostEstimator.registerPrice: 新增 provider 价格', () => {
  CostEstimator.registerPrice('newprovider/model-x', {
    inputPerMillion: 5,
    outputPerMillion: 20,
  });
  const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const cost = CostEstimator.estimate('newprovider', usage, 'model-x');
  assert.equal(cost.usd, 25);  // 5 + 20
});

// ============================================================
// 未知 provider
// ============================================================

test('CostEstimator.estimate: 未知 provider 返回 0', () => {
  const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const cost = CostEstimator.estimate('unknown-provider', usage, 'unknown-model');
  assert.equal(cost.usd, 0);
  assert.equal(cost.basis, undefined);
});

// ============================================================
// lookupPrice
// ============================================================

test('CostEstimator.lookupPrice: 已知 provider+model', () => {
  const price = CostEstimator.lookupPrice('openai', 'gpt-4o');
  assert.ok(price);
  assert.equal(price?.inputPerMillion, 100);  // 被上面的 registerPrice 覆盖
});

test('CostEstimator.lookupPrice: provider fallback', () => {
  const price = CostEstimator.lookupPrice('openai');
  assert.ok(price);
  // openai fallback: $2.5 input, $10 output
  assert.ok(price?.inputPerMillion === 2.5);
});

// ============================================================
// listKnownKeys
// ============================================================

test('CostEstimator.listKnownKeys: 包含主要 provider', () => {
  const keys = CostEstimator.listKnownKeys();
  assert.ok(keys.length > 0);
  assert.ok(keys.some(k => k.startsWith('openai/')));
  assert.ok(keys.some(k => k.startsWith('anthropic/')));
  assert.ok(keys.some(k => k.startsWith('ollama/')));
});

// ============================================================
// TokenUsage 边界
// ============================================================

test('CostEstimator.estimate: 大量 token 不溢出', () => {
  const usage: TokenUsage = {
    inputTokens: 100_000_000,   // 100M
    outputTokens: 100_000_000,
  };
  const cost = CostEstimator.estimate('anthropic', usage, 'claude-sonnet-4-5');
  // 100M × $3 + 100M × $15 = $300 + $1500 = $1800
  assert.equal(cost.usd, 1800);
});

test('CostEstimator.estimate: undefined cacheTokens 视为 0', () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    // cacheReadTokens / cacheCreationTokens undefined
  };
  const detailed = CostEstimator.estimateDetailed('anthropic', usage, 'claude-sonnet-4-5');
  assert.equal(detailed.breakdown?.cacheReadCost, 0);
  assert.equal(detailed.breakdown?.cacheCreationCost, 0);
  assert.equal(detailed.usd, 18);  // 3 + 15
});
