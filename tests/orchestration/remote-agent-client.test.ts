import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  RemoteAgentClient,
  MockSSHClient,
  classifyRemoteError,
  backoffDelay,
} from '../../src/orchestration/remote-agent-client.js';
import type { ToolResult } from '../../src/types/index.js';

// ============================================================
// helpers
// ============================================================

function tmpHome(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-remote-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function getText(result: ToolResult): string {
  const block = result.content[0];
  return block.type === 'text' ? block.text : '';
}

function makeClient(opts: { sshClient?: MockSSHClient } = {}) {
  const sshClient = opts.sshClient ?? new MockSSHClient();
  const client = new RemoteAgentClient({ sshClient });
  return { client, sshClient };
}

// ============================================================
// backoffDelay（指数退避）
// ============================================================

test('backoffDelay: 第 0 次重试 = base', () => {
  assert.equal(backoffDelay(0, 1000), 1000);
});

test('backoffDelay: 指数退避（2^n × base）', () => {
  assert.equal(backoffDelay(0, 1000), 1000);  // 2^0 = 1
  assert.equal(backoffDelay(1, 1000), 2000);  // 2^1 = 2
  assert.equal(backoffDelay(2, 1000), 4000);  // 2^2 = 4
  assert.equal(backoffDelay(3, 1000), 8000);  // 2^3 = 8
  assert.equal(backoffDelay(4, 1000), 16000); // 2^4 = 16
});

test('backoffDelay: 封顶 30s', () => {
  assert.equal(backoffDelay(10, 1000), 30000);  // 1024 → 封顶
  assert.equal(backoffDelay(20, 1000), 30000);  // 永远封顶 30s
});

test('backoffDelay: 不同 base', () => {
  assert.equal(backoffDelay(2, 500), 2000);  // 500 * 4
  assert.equal(backoffDelay(2, 2000), 8000); // 2000 * 4
});

// ============================================================
// classifyRemoteError（错误分类）
// ============================================================

test('classifyRemoteError: SSH/TCP 错误 → unreachable', () => {
  const r = classifyRemoteError(new Error('SSH connection refused: ECONNREFUSED'));
  assert.equal(r.kind, 'unreachable');
  assert.match(r.message, /remote unreachable/);
  assert.match(r.message, /ECONNREFUSED/);
});

test('classifyRemoteError: ENOTFOUND → unreachable', () => {
  const r = classifyRemoteError(new Error('DNS lookup failed: ENOTFOUND host'));
  assert.equal(r.kind, 'unreachable');
});

test('classifyRemoteError: EHOSTUNREACH → unreachable', () => {
  const r = classifyRemoteError(new Error('network unreachable: EHOSTUNREACH'));
  assert.equal(r.kind, 'unreachable');
});

test('classifyRemoteError: timeout → timeout', () => {
  const r = classifyRemoteError(new Error('exec timeout after 30000ms'));
  assert.equal(r.kind, 'timeout');
  assert.match(r.message, /exec timeout/);
});

test('classifyRemoteError: 未知错误 → unknown', () => {
  const r = classifyRemoteError(new Error('some other error'));
  assert.equal(r.kind, 'unknown');
  assert.equal(r.message, 'some other error');
});

test('classifyRemoteError: 字符串错误也能分类', () => {
  const r = classifyRemoteError('SSH connection refused');
  assert.equal(r.kind, 'unreachable');
});

test('classifyRemoteError: 保留原始 cause', () => {
  const err = new Error('SSH connection refused');
  const r = classifyRemoteError(err);
  assert.equal(r.cause, err);
});

// ============================================================
// delegate：基本路径
// ============================================================

test('RemoteAgentClient.delegate: 成功路径（exitCode=0）', async () => {
  await withTempHome(async () => {
    const { client, sshClient } = makeClient();
    sshClient.execResult = {
      stdout: 'remote agent executed successfully',
      stderr: '',
      exitCode: 0,
    };

    const result = await client.delegate({
      remote_target: 'user@host',
      prompt: 'list files',
      runtimeTaskId: 'task-001' as never,
    });

    assert.equal(result.is_error, false);
    assert.match(getText(result), /remote agent executed successfully/);
    // 应调用 connect 1 次
    assert.equal(sshClient.connectCalls.length, 1);
    assert.equal(sshClient.connectCalls[0].target, 'user@host');
  });
});

test('RemoteAgentClient.delegate: 远端 exec 构造正确命令', async () => {
  await withTempHome(async () => {
    let captured: { cmd?: string; args?: string[] } = {};
    const capturingSshClient = {
      connectCalls: [] as Array<{ target: string; opts: unknown }>,
      async connect(target: string, opts: unknown) {
        this.connectCalls.push({ target, opts });
        return {
          async exec(cmd: string, args: string[]) {
            captured = { cmd, args };
            return { stdout: 'ok', stderr: '', exitCode: 0 };
          },
          async close() {},
        };
      },
    };
    const client = new RemoteAgentClient({ sshClient: capturingSshClient as never });

    await client.delegate({
      remote_target: 'user@host',
      prompt: 'review PR',
      runtimeTaskId: 't1' as never,
    });

    assert.equal(captured.cmd, 'omniagent');
    assert.ok(captured.args?.includes('--headless'));
    assert.ok(captured.args?.includes('--prompt'));
    assert.ok(captured.args?.includes('review PR'));
  });
});

test('RemoteAgentClient.delegate: 自定义 command + args prefix', async () => {
  await withTempHome(async () => {
    let captured: { cmd?: string; args?: string[] } = {};
    class CapturingClient extends MockSSHClient {
      async connect(target: string, opts: never) {
        this.connectCalls.push({ target, opts });
        return {
          exec: async (cmd: string, args: string[]) => {
            captured = { cmd, args };
            return { stdout: 'ok', stderr: '', exitCode: 0 };
          },
          close: async () => {},
        } as never;
      }
    }
    const client = new RemoteAgentClient({
      sshClient: new CapturingClient(),
      remoteCommand: 'my-omniagent',
      remoteArgsPrefix: ['--headless', '--verbose'],
    });

    await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });

    assert.equal(captured.cmd, 'my-omniagent');
    assert.ok(captured.args?.includes('--verbose'));
    assert.ok(captured.args?.includes('--prompt'));
  });
});

// ============================================================
// delegate：参数校验
// ============================================================

test('RemoteAgentClient.delegate: 缺 remote_target 返回 error', async () => {
  await withTempHome(async () => {
    const { client } = makeClient();
    const result = await client.delegate({
      remote_target: '',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });
    assert.equal(result.is_error, true);
    assert.match(getText(result), /remote_target required/);
  });
});

// ============================================================
// delegate：远端失败路径（exitCode != 0）
// ============================================================

test('RemoteAgentClient.delegate: exitCode != 0 → is_error=true 含 stderr', async () => {
  await withTempHome(async () => {
    const { client, sshClient } = makeClient();
    sshClient.execResult = {
      stdout: 'partial output',
      stderr: 'error: file not found',
      exitCode: 1,
    };

    const result = await client.delegate({
      remote_target: 'user@host',
      prompt: 'read missing file',
      runtimeTaskId: 't1' as never,
    });

    assert.equal(result.is_error, true);
    assert.match(getText(result), /partial output/);
    assert.match(getText(result), /\[stderr\]/);
    assert.match(getText(result), /error: file not found/);
    assert.match(getText(result), /\[exit=1\]/);
  });
});

test('RemoteAgentClient.delegate: exitCode != 0 无 stderr → 仅 stdout', async () => {
  await withTempHome(async () => {
    const { client, sshClient } = makeClient();
    sshClient.execResult = {
      stdout: 'output with error',
      stderr: '',
      exitCode: 2,
    };

    const result = await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });

    assert.equal(result.is_error, true);
    assert.equal(getText(result), 'output with error');
  });
});

// ============================================================
// delegate：SSH 重连（3 次重试 + 指数退避）
// ============================================================

test('RemoteAgentClient.delegate: SSH 连接 1 次失败 → 第 2 次成功', async () => {
  await withTempHome(async () => {
    const { client, sshClient } = makeClient();
    sshClient.connectFailCount = 1;  // 第 1 次失败

    const result = await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });

    assert.equal(result.is_error, false);
    // 应有 2 次 connect 调用（1 失败 + 1 成功）
    assert.equal(sshClient.connectCalls.length, 2);
  });
});

test('RemoteAgentClient.delegate: SSH 连接 2 次失败 → 第 3 次成功', async () => {
  await withTempHome(async () => {
    const { client, sshClient } = makeClient();
    sshClient.connectFailCount = 2;

    const result = await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });

    assert.equal(result.is_error, false);
    assert.equal(sshClient.connectCalls.length, 3);
  });
});

test('RemoteAgentClient.delegate: SSH 连接 3 次失败 → unreachable 错误（场景 6）', async () => {
  await withTempHome(async () => {
    const { client, sshClient } = makeClient();
    sshClient.permanentConnectFail = true;  // 永远失败

    const result = await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });

    assert.equal(result.is_error, true);
    assert.match(getText(result), /remote unreachable/);
    assert.match(getText(result), /invariant #16 scenario 6/);
    assert.match(getText(result), /ECONNREFUSED/);
    // 应有 3 次 connect 调用（全部失败）
    assert.equal(sshClient.connectCalls.length, 3);
  });
});

// ============================================================
// delegate：exec 超时（场景 7）
// ============================================================

test('RemoteAgentClient.delegate: exec 超时 → timeout 错误（场景 7）', async () => {
  await withTempHome(async () => {
    const { client, sshClient } = makeClient();
    sshClient.execTimeout = true;  // exec 抛 timeout
    // 用极短 timeout 让测试快
    const result = await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
      timeout_ms: 10,  // 10ms 超时
    });

    assert.equal(result.is_error, true);
    assert.match(getText(result), /remote exec timeout/);
    assert.match(getText(result), /invariant #16 scenario 7/);
  });
});

// ============================================================
// delegate：tools_whitelist 透传
// ============================================================

test('RemoteAgentClient.delegate: tools_whitelist 透传到远端 --tools', async () => {
  await withTempHome(async () => {
    let captured: { args?: string[] } = {};
    class CapturingClient extends MockSSHClient {
      async connect(target: string, opts: never) {
        this.connectCalls.push({ target, opts });
        return {
          exec: async (_cmd: string, args: string[]) => {
            captured = { args };
            return { stdout: 'ok', stderr: '', exitCode: 0 };
          },
          close: async () => {},
        } as never;
      }
    }
    const client = new RemoteAgentClient({ sshClient: new CapturingClient() });

    await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
      tools_whitelist: ['read_file', 'grep'],
    });

    // args 应包含 --tools read_file,grep
    const toolsIdx = captured.args?.indexOf('--tools');
    assert.ok(toolsIdx !== undefined && toolsIdx >= 0, '应包含 --tools 参数');
    assert.equal(captured.args![toolsIdx! + 1], 'read_file,grep');
  });
});

test('RemoteAgentClient.delegate: 无 tools_whitelist 不传 --tools', async () => {
  await withTempHome(async () => {
    let captured: { args?: string[] } = {};
    class CapturingClient extends MockSSHClient {
      async connect(target: string, opts: never) {
        this.connectCalls.push({ target, opts });
        return {
          exec: async (_cmd: string, args: string[]) => {
            captured = { args };
            return { stdout: 'ok', stderr: '', exitCode: 0 };
          },
          close: async () => {},
        } as never;
      }
    }
    const client = new RemoteAgentClient({ sshClient: new CapturingClient() });

    await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });

    assert.equal(captured.args?.includes('--tools'), false);
  });
});

// ============================================================
// delegate：连接关闭（cleanup）
// ============================================================

test('RemoteAgentClient.delegate: 完成后关闭连接', async () => {
  await withTempHome(async () => {
    let closed = false;
    class TrackingClient extends MockSSHClient {
      async connect(target: string, opts: never) {
        this.connectCalls.push({ target, opts });
        return {
          exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
          close: async () => { closed = true; },
        } as never;
      }
    }
    const client = new RemoteAgentClient({ sshClient: new TrackingClient() });

    await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });

    assert.equal(closed, true, '应调用 conn.close()');
  });
});

test('RemoteAgentClient.delegate: 失败也关闭连接（best-effort）', async () => {
  await withTempHome(async () => {
    let closed = false;
    class TrackingClient extends MockSSHClient {
      async connect(target: string, opts: never) {
        this.connectCalls.push({ target, opts });
        return {
          exec: async () => {
            throw new Error('exec failed');
          },
          close: async () => { closed = true; },
        } as never;
      }
    }
    const client = new RemoteAgentClient({ sshClient: new TrackingClient() });

    const result = await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });

    assert.equal(result.is_error, true);
    assert.equal(closed, true, '失败路径也应关闭连接');
  });
});

// ============================================================
// 集成：metadata.compactable=false
// ============================================================

test('RemoteAgentClient.delegate: metadata.compactable=false（不可压缩）', async () => {
  await withTempHome(async () => {
    const { client } = makeClient();
    const result = await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });
    assert.equal(result.metadata?.compactable, false);
  });
});

// ============================================================
// 默认连接参数
// ============================================================

test('RemoteAgentClient: 默认连接参数 retries=3, backoffMs=1000, timeoutMs=10000', async () => {
  await withTempHome(async () => {
    const { client, sshClient } = makeClient();
    await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });

    const opts = sshClient.connectCalls[0].opts;
    assert.equal(opts.retries, 3);
    assert.equal(opts.backoffMs, 1000);
    assert.equal(opts.timeoutMs, 10000);
  });
});

test('RemoteAgentClient: 自定义默认连接参数', async () => {
  await withTempHome(async () => {
    const sshClient = new MockSSHClient();
    const client = new RemoteAgentClient({
      sshClient,
      defaultConnectOpts: { retries: 5, backoffMs: 500, timeoutMs: 5000 },
    });
    await client.delegate({
      remote_target: 'user@host',
      prompt: 'x',
      runtimeTaskId: 't1' as never,
    });

    const opts = sshClient.connectCalls[0].opts;
    assert.equal(opts.retries, 5);
    assert.equal(opts.backoffMs, 500);
    assert.equal(opts.timeoutMs, 5000);
  });
});
