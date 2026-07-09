import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ReActLoop, type StreamRenderer, type TurnResult } from '../../src/core/react-loop.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { FILE_TOOLS } from '../../src/tools/builtin/index.js';
import type {
  AuthResult,
  Capabilities,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  CostEstimate,
  Credentials,
  LLMProvider,
  Message,
  TokenCount,
  TokenUsage,
} from '../../src/types/index.js';

// ------------------------------------------------------------
// Mock LLMProvider：按脚本返回预定义 ChatChunk 流
// ------------------------------------------------------------

interface MockScript {
  /** 第 N 轮调用的 chatStream 返回这些 chunks */
  chunks: ChatChunk[];
  /** 或：用 chat() 返回此响应（非流式） */
  response?: ChatResponse;
  /** 或：chatStream 抛错（模拟 5xx） */
  throws?: Error;
}

class MockProvider implements LLMProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock Provider';
  readonly capabilities: Capabilities = {
    supportsStreaming: true,
    supportsToolCalling: true,
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

  async *chatStream(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.callLog.push(req);
    const script = this.scripts[this.callIndex++];
    if (!script) {
      throw new Error(`MockProvider: no script for call ${this.callIndex}`);
    }
    if (script.throws) {
      throw script.throws;
    }
    for (const chunk of script.chunks) {
      yield chunk;
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.callLog.push(req);
    const script = this.scripts[this.callIndex++];
    if (!script || !script.response) {
      throw new Error(`MockProvider: no response script for call ${this.callIndex}`);
    }
    return script.response;
  }

  async countTokens(_messages: Message[]): Promise<TokenCount> {
    return { inputTokens: 0, outputTokens: 0, accuracy: 'estimated' };
  }

  estimateCost(_usage: TokenUsage): CostEstimate {
    return { usd: 0 };
  }
}

/** helper：构造纯文本 chunks 流 */
function textResponse(text: string, usage: TokenUsage = { inputTokens: 5, outputTokens: 10 }): ChatChunk[] {
  return [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', tokenUsage: usage },
  ];
}

/** helper：构造 tool_use chunks 流 */
function toolUseResponse(toolUseId: string, toolName: string, input: Record<string, unknown>): ChatChunk[] {
  return [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'tool_use_start', id: toolUseId as never, name: toolName },
    { type: 'tool_use_delta', id: toolUseId as never, input },
    { type: 'tool_use_end', id: toolUseId as never },
    { type: 'message_end', stopReason: 'tool_use', tokenUsage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

/** renderer 收集器 */
function makeRenderer(): StreamRenderer & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    onTextDelta: (t) => events.push(`text:${t}`),
    onToolUseStart: (id, name) => events.push(`tool_start:${id}:${name}`),
    onToolUseDelta: (id, input) => events.push(`tool_delta:${id}:${JSON.stringify(input)}`),
    onToolUseEnd: (id) => events.push(`tool_end:${id}`),
    onMessageEnd: (stop) => events.push(`end:${stop}`),
  };
}

async function tmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `omniagent-react-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ------------------------------------------------------------

test('ReActLoop: 纯文本一轮 end_turn', async () => {
  const provider = new MockProvider([
    { chunks: textResponse('Hello!') },
  ]);
  const memory = new WorkingMemory();
  const loop = new ReActLoop({ provider, memory, model: 'gpt-4o' });

  const result = await loop.runTurn('hi');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.iterations, 1);
  assert.equal(result.tokenUsage.inputTokens, 5);
  assert.equal(result.tokenUsage.outputTokens, 10);

  // assistant 消息应在 memory 中
  const msgs = memory.getMessages();
  assert.equal(msgs.length, 2);  // user + assistant
  assert.equal(msgs[1].role, 'assistant');
  assert.equal((msgs[1].content[0] as { text: string }).text, 'Hello!');
});

test('ReActLoop: tool_use 一轮 + 文本一轮（两轮对话）', async () => {
  const dir = await tmpDir();
  const provider = new MockProvider([
    // 第 1 轮：LLM 要求 read_file
    { chunks: toolUseResponse('call_1', 'write_file', { file_path: path.join(dir, 'out.txt'), content: 'data' }) },
    // 第 2 轮：LLM 看到结果后回复文本
    { chunks: textResponse('File written.') },
  ]);
  const memory = new WorkingMemory();
  const loop = new ReActLoop({
    provider,
    memory,
    tools: FILE_TOOLS,
    model: 'gpt-4o',
    cwd: dir,
  });

  const result = await loop.runTurn('write a file');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.iterations, 2);

  // 文件应被创建
  const written = await fs.readFile(path.join(dir, 'out.txt'), 'utf8');
  assert.equal(written, 'data');

  // memory 应有 4 条消息：user, assistant(tool_use), tool(result), assistant(text)
  const msgs = memory.getMessages();
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content[0].type, 'tool_use');
  assert.equal(msgs[2].role, 'tool');
  assert.equal(msgs[2].content[0].type, 'tool_result');
  assert.equal(msgs[3].role, 'assistant');
});

test('ReActLoop: 渲染器收到完整事件流', async () => {
  const provider = new MockProvider([
    { chunks: [
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'text_delta', text: 'Hi' },
      { type: 'text_delta', text: ' there' },
      { type: 'message_end', stopReason: 'end_turn', tokenUsage: { inputTokens: 1, outputTokens: 2 } },
    ] },
  ]);
  const renderer = makeRenderer();
  const loop = new ReActLoop({
    provider,
    memory: new WorkingMemory(),
    renderer,
    model: 'gpt-4o',
  });

  await loop.runTurn('hello');
  assert.ok(renderer.events.includes('text:Hi'));
  assert.ok(renderer.events.includes('text: there'));
  assert.ok(renderer.events.includes('end:end_turn'));
});

test('ReActLoop: 超过 maxIterations 强制终止', async () => {
  // 每轮都返回 tool_use，死循环
  const provider = new MockProvider([
    { chunks: toolUseResponse('call_1', 'read_file', { file_path: '/etc/hostname' }) },
    { chunks: toolUseResponse('call_2', 'read_file', { file_path: '/etc/hostname' }) },
    { chunks: toolUseResponse('call_3', 'read_file', { file_path: '/etc/hostname' }) },
  ]);
  const memory = new WorkingMemory();
  const loop = new ReActLoop({
    provider,
    memory,
    tools: FILE_TOOLS,
    model: 'gpt-4o',
    maxIterations: 2,
  });

  const result = await loop.runTurn('loop');
  assert.equal(result.iterations, 2);
  // maxIterations 超限后返回 max_output_tokens（M1 stub 行为）
  assert.equal(result.stopReason, 'max_output_tokens');
});

test('ReActLoop: tool not found 标 is_error', async () => {
  const provider = new MockProvider([
    { chunks: toolUseResponse('call_1', 'nonexistent_tool', {}) },
    { chunks: textResponse('Sorry, tool not found.') },
  ]);
  const memory = new WorkingMemory();
  const loop = new ReActLoop({
    provider,
    memory,
    tools: [],  // 无工具注册
    model: 'gpt-4o',
  });

  const result = await loop.runTurn('use missing tool');
  assert.equal(result.stopReason, 'end_turn');

  // tool_result 应 is_error=true
  const msgs = memory.getMessages();
  const toolResultBlock = msgs[2].content[0] as { type: string; is_error: boolean };
  assert.equal(toolResultBlock.type, 'tool_result');
  assert.equal(toolResultBlock.is_error, true);
});

test('ReActLoop: chat 请求带 systemPromptBlocks', async () => {
  const provider = new MockProvider([
    { chunks: textResponse('ok') },
  ]);
  const loop = new ReActLoop({
    provider,
    memory: new WorkingMemory(),
    systemPrompt: 'You are a coding expert.',
    model: 'gpt-4o',
  });

  await loop.runTurn('hi');
  const req = provider.callLog[0];
  assert.ok(req.systemPromptBlocks);
  assert.equal(req.systemPromptBlocks![0], 'You are a coding expert.');
});

test('ReActLoop: chat 请求带 tools（当 tools 非空）', async () => {
  const provider = new MockProvider([
    { chunks: textResponse('ok') },
  ]);
  const loop = new ReActLoop({
    provider,
    memory: new WorkingMemory(),
    tools: FILE_TOOLS,
    model: 'gpt-4o',
  });

  await loop.runTurn('hi');
  const req = provider.callLog[0];
  assert.ok(req.tools);
  assert.ok(req.tools!.length >= 5);
  const toolNames = req.tools!.map(t => t.name);
  assert.ok(toolNames.includes('read_file'));
  assert.ok(toolNames.includes('edit_file'));
  assert.ok(toolNames.includes('write_file'));
  assert.ok(toolNames.includes('glob'));
  assert.ok(toolNames.includes('grep'));
});

test('ReActLoop: chat 请求不带 tools（当 tools 为空）', async () => {
  const provider = new MockProvider([
    { chunks: textResponse('ok') },
  ]);
  const loop = new ReActLoop({
    provider,
    memory: new WorkingMemory(),
    model: 'gpt-4o',
  });

  await loop.runTurn('hi');
  const req = provider.callLog[0];
  assert.equal(req.tools, undefined);
});

test('ReActLoop: 状态机转换序列', async () => {
  const provider = new MockProvider([
    { chunks: textResponse('done') },
  ]);
  const loop = new ReActLoop({
    provider,
    memory: new WorkingMemory(),
    model: 'gpt-4o',
  });

  const stateLog: string[] = [];
  const origRun = loop.runTurn.bind(loop);
  // wrap to track state
  const result = await origRun('hi');
  assert.ok(result);

  // 最终状态应是 END_TURN
  assert.equal(loop.getState(), 'END_TURN');
});

test('ReActLoop: reset 清空状态', async () => {
  const provider = new MockProvider([
    { chunks: textResponse('ok') },
  ]);
  const memory = new WorkingMemory();
  const loop = new ReActLoop({ provider, memory, model: 'gpt-4o' });

  await loop.runTurn('first');
  assert.equal(memory.size(), 2);
  loop.reset();
  assert.equal(memory.size(), 0);
  assert.equal(loop.getState(), 'IDLE');
});

test('ReActLoop: 多轮 tool_use 链', async () => {
  const dir = await tmpDir();
  const file1 = path.join(dir, 'a.txt');
  const file2 = path.join(dir, 'b.txt');
  await fs.writeFile(file1, 'content-A');

  const provider = new MockProvider([
    // 第 1 轮：read a.txt
    { chunks: toolUseResponse('c1', 'read_file', { file_path: file1 }) },
    // 第 2 轮：write b.txt（内容来自 a.txt 的 content-A）
    { chunks: toolUseResponse('c2', 'write_file', { file_path: file2, content: 'content-A' }) },
    // 第 3 轮：回复完成
    { chunks: textResponse('Done copying.') },
  ]);
  const memory = new WorkingMemory();
  const loop = new ReActLoop({
    provider,
    memory,
    tools: FILE_TOOLS,
    model: 'gpt-4o',
    cwd: dir,
  });

  const result = await loop.runTurn('copy a.txt to b.txt');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.iterations, 3);

  // b.txt 应被创建，内容与 a.txt 相同
  const bContent = await fs.readFile(file2, 'utf8');
  assert.equal(bContent, 'content-A');
});

// ============================================================
// 5xx 降级 → fallbackModel 切换（M1 迭代 3 — L2 §11.1）
// ============================================================

test('ReActLoop: provider_5xx → 切 fallbackModel 重发成功', async () => {
  const provider = new MockProvider([
    // 第 1 轮：chatStream 抛错（模拟 5xx）
    { chunks: [], throws: new Error('provider 5xx: internal server error') },
    // 第 2 轮：fallback model 重发成功
    { chunks: textResponse('Recovered via fallback.') },
  ]);
  const memory = new WorkingMemory();
  const loop = new ReActLoop({
    provider,
    memory,
    model: 'gpt-4o',
    fallbackModel: 'gpt-4o-mini',
  });

  const result = await loop.runTurn('hi');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.iterations, 2);

  // 第 1 次调用用 gpt-4o，第 2 次切到 gpt-4o-mini
  assert.equal(provider.callLog[0].model, 'gpt-4o');
  assert.equal(provider.callLog[1].model, 'gpt-4o-mini');
  assert.ok(provider.callLog[1].fallbackModel !== undefined, 'fallback 应保留在 request');
});

test('ReActLoop: provider_5xx — 无 fallbackModel → fail', async () => {
  const provider = new MockProvider([
    { chunks: [], throws: new Error('provider 5xx: internal server error') },
  ]);
  const memory = new WorkingMemory();
  const loop = new ReActLoop({
    provider,
    memory,
    model: 'gpt-4o',
    // 无 fallbackModel
  });

  const result = await loop.runTurn('hi');
  // 无 fallback 时 stopReason 保留 provider_5xx（明确报错，不臆造 end_turn）
  assert.equal(result.stopReason, 'provider_5xx');
  assert.equal(result.iterations, 1);
  // 只调用过 1 次（未重试）
  assert.equal(provider.callLog.length, 1);
});
