import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { MailboxService } from '../../../../src/orchestration/mailbox-service.js';
import { createSendMessageTool } from '../../../../src/tools/builtin/orchestration/send-message.js';
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
    `omniagent-send-msg-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    toolUseId: 'tu-send-1' as ToolUseId,
  };
}

function getText(result: ToolResult): string {
  const block = result.content[0];
  return block.type === 'text' ? block.text : '';
}

function makeFixture() {
  const mailboxService = new MailboxService();
  const tool = createSendMessageTool({
    mailboxService,
    parentAgentId: () => 'leader-agent-id',
  });
  return { tool, mailboxService };
}

// ============================================================
// 工具元数据
// ============================================================

test('SendMessageTool: 工具名 + 元数据满足契约', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    assert.equal(tool.name, 'send_message');
    assert.equal(tool.isReadOnly, false);
    assert.equal(tool.isDestructive, false);
    assert.equal(tool.isConcurrencySafe, true);
    assert.equal(tool.isBackground, false);
  });
});

test('SendMessageTool: checkPermissions M2 stub allow', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    const decision = tool.checkPermissions({ to: 'alice', text: 'hi' } as never);
    assert.equal(decision.decision, 'allow');
    assert.equal(decision.matchedRule, 'm2-stub');
    assert.equal(decision.layer, 2);
  });
});

// ============================================================
// 基本发送
// ============================================================

test('SendMessageTool: 默认 type=text 发送文本', async () => {
  await withTempHome(async () => {
    const { tool, mailboxService } = makeFixture();
    const result = await tool.call(
      { to: 'alice', text: 'hello world' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, false);
    assert.match(getText(result), /delivered to "alice"/);

    // 验证 mailbox 收到
    const msgs = await mailboxService.readUnread('alice');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'text');
    assert.equal((msgs[0].payload as { text: string }).text, 'hello world');
    assert.equal(msgs[0].from, 'leader-agent-id');
    assert.equal(msgs[0].to, 'alice');
  });
});

test('SendMessageTool: 显式 type=text 与默认一致', async () => {
  await withTempHome(async () => {
    const { tool, mailboxService } = makeFixture();
    const result = await tool.call(
      { to: 'alice', text: 'explicit text', type: 'text' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, false);
    const msgs = await mailboxService.readUnread('alice');
    assert.equal(msgs.length, 1);
    assert.equal((msgs[0].payload as { text: string }).text, 'explicit text');
  });
});

test('SendMessageTool: 返回 message_id 与 archive_triggered', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    const result = await tool.call(
      { to: 'alice', text: 'check id' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, false);
    const text = getText(result);
    assert.match(text, /"message_id":\s*"[0-9a-f-]{36}"/);
    assert.match(text, /"archive_triggered":\s*false/);
  });
});

// ============================================================
// 参数校验
// ============================================================

test('SendMessageTool: 缺 to 返回 error', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    const result = await tool.call(
      { text: 'hi' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, true);
    assert.match(getText(result), /to \(teammate name\) is required/);
  });
});

test('SendMessageTool: 缺 text 返回 error', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    const result = await tool.call(
      { to: 'alice' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, true);
    assert.match(getText(result), /text is required/);
  });
});

// ============================================================
// 高级消息类型
// ============================================================

test('SendMessageTool: type=task_update 携带 payload', async () => {
  await withTempHome(async () => {
    const { tool, mailboxService } = makeFixture();
    const result = await tool.call(
      {
        to: 'alice',
        text: 'unused',  // type != text 时 payload 优先
        type: 'task_update',
        payload: { task_id: 'task-001', status: 'completed', result: 'ok' },
      } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, false);
    const msgs = await mailboxService.readUnread('alice');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'task_update');
    assert.equal((msgs[0].payload as { task_id: string }).task_id, 'task-001');
    assert.equal((msgs[0].payload as { status: string }).status, 'completed');
  });
});

test('SendMessageTool: type=shutdown_request', async () => {
  await withTempHome(async () => {
    const { tool, mailboxService } = makeFixture();
    const result = await tool.call(
      {
        to: 'alice',
        text: 'unused',
        type: 'shutdown_request',
        payload: { reason: 'user_exit' },
      } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, false);
    const msgs = await mailboxService.readUnread('alice');
    assert.equal(msgs[0].type, 'shutdown_request');
    assert.equal((msgs[0].payload as { reason: string }).reason, 'user_exit');
  });
});

test('SendMessageTool: 非法 type 默认回退到 text', async () => {
  await withTempHome(async () => {
    const { tool, mailboxService } = makeFixture();
    // 非法 type → 默认 'text'
    const result = await tool.call(
      { to: 'alice', text: 'fallback text', type: 'invalid_type' } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, false);
    const msgs = await mailboxService.readUnread('alice');
    assert.equal(msgs[0].type, 'text');
    assert.equal((msgs[0].payload as { text: string }).text, 'fallback text');
  });
});

// ============================================================
// 容量限制 + 不变量 #7（零丢失）
// ============================================================

test('SendMessageTool: 容量超限返回 error（不变量 #7 不静默丢消息）', async () => {
  await withTempHome(async () => {
    const mailboxService = new MailboxService({
      limits: {
        maxSingleMessageBytes: 100,
        maxMailboxFileBytes: 1024,
        maxMessagesPerMailbox: 1000,
        archiveThreshold: 200,
      },
    });
    const tool = createSendMessageTool({
      mailboxService,
      parentAgentId: () => 'leader',
    });

    // 大消息 → 写失败
    const big = 'x'.repeat(200);
    const result = await tool.call(
      { to: 'alice', text: big } as never,
      makeCtx(),
    );
    assert.equal(result.is_error, true);
    assert.match(getText(result), /mailbox write to "alice" failed/);
    assert.match(getText(result), /over_capacity|io_error/);
  });
});

// ============================================================
// 并发写入（不变量 #7：零丢失）
// ============================================================

test('SendMessageTool: 并发 50 条全部落盘', async () => {
  await withTempHome(async () => {
    const { tool, mailboxService } = makeFixture();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        tool.call({ to: 'alice', text: `msg-${i}` } as never, makeCtx()),
      ),
    );
    const okCount = results.filter(r => !r.is_error).length;
    assert.equal(okCount, 50, '所有 50 条并发都应成功');

    const msgs = await mailboxService.readUnread('alice');
    assert.equal(msgs.length, 50, 'mailbox 应有全部 50 条消息');

    // 验证消息内容齐全
    const texts = new Set(
      msgs.map(m => (m.payload as { text: string }).text),
    );
    for (let i = 0; i < 50; i++) {
      assert.ok(texts.has(`msg-${i}`), `msg-${i} 应在 mailbox 中`);
    }
  });
});

// ============================================================
// 跨 name 隔离
// ============================================================

test('SendMessageTool: 不同 name 隔离', async () => {
  await withTempHome(async () => {
    const { tool, mailboxService } = makeFixture();
    await tool.call({ to: 'alice', text: 'for alice' } as never, makeCtx());
    await tool.call({ to: 'bob', text: 'for bob' } as never, makeCtx());

    const aliceMsgs = await mailboxService.readUnread('alice');
    const bobMsgs = await mailboxService.readUnread('bob');
    assert.equal(aliceMsgs.length, 1);
    assert.equal(bobMsgs.length, 1);
    assert.equal((aliceMsgs[0].payload as { text: string }).text, 'for alice');
    assert.equal((bobMsgs[0].payload as { text: string }).text, 'for bob');
  });
});

// ============================================================
// 持久化
// ============================================================

test('SendMessageTool: 消息持久化到 ~/.omniagent/mailbox/<name>.jsonl', async () => {
  await withTempHome(async () => {
    const { tool } = makeFixture();
    await tool.call({ to: 'alice', text: 'persisted' } as never, makeCtx());

    const mailboxPath = path.join(
      process.env.HOME!, '.omniagent', 'mailbox', 'alice.jsonl',
    );
    const stat = await fs.stat(mailboxPath);
    assert.ok(stat.isFile());

    const raw = await fs.readFile(mailboxPath, 'utf-8');
    assert.ok(raw.includes('persisted'));
  });
});

// ============================================================
// 集成：leader ↔ teammate 双向
// ============================================================

test('SendMessageTool: leader 发消息 → teammate mailbox 收齐 → teammate 回复', async () => {
  await withTempHome(async () => {
    const { tool, mailboxService } = makeFixture();

    // leader → alice
    await tool.call({ to: 'alice', text: 'please review PR' } as never, makeCtx());

    // alice → leader（alice 也是个 teammate）
    const aliceTool = createSendMessageTool({
      mailboxService,
      parentAgentId: () => 'alice-agent-id',
    });
    await aliceTool.call({ to: 'leader', text: 'PR reviewed, looks good' } as never, makeCtx());

    // 验证 leader 收到 alice 的消息
    const leaderMsgs = await mailboxService.readUnread('leader');
    assert.equal(leaderMsgs.length, 1);
    assert.equal(leaderMsgs[0].from, 'alice-agent-id');
    assert.equal(leaderMsgs[0].to, 'leader');
    assert.equal((leaderMsgs[0].payload as { text: string }).text, 'PR reviewed, looks good');

    // 验证 alice 收到 leader 的消息
    const aliceMsgs = await mailboxService.readUnread('alice');
    assert.equal(aliceMsgs.length, 1);
    assert.equal(aliceMsgs[0].from, 'leader-agent-id');
    assert.equal(aliceMsgs[0].to, 'alice');
    assert.equal((aliceMsgs[0].payload as { text: string }).text, 'please review PR');
  });
});
