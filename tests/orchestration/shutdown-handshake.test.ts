import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ShutdownHandshake } from '../../src/orchestration/shutdown-handshake.js';
import { MailboxService } from '../../src/orchestration/mailbox-service.js';
import type {
  AgentId,
  MailboxName,
} from '../../src/types/index.js';

// ============================================================
// 测试 helpers
// ============================================================

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-shutdown-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

// ============================================================
// sendRequest
// ============================================================

test('ShutdownHandshake.sendRequest: leader 发 shutdown_request', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox);
    const requestId = await handshake.sendRequest(
      makeMailboxName('alice'),
      {
        agentId: makeAgentId('leader'),
        leaderName: makeMailboxName('leader'),
        reason: 'user_exit',
      },
    );
    assert.ok(requestId);
    assert.match(requestId, /^[0-9a-f-]{36}$/);

    // 验证 alice 的 mailbox 有 shutdown_request
    const unread = await mailbox.readUnread(makeMailboxName('alice'));
    assert.equal(unread.length, 1);
    assert.equal(unread[0].type, 'shutdown_request');
    assert.equal(unread[0].from, makeAgentId('leader'));
    assert.equal(unread[0].to, makeMailboxName('alice'));
    assert.equal((unread[0].payload as { reason: string }).reason, 'user_exit');
    assert.equal((unread[0].payload as { request_id: string }).request_id, requestId);
  });
});

test('ShutdownHandshake.sendRequest: 默认 reason 是 user_shutdown', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox);
    await handshake.sendRequest(
      makeMailboxName('alice'),
      {
        agentId: makeAgentId('leader'),
        leaderName: makeMailboxName('leader'),
      },
    );
    const unread = await mailbox.readUnread(makeMailboxName('alice'));
    assert.equal((unread[0].payload as { reason: string }).reason, 'user_shutdown');
  });
});

test('ShutdownHandshake.sendRequest: 记录握手状态为 request_sent', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox);
    const requestId = await handshake.sendRequest(
      makeMailboxName('alice'),
      {
        agentId: makeAgentId('leader'),
        leaderName: makeMailboxName('leader'),
      },
    );
    const record = handshake.getRecord(makeMailboxName('alice'));
    assert.ok(record);
    assert.equal(record!.state, 'request_sent');
    assert.equal(record!.requestId, requestId);
    assert.equal(record!.leaderName, makeMailboxName('leader'));
    assert.ok(record!.startedAt > 0);
  });
});

test('ShutdownHandshake.sendRequest: 写失败抛错', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService({
      limits: {
        maxSingleMessageBytes: 100,
        maxMailboxFileBytes: 1024,
        maxMessagesPerMailbox: 1000,
        archiveThreshold: 200,
      },
    });
    const handshake = new ShutdownHandshake(mailbox);
    await assert.rejects(
      () => handshake.sendRequest(
        makeMailboxName('alice'),
        {
          agentId: makeAgentId('leader'),
          leaderName: makeMailboxName('leader'),
        },
      ),
      /failed to send shutdown_request/,
    );
  });
});

// ============================================================
// handleRequest
// ============================================================

test('ShutdownHandshake.handleRequest: approve=true 时清理资源', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    let cleanupCalled = false;
    const cleanup = async () => {
      cleanupCalled = true;
    };
    const handshake = new ShutdownHandshake(mailbox, { cleanup });

    // leader 发 request
    const leaderName = makeMailboxName('leader');
    const teammateName = makeMailboxName('alice');
    const requestId = await handshake.sendRequest(teammateName, {
      agentId: makeAgentId('leader'),
      leaderName,
      reason: 'user_exit',
    });

    // teammate 处理 request（无 pending work → approve）
    const response = await handshake.handleRequest(teammateName, requestId, {
      leaderName,
      agentId: makeAgentId('agent-alice-001'),
      hasPendingWork: false,
    });

    assert.equal(response.approve, true);
    assert.equal(response.reason, 'all_done');
    assert.equal(cleanupCalled, true, 'approve=true 应触发清理');

    // leader 的 mailbox 应有 shutdown_response
    const leaderUnread = await mailbox.readUnread(leaderName);
    assert.equal(leaderUnread.length, 1);
    assert.equal(leaderUnread[0].type, 'shutdown_response');
    assert.equal((leaderUnread[0].payload as { approve: boolean }).approve, true);
  });
});

test('ShutdownHandshake.handleRequest: approve=false 时不清理', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    let cleanupCalled = false;
    const cleanup = async () => { cleanupCalled = true; };
    const handshake = new ShutdownHandshake(mailbox, { cleanup });

    const leaderName = makeMailboxName('leader');
    const teammateName = makeMailboxName('alice');
    const requestId = await handshake.sendRequest(teammateName, {
      agentId: makeAgentId('leader'),
      leaderName,
    });

    // teammate 有 pending work → reject
    const response = await handshake.handleRequest(teammateName, requestId, {
      leaderName,
      agentId: makeAgentId('agent-alice-001'),
      hasPendingWork: true,
    });

    assert.equal(response.approve, false);
    assert.equal(response.reason, 'pending_work');
    assert.equal(cleanupCalled, false, 'reject 不应触发清理');
  });
});

test('ShutdownHandshake.handleRequest: 自定义 canShutdown 评估器', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    let canShutdownCalled = false;
    const canShutdown = async () => {
      canShutdownCalled = true;
      return true;
    };
    const handshake = new ShutdownHandshake(mailbox, { canShutdown });

    const leaderName = makeMailboxName('leader');
    const teammateName = makeMailboxName('alice');
    const requestId = await handshake.sendRequest(teammateName, {
      agentId: makeAgentId('leader'),
      leaderName,
    });
    await handshake.handleRequest(teammateName, requestId, {
      leaderName,
      agentId: makeAgentId('agent-alice-001'),
    });
    assert.equal(canShutdownCalled, true, '自定义评估器应被调用');
  });
});

test('ShutdownHandshake.handleRequest: 回复写入 leader mailbox', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox);

    const leaderName = makeMailboxName('leader');
    const teammateName = makeMailboxName('alice');

    // 先在 leader mailbox 创建文件（写一条无关消息）
    await mailbox.sendText(leaderName, teammateName, 'setup');

    // teammate handleRequest 应写入 leader mailbox
    await handshake.handleRequest(teammateName, 'req-1', {
      leaderName,
      agentId: makeAgentId('agent-alice-001'),
      hasPendingWork: false,
    });

    const leaderMsgs = await mailbox.read(leaderName);
    const responses = leaderMsgs.filter(m => m.type === 'shutdown_response');
    assert.equal(responses.length, 1);
    assert.equal(responses[0].from, teammateName);
    assert.equal(responses[0].to, leaderName);
  });
});

// ============================================================
// waitForResponse
// ============================================================

test('ShutdownHandshake.waitForResponse: 收到 approve 后返回', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox, { pollIntervalMs: 10 });

    const leaderName = makeMailboxName('leader');
    const teammateName = makeMailboxName('alice');

    // 1. leader 发 request
    const requestId = await handshake.sendRequest(teammateName, {
      agentId: makeAgentId('leader'),
      leaderName,
    });

    // 2. teammate 处理 + 回复（异步）
    setImmediate(() => {
      void handshake.handleRequest(teammateName, requestId, {
        leaderName,
        agentId: makeAgentId('agent-alice-001'),
        hasPendingWork: false,
      });
    });

    // 3. leader 等待 response
    const response = await handshake.waitForResponse(teammateName, 5000);
    assert.equal(response.approve, true);

    // 握手状态更新
    const record = handshake.getRecord(teammateName);
    assert.equal(record?.state, 'cleaned_up');
    assert.equal(record?.response?.approve, true);
  });
});

test('ShutdownHandshake.waitForResponse: 收到 reject 后返回', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox, { pollIntervalMs: 10 });

    const leaderName = makeMailboxName('leader');
    const teammateName = makeMailboxName('alice');
    const requestId = await handshake.sendRequest(teammateName, {
      agentId: makeAgentId('leader'),
      leaderName,
    });

    setImmediate(() => {
      void handshake.handleRequest(teammateName, requestId, {
        leaderName,
        agentId: makeAgentId('agent-alice-001'),
        hasPendingWork: true,  // reject
      });
    });

    const response = await handshake.waitForResponse(teammateName, 5000);
    assert.equal(response.approve, false);
    assert.equal(response.reason, 'pending_work');

    const record = handshake.getRecord(teammateName);
    assert.equal(record?.state, 'rejected');
  });
});

test('ShutdownHandshake.waitForResponse: 超时抛错（不变量 #6）', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox, { pollIntervalMs: 5 });

    const teammateName = makeMailboxName('alice');
    await handshake.sendRequest(teammateName, {
      agentId: makeAgentId('leader'),
      leaderName: makeMailboxName('leader'),
    });

    // 不回复 → 超时
    await assert.rejects(
      () => handshake.waitForResponse(teammateName, 50),  // 50ms 超时
      /shutdown_response timeout/,
    );

    const record = handshake.getRecord(teammateName);
    assert.equal(record?.state, 'timeout');
  });
});

test('ShutdownHandshake.waitForResponse: 收到 response 后标记已读', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox, { pollIntervalMs: 10 });

    const leaderName = makeMailboxName('leader');
    const teammateName = makeMailboxName('alice');
    const requestId = await handshake.sendRequest(teammateName, {
      agentId: makeAgentId('leader'),
      leaderName,
    });

    setImmediate(() => {
      void handshake.handleRequest(teammateName, requestId, {
        leaderName,
        agentId: makeAgentId('agent-alice-001'),
        hasPendingWork: false,
      });
    });

    await handshake.waitForResponse(teammateName, 5000);

    // leader 的 mailbox 里 shutdown_response 应已标记已读
    const leaderMsgs = await mailbox.read(leaderName);
    assert.equal(leaderMsgs.length, 1);  // shutdown_response
    assert.equal(leaderMsgs[0].read, true, 'shutdown_response 应被标记已读');
  });
});

// ============================================================
// getRecord / clearRecords
// ============================================================

test('ShutdownHandshake.getRecord: 未发起握手返回 undefined', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox);
    assert.equal(handshake.getRecord(makeMailboxName('nonexistent')), undefined);
  });
});

test('ShutdownHandshake.clearRecords: 清除全部握手记录', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox);
    await handshake.sendRequest(makeMailboxName('alice'), {
      agentId: makeAgentId('leader'),
      leaderName: makeMailboxName('leader'),
    });
    await handshake.sendRequest(makeMailboxName('bob'), {
      agentId: makeAgentId('leader'),
      leaderName: makeMailboxName('leader'),
    });
    assert.ok(handshake.getRecord(makeMailboxName('alice')));
    assert.ok(handshake.getRecord(makeMailboxName('bob')));
    handshake.clearRecords();
    assert.equal(handshake.getRecord(makeMailboxName('alice')), undefined);
    assert.equal(handshake.getRecord(makeMailboxName('bob')), undefined);
  });
});

// ============================================================
// 集成：完整四步握手
// ============================================================

test('ShutdownHandshake: 完整四步握手（leader request → teammate approve → leader receive）', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const cleanupCalls: string[] = [];
    const cleanup = async (ctx: { agentId: AgentId }) => {
      cleanupCalls.push(ctx.agentId as string);
    };
    const handshake = new ShutdownHandshake(mailbox, {
      pollIntervalMs: 10,
      cleanup,
    });

    const leaderName = makeMailboxName('leader');
    const teammateName = makeMailboxName('alice');
    const teammateAgentId = makeAgentId('agent-alice-001');

    // 步骤 1: leader 发 request
    const requestId = await handshake.sendRequest(teammateName, {
      agentId: makeAgentId('leader'),
      leaderName,
      reason: 'user_exit',
    });
    assert.equal(handshake.getRecord(teammateName)?.state, 'request_sent');

    // 步骤 2: teammate 异步处理 + 回复
    setImmediate(() => {
      void handshake.handleRequest(teammateName, requestId, {
        leaderName,
        agentId: teammateAgentId,
        hasPendingWork: false,
      });
    });

    // 步骤 3: leader 等待 response
    const response = await handshake.waitForResponse(teammateName, 5000);

    // 步骤 4: 验证 approve + 清理调用
    assert.equal(response.approve, true);
    assert.equal(cleanupCalls.length, 1, 'approve 应触发清理');
    assert.equal(cleanupCalls[0], teammateAgentId as string);

    // 最终握手状态
    assert.equal(handshake.getRecord(teammateName)?.state, 'cleaned_up');
  });
});

test('ShutdownHandshake: reject 时 teammate 继续运行（不强杀，不变量 #6）', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    let cleanupCalled = false;
    const handshake = new ShutdownHandshake(mailbox, {
      pollIntervalMs: 10,
      cleanup: async () => { cleanupCalled = true; },
    });

    const leaderName = makeMailboxName('leader');
    const teammateName = makeMailboxName('alice');
    const requestId = await handshake.sendRequest(teammateName, {
      agentId: makeAgentId('leader'),
      leaderName,
    });

    setImmediate(() => {
      void handshake.handleRequest(teammateName, requestId, {
        leaderName,
        agentId: makeAgentId('agent-alice-001'),
        hasPendingWork: true,  // reject
      });
    });

    const response = await handshake.waitForResponse(teammateName, 5000);
    assert.equal(response.approve, false);
    assert.equal(cleanupCalled, false, 'reject 不应清理');
    assert.equal(handshake.getRecord(teammateName)?.state, 'rejected');
  });
});

test('ShutdownHandshake: 多 teammate 并行握手', async () => {
  await withTempHome(async () => {
    const mailbox = new MailboxService();
    const handshake = new ShutdownHandshake(mailbox, { pollIntervalMs: 10 });
    const leaderName = makeMailboxName('leader');

    const aliceName = makeMailboxName('alice');
    const bobName = makeMailboxName('bob');

    const aliceReqId = await handshake.sendRequest(aliceName, {
      agentId: makeAgentId('leader'),
      leaderName,
    });
    const bobReqId = await handshake.sendRequest(bobName, {
      agentId: makeAgentId('leader'),
      leaderName,
    });

    setImmediate(() => {
      void handshake.handleRequest(aliceName, aliceReqId, {
        leaderName,
        agentId: makeAgentId('agent-alice'),
        hasPendingWork: false,
      });
    });
    setImmediate(() => {
      void handshake.handleRequest(bobName, bobReqId, {
        leaderName,
        agentId: makeAgentId('agent-bob'),
        hasPendingWork: false,
      });
    });

    // 并行等待
    const [aliceResp, bobResp] = await Promise.all([
      handshake.waitForResponse(aliceName, 5000),
      handshake.waitForResponse(bobName, 5000),
    ]);
    assert.equal(aliceResp.approve, true);
    assert.equal(bobResp.approve, true);

    assert.equal(handshake.getRecord(aliceName)?.state, 'cleaned_up');
    assert.equal(handshake.getRecord(bobName)?.state, 'cleaned_up');
  });
});
