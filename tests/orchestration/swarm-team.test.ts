import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { SwarmTeam } from '../../src/orchestration/swarm-team.js';
import { MailboxService } from '../../src/orchestration/mailbox-service.js';
import { TeammateRegistry } from '../../src/orchestration/teammate-registry.js';
import { WorktreeRoster, InMemoryWorktreeOps } from '../../src/orchestration/worktree-roster.js';
import type { AgentId, MailboxName, TaskId, TraceId } from '../../src/types/index.js';

// ============================================================
// 测试 helpers
// ============================================================

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-swarm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const tmp = tmpDir();
  const oldHome = process.env.HOME;
  process.env.HOME = tmp;
  return fn().finally(async () => {
    process.env.HOME = oldHome;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
}

function makeAgentId(s: string): AgentId {
  return s as AgentId;
}
function makeMailboxName(s: string): MailboxName {
  return s as MailboxName;
}
function makeTaskId(s: string): TaskId {
  return s as TaskId;
}
function makeTraceId(s: string): TraceId {
  return s as TraceId;
}

// ============================================================
// joinTeam
// ============================================================

test('SwarmTeam.joinTeam: 注册 teammate + 分配 worktree', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    const result = await swarm.joinTeam({
      teammateName: makeMailboxName('alice'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-1'),
      traceId: makeTraceId('trace-1'),
      worktreePath: path.join(tmp, 'wt-alice'),
    });

    assert.ok(result.agentId, '应返回 teammate agentId');
    assert.match(result.agentId as string, /^[0-9a-f-]{36}$/);
    assert.equal(result.worktreePath, path.join(tmp, 'wt-alice'));
    assert.equal(result.taskId, makeTaskId('task-1'));

    // 验证 registry 已注册
    assert.equal(await registry.exists(makeMailboxName('alice')), true);
    const record = await registry.get(makeMailboxName('alice'));
    assert.equal(record?.agentId, result.agentId);
    assert.equal(record?.parentAgentId, makeAgentId('leader'));

    // 验证 worktree 已分配
    assert.equal(roster.get(makeMailboxName('alice'))?.path, path.join(tmp, 'wt-alice'));
    assert.equal(roster.getOwner(path.join(tmp, 'wt-alice')), makeMailboxName('alice'));

    // 清理
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('SwarmTeam.joinTeam: teammate_name 缺失抛错（不变量 #2）', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    await assert.rejects(
      () => swarm.joinTeam({
        teammateName: '' as MailboxName,  // 空 name
        parentAgentId: makeAgentId('leader'),
        runtimeTaskId: makeTaskId('task-1'),
        traceId: makeTraceId('trace-1'),
        worktreePath: path.join(tmp, 'wt-alice'),
      }),
      /teammate_name required/,
    );

    assert.equal(registry.size(), 0, '失败时不应注册');
    assert.equal(roster.size(), 0, '失败时不应分配 worktree');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('SwarmTeam.joinTeam: 重复 name 抛错（不变量 #2）', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    await swarm.joinTeam({
      teammateName: makeMailboxName('alice'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-1'),
      traceId: makeTraceId('trace-1'),
      worktreePath: path.join(tmp, 'wt-alice-1'),
    });

    await assert.rejects(
      () => swarm.joinTeam({
        teammateName: makeMailboxName('alice'),  // 重复 name
        parentAgentId: makeAgentId('leader'),
        runtimeTaskId: makeTaskId('task-2'),
        traceId: makeTraceId('trace-2'),
        worktreePath: path.join(tmp, 'wt-alice-2'),
      }),
      /already registered/,
    );

    assert.equal(registry.size(), 1, '失败时不应增加');
    assert.equal(roster.size(), 1, '失败时不应增加');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('SwarmTeam.joinTeam: worktree 分配失败时回滚 registry', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    // 先占用 /tmp/wt-collision 这个 path
    await roster.assign({
      teammateName: makeMailboxName('first-teammate'),
      agentId: makeAgentId('first-agent'),
      worktreePath: path.join(tmp, 'wt-collision'),
    });

    // alice 试图用同一 path → 失败
    await assert.rejects(
      () => swarm.joinTeam({
        teammateName: makeMailboxName('alice'),
        parentAgentId: makeAgentId('leader'),
        runtimeTaskId: makeTaskId('task-1'),
        traceId: makeTraceId('trace-1'),
        worktreePath: path.join(tmp, 'wt-collision'),  // 冲突
      }),
      /already assigned to teammate "first-teammate"/,
    );

    // alice 未注册（回滚成功）
    assert.equal(await registry.exists(makeMailboxName('alice')), false);
    assert.equal(registry.size(), 0, 'registry 应为空（first-teammate 在 roster 不在 registry）');
    assert.equal(roster.size(), 1, 'roster 应只保留 first-teammate');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('SwarmTeam.joinTeam: 多个 teammate 并存', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    await swarm.joinTeam({
      teammateName: makeMailboxName('alice'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-1'),
      traceId: makeTraceId('trace-1'),
      worktreePath: path.join(tmp, 'wt-alice'),
    });
    await swarm.joinTeam({
      teammateName: makeMailboxName('bob'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-2'),
      traceId: makeTraceId('trace-2'),
      worktreePath: path.join(tmp, 'wt-bob'),
    });
    await swarm.joinTeam({
      teammateName: makeMailboxName('carol'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-3'),
      traceId: makeTraceId('trace-3'),
      worktreePath: path.join(tmp, 'wt-carol'),
    });

    assert.equal(registry.size(), 3);
    assert.equal(roster.size(), 3);

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('SwarmTeam.joinTeam: 生成的 agentId 是 UUID 格式', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    const r1 = await swarm.joinTeam({
      teammateName: makeMailboxName('alice'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-1'),
      traceId: makeTraceId('trace-1'),
      worktreePath: path.join(tmp, 'wt-alice'),
    });
    const r2 = await swarm.joinTeam({
      teammateName: makeMailboxName('bob'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-2'),
      traceId: makeTraceId('trace-2'),
      worktreePath: path.join(tmp, 'wt-bob'),
    });

    assert.notEqual(r1.agentId, r2.agentId, 'agentId 应唯一');
    assert.match(r1.agentId as string, /^[0-9a-f-]{36}$/);
    assert.match(r2.agentId as string, /^[0-9a-f-]{36}$/);

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// sendMessage
// ============================================================

test('SwarmTeam.sendMessage: 委托 MailboxService 写入', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    await swarm.joinTeam({
      teammateName: makeMailboxName('alice'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-1'),
      traceId: makeTraceId('trace-1'),
      worktreePath: path.join(tmp, 'wt-alice'),
    });

    // leader 给 alice 发消息
    await swarm.sendMessage({
      from: makeAgentId('leader'),
      to: makeMailboxName('alice'),
      type: 'text',
      payload: { text: 'hello alice' },
    });

    // 验证 alice 的 mailbox 有消息
    const read = await mailbox.read(makeMailboxName('alice'));
    assert.equal(read.length, 1);
    assert.equal(read[0].from, makeAgentId('leader'));
    assert.equal(read[0].to, makeMailboxName('alice'));
    assert.equal((read[0].payload as { text: string }).text, 'hello alice');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('SwarmTeam.sendMessage: 写失败抛错', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    // 用极小 limits 让写失败
    const mailbox = new MailboxService({
      limits: {
        maxSingleMessageBytes: 100,
        maxMailboxFileBytes: 1024,
        maxMessagesPerMailbox: 1000,
        archiveThreshold: 200,
      },
    });
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    // 发超大消息（>100B）→ over_capacity
    await assert.rejects(
      () => swarm.sendMessage({
        from: makeAgentId('leader'),
        to: makeMailboxName('alice'),
        type: 'text',
        payload: { text: 'x'.repeat(200) },
      }),
      /mailbox write to "alice" failed: over_capacity/,
    );

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// leaveTeam
// ============================================================

test('SwarmTeam.leaveTeam: 释放 worktree + 注销 registry', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    const r = await swarm.joinTeam({
      teammateName: makeMailboxName('alice'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-1'),
      traceId: makeTraceId('trace-1'),
      worktreePath: path.join(tmp, 'wt-alice'),
    });

    assert.equal(registry.size(), 1);
    assert.equal(roster.size(), 1);

    await swarm.leaveTeam(makeMailboxName('alice'));

    assert.equal(registry.size(), 0);
    assert.equal(roster.size(), 0);
    assert.equal(await registry.exists(makeMailboxName('alice')), false);
    assert.equal(roster.get(makeMailboxName('alice')), undefined);

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('SwarmTeam.leaveTeam: 不存在的 name 幂等返回', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    // 不抛错
    await swarm.leaveTeam(makeMailboxName('nonexistent'));

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// toToolResult
// ============================================================

test('SwarmTeam.toToolResult: 转换为 ToolResult', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    const params = {
      teammateName: makeMailboxName('alice'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-1'),
      traceId: makeTraceId('trace-1'),
      worktreePath: path.join(tmp, 'wt-alice'),
    };
    const result = await swarm.joinTeam(params);
    const toolResult = swarm.toToolResult(params, result);

    assert.equal(toolResult.is_error, false);
    assert.equal(toolResult.metadata?.compactable, false);
    const textBlock = toolResult.content[0] as { type: string; text: string };
    assert.equal(textBlock.type, 'text');
    assert.ok(textResultIncludes(textBlock.text, 'alice'));
    assert.ok(textResultIncludes(textBlock.text, result.worktreePath));
    assert.ok(textResultIncludes(textBlock.text, 'task-1'));

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

function textResultIncludes(text: string, substr: string): boolean {
  return text.includes(substr);
}

// ============================================================
// 集成：完整 swarm 流程
// ============================================================

test('SwarmTeam: 完整流程（join → send → read → leave）', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const swarm = new SwarmTeam(mailbox, registry, roster);

    // 1. join
    const r = await swarm.joinTeam({
      teammateName: makeMailboxName('alice'),
      parentAgentId: makeAgentId('leader'),
      runtimeTaskId: makeTaskId('task-1'),
      traceId: makeTraceId('trace-1'),
      worktreePath: path.join(tmp, 'wt-alice'),
    });

    // 2. leader → alice
    await swarm.sendMessage({
      from: makeAgentId('leader'),
      to: makeMailboxName('alice'),
      type: 'text',
      payload: { text: 'task instructions' },
    });

    // 3. alice 检查 mailbox
    const aliceUnread = await mailbox.readUnread(makeMailboxName('alice'));
    assert.equal(aliceUnread.length, 1);

    // 4. alice → leader (task_update)
    await swarm.sendMessage({
      from: makeMailboxName('alice'),
      to: makeMailboxName('leader'),  // leader 也有 mailbox
      type: 'task_update',
      payload: { task_id: 'task-1', status: 'running' },
    });

    // 5. leader 检查 mailbox
    const leaderUnread = await mailbox.readUnread(makeMailboxName('leader'));
    assert.equal(leaderUnread.length, 1);
    assert.equal(leaderUnread[0].type, 'task_update');

    // 6. leave
    await swarm.leaveTeam(makeMailboxName('alice'));
    assert.equal(registry.size(), 0);
    assert.equal(roster.size(), 0);

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});
