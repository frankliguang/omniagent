import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  RecoveryHandler,
  createRecoveryHandler,
  defaultMailboxDir,
  defaultTranscriptDir,
} from '../../src/memory/recovery.js';
import { TranscriptStore } from '../../src/memory/transcript.js';
import {
  BoundaryStore,
  generateBoundaryId,
  nowTimestamp,
} from '../../src/memory/boundary.js';
import type {
  CompactBoundary,
  MailboxName,
  Message,
  PermissionMode,
  SessionId,
  UUID,
} from '../../src/types/index.js';

// ============================================================
// helpers
// ============================================================

function tmpHome(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function makeMessage(opts: {
  role?: 'user' | 'assistant' | 'system' | 'tool';
  text?: string;
  id?: UUID;
  parentUuid?: UUID;
}): Message {
  return {
    role: opts.role ?? 'user',
    content: [{ type: 'text', text: opts.text ?? 'msg' }],
    id: opts.id ?? (randomUUID() as UUID),
    parentUuid: opts.parentUuid,
    createdAt: new Date().toISOString() as never,
  };
}

/** 构造一条完整链路：每条 parentUuid 指向上一条 id */
function makeChain(count: number, firstParentUndefined = true): Message[] {
  const msgs: Message[] = [];
  let prevId: UUID | undefined;
  for (let i = 0; i < count; i++) {
    const id = randomUUID() as UUID;
    msgs.push(
      makeMessage({
        id,
        parentUuid: i === 0 && firstParentUndefined ? undefined : prevId,
        text: `msg ${i}`,
      }),
    );
    prevId = id;
  }
  return msgs;
}

/** 构造一条断链：在第 breakIndex 条把 parentUuid 改成不匹配的 UUID */
function makeBrokenChain(count: number, breakIndex: number): Message[] {
  const msgs = makeChain(count);
  if (breakIndex < msgs.length) {
    msgs[breakIndex] = {
      ...msgs[breakIndex],
      parentUuid: randomUUID() as UUID, // 错误的 parentUuid
    };
  }
  return msgs;
}

async function writeTranscript(
  sessionId: SessionId,
  messages: Message[],
): Promise<TranscriptStore> {
  const dir = defaultTranscriptDir();
  await fs.mkdir(dir, { recursive: true });
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  const store = await TranscriptStore.load(transcriptPath);
  for (const m of messages) {
    await store.append(m);
  }
  await store.flush();
  return store;
}

async function writeBoundary(
  transcriptId: UUID,
  boundary: CompactBoundary,
): Promise<void> {
  const dir = defaultTranscriptDir();
  await fs.mkdir(dir, { recursive: true });
  const boundaryPath = path.join(dir, `${transcriptId}.boundaries.jsonl`);
  const store = new BoundaryStore({ boundaryPath });
  await store.append(boundary);
}

async function makeBoundary(transcriptId: UUID): Promise<CompactBoundary> {
  return {
    boundary_id: generateBoundaryId(transcriptId),
    compactRange: { start: 0, end: 5 },
    tokensBefore: 1000,
    tokensAfter: 500,
    timestamp: nowTimestamp(),
    transcriptId,
    triggerLayer: 'ptl_handler' as never,
  };
}

/** 构造 mock TeammateRegistry */
function makeMockTeammateRegistry(existsResult: boolean) {
  return {
    exists: async (_name: MailboxName) => existsResult,
    register: async () => ({ agentId: 'a1' as never }),
    get: () => undefined,
    unregister: () => {},
    list: () => [],
    size: () => 0,
  } as never;
}

/** 构造 mock WorktreeRoster */
function makeMockWorktreeRoster(entries: Array<{
  teammateName: MailboxName;
  path: string;
}>) {
  return {
    list: () =>
      entries.map((e) => ({
        teammateName: e.teammateName,
        agentId: 'a1' as never,
        path: e.path,
        assignedAt: new Date().toISOString() as never,
      })),
    assign: async () => ({} as never),
    release: async () => {},
    getOwner: () => undefined,
  } as never;
}

/** 构造 mock ThreeStateRecovery */
function makeMockThreeStateRecovery(recoverResult: { recovered: boolean; detail?: string }) {
  return {
    recover: async (
      _name: MailboxName,
      _opts: { strategy: string; reason?: string },
    ) => recoverResult,
    checkStatus: async () => 'evicted' as never,
  } as never;
}

/** 构造 mock TaskManager */
function makeMockTaskManager(taskExists: boolean) {
  return {
    getOutput: async () =>
      taskExists
        ? { status: 'completed', result: {} } as never
        : undefined,
    createDualTrack: async () => ({ workItemId: 'w1', runtimeTaskId: 't1' }) as never,
    completeTask: async () => {},
    failTask: async () => {},
    setSidechain: async () => {},
  } as never;
}

// ============================================================
// 调度器：路由 9 场景
// ============================================================

test('RecoveryHandler.recover: 路由 SCENARIO_TRANSCRIPT_CORRUPT → recoverTranscriptCorrupt', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_TRANSCRIPT_CORRUPT', {
      sessionId: 'nonexistent' as SessionId,
    });
    assert.equal(result.scenario, 'SCENARIO_TRANSCRIPT_CORRUPT');
    // 无 transcript → ok=true 但 dataLoss=last_session（从空开始）
    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_session');
  });
});

test('RecoveryHandler.recover: 路由未知 scenario → ok=false', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover(
      'UNKNOWN_SCENARIO' as never,
      {},
    );
    assert.equal(result.ok, false);
    assert.equal(result.dataLoss, 'unknown');
  });
});

// ============================================================
// 场景 1：main transcript 损坏（断链）
// ============================================================

test('SCENARIO_TRANSCRIPT_CORRUPT: 无 boundary → 从空开始（dataLoss=last_session）', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID() as SessionId;
    const msgs = makeBrokenChain(5, 2); // 第 2 条断链
    await writeTranscript(sessionId, msgs);

    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_TRANSCRIPT_CORRUPT', { sessionId });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_session');
    assert.equal(result.recoveredMessages?.length, 0);
  });
});

test('SCENARIO_TRANSCRIPT_CORRUPT: 有 boundary → 重建后 boundary 之后的消息（dataLoss=last_turn）', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID() as SessionId;
    const msgs = makeChain(5);
    // 让最后一条 id 作为 boundary 的 last_message_id
    const boundary: CompactBoundary = {
      ...(await makeBoundary(sessionId as unknown as UUID)),
      // 注入 last_message_id 字段（recovery.ts 用它判断 boundary 位置）
    } as CompactBoundary;
    (boundary as unknown as { last_message_id: UUID }).last_message_id = msgs[2].id!;
    await writeBoundary(sessionId as unknown as UUID, boundary);
    await writeTranscript(sessionId, msgs);

    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_TRANSCRIPT_CORRUPT', { sessionId });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_turn');
    assert.ok(result.recoveredBoundary);
    // 应保留 boundary 之后的消息（msgs[3] 和 msgs[4]）
    assert.equal(result.recoveredMessages?.length, 2);
  });
});

test('SCENARIO_TRANSCRIPT_CORRUPT: 缺 sessionId → fail', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_TRANSCRIPT_CORRUPT', {});
    assert.equal(result.ok, false);
    assert.match(result.error!, /sessionId required/);
  });
});

// ============================================================
// 场景 2：sidechain 损坏
// ============================================================

test('SCENARIO_SIDECHAIN_CORRUPT: 有 boundary → 从 boundary 重建（dataLoss=last_turn）', async () => {
  await withTempHome(async () => {
    const sidechainId = randomUUID() as UUID;
    const boundary = await makeBoundary(sidechainId);
    await writeBoundary(sidechainId, boundary);

    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_SIDECHAIN_CORRUPT', { sidechainId });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_turn');
    assert.ok(result.recoveredBoundary);
  });
});

test('SCENARIO_SIDECHAIN_CORRUPT: 无 boundary → ok=false（无法恢复）', async () => {
  await withTempHome(async () => {
    const sidechainId = randomUUID() as UUID;
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_SIDECHAIN_CORRUPT', { sidechainId });

    assert.equal(result.ok, false);
    assert.equal(result.dataLoss, 'last_session');
  });
});

test('SCENARIO_SIDECHAIN_CORRUPT: 缺 sidechainId → fail', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_SIDECHAIN_CORRUPT', {});
    assert.equal(result.ok, false);
    assert.match(result.error!, /sidechainId required/);
  });
});

// ============================================================
// 场景 3：team 缺失
// ============================================================

test('SCENARIO_TEAM_MISSING: teammate 不存在 → 通知 leader stopped（dataLoss=none）', async () => {
  await withTempHome(async () => {
    const registry = makeMockTeammateRegistry(false); // 不存在
    const handler = createRecoveryHandler({ teammateRegistry: registry });
    const result = await handler.recover('SCENARIO_TEAM_MISSING', {
      teammateName: 'missing-teammate' as MailboxName,
    });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'none');
    assert.match(result.detail!, /missing-teammate/);
    assert.match(result.detail!, /stopped/);
  });
});

test('SCENARIO_TEAM_MISSING: teammate 实际存在 → false alarm（dataLoss=none）', async () => {
  await withTempHome(async () => {
    const registry = makeMockTeammateRegistry(true); // 存在
    const handler = createRecoveryHandler({ teammateRegistry: registry });
    const result = await handler.recover('SCENARIO_TEAM_MISSING', {
      teammateName: 'alice' as MailboxName,
    });

    assert.equal(result.ok, true);
    assert.match(result.detail!, /false alarm/);
  });
});

test('SCENARIO_TEAM_MISSING:  teammateRegistry → fail', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_TEAM_MISSING', {
      teammateName: 'alice' as MailboxName,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /teammateRegistry not injected/);
  });
});

// ============================================================
// 场景 4：mailbox 损坏
// ============================================================

test('SCENARIO_MAILBOX_CORRUPT: 有 .bak → 从 .bak 恢复（dataLoss=last_turn）', async () => {
  await withTempHome(async () => {
    const name = 'alice' as MailboxName;
    const mailboxDir = defaultMailboxDir();
    await fs.mkdir(mailboxDir, { recursive: true });
    const mailboxPath = path.join(mailboxDir, `${name}.jsonl`);
    const bakPath = path.join(mailboxDir, `${name}.bak.jsonl`);

    // 当前 mailbox 损坏（无效 JSON）
    await fs.writeFile(mailboxPath, '{ CORRUPT JSON {{{', 'utf8');
    // .bak 有有效内容
    const validBak = JSON.stringify({
      id: 'm1' as never,
      from: 'leader' as never,
      to: name,
      content: { type: 'text', text: 'hello' },
      timestamp: new Date().toISOString() as never,
      read: false,
    });
    await fs.writeFile(bakPath, validBak + '\n', 'utf8');

    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_MAILBOX_CORRUPT', { teammateName: name });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_turn');
    assert.match(result.detail!, /\.bak\.jsonl/);

    // 验证 mailbox 已被 .bak 替换
    const restored = await fs.readFile(mailboxPath, 'utf8');
    assert.ok(restored.includes('hello'));
  });
});

test('SCENARIO_MAILBOX_CORRUPT: 无 .bak 但有 archive → 从 archive 恢复（dataLoss=last_session）', async () => {
  await withTempHome(async () => {
    const name = 'bob' as MailboxName;
    const mailboxDir = defaultMailboxDir();
    await fs.mkdir(mailboxDir, { recursive: true });
    const mailboxPath = path.join(mailboxDir, `${name}.jsonl`);
    const archivePath = path.join(mailboxDir, `${name}.archive.jsonl`);

    await fs.writeFile(mailboxPath, 'CORRUPT {{{', 'utf8');
    const archived = JSON.stringify({
      id: 'old1' as never,
      from: 'leader' as never,
      to: name,
      content: { type: 'text', text: 'archived msg' },
      timestamp: new Date().toISOString() as never,
      read: true,
    });
    await fs.writeFile(archivePath, archived + '\n', 'utf8');

    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_MAILBOX_CORRUPT', { teammateName: name });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_session');
    assert.match(result.detail!, /archive/);

    const restored = await fs.readFile(mailboxPath, 'utf8');
    assert.ok(restored.includes('archived msg'));
  });
});

test('SCENARIO_MAILBOX_CORRUPT: 无 .bak 无 archive → 清空 mailbox（dataLoss=last_session）', async () => {
  await withTempHome(async () => {
    const name = 'carol' as MailboxName;
    const mailboxDir = defaultMailboxDir();
    await fs.mkdir(mailboxDir, { recursive: true });
    const mailboxPath = path.join(mailboxDir, `${name}.jsonl`);
    await fs.writeFile(mailboxPath, 'CORRUPT', 'utf8');

    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_MAILBOX_CORRUPT', { teammateName: name });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_session');
    assert.match(result.detail!, /reset to empty/);

    const restored = await fs.readFile(mailboxPath, 'utf8');
    assert.equal(restored, '');
  });
});

test('SCENARIO_MAILBOX_CORRUPT: 缺 teammateName → fail', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_MAILBOX_CORRUPT', {});
    assert.equal(result.ok, false);
    assert.match(result.error!, /teammateName required/);
  });
});

// ============================================================
// 场景 5：task 损坏
// ============================================================

test('SCENARIO_TASK_CORRUPT: task 存在 → 从 runtime store 恢复（dataLoss=none）', async () => {
  await withTempHome(async () => {
    const taskManager = makeMockTaskManager(true);
    const handler = createRecoveryHandler({ taskManager });
    const result = await handler.recover('SCENARIO_TASK_CORRUPT', {
      taskId: 'task-001' as never,
    });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'none');
    assert.equal(result.recoveredTaskId, 'task-001' as never);
  });
});

test('SCENARIO_TASK_CORRUPT: task 不存在 → fail（dataLoss=unknown）', async () => {
  await withTempHome(async () => {
    const taskManager = makeMockTaskManager(false);
    const handler = createRecoveryHandler({ taskManager });
    const result = await handler.recover('SCENARIO_TASK_CORRUPT', {
      taskId: 'task-002' as never,
    });

    assert.equal(result.ok, false);
    assert.equal(result.dataLoss, 'unknown');
  });
});

test('SCENARIO_TASK_CORRUPT: 缺 taskManager → fail', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_TASK_CORRUPT', {
      taskId: 'task-003' as never,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /taskManager not injected/);
  });
});

// ============================================================
// 场景 6：sidecar 404
// ============================================================

test('SCENARIO_SIDECAR_404: ThreeStateRecovery 注入 → 调用 recover abandon（dataLoss=last_turn）', async () => {
  await withTempHome(async () => {
    const tsr = makeMockThreeStateRecovery({
      recovered: true,
      detail: 'evicted',
    });
    const handler = createRecoveryHandler({ threeStateRecovery: tsr });
    const result = await handler.recover('SCENARIO_SIDECAR_404', {
      teammateName: 'remote-agent' as MailboxName,
    });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_turn');
    assert.match(result.detail!, /evicted/);
  });
});

test('SCENARIO_SIDECAR_404: 无 ThreeStateRecovery → 仅返回结果（dataLoss=last_turn）', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_SIDECAR_404', {
      teammateName: 'remote-agent' as MailboxName,
    });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_turn');
    assert.match(result.detail!, /invariant #16 scenario 6/);
  });
});

test('SCENARIO_SIDECAR_404: 缺 teammateName → fail', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_SIDECAR_404', {});
    assert.equal(result.ok, false);
    assert.match(result.error!, /teammateName required/);
  });
});

// ============================================================
// 场景 7：worktree pointer 缺失
// ============================================================

test('SCENARIO_WORKTREE_MISSING: roster 有 entry 且 path 存在 → 重建 pointer（dataLoss=none）', async () => {
  await withTempHome(async () => {
    // 创建 worktree path
    const wtPath = path.join(process.env.HOME!, 'worktree-alice');
    await fs.mkdir(wtPath, { recursive: true });

    const roster = makeMockWorktreeRoster([
      { teammateName: 'alice' as MailboxName, path: wtPath },
    ]);
    const handler = createRecoveryHandler({ worktreeRoster: roster });
    const result = await handler.recover('SCENARIO_WORKTREE_MISSING', {
      teammateName: 'alice' as MailboxName,
    });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'none');
    assert.match(result.detail!, /pointer/);
    assert.match(result.detail!, /rebuilt/);
  });
});

test('SCENARIO_WORKTREE_MISSING: roster 有 entry 但 path 缺失 → fail（dataLoss=last_session）', async () => {
  await withTempHome(async () => {
    const roster = makeMockWorktreeRoster([
      { teammateName: 'bob' as MailboxName, path: '/nonexistent/path-123' },
    ]);
    const handler = createRecoveryHandler({ worktreeRoster: roster });
    const result = await handler.recover('SCENARIO_WORKTREE_MISSING', {
      teammateName: 'bob' as MailboxName,
    });

    assert.equal(result.ok, false);
    assert.equal(result.dataLoss, 'last_session');
    assert.match(result.detail!, /path.*missing/);
  });
});

test('SCENARIO_WORKTREE_MISSING: roster 无 entry → fail（dataLoss=unknown）', async () => {
  await withTempHome(async () => {
    const roster = makeMockWorktreeRoster([]);
    const handler = createRecoveryHandler({ worktreeRoster: roster });
    const result = await handler.recover('SCENARIO_WORKTREE_MISSING', {
      teammateName: 'unknown' as MailboxName,
    });

    assert.equal(result.ok, false);
    assert.equal(result.dataLoss, 'unknown');
    assert.match(result.detail!, /no roster entry/);
  });
});

test('SCENARIO_WORKTREE_MISSING: 缺 worktreeRoster → fail', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_WORKTREE_MISSING', {
      teammateName: 'alice' as MailboxName,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /worktreeRoster not injected/);
  });
});

// ============================================================
// 场景 8：fork metadata 缺失
// ============================================================

test('SCENARIO_FORK_METADATA_MISSING: 链路中有 fork point → 从 fork point 重建（dataLoss=last_turn）', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID() as SessionId;
    // 构造链路：第一条无 parentUuid（首条），第二条有 parentUuid 指向第一条
    const msgs = makeChain(5);
    // 篡改第 1 条的 parentUuid → 缺失（模拟 fork metadata 缺失）
    // 但保留有 parentUuid 的消息（让 fork point 可回溯）
    msgs[1] = { ...msgs[1], parentUuid: undefined }; // 模拟 fork metadata 缺失
    // 第 2 条之后仍有 parentUuid（指向 msgs[1].id）
    await writeTranscript(sessionId, msgs);

    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_FORK_METADATA_MISSING', { sessionId });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_turn');
    assert.ok(result.recoveredMessages);
    assert.ok(result.recoveredMessages!.length > 0);
  });
});

test('SCENARIO_FORK_METADATA_MISSING: 无 fork point → 视为新会话（dataLoss=last_session）', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID() as SessionId;
    // 全部消息无 parentUuid
    const msgs: Message[] = [];
    for (let i = 0; i < 3; i++) {
      msgs.push(makeMessage({ id: randomUUID() as UUID, parentUuid: undefined }));
    }
    await writeTranscript(sessionId, msgs);

    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_FORK_METADATA_MISSING', { sessionId });

    assert.equal(result.ok, true);
    assert.equal(result.dataLoss, 'last_session');
    assert.equal(result.recoveredMessages?.length, 0);
  });
});

test('SCENARIO_FORK_METADATA_MISSING: 缺 sessionId → fail', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_FORK_METADATA_MISSING', {});
    assert.equal(result.ok, false);
    assert.match(result.error!, /sessionId required/);
  });
});

// ============================================================
// 场景 9：mode 不匹配
// ============================================================

test('SCENARIO_MODE_MISMATCH: 返回 needsUserConfirm=true（dataLoss=none）', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_MODE_MISMATCH', {
      expectedMode: 'default' as PermissionMode,
    });

    // mode mismatch → 不自动修复，需用户确认
    assert.equal(result.ok, false); // ok=false 因为未恢复
    assert.equal(result.needsUserConfirm, true);
    assert.equal(result.dataLoss, 'none');
    assert.match(result.detail!, /default/);
    assert.match(result.detail!, /user must confirm/);
  });
});

test('SCENARIO_MODE_MISMATCH: 缺 expectedMode → fail', async () => {
  await withTempHome(async () => {
    const handler = createRecoveryHandler({});
    const result = await handler.recover('SCENARIO_MODE_MISMATCH', {});
    assert.equal(result.ok, false);
    assert.match(result.error!, /expectedMode required/);
  });
});

// ============================================================
// .bak 备份机制（场景 4 的前置）
// ============================================================

test('createMailboxBackup: 当前 mailbox 存在 → 复制到 .bak', async () => {
  await withTempHome(async () => {
    const name = 'alice' as MailboxName;
    const mailboxDir = defaultMailboxDir();
    await fs.mkdir(mailboxDir, { recursive: true });
    const mailboxPath = path.join(mailboxDir, `${name}.jsonl`);
    const bakPath = path.join(mailboxDir, `${name}.bak.jsonl`);

    await fs.writeFile(mailboxPath, 'current content', 'utf8');

    const handler = createRecoveryHandler({});
    await handler.createMailboxBackup(name);

    const bak = await fs.readFile(bakPath, 'utf8');
    assert.equal(bak, 'current content');
  });
});

test('createMailboxBackup: 当前 mailbox 不存在 → 不创建 .bak', async () => {
  await withTempHome(async () => {
    const name = 'new-teammate' as MailboxName;
    const handler = createRecoveryHandler({});
    await handler.createMailboxBackup(name); // 不应抛错

    const bakPath = path.join(defaultMailboxDir(), `${name}.bak.jsonl`);
    const exists = await fs.access(bakPath).then(() => true).catch(() => false);
    assert.equal(exists, false);
  });
});

// ============================================================
// 不变量 #16：9 场景全覆盖
// ============================================================

test('不变量 #16: 9 场景恢复矩阵全覆盖（每场景至少 1 个测试 PASS）', async () => {
  await withTempHome(async () => {
    const scenarios: Array<{
      scenario: Parameters<RecoveryHandler['recover']>[0];
      ctx: Parameters<RecoveryHandler['recover']>[1];
      expectOk: boolean;
    }> = [
      { scenario: 'SCENARIO_TRANSCRIPT_CORRUPT', ctx: { sessionId: randomUUID() as SessionId }, expectOk: true },
      { scenario: 'SCENARIO_SIDECHAIN_CORRUPT', ctx: { sidechainId: randomUUID() as UUID }, expectOk: false },
      { scenario: 'SCENARIO_TEAM_MISSING', ctx: { teammateName: 'x' as MailboxName }, expectOk: false },
      { scenario: 'SCENARIO_MAILBOX_CORRUPT', ctx: { teammateName: 'y' as MailboxName }, expectOk: true },
      { scenario: 'SCENARIO_TASK_CORRUPT', ctx: { taskId: 't1' as never }, expectOk: false },
      { scenario: 'SCENARIO_SIDECAR_404', ctx: { teammateName: 'z' as MailboxName }, expectOk: true },
      { scenario: 'SCENARIO_WORKTREE_MISSING', ctx: { teammateName: 'w' as MailboxName }, expectOk: false },
      { scenario: 'SCENARIO_FORK_METADATA_MISSING', ctx: {}, expectOk: false },
      { scenario: 'SCENARIO_MODE_MISMATCH', ctx: { expectedMode: 'default' as PermissionMode }, expectOk: false },
    ];

    const handler = createRecoveryHandler({});
    const results: string[] = [];
    for (const { scenario, ctx, expectOk } of scenarios) {
      const r = await handler.recover(scenario, ctx);
      // 每场景都不抛错（即使 ok=false 也应是预期内的失败，不是 crash）
      results.push(`${scenario}: ok=${r.ok} dataLoss=${r.dataLoss}`);
      // ok 与预期一致（场景 4 mailbox 不存在 → ok=true reset；场景 6 sidecar 404 → ok=true）
      if (scenario === 'SCENARIO_MAILBOX_CORRUPT' || scenario === 'SCENARIO_SIDECAR_404') {
        assert.equal(r.ok, true, `${scenario} 应 ok=true`);
      } else {
        assert.equal(r.ok, expectOk, `${scenario} ok 预期 ${expectOk}，实际 ${r.ok}`);
      }
    }
    // 9 场景全部不抛错
    assert.equal(results.length, 9);
  });
});
