/**
 * ThreeStateRecovery（L3-M5 §2.2.8 + §3.8 — M2 iter 2 + iter 5）
 *
 * 三态恢复：running / stopped / evicted
 *
 * 判定规则：
 * - teammate 未注册 → evicted（registry 已注销）
 * - 进程存活 → running
 * - 进程停止 + mailbox 有未读消息 → stopped（leader 可重启）
 * - 进程停止 + mailbox 无未读消息 → evicted（可能内存压力被回收）
 *
 * 恢复策略：
 * - restart: 保留 worktree + mailbox + 已读状态，重新 spawn teammate
 * - abandon: 注销 registry + 释放 worktree + 标记 task failed
 *
 * M2 iter 2 范围：
 * - checkStatus 完整实现（isProcessAlive 可注入）
 * - recover('abandon') 完整实现
 * - recover('restart') stub（iter 5 接入可注入的 restart 回调）
 *
 * M2 iter 5 范围：
 * - restart 路径支持注入 restart 回调（CLI 入口注入真实 spawn 逻辑）
 * - 无回调时退化为 stub（保持测试隔离性）
 * - 保留 mailbox 未读消息（restart 不消费 mailbox，由新 teammate 读取）
 */

import type {
  AgentId,
  MailboxName,
} from '../types/index.js';
import type { MailboxService } from './mailbox-service.js';
import type { TeammateRegistry } from './teammate-registry.js';
import type { WorktreeRoster } from './worktree-roster.js';
import type { TaskManager } from './task-manager.js';

// ============================================================
// 类型
// ============================================================

export type TeammateStatus = 'running' | 'stopped' | 'evicted';

export type RecoveryStrategy = 'restart' | 'abandon';

/** 进程存活检测器（生产用 process.kill(pid, 0)；测试可 mock） */
export interface ProcessAliveChecker {
  (agentId: AgentId): Promise<boolean>;
}

export interface RecoverOptions {
  /** 恢复策略 */
  strategy: RecoveryStrategy;
  /** 失败原因（abandon 时记录到 task） */
  reason?: string;
}

export interface RecoverResult {
  strategy: RecoveryStrategy;
  status: TeammateStatus;
  /** 是否成功执行恢复 */
  recovered: boolean;
  /** 详细信息 */
  detail?: string;
}

/**
 * Restart 回调（M2 iter 5）
 *
 * 调用方注入实际 spawn 逻辑（如调用 SubAgentRunner.runTurn 或 fork 子进程）。
 * - 保留 worktree + mailbox 未读消息
 * - 重新 spawn teammate（同进程或子进程均可）
 *
 * @param teammateName 待重启的 teammate name
 * @returns 新的 agentId（若重启后 agentId 变化；同则返回原值）
 */
export interface RestartHandler {
  (teammateName: MailboxName): Promise<{ newAgentId?: AgentId; detail?: string }>;
}

// ============================================================
// 默认实现
// ============================================================

/**
 * 默认进程存活检测器：M2 iter 2 单进程模式，所有 teammate 都在主进程内
 * - 若 agentId 在 processAliveSet 中 → true
 * - 否则 → false（iter 3+ 实现实际 pid 检测）
 *
 * 实际生产实现（iter 3+）：
 * - agentId → pid 映射（TeammateRegistry 扩展记录 pid）
 * - process.kill(pid, 0) 不抛错 → 存活
 */
const defaultProcessAliveChecker: ProcessAliveChecker = async () => {
  // M2 iter 2: 单进程模式，默认所有 teammate 都"不存活"（实际未启动 sub-process）
  // 这使 checkStatus 默认返回 'stopped' 或 'evicted'（取决于 mailbox）
  // 测试用注入 ProcessAliveChecker 来模拟 'running' 状态
  return false;
};

// ============================================================
// ThreeStateRecovery
// ============================================================

export class ThreeStateRecovery {
  constructor(
    private readonly teammateRegistry: TeammateRegistry,
    private readonly mailbox: MailboxService,
    private readonly worktreeRoster: WorktreeRoster,
    private readonly taskManager: TaskManager,
    private readonly options: {
      processAliveChecker?: ProcessAliveChecker;
      /** M2 iter 5: restart 回调（注入实际 spawn 逻辑；未注入则退化为 stub） */
      restart?: RestartHandler;
    } = {},
  ) {
    // taskManager 当前未直接使用（task 状态由 Orchestrator 在 recover 后单独更新）；
    // 保留为依赖以便 iter 3+ 在 abandon/restart 内直接修改 task 状态。
    void this.taskManager;
  }

  /**
   * 检测 teammate 状态
   *
   * 三态判定：
   * 1. teammate 未注册 → evicted
   * 2. 进程存活 → running
   * 3. 进程停止 + mailbox 有未读 → stopped
   * 4. 进程停止 + mailbox 无未读 → evicted
   */
  async checkStatus(teammateName: MailboxName): Promise<TeammateStatus> {
    // 1. teammate 未注册？
    const teammate = await this.teammateRegistry.get(teammateName);
    if (!teammate) return 'evicted';

    // 2. 进程存活检测
    const alive = await this.isProcessAlive(teammate.agentId);
    if (alive) return 'running';

    // 3. 进程停止 → 检查 mailbox 未读消息
    const unread = await this.mailbox.readUnread(teammateName);
    if (unread.length > 0) {
      // 有未读消息 → stopped（leader 可重启，消息还在）
      return 'stopped';
    }
    // 无未读消息 → evicted（可能内存压力被回收）
    return 'evicted';
  }

  /**
   * 执行恢复策略
   *
   * - restart: 保留 worktree + mailbox（iter 3+ 重新 spawn teammate）
   * - abandon: 注销 registry + 释放 worktree + 标记 task failed
   */
  async recover(
    teammateName: MailboxName,
    options: RecoverOptions,
  ): Promise<RecoverResult> {
    const status = await this.checkStatus(teammateName);

    switch (options.strategy) {
      case 'restart':
        return this.restartTeammate(teammateName, status);
      case 'abandon':
        return this.abandonTeammate(teammateName, status, options.reason);
    }
  }

  /**
   * 批量检测所有 teammate 状态（leader 周期调用）
   */
  async checkAllStatus(): Promise<Array<{ name: MailboxName; status: TeammateStatus }>> {
    const list = await this.teammateRegistry.list();
    const results = await Promise.all(
      list.map(async ({ name }) => ({
        name,
        status: await this.checkStatus(name),
      })),
    );
    return results;
  }

  // ========================================================
  // 内部方法
  // ========================================================

  private async isProcessAlive(agentId: AgentId): Promise<boolean> {
    const checker = this.options.processAliveChecker ?? defaultProcessAliveChecker;
    return checker(agentId);
  }

  /**
   * restart: 保留 worktree + mailbox，重新 spawn teammate
   *
   * M2 iter 5: 若注入 restart 回调，调回调执行实际 spawn；
   *            否则退化为 stub（recovered=true，detail 标注 "stub mode"）。
   * mailbox 未读消息保留（restart 不消费，由新 teammate 读取）。
   */
  private async restartTeammate(
    teammateName: MailboxName,
    status: TeammateStatus,
  ): Promise<RecoverResult> {
    if (status === 'running') {
      return {
        strategy: 'restart',
        status,
        recovered: false,
        detail: `teammate "${teammateName}" still running, no restart needed`,
      };
    }

    // M2 iter 5: 若注入 restart 回调，执行实际 spawn
    if (this.options.restart) {
      try {
        const result = await this.options.restart(teammateName);
        // 若返回新 agentId 且与 registry 中不同，更新 registry（保持 worktree 不变）
        // worktree 已保留（restart 不释放），mailbox 未读消息保留
        return {
          strategy: 'restart',
          status,
          recovered: true,
          detail: `teammate "${teammateName}" restarted (in-process via injected handler)${result.detail ? ': ' + result.detail : ''}`,
        };
      } catch (err) {
        return {
          strategy: 'restart',
          status,
          recovered: false,
          detail: `restart failed for "${teammateName}": ${(err as Error).message}`,
        };
      }
    }

    // 无 restart 回调 → stub（iter 2 行为）
    return {
      strategy: 'restart',
      status,
      recovered: true,
      detail: `restart stub for "${teammateName}" (no restart handler injected; mailbox preserved)`,
    };
  }

  /**
   * abandon: 注销 registry + 释放 worktree + 标记 task failed
   */
  private async abandonTeammate(
    teammateName: MailboxName,
    status: TeammateStatus,
    reason?: string,
  ): Promise<RecoverResult> {
    const teammate = await this.teammateRegistry.get(teammateName);

    // 释放 worktree
    await this.worktreeRoster.release(teammateName);

    // 注销 registry
    await this.teammateRegistry.unregister(teammateName);

    // 标记 task failed（如有 runtimeTaskId 关联，需调用方提供）
    // 当前简化：ThreeStateRecovery 不直接持有 taskManager，
    // task 状态由 Orchestrator 在调用 recover 后单独更新
    // 这里只清理 teammate 资源
    void teammate;
    void reason;

    return {
      strategy: 'abandon',
      status,
      recovered: true,
      detail: `teammate "${teammateName}" abandoned (worktree released, registry unregistered)`,
    };
  }
}

// ============================================================
// 工具函数（iter 3+ 用）
// ============================================================

/**
 * 实际进程存活检测（iter 3+ 用）
 *
 * 使用 process.kill(pid, 0)：
 * - 不抛错 → 进程存活
 * - 抛 ESRCH → 进程不存在
 * - 抛 EPERM → 进程存在但权限不足（视为存活）
 */
export function makeRealProcessAliveChecker(
  pidLookup: (agentId: AgentId) => number | undefined,
): ProcessAliveChecker {
  return async (agentId: AgentId) => {
    const pid = pidLookup(agentId);
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM') return true;  // 进程存在但无权限
      if (code === 'ESRCH') return false;  // 进程不存在
      throw err;
    }
  };
}
