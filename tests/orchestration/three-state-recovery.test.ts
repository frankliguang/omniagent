import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ThreeStateRecovery } from '../../src/orchestration/three-state-recovery.js';
import { MailboxService } from '../../src/orchestration/mailbox-service.js';
import { TeammateRegistry } from '../../src/orchestration/teammate-registry.js';
import { WorktreeRoster, InMemoryWorktreeOps } from '../../src/orchestration/worktree-roster.js';
import { TaskManager } from '../../src/orchestration/task-manager.js';
import type { AgentId, MailboxName } from '../../src/types/index.js';

// ============================================================
// 测试 helpers
// ============================================================

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function makeAgentId(s: string): AgentId { return s as AgentId; }
function makeMailboxName(s: string): MailboxName { return s as MailboxName; }

/** 创建 mock processAliveChecker：返回指定 agentId 的存活状态 */
function makeAliveChecker(aliveSet: Set<string>): (agentId: AgentId) => Promise<boolean> {
  return async (agentId) => aliveSet.has(agentId as string);
}

/** 创建 mock taskManager（只用作构造函数参数） */
function makeMockTaskManager(): TaskManager {
  return new TaskManager();
}

/** 准备测试 fixture：注册 teammate + 可选发 mailbox 消息 */
async function setupTeammate(
  registry: TeammateRegistry,
  mailbox: MailboxService,
  name: MailboxName,
  agentId: AgentId,
  options: { sendUnread?: boolean; parentAgentId?: AgentId } = {},
): Promise<void> {
  await registry.register({
    name,
    agentId,
    parentAgentId: options.parentAgentId ?? makeAgentId('leader'),
  });
  if (options.sendUnread) {
    await mailbox.sendText(makeAgentId('leader'), name, 'unread msg');
  }
}

// ============================================================
// checkStatus
// ============================================================

test('ThreeStateRecovery.checkStatus: teammate 未注册 → evicted', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager);

    const status = await recovery.checkStatus(makeMailboxName('nonexistent'));
    assert.equal(status, 'evicted');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('ThreeStateRecovery.checkStatus: 进程存活 → running', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceAgentId = makeAgentId('agent-alice-001');

    await setupTeammate(registry, mailbox, makeMailboxName('alice'), aliceAgentId);

    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set([aliceAgentId as string])),
    });

    const status = await recovery.checkStatus(makeMailboxName('alice'));
    assert.equal(status, 'running');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('ThreeStateRecovery.checkStatus: 进程停止 + mailbox 有未读 → stopped', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceAgentId = makeAgentId('agent-alice-001');

    // 注册 + 发未读消息
    await setupTeammate(registry, mailbox, makeMailboxName('alice'), aliceAgentId, {
      sendUnread: true,
    });

    // 进程不存活（空集合）
    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set()),
    });

    const status = await recovery.checkStatus(makeMailboxName('alice'));
    assert.equal(status, 'stopped');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('ThreeStateRecovery.checkStatus: 进程停止 + mailbox 无未读 → evicted', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceAgentId = makeAgentId('agent-alice-001');

    // 注册但无未读消息
    await setupTeammate(registry, mailbox, makeMailboxName('alice'), aliceAgentId);

    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set()),
    });

    const status = await recovery.checkStatus(makeMailboxName('alice'));
    assert.equal(status, 'evicted');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('ThreeStateRecovery.checkStatus: 进程停止 + 已读消息 + 无未读 → evicted', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceAgentId = makeAgentId('agent-alice-001');

    await setupTeammate(registry, mailbox, makeMailboxName('alice'), aliceAgentId, {
      sendUnread: true,
    });

    // 标记已读（无未读了）
    const aliceName = makeMailboxName('alice');
    const unread = await mailbox.readUnread(aliceName);
    await mailbox.markRead(aliceName, unread.map(m => m.id));

    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set()),
    });

    const status = await recovery.checkStatus(aliceName);
    assert.equal(status, 'evicted', '已读消息不算未读 → evicted');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('ThreeStateRecovery.checkStatus: 默认 processAliveChecker（单进程模式）返回 false', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceAgentId = makeAgentId('agent-alice-001');

    await setupTeammate(registry, mailbox, makeMailboxName('alice'), aliceAgentId, {
      sendUnread: true,
    });

    // 不注入 processAliveChecker → 用默认（false）
    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager);

    const status = await recovery.checkStatus(makeMailboxName('alice'));
    assert.equal(status, 'stopped', '默认 checker 返回 false → stopped（有未读）');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// recover: restart
// ============================================================

test('ThreeStateRecovery.recover: restart + running 状态 → 不重启', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceAgentId = makeAgentId('agent-alice-001');

    await setupTeammate(registry, mailbox, makeMailboxName('alice'), aliceAgentId);
    await roster.assign({
      teammateName: makeMailboxName('alice'),
      agentId: aliceAgentId,
      worktreePath: path.join(tmp, 'wt-alice'),
    });

    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set([aliceAgentId as string])),
    });

    const result = await recovery.recover(makeMailboxName('alice'), { strategy: 'restart' });
    assert.equal(result.strategy, 'restart');
    assert.equal(result.recovered, false, 'running 时不应重启');
    assert.match(result.detail!, /still running/);

    // 资源未清理
    assert.equal(await registry.exists(makeMailboxName('alice')), true);
    assert.equal(roster.size(), 1);

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('ThreeStateRecovery.recover: restart + stopped 状态 → stub 重启', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceAgentId = makeAgentId('agent-alice-001');

    await setupTeammate(registry, mailbox, makeMailboxName('alice'), aliceAgentId, {
      sendUnread: true,
    });
    await roster.assign({
      teammateName: makeMailboxName('alice'),
      agentId: aliceAgentId,
      worktreePath: path.join(tmp, 'wt-alice'),
    });

    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set()),
    });

    const result = await recovery.recover(makeMailboxName('alice'), { strategy: 'restart' });
    assert.equal(result.strategy, 'restart');
    assert.equal(result.status, 'stopped');
    assert.equal(result.recovered, true);
    assert.match(result.detail!, /stub/);

    // restart 保留资源
    assert.equal(await registry.exists(makeMailboxName('alice')), true, 'registry 应保留');
    assert.equal(roster.size(), 1, 'worktree 应保留');
    // mailbox 也保留
    const aliceUnread = await mailbox.readUnread(makeMailboxName('alice'));
    assert.equal(aliceUnread.length, 1, 'mailbox 未读消息应保留');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('ThreeStateRecovery.recover: restart + evicted 状态 → stub 重启', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceAgentId = makeAgentId('agent-alice-001');

    await setupTeammate(registry, mailbox, makeMailboxName('alice'), aliceAgentId);
    // 无未读消息 → evicted

    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set()),
    });

    const result = await recovery.recover(makeMailboxName('alice'), { strategy: 'restart' });
    assert.equal(result.status, 'evicted');
    assert.equal(result.recovered, true);

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// recover: abandon
// ============================================================

test('ThreeStateRecovery.recover: abandon → 注销 + 释放 worktree', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceAgentId = makeAgentId('agent-alice-001');
    const aliceName = makeMailboxName('alice');

    await setupTeammate(registry, mailbox, aliceName, aliceAgentId);
    await roster.assign({
      teammateName: aliceName,
      agentId: aliceAgentId,
      worktreePath: path.join(tmp, 'wt-alice'),
    });

    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set()),
    });

    const result = await recovery.recover(aliceName, {
      strategy: 'abandon',
      reason: 'test abandon',
    });
    assert.equal(result.strategy, 'abandon');
    assert.equal(result.recovered, true);

    // registry 已注销
    assert.equal(await registry.exists(aliceName), false);
    // worktree 已释放
    assert.equal(roster.size(), 0);

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('ThreeStateRecovery.recover: abandon 不存在的 teammate → 仍返回 recovered=true', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager);

    const result = await recovery.recover(makeMailboxName('nonexistent'), {
      strategy: 'abandon',
    });
    assert.equal(result.recovered, true);
    assert.equal(result.status, 'evicted');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// checkAllStatus
// ============================================================

test('ThreeStateRecovery.checkAllStatus: 批量检测多 teammate', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceId = makeAgentId('agent-alice');
    const bobId = makeAgentId('agent-bob');
    const carolId = makeAgentId('agent-carol');

    // alice: running
    await setupTeammate(registry, mailbox, makeMailboxName('alice'), aliceId);
    // bob: stopped (有未读)
    await setupTeammate(registry, mailbox, makeMailboxName('bob'), bobId, { sendUnread: true });
    // carol: evicted (无未读)
    await setupTeammate(registry, mailbox, makeMailboxName('carol'), carolId);

    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set([aliceId as string])),
    });

    const results = await recovery.checkAllStatus();
    assert.equal(results.length, 3);

    const byName = new Map(results.map(r => [r.name as string, r.status]));
    assert.equal(byName.get('alice'), 'running');
    assert.equal(byName.get('bob'), 'stopped');
    assert.equal(byName.get('carol'), 'evicted');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('ThreeStateRecovery.checkAllStatus: 空 registry 返回空数组', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager);

    const results = await recovery.checkAllStatus();
    assert.deepEqual(results, []);

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// makeRealProcessAliveChecker（iter 3+ 用，基本逻辑测试）
// ============================================================

test('makeRealProcessAliveChecker: pid 未找到 → false', async () => {
  const { makeRealProcessAliveChecker } = await import('../../src/orchestration/three-state-recovery.js');
  const checker = makeRealProcessAliveChecker(() => undefined);
  const alive = await checker(makeAgentId('nonexistent'));
  assert.equal(alive, false);
});

test('makeRealProcessAliveChecker: 自身进程 pid → true', async () => {
  const { makeRealProcessAliveChecker } = await import('../../src/orchestration/three-state-recovery.js');
  const selfPid = process.pid;
  const checker = makeRealProcessAliveChecker(() => selfPid);
  const alive = await checker(makeAgentId('self'));
  assert.equal(alive, true, '自身进程应存活');
});

test('makeRealProcessAliveChecker: 不存在的 pid → false', async () => {
  const { makeRealProcessAliveChecker } = await import('../../src/orchestration/three-state-recovery.js');
  // pid 2147483647 通常是无效的（极大 pid）
  const checker = makeRealProcessAliveChecker(() => 2147483647);
  const alive = await checker(makeAgentId('nonexistent-process'));
  assert.equal(alive, false);
});

// ============================================================
// 集成：完整恢复流程
// ============================================================

test('ThreeStateRecovery: 集成流程（注册 → 检测 stopped → abandon → 注销）', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceName = makeMailboxName('alice');
    const aliceAgentId = makeAgentId('agent-alice-001');

    // 1. 注册 teammate + 分配 worktree + 发未读消息
    await setupTeammate(registry, mailbox, aliceName, aliceAgentId, {
      sendUnread: true,
      parentAgentId: makeAgentId('leader'),
    });
    await roster.assign({
      teammateName: aliceName,
      agentId: aliceAgentId,
      worktreePath: path.join(tmp, 'wt-alice'),
    });

    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set()),  // 进程不存活
    });

    // 2. 检测 → stopped
    const status = await recovery.checkStatus(aliceName);
    assert.equal(status, 'stopped');

    // 3. abandon
    const result = await recovery.recover(aliceName, { strategy: 'abandon' });
    assert.equal(result.recovered, true);

    // 4. 验证资源已清理
    assert.equal(await registry.exists(aliceName), false);
    assert.equal(roster.size(), 0);

    // 5. 再次检测 → evicted（未注册）
    const statusAfter = await recovery.checkStatus(aliceName);
    assert.equal(statusAfter, 'evicted');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});

test('ThreeStateRecovery: 多 teammate 部分存活部分停止', async () => {
  await withTempHome(async () => {
    const tmp = tmpDir();
    const mailbox = new MailboxService();
    const registry = new TeammateRegistry();
    const roster = new WorktreeRoster(new InMemoryWorktreeOps(tmp));
    const taskManager = makeMockTaskManager();
    const aliceId = makeAgentId('agent-alice');
    const bobId = makeAgentId('agent-bob');

    await setupTeammate(registry, mailbox, makeMailboxName('alice'), aliceId);  // 无未读
    await setupTeammate(registry, mailbox, makeMailboxName('bob'), bobId, { sendUnread: true });

    const recovery = new ThreeStateRecovery(registry, mailbox, roster, taskManager, {
      processAliveChecker: makeAliveChecker(new Set([aliceId as string])),  // alice 存活
    });

    const results = await recovery.checkAllStatus();
    const map = new Map(results.map(r => [r.name as string, r.status]));
    assert.equal(map.get('alice'), 'running');
    assert.equal(map.get('bob'), 'stopped');

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
});
