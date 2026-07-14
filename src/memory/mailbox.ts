/**
 * writeMailboxAtomic（L3-M7 §4.5.2 + L3-M5 §5.2 — M2 iter 2 + iter 5）
 *
 * Mailbox 原子写原语：按 name 寻址的文件系统 JSONL mailbox。
 *
 * 设计要点：
 * - 文件路径：`{home}/.omniagent/mailbox/{name}.jsonl`（按 name 寻址，不变量 #2）
 * - 原子写：temp + rename（fs.rename 在 POSIX 下原子）
 * - 重试：10 次指数退避 1ms / 2ms / 4ms / ... / 512ms（封顶 512ms）
 * - 容量限制：单条 64KB / 文件 4MB / 1000 条消息
 * - 归档触发：超 archiveThreshold (200) 时，最老 200 条移到 `{name}.archive.jsonl`
 *
 * 不变量 #7（零丢失）：
 * - 任何并发写都不会丢消息（temp + rename 保证）
 * - 重试失败到上限返回 `file_locked`，调用方决定降级
 * - 归档是 best-effort（归档失败不阻断主写）
 *
 * 双层锁（M2 iter 5）：
 * - L1 进程内：per-name Mutex（同进程多 agent 串行化 read-modify-write）
 * - L2 跨进程：file lock（`{name}.jsonl.lock` PID 文件 + stale 检测）
 * - 跨进程锁失败退避重试，stale lock 自动清理
 *
 * M2 iter 2 范围：
 * - writeMailboxAtomic 实现
 * - readMailbox（读全部，含 archive）
 * - markMailboxRead（标记已读）
 *
 * M2 iter 5 范围：
 * - 跨进程文件锁（Daemon 模式多进程写同一 mailbox 不丢失）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  MailboxCapacityLimits,
  MailboxMessage,
  MailboxName,
  UUID,
  WriteMailboxAtomicParams,
  WriteMailboxAtomicResult,
} from '../types/index.js';
import { DEFAULT_MAILBOX_LIMITS } from '../types/index.js';

// ============================================================
// 路径 helper
// ============================================================

/** 默认 mailbox 文件路径（~/.omniagent/mailbox/{name}.jsonl） */
export function defaultMailboxPath(name: MailboxName): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return path.join(home, '.omniagent', 'mailbox', `${name}.jsonl`);
}

/** 默认 archive 文件路径（~/.omniagent/mailbox/{name}.archive.jsonl） */
export function defaultMailboxArchivePath(name: MailboxName): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return path.join(home, '.omniagent', 'mailbox', `${name}.archive.jsonl`);
}

/** 确保 mailbox 目录存在 */
async function ensureMailboxDir(mailboxPath: string): Promise<void> {
  await fs.mkdir(path.dirname(mailboxPath), { recursive: true });
}

// ============================================================
// 原子写实现
// ============================================================

/** 退避时间（ms）：1, 2, 4, 8, 16, 32, 64, 128, 256, 512 */
function backoffMs(attempt: number): number {
  return Math.min(512, 2 ** attempt);
}

/** sleep helper（可被打断） */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// 进程内 per-name Mutex（不变量 #7：同进程并发写零丢失）
// ============================================================

/**
 * 按 mailbox name 分片的进程内 Mutex。
 *
 * 同 name 的写操作串行化（read-modify-write 临界区），
 * 不同 name 之间互不阻塞。
 *
 * 跨进程锁见 acquireMailboxFileLock（M2 iter 5）。
 */
const mailboxMutexes = new Map<string, Promise<void>>();

/** 在 per-name Mutex 保护下执行临界区 */
function withMailboxMutex<T>(
  name: MailboxName,
  fn: () => Promise<T>,
): Promise<T> {
  const key = name as string;
  const prev = mailboxMutexes.get(key) ?? Promise.resolve();
  // 链式：prev 完成后才执行 fn；fn 的结果/错误透传给调用方
  // 但下一个 link 等待的是"已 settled"的版本（错误被吞），避免链路中断
  const next = prev.then(() => fn());
  mailboxMutexes.set(key, next.then(() => {}, () => {}));
  return next;
}

// ============================================================
// 跨进程文件锁（M2 iter 5：Daemon 模式多进程写同一 mailbox）
// ============================================================

/** lock 文件路径（`{mailboxPath}.lock`） */
function mailboxLockPath(name: MailboxName): string {
  return `${defaultMailboxPath(name)}.lock`;
}

/** 检测 PID 是否存活（process.kill(pid, 0) 不抛错 → 存活） */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = 进程存在但无权限（视为存活）；ESRCH = 进程不存在
    return code === 'EPERM';
  }
}

/** stale lock 超时阈值：60 秒（超过视为 stale，可强制删除） */
const STALE_LOCK_TIMEOUT_MS = 60_000;

/**
 * 获取 mailbox 跨进程文件锁
 *
 * 实现：PID 文件 + stale 检测
 * - 用 fs.open(lockPath, 'wx')（O_EXCL）独占创建 lock 文件
 * - 写入 {pid}\n{timestamp}\n
 * - 释放时删除 lock 文件
 *
 * stale 检测：
 * - 若 lock 文件存在但 pid 已死 → stale，强制删除
 * - 若 lock 文件存在但 timestamp > 60s → stale，强制删除
 *
 * 失败退避重试 10 次（指数退避 1ms-512ms）。
 *
 * @returns release 函数（删除 lock 文件）
 */
async function acquireMailboxFileLock(
  name: MailboxName,
  retries = 10,
): Promise<{ release: () => Promise<void> }> {
  const lockPath = mailboxLockPath(name);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // O_EXCL + O_CREAT：文件已存在则失败（ENOENT → 创建；EEXIST → 已有 lock）
      const fh = await fs.open(lockPath, 'wx', 0o600);
      await fh.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8');
      await fh.close();
      return {
        release: async () => {
          // 仅当 lock 文件仍属于本进程时才删除（避免误删他人 lock）
          try {
            const content = await fs.readFile(lockPath, 'utf8');
            const pidStr = content.split('\n')[0];
            if (parseInt(pidStr!, 10) === process.pid) {
              await fs.unlink(lockPath);
            }
          } catch {
            // 读取失败 → 不删除（避免误删）
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // lock 文件已存在 → 检查 stale
        try {
          const content = await fs.readFile(lockPath, 'utf8');
          const [pidStr, tsStr] = content.split('\n');
          const pid = parseInt(pidStr!, 10);
          const ts = parseInt(tsStr!, 10);
          if (!Number.isFinite(pid) || !isProcessAlive(pid) || Date.now() - ts > STALE_LOCK_TIMEOUT_MS) {
            // stale lock，强制删除后重试
            await fs.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {
          // 读取失败 → 视为 stale，强制删除后重试
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
        if (attempt < retries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(`mailbox file lock acquisition failed after ${retries} retries (lock="${lockPath}")`);
      }
      throw err;
    }
  }
  throw new Error(`mailbox file lock acquisition failed after ${retries} retries (lock="${lockPath}")`);
}

/** 计算 messages 数组的总字节数（每条 + '\n'） */
function totalBytes(messages: MailboxMessage[]): number {
  return messages.reduce(
    (sum, m) => sum + Buffer.byteLength(JSON.stringify(m) + '\n', 'utf8'),
    0,
  );
}

/**
 * 原子写一条消息到 mailbox
 *
 * 步骤：
 * 1. 校验单条消息大小 ≤ maxSingleMessageBytes
 * 2. 确保目录存在
 * 3. 进入 per-name Mutex 临界区：
 *    a. 读取当前 mailbox
 *    b. 校验消息数 + 1 ≤ maxMessagesPerMailbox（否则触发归档）
 *    c. 校验文件字节 + 新消息字节 ≤ maxMailboxFileBytes（否则触发归档）
 *    d. temp + rename 原子写
 * 4. 失败（如 EBUSY / EPERM）则退避重试，最多 `retries` 次
 *
 * 不变量 #7（零丢失）：
 * - 同进程并发写由 per-name Mutex 串行化，无 read-modify-write 竞态
 * - temp + rename 保证文件原子替换（POSIX rename 原子性）
 * - 归档失败不阻断主写（返回 over_capacity 让调用方决定降级）
 */
export async function writeMailboxAtomic(
  params: WriteMailboxAtomicParams,
  limits: MailboxCapacityLimits = DEFAULT_MAILBOX_LIMITS,
): Promise<WriteMailboxAtomicResult> {
  const { teammate_name, message } = params;
  const maxRetries = params.retries ?? 10;
  const mailboxPath = defaultMailboxPath(teammate_name);

  // 1. 校验单条消息大小（mutex 外可做，无副作用）
  const messageJson = JSON.stringify(message) + '\n';
  const messageBytes = Buffer.byteLength(messageJson, 'utf8');
  if (messageBytes > limits.maxSingleMessageBytes) {
    return { written: false, error: 'over_capacity' };
  }

  // 2. 确保目录存在
  await ensureMailboxDir(mailboxPath);

  // 3. 临界区：read + check + archive + write
  //    L1 进程内 Mutex（withMailboxMutex）+ L2 跨进程文件锁（acquireMailboxFileLock）
  //    双层锁：L1 防同进程竞态，L2 防跨进程（Daemon 模式）竞态
  return withMailboxMutex(teammate_name, async () => {
    // L2 跨进程锁：获取后保证此进程独占 mailbox 文件
    // 失败（如 lock 文件持续被占）→ 返回 file_locked（不变量 #7：不强删，调用方降级）
    let lock: { release: () => Promise<void> };
    try {
      lock = await acquireMailboxFileLock(teammate_name, maxRetries);
    } catch {
      return { written: false, error: 'file_locked' as const };
    }

    try {
      let archiveTriggered = false;

      // 3a. 读取当前 mailbox
      let current: MailboxMessage[];
      try {
        current = await readMailboxRaw(teammate_name);
      } catch {
        return { written: false, error: 'io_error' as const };
      }

      // 3b. 校验消息数 + 触发归档
      if (current.length + 1 > limits.maxMessagesPerMailbox) {
        const archiveCount = Math.min(limits.archiveThreshold, current.length);
        if (archiveCount === 0) {
          return { written: false, error: 'over_capacity' as const };
        }
        const toArchive = current.slice(0, archiveCount);
        const remaining = current.slice(archiveCount);
        if (remaining.length + 1 > limits.maxMessagesPerMailbox) {
          return { written: false, error: 'over_capacity' as const };
        }
        try {
          await archiveMessages(teammate_name, toArchive, remaining);
          archiveTriggered = true;
          current = remaining;
        } catch {
          return { written: false, error: 'over_capacity' as const };
        }
      }

      // 3c. 校验文件字节 + 触发归档
      const currentBytes = totalBytes(current);
      if (currentBytes + messageBytes > limits.maxMailboxFileBytes) {
        const archiveCount = Math.min(limits.archiveThreshold, current.length);
        if (archiveCount === 0) {
          return { written: false, error: 'over_capacity' as const };
        }
        const toArchive = current.slice(0, archiveCount);
        const remaining = current.slice(archiveCount);
        const remainingBytes = totalBytes(remaining);
        if (remainingBytes + messageBytes > limits.maxMailboxFileBytes) {
          // 归档后仍超限 → 放弃
          return { written: false, error: 'over_capacity' as const };
        }
        try {
          await archiveMessages(teammate_name, toArchive, remaining);
          archiveTriggered = true;
          current = remaining;
        } catch {
          return { written: false, error: 'over_capacity' as const };
        }
      }

      // 3d. 原子写：temp + rename，重试
      // 当前进程内 mutex + 跨进程 lock 保护下，current 就是最新状态，无需重读
      const next = [...current, message];
      const nextJson = next.map(m => JSON.stringify(m)).join('\n') + '\n';

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const tempPath = `${mailboxPath}.${randomUUID()}.tmp`;
          await fs.writeFile(tempPath, nextJson, { encoding: 'utf8' });
          await fs.rename(tempPath, mailboxPath);
          return { written: true, archive_triggered: archiveTriggered };
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // 重试场景：EBUSY / EPERM / EACCES（跨进程文件锁暂时不可用）
          if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EEXIST') {
            if (attempt < maxRetries) {
              await sleep(backoffMs(attempt));
              continue;
            }
          }
          // 其他错误 → 不重试
          return { written: false, error: 'io_error' as const };
        }
      }

      return { written: false, error: 'file_locked' as const };
    } finally {
      // 释放跨进程锁（finally 保证异常路径也释放）
      await lock.release();
    }
  });
}

// ============================================================
// 读 / 标记已读 / 归档
// ============================================================

/** 读取 mailbox 当前消息（不含 archive） */
export async function readMailboxRaw(name: MailboxName): Promise<MailboxMessage[]> {
  const mailboxPath = defaultMailboxPath(name);
  let text: string;
  try {
    text = await fs.readFile(mailboxPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const lines = text.split('\n').filter(l => l.trim());
  const messages: MailboxMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as MailboxMessage);
    } catch {
      // 单行解析失败 → 跳过
    }
  }
  return messages;
}

/** 读取 mailbox 全部消息（含 archive，archive 在前） */
export async function readMailboxAll(name: MailboxName): Promise<MailboxMessage[]> {
  const archivePath = defaultMailboxArchivePath(name);
  let archive: MailboxMessage[] = [];
  try {
    const text = await fs.readFile(archivePath, 'utf8');
    archive = text
      .split('\n')
      .filter(l => l.trim())
      .map(l => {
        try { return JSON.parse(l) as MailboxMessage; } catch { return null; }
      })
      .filter((m): m is MailboxMessage => m !== null);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
  const current = await readMailboxRaw(name);
  return [...archive, ...current];
}

/**
 * 标记消息已读（按 id 匹配）
 *
 * 跨 turn 持久化：leader 重启后未读消息仍可达，所以 read 状态必须写入文件。
 *
 * 在 per-name Mutex 保护下执行 read-modify-write，避免与并发写竞态。
 */
export async function markMailboxRead(
  name: MailboxName,
  messageIds: UUID[],
): Promise<number> {
  if (messageIds.length === 0) return 0;
  return withMailboxMutex(name, async () => {
    const idSet = new Set(messageIds);
    const current = await readMailboxRaw(name);
    let marked = 0;
    const next = current.map(m => {
      if (idSet.has(m.id) && !m.read) {
        marked++;
        return { ...m, read: true };
      }
      return m;
    });
    if (marked === 0) return 0;
    const mailboxPath = defaultMailboxPath(name);
    const tempPath = `${mailboxPath}.${randomUUID()}.tmp`;
    const nextJson = next.map(m => JSON.stringify(m)).join('\n') + '\n';
    await fs.writeFile(tempPath, nextJson, { encoding: 'utf8' });
    await fs.rename(tempPath, mailboxPath);
    return marked;
  });
}

/**
 * 归档消息：把 toArchive 移到 archive 文件，remaining 留在主 mailbox
 *
 * 原子性：先写 archive + remaining 的 temp，再 rename 两次。
 * 失败回滚：rename 失败时 archive 文件不变。
 */
async function archiveMessages(
  name: MailboxName,
  toArchive: MailboxMessage[],
  remaining: MailboxMessage[],
): Promise<void> {
  const mailboxPath = defaultMailboxPath(name);
  const archivePath = defaultMailboxArchivePath(name);

  // 1. 读取现有 archive（append 模式）
  let existingArchive: MailboxMessage[] = [];
  try {
    const text = await fs.readFile(archivePath, 'utf8');
    existingArchive = text
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as MailboxMessage);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  // 2. 写 archive（existingArchive + toArchive）
  const archiveNext = [...existingArchive, ...toArchive];
  const archiveJson = archiveNext.map(m => JSON.stringify(m)).join('\n') + '\n';
  const archiveTemp = `${archivePath}.${randomUUID()}.tmp`;
  await fs.writeFile(archiveTemp, archiveJson, { encoding: 'utf8' });

  // 3. 写 remaining（覆盖主 mailbox）
  const remainingJson = remaining.map(m => JSON.stringify(m)).join('\n') + '\n';
  const mailboxTemp = `${mailboxPath}.${randomUUID()}.tmp`;
  await fs.writeFile(mailboxTemp, remainingJson, { encoding: 'utf8' });

  // 4. 原子 rename 两次（archive 先，mailbox 后；如果 archive rename 失败，mailbox 不变）
  await fs.rename(archiveTemp, archivePath);
  await fs.rename(mailboxTemp, mailboxPath);
}

// ============================================================
// 统计 helper（监控 / 测试用）
// ============================================================

/** mailbox 当前消息数（不含 archive） */
export async function mailboxCount(name: MailboxName): Promise<number> {
  const msgs = await readMailboxRaw(name);
  return msgs.length;
}

/** mailbox 当前字节数（不含 archive） */
export async function mailboxBytes(name: MailboxName): Promise<number> {
  const mailboxPath = defaultMailboxPath(name);
  try {
    const stat = await fs.stat(mailboxPath);
    return stat.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    throw err;
  }
}
