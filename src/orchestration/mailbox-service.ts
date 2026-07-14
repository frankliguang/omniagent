/**
 * MailboxService（L3-M5 §3.3 + L2 §5.3 — M2 iter 2）
 *
 * Mailbox 高层 API：包装 writeMailboxAtomic，提供 send/read/markRead/unreadCount。
 *
 * 职责：
 * - 自动生成 message id + timestamp
 * - 区分 unread / all 两种读模式
 * - 提供 unreadCount（leader 轮询触发点）
 *
 * 不变量 #2（按 name 寻址）：
 * - send({ to: MailboxName }) 强制按 name 寻址，不接受 AgentId
 *
 * 不变量 #7（零丢失）：
 * - 底层 writeMailboxAtomic 保证（temp + rename + per-name Mutex）
 * - send 返回 written=false 时调用方决定降级（不静默丢消息）
 *
 * M2 iter 2 范围：
 * - send / read / readUnread / markRead / unreadCount / count
 * - 不实现 fs watch（M2 iter 3+，目前用轮询）
 * - 不实现跨进程文件锁（v2.x）
 */

import { randomUUID } from 'node:crypto';

import {
  writeMailboxAtomic,
  readMailboxRaw,
  readMailboxAll,
  markMailboxRead,
  mailboxCount,
} from '../memory/mailbox.js';
import type {
  AgentId,
  MailboxCapacityLimits,
  MailboxMessage,
  MailboxName,
  UUID,
} from '../types/index.js';
import { DEFAULT_MAILBOX_LIMITS } from '../types/index.js';

// ============================================================
// 类型
// ============================================================

export interface SendMailboxParams {
  /** 发送方（leader agentId 或 teammate name） */
  from: AgentId | MailboxName;
  /** 接收方 mailbox name（不变量 #2：按 name 寻址） */
  to: MailboxName;
  /** 消息类型 */
  type: MailboxMessage['type'];
  /** 消息负载（text 消息建议 { text: string }） */
  payload: unknown;
  /** 自定义 message id（默认随机生成） */
  id?: UUID;
  /** 自定义 timestamp（默认 now） */
  timestamp?: string;
}

export interface SendMailboxResult {
  written: boolean;
  error?: 'file_locked' | 'over_capacity' | 'io_error';
  archive_triggered?: boolean;
  /** 写入消息的 id（便于调用方追踪） */
  messageId?: UUID;
}

export interface MailboxServiceOptions {
  /** 容量限制（默认 DEFAULT_MAILBOX_LIMITS） */
  limits?: MailboxCapacityLimits;
  /** 写失败重试次数（默认 10） */
  retries?: number;
}

// ============================================================
// MailboxService
// ============================================================

export class MailboxService {
  private readonly limits: MailboxCapacityLimits;
  private readonly retries: number;

  constructor(opts: MailboxServiceOptions = {}) {
    this.limits = opts.limits ?? DEFAULT_MAILBOX_LIMITS;
    this.retries = opts.retries ?? 10;
  }

  /**
   * 发送消息到 mailbox
   *
   * 自动生成 id + timestamp，调用 writeMailboxAtomic。
   * 返回 written=true 时消息已落盘；written=false 时调用方决定降级。
   */
  async send(params: SendMailboxParams): Promise<SendMailboxResult> {
    const message: MailboxMessage = {
      id: params.id ?? (randomUUID() as UUID),
      from: params.from,
      to: params.to,
      type: params.type,
      payload: params.payload,
      timestamp: (params.timestamp ?? new Date().toISOString()) as never,
    };

    const result = await writeMailboxAtomic(
      {
        teammate_name: params.to,
        message,
        retries: this.retries,
      },
      this.limits,
    );

    if (result.written) {
      return {
        written: true,
        archive_triggered: result.archive_triggered,
        messageId: message.id,
      };
    }
    return {
      written: false,
      error: result.error,
    };
  }

  /** 读取 mailbox 全部消息（含 archive，archive 在前） */
  async read(name: MailboxName): Promise<MailboxMessage[]> {
    return readMailboxAll(name);
  }

  /** 读取当前 mailbox 消息（不含 archive） */
  async readCurrent(name: MailboxName): Promise<MailboxMessage[]> {
    return readMailboxRaw(name);
  }

  /** 读取未读消息（含 archive 中的未读） */
  async readUnread(name: MailboxName): Promise<MailboxMessage[]> {
    const all = await readMailboxAll(name);
    return all.filter(m => !m.read);
  }

  /** 标记消息已读（按 id 匹配） */
  async markRead(name: MailboxName, messageIds: UUID[]): Promise<number> {
    return markMailboxRead(name, messageIds);
  }

  /** 未读消息数（leader 轮询触发点） */
  async unreadCount(name: MailboxName): Promise<number> {
    const unread = await this.readUnread(name);
    return unread.length;
  }

  /** 当前消息数（不含 archive） */
  async count(name: MailboxName): Promise<number> {
    return mailboxCount(name);
  }

  /** 便捷发送：text 消息 */
  async sendText(
    from: AgentId | MailboxName,
    to: MailboxName,
    text: string,
  ): Promise<SendMailboxResult> {
    return this.send({ from, to, type: 'text', payload: { text } });
  }

  /** 便捷发送：shutdown_request */
  async sendShutdownRequest(
    from: AgentId | MailboxName,
    to: MailboxName,
    reason: string,
  ): Promise<SendMailboxResult> {
    return this.send({
      from,
      to,
      type: 'shutdown_request',
      payload: { reason },
    });
  }

  /** 便捷发送：shutdown_response */
  async sendShutdownResponse(
    from: AgentId | MailboxName,
    to: MailboxName,
    approve: boolean,
    reason?: string,
  ): Promise<SendMailboxResult> {
    return this.send({
      from,
      to,
      type: 'shutdown_response',
      payload: { approve, reason },
    });
  }

  /** 便捷发送：task_update */
  async sendTaskUpdate(
    from: AgentId | MailboxName,
    to: MailboxName,
    update: {
      task_id: string;
      status: 'running' | 'completed' | 'failed';
      result?: unknown;
      error?: string;
    },
  ): Promise<SendMailboxResult> {
    return this.send({
      from,
      to,
      type: 'task_update',
      payload: update,
    });
  }
}
