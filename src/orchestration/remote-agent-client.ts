/**
 * RemoteAgentClient（L3-M5 §2.2.7 + §3.7 — M2 iter 3）
 *
 * Remote 路径：委托到 SSH 远程 OmniAgent 实例
 *
 * 流程：
 * 1. SSH 连接（指数退避 3 次重试，base 1000ms）
 * 2. 远程执行 omniagent --headless --prompt <prompt>
 * 3. 返回 stdout/exitCode 作为 ToolResult
 *
 * 错误分类（不变量 #16 — 9 场景恢复矩阵）：
 * - SSH/TCP 错误（远端不可达） → 三态 evicted（场景 6: sidecar 404）
 * - exec 超时 → task timeout（场景 7）
 * - 远端进程退出非 0 → tool_result is_error=true（场景 8）
 *
 * 不变量 #16（9 场景矩阵）— 场景 6：sidecar 404
 * - 检测：ping 超时 / SSH 连接拒绝 → 远端 sidecar 不可达
 * - 恢复：将 task 标记 evicted（leader 下次轮询可重启或 abandon）
 *
 * 设计选择：
 * - SSHClient/SSHConnection 为可注入接口（生产用 ssh2，测试用 mock）
 * - 不直接依赖具体 SSH 库（避免把 ssh2 绑到工具层）
 * - 指数退避实现独立（可用于其他重试场景）
 *
 * M2 iter 3 范围：
 * - delegate() 完整实现（含 3 次重试 + 退避）
 * - 错误分类（SSH/TCP / timeout / exit != 0）
 * - 不实现 actual sidecar ping（iter 4+ 接入 pingSidecar）
 */

import type {
  TaskId,
  ToolResult,
  ToolUseId,
} from '../types/index.js';

// ============================================================
// 类型：SSH 接口（可注入）
// ============================================================

export interface SSHConnectOptions {
  /** 最大重试次数（默认 3） */
  retries: number;
  /** 退避初始毫秒（默认 1000，指数退避 base） */
  backoffMs: number;
  /** 单次连接超时（默认 10000） */
  timeoutMs: number;
}

export interface SSHExecOptions {
  /** exec 超时（ms） */
  timeoutMs: number;
}

export interface SSHExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** SSH 连接（生产用 ssh2；测试用 mock） */
export interface SSHConnection {
  exec(
    cmd: string,
    args: string[],
    opts: SSHExecOptions,
  ): Promise<SSHExecResult>;
  /** 关闭连接（用于 cleanup） */
  close(): Promise<void>;
}

/** SSH 客户端工厂（注入用） */
export interface SSHClient {
  connect(
    target: string,
    opts: SSHConnectOptions,
  ): Promise<SSHConnection>;
}

// ============================================================
// 错误分类（不变量 #16 — 场景 6 / 7 / 8）
// ============================================================

export type RemoteErrorKind =
  | 'unreachable'  // SSH/TCP 错误 → 三态 evicted（场景 6）
  | 'timeout'      // exec 超时（场景 7）
  | 'remote_failure'  // 远端进程退出非 0（场景 8）
  | 'unknown';

export interface RemoteError {
  kind: RemoteErrorKind;
  message: string;
  /** 原始错误（用于日志） */
  cause?: unknown;
}

/** 从异常中分类错误（不变量 #16 场景矩阵） */
export function classifyRemoteError(err: unknown): RemoteError {
  const msg = (err as Error)?.message ?? String(err);
  // SSH/TCP 错误：连接拒绝 / 网络不可达 / DNS 失败
  if (/SSH|TCP|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(msg)) {
    return { kind: 'unreachable', message: `remote unreachable: ${msg}`, cause: err };
  }
  // exec 超时
  if (/timeout|timed out/i.test(msg)) {
    return { kind: 'timeout', message: `remote exec timeout: ${msg}`, cause: err };
  }
  // 退出非 0 由调用方处理（不抛错），此处覆盖其他未知错误
  return { kind: 'unknown', message: msg, cause: err };
}

// ============================================================
// 指数退避（独立工具，可用于其他重试场景）
// ============================================================

/** 计算第 n 次重试的退避毫秒（指数 2^n × base，封顶 30s） */
export function backoffDelay(attempt: number, baseMs: number): number {
  // 0 → base, 1 → 2*base, 2 → 4*base, ...
  // 封顶 30000ms（30s）
  const factor = Math.pow(2, attempt);
  return Math.min(baseMs * factor, 30_000);
}

// ============================================================
// RemoteAgentClient
// ============================================================

/** delegate 参数（AgentRouterParams + 运行时 task id） */
export interface RemoteDelegateParams {
  /** 远程目标（user@host[:port] 或 ssh alias） */
  remote_target: string;
  /** 子 agent prompt */
  prompt: string;
  /** 运行时 task id（Orchestrator 创建） */
  runtimeTaskId: TaskId;
  /** 超时 ms（默认 30000） */
  timeout_ms?: number;
  /** 工具白名单（透传到远端） */
  tools_whitelist?: string[];
}

/** RemoteAgentClient 构造参数 */
export interface RemoteAgentClientOptions {
  sshClient: SSHClient;
  /** 默认连接参数（可被 delegate 参数覆盖） */
  defaultConnectOpts?: Partial<SSHConnectOptions>;
  /** 默认 exec 命令（默认 'omniagent'） */
  remoteCommand?: string;
  /** 默认 exec 参数前缀（默认 ['--headless']） */
  remoteArgsPrefix?: string[];
}

export class RemoteAgentClient {
  private readonly sshClient: SSHClient;
  private readonly defaultConnectOpts: Partial<SSHConnectOptions>;
  private readonly remoteCommand: string;
  private readonly remoteArgsPrefix: string[];

  constructor(opts: RemoteAgentClientOptions) {
    this.sshClient = opts.sshClient;
    this.defaultConnectOpts = opts.defaultConnectOpts ?? {};
    this.remoteCommand = opts.remoteCommand ?? 'omniagent';
    this.remoteArgsPrefix = opts.remoteArgsPrefix ?? ['--headless'];
  }

  /**
   * remote 路径：委托到远程 OmniAgent 实例
   *
   * 流程：
   * 1. SSH 连接（3 次重试 + 指数退避）
   * 2. 远程执行 omniagent --headless --prompt <prompt>
   * 3. 远端 stdout 作为 ToolResult.content
   * 4. exitCode != 0 → is_error=true
   * 5. SSH/TCP 错误 → unreachable（不变量 #16 场景 6: sidecar 404）
   *
   * 不变量 #16 — 场景 6 (sidecar 404)：
   * - 远端 sidecar 不可达 → classifyRemoteError 返回 'unreachable'
   * - Orchestrator 据此标记 task 为 evicted（leader 下次轮询可重启或 abandon）
   */
  async delegate(params: RemoteDelegateParams): Promise<ToolResult> {
    if (!params.remote_target) {
      return toErrorResult('remote_target required for route=remote');
    }

    const connectOpts: SSHConnectOptions = {
      retries: this.defaultConnectOpts.retries ?? 3,
      backoffMs: this.defaultConnectOpts.backoffMs ?? 1000,
      timeoutMs: this.defaultConnectOpts.timeoutMs ?? 10_000,
    };
    const execTimeoutMs = params.timeout_ms ?? 30_000;

    // 1. SSH 连接（带重试）
    let conn: SSHConnection;
    try {
      conn = await this.connectWithRetry(params.remote_target, connectOpts);
    } catch (err) {
      // 不变量 #16 场景 6: SSH/TCP 错误 → unreachable
      const classified = classifyRemoteError(err);
      return toErrorResult(
        `remote unreachable: ${classified.message}` +
          ` (invariant #16 scenario 6: sidecar 404 → task should be evicted)`,
      );
    }

    // 2. 远程 exec
    try {
      const args = [
        ...this.remoteArgsPrefix,
        '--prompt', params.prompt,
      ];
      if (params.tools_whitelist && params.tools_whitelist.length > 0) {
        args.push('--tools', params.tools_whitelist.join(','));
      }

      const result = await conn.exec(this.remoteCommand, args, {
        timeoutMs: execTimeoutMs,
      });

      const isError = result.exitCode !== 0;
      const text = isError && result.stderr
        ? `${result.stdout}\n[stderr]\n${result.stderr}\n[exit=${result.exitCode}]`
        : result.stdout;

      return {
        tool_use_id: '' as ToolUseId,
        content: [{ type: 'text', text }],
        is_error: isError,
        metadata: { duration_ms: 0, compactable: false },
      };
    } catch (err) {
      const classified = classifyRemoteError(err);
      if (classified.kind === 'timeout') {
        // 不变量 #16 场景 7: exec 超时
        return toErrorResult(
          `remote exec timeout (${execTimeoutMs}ms): ${classified.message}` +
            ` (invariant #16 scenario 7)`,
        );
      }
      return toErrorResult(`remote exec error: ${classified.message}`);
    } finally {
      // 关闭连接（best-effort）
      await conn.close().catch(() => {});
    }
  }

  /**
   * SSH 连接（带指数退避重试）
   *
   * 重试策略：
   * - attempt 0 失败 → wait backoffMs × 2^0 = base
   * - attempt 1 失败 → wait backoffMs × 2^1 = 2×base
   * - attempt 2 失败 → wait backoffMs × 2^2 = 4×base
   * - 达到 retries 次后抛错
   */
  private async connectWithRetry(
    target: string,
    opts: SSHConnectOptions,
  ): Promise<SSHConnection> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < opts.retries; attempt++) {
      try {
        return await this.sshClient.connect(target, opts);
      } catch (err) {
        lastErr = err;
        // 分类错误：仅对 SSH/TCP 错误重试（其他错误立即抛出）
        const classified = classifyRemoteError(err);
        if (classified.kind !== 'unreachable') {
          throw err;
        }
        // 最后一次不 sleep
        if (attempt < opts.retries - 1) {
          const delay = backoffDelay(attempt, opts.backoffMs);
          await sleep(delay);
        }
      }
    }
    throw lastErr;
  }
}

// ============================================================
// 工具
// ============================================================

function toErrorResult(message: string): ToolResult {
  return {
    tool_use_id: '' as ToolUseId,
    content: [{ type: 'text', text: message }],
    is_error: true,
    metadata: { duration_ms: 0, compactable: false },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// Mock SSHClient（测试用 + 生产 mock）
// ============================================================

/** Mock SSH 连接（测试用） */
export class MockSSHConnection implements SSHConnection {
  constructor(
    private readonly execResult: SSHExecResult,
    private readonly shouldFail?: { kind: RemoteErrorKind; message: string },
  ) {}

  async exec(
    _cmd: string,
    _args: string[],
    opts: SSHExecOptions,
  ): Promise<SSHExecResult> {
    if (this.shouldFail) {
      // 模拟各类错误
      if (this.shouldFail.kind === 'timeout') {
        // 等到超时再抛
        await new Promise(resolve => setTimeout(resolve, opts.timeoutMs + 10));
        throw new Error(`exec timeout after ${opts.timeoutMs}ms`);
      }
      throw new Error(this.shouldFail.message);
    }
    return this.execResult;
  }

  async close(): Promise<void> {
    // no-op
  }
}

/** Mock SSH 客户端（测试用） */
export class MockSSHClient implements SSHClient {
  /** exec 结果（成功路径） */
  readonly execResult: SSHExecResult = {
    stdout: 'remote agent output',
    stderr: '',
    exitCode: 0,
  };
  /** connect 失败次数（模拟 unreachable） */
  connectFailCount = 0;
  /** connect 是否永久失败（unreachable 路径） */
  permanentConnectFail = false;
  /** exec 是否抛 timeout */
  execTimeout = false;

  /** 记录 connect 调用 */
  readonly connectCalls: Array<{ target: string; opts: SSHConnectOptions }> = [];

  async connect(
    target: string,
    opts: SSHConnectOptions,
  ): Promise<SSHConnection> {
    this.connectCalls.push({ target, opts });
    if (this.permanentConnectFail) {
      throw new Error('SSH connection refused: ECONNREFUSED');
    }
    if (this.connectFailCount > 0) {
      this.connectFailCount--;
      throw new Error('SSH connection refused: ECONNREFUSED');
    }
    return new MockSSHConnection(this.execResult, this.execTimeout
      ? { kind: 'timeout', message: 'exec timed out' }
      : undefined);
  }
}
