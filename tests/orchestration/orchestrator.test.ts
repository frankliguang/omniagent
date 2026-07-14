import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { Orchestrator } from '../../src/orchestration/orchestrator.js';
import { TaskManager } from '../../src/orchestration/task-manager.js';
import {
  LocalMemoryEngine,
  SidechainManager,
  defaultSidechainPath,
} from '../../src/memory/sidechain.js';
import { TranscriptStore } from '../../src/memory/transcript.js';
import {
  ForkAgentSpawner,
  fillPlaceholderToolResults,
  verifyByteIdenticalPrefix,
} from '../../src/orchestration/fork-agent-spawner.js';
import { spawnSync, spawnAsync } from '../../src/orchestration/coordinator-mode.js';
import type {
  SubAgentRunner,
  SubAgentRunnerFactory,
  SubAgentTurnResult,
} from '../../src/orchestration/sub-agent-runner.js';
import { createAgentRouterTool } from '../../src/tools/builtin/orchestration/agent-router.js';
import type {
  AgentId,
  Message,
  ToolContext,
  ToolResult,
  ToolUseId,
  UUID,
} from '../../src/types/index.js';

// ============================================================
// helpers
// ============================================================

function tmpHome(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-orch-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const tmp = tmpHome();
  const oldHome = process.env.HOME;
  process.env.HOME = tmp;
  return fn().finally(async () => {
    process.env.HOME = oldHome;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
}

function makeMessage(params: {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  id?: UUID;
  parentUuid?: UUID;
}): Message {
  return {
    role: params.role,
    content: [{ type: 'text', text: params.text }],
    id: params.id ?? (randomUUID() as UUID),
    parentUuid: params.parentUuid,
    createdAt: new Date().toISOString() as never,
  };
}

function makeToolUseMessage(toolUseId: string, name: string, input: Record<string, unknown>): Message {
  return {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: toolUseId as ToolUseId,
      name,
      input,
    }],
    id: randomUUID() as UUID,
    createdAt: new Date().toISOString() as never,
  };
}

function makeToolResultMessage(toolUseId: string, text: string): Message {
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId as ToolUseId,
      content: [{ type: 'text', text }],
      is_error: false,
    }],
    id: randomUUID() as UUID,
    createdAt: new Date().toISOString() as never,
  };
}

/** 构造链路：每条消息的 parentUuid 指向上一条 id（首条 parentUuid=undefined） */
function makeChain(texts: string[]): Message[] {
  const msgs: Message[] = [];
  let prevId: UUID | undefined;
  for (const text of texts) {
    const id = randomUUID() as UUID;
    msgs.push(makeMessage({ role: 'user', text, id, parentUuid: prevId }));
    prevId = id;
  }
  return msgs;
}

function makeCtx(): ToolContext {
  return {
    cwd: '/tmp',
    permissionMode: 'bypassPermissions',
    agentId: 'test-agent' as never,
    abortSignal: new AbortController().signal,
    agentRole: 'main',
    toolUseId: 'tu-1' as ToolUseId,
  };
}

function getText(result: ToolResult): string {
  const block = result.content[0];
  return block.type === 'text' ? block.text : '';
}

/** Mock SubAgentRunner：记录调用 + 返回固定结果 */
class MockSubAgentRunner implements SubAgentRunner {
  public calls: Array<{ prompt: string; sidechainId: UUID; parentAgentId: string }> = [];
  constructor(private readonly result: SubAgentTurnResult) {}

  async runTurn(params: {
    prompt: string;
    sidechainId: UUID;
    parentAgentId: AgentId;
  }): Promise<SubAgentTurnResult> {
    this.calls.push({ ...params });
    return this.result;
  }
}

/** Mock runner factory：每次返回同一 runner 实例（便于断言调用次数） */
function makeMockRunnerFactory(result: SubAgentTurnResult): {
  factory: SubAgentRunnerFactory;
  runner: MockSubAgentRunner;
} {
  const runner = new MockSubAgentRunner(result);
  return {
    factory: () => runner,
    runner,
  };
}

async function makeOrchFixture(opts: {
  parentMessages?: Message[];
  runnerResult?: SubAgentTurnResult;
}) {
  const sessionId = randomUUID();
  const mainPath = path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`);
  const mainStore = await TranscriptStore.load(mainPath);
  const engine = new LocalMemoryEngine(sessionId, mainStore);
  const sidechainManager = new SidechainManager(engine);
  const taskManager = new TaskManager();

  // 写入父 agent messages（如果有）
  if (opts.parentMessages) {
    for (const m of opts.parentMessages) await mainStore.append(m);
    await mainStore.flush();
  }

  const result = opts.runnerResult ?? {
    stopReason: 'end_turn' as const,
    iterations: 1,
    finalText: 'sub-agent output',
  };
  const { factory: runnerFactory, runner } = makeMockRunnerFactory(result);

  const orchestrator = new Orchestrator({
    taskManager,
    sidechain: sidechainManager,
    memoryEngine: engine,
    runnerFactory,
  });

  return {
    orchestrator,
    taskManager,
    sidechainManager,
    engine,
    mainStore,
    sessionId,
    runner,
    runnerFactory,
  };
}

// ============================================================
// fillPlaceholderToolResults 单元测试（不变量 #5）
// ============================================================

test('fillPlaceholderToolResults: 全部配对时返回原 messages（immutable copy）', () => {
  const msgs = [
    makeToolUseMessage('tu-1', 'read_file', { path: '/a' }),
    makeToolResultMessage('tu-1', 'content of a'),
    makeMessage({ role: 'assistant', text: 'response' }),
  ];
  const result = fillPlaceholderToolResults(msgs);
  assert.equal(result.length, msgs.length, '全部配对不应增加 message');
  // 前 N 条应与原 messages byte-identical
  const check = verifyByteIdenticalPrefix(msgs, result);
  assert.ok(check.ok, check.detail);
});

test('fillPlaceholderToolResults: 1 个 orphan tool_use 补 1 条占位 message', () => {
  const msgs = [
    makeToolUseMessage('tu-1', 'read_file', { path: '/a' }),
    makeToolResultMessage('tu-1', 'content'),
    makeToolUseMessage('tu-2', 'bash', { cmd: 'ls' }),  // orphan
    makeMessage({ role: 'assistant', text: 'next' }),
  ];
  const result = fillPlaceholderToolResults(msgs);
  assert.equal(result.length, msgs.length + 1, '应补 1 条占位 message');
  // 前 N 条 byte-identical
  const check = verifyByteIdenticalPrefix(msgs, result);
  assert.ok(check.ok, check.detail);
  // 最后一条应是 user role + tool_result block
  const placeholder = result[result.length - 1];
  assert.equal(placeholder.role, 'user');
  assert.equal(placeholder.content.length, 1);
  assert.equal(placeholder.content[0].type, 'tool_result');
  if (placeholder.content[0].type === 'tool_result') {
    assert.equal(placeholder.content[0].tool_use_id, 'tu-2' as ToolUseId);
    const textBlock = placeholder.content[0].content[0];
    assert.equal(textBlock.type, 'text');
    if (textBlock.type === 'text') assert.equal(textBlock.text, 'placeholder');
  }
});

test('fillPlaceholderToolResults: 多个 orphan 补 1 条含 N 个 tool_result', () => {
  const msgs = [
    makeToolUseMessage('tu-1', 'bash', { cmd: 'a' }),
    makeToolUseMessage('tu-2', 'bash', { cmd: 'b' }),
    makeToolUseMessage('tu-3', 'bash', { cmd: 'c' }),
    // 全部 orphan（无对应 tool_result）
  ];
  const result = fillPlaceholderToolResults(msgs);
  assert.equal(result.length, msgs.length + 1, '应补 1 条占位');
  const placeholder = result[result.length - 1];
  assert.equal(placeholder.content.length, 3, '占位 message 应含 3 个 tool_result');
  // 顺序应为 tu-1, tu-2, tu-3
  if (placeholder.content[0].type === 'tool_result' &&
      placeholder.content[1].type === 'tool_result' &&
      placeholder.content[2].type === 'tool_result') {
    assert.equal(placeholder.content[0].tool_use_id, 'tu-1' as ToolUseId);
    assert.equal(placeholder.content[1].tool_use_id, 'tu-2' as ToolUseId);
    assert.equal(placeholder.content[2].tool_use_id, 'tu-3' as ToolUseId);
  }
});

test('fillPlaceholderToolResults: 不修改原数组（immutable）', () => {
  const msgs = [
    makeToolUseMessage('tu-1', 'bash', { cmd: 'ls' }),
    makeMessage({ role: 'assistant', text: 'r' }),
  ];
  const originalLength = msgs.length;
  const originalFirstId = msgs[0].id;
  fillPlaceholderToolResults(msgs);
  assert.equal(msgs.length, originalLength, '原数组长度不应变');
  assert.equal(msgs[0].id, originalFirstId, '原数组元素不应被修改');
});

test('fillPlaceholderToolResults: 空数组返回空', () => {
  const result = fillPlaceholderToolResults([]);
  assert.equal(result.length, 0);
});

test('fillPlaceholderToolResults: 部分配对 + 部分 orphan', () => {
  const msgs = [
    makeToolUseMessage('tu-1', 'a', {}),
    makeToolResultMessage('tu-1', 'r1'),  // 配对
    makeToolUseMessage('tu-2', 'b', {}),
    makeToolResultMessage('tu-2', 'r2'),  // 配对
    makeToolUseMessage('tu-3', 'c', {}),   // orphan
    makeToolUseMessage('tu-4', 'd', {}),   // orphan
  ];
  const result = fillPlaceholderToolResults(msgs);
  assert.equal(result.length, msgs.length + 1);
  const placeholder = result[result.length - 1];
  assert.equal(placeholder.content.length, 2);
  if (placeholder.content[0].type === 'tool_result' &&
      placeholder.content[1].type === 'tool_result') {
    assert.equal(placeholder.content[0].tool_use_id, 'tu-3' as ToolUseId);
    assert.equal(placeholder.content[1].tool_use_id, 'tu-4' as ToolUseId);
  }
});

// ============================================================
// verifyByteIdenticalPrefix 单元测试
// ============================================================

test('verifyByteIdenticalPrefix: 完全一致 + 无占位 = ok', () => {
  const msgs = [makeMessage({ role: 'user', text: 'a' })];
  const result = fillPlaceholderToolResults(msgs);
  assert.ok(verifyByteIdenticalPrefix(msgs, result).ok);
});

test('verifyByteIdenticalPrefix: 占位 message 不规范 = 不 ok', () => {
  const orig = [makeToolUseMessage('tu-1', 'a', {})];
  // 构造一个错误的 forked（占位 message 是 assistant 而非 user）
  const badForked = [...orig, {
    role: 'assistant' as const,
    content: [{
      type: 'tool_result' as const,
      tool_use_id: 'tu-1' as ToolUseId,
      content: [{ type: 'text' as const, text: 'placeholder' }],
      is_error: false,
    }],
    id: randomUUID() as UUID,
    createdAt: new Date().toISOString() as never,
  }];
  const check = verifyByteIdenticalPrefix(orig, badForked);
  assert.equal(check.ok, false);
  assert.match(check.detail!, /placeholder message should be user role/);
});

// ============================================================
// CoordinatorMode: sync 路径
// ============================================================

test('CoordinatorMode spawnSync: 创建 sidechain + 调 runner + flush + 返回结果', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainManager = new SidechainManager(engine);
    const taskManager = new TaskManager();
    const { factory, runner } = makeMockRunnerFactory({
      stopReason: 'end_turn',
      iterations: 3,
      finalText: 'sync result text',
    });

    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });

    const result = await spawnSync({
      route: 'sync',
      prompt: 'test prompt',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
      sidechain: sidechainManager,
      taskManager,
      runnerFactory: factory,
    });

    // 验证 runner 被调用 1 次，参数正确
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].prompt, 'test prompt');
    assert.ok(runner.calls[0].sidechainId);

    // 验证 result 内容
    assert.equal(getText(result), 'sync result text');
    assert.equal(result.is_error, false);

    // 验证 sidechain 已关联
    const out = await taskManager.getOutput(runtimeTaskId as never);
    assert.ok(out?.sidechainId);

    await engine.closeAll();
    await mainStore.close();
  });
});

test('CoordinatorMode spawnSync: runner 抛错时返回 is_error=true', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainManager = new SidechainManager(engine);
    const taskManager = new TaskManager();
    const { factory } = makeMockRunnerFactory({
      stopReason: 'failed',
      iterations: 0,
      finalText: '',
      error: 'mock failure',
    });

    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });

    const result = await spawnSync({
      route: 'sync',
      prompt: 'test',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
      sidechain: sidechainManager,
      taskManager,
      runnerFactory: factory,
    });

    assert.equal(result.is_error, true);
    // finalText 为空时 fallback 到 JSON.stringify
    assert.match(getText(result), /mock failure/);

    await engine.closeAll();
    await mainStore.close();
  });
});

// ============================================================
// CoordinatorMode: async 路径
// ============================================================

test('CoordinatorMode spawnAsync: 立即返回 task_id + 后台完成', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainManager = new SidechainManager(engine);
    const taskManager = new TaskManager();
    const { factory, runner } = makeMockRunnerFactory({
      stopReason: 'end_turn',
      iterations: 2,
      finalText: 'async result',
    });

    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'async',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });

    const result = await spawnAsync({
      route: 'async',
      prompt: 'test prompt',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
      sidechain: sidechainManager,
      taskManager,
      runnerFactory: factory,
    });

    // 立即返回 task_id（不等 runner 完成）
    assert.match(getText(result), /async task started/);
    assert.match(getText(result), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);

    // 等后台 spawn 完成（轮询）
    for (let i = 0; i < 100; i++) {
      const out = await taskManager.getOutput(runtimeTaskId as never);
      if (out && out.status !== 'running') break;
      await new Promise(r => setTimeout(r, 10));
    }

    // 验证后台 runner 被调用
    assert.equal(runner.calls.length, 1);
    // 验证 task 已完成
    const out = await taskManager.getOutput(runtimeTaskId as never);
    assert.equal(out?.status, 'completed');

    await engine.closeAll();
    await mainStore.close();
  });
});

// ============================================================
// ForkAgentSpawner: fork 路径 + 不变量 #5
// ============================================================

test('ForkAgentSpawner spawn: 继承父上下文 + 占位 tool_result', async () => {
  await withTempHome(async () => {
    const parentMessages: Message[] = [
      makeMessage({ role: 'user', text: 'parent q' }),
      makeMessage({ role: 'assistant', text: 'parent a' }),
      makeToolUseMessage('tu-1', 'read_file', { path: '/a' }),
      // 故意不给 tu-1 tool_result（orphan）
      makeMessage({ role: 'assistant', text: 'after tool' }),
    ];

    const fix = await makeOrchFixture({
      parentMessages,
      runnerResult: { stopReason: 'end_turn', iterations: 1, finalText: 'fork result' },
    });

    const { runtimeTaskId } = await fix.taskManager.createDualTrack({
      route: 'fork',
      prompt: 'refactor module',
      parentAgentId: 'parent-1',
    });

    const spawner = new ForkAgentSpawner({
      sidechain: fix.sidechainManager,
      memoryEngine: fix.engine,
      runnerFactory: fix.runnerFactory,
      taskManager: fix.taskManager,
    });

    const result = await spawner.spawn({
      prompt: 'refactor this',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });

    // 1. 验证 runner 被调用，prompt 透传
    assert.equal(fix.runner.calls.length, 1);
    assert.equal(fix.runner.calls[0].prompt, 'refactor this');

    // 2. 验证 sidechain 已创建且包含继承的父上下文 + 占位 tool_result
    const out = await fix.taskManager.getOutput(runtimeTaskId as never);
    assert.ok(out?.sidechainId);
    const sideMsgs = await fix.sidechainManager.read(out!.sidechainId!);
    // 父 4 条 + 占位 1 条 = 5 条
    assert.equal(sideMsgs.length, 5, 'sidechain 应包含父上下文 + 占位 tool_result');
    // 前 4 条 byte-identical
    const check = verifyByteIdenticalPrefix(parentMessages, sideMsgs);
    assert.ok(check.ok, check.detail);
    // 最后 1 条是占位 user message，含 tu-1 的 tool_result
    const placeholder = sideMsgs[sideMsgs.length - 1];
    assert.equal(placeholder.role, 'user');
    if (placeholder.content[0].type === 'tool_result') {
      assert.equal(placeholder.content[0].tool_use_id, 'tu-1' as ToolUseId);
    }

    // 3. 验证返回的 ToolResult 透传 finalText
    assert.equal(getText(result), 'fork result');

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('ForkAgentSpawner spawn: 无 orphan tool_use 时不补占位', async () => {
  await withTempHome(async () => {
    const parentMessages: Message[] = [
      makeMessage({ role: 'user', text: 'q' }),
      makeToolUseMessage('tu-1', 'a', {}),
      makeToolResultMessage('tu-1', 'r'),
      makeMessage({ role: 'assistant', text: 'a' }),
    ];

    const fix = await makeOrchFixture({ parentMessages });

    const { runtimeTaskId } = await fix.taskManager.createDualTrack({
      route: 'fork',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });

    const spawner = new ForkAgentSpawner({
      sidechain: fix.sidechainManager,
      memoryEngine: fix.engine,
      runnerFactory: fix.runnerFactory,
      taskManager: fix.taskManager,
    });

    const result = await spawner.spawn({
      prompt: 'fork prompt',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });

    assert.equal(fix.runner.calls.length, 1);
    const out = await fix.taskManager.getOutput(runtimeTaskId as never);
    const sideMsgs = await fix.sidechainManager.read(out!.sidechainId!);
    // 父 4 条 + 0 占位 = 4 条
    assert.equal(sideMsgs.length, 4);
    const check = verifyByteIdenticalPrefix(parentMessages, sideMsgs);
    assert.ok(check.ok, check.detail);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('ForkAgentSpawner spawn: 父上下文为空时 sidechain 也为空', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({ parentMessages: [] });

    const { runtimeTaskId } = await fix.taskManager.createDualTrack({
      route: 'fork',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });

    const spawner = new ForkAgentSpawner({
      sidechain: fix.sidechainManager,
      memoryEngine: fix.engine,
      runnerFactory: fix.runnerFactory,
      taskManager: fix.taskManager,
    });

    await spawner.spawn({
      prompt: 'from empty parent',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });

    const out = await fix.taskManager.getOutput(runtimeTaskId as never);
    const sideMsgs = await fix.sidechainManager.read(out!.sidechainId!);
    assert.equal(sideMsgs.length, 0, '空父上下文 → 空 sidechain');

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('ForkAgentSpawner: 不变量 #5 byte-identical prefix 多 orphan 场景', async () => {
  await withTempHome(async () => {
    const parentMessages: Message[] = [
      makeMessage({ role: 'user', text: 'init' }),
      makeToolUseMessage('tu-a', 'bash', { cmd: 'ls' }),
      makeToolUseMessage('tu-b', 'bash', { cmd: 'pwd' }),
      makeToolUseMessage('tu-c', 'bash', { cmd: 'whoami' }),
      // 全部 orphan
    ];

    const fix = await makeOrchFixture({ parentMessages });

    const { runtimeTaskId } = await fix.taskManager.createDualTrack({
      route: 'fork',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });

    const spawner = new ForkAgentSpawner({
      sidechain: fix.sidechainManager,
      memoryEngine: fix.engine,
      runnerFactory: fix.runnerFactory,
      taskManager: fix.taskManager,
    });

    await spawner.spawn({
      prompt: 'x',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });

    const out = await fix.taskManager.getOutput(runtimeTaskId as never);
    const sideMsgs = await fix.sidechainManager.read(out!.sidechainId!);
    // 父 4 条 + 占位 1 条（含 3 个 tool_result）= 5 条
    assert.equal(sideMsgs.length, 5);
    const check = verifyByteIdenticalPrefix(parentMessages, sideMsgs);
    assert.ok(check.ok, check.detail);

    // 占位 message 含 3 个 tool_result
    const placeholder = sideMsgs[sideMsgs.length - 1];
    assert.equal(placeholder.content.length, 3);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

// ============================================================
// Orchestrator: 3 路径分发
// ============================================================

test('ForkAgentSpawner: sidechain 通过 walkChainBeforeParse 链路校验（byte-identical 首条 parentUuid=undefined）', async () => {
  await withTempHome(async () => {
    // 父 transcript：正常的链路（首条 parentUuid=undefined，后续指向上一条）
    const parentMessages = makeChain(['parent q', 'parent a']);
    const fix = await makeOrchFixture({ parentMessages });

    const { runtimeTaskId } = await fix.taskManager.createDualTrack({
      route: 'fork',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });

    const spawner = new ForkAgentSpawner({
      sidechain: fix.sidechainManager,
      memoryEngine: fix.engine,
      runnerFactory: fix.runnerFactory,
      taskManager: fix.taskManager,
    });
    await spawner.spawn({
      prompt: 'fork',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });

    const out = await fix.taskManager.getOutput(runtimeTaskId as never);
    await fix.sidechainManager.flush(out!.sidechainId!);

    // 读取 sidechain 文件直接用 TranscriptStore.load 校验链路
    const sideStore = await TranscriptStore.load(
      defaultSidechainPath(fix.sessionId, out!.sidechainId!),
    );
    const check = await sideStore.walkChainBeforeParse();
    assert.ok(check.ok, `sidechain 链路应通过校验（byte-identical 复制）：${check.detail ?? ''}`);

    await sideStore.close();
    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('Orchestrator route sync: 完整流程（创建 task + spawn + 完成）', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({
      runnerResult: { stopReason: 'end_turn', iterations: 1, finalText: 'sync out' },
    });

    const result = await fix.orchestrator.route({
      route: 'sync',
      prompt: 'test sync',
      parentAgentId: 'parent-1' as AgentId,
      traceId: randomUUID() as never,
    });

    assert.equal(result.status, 'completed');
    assert.ok(result.task_id);
    assert.ok(result.work_item_id);
    assert.ok(result.result);
    assert.equal(getText(result.result!), 'sync out');

    // runner 被调用 1 次
    assert.equal(fix.runner.calls.length, 1);

    // TaskManager 状态已更新
    const out = await fix.taskManager.getOutput(result.task_id);
    assert.equal(out?.status, 'completed');

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('Orchestrator route async: 返回 running + 后台完成', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({
      runnerResult: { stopReason: 'end_turn', iterations: 1, finalText: 'async out' },
    });

    const result = await fix.orchestrator.route({
      route: 'async',
      prompt: 'test async',
      parentAgentId: 'parent-1' as AgentId,
      traceId: randomUUID() as never,
    });

    // async 路径立即返回 running
    assert.equal(result.status, 'running');
    assert.ok(result.task_id);
    assert.match(getText(result.result!), /async task started/);

    // 等后台完成
    for (let i = 0; i < 100; i++) {
      const out = await fix.taskManager.getOutput(result.task_id);
      if (out && out.status !== 'running') break;
      await new Promise(r => setTimeout(r, 10));
    }
    const out = await fix.taskManager.getOutput(result.task_id);
    assert.equal(out?.status, 'completed');
    assert.equal(fix.runner.calls.length, 1);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('Orchestrator route fork: 继承父上下文 + 独立 sidechain', async () => {
  await withTempHome(async () => {
    const parentMessages: Message[] = [
      makeMessage({ role: 'user', text: 'parent q' }),
      makeMessage({ role: 'assistant', text: 'parent a' }),
    ];
    const fix = await makeOrchFixture({
      parentMessages,
      runnerResult: { stopReason: 'end_turn', iterations: 1, finalText: 'fork out' },
    });

    const result = await fix.orchestrator.route({
      route: 'fork',
      prompt: 'fork prompt',
      parentAgentId: 'parent-1' as AgentId,
      traceId: randomUUID() as never,
    });

    assert.equal(result.status, 'completed');
    assert.ok(result.result);
    assert.equal(getText(result.result!), 'fork out');

    // sidechain 应包含父上下文（2 条 + 0 占位 = 2 条）
    const out = await fix.taskManager.getOutput(result.task_id);
    const sideMsgs = await fix.sidechainManager.read(out!.sidechainId!);
    assert.equal(sideMsgs.length, 2);
    const check = verifyByteIdenticalPrefix(parentMessages, sideMsgs);
    assert.ok(check.ok, check.detail);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('Orchestrator route: 不支持的 route 返回 failed', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});

    const result = await fix.orchestrator.route({
      route: 'teammate' as never,
      prompt: 'test',
      parentAgentId: 'parent-1' as AgentId,
      traceId: randomUUID() as never,
    });

    assert.equal(result.status, 'failed');
    assert.equal(fix.runner.calls.length, 0);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('Orchestrator route: runner 抛错时标记 task failed', async () => {
  await withTempHome(async () => {
    // runner 返回 failed stopReason → result.is_error=true → task 应标记 failed
    const fix = await makeOrchFixture({
      runnerResult: { stopReason: 'failed', iterations: 0, finalText: '', error: 'boom' },
    });

    const result = await fix.orchestrator.route({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'parent-1' as AgentId,
      traceId: randomUUID() as never,
    });

    // result.is_error=true → status='failed'（M2 iter 3 修正：错误结果不应标记 completed）
    assert.equal(result.status, 'failed');
    assert.equal(result.result?.is_error, true);
    assert.equal(result.result!.is_error, true);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('Orchestrator route: 三路径分发各自调对应 spawner', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});

    // sync
    await fix.orchestrator.route({
      route: 'sync', prompt: 's', parentAgentId: 'p' as AgentId, traceId: 't' as never,
    });
    // async
    await fix.orchestrator.route({
      route: 'async', prompt: 'a', parentAgentId: 'p' as AgentId, traceId: 't' as never,
    });
    // 等 async 完成
    await new Promise(r => setTimeout(r, 50));
    // fork
    await fix.orchestrator.route({
      route: 'fork', prompt: 'f', parentAgentId: 'p' as AgentId, traceId: 't' as never,
    });

    // 3 次调用（async 的后台 spawn 也算 1 次）
    assert.equal(fix.runner.calls.length, 3);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

// ============================================================
// AgentRouterTool
// ============================================================

test('AgentRouterTool: sync 路径返回 task_id + status', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});

    const tool = createAgentRouterTool({
      orchestrator: fix.orchestrator,
      parentAgentId: () => 'parent-1',
      traceIdGen: () => randomUUID(),
    });

    const result = await tool.call(
      { route: 'sync', prompt: 'test sync' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /sync path dispatched/);
    assert.match(text, /task_id/);
    assert.match(text, /status.*completed/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('AgentRouterTool: async 路径返回 running', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    const tool = createAgentRouterTool({
      orchestrator: fix.orchestrator,
      parentAgentId: () => 'parent-1',
    });

    const result = await tool.call(
      { route: 'async', prompt: 'test' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /async path dispatched/);

    // 等后台完成
    await new Promise(r => setTimeout(r, 50));

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('AgentRouterTool: fork 路径正常分发', async () => {
  await withTempHome(async () => {
    const parentMessages = [makeMessage({ role: 'user', text: 'parent' })];
    const fix = await makeOrchFixture({ parentMessages });
    const tool = createAgentRouterTool({
      orchestrator: fix.orchestrator,
      parentAgentId: () => 'parent-1',
    });

    const result = await tool.call(
      { route: 'fork', prompt: 'fork prompt' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, false);
    assert.match(getText(result), /fork path dispatched/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('AgentRouterTool: 缺 route 参数返回 error', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    const tool = createAgentRouterTool({
      orchestrator: fix.orchestrator,
      parentAgentId: () => 'parent-1',
    });

    const result = await tool.call({ prompt: 'test' } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /route is required/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('AgentRouterTool: 缺 prompt 参数返回 error', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    const tool = createAgentRouterTool({
      orchestrator: fix.orchestrator,
      parentAgentId: () => 'parent-1',
    });

    const result = await tool.call({ route: 'sync' } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /prompt is required/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('AgentRouterTool: 不支持的 route 返回 error', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    const tool = createAgentRouterTool({
      orchestrator: fix.orchestrator,
      parentAgentId: () => 'parent-1',
    });

    const result = await tool.call(
      { route: 'invalid_route', prompt: 'x' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, true);
    assert.match(getText(result), /unsupported route/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('AgentRouterTool: remote 路径无 remote_target 返回 error', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    const tool = createAgentRouterTool({
      orchestrator: fix.orchestrator,
      parentAgentId: () => 'parent-1',
    });

    const result = await tool.call(
      { route: 'remote', prompt: 'x' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, true);
    assert.match(getText(result), /remote_target is required/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('AgentRouterTool: remote 路径 + remote_target 成功 dispatch', async () => {
  await withTempHome(async () => {
    // 构造带 remoteAgentClient 的 fixture
    const { RemoteAgentClient, MockSSHClient } = await import('../../src/orchestration/remote-agent-client.js');
    const mockSsh = new MockSSHClient();
    mockSsh.execResult = {
      stdout: 'remote output',
      stderr: '',
      exitCode: 0,
    };
    const remoteAgentClient = new RemoteAgentClient({ sshClient: mockSsh });

    const sessionId = randomUUID();
    const mainPath = path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`);
    const mainStore = await TranscriptStore.load(mainPath);
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainManager = new SidechainManager(engine);
    const taskManager = new TaskManager();

    const { factory: runnerFactory } = makeMockRunnerFactory({
      stopReason: 'end_turn', iterations: 1, finalText: '',
    });

    const orchestrator = new Orchestrator({
      taskManager,
      sidechain: sidechainManager,
      memoryEngine: engine,
      runnerFactory,
      remoteAgentClient,
    });
    const tool = createAgentRouterTool({
      orchestrator,
      parentAgentId: () => 'parent-1',
    });

    const result = await tool.call({
      route: 'remote',
      remote_target: 'user@host',
      prompt: 'run tests',
    } as never, makeCtx());

    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /remote path dispatched/);
    assert.match(text, /"status":\s*"completed"/);

    await engine.closeAll();
    await mainStore.close();
  });
});

test('AgentRouterTool: teammate 路径无 teammate_name 返回 error（不变量 #2）', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    const tool = createAgentRouterTool({
      orchestrator: fix.orchestrator,
      parentAgentId: () => 'parent-1',
    });

    const result = await tool.call(
      { route: 'teammate', prompt: 'do work' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, true);
    assert.match(getText(result), /teammate_name is required/);
    assert.match(getText(result), /invariant #2/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('AgentRouterTool: teammate 路径 + teammate_name 成功 dispatch + 返回 running', async () => {
  await withTempHome(async () => {
    // 构造带 swarmTeam 的 fixture
    const { TeammateRegistry } = await import('../../src/orchestration/teammate-registry.js');
    const { WorktreeRoster, InMemoryWorktreeOps } = await import('../../src/orchestration/worktree-roster.js');
    const { SwarmTeam } = await import('../../src/orchestration/swarm-team.js');
    const { MailboxService } = await import('../../src/orchestration/mailbox-service.js');

    const sessionId = randomUUID();
    const mainPath = path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`);
    const mainStore = await TranscriptStore.load(mainPath);
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainManager = new SidechainManager(engine);
    const taskManager = new TaskManager();
    const teammateRegistry = new TeammateRegistry();
    const mailboxService = new MailboxService();
    const worktreeOps = new InMemoryWorktreeOps(path.join(process.env.HOME!, 'worktrees'));
    const worktreeRoster = new WorktreeRoster(worktreeOps);
    const swarmTeam = new SwarmTeam(mailboxService, teammateRegistry, worktreeRoster);

    const { factory: runnerFactory } = makeMockRunnerFactory({
      stopReason: 'end_turn',
      iterations: 1,
      finalText: '',
    });

    const orchestrator = new Orchestrator({
      taskManager,
      sidechain: sidechainManager,
      memoryEngine: engine,
      runnerFactory,
      swarmTeam,
    });
    const tool = createAgentRouterTool({
      orchestrator,
      parentAgentId: () => 'parent-1',
    });

    const result = await tool.call({
      route: 'teammate',
      teammate_name: 'alice',
      prompt: 'review PR',
    } as never, makeCtx());

    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /teammate path dispatched/);
    assert.match(text, /"status":\s*"running"/);

    // teammate 应已注册
    assert.equal(await teammateRegistry.exists('alice'), true);

    await engine.closeAll();
    await mainStore.close();
  });
});

test('Orchestrator.route: teammate 路径 swarmTeam 未注入返回 error result', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    // fixture 默认不注入 swarmTeam
    const result = await fix.orchestrator.route({
      route: 'teammate',
      prompt: 'do work',
      teammate_name: 'alice' as never,
      parentAgentId: 'parent-1' as never,
      traceId: 'trace-1' as never,
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.result);
    assert.equal(result.result!.is_error, true);
    assert.match(getText(result.result!), /swarmTeam not injected/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('Orchestrator.route: teammate 路径缺 teammate_name 返回 error result（不变量 #2）', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    // 不注入 swarmTeam → 触发 swarmTeam not injected（先检查）
    // 但若注入了 swarmTeam 缺 teammate_name 应触发 name required
    // 这里简化测试：先检查 swarmTeam 注入路径的 teammate_name 校验
    const { TeammateRegistry } = await import('../../src/orchestration/teammate-registry.js');
    const { WorktreeRoster, InMemoryWorktreeOps } = await import('../../src/orchestration/worktree-roster.js');
    const { SwarmTeam } = await import('../../src/orchestration/swarm-team.js');
    const { MailboxService } = await import('../../src/orchestration/mailbox-service.js');

    const teammateRegistry = new TeammateRegistry();
    const mailboxService = new MailboxService();
    const worktreeOps = new InMemoryWorktreeOps(path.join(process.env.HOME!, 'worktrees'));
    const worktreeRoster = new WorktreeRoster(worktreeOps);
    const swarmTeam = new SwarmTeam(mailboxService, teammateRegistry, worktreeRoster);

    // 重新构造 orchestrator with swarmTeam
    const orchestrator = new Orchestrator({
      taskManager: fix.taskManager,
      sidechain: fix.sidechainManager,
      memoryEngine: fix.engine,
      runnerFactory: fix.runnerFactory,
      swarmTeam,
    });

    const result = await orchestrator.route({
      route: 'teammate',
      prompt: 'do work',
      // 不传 teammate_name
      parentAgentId: 'parent-1' as never,
      traceId: 'trace-1' as never,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.result!.is_error, true);
    assert.match(getText(result.result!), /teammate_name/);
    assert.match(getText(result.result!), /invariant #2/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('Orchestrator.route: teammate 路径成功 → registry + worktree 已分配 + task 状态 running', async () => {
  await withTempHome(async () => {
    const { TeammateRegistry } = await import('../../src/orchestration/teammate-registry.js');
    const { WorktreeRoster, InMemoryWorktreeOps } = await import('../../src/orchestration/worktree-roster.js');
    const { SwarmTeam } = await import('../../src/orchestration/swarm-team.js');
    const { MailboxService } = await import('../../src/orchestration/mailbox-service.js');

    const sessionId = randomUUID();
    const mainPath = path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`);
    const mainStore = await TranscriptStore.load(mainPath);
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainManager = new SidechainManager(engine);
    const taskManager = new TaskManager();
    const teammateRegistry = new TeammateRegistry();
    const mailboxService = new MailboxService();
    const worktreeOps = new InMemoryWorktreeOps(path.join(process.env.HOME!, 'worktrees'));
    const worktreeRoster = new WorktreeRoster(worktreeOps);
    const swarmTeam = new SwarmTeam(mailboxService, teammateRegistry, worktreeRoster);

    const { factory: runnerFactory } = makeMockRunnerFactory({
      stopReason: 'end_turn', iterations: 1, finalText: '',
    });

    const orchestrator = new Orchestrator({
      taskManager,
      sidechain: sidechainManager,
      memoryEngine: engine,
      runnerFactory,
      swarmTeam,
    });

    const result = await orchestrator.route({
      route: 'teammate',
      prompt: 'review PR',
      teammate_name: 'alice' as never,
      parentAgentId: 'parent-1' as never,
      traceId: 'trace-1' as never,
    });

    assert.equal(result.status, 'running', 'teammate 路径应返回 running（后台运行）');
    assert.ok(result.result);
    assert.equal(result.result!.is_error, false);
    assert.match(getText(result.result!), /teammate "alice" joined at worktree/);
    assert.match(getText(result.result!), /task_id=/);

    // teammate 已注册
    assert.equal(await teammateRegistry.exists('alice'), true);
    // worktree 已分配
    assert.ok(worktreeRoster.get('alice'));

    // task 状态保持 running（不在 Orchestrator 标记 completed）
    const out = await taskManager.getOutput(result.task_id);
    assert.equal(out!.status, 'running');

    await engine.closeAll();
    await mainStore.close();
  });
});

test('Orchestrator.route: remote 路径 remoteAgentClient 未注入返回 error result', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    // fixture 默认不注入 remoteAgentClient
    const result = await fix.orchestrator.route({
      route: 'remote',
      prompt: 'do work',
      remote_target: 'user@host',
      parentAgentId: 'parent-1' as never,
      traceId: 'trace-1' as never,
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.result);
    assert.equal(result.result!.is_error, true);
    assert.match(getText(result.result!), /remoteAgentClient not injected/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('Orchestrator.route: remote 路径缺 remote_target 返回 error result', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    // 构造注入 remoteAgentClient 的 orchestrator
    const { RemoteAgentClient, MockSSHClient } = await import('../../src/orchestration/remote-agent-client.js');
    const remoteAgentClient = new RemoteAgentClient({ sshClient: new MockSSHClient() });

    const orchestrator = new Orchestrator({
      taskManager: fix.taskManager,
      sidechain: fix.sidechainManager,
      memoryEngine: fix.engine,
      runnerFactory: fix.runnerFactory,
      remoteAgentClient,
    });

    const result = await orchestrator.route({
      route: 'remote',
      prompt: 'do work',
      // 不传 remote_target
      parentAgentId: 'parent-1' as never,
      traceId: 'trace-1' as never,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.result!.is_error, true);
    assert.match(getText(result.result!), /remote_target/);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('Orchestrator.route: remote 路径成功 → task completed + stdout 透传', async () => {
  await withTempHome(async () => {
    const { RemoteAgentClient, MockSSHClient } = await import('../../src/orchestration/remote-agent-client.js');

    const sessionId = randomUUID();
    const mainPath = path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`);
    const mainStore = await TranscriptStore.load(mainPath);
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainManager = new SidechainManager(engine);
    const taskManager = new TaskManager();

    const mockSsh = new MockSSHClient();
    mockSsh.execResult = { stdout: 'remote result', stderr: '', exitCode: 0 };
    const remoteAgentClient = new RemoteAgentClient({ sshClient: mockSsh });

    const { factory: runnerFactory } = makeMockRunnerFactory({
      stopReason: 'end_turn', iterations: 1, finalText: '',
    });

    const orchestrator = new Orchestrator({
      taskManager,
      sidechain: sidechainManager,
      memoryEngine: engine,
      runnerFactory,
      remoteAgentClient,
    });

    const result = await orchestrator.route({
      route: 'remote',
      prompt: 'do work',
      remote_target: 'user@host',
      parentAgentId: 'parent-1' as never,
      traceId: 'trace-1' as never,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.result!.is_error, false);
    assert.match(getText(result.result!), /remote result/);

    // task 应标记 completed
    const out = await taskManager.getOutput(result.task_id);
    assert.equal(out!.status, 'completed');

    await engine.closeAll();
    await mainStore.close();
  });
});

test('Orchestrator.route: remote 路径 unreachable（场景 6）→ task failed', async () => {
  await withTempHome(async () => {
    const { RemoteAgentClient, MockSSHClient } = await import('../../src/orchestration/remote-agent-client.js');

    const sessionId = randomUUID();
    const mainPath = path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`);
    const mainStore = await TranscriptStore.load(mainPath);
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainManager = new SidechainManager(engine);
    const taskManager = new TaskManager();

    const mockSsh = new MockSSHClient();
    mockSsh.permanentConnectFail = true;  // 永远 SSH 失败
    const remoteAgentClient = new RemoteAgentClient({ sshClient: mockSsh });

    const { factory: runnerFactory } = makeMockRunnerFactory({
      stopReason: 'end_turn', iterations: 1, finalText: '',
    });

    const orchestrator = new Orchestrator({
      taskManager,
      sidechain: sidechainManager,
      memoryEngine: engine,
      runnerFactory,
      remoteAgentClient,
    });

    const result = await orchestrator.route({
      route: 'remote',
      prompt: 'do work',
      remote_target: 'user@host',
      parentAgentId: 'parent-1' as never,
      traceId: 'trace-1' as never,
    });

    // unreachable → failed（不变量 #16 场景 6）
    assert.equal(result.status, 'failed');
    assert.equal(result.result!.is_error, true);
    assert.match(getText(result.result!), /remote unreachable/);
    assert.match(getText(result.result!), /invariant #16 scenario 6/);

    const out = await taskManager.getOutput(result.task_id);
    assert.equal(out!.status, 'failed');

    await engine.closeAll();
    await mainStore.close();
  });
});

test('AgentRouterTool: 工具元数据正确', async () => {
  await withTempHome(async () => {
    const fix = await makeOrchFixture({});
    const tool = createAgentRouterTool({
      orchestrator: fix.orchestrator,
      parentAgentId: () => 'parent-1',
    });
    assert.equal(tool.name, 'agent_router');
    assert.equal(tool.isReadOnly, false);
    assert.equal(tool.isDestructive, false);

    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});
