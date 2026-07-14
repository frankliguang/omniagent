import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { TaskManager } from '../../../../src/orchestration/task-manager.js';
import {
  LocalMemoryEngine,
  SidechainManager,
  defaultSidechainPath,
} from '../../../../src/memory/sidechain.js';
import { TranscriptStore } from '../../../../src/memory/transcript.js';
import { createTaskOutputTool } from '../../../../src/tools/builtin/orchestration/task-output.js';
import type {
  ContentBlock,
  Message,
  ToolContext,
  ToolResult,
  ToolUseId,
  UUID,
} from '../../../../src/types/index.js';

// ============================================================
// helpers
// ============================================================

function tmpHome(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-taskoutput-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

async function makeToolFixture(opts: {
  route?: 'sync' | 'async' | 'fork';
  withSidechain?: boolean;
  initialMessages?: Message[];
}) {
  const sessionId = randomUUID();
  const mainPath = path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`);
  const mainStore = await TranscriptStore.load(mainPath);
  const engine = new LocalMemoryEngine(sessionId, mainStore);
  const sidechainManager = new SidechainManager(engine);
  const taskManager = new TaskManager();

  const { runtimeTaskId } = await taskManager.createDualTrack({
    route: opts.route ?? 'fork',
    prompt: 'test task',
    parentAgentId: 'test-agent',
  });

  let sidechainId: UUID | undefined;
  if (opts.withSidechain) {
    sidechainId = await sidechainManager.create({
      parentTranscriptId: 'test-agent' as never,
      runtimeTaskId: runtimeTaskId as never,
      initialMessages: opts.initialMessages ?? [makeMessage({ role: 'user', text: 'init' })],
    });
    await taskManager.setSidechain(runtimeTaskId as never, sidechainId);
  }

  const tool = createTaskOutputTool({ taskManager, sidechainManager });
  return { tool, taskManager, sidechainManager, engine, mainStore, runtimeTaskId, sidechainId };
}

// ============================================================
// TaskManager 单元测试
// ============================================================

test('TaskManager: createDualTrack 返回 workItemId + runtimeTaskId', async () => {
  await withTempHome(async () => {
    const tm = new TaskManager();
    const handle = await tm.createDualTrack({
      route: 'fork',
      prompt: 'test',
      parentAgentId: 'a1',
    });
    assert.ok(handle.workItemId);
    assert.ok(handle.runtimeTaskId);
    assert.notEqual(handle.workItemId, handle.runtimeTaskId);
  });
});

test('TaskManager: getOutput 未完成返回 status=running', async () => {
  await withTempHome(async () => {
    const tm = new TaskManager();
    const { runtimeTaskId } = await tm.createDualTrack({
      route: 'async',
      prompt: 'long task',
      parentAgentId: 'a1',
    });
    const out = await tm.getOutput(runtimeTaskId as never);
    assert.ok(out);
    assert.equal(out!.status, 'running');
    assert.equal(out!.subtype, 'async');
    assert.ok(out!.startedAt);
    assert.equal(out!.finishedAt, undefined);
  });
});

test('TaskManager: completeTask 保存 result', async () => {
  await withTempHome(async () => {
    const tm = new TaskManager();
    const { runtimeTaskId } = await tm.createDualTrack({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'a1',
    });
    const result: ToolResult = {
      tool_use_id: '' as ToolUseId,
      content: [{ type: 'text', text: 'task done' }],
      is_error: false,
    };
    await tm.completeTask(runtimeTaskId as never, result);

    const out = await tm.getOutput(runtimeTaskId as never);
    assert.equal(out!.status, 'completed');
    assert.ok(out!.finishedAt);
    assert.equal(out!.result, result);
  });
});

test('TaskManager: failTask 保存 error', async () => {
  await withTempHome(async () => {
    const tm = new TaskManager();
    const { runtimeTaskId } = await tm.createDualTrack({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'a1',
    });
    await tm.failTask(runtimeTaskId as never, 'mock failure');

    const out = await tm.getOutput(runtimeTaskId as never);
    assert.equal(out!.status, 'failed');
    assert.equal(out!.error, 'mock failure');
  });
});

test('TaskManager: setSidechain 关联 sidechainId', async () => {
  await withTempHome(async () => {
    const tm = new TaskManager();
    const { runtimeTaskId } = await tm.createDualTrack({
      route: 'fork',
      prompt: 'test',
      parentAgentId: 'a1',
    });
    const sidechainId = randomUUID() as UUID;
    await tm.setSidechain(runtimeTaskId as never, sidechainId);

    const out = await tm.getOutput(runtimeTaskId as never);
    assert.equal(out!.sidechainId, sidechainId);
  });
});

test('TaskManager: getOutput 不存在的 task 返回 undefined', async () => {
  await withTempHome(async () => {
    const tm = new TaskManager();
    const out = await tm.getOutput('nonexistent' as never);
    assert.equal(out, undefined);
  });
});

test('TaskManager: setSidechain 不存在的 task 抛错', async () => {
  await withTempHome(async () => {
    const tm = new TaskManager();
    await assert.rejects(
      () => tm.setSidechain('nonexistent' as never, randomUUID() as UUID),
      /task not found/,
    );
  });
});

test('TaskManager: completeTask 不存在的 task 抛错', async () => {
  await withTempHome(async () => {
    const tm = new TaskManager();
    await assert.rejects(
      () => tm.completeTask('nonexistent' as never),
      /task not found/,
    );
  });
});

test('TaskManager: listTasks 返回全部 RuntimeTask', async () => {
  await withTempHome(async () => {
    const tm = new TaskManager();
    await tm.createDualTrack({ route: 'sync', prompt: 't1', parentAgentId: 'a' });
    await tm.createDualTrack({ route: 'async', prompt: 't2', parentAgentId: 'a' });
    const list = await tm.listTasks();
    assert.equal(list.length, 2);
  });
});

// ============================================================
// TaskOutputTool 测试
// ============================================================

test('TaskOutputTool: running 状态返回 still running', async () => {
  await withTempHome(async () => {
    const fix = await makeToolFixture({ route: 'async' });
    const result = await fix.tool.call({ task_id: fix.runtimeTaskId } as never, makeCtx());
    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /still running/);
    assert.match(text, /status: running/);
    assert.match(text, /subtype: async/);
    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('TaskOutputTool: completed + inline result 透传 result 内容', async () => {
  await withTempHome(async () => {
    const fix = await makeToolFixture({ route: 'sync' });
    const taskResult: ToolResult = {
      tool_use_id: '' as ToolUseId,
      content: [{ type: 'text', text: 'sync output text' }],
      is_error: false,
    };
    await fix.taskManager.completeTask(fix.runtimeTaskId as never, taskResult);

    const result = await fix.tool.call({ task_id: fix.runtimeTaskId } as never, makeCtx());
    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /completed/);
    assert.match(text, /sync output text/);
    assert.equal(result.metadata?.compactable, true);
    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('TaskOutputTool: completed + sidechain 无 inline result 读 sidechain 最后 assistant', async () => {
  await withTempHome(async () => {
    const initialMessages: Message[] = [
      makeMessage({ role: 'user', text: 'fork prompt', parentUuid: 'fork-1' as UUID }),
      makeMessage({ role: 'assistant', text: 'first response' }),
      makeMessage({ role: 'user', text: 'continue' }),
      makeMessage({ role: 'assistant', text: 'final answer from sidechain' }),
    ];
    const fix = await makeToolFixture({
      route: 'fork',
      withSidechain: true,
      initialMessages,
    });
    // 标记完成（无 inline result）
    await fix.taskManager.completeTask(fix.runtimeTaskId as never);

    const result = await fix.tool.call({ task_id: fix.runtimeTaskId } as never, makeCtx());
    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /completed/);
    assert.match(text, /final answer from sidechain/);
    assert.match(text, /from sidechain/);
    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('TaskOutputTool: completed + sidechain 无 assistant 消息返回状态', async () => {
  await withTempHome(async () => {
    const fix = await makeToolFixture({
      route: 'fork',
      withSidechain: true,
      initialMessages: [makeMessage({ role: 'user', text: 'only user msg' })],
    });
    await fix.taskManager.completeTask(fix.runtimeTaskId as never);

    const result = await fix.tool.call({ task_id: fix.runtimeTaskId } as never, makeCtx());
    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /completed but sidechain has no assistant output/);
    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('TaskOutputTool: failed 状态返回 error 信息', async () => {
  await withTempHome(async () => {
    const fix = await makeToolFixture({ route: 'sync' });
    await fix.taskManager.failTask(fix.runtimeTaskId as never, 'some error message');

    const result = await fix.tool.call({ task_id: fix.runtimeTaskId } as never, makeCtx());
    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /ended with failed/);
    assert.match(text, /some error message/);
    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('TaskOutputTool: task 不存在返回 error', async () => {
  await withTempHome(async () => {
    const fix = await makeToolFixture({ route: 'sync' });
    const result = await fix.tool.call({ task_id: 'nonexistent-task' } as never, makeCtx());
    assert.equal(result.is_error, true);
    const text = getText(result);
    assert.match(text, /task not found/);
    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('TaskOutputTool: 缺 task_id 参数返回 error', async () => {
  await withTempHome(async () => {
    const fix = await makeToolFixture({ route: 'sync' });
    const result = await fix.tool.call({} as never, makeCtx());
    assert.equal(result.is_error, true);
    const text = getText(result);
    assert.match(text, /task_id is required/);
    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('TaskOutputTool: 工具元数据满足 COMPACTABLE_TOOLS 白名单', async () => {
  await withTempHome(async () => {
    const fix = await makeToolFixture({ route: 'sync' });
    assert.equal(fix.tool.name, 'task_output');
    assert.equal(fix.tool.isReadOnly, true);
    assert.equal(fix.tool.isDestructive, false);
    // call 后 metadata.compactable 应为 true
    const result = await fix.tool.call({ task_id: fix.runtimeTaskId } as never, makeCtx());
    assert.equal(result.metadata?.compactable, true);
    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('TaskOutputTool: 多次调用返回一致结果（幂等只读）', async () => {
  await withTempHome(async () => {
    const fix = await makeToolFixture({ route: 'sync' });
    const taskResult: ToolResult = {
      tool_use_id: '' as ToolUseId,
      content: [{ type: 'text', text: 'stable output' }],
      is_error: false,
    };
    await fix.taskManager.completeTask(fix.runtimeTaskId as never, taskResult);

    const r1 = await fix.tool.call({ task_id: fix.runtimeTaskId } as never, makeCtx());
    const r2 = await fix.tool.call({ task_id: fix.runtimeTaskId } as never, makeCtx());
    assert.equal(getText(r1), getText(r2), '幂等调用结果一致');
    await fix.engine.closeAll();
    await fix.mainStore.close();
  });
});

test('TaskOutputTool: sidechain 读取失败优雅降级', async () => {
  await withTempHome(async () => {
    // 构造一个 sidechain 但不写入消息，然后 close 掉 sidechain store，模拟读取失败
    const fix = await makeToolFixture({
      route: 'fork',
      withSidechain: true,
      initialMessages: [makeMessage({ role: 'user', text: 'init' })],
    });
    await fix.taskManager.completeTask(fix.runtimeTaskId as never);
    // close sidechain 使后续 read 抛错
    await fix.engine.closeAll();

    // 由于 sidechain store 已被 close（从 Map 移除），read 会抛 'sidechain not found'
    // 但 tool 持有的是 SidechainManager（委托 engine），engine 已 close
    // 重新构造一个 engine + manager 让其能找到 sidechain
    const sessionId = fix.mainStore.path.match(/\/transcript\/([^.]+)\.jsonl$/)?.[1] ?? '';
    const newMainStore = await TranscriptStore.load(fix.mainStore.path);
    const newEngine = new LocalMemoryEngine(sessionId, newMainStore);
    const newSidechainManager = new SidechainManager(newEngine);
    // 新 engine 没有 sidechain，read 会抛错
    const newTool = createTaskOutputTool({
      taskManager: fix.taskManager,
      sidechainManager: newSidechainManager,
    });
    const result = await newTool.call({ task_id: fix.runtimeTaskId } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /failed to read sidechain/);
    await newEngine.closeAll();
    await newMainStore.close();
    await fix.mainStore.close();
  });
});
