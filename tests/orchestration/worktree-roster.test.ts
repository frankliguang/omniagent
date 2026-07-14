import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  WorktreeRoster,
  InMemoryWorktreeOps,
} from '../../src/orchestration/worktree-roster.js';
import type { WorktreeOperations } from '../../src/orchestration/worktree-roster.js';
import type { AgentId, MailboxName } from '../../src/types/index.js';

// ============================================================
// 测试 helpers
// ============================================================

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-worktree-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function makeAgentId(s: string): AgentId {
  return s as AgentId;
}
function makeMailboxName(s: string): MailboxName {
  return s as MailboxName;
}

/** Mock worktree ops：只记录调用，不实际创建目录 */
class MockWorktreeOps implements WorktreeOperations {
  public readonly created: Array<{ name: MailboxName; path: string }> = [];
  public readonly removed: string[] = [];
  public shouldFailCreate = false;

  async createWorktree(name: MailboxName, path: string): Promise<void> {
    if (this.shouldFailCreate) {
      throw new Error('mock create failed');
    }
    this.created.push({ name, path });
  }

  async removeWorktree(path: string): Promise<void> {
    this.removed.push(path);
  }
}

// ============================================================
// assign
// ============================================================

test('WorktreeRoster.assign: 分配 worktree 给 teammate', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  const result = await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    worktreePath: '/tmp/wt-alice-1',
  });
  assert.equal(result.path, '/tmp/wt-alice-1');
  assert.equal(ops.created.length, 1);
  assert.equal(ops.created[0].name, makeMailboxName('alice'));
  assert.equal(ops.created[0].path, '/tmp/wt-alice-1');
});

test('WorktreeRoster.assign: 默认 path 自动生成', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  const result = await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
  });
  assert.ok(result.path);
  assert.match(result.path, /worktrees\/alice-[0-9a-f]{8}$/);
});

test('WorktreeRoster.assign: 默认 path 含 name 前缀（便于识别）', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  const r1 = await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
  });
  const r2 = await roster.assign({
    teammateName: makeMailboxName('bob'),
    agentId: makeAgentId('agent-2'),
  });
  assert.ok(r1.path.includes('alice'));
  assert.ok(r2.path.includes('bob'));
  assert.notEqual(r1.path, r2.path);
});

test('WorktreeRoster.assign: 同一 teammate 重复分配抛错（不变量 #1）', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-alice-1',
  });
  await assert.rejects(
    () => roster.assign({
      teammateName: makeMailboxName('alice'),
      agentId: makeAgentId('agent-1'),
      worktreePath: '/tmp/wt-alice-2',  // 不同 path
    }),
    /already has a worktree/,
  );
  assert.equal(roster.size(), 1);
});

test('WorktreeRoster.assign: 不同 teammate 用同一 path 抛错（不变量 #1）', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-shared',
  });
  await assert.rejects(
    () => roster.assign({
      teammateName: makeMailboxName('bob'),
      agentId: makeAgentId('agent-2'),
      worktreePath: '/tmp/wt-shared',  // 同 path
    }),
    /already assigned to teammate "alice"/,
  );
  assert.equal(roster.size(), 1);
});

test('WorktreeRoster.assign: git worktree 失败时不记录归属', async () => {
  const ops = new MockWorktreeOps();
  ops.shouldFailCreate = true;
  const roster = new WorktreeRoster(ops);
  await assert.rejects(
    () => roster.assign({
      teammateName: makeMailboxName('alice'),
      agentId: makeAgentId('agent-1'),
      worktreePath: '/tmp/wt-fail',
    }),
    /mock create failed/,
  );
  assert.equal(roster.size(), 0, '失败时不应记录归属');
  assert.equal(roster.get(makeMailboxName('alice')), undefined);
});

test('WorktreeRoster.assign: 多 teammate 并存（不同 path）', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-1',
  });
  await roster.assign({
    teammateName: makeMailboxName('bob'),
    agentId: makeAgentId('agent-2'),
    worktreePath: '/tmp/wt-2',
  });
  await roster.assign({
    teammateName: makeMailboxName('carol'),
    agentId: makeAgentId('agent-3'),
    worktreePath: '/tmp/wt-3',
  });
  assert.equal(roster.size(), 3);
});

// ============================================================
// release
// ============================================================

test('WorktreeRoster.release: 释放 worktree', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-1',
  });
  assert.equal(roster.size(), 1);
  await roster.release(makeMailboxName('alice'));
  assert.equal(roster.size(), 0);
  assert.equal(ops.removed.length, 1);
  assert.equal(ops.removed[0], '/tmp/wt-1');
});

test('WorktreeRoster.release: 不存在的 name 幂等返回', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.release(makeMailboxName('nonexistent'));  // 不抛错
  assert.equal(ops.removed.length, 0);
});

test('WorktreeRoster.release: 释放后 path 可再次分配给新 teammate', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-reuse',
  });
  await roster.release(makeMailboxName('alice'));
  // 不同 teammate 可以用同一 path（释放后）
  await roster.assign({
    teammateName: makeMailboxName('bob'),
    agentId: makeAgentId('agent-2'),
    worktreePath: '/tmp/wt-reuse',
  });
  assert.equal(roster.size(), 1);
  assert.equal(roster.get(makeMailboxName('bob'))?.path, '/tmp/wt-reuse');
});

test('WorktreeRoster.release: 释放后原 teammate 可重新分配（新 path）', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-1',
  });
  await roster.release(makeMailboxName('alice'));
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-2',
  });
  assert.equal(roster.size(), 1);
});

// ============================================================
// getOwner / get / list / size
// ============================================================

test('WorktreeRoster.getOwner: 按 path 反查 teammate name', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-1',
  });
  assert.equal(roster.getOwner('/tmp/wt-1'), makeMailboxName('alice'));
});

test('WorktreeRoster.getOwner: 未占用的 path 返回 undefined', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  assert.equal(roster.getOwner('/tmp/wt-nonexistent'), undefined);
});

test('WorktreeRoster.get: 按 name 正查 entry', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-1',
  });
  const entry = roster.get(makeMailboxName('alice'));
  assert.ok(entry);
  assert.equal(entry!.teammateName, makeMailboxName('alice'));
  assert.equal(entry!.agentId, makeAgentId('agent-1'));
  assert.equal(entry!.path, '/tmp/wt-1');
  assert.ok(entry!.assignedAt);
});

test('WorktreeRoster.get: 未注册返回 undefined', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  assert.equal(roster.get(makeMailboxName('nonexistent')), undefined);
});

test('WorktreeRoster.list: 列出全部 entry', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-1',
  });
  await roster.assign({
    teammateName: makeMailboxName('bob'),
    agentId: makeAgentId('agent-2'),
    worktreePath: '/tmp/wt-2',
  });
  const list = roster.list();
  assert.equal(list.length, 2);
  const names = list.map(e => e.teammateName).sort();
  assert.deepEqual(names, ['alice', 'bob']);
});

test('WorktreeRoster.size: 返回当前数量', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  assert.equal(roster.size(), 0);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-1',
  });
  assert.equal(roster.size(), 1);
  await roster.release(makeMailboxName('alice'));
  assert.equal(roster.size(), 0);
});

// ============================================================
// clear
// ============================================================

test('WorktreeRoster.clear: 重置全部', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-1',
  });
  await roster.assign({
    teammateName: makeMailboxName('bob'),
    agentId: makeAgentId('agent-2'),
    worktreePath: '/tmp/wt-2',
  });
  assert.equal(roster.size(), 2);
  roster.clear();
  assert.equal(roster.size(), 0);
  assert.equal(roster.getOwner('/tmp/wt-1'), undefined);
});

// ============================================================
// InMemoryWorktreeOps（实际创建目录的测试 ops）
// ============================================================

test('InMemoryWorktreeOps: 实际创建目录', async () => {
  const tmp = tmpDir();
  const ops = new InMemoryWorktreeOps(tmp);
  try {
    const wtPath = path.join(tmp, 'wt-alice');
    await ops.createWorktree(makeMailboxName('alice'), wtPath);
    const stat = await fs.stat(wtPath);
    assert.ok(stat.isDirectory());
    await ops.removeWorktree(wtPath);
    await assert.rejects(() => fs.stat(wtPath));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test('WorktreeRoster: 集成 InMemoryWorktreeOps 实际创建/删除目录', async () => {
  const tmp = tmpDir();
  const ops = new InMemoryWorktreeOps(tmp);
  const roster = new WorktreeRoster(ops);
  try {
    const r = await roster.assign({
      teammateName: makeMailboxName('alice'),
      agentId: makeAgentId('agent-1'),
      worktreePath: path.join(tmp, 'wt-alice'),
    });
    const stat = await fs.stat(r.path);
    assert.ok(stat.isDirectory());
    await roster.release(makeMailboxName('alice'));
    await assert.rejects(() => fs.stat(r.path));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================
// 完整生命周期
// ============================================================

test('WorktreeRoster: 完整生命周期（assign → use → release → reassign）', async () => {
  const ops = new MockWorktreeOps();
  const roster = new WorktreeRoster(ops);
  // 1. assign
  const r1 = await roster.assign({
    teammateName: makeMailboxName('alice'),
    agentId: makeAgentId('agent-1'),
    worktreePath: '/tmp/wt-1',
  });
  // 2. 验证归属
  assert.equal(roster.getOwner(r1.path), makeMailboxName('alice'));
  assert.equal(roster.get(makeMailboxName('alice'))?.path, r1.path);
  // 3. release
  await roster.release(makeMailboxName('alice'));
  assert.equal(roster.getOwner(r1.path), undefined);
  // 4. reassign 同 path 给新 teammate
  const r2 = await roster.assign({
    teammateName: makeMailboxName('bob'),
    agentId: makeAgentId('agent-2'),
    worktreePath: r1.path,
  });
  assert.equal(roster.getOwner(r2.path), makeMailboxName('bob'));
});
