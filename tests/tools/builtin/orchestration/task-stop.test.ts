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
import { ShutdownHandshake } from '../../../../src/orchestration/shutdown-handshake.js';
import { ThreeStateRecovery } from '../../../../src/orchestration/three-state-recovery.js';
import { createTaskStopTool } from '../../../../src/tools/builtin/orchestration/task-stop.js';
import { createTaskCreateTool } from '../../../../src/tools/builtin/orchestration/task-create.js';
import type {
  MailboxName,
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
    `omniagent-taskstop-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    toolUseId: 'tu-stop-1' as ToolUseId,
  };
}

function getText(result: ToolResult): string {
  const block = result.content[0];
  return block.type === 'text' ? block.text : '';
}

interface Fixture {
  taskManager: TaskManager;
  mailboxService: MailboxService;
  teammateRegistry: TeammateRegistry;
  worktreeRoster: WorktreeRoster;
  swarmTeam: SwarmTeam;
  shutdownHandshake: ShutdownHandshake;
  threeStateRecovery: ThreeStateRecovery;
  taskCreateTool: ReturnType<typeof createTaskCreateTool>;
  taskStopTool: ReturnType<typeof createTaskStopTool>;
  /** cleanup 是否被调用（getter，保持引用） */
  isCleanupCalled: () => boolean;
}

function makeFixture(opts: { pollIntervalMs?: number } = {}): Fixture {
  const taskManager = new TaskManager();
  const mailboxService = new MailboxService();
  const teammateRegistry = new TeammateRegistry();
  const worktreeOps = new InMemoryWorktreeOps(path.join(process.env.HOME!, 'worktrees'));
  const worktreeRoster = new WorktreeRoster(worktreeOps);
  const swarmTeam = new SwarmTeam(mailboxService, teammateRegistry, worktreeRoster);

  const cleanupState = { called: false };
  const shutdownHandshake = new ShutdownHandshake(mailboxService, {
    pollIntervalMs: opts.pollIntervalMs ?? 10,
    cleanup: async () => { cleanupState.called = true; },
  });

  const threeStateRecovery = new ThreeStateRecovery(
    teammateRegistry,
    mailboxService,
    worktreeRoster,
    taskManager,
  );

  const taskCreateTool = createTaskCreateTool({
    taskManager,
    swarmTeam,
    parentAgentId: () => 'leader-agent-id',
  });
  const taskStopTool = createTaskStopTool({
    taskManager,
    shutdownHandshake,
    threeStateRecovery,
    teammateRegistry,
    parentAgentId: () => 'leader-agent-id',
    leaderName: () => 'leader' as MailboxName,
  });

  return {
    taskManager, mailboxService, teammateRegistry, worktreeRoster,
    swarmTeam, shutdownHandshake, threeStateRecovery,
    taskCreateTool, taskStopTool,
    isCleanupCalled: () => cleanupState.called,
  };
}

async function createTeammate(fixture: Fixture, name: string): Promise<string> {
  const r = await fixture.taskCreateTool.call({
    route: 'teammate',
    teammate_name: name,
    prompt: 'do work',
  } as never, makeCtx());
  assert.equal(r.is_error, false);
  // 提取 task_id
  const match = getText(r).match(/"task_id":\s*"([0-9a-f-]{36})"/);
  assert.ok(match, 'task_id 应在响应中');
  return match![1];
}

// ============================================================
// 工具元数据
// ============================================================

test('TaskStopTool: 工具名 + 元数据满足契约', async () => {
  await withTempHome(async () => {
    const { taskStopTool } = makeFixture();
    assert.equal(taskStopTool.name, 'task_stop');
    assert.equal(taskStopTool.isReadOnly, false);
    assert.equal(taskStopTool.isDestructive, true);  // 不可逆
    assert.equal(taskStopTool.isConcurrencySafe, false);
    assert.equal(taskStopTool.isBackground, false);
  });
});

test('TaskStopTool: checkPermissions M2 stub allow', async () => {
  await withTempHome(async () => {
    const { taskStopTool } = makeFixture();
    const decision = taskStopTool.checkPermissions({
      task_id: 'task-1', strategy: 'graceful',
    } as never);
    assert.equal(decision.decision, 'allow');
    assert.equal(decision.matchedRule, 'm2-stub');
    assert.equal(decision.layer, 2);
  });
});

// ============================================================
// 参数校验
// ============================================================

test('TaskStopTool: 缺 task_id 返回 error', async () => {
  await withTempHome(async () => {
    const { taskStopTool } = makeFixture();
    const result = await taskStopTool.call({
      strategy: 'graceful',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /task_id is required/);
  });
});

test('TaskStopTool: 缺 strategy 返回 error', async () => {
  await withTempHome(async () => {
    const { taskStopTool } = makeFixture();
    const result = await taskStopTool.call({
      task_id: 'task-1',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /strategy must be/);
  });
});

test('TaskStopTool: 非法 strategy 返回 error', async () => {
  await withTempHome(async () => {
    const { taskStopTool } = makeFixture();
    const result = await taskStopTool.call({
      task_id: 'task-1', strategy: 'invalid',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /strategy must be/);
  });
});

test('TaskStopTool: 不存在的 task 返回 error', async () => {
  await withTempHome(async () => {
    const { taskStopTool } = makeFixture();
    const result = await taskStopTool.call({
      task_id: 'nonexistent', strategy: 'graceful', teammate_name: 'alice',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /task not found/);
  });
});

test('TaskStopTool: task 已完成（非 running）幂等返回 no action', async () => {
  await withTempHome(async () => {
    const fixture = makeFixture();
    const taskId = await createTeammate(fixture, 'alice');
    await fixture.taskManager.completeTask(taskId as never);

    const result = await fixture.taskStopTool.call({
      task_id: taskId, strategy: 'graceful', teammate_name: 'alice',
    } as never, makeCtx());
    assert.equal(result.is_error, false);
    assert.match(getText(result), /already in status=completed/);
    assert.match(getText(result), /no action/);
  });
});

// ============================================================
// graceful 路径
// ============================================================

test('TaskStopTool: graceful + approve → task 标记 completed + cleanup 触发', async () => {
  await withTempHome(async () => {
    const fixture = makeFixture();
    const taskId = await createTeammate(fixture, 'alice');

    // 异步触发 teammate handleRequest（approve=true，无 pending work）
    setImmediate(() => {
      void fixture.shutdownHandshake.handleRequest('alice' as MailboxName, 'placeholder', {
        leaderName: 'leader' as MailboxName,
        agentId: 'agent-alice' as never,
        hasPendingWork: false,
      }).catch(() => {});
    });

    const result = await fixture.taskStopTool.call({
      task_id: taskId, strategy: 'graceful', teammate_name: 'alice',
      timeout_ms: 5000,
    } as never, makeCtx());

    assert.equal(result.is_error, false);
    assert.match(getText(result), /graceful shutdown approved/);
    assert.match(getText(result), /"approve":true/);

    // task 标记 completed
    const out = await fixture.taskManager.getOutput(taskId as never);
    assert.equal(out!.status, 'completed');

    // cleanup 被调用
    assert.equal(fixture.isCleanupCalled(), true);
  });
});

test('TaskStopTool: graceful + reject（pending work）→ task 继续运行（不强杀）', async () => {
  await withTempHome(async () => {
    const fixture = makeFixture();
    const taskId = await createTeammate(fixture, 'alice');

    setImmediate(() => {
      void fixture.shutdownHandshake.handleRequest('alice' as MailboxName, 'placeholder', {
        leaderName: 'leader' as MailboxName,
        agentId: 'agent-alice' as never,
        hasPendingWork: true,
      }).catch(() => {});
    });

    const result = await fixture.taskStopTool.call({
      task_id: taskId, strategy: 'graceful', teammate_name: 'alice',
      timeout_ms: 5000,
    } as never, makeCtx());

    assert.equal(result.is_error, false);
    assert.match(getText(result), /REJECTED/);
    assert.match(getText(result), /Task continues to run/);

    // task 仍是 running（不强杀，不变量 #6）
    const out = await fixture.taskManager.getOutput(taskId as never);
    assert.equal(out!.status, 'running');
    assert.equal(fixture.isCleanupCalled(), false);
  });
});

test('TaskStopTool: graceful 超时 → task 标记 failed（不变量 #6 不强杀）', async () => {
  await withTempHome(async () => {
    const fixture = makeFixture({ pollIntervalMs: 5 });
    const taskId = await createTeammate(fixture, 'alice');

    // 不回复 → 超时
    const result = await fixture.taskStopTool.call({
      task_id: taskId, strategy: 'graceful', teammate_name: 'alice',
      timeout_ms: 50,
    } as never, makeCtx());

    assert.equal(result.is_error, true);
    assert.match(getText(result), /timed out/);
    assert.match(getText(result), /no force kill/);

    const out = await fixture.taskManager.getOutput(taskId as never);
    assert.equal(out!.status, 'failed');
    assert.match(out!.error!, /graceful stop timeout/);
  });
});

test('TaskStopTool: graceful 缺 teammate_name 返回 error', async () => {
  await withTempHome(async () => {
    const fixture = makeFixture();
    const taskId = await createTeammate(fixture, 'alice');

    const result = await fixture.taskStopTool.call({
      task_id: taskId, strategy: 'graceful',
      // 不传 teammate_name
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /teammate_name is required for graceful/);
  });
});

test('TaskStopTool: shutdownHandshake 未注入时 graceful 返回 error', async () => {
  await withTempHome(async () => {
    const taskManager = new TaskManager();
    const taskId = (await taskManager.createDualTrack({
      route: 'teammate', prompt: 'x', parentAgentId: 'a',
    })).runtimeTaskId as string;

    const taskStopTool = createTaskStopTool({
      taskManager,
      parentAgentId: () => 'leader',
      leaderName: () => 'leader' as MailboxName,
    });

    const result = await taskStopTool.call({
      task_id: taskId, strategy: 'graceful', teammate_name: 'alice',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /shutdownHandshake not injected/);
  });
});

// ============================================================
// force 路径
// ============================================================

test('TaskStopTool: force → abandon teammate（registry + worktree 释放）+ task 标记 failed', async () => {
  await withTempHome(async () => {
    const fixture = makeFixture();
    const taskId = await createTeammate(fixture, 'alice');

    const result = await fixture.taskStopTool.call({
      task_id: taskId, strategy: 'force', teammate_name: 'alice',
      reason: 'budget_exceeded',
    } as never, makeCtx());

    assert.equal(result.is_error, false);
    assert.match(getText(result), /force abandoned/);
    assert.match(getText(result), /"recovered":true/);
    assert.match(getText(result), /budget_exceeded/);

    // registry 注销
    assert.equal(await fixture.teammateRegistry.exists('alice'), false);
    // worktree 释放
    assert.equal(fixture.worktreeRoster.get('alice'), undefined);
    // task 标记 failed
    const out = await fixture.taskManager.getOutput(taskId as never);
    assert.equal(out!.status, 'failed');
    assert.match(out!.error!, /force stop: budget_exceeded/);
  });
});

test('TaskStopTool: force 缺 teammate_name 返回 error', async () => {
  await withTempHome(async () => {
    const fixture = makeFixture();
    const taskId = await createTeammate(fixture, 'alice');

    const result = await fixture.taskStopTool.call({
      task_id: taskId, strategy: 'force',
      // 不传 teammate_name
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /teammate_name is required for force/);
  });
});

test('TaskStopTool: threeStateRecovery 未注入时 force 返回 error', async () => {
  await withTempHome(async () => {
    const taskManager = new TaskManager();
    const mailboxService = new MailboxService();
    const shutdownHandshake = new ShutdownHandshake(mailboxService);
    const taskId = (await taskManager.createDualTrack({
      route: 'teammate', prompt: 'x', parentAgentId: 'a',
    })).runtimeTaskId as string;

    const taskStopTool = createTaskStopTool({
      taskManager,
      shutdownHandshake,
      parentAgentId: () => 'leader',
      leaderName: () => 'leader' as MailboxName,
    });

    const result = await taskStopTool.call({
      task_id: taskId, strategy: 'force', teammate_name: 'alice',
    } as never, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(getText(result), /threeStateRecovery not injected/);
  });
});

// ============================================================
// metadata + compactable
// ============================================================

test('TaskStopTool: graceful approve 时 metadata.compactable=false', async () => {
  await withTempHome(async () => {
    const fixture = makeFixture();
    const taskId = await createTeammate(fixture, 'alice');

    setImmediate(() => {
      void fixture.shutdownHandshake.handleRequest('alice' as MailboxName, 'placeholder', {
        leaderName: 'leader' as MailboxName,
        agentId: 'agent-alice' as never,
        hasPendingWork: false,
      }).catch(() => {});
    });

    const result = await fixture.taskStopTool.call({
      task_id: taskId, strategy: 'graceful', teammate_name: 'alice',
      timeout_ms: 5000,
    } as never, makeCtx());
    assert.equal(result.metadata?.compactable, false);
  });
});

test('TaskStopTool: 已完成 task no-action 时 metadata.compactable=true', async () => {
  await withTempHome(async () => {
    const fixture = makeFixture();
    const taskId = await createTeammate(fixture, 'alice');
    await fixture.taskManager.completeTask(taskId as never);

    const result = await fixture.taskStopTool.call({
      task_id: taskId, strategy: 'graceful', teammate_name: 'alice',
    } as never, makeCtx());
    assert.equal(result.metadata?.compactable, true);
  });
});
