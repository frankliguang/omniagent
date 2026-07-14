/**
 * WorktreeRoster（L3-M5 §2.2.12 — M2 iter 2）
 *
 * 不变量 #1（worktree 唯一归属）：
 * - 一个 worktree 同时只属于一个 teammate
 * - assign 时检测 path 冲突（同一 path 不能给两个 teammate）
 * - release 后才能再次 assign 同一 path
 *
 * 设计：
 * - roster 内存表（M2 iter 2 单进程模式）
 * - git worktree 命令通过 injectable runner 执行（测试可 mock）
 * - 跨进程持久化留 v2.x（Daemon 模式 flock + 文件 roster）
 *
 * M2 iter 2 范围：
 * - assign / release / getOwner / list
 * - 不变量 #1 守护
 * - 不实现跨进程文件锁（v2.x）
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import type { AgentId, MailboxName } from '../types/index.js';

// ============================================================
// 类型
// ============================================================

export interface WorktreeEntry {
  teammateName: MailboxName;
  agentId: AgentId;
  path: string;
  assignedAt: string;
}

export interface AssignWorktreeParams {
  teammateName: MailboxName;
  agentId: AgentId;
  /** 自定义 worktree 路径（测试用；默认自动生成） */
  worktreePath?: string;
}

export interface WorktreeOperations {
  /** 创建 git worktree（实际命令：git worktree add） */
  createWorktree(name: MailboxName, path: string): Promise<void>;
  /** 删除 git worktree（实际命令：git worktree remove） */
  removeWorktree(path: string): Promise<void>;
}

// ============================================================
// 默认 git worktree 操作（生产用）
// ============================================================

/** 默认 git worktree 操作：调用 git worktree add / remove */
export class GitWorktreeOps implements WorktreeOperations {
  constructor(private readonly repoRoot: string) {}

  async createWorktree(_name: MailboxName, path: string): Promise<void> {
    await this.execGit(['worktree', 'add', path, 'HEAD']);
  }

  async removeWorktree(path: string): Promise<void> {
    await this.execGit(['worktree', 'remove', path, '--force']);
  }

  private execGit(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd: this.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr}`));
      });
    });
  }
}

// ============================================================
// 内存版 worktree 操作（测试用，不调 git）
// ============================================================

/** 测试用 worktree ops：只创建空目录，不调 git */
export class InMemoryWorktreeOps implements WorktreeOperations {
  private readonly createdPaths = new Set<string>();

  constructor(private readonly baseDir: string) {
    // baseDir 当前未直接使用（路径由调用方提供）；保留为契约字段以便未来扩展默认路径生成。
    void this.baseDir;
  }

  async createWorktree(_name: MailboxName, path: string): Promise<void> {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path, { recursive: true });
    this.createdPaths.add(path);
  }

  async removeWorktree(path: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(path, { recursive: true, force: true }).catch(() => {});
    this.createdPaths.delete(path);
  }
}

// ============================================================
// WorktreeRoster
// ============================================================

export class WorktreeRoster {
  /** teammateName → entry 映射 */
  private readonly roster = new Map<MailboxName, WorktreeEntry>();
  /** path → teammateName 反向索引（不变量 #1 守护） */
  private readonly pathIndex = new Map<string, MailboxName>();

  constructor(private readonly ops: WorktreeOperations) {}

  /**
   * 分配 worktree 给 teammate
   *
   * 不变量 #1 守护：
   * - teammate 已有 worktree → 抛错（不覆盖）
   * - path 已被其他 teammate 占用 → 抛错（worktree 唯一归属）
   */
  async assign(params: AssignWorktreeParams): Promise<{ path: string }> {
    // 1. teammate 已有 worktree？
    if (this.roster.has(params.teammateName)) {
      throw new Error(
        `teammate "${params.teammateName}" already has a worktree at ${this.roster.get(params.teammateName)!.path} (invariant #1: one worktree per teammate)`,
      );
    }

    // 2. 生成或使用自定义 path
    const worktreePath = params.worktreePath ?? this.generateDefaultPath(params.teammateName);

    // 3. path 已被其他 teammate 占用？
    if (this.pathIndex.has(worktreePath)) {
      const owner = this.pathIndex.get(worktreePath)!;
      throw new Error(
        `worktree path "${worktreePath}" already assigned to teammate "${owner}" (invariant #1: worktree unique ownership)`,
      );
    }

    // 4. 调用 git worktree add（实际创建 worktree）
    await this.ops.createWorktree(params.teammateName, worktreePath);

    // 5. 记录归属
    const entry: WorktreeEntry = {
      teammateName: params.teammateName,
      agentId: params.agentId,
      path: worktreePath,
      assignedAt: new Date().toISOString(),
    };
    this.roster.set(params.teammateName, entry);
    this.pathIndex.set(worktreePath, params.teammateName);

    return { path: worktreePath };
  }

  /** 释放 worktree（shutdown / evicted 时调用） */
  async release(teammateName: MailboxName): Promise<void> {
    const entry = this.roster.get(teammateName);
    if (!entry) return;  // 幂等：未注册的 name 直接返回
    await this.ops.removeWorktree(entry.path);
    this.roster.delete(teammateName);
    this.pathIndex.delete(entry.path);
  }

  /** 查询 worktree 归属（按 path 反查 teammate name） */
  getOwner(worktreePath: string): MailboxName | undefined {
    return this.pathIndex.get(worktreePath);
  }

  /** 查询 teammate 的 worktree（按 name 正查） */
  get(teammateName: MailboxName): WorktreeEntry | undefined {
    return this.roster.get(teammateName);
  }

  /** 列出全部 worktree 归属 */
  list(): WorktreeEntry[] {
    return Array.from(this.roster.values());
  }

  /** 当前 worktree 数量 */
  size(): number {
    return this.roster.size;
  }

  /** 重置 roster（测试 / 全部清理用） */
  clear(): void {
    this.roster.clear();
    this.pathIndex.clear();
  }

  /** 默认 worktree 路径：~/.omniagent/worktrees/{name}-{uuid} */
  private generateDefaultPath(name: MailboxName): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
    const safeName = (name as string).replace(/[^a-zA-Z0-9-_]/g, '-');
    return `${home}/.omniagent/worktrees/${safeName}-${randomUUID().slice(0, 8)}`;
  }
}
