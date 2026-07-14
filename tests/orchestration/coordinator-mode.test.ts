import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  CoordinatorMode,
  spawnSync,
} from '../../src/orchestration/coordinator-mode.js';
import { TaskManager } from '../../src/orchestration/task-manager.js';
import {
  LocalMemoryEngine,
  SidechainManager,
} from '../../src/memory/sidechain.js';
import { TranscriptStore } from '../../src/memory/transcript.js';
import { buildTool } from '../../src/tools/build-tool.js';
import type {
  AgentId,
  Tool,
  ToolResult,
  ToolUseId,
  UUID,
} from '../../src/types/index.js';
import type {
  SubAgentRunner,
  SubAgentRunnerFactory,
  SubAgentTurnResult,
} from '../../src/orchestration/sub-agent-runner.js';

// ============================================================
// helpers
// ============================================================

function tmpHome(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-coord-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function makeTool(name: string): Tool {
  return buildTool({
    name,
    description: `tool ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isBackground: false,
    checkPermissions: () => ({ decision: 'allow', matchedRule: 'test', layer: 2 }),
    call: async () => ({
      tool_use_id: '' as ToolUseId,
      content: [{ type: 'text', text: 'ok' }],
      is_error: false,
    }),
  });
}

function getText(result: ToolResult): string {
  const block = result.content[0];
  return block.type === 'text' ? block.text : '';
}

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

async function makeCoordinatorFixture(opts: {
  baseTools?: Tool[];
  runnerResult?: SubAgentTurnResult;
}) {
  const sessionId = randomUUID();
  const mainPath = path.join(
    process.env.HOME!,
    '.omniagent',
    'transcript',
    `${sessionId}.jsonl`,
  );
  const mainStore = await TranscriptStore.load(mainPath);
  const engine = new LocalMemoryEngine(sessionId, mainStore);
  const sidechainManager = new SidechainManager(engine);
  const taskManager = new TaskManager();

  const result =
    opts.runnerResult ??
    ({ stopReason: 'end_turn' as const, iterations: 1, finalText: 'ok' });
  const { factory: runnerFactory, runner } = makeMockRunnerFactory(result);

  const coordinator = new CoordinatorMode(
    sidechainManager,
    taskManager,
    runnerFactory,
    opts.baseTools,
  );

  return { coordinator, taskManager, sidechainManager, runner, sessionId };
}

// ============================================================
// getCoordinatorToolPool: 不变量 #4 — 移除被禁工具
// ============================================================

test('CoordinatorMode.getCoordinatorToolPool: 无 baseTools → 返回空数组', async () => {
  await withTempHome(async () => {
    const { coordinator } = await makeCoordinatorFixture({});
    assert.deepEqual(coordinator.getCoordinatorToolPool(), []);
  });
});

test('CoordinatorMode.getCoordinatorToolPool: 含 bash/edit_file/write_file → 全部移除', async () => {
  await withTempHome(async () => {
    const baseTools = [
      makeTool('bash'),
      makeTool('edit_file'),
      makeTool('write_file'),
      makeTool('read_file'),
      makeTool('grep'),
      makeTool('agent_router'),
    ];
    const { coordinator } = await makeCoordinatorFixture({ baseTools });
    const pool = coordinator.getCoordinatorToolPool();
    const names = pool.map((t) => t.name);
    assert.deepEqual(names.sort(), ['agent_router', 'grep', 'read_file'].sort());
    assert.equal(names.includes('bash'), false);
    assert.equal(names.includes('edit_file'), false);
    assert.equal(names.includes('write_file'), false);
  });
});

test('CoordinatorMode.getCoordinatorToolPool: 不变量 #4 守护 — filtered 池绝不含被禁工具', async () => {
  await withTempHome(async () => {
    // 测试多次：随机组合工具
    const testCases: Tool[][] = [
      [makeTool('bash'), makeTool('read_file')],
      [makeTool('edit_file'), makeTool('write_file'), makeTool('grep')],
      [makeTool('bash'), makeTool('bash'), makeTool('write_file')], // 重复也都移除
      [makeTool('agent_router'), makeTool('send_message'), makeTool('task_create')],
    ];
    for (const baseTools of testCases) {
      const { coordinator } = await makeCoordinatorFixture({ baseTools });
      const pool = coordinator.getCoordinatorToolPool();
      for (const t of pool) {
        assert.notEqual(t.name, 'bash', `filtered pool 不应含 bash`);
        assert.notEqual(t.name, 'edit_file', `filtered pool 不应含 edit_file`);
        assert.notEqual(t.name, 'write_file', `filtered pool 不应含 write_file`);
      }
    }
  });
});

test('CoordinatorMode.getCoordinatorToolPool: 保留编排工具', async () => {
  await withTempHome(async () => {
    const baseTools = [
      makeTool('agent_router'),
      makeTool('send_message'),
      makeTool('task_create'),
      makeTool('task_stop'),
      makeTool('task_output'),
    ];
    const { coordinator } = await makeCoordinatorFixture({ baseTools });
    const pool = coordinator.getCoordinatorToolPool();
    const names = pool.map((t) => t.name);
    // 编排工具全部保留
    for (const n of names) {
      assert.ok(
        ['agent_router', 'send_message', 'task_create', 'task_stop', 'task_output'].includes(n),
        `编排工具 ${n} 应被保留`,
      );
    }
    assert.equal(names.length, 5);
  });
});

// ============================================================
// assertCoordinatorInvariant: 静态 fail-closed 守护器
// ============================================================

test('CoordinatorMode.assertCoordinatorInvariant: 无违规 → 不抛错', () => {
  const pool = [makeTool('read_file'), makeTool('grep')];
  CoordinatorMode.assertCoordinatorInvariant(pool); // 不抛
});

test('CoordinatorMode.assertCoordinatorInvariant: 含 bash → 抛错', () => {
  const pool = [makeTool('bash'), makeTool('read_file')];
  assert.throws(
    () => CoordinatorMode.assertCoordinatorInvariant(pool),
    /invariant #4 violated/,
  );
});

test('CoordinatorMode.assertCoordinatorInvariant: 含 edit_file → 抛错', () => {
  const pool = [makeTool('edit_file')];
  assert.throws(
    () => CoordinatorMode.assertCoordinatorInvariant(pool),
    /invariant #4 violated/,
  );
});

test('CoordinatorMode.assertCoordinatorInvariant: 含 write_file → 抛错', () => {
  const pool = [makeTool('write_file')];
  assert.throws(
    () => CoordinatorMode.assertCoordinatorInvariant(pool),
    /invariant #4 violated/,
  );
});

test('CoordinatorMode.assertCoordinatorInvariant: 错误消息含被禁工具名', () => {
  const pool = [makeTool('bash'), makeTool('edit_file')];
  try {
    CoordinatorMode.assertCoordinatorInvariant(pool);
    assert.fail('应抛错');
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(msg.includes('bash'), '错误消息应含 bash');
    assert.ok(msg.includes('edit_file'), '错误消息应含 edit_file');
  }
});

// ============================================================
// spawnSync: 入口 fail-closed 守护
// ============================================================

test('CoordinatorMode.spawnSync: 无 baseTools → 不守护，正常 spawn', async () => {
  await withTempHome(async () => {
    const { coordinator, taskManager, runner } = await makeCoordinatorFixture({});
    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });
    const result = await coordinator.spawnSync({
      route: 'sync',
      prompt: 'test',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });
    assert.equal(result.is_error, false);
    assert.equal(runner.calls.length, 1);
  });
});

test('CoordinatorMode.spawnSync: baseTools 合规 → 正常 spawn', async () => {
  await withTempHome(async () => {
    const baseTools = [makeTool('read_file'), makeTool('agent_router')];
    const { coordinator, taskManager, runner } = await makeCoordinatorFixture({ baseTools });

    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });
    const result = await coordinator.spawnSync({
      route: 'sync',
      prompt: 'test',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });
    assert.equal(result.is_error, false);
    assert.equal(runner.calls.length, 1);
  });
});

test('CoordinatorMode.spawnSync: baseTools 含 bash → filtered 仍合规 → 正常 spawn（守护通过）', async () => {
  await withTempHome(async () => {
    // baseTools 含 bash，但 mergeAndFilterTools 会过滤掉 → filtered 池合规 → 守护通过
    const baseTools = [makeTool('bash'), makeTool('read_file')];
    const { coordinator, taskManager, runner } = await makeCoordinatorFixture({ baseTools });

    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });
    const result = await coordinator.spawnSync({
      route: 'sync',
      prompt: 'test',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });
    // 守护通过（mergeAndFilterTools 已移除 bash）
    assert.equal(result.is_error, false);
    assert.equal(runner.calls.length, 1);
  });
});

// ============================================================
// spawnAsync: 入口 fail-closed 守护
// ============================================================

test('CoordinatorMode.spawnAsync: 无 baseTools → 不守护，立即返回 task_id', async () => {
  await withTempHome(async () => {
    const { coordinator, taskManager, runner } = await makeCoordinatorFixture({});
    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'async',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });
    const result = await coordinator.spawnAsync({
      route: 'async',
      prompt: 'test',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });
    assert.equal(result.is_error, false);
    assert.match(getText(result), /async task started/);

    // 等后台完成
    for (let i = 0; i < 100; i++) {
      const out = await taskManager.getOutput(runtimeTaskId as never);
      if (out && out.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(runner.calls.length, 1);
  });
});

test('CoordinatorMode.spawnAsync: baseTools 合规 → 正常 spawn', async () => {
  await withTempHome(async () => {
    const baseTools = [makeTool('read_file')];
    const { coordinator, taskManager, runner } = await makeCoordinatorFixture({ baseTools });
    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'async',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });
    const result = await coordinator.spawnAsync({
      route: 'async',
      prompt: 'test',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });
    assert.equal(result.is_error, false);

    for (let i = 0; i < 100; i++) {
      const out = await taskManager.getOutput(runtimeTaskId as never);
      if (out && out.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(runner.calls.length, 1);
  });
});

// ============================================================
// 集成：spawnSync 端到端
// ============================================================

test('CoordinatorMode.spawnSync: 端到端 — coordinator + sidechain + runner + flush', async () => {
  await withTempHome(async () => {
    const baseTools = [
      makeTool('bash'),       // 应被过滤
      makeTool('edit_file'),  // 应被过滤
      makeTool('write_file'), // 应被过滤
      makeTool('read_file'),  // 保留
      makeTool('agent_router'), // 保留
    ];
    const { coordinator, taskManager, runner, sidechainManager } = await makeCoordinatorFixture({
      baseTools,
      runnerResult: { stopReason: 'end_turn', iterations: 2, finalText: 'sub-agent done' },
    });

    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'sync',
      prompt: 'list files',
      parentAgentId: 'parent-1',
    });

    const result = await coordinator.spawnSync({
      route: 'sync',
      prompt: 'list files',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });

    // 守护通过（mergeAndFilterTools 已过滤 bash/edit_file/write_file）
    assert.equal(result.is_error, false);
    assert.equal(getText(result), 'sub-agent done');
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].prompt, 'list files');

    // sidechain 已关联
    const out = await taskManager.getOutput(runtimeTaskId as never);
    assert.ok(out?.sidechainId, 'sidechainId 应已设置');

    await sidechainManager.closeAll?.();
  });
});

// ============================================================
// 向后兼容：旧调用方（无 baseTools）仍可工作
// ============================================================

test('CoordinatorMode: 4 参数构造（无 baseTools）→ 兼容 M2 iter 1/2 调用方', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainManager = new SidechainManager(engine);
    const taskManager = new TaskManager();
    const { factory } = makeMockRunnerFactory({
      stopReason: 'end_turn',
      iterations: 1,
      finalText: 'ok',
    });

    // 4 参数构造（无 baseTools）— 兼容性测试
    const coordinator = new CoordinatorMode(sidechainManager, taskManager, factory);

    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });

    const result = await coordinator.spawnSync({
      route: 'sync',
      prompt: 'test',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
    });
    assert.equal(result.is_error, false);

    await engine.closeAll();
    await mainStore.close();
  });
});

test('CoordinatorMode: spawnSync 函数式 API 仍可独立调用（向后兼容）', async () => {
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
      iterations: 1,
      finalText: 'fn-style ok',
    });

    const { runtimeTaskId } = await taskManager.createDualTrack({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'parent-1',
    });

    // 直接调用 spawnSync 函数（不经 CoordinatorMode 类）
    const result = await spawnSync({
      route: 'sync',
      prompt: 'test',
      runtimeTaskId,
      parentAgentId: 'parent-1' as AgentId,
      sidechain: sidechainManager,
      taskManager,
      runnerFactory: factory,
    });
    assert.equal(result.is_error, false);
    assert.equal(getText(result), 'fn-style ok');
    assert.equal(runner.calls.length, 1);

    await engine.closeAll();
    await mainStore.close();
  });
});
