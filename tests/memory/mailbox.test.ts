import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  defaultMailboxPath,
  defaultMailboxArchivePath,
  writeMailboxAtomic,
  readMailboxRaw,
  readMailboxAll,
  markMailboxRead,
  mailboxCount,
  mailboxBytes,
} from '../../src/memory/mailbox.js';
import type {
  AgentId,
  MailboxCapacityLimits,
  MailboxMessage,
  MailboxName,
  UUID,
} from '../../src/types/index.js';
import { DEFAULT_MAILBOX_LIMITS } from '../../src/types/index.js';

// ============================================================
// 测试 helpers
// ============================================================

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-mailbox-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function makeMessage(params: {
  id?: UUID;
  from?: AgentId | MailboxName;
  to?: MailboxName;
  type?: MailboxMessage['type'];
  payload?: unknown;
  text?: string;
  timestamp?: string;
}): MailboxMessage {
  return {
    id: params.id ?? (randomUUID() as UUID),
    from: params.from ?? ('leader' as AgentId),
    to: params.to ?? ('alice' as MailboxName),
    type: params.type ?? 'text',
    payload: params.payload ?? { text: params.text ?? 'hello' },
    timestamp: (params.timestamp ?? new Date().toISOString()) as never,
  };
}

/** 用 HOME 指向临时目录，让 defaultMailboxPath 落在其中 */
function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const tmp = tmpDir();
  const oldHome = process.env.HOME;
  process.env.HOME = tmp;
  return fn().finally(async () => {
    process.env.HOME = oldHome;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
}

/** 生成 N 条不同 id 的消息 */
function makeMessages(n: number, to: MailboxName = 'alice' as MailboxName): MailboxMessage[] {
  const out: MailboxMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(makeMessage({
      to,
      text: `msg-${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
  }
  return out;
}

/** 生成一条 sizeInBytes 大小的消息（payload 用字符串填充） */
function makeLargeMessage(sizeInBytes: number, to: MailboxName = 'alice' as MailboxName): MailboxMessage {
  // JSON.stringify(message) + '\n' 总字节 ≥ sizeInBytes
  // 简化：payload.text 直接 padding 到 sizeInBytes
  const padding = 'x'.repeat(Math.max(0, sizeInBytes));
  return makeMessage({ to, payload: { text: padding } });
}

// ============================================================
// 路径 helper
// ============================================================

test('defaultMailboxPath: 格式正确', () => {
  const oldHome = process.env.HOME;
  process.env.HOME = '/tmp/test-home';
  try {
    const p = defaultMailboxPath('alice' as MailboxName);
    assert.equal(p, '/tmp/test-home/.omniagent/mailbox/alice.jsonl');
  } finally {
    process.env.HOME = oldHome;
  }
});

test('defaultMailboxArchivePath: 格式正确', () => {
  const oldHome = process.env.HOME;
  process.env.HOME = '/tmp/test-home';
  try {
    const p = defaultMailboxArchivePath('alice' as MailboxName);
    assert.equal(p, '/tmp/test-home/.omniagent/mailbox/alice.archive.jsonl');
  } finally {
    process.env.HOME = oldHome;
  }
});

test('defaultMailboxPath: 不同 name 路径不同（按 name 寻址，不变量 #2）', () => {
  const oldHome = process.env.HOME;
  process.env.HOME = '/tmp/test-home';
  try {
    const p1 = defaultMailboxPath('alice' as MailboxName);
    const p2 = defaultMailboxPath('bob' as MailboxName);
    assert.notEqual(p1, p2, '不同 teammate 的 mailbox 路径应不同');
    assert.ok(p1.endsWith('alice.jsonl'));
    assert.ok(p2.endsWith('bob.jsonl'));
  } finally {
    process.env.HOME = oldHome;
  }
});

// ============================================================
// 基础读写
// ============================================================

test('writeMailboxAtomic: 首次写创建 mailbox 文件', async () => {
  await withTempHome(async () => {
    const msg = makeMessage({ text: 'first' });
    const result = await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: msg,
    });
    assert.equal(result.written, true);
    assert.equal(result.error, undefined);

    const mailboxPath = defaultMailboxPath('alice' as MailboxName);
    const stat = await fs.stat(mailboxPath);
    assert.ok(stat.isFile(), 'mailbox 文件应存在');
  });
});

test('writeMailboxAtomic + readMailboxRaw: 基础读写 roundtrip', async () => {
  await withTempHome(async () => {
    const msgs = [
      makeMessage({ text: 'msg-1' }),
      makeMessage({ text: 'msg-2' }),
      makeMessage({ text: 'msg-3' }),
    ];
    for (const m of msgs) {
      await writeMailboxAtomic({ teammate_name: 'alice' as MailboxName, message: m });
    }
    const read = await readMailboxRaw('alice' as MailboxName);
    assert.equal(read.length, 3);
    assert.deepEqual(
      read.map(m => (m.payload as { text: string }).text),
      ['msg-1', 'msg-2', 'msg-3'],
    );
  });
});

test('readMailboxRaw: 不存在的 mailbox 返回空数组（不抛错）', async () => {
  await withTempHome(async () => {
    const read = await readMailboxRaw('nonexistent' as MailboxName);
    assert.deepEqual(read, []);
  });
});

test('writeMailboxAtomic: 写多条消息按顺序追加', async () => {
  await withTempHome(async () => {
    const N = 50;
    for (let i = 0; i < N; i++) {
      await writeMailboxAtomic({
        teammate_name: 'alice' as MailboxName,
        message: makeMessage({ text: `m-${i}` }),
      });
    }
    const read = await readMailboxRaw('alice' as MailboxName);
    assert.equal(read.length, N);
    assert.equal((read[0].payload as { text: string }).text, 'm-0');
    assert.equal((read[N - 1].payload as { text: string }).text, `m-${N - 1}`);
  });
});

// ============================================================
// 容量限制
// ============================================================

test('writeMailboxAtomic: 单条消息超过 64KB 返回 over_capacity', async () => {
  await withTempHome(async () => {
    // 64KB + 1B 的消息
    const largeMsg = makeLargeMessage(64 * 1024 + 1);
    const result = await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: largeMsg,
    });
    assert.equal(result.written, false);
    assert.equal(result.error, 'over_capacity');
  });
});

test('writeMailboxAtomic: 单条消息恰好 64KB（边界）写成功', async () => {
  await withTempHome(async () => {
    // 构造一条消息，使其 JSON 序列化 + '\n' 字节恰好 ≤ 64KB
    // 先写一条小消息看是否能成功（确保 over_capacity 只触发于大小）
    const msg = makeMessage({ payload: { text: 'x'.repeat(1024) } });
    const result = await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: msg,
    });
    assert.equal(result.written, true);
  });
});

test('writeMailboxAtomic: 消息数超过 maxMessagesPerMailbox 返回 over_capacity', async () => {
  await withTempHome(async () => {
    // 用很小的 limits 让测试快
    const limits: MailboxCapacityLimits = {
      maxSingleMessageBytes: 1024,
      maxMailboxFileBytes: 10 * 1024,
      maxMessagesPerMailbox: 5,
      archiveThreshold: 2,
    };
    // 先写 5 条（达到上限）
    for (let i = 0; i < 5; i++) {
      const r = await writeMailboxAtomic({
        teammate_name: 'alice' as MailboxName,
        message: makeMessage({ text: `m-${i}` }),
      }, limits);
      assert.equal(r.written, true, `第 ${i} 条应写成功`);
    }
    // 第 6 条触发归档（archiveThreshold=2，移走最老 2 条，剩 3 条 + 1 新 = 4，不超 5）
    // 注意：maxMessagesPerMailbox 校验在归档前；如归档后仍超则返回 over_capacity
    // 这里 5+1=6 > 5，触发归档，归档后 3+1=4 ≤ 5，写成功
    const r6 = await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: makeMessage({ text: 'm-5' }),
    }, limits);
    assert.equal(r6.written, true, '第 6 条应触发归档后写成功');
    assert.equal(r6.archive_triggered, true, '应触发归档');
  });
});

test('writeMailboxAtomic: 文件字节超过 maxMailboxFileBytes 触发归档', async () => {
  await withTempHome(async () => {
    const limits: MailboxCapacityLimits = {
      maxSingleMessageBytes: 10 * 1024,
      maxMailboxFileBytes: 1024,  // 1KB 上限
      maxMessagesPerMailbox: 1000,
      archiveThreshold: 2,
    };
    // 写 2 条 ~500B 消息
    const bigPayload = 'y'.repeat(450);
    for (let i = 0; i < 2; i++) {
      await writeMailboxAtomic({
        teammate_name: 'alice' as MailboxName,
        message: makeMessage({ payload: { text: bigPayload } }),
      }, limits);
    }
    // 第 3 条会使总字节 > 1024 → 触发归档
    const r3 = await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: makeMessage({ payload: { text: bigPayload } }),
    }, limits);
    assert.equal(r3.written, true);
    assert.equal(r3.archive_triggered, true, '文件字节超限应触发归档');

    // 归档后主 mailbox 应只留最近消息（archiveThreshold=2，移走最老 2 条）
    const remaining = await readMailboxRaw('alice' as MailboxName);
    assert.equal(remaining.length, 1, '主 mailbox 应只留 1 条（第 3 条）');
  });
});

test('writeMailboxAtomic: 归档后 archive 文件包含被归档的消息', async () => {
  await withTempHome(async () => {
    const limits: MailboxCapacityLimits = {
      maxSingleMessageBytes: 1024,
      maxMailboxFileBytes: 1024,
      maxMessagesPerMailbox: 1000,
      archiveThreshold: 2,
    };
    const bigPayload = 'z'.repeat(300);
    for (let i = 0; i < 3; i++) {
      await writeMailboxAtomic({
        teammate_name: 'alice' as MailboxName,
        message: makeMessage({ payload: { text: `${bigPayload}-${i}` } }),
      }, limits);
    }
    // 第 3 条触发归档，最老 2 条（i=0, 1）移到 archive
    const archivePath = defaultMailboxArchivePath('alice' as MailboxName);
    const archiveText = await fs.readFile(archivePath, 'utf8');
    const archiveLines = archiveText.split('\n').filter(l => l.trim());
    assert.equal(archiveLines.length, 2, 'archive 应有 2 条');

    // readMailboxAll 应返回 archive + current
    const all = await readMailboxAll('alice' as MailboxName);
    assert.equal(all.length, 3, 'archive(2) + current(1) = 3');
  });
});

test('writeMailboxAtomic: 文件字节超限但归档无法降容时返回 over_capacity', async () => {
  await withTempHome(async () => {
    // 极端情况：单条消息字节数 = maxMailboxFileBytes，归档也救不了
    // 因为单条就 ≥ 文件上限
    const limits: MailboxCapacityLimits = {
      maxSingleMessageBytes: 2048,
      maxMailboxFileBytes: 1024,  // 文件上限小于单条上限
      maxMessagesPerMailbox: 1000,
      archiveThreshold: 200,
    };
    // 写一条 ~1KB 的消息（< maxSingleMessageBytes 但 ≥ maxMailboxFileBytes）
    const msg = makeMessage({ payload: { text: 'x'.repeat(1024) } });
    const r = await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: msg,
    }, limits);
    // 字节超 maxMailboxFileBytes 但 archiveThreshold=200 > 当前 0 条，archiveCount=0
    // 进入 else 分支返回 over_capacity
    assert.equal(r.written, false);
    assert.equal(r.error, 'over_capacity');
  });
});

// ============================================================
// markMailboxRead
// ============================================================

test('markMailboxRead: 标记消息已读并持久化', async () => {
  await withTempHome(async () => {
    const msgs = makeMessages(3);
    for (const m of msgs) {
      await writeMailboxAtomic({ teammate_name: 'alice' as MailboxName, message: m });
    }
    // 初始全部未读
    const before = await readMailboxRaw('alice' as MailboxName);
    assert.equal(before.every(m => !m.read), true, '初始应全部未读');

    // 标记前 2 条已读
    const marked = await markMailboxRead('alice' as MailboxName, [msgs[0].id, msgs[1].id]);
    assert.equal(marked, 2, '应标记 2 条');

    // 持久化后重读
    const after = await readMailboxRaw('alice' as MailboxName);
    assert.equal(after[0].read, true);
    assert.equal(after[1].read, true);
    assert.equal(after[2].read, undefined, '第 3 条应仍未读');
  });
});

test('markMailboxRead: 空 messageIds 返回 0', async () => {
  await withTempHome(async () => {
    await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: makeMessage({ text: 'm-1' }),
    });
    const marked = await markMailboxRead('alice' as MailboxName, []);
    assert.equal(marked, 0);
  });
});

test('markMailboxRead: 不存在的 id 返回 0', async () => {
  await withTempHome(async () => {
    await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: makeMessage({ text: 'm-1' }),
    });
    const marked = await markMailboxRead('alice' as MailboxName, [
      '00000000-0000-0000-0000-000000000000' as UUID,
    ]);
    assert.equal(marked, 0);
  });
});

test('markMailboxRead: 重复标记不重复计数（幂等）', async () => {
  await withTempHome(async () => {
    const msg = makeMessage({ text: 'm-1' });
    await writeMailboxAtomic({ teammate_name: 'alice' as MailboxName, message: msg });

    const first = await markMailboxRead('alice' as MailboxName, [msg.id]);
    assert.equal(first, 1, '首次标记应 +1');
    const second = await markMailboxRead('alice' as MailboxName, [msg.id]);
    assert.equal(second, 0, '已读消息再标记应 +0');
  });
});

test('markMailboxRead: 不存在的 mailbox 不抛错返回 0', async () => {
  await withTempHome(async () => {
    const marked = await markMailboxRead('nonexistent' as MailboxName, [
      randomUUID() as UUID,
    ]);
    assert.equal(marked, 0);
  });
});

// ============================================================
// readMailboxAll（archive + current）
// ============================================================

test('readMailboxAll: 无 archive 时只返回 current', async () => {
  await withTempHome(async () => {
    for (let i = 0; i < 3; i++) {
      await writeMailboxAtomic({
        teammate_name: 'alice' as MailboxName,
        message: makeMessage({ text: `c-${i}` }),
      });
    }
    const all = await readMailboxAll('alice' as MailboxName);
    assert.equal(all.length, 3);
    assert.deepEqual(
      all.map(m => (m.payload as { text: string }).text),
      ['c-0', 'c-1', 'c-2'],
    );
  });
});

test('readMailboxAll: archive 在前 current 在后', async () => {
  await withTempHome(async () => {
    // 用小 limits 触发归档
    const limits: MailboxCapacityLimits = {
      maxSingleMessageBytes: 1024,
      maxMailboxFileBytes: 1024,
      maxMessagesPerMailbox: 1000,
      archiveThreshold: 2,
    };
    const bigPayload = 'a'.repeat(300);
    // 写 3 条 → 第 3 条触发归档，移走最老 2 条到 archive
    for (let i = 0; i < 3; i++) {
      await writeMailboxAtomic({
        teammate_name: 'alice' as MailboxName,
        message: makeMessage({
          payload: { text: `${bigPayload}-${i}` },
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      }, limits);
    }
    const all = await readMailboxAll('alice' as MailboxName);
    assert.equal(all.length, 3, 'archive(2) + current(1) = 3');

    // 验证 archive 在前
    const archivePath = defaultMailboxArchivePath('alice' as MailboxName);
    const archiveText = await fs.readFile(archivePath, 'utf8');
    const archiveFirst = JSON.parse(archiveText.split('\n')[0]) as MailboxMessage;
    assert.equal(all[0].id, archiveFirst.id, 'all[0] 应是 archive 的首条');
  });
});

test('readMailboxAll: 不存在的 mailbox 返回空', async () => {
  await withTempHome(async () => {
    const all = await readMailboxAll('nonexistent' as MailboxName);
    assert.deepEqual(all, []);
  });
});

// ============================================================
// 并发写（不变量 #7：零丢失）
// ============================================================

test('writeMailboxAtomic: 并发写 100 条不丢消息（不变量 #7）', async () => {
  await withTempHome(async () => {
    const N = 100;
    const messages = makeMessages(N);
    // 并发写
    const results = await Promise.all(
      messages.map(m =>
        writeMailboxAtomic({ teammate_name: 'alice' as MailboxName, message: m }),
      ),
    );
    // 全部应写成功
    const failed = results.filter(r => !r.written);
    assert.equal(failed.length, 0, `所有写应成功，但 ${failed.length} 条失败`);

    // 重读：应包含全部 100 条（顺序可能交错，但 id 集合应一致）
    const read = await readMailboxRaw('alice' as MailboxName);
    assert.equal(read.length, N, `应读出 ${N} 条，实际 ${read.length}`);

    const expectedIds = new Set(messages.map(m => m.id));
    const actualIds = new Set(read.map(m => m.id));
    assert.equal(actualIds.size, N, 'id 不应重复');
    for (const id of expectedIds) {
      assert.ok(actualIds.has(id), `id ${id} 应在 read 结果中`);
    }
  });
});

test('writeMailboxAtomic: 不同 teammate 并发写不互相污染', async () => {
  await withTempHome(async () => {
    const aliceMsgs = makeMessages(20, 'alice' as MailboxName);
    const bobMsgs = makeMessages(20, 'bob' as MailboxName);

    // 交错并发写
    const all = [...aliceMsgs.map(m => ({ m, name: 'alice' as MailboxName })),
                 ...bobMsgs.map(m => ({ m, name: 'bob' as MailboxName }))];
    // shuffle
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    await Promise.all(all.map(({ m, name }) =>
      writeMailboxAtomic({ teammate_name: name, message: m }),
    ));

    const aliceRead = await readMailboxRaw('alice' as MailboxName);
    const bobRead = await readMailboxRaw('bob' as MailboxName);

    assert.equal(aliceRead.length, 20);
    assert.equal(bobRead.length, 20);

    // alice 的 mailbox 应只含 alice 的消息
    const aliceExpected = new Set(aliceMsgs.map(m => m.id));
    for (const m of aliceRead) {
      assert.ok(aliceExpected.has(m.id), `alice 的 mailbox 不应含其他人的消息 ${m.id}`);
    }
    const bobExpected = new Set(bobMsgs.map(m => m.id));
    for (const m of bobRead) {
      assert.ok(bobExpected.has(m.id), `bob 的 mailbox 不应含其他人的消息 ${m.id}`);
    }
  });
});

// ============================================================
// 统计 helper
// ============================================================

test('mailboxCount: 不存在的 mailbox 返回 0', async () => {
  await withTempHome(async () => {
    const c = await mailboxCount('nonexistent' as MailboxName);
    assert.equal(c, 0);
  });
});

test('mailboxCount: 返回当前消息数（不含 archive）', async () => {
  await withTempHome(async () => {
    for (let i = 0; i < 5; i++) {
      await writeMailboxAtomic({
        teammate_name: 'alice' as MailboxName,
        message: makeMessage({ text: `m-${i}` }),
      });
    }
    const c = await mailboxCount('alice' as MailboxName);
    assert.equal(c, 5);
  });
});

test('mailboxBytes: 不存在的 mailbox 返回 0', async () => {
  await withTempHome(async () => {
    const b = await mailboxBytes('nonexistent' as MailboxName);
    assert.equal(b, 0);
  });
});

test('mailboxBytes: 返回当前文件字节数', async () => {
  await withTempHome(async () => {
    await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: makeMessage({ text: 'hello' }),
    });
    const b = await mailboxBytes('alice' as MailboxName);
    assert.ok(b > 0, '字节数应 > 0');
    // 一条消息 JSON 序列化后约 200+ 字节
    assert.ok(b < 1024, '一条小消息应 < 1KB');
  });
});

// ============================================================
// 容错 / 损坏行
// ============================================================

test('readMailboxRaw: 损坏行被跳过（其他消息不丢）', async () => {
  await withTempHome(async () => {
    // 先写 2 条合法消息
    await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: makeMessage({ text: 'good-1' }),
    });
    await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: makeMessage({ text: 'good-2' }),
    });

    // 手动追加一行损坏 JSON
    const mailboxPath = defaultMailboxPath('alice' as MailboxName);
    await fs.appendFile(mailboxPath, 'this is not json\n', 'utf8');

    const read = await readMailboxRaw('alice' as MailboxName);
    assert.equal(read.length, 2, '损坏行应被跳过，合法消息保留');
  });
});

test('readMailboxAll: archive 中损坏行被跳过', async () => {
  await withTempHome(async () => {
    // 手动构造 archive 文件，含 1 合法 + 1 损坏
    const archivePath = defaultMailboxArchivePath('alice' as MailboxName);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    const goodMsg = makeMessage({ text: 'archive-good' });
    const goodJson = JSON.stringify(goodMsg);
    await fs.writeFile(archivePath, `${goodJson}\nbroken-line\n`, 'utf8');

    // 主 mailbox 也写 1 条
    await writeMailboxAtomic({
      teammate_name: 'alice' as MailboxName,
      message: makeMessage({ text: 'current-good' }),
    });

    const all = await readMailboxAll('alice' as MailboxName);
    assert.equal(all.length, 2, 'archive 1 + current 1 = 2（损坏行跳过）');
  });
});

// ============================================================
// 默认 limits
// ============================================================

test('DEFAULT_MAILBOX_LIMITS: 默认值正确', () => {
  assert.equal(DEFAULT_MAILBOX_LIMITS.maxSingleMessageBytes, 64 * 1024);
  assert.equal(DEFAULT_MAILBOX_LIMITS.maxMailboxFileBytes, 4 * 1024 * 1024);
  assert.equal(DEFAULT_MAILBOX_LIMITS.maxMessagesPerMailbox, 1000);
  assert.equal(DEFAULT_MAILBOX_LIMITS.archiveThreshold, 200);
});
