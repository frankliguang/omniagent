/**
 * DrainWriteQueue（L3-M7 §2.2.16 + L2 §5.2）
 *
 * Transcript 持久化写队列：
 * - 100ms 节流（throttle）：批量写，吞吐优先
 * - 10ms flush：紧急持久化（崩溃窗口最多 10ms 数据丢失）
 * - 进程内 Mutex：同进程多 agent 串行化
 * - flock 跨进程锁：Daemon 模式下协调多进程
 * - appendFile + fsync：append-only JSONL，原子性 + 落盘
 *
 * 关键修正（L2 §5.2 自审 C1 + C2 + M17）：
 * - 不用 temp+rename（会覆盖历史）→ 用 appendFile
 * - flushing 重入守卫（throttle 与 flush 同时到期时避免竞态）
 * - 10ms flush 立即触发，100ms throttle 永远没机会批量 → 两者都启动，先到期的先 flush
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Message } from '../types/index.js';

/** 跨进程文件锁（flock 封装） */
export interface FileLock {
  /** 获取锁，超时抛错 */
  acquire(timeoutMs: number): Promise<void>;
  /** 释放锁 */
  release(): Promise<void>;
}

/** DrainWriteQueue 配置 */
export interface DrainWriteQueueOptions {
  /** transcript 文件路径（~/.omniagent/transcript/{sessionId}.jsonl） */
  transcriptPath: string;
  /** 节流定时器 ms（默认 100） */
  throttleMs?: number;
  /** flush 定时器 ms（默认 10） */
  flushMs?: number;
  /** 跨进程文件锁（Daemon 模式启用，CLI 单进程模式可选） */
  fileLock?: FileLock;
  /** 是否启用 fsync（默认 true；测试可关以加速） */
  enableFsync?: boolean;
}

export class DrainWriteQueue {
  /** 100ms 节流：积累消息，100ms 后批量写 */
  static readonly THROTTLE_MS = 100;
  /** 10ms flush：紧急持久化 */
  static readonly FLUSH_MS = 10;

  private readonly queue: Message[] = [];
  private throttleTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private mutex: Promise<void> = Promise.resolve();
  private flushing = false;
  private closed = false;

  private readonly transcriptPath: string;
  private readonly throttleMs: number;
  private readonly flushMs: number;
  private readonly fileLock?: FileLock;
  private readonly enableFsync: boolean;

  constructor(opts: DrainWriteQueueOptions) {
    this.transcriptPath = opts.transcriptPath;
    this.throttleMs = opts.throttleMs ?? DrainWriteQueue.THROTTLE_MS;
    this.flushMs = opts.flushMs ?? DrainWriteQueue.FLUSH_MS;
    this.fileLock = opts.fileLock;
    this.enableFsync = opts.enableFsync ?? true;
  }

  /** 入队消息（异步返回，写入由定时器触发） */
  async enqueue(msg: Message): Promise<void> {
    if (this.closed) throw new Error('DrainWriteQueue: closed, cannot enqueue');
    // 进程内 Mutex 排队
    this.mutex = this.mutex.then(() => this.enqueueInternal(msg));
    await this.mutex;
  }

  private async enqueueInternal(msg: Message): Promise<void> {
    this.queue.push(msg);
    // 启动 100ms 节流定时器（若未启动）
    if (!this.throttleTimer && !this.flushTimer) {
      this.throttleTimer = setTimeout(() => {
        void this.flush();
      }, this.throttleMs);
    }
    // 启动 10ms flush 定时器（若未启动）
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        void this.flush();
      }, this.flushMs);
    }
  }

  /** 立即 flush 队列（外部强制持久化用，如 abort/shutdown） */
  async flush(): Promise<void> {
    // 重入守卫：throttle 与 flush 同时到期时，后到的直接返回
    if (this.flushing) return;
    this.flushing = true;

    // 清掉两个定时器（任一触发 flush，两个都失效）
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    try {
      // 跨进程文件锁
      if (this.fileLock) await this.fileLock.acquire(5000);

      // 取出批量消息
      const batch = this.queue.splice(0);
      if (batch.length === 0) return;

      // 原子追加写（append-only JSONL）
      const data = batch.map(m => JSON.stringify(m) + '\n').join('');
      await fs.appendFile(this.transcriptPath, data, { encoding: 'utf8' });

      // fsync 保证落盘
      if (this.enableFsync) {
        const fd = await fs.open(this.transcriptPath, 'r+');
        try {
          await fd.sync();
        } finally {
          await fd.close();
        }
      }
    } finally {
      if (this.fileLock) await this.fileLock.release();
      this.flushing = false;
    }
  }

  /** 关闭队列（shutdown 时强制 flush） */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  /** 当前队列长度（未写出的消息数） */
  size(): number {
    return this.queue.length;
  }

  /** 是否正在 flush */
  isFlushing(): boolean {
    return this.flushing;
  }
}

// ============================================================
// 工厂函数
// ============================================================

/** 创建 transcript 目录（若不存在） */
export async function ensureTranscriptDir(transcriptPath: string): Promise<void> {
  const dir = path.dirname(transcriptPath);
  await fs.mkdir(dir, { recursive: true });
}

/** 默认 transcript 路径（~/.omniagent/transcript/{sessionId}.jsonl） */
export function defaultTranscriptPath(sessionId: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return path.join(home, '.omniagent', 'transcript', `${sessionId}.jsonl`);
}
