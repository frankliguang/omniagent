import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { TaskManager } from '../../../../src/orchestration/task-manager.js';
import { MailboxService } from '../../../../src/orchestration/mailbox-service.js';
import { TeammateRegistry } from '../../../../src/orchestration/teammate-registry.js';
import { WorktreeRoster, InMemoryWorktreeOps } from '../../../../src/orchestration/worktree-roster.js';
import { SwarmTeam } from '../../../../src/orchestration/swarm-team.js';
import { createTaskCreateTool } from '../../../../src/tools/builtin/orchestration/task-create.js';
import type {
  ToolContext,
  ToolResult,
  ToolUseId,
} from '../../../../src/types/index.js';

// ============================================================
// helpers
// ============================================================

function tmpHome(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-taskcreate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function makeCtx(): ToolContext {
  return {
    cwd: '/tmp',
    permissionMode: 'bypassPermissions',
    agentId: 'leader-agent' as never,
    abortSignal: new AbortController().signal,
    agentRole: 'main',
    toolUseId: 'tu-create-1' as ToolUseId,
  };
}

function getText(result: ToolResult): string {
  const block = result.content[0];
  return block.type === 'text' ? block.text : '';
}

function makeFixture() {
  const taskManager = new TaskManager();
  const mailboxService = new MailboxService();
  const teammateRegistry = new TeammateRegistry();
  const worktreeOps = new InMemoryWorktreeOps(path.join(process.env.HOME!, 'worktrees'));
  const worktreeRoster = new WorktreeRoster(worktreeOps);
  const swarmTeam = new SwarmTeam(mailboxService, teammateRegistry, worktreeRoster);

  const tool = createTaskCreateTool({
    taskManager,
    swarmTeam,
    parentAgentId: () => 'leader-agent-id',
  });
  return {
    tool, taskManager, mailboxService, teammateRegistry, worktreeRoster, swarmTeam,
  };
}

// ============================================================
// 工具元数据
// ============================================================

test('TaskCreateTool: 工具名 + 元数据满足契约', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    assert.equal(tool.name, 'task_create');
    assert.equal(tool.isReadOnly, false);
    assert.equal(tool.isDestructive, false);
    // isConcurrencySafe=false 因为涉及共享状态（registry + worktree）
    assert.equal(tool.isConcurrencySafe, false);
    assert.equal(tool.isBackground, false);
  });
});

test('TaskCreateTool: checkPermissions M2 stub allow', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    const decision = tool.checkPermissions({
      route: 'teammate', teammate_name: 'alice', prompt: 'x',
    } as never);
    assert.equal(decision.decision, 'allow');
    assert.equal(decision.matchedRule, 'm2-stub');
    assert.equal(decision.layer, 2);
  });
});

// ============================================================
// 参数校验
// ============================================================

test('TaskCreateTool: 缺 route 返回 error', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    const result = await tool.call({
      teammate_name: 'alice', prompt: 'x',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /route is required/);
  });
});

test('TaskCreateTool: 非 teammate route 返回 error（M2 iter 2 仅支持 teammate）', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    const result = await tool.call({
      route: 'sync', teammate_name: 'alice', prompt: 'x',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /route "sync" not supported/);
    assert.match(getText(result), /use agent_router/);
  });
});

test('TaskCreateTool: 缺 teammate_name 返回 error（不变量 #2）', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    const result = await tool.call({
      route: 'teammate', prompt: 'x',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /teammate_name is required/);
    assert.match(getText(result), /invariant #2/);
  });
});

test('TaskCreateTool: 缺 prompt 返回 error', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    const result = await tool.call({
      route: 'teammate', teammate_name: 'alice',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /prompt is required/);
  });
});

test('TaskCreateTool: swarmTeam 未注入返回 error', async () => {
  await withTempHome(async () => {
    const taskManager = new TaskManager();
    const tool = createTaskCreateTool({
      taskManager,
      parentAgentId: () => 'leader',
    });
    const result = await tool.call({
      route: 'teammate', teammate_name: 'alice', prompt: 'x',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /swarmTeam not injected/);
  });
});

// ============================================================
// teammate 路径完整流程
// ============================================================

test('TaskCreateTool: teammate 路径成功创建 + 注册 + 分配 worktree', async () => {
  await withTempHome(async () => {
    const { tool, taskManager, teammateRegistry, worktreeRoster } = makeFixture();
    const result = await tool.call({
      route: 'teammate',
      teammate_name: 'alice',
      prompt: 'refactor module X',
    } as never, makeCtx());

    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /teammate "alice" joined team/);
    assert.match(text, /"task_id":\s*"[0-9a-f-]{36}"/);
    assert.match(text, /"work_item_id":\s*"[0-9a-f-]{36}"/);
    assert.match(text, /"agent_id":\s*"[0-9a-f-]{36}"/);
    assert.match(text, /"worktree_path":/);
    assert.match(text, /send_message\(to="alice"/);
    assert.match(text, /task_output\(task_id=/);

    // TaskManager 状态
    const list = await taskManager.listTasks();
    assert.equal(list.length, 1);
    assert.equal(list[0].subtype, 'teammate');
    assert.equal(list[0].status, 'running');

    // Registry 状态
    assert.equal(await teammateRegistry.exists('alice'), true);
    const record = await teammateRegistry.get('alice');
    assert.ok(record);
    assert.equal(record!.parentAgentId, 'leader-agent-id');

    // WorktreeRoster 状态
    const wt = worktreeRoster.get('alice');
    assert.ok(wt, 'alice 应有 worktree');
    assert.equal(wt!.teammateName as string, 'alice');
    assert.ok(wt!.agentId as string, 'agentId 应存在');
    assert.notEqual(wt!.agentId as string, 'leader-agent-id', 'teammate agentId 应不同于父');
    assert.ok(wt!.path.length > 0);
    // getOwner 按 path 反查应返回 alice
    assert.equal(worktreeRoster.getOwner(wt!.path), 'alice');
  });
});

test('TaskCreateTool: 重复 teammate_name 失败（不变量 #2）+ task 标记 failed', async () => {
  await withTempHome(async () => {
    const { tool, taskManager } = makeFixture();
    // 第一次成功
    const r1 = await tool.call({
      route: 'teammate', teammate_name: 'alice', prompt: 'task 1',
    } as never, makeCtx());
    assert.equal(r1.is_error, false);

    // 第二次同名失败
    const r2 = await tool.call({
      route: 'teammate', teammate_name: 'alice', prompt: 'task 2',
    } as never, makeCtx());
    assert.equal(r2.is_error, true);
    assert.match(getText(r2), /joinTeam failed/);

    // 第二次的 task 应标记为 failed
    const list = await taskManager.listTasks();
    assert.equal(list.length, 2);
    const failedTask = list.find(t => t.status === 'failed');
    assert.ok(failedTask, '应有 failed task');
  });
});

test('TaskCreateTool: 多 teammate 并行注册', async () => {
  await withTempHome(async () => {
    const { tool, teammateRegistry } = makeFixture();
    const [r1, r2, r3] = await Promise.all([
      tool.call({ route: 'teammate', teammate_name: 'alice', prompt: 'a' } as never, makeCtx()),
      tool.call({ route: 'teammate', teammate_name: 'bob', prompt: 'b' } as never, makeCtx()),
      tool.call({ route: 'teammate', teammate_name: 'carol', prompt: 'c' } as never, makeCtx()),
    ]);
    assert.equal(r1.is_error, false);
    assert.equal(r2.is_error, false);
    assert.equal(r3.is_error, false);

    assert.equal(teammateRegistry.size(), 3);
    assert.equal(await teammateRegistry.exists('alice'), true);
    assert.equal(await teammateRegistry.exists('bob'), true);
    assert.equal(await teammateRegistry.exists('carol'), true);
  });
});

test('TaskCreateTool: 创建后 send_message 可达（mailbox 已就绪）', async () => {
  await withTempHome(async () => {
    const { tool, mailboxService } = makeFixture();
    const r = await tool.call({
      route: 'teammate', teammate_name: 'alice', prompt: 'do work',
    } as never, makeCtx());
    assert.equal(r.is_error, false);

    // 现在可以给 alice 发消息
    const sendResult = await mailboxService.sendText('leader', 'alice', 'start working');
    assert.equal(sendResult.written, true);

    const msgs = await mailboxService.readUnread('alice');
    assert.equal(msgs.length, 1);
    assert.equal((msgs[0].payload as { text: string }).text, 'start working');
  });
});

test('TaskCreateTool: metadata.compactable=false（不可压缩）', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    const result = await tool.call({
      route: 'teammate', teammate_name: 'alice', prompt: 'x',
    } as never, makeCtx());
    assert.equal(result.metadata?.compactable, false);
  });
});
