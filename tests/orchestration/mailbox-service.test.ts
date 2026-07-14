import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { MailboxService } from '../../src/orchestration/mailbox-service.js';
import { defaultMailboxPath } from '../../src/memory/mailbox.js';
import type { MailboxName, UUID } from '../../src/types/index.js';

// ============================================================
// 测试 helpers
// ============================================================

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-mailbox-svc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

// ============================================================
// send
// ============================================================

test('MailboxService.send: 写入消息并返回 messageId', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const result = await svc.send({
      from: 'leader' as never,
      to: 'alice' as MailboxName,
      type: 'text',
      payload: { text: 'hello' },
    });
    assert.equal(result.written, true);
    assert.ok(result.messageId, '应返回 messageId');
    assert.match(result.messageId! as string, /^[0-9a-f-]{36}$/);
  });
});

test('MailboxService.send: 自动生成 id + timestamp', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const result = await svc.send({
      from: 'leader' as never,
      to: 'alice' as MailboxName,
      type: 'text',
      payload: { text: 'msg-1' },
    });
    assert.equal(result.written, true);

    const read = await svc.read('alice' as MailboxName);
    assert.equal(read.length, 1);
    assert.equal(read[0].id, result.messageId);
    assert.ok(read[0].timestamp, 'timestamp 应已自动生成');
    assert.match(read[0].timestamp as string, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('MailboxService.send: 支持自定义 id + timestamp', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const customId = '11111111-2222-3333-4444-555555555555' as UUID;
    const customTs = '2026-07-13T10:00:00.000Z';
    const result = await svc.send({
      from: 'leader' as never,
      to: 'alice' as MailboxName,
      type: 'text',
      payload: { text: 'custom' },
      id: customId,
      timestamp: customTs,
    });
    assert.equal(result.written, true);
    assert.equal(result.messageId, customId);

    const read = await svc.read('alice' as MailboxName);
    assert.equal(read[0].id, customId);
    assert.equal(read[0].timestamp, customTs as never);
  });
});

test('MailboxService.send: 不同 name 路径不同（不变量 #2）', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    await svc.send({
      from: 'leader' as never,
      to: 'alice' as MailboxName,
      type: 'text',
      payload: { text: 'for-alice' },
    });
    await svc.send({
      from: 'leader' as never,
      to: 'bob' as MailboxName,
      type: 'text',
      payload: { text: 'for-bob' },
    });

    const alicePath = defaultMailboxPath('alice' as MailboxName);
    const bobPath = defaultMailboxPath('bob' as MailboxName);
    assert.notEqual(alicePath, bobPath);

    const aliceRead = await svc.read('alice' as MailboxName);
    const bobRead = await svc.read('bob' as MailboxName);
    assert.equal(aliceRead.length, 1);
    assert.equal(bobRead.length, 1);
    assert.equal((aliceRead[0].payload as { text: string }).text, 'for-alice');
    assert.equal((bobRead[0].payload as { text: string }).text, 'for-bob');
  });
});

test('MailboxService.send: 单条超 64KB 返回 over_capacity', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const result = await svc.send({
      from: 'leader' as never,
      to: 'alice' as MailboxName,
      type: 'text',
      payload: { text: 'x'.repeat(64 * 1024 + 100) },
    });
    assert.equal(result.written, false);
    assert.equal(result.error, 'over_capacity');
  });
});

test('MailboxService.send: 并发 send 100 条不丢消息（不变量 #7）', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        svc.send({
          from: 'leader' as never,
          to: 'alice' as MailboxName,
          type: 'text',
          payload: { text: `m-${i}` },
        }),
      ),
    );
    const failed = results.filter(r => !r.written);
    assert.equal(failed.length, 0, '所有写应成功');

    const read = await svc.read('alice' as MailboxName);
    assert.equal(read.length, N, `应读出 ${N} 条`);
  });
});

// ============================================================
// read / readCurrent / readUnread
// ============================================================

test('MailboxService.read: 含 archive（archive 在前）', async () => {
  await withTempHome(async () => {
    // 用小 limits 触发归档
    const svc = new MailboxService({
      limits: {
        maxSingleMessageBytes: 1024,
        maxMailboxFileBytes: 1024,
        maxMessagesPerMailbox: 1000,
        archiveThreshold: 2,
      },
    });
    const bigPayload = 'a'.repeat(300);
    for (let i = 0; i < 3; i++) {
      await svc.send({
        from: 'leader' as never,
        to: 'alice' as MailboxName,
        type: 'text',
        payload: { text: `${bigPayload}-${i}` },
      });
    }
    const all = await svc.read('alice' as MailboxName);
    assert.equal(all.length, 3, 'archive(2) + current(1)');
  });
});

test('MailboxService.readCurrent: 不含 archive', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService({
      limits: {
        maxSingleMessageBytes: 1024,
        maxMailboxFileBytes: 1024,
        maxMessagesPerMailbox: 1000,
        archiveThreshold: 2,
      },
    });
    const bigPayload = 'b'.repeat(300);
    for (let i = 0; i < 3; i++) {
      await svc.send({
        from: 'leader' as never,
        to: 'alice' as MailboxName,
        type: 'text',
        payload: { text: `${bigPayload}-${i}` },
      });
    }
    const current = await svc.readCurrent('alice' as MailboxName);
    assert.equal(current.length, 1, '主 mailbox 应只留 1 条');
  });
});

test('MailboxService.readUnread: 返回未读消息', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const r1 = await svc.send({
      from: 'leader' as never,
      to: 'alice' as MailboxName,
      type: 'text',
      payload: { text: 'm-1' },
    });
    const r2 = await svc.send({
      from: 'leader' as never,
      to: 'alice' as MailboxName,
      type: 'text',
      payload: { text: 'm-2' },
    });
    const r3 = await svc.send({
      from: 'leader' as never,
      to: 'alice' as MailboxName,
      type: 'text',
      payload: { text: 'm-3' },
    });

    // 标记前 2 条已读
    await svc.markRead('alice' as MailboxName, [r1.messageId!, r2.messageId!]);

    const unread = await svc.readUnread('alice' as MailboxName);
    assert.equal(unread.length, 1, '只 1 条未读');
    assert.equal(unread[0].id, r3.messageId);
  });
});

test('MailboxService.readUnread: 不存在的 mailbox 返回空', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const unread = await svc.readUnread('nonexistent' as MailboxName);
    assert.deepEqual(unread, []);
  });
});

test('MailboxService.markRead: 标记后 unreadCount 减少', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const r1 = await svc.send({
      from: 'leader' as never,
      to: 'alice' as MailboxName,
      type: 'text',
      payload: { text: 'm-1' },
    });
    const r2 = await svc.send({
      from: 'leader' as never,
      to: 'alice' as MailboxName,
      type: 'text',
      payload: { text: 'm-2' },
    });

    assert.equal(await svc.unreadCount('alice' as MailboxName), 2);
    await svc.markRead('alice' as MailboxName, [r1.messageId!]);
    assert.equal(await svc.unreadCount('alice' as MailboxName), 1);
    await svc.markRead('alice' as MailboxName, [r2.messageId!]);
    assert.equal(await svc.unreadCount('alice' as MailboxName), 0);
  });
});

// ============================================================
// 便捷方法
// ============================================================

test('MailboxService.sendText: 写入 text 消息', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const r = await svc.sendText('leader' as never, 'alice' as MailboxName, 'hi');
    assert.equal(r.written, true);

    const read = await svc.read('alice' as MailboxName);
    assert.equal(read.length, 1);
    assert.equal(read[0].type, 'text');
    assert.equal((read[0].payload as { text: string }).text, 'hi');
  });
});

test('MailboxService.sendShutdownRequest: 写入 shutdown_request 类型', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const r = await svc.sendShutdownRequest(
      'leader' as never,
      'alice' as MailboxName,
      'user_exit',
    );
    assert.equal(r.written, true);

    const read = await svc.read('alice' as MailboxName);
    assert.equal(read.length, 1);
    assert.equal(read[0].type, 'shutdown_request');
    assert.deepEqual(read[0].payload, { reason: 'user_exit' });
  });
});

test('MailboxService.sendShutdownResponse: approve=true', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const r = await svc.sendShutdownResponse(
      'alice' as MailboxName,
      'leader' as never,
      true,
      'work done',
    );
    assert.equal(r.written, true);

    const read = await svc.read('leader' as MailboxName);
    assert.equal(read[0].type, 'shutdown_response');
    assert.deepEqual(read[0].payload, { approve: true, reason: 'work done' });
  });
});

test('MailboxService.sendShutdownResponse: approve=false', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const r = await svc.sendShutdownResponse(
      'alice' as MailboxName,
      'leader' as never,
      false,
    );
    assert.equal(r.written, true);

    const read = await svc.read('leader' as MailboxName);
    assert.equal(read[0].type, 'shutdown_response');
    assert.equal((read[0].payload as { approve: boolean }).approve, false);
    assert.ok(!('reason' in (read[0].payload as object)), 'reason 应未设置');
  });
});

test('MailboxService.sendTaskUpdate: 写入 task_update 类型', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const r = await svc.sendTaskUpdate(
      'alice' as MailboxName,
      'leader' as never,
      {
        task_id: 'task-42',
        status: 'completed',
        result: { files: ['a.ts'] },
      },
    );
    assert.equal(r.written, true);

    const read = await svc.read('leader' as MailboxName);
    assert.equal(read[0].type, 'task_update');
    assert.deepEqual(read[0].payload, {
      task_id: 'task-42',
      status: 'completed',
      result: { files: ['a.ts'] },
    });
  });
});

// ============================================================
// count
// ============================================================

test('MailboxService.count: 不存在的 mailbox 返回 0', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    const c = await svc.count('nonexistent' as MailboxName);
    assert.equal(c, 0);
  });
});

test('MailboxService.count: 返回当前消息数（不含 archive）', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();
    for (let i = 0; i < 5; i++) {
      await svc.sendText('leader' as never, 'alice' as MailboxName, `m-${i}`);
    }
    const c = await svc.count('alice' as MailboxName);
    assert.equal(c, 5);
  });
});

// ============================================================
// 集成：send + read + markRead 完整流程
// ============================================================

test('MailboxService: leader → teammate send + teammate read + markRead 完整流程', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();

    // leader 给 alice 发 3 条消息
    const r1 = await svc.sendText('leader' as never, 'alice' as MailboxName, 'task-1');
    const r2 = await svc.sendText('leader' as never, 'alice' as MailboxName, 'task-2');
    const r3 = await svc.sendText('leader' as never, 'alice' as MailboxName, 'task-3');

    // alice 轮询发现有 3 条未读
    assert.equal(await svc.unreadCount('alice' as MailboxName), 3);

    // alice 读取未读
    const unread = await svc.readUnread('alice' as MailboxName);
    assert.equal(unread.length, 3);

    // alice 处理完前 2 条，标记已读
    await svc.markRead('alice' as MailboxName, [r1.messageId!, r2.messageId!]);
    assert.equal(await svc.unreadCount('alice' as MailboxName), 1);

    // alice 处理完第 3 条
    await svc.markRead('alice' as MailboxName, [r3.messageId!]);
    assert.equal(await svc.unreadCount('alice' as MailboxName), 0);

    // 全部已读后 readUnread 返回空
    const finalUnread = await svc.readUnread('alice' as MailboxName);
    assert.equal(finalUnread.length, 0);

    // 但 read 仍返回全部 3 条
    const all = await svc.read('alice' as MailboxName);
    assert.equal(all.length, 3);
  });
});

test('MailboxService: 双向通信（leader ↔ teammate）', async () => {
  await withTempHome(async () => {
    const svc = new MailboxService();

    // leader → alice: shutdown_request
    await svc.sendShutdownRequest(
      'leader' as never,
      'alice' as MailboxName,
      'budget_exceeded',
    );

    // alice → leader: shutdown_response approve
    await svc.sendShutdownResponse(
      'alice' as MailboxName,
      'leader' as never,
      true,
      'work committed',
    );

    // leader 读取自己的 mailbox
    const leaderMsgs = await svc.read('leader' as never);
    assert.equal(leaderMsgs.length, 1);
    assert.equal(leaderMsgs[0].type, 'shutdown_response');
    assert.deepEqual(leaderMsgs[0].payload, { approve: true, reason: 'work committed' });
    assert.equal(leaderMsgs[0].from, 'alice' as never);

    // alice 读取自己的 mailbox
    const aliceMsgs = await svc.read('alice' as MailboxName);
    assert.equal(aliceMsgs.length, 1);
    assert.equal(aliceMsgs[0].type, 'shutdown_request');
    assert.deepEqual(aliceMsgs[0].payload, { reason: 'budget_exceeded' });
  });
});
