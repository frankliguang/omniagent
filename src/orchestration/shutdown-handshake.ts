/**
 * ShutdownHandshake（L3-M5 §2.2.9 + L2 §4.2.6 — M2 iter 2）
 *
 * 四步握手协议：
 * 1. leader → teammate: shutdown_request（via mailbox）
 * 2. teammate → leader: shutdown_response（approve/reject）
 * 3. approve → teammate 清理资源
 * 4. reject → teammate 继续运行（不强杀，不变量 #6）
 *
 * 不变量 #6（优雅退出，不强杀）：
 * - leader 只发 shutdown_request，不 kill 进程
 * - teammate 自行评估能否 shutdown
 * - 超时（30s）抛错，不强杀
 *
 * 状态机：
 * - IDLE → REQUEST_SENT → RESPONSE_RECEIVED
 *   - approve: CLEANED_UP
 *   - reject: REJECTED（teammate 继续运行）
 *
 * M2 iter 2 范围：
 * - sendRequest / handleRequest / waitForResponse
 * - 超时 30s（默认）+ 轮询 100ms
 * - 清理回调可注入（测试可 mock）
 */

import type {
  AgentId,
  MailboxName,
} from '../types/index.js';
import { randomUUID } from 'node:crypto';
import type { MailboxService } from './mailbox-service.js';

// ============================================================
// 类型
// ============================================================

export type HandshakeState =
  | 'idle'
  | 'request_sent'
  | 'response_received'
  | 'cleaned_up'
  | 'rejected'
  | 'timeout';

export interface ShutdownContext {
  /** leader 的 agentId */
  agentId: AgentId;
  /** leader 的 mailbox name（用于接收 shutdown_response） */
  leaderName: MailboxName;
  /** 触发原因（user_exit / budget_exceeded / abort_signal 等） */
  reason?: string;
}

export interface TeammateContext {
  /** leader 的 mailbox name（teammate 用以回 shutdown_response） */
  leaderName: MailboxName;
  /** teammate 的 agentId */
  agentId: AgentId;
  /** teammate 当前状态（用于评估能否 shutdown） */
  hasPendingWork?: boolean;
}

export interface ShutdownResponse {
  request_id: string;
  approve: boolean;
  reason?: string;
}

export interface ShutdownRequestPayload {
  request_id: string;
  reason: string;
}

export interface HandshakeRecord {
  state: HandshakeState;
  requestId: string;
  /** leader 的 mailbox name（waitForResponse 轮询用） */
  leaderName: MailboxName;
  startedAt: number;
  response?: ShutdownResponse;
}

export interface CleanupResources {
  /** teammate approve 后调用（清理 drainWriteQueue / MCP / worktree 等） */
  (ctx: TeammateContext): Promise<void>;
}

export interface CanShutdownEvaluator {
  /** teammate 评估能否 shutdown（默认：基于 hasPendingWork） */
  (ctx: TeammateContext): Promise<boolean>;
}

// ============================================================
// 默认实现
// ============================================================

/** 默认能否 shutdown 评估：基于 hasPendingWork */
const defaultCanShutdown: CanShutdownEvaluator = async (ctx) => {
  return !ctx.hasPendingWork;
};

/** 默认清理回调（空实现；实际清理由调用方注入） */
const defaultCleanup: CleanupResources = async () => {
  // 默认无操作；生产环境由 Orchestrator 注入完整清理逻辑
};

// ============================================================
// 工具函数
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// ShutdownHandshake
// ============================================================

export class ShutdownHandshake {
  /** per-teammate 握手状态（MailboxName → record） */
  private readonly records = new Map<MailboxName, HandshakeRecord>();

  constructor(
    private readonly mailbox: MailboxService,
    private readonly options: {
      /** 默认超时 ms（默认 30000） */
      defaultTimeoutMs?: number;
      /** 轮询间隔 ms（默认 100） */
      pollIntervalMs?: number;
      /** 清理回调（teammate approve 后调用） */
      cleanup?: CleanupResources;
      /** 能否 shutdown 评估器 */
      canShutdown?: CanShutdownEvaluator;
    } = {},
  ) {}

  /**
   * 步骤 1：leader 发 shutdown_request 给 teammate
   *
   * 不变量 #6：只发请求，不杀进程
   */
  async sendRequest(
    teammateName: MailboxName,
    ctx: ShutdownContext,
  ): Promise<string> {
    const requestId = randomUUID();
    const payload: ShutdownRequestPayload = {
      request_id: requestId,
      reason: ctx.reason ?? 'user_shutdown',
    };

    const result = await this.mailbox.send({
      from: ctx.agentId,
      to: teammateName,
      type: 'shutdown_request',
      payload,
    });

    if (!result.written) {
      throw new Error(`failed to send shutdown_request to "${teammateName}": ${result.error}`);
    }

    // 记录握手状态
    this.records.set(teammateName, {
      state: 'request_sent',
      requestId,
      leaderName: ctx.leaderName,
      startedAt: Date.now(),
    });

    return requestId;
  }

  /**
   * 步骤 2 + 3：teammate 处理 shutdown_request
   *
   * 评估能否 shutdown：
   * - approve → 清理资源 + 回复 shutdown_response(approve=true)
   * - reject → 回复 shutdown_response(approve=false)，继续运行
   */
  async handleRequest(
    teammateName: MailboxName,
    requestId: string,
    ctx: TeammateContext,
  ): Promise<ShutdownResponse> {
    const canShutdown = await (this.options.canShutdown ?? defaultCanShutdown)(ctx);

    const response: ShutdownResponse = {
      request_id: requestId,
      approve: canShutdown,
      reason: canShutdown ? 'all_done' : 'pending_work',
    };

    // 回复 shutdown_response
    const result = await this.mailbox.send({
      from: teammateName,
      to: ctx.leaderName,
      type: 'shutdown_response',
      payload: response,
    });

    if (!result.written) {
      throw new Error(`failed to send shutdown_response to "${ctx.leaderName}": ${result.error}`);
    }

    // approve → 清理资源
    if (canShutdown) {
      await (this.options.cleanup ?? defaultCleanup)(ctx);
    }

    return response;
  }

  /**
   * 步骤 4：leader 等待 shutdown_response
   *
   * 轮询 leader 自己的 mailbox（teammate 把 response 发给 leader），
   * 按 from === teammateName 匹配。
   *
   * 超时抛错（不强杀，不变量 #6）
   */
  async waitForResponse(
    teammateName: MailboxName,
    timeoutMs: number = this.options.defaultTimeoutMs ?? 30_000,
  ): Promise<ShutdownResponse> {
    const record = this.records.get(teammateName);
    if (!record) {
      throw new Error(`no shutdown_request sent to "${teammateName}" (call sendRequest first)`);
    }
    const leaderName = record.leaderName;
    const start = Date.now();
    const pollInterval = this.options.pollIntervalMs ?? 100;

    while (Date.now() - start < timeoutMs) {
      const unread = await this.mailbox.readUnread(leaderName);
      const responseMsg = unread.find(m =>
        m.type === 'shutdown_response' &&
        m.from === teammateName,
      );
      if (responseMsg) {
        const response = responseMsg.payload as ShutdownResponse;
        // 标记已读 + 更新握手状态
        await this.mailbox.markRead(leaderName, [responseMsg.id]);
        record.response = response;
        record.state = response.approve ? 'cleaned_up' : 'rejected';
        return response;
      }
      await sleep(pollInterval);
    }

    // 超时
    record.state = 'timeout';
    throw new Error(
      `shutdown_response timeout (${timeoutMs}ms) for teammate "${teammateName}" (invariant #6: no force kill)`,
    );
  }

  /** 查询握手状态 */
  getRecord(teammateName: MailboxName): HandshakeRecord | undefined {
    return this.records.get(teammateName);
  }

  /** 清除握手记录（测试用） */
  clearRecords(): void {
    this.records.clear();
  }
}
