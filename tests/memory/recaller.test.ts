import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryRecaller } from '../../src/memory/recaller.js';
import type {
  AuthResult,
  Capabilities,
  ChatRequest,
  ChatResponse,
  CostEstimate,
  Credentials,
  LLMProvider,
  Message,
  TokenCount,
  TokenUsage,
  ChatChunk,
} from '../../src/types/index.js';

// ============================================================
// Mock LLMProvider：chat() 返回预设响应
// ============================================================

interface MockScript {
  /** chat() 第 N 次调用返回的响应文本 */
  responseText?: string;
  /** 或：chat() 抛错 */
  throws?: Error;
}

class MockProvider implements LLMProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock Provider';
  readonly capabilities: Capabilities = {
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsPromptCaching: false,
    supportsMultiModal: false,
    supportsRiskClassification: false,
    maxContextWindow: 128_000,
    maxOutputTokens: 4_096,
    tokenCountAccuracy: 'estimated',
  };

  private scripts: MockScript[];
  private callIndex = 0;
  public callLog: ChatRequest[] = [];

  constructor(scripts: MockScript[]) {
    this.scripts = scripts;
  }

  async authenticate(_credentials: Credentials): Promise<AuthResult> {
    return { success: true, providerId: 'mock' };
  }

  async *chatStream(_req: ChatRequest): AsyncIterable<ChatChunk> {
    // Mock 不实现流式（recaller 用 chat）
    yield { type: 'message_start', message: { role: 'assistant', content: [] } };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.callLog.push(req);
    const script = this.scripts[this.callIndex++];
    if (!script) {
      throw new Error(`MockProvider: no script for call ${this.callIndex}`);
    }
    if (script.throws) {
      throw script.throws;
    }
    const text = script.responseText ?? '';
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text }],
      metadata: { model: 'mock', provider: 'mock' },
    };
    return {
      message,
      stopReason: 'end_turn',
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
      providerMetadata: { id: 'mock', model: 'mock' },
    };
  }

  async countTokens(_messages: Message[]): Promise<TokenCount> {
    return { inputTokens: 0, outputTokens: 0, accuracy: 'estimated' };
  }

  estimateCost(_usage: TokenUsage): CostEstimate {
    return { usd: 0 };
  }
}

// ============================================================
// 辅助
// ============================================================

async function makeMemoryDir(memories: Array<{ name: string; description: string; type: string; body?: string }>): Promise<string> {
  const dir = path.join(os.tmpdir(), `omniagent-recall-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  for (const m of memories) {
    const content = `---
name: ${m.name}
description: ${m.description}
type: ${m.type}
---
${m.body ?? 'body'}`;
    await fs.writeFile(path.join(dir, `${m.name}.md`), content);
  }
  return dir;
}

// ============================================================
// MemoryRecaller 测试
// ============================================================

test('MemoryRecaller: 无记忆目录 → []', async () => {
  const provider = new MockProvider([{ responseText: '[]' }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: '/nonexistent' });
  const result = await recaller.findRelevantMemories('anything');
  assert.equal(result.length, 0);
  // LLM 未被调用
  assert.equal(provider.callLog.length, 0);
});

test('MemoryRecaller: 空 query → []', async () => {
  const dir = await makeMemoryDir([
    { name: 'mem1', description: 'desc', type: 'user' },
  ]);
  const provider = new MockProvider([{ responseText: '[]' }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir });
  const result = await recaller.findRelevantMemories('');
  assert.equal(result.length, 0);
  assert.equal(provider.callLog.length, 0);
});

test('MemoryRecaller: LLM 返回高置信度记忆 → 注入', async () => {
  const dir = await makeMemoryDir([
    { name: 'go_pref', description: '用户偏好 Go', type: 'user' },
    { name: 'python_pref', description: '用户偏好 Python', type: 'user' },
    { name: 'rust_pref', description: '用户偏好 Rust', type: 'user' },
  ]);
  const provider = new MockProvider([{
    responseText: '[{"name":"go_pref","confidence":0.9},{"name":"rust_pref","confidence":0.6},{"name":"python_pref","confidence":0.1}]',
  }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir, confidenceThreshold: 0.5 });
  const result = await recaller.findRelevantMemories('用户喜欢什么语言');
  assert.equal(result.length, 2);
  assert.equal(result[0]!.frontmatter.name, 'go_pref');  // 0.9 排前
  assert.equal(result[1]!.frontmatter.name, 'rust_pref');  // 0.6 排后
});

test('MemoryRecaller: 低置信度过滤', async () => {
  const dir = await makeMemoryDir([
    { name: 'mem_a', description: 'A', type: 'project' },
    { name: 'mem_b', description: 'B', type: 'project' },
  ]);
  const provider = new MockProvider([{
    responseText: '[{"name":"mem_a","confidence":0.3},{"name":"mem_b","confidence":0.4}]',
  }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir, confidenceThreshold: 0.5 });
  const result = await recaller.findRelevantMemories('query');
  assert.equal(result.length, 0);  // 都低于阈值
});

test('MemoryRecaller: maxResults 限制返回数', async () => {
  const dir = await makeMemoryDir([
    { name: 'm1', description: 'd1', type: 'user' },
    { name: 'm2', description: 'd2', type: 'user' },
    { name: 'm3', description: 'd3', type: 'user' },
    { name: 'm4', description: 'd4', type: 'user' },
    { name: 'm5', description: 'd5', type: 'user' },
  ]);
  const provider = new MockProvider([{
    responseText: '[{"name":"m1","confidence":0.9},{"name":"m2","confidence":0.9},{"name":"m3","confidence":0.9},{"name":"m4","confidence":0.9},{"name":"m5","confidence":0.9}]',
  }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir, maxResults: 3, confidenceThreshold: 0.5 });
  const result = await recaller.findRelevantMemories('q');
  assert.equal(result.length, 3);
});

test('MemoryRecaller: LLM 臆造 name 过滤', async () => {
  const dir = await makeMemoryDir([
    { name: 'real_mem', description: 'real', type: 'user' },
  ]);
  const provider = new MockProvider([{
    responseText: '[{"name":"real_mem","confidence":0.9},{"name":"hallucinated","confidence":1.0}]',
  }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir });
  const result = await recaller.findRelevantMemories('q');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.frontmatter.name, 'real_mem');
});

test('MemoryRecaller: LLM 失败 → []（不抛错）', async () => {
  const dir = await makeMemoryDir([
    { name: 'mem', description: 'd', type: 'user' },
  ]);
  const provider = new MockProvider([{ throws: new Error('LLM down') }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir });
  const result = await recaller.findRelevantMemories('q');
  assert.equal(result.length, 0);  // 失败跳过
});

test('MemoryRecaller: LLM 响应非 JSON → []', async () => {
  const dir = await makeMemoryDir([
    { name: 'mem', description: 'd', type: 'user' },
  ]);
  const provider = new MockProvider([{ responseText: 'I think the relevant memory is mem.' }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir });
  const result = await recaller.findRelevantMemories('q');
  assert.equal(result.length, 0);
});

test('MemoryRecaller: LLM 响应带 prose + JSON 块 → 提取 JSON', async () => {
  const dir = await makeMemoryDir([
    { name: 'mem', description: 'd', type: 'user' },
  ]);
  const provider = new MockProvider([{
    responseText: 'Here is my analysis:\n[{"name":"mem","confidence":0.8}]\nHope this helps.',
  }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir });
  const result = await recaller.findRelevantMemories('q');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.frontmatter.name, 'mem');
});

test('MemoryRecaller: confidence 超出 [0,1] 截断', async () => {
  const dir = await makeMemoryDir([
    { name: 'mem', description: 'd', type: 'user' },
  ]);
  const provider = new MockProvider([{
    responseText: '[{"name":"mem","confidence":1.5}]',
  }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir });
  const result = await recaller.findRelevantMemories('q');
  assert.equal(result.length, 1);
});

test('MemoryRecaller: 默认 maxTokens=256', async () => {
  const dir = await makeMemoryDir([
    { name: 'mem', description: 'd', type: 'user' },
  ]);
  const provider = new MockProvider([{ responseText: '[]' }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir });
  await recaller.findRelevantMemories('q');
  assert.equal(provider.callLog[0]!.maxOutputTokens, 256);
});

test('MemoryRecaller: temperature=0（确定性）', async () => {
  const dir = await makeMemoryDir([
    { name: 'mem', description: 'd', type: 'user' },
  ]);
  const provider = new MockProvider([{ responseText: '[]' }]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir });
  await recaller.findRelevantMemories('q');
  assert.equal(provider.callLog[0]!.temperature, 0);
});

test('MemoryRecaller: 多次调用复用 authenticated 状态', async () => {
  const dir = await makeMemoryDir([
    { name: 'm1', description: 'd1', type: 'user' },
    { name: 'm2', description: 'd2', type: 'user' },
  ]);
  const provider = new MockProvider([
    { responseText: '[{"name":"m1","confidence":0.9}]' },
    { responseText: '[{"name":"m2","confidence":0.9}]' },
  ]);
  const recaller = new MemoryRecaller(provider, { memoryDir: dir });
  // 首次调用：会 authenticate
  await recaller.findRelevantMemories('query1');
  // 第二次：应已 authenticated，不再 authenticate
  await recaller.findRelevantMemories('query2');
  // chat 被调 2 次
  assert.equal(provider.callLog.length, 2);
});
