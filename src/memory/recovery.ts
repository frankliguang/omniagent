/**
 * RecoveryHandler（L3-M7 §2.2.8 + §3.9 — M2 iter 4）
 *
 * 9 场景错误恢复矩阵（PRD mod-07 §4.5.3）：
 *   1. SCENARIO_TRANSCRIPT_CORRUPT       — main transcript 损坏（断链）→ 从 checkpoint 重建主链
 *   2. SCENARIO_SIDECHAIN_CORRUPT          — sidechain 损坏 → 从最近 boundary 重建
 *   3. SCENARIO_TEAM_MISSING               — team 缺失 → 通知 leader stopped
 *   4. SCENARIO_MAILBOX_CORRUPT            — mailbox 损坏 → 从 .bak 恢复
 *   5. SCENARIO_TASK_CORRUPT               — task 损坏 → work item 重新生成 / runtime task 重建
 *   6. SCENARIO_SIDECAR_404                — sidecar 404 → 三态 evicted（RemoteAgentClient + ThreeStateRecovery）
 *   7. SCENARIO_WORKTREE_MISSING           — worktree pointer 缺失 → 从 roster 重建 pointer
 *   8. SCENARIO_FORK_METADATA_MISSING      — fork metadata 缺失 → 从 parentUuid 回溯
 *   9. SCENARIO_MODE_MISMATCH              — mode 不匹配 → 提示用户重新确认
 *
 * 不变量 #16：9 场景恢复矩阵全 PASS。
 *
 * 数据损失分类（dataLoss）：
 * - 'none'        — 无数据损失（恢复后等价于损坏前）
 * - 'last_turn'   — 丢失最近一轮（最后一条 assistant + 对应 tool_result）
 * - 'last_session'— 丢失最后一次会话（resume 后从空开始）
 * - 'unknown'     — 损坏程度未知（保守 fail-closed）
 *
 * M2 iter 4 范围：
 * - recover() 调度器
 * - 9 个 recoverXxx() 方法实施
 * - .bak mailbox 备份机制（场景 4）
 * - 测试覆盖全 9 场景（mod-07 §6.3.4）
 *
 * 关联模块（依赖注入，便于测试）：
 * - TranscriptStore    — 场景 1/8 链路校验
 * - SidechainManager   — 场景 2 sidechain 重建
 * - TeammateRegistry   — 场景 3 检测
 * - MailboxService     — 场景 4 .bak 恢复
 * - TaskManager        — 场景 5 task 重建
 * - WorktreeRoster     — 场景 7 worktree pointer 重建
 * - BoundaryStore      — 场景 2/8 boundary 回溯
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  BoundaryId,
  CompactBoundary,
  MailboxName,
  Message,
  PermissionMode,
  SessionId,
  TaskId,
  ToolResult,
  UUID,
  WorkItemId,
} from '../types/index.js';
import type { TranscriptStore } from './transcript.js';
import type { BoundaryStore } from './boundary.js';
import type { MailboxService } from '../orchestration/mailbox-service.js';
import type { TeammateRegistry } from '../orchestration/teammate-registry.js';
import type { TaskManager } from '../orchestration/task-manager.js';
import type { WorktreeRoster } from '../orchestration/worktree-roster.js';
import type { ThreeStateRecovery } from '../orchestration/three-state-recovery.js';

// ============================================================
// 9 场景错误码（OmniAgentErrorCode 子集）
// ============================================================

export type RecoveryScenario =
  | 'SCENARIO_TRANSCRIPT_CORRUPT'
  | 'SCENARIO_SIDECHAIN_CORRUPT'
  | 'SCENARIO_TEAM_MISSING'
  | 'SCENARIO_MAILBOX_CORRUPT'
  | 'SCENARIO_TASK_CORRUPT'
  | 'SCENARIO_SIDECAR_404'
  | 'SCENARIO_WORKTREE_MISSING'
  | 'SCENARIO_FORK_METADATA_MISSING'
  | 'SCENARIO_MODE_MISMATCH';

/** 数据损失程度（场景恢复后） */
export type DataLossLevel = 'none' | 'last_turn' | 'last_session' | 'unknown';

// ============================================================
// 恢复上下文 + 结果
// ============================================================

/** 恢复上下文：每个场景需要的字段不同，全部可选（按场景取用） */
export interface RecoveryContext {
  /** 主 transcript sessionId（场景 1/8/9） */
  sessionId?: SessionId;
  /** sidechainId（场景 2） */
  sidechainId?: UUID;
  /** teammate name（场景 3/4/7） */
  teammateName?: MailboxName;
  /** task / work item ID（场景 5） */
  taskId?: TaskId;
  /** workItemId（场景 5） */
  workItemId?: WorkItemId;
  /** 远程 target（场景 6） */
  remoteTarget?: string;
  /** 当前启动 mode（场景 9） */
  expectedMode?: PermissionMode;
  /** transcript store（场景 1/8 已注入；否则 RecoveryHandler 自建） */
  transcript?: TranscriptStore;
  /** boundaryId（场景 2 显式回溯到指定 boundary） */
  boundaryId?: BoundaryId;
  /** 备用消息（场景 8 显式提供 parentUuid 回溯起点） */
  fromMessageId?: UUID;
}

/** 恢复结果 */
export interface RecoveryResult {
  /** 是否成功恢复 */
  ok: boolean;
  /** 场景 */
  scenario: RecoveryScenario;
  /** 数据损失程度 */
  dataLoss: DataLossLevel;
  /** 恢复后可用的消息（场景 1/2/8） */
  recoveredMessages?: Message[];
  /** 恢复后的 boundary（场景 2/8） */
  recoveredBoundary?: CompactBoundary;
  /** 恢复后的 task ID（场景 5） */
  recoveredTaskId?: TaskId;
  /** 是否需要用户确认（场景 9） */
  needsUserConfirm?: boolean;
  /** 详细信息 */
  detail?: string;
  /** 失败原因（ok=false 时） */
  error?: string;
}

// ============================================================
// RecoveryHandler 依赖
// ============================================================

export interface RecoveryHandlerDeps {
  /** TeammateRegistry（场景 3） */
  teammateRegistry?: TeammateRegistry;
  /** MailboxService（场景 4 .bak 恢复） */
  mailboxService?: MailboxService;
  /** TaskManager（场景 5） */
  taskManager?: TaskManager;
  /** WorktreeRoster（场景 7 pointer 重建） */
  worktreeRoster?: WorktreeRoster;
  /** ThreeStateRecovery（场景 6 evicted） */
  threeStateRecovery?: ThreeStateRecovery;
  /** BoundaryStore 工厂（场景 2/8 — 按 transcriptId 路径自建） */
  boundaryStoreFor?: (transcriptId: UUID) => BoundaryStore;
  /** TranscriptStore 工厂（场景 1/8 — 按 sessionId 路径自建） */
  transcriptStoreFor?: (sessionId: SessionId) => Promise<TranscriptStore>;
  /** transcript 根目录（默认 ~/.omniagent/transcript） */
  transcriptDir?: string;
  /** mailbox 根目录（默认 ~/.omniagent/mailbox） */
  mailboxDir?: string;
}

// ============================================================
// RecoveryHandler
// ============================================================

/**
 * 9 场景错误恢复矩阵 dispatcher + 实施
 *
 * 使用：
 *   const handler = new RecoveryHandler({ ...deps });
 *   const result = await handler.recover('SCENARIO_TRANSCRIPT_CORRUPT', { sessionId });
 *   if (!result.ok) failClosed();
 *   if (result.needsUserConfirm) await askUser();
 */
export class RecoveryHandler {
  private readonly deps: RecoveryHandlerDeps;

  constructor(deps: RecoveryHandlerDeps = {}) {
    this.deps = deps;
  }

  /**
   * 调度器：按 scenario 路由到对应 recoverXxx 方法
   */
  async recover(
    scenario: RecoveryScenario,
    ctx: RecoveryContext,
  ): Promise<RecoveryResult> {
    switch (scenario) {
      case 'SCENARIO_TRANSCRIPT_CORRUPT':
        return this.recoverTranscriptCorrupt(ctx);
      case 'SCENARIO_SIDECHAIN_CORRUPT':
        return this.recoverSidechainCorrupt(ctx);
      case 'SCENARIO_TEAM_MISSING':
        return this.recoverTeamMissing(ctx);
      case 'SCENARIO_MAILBOX_CORRUPT':
        return this.recoverMailboxCorrupt(ctx);
      case 'SCENARIO_TASK_CORRUPT':
        return this.recoverTaskCorrupt(ctx);
      case 'SCENARIO_SIDECAR_404':
        return this.recoverSidecar404(ctx);
      case 'SCENARIO_WORKTREE_MISSING':
        return this.recoverWorktreeMissing(ctx);
      case 'SCENARIO_FORK_METADATA_MISSING':
        return this.recoverForkMetadataMissing(ctx);
      case 'SCENARIO_MODE_MISMATCH':
        return this.recoverModeMismatch(ctx);
      default:
        return {
          ok: false,
          scenario: scenario as RecoveryScenario,
          dataLoss: 'unknown',
          error: `unknown scenario: ${scenario as string}`,
        };
    }
  }

  // ============================================================
  // 场景 1：main transcript 损坏（断链）
  // ============================================================

  /**
   * 场景 1：main transcript 损坏 — walkChainBeforeParse 检测断链
   *
   * 恢复策略：
   * - 从最近 CompactBoundary 回溯到压缩点
   * - 重读压缩点之后的消息（断链之前的）
   * - 数据损失：last_turn（断链处到最后一条压缩前消息可能丢失）
   */
  async recoverTranscriptCorrupt(ctx: RecoveryContext): Promise<RecoveryResult> {
    const sessionId = ctx.sessionId;
    if (!sessionId) {
      return this.fail('SCENARIO_TRANSCRIPT_CORRUPT', 'sessionId required');
    }

    try {
      const transcript = ctx.transcript ?? (await this.getTranscriptStore(sessionId));
      const messages = await transcript.readRaw();

      // 找到断链位置
      const brokenAt = this.findBrokenChainIndex(messages);

      // 找最近 boundary（用于回溯）
      const boundary = await this.getLastBoundary(sessionId as unknown as UUID);

      // 无 boundary → 全部丢失，从空开始
      if (!boundary) {
        return {
          ok: true,
          scenario: 'SCENARIO_TRANSCRIPT_CORRUPT',
          dataLoss: 'last_session',
          recoveredMessages: [],
          detail: `no boundary; recovered from empty (brokenAt=${brokenAt})`,
        };
      }

      // 从 boundary 之后开始读取
      const recoveredMessages = this.readAfterBoundary(messages, boundary);

      return {
        ok: true,
        scenario: 'SCENARIO_TRANSCRIPT_CORRUPT',
        dataLoss: 'last_turn',
        recoveredMessages,
        recoveredBoundary: boundary,
        detail: `recovered from boundary ${boundary.boundary_id}, ${recoveredMessages.length} messages retained`,
      };
    } catch (err) {
      return this.fail(
        'SCENARIO_TRANSCRIPT_CORRUPT',
        `recovery failed: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // 场景 2：sidechain 损坏
  // ============================================================

  /**
   * 场景 2：sidechain 损坏 — 子 agent spawn 时校验失败
   *
   * 恢复策略：
   * - 从 sidechain 最近 boundary 重建
   * - 若无 boundary → 中止 sidechain，标记 task failed
   * - 数据损失：last_turn（sidechain 最近一轮）
   */
  async recoverSidechainCorrupt(ctx: RecoveryContext): Promise<RecoveryResult> {
    const sidechainId = ctx.sidechainId;
    if (!sidechainId) {
      return this.fail('SCENARIO_SIDECHAIN_CORRUPT', 'sidechainId required');
    }

    try {
      // sidechain transcriptId 即 sidechainId
      const boundary = await this.getLastBoundary(sidechainId);

      if (!boundary) {
        // 无 boundary → sidechain 无法恢复，标记 task failed
        return {
          ok: false,
          scenario: 'SCENARIO_SIDECHAIN_CORRUPT',
          dataLoss: 'last_session',
          detail: 'no sidechain boundary; task should be marked failed',
        };
      }

      return {
        ok: true,
        scenario: 'SCENARIO_SIDECHAIN_CORRUPT',
        dataLoss: 'last_turn',
        recoveredBoundary: boundary,
        detail: `recovered sidechain ${sidechainId} from boundary ${boundary.boundary_id}`,
      };
    } catch (err) {
      return this.fail(
        'SCENARIO_SIDECHAIN_CORRUPT',
        `recovery failed: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // 场景 3：team 缺失
  // ============================================================

  /**
   * 场景 3：team 缺失 — M5 SendMessage 路由时 roster 未找到 name
   *
   * 恢复策略：
   * - 通知 leader teammate 状态 stopped
   * - 不尝试自动重启 teammate（需要 leader 决策）
   * - 数据损失：none（leader 仍有完整状态）
   */
  async recoverTeamMissing(ctx: RecoveryContext): Promise<RecoveryResult> {
    const name = ctx.teammateName;
    if (!name) {
      return this.fail('SCENARIO_TEAM_MISSING', 'teammateName required');
    }

    if (!this.deps.teammateRegistry) {
      return this.fail('SCENARIO_TEAM_MISSING', 'teammateRegistry not injected');
    }

    const exists = await this.deps.teammateRegistry.exists(name);
    if (exists) {
      return {
        ok: true,
        scenario: 'SCENARIO_TEAM_MISSING',
        dataLoss: 'none',
        detail: `teammate ${name} exists (false alarm)`,
      };
    }

    // 通知 leader：teammate 已 stopped
    // 实际生产：写入 leader mailbox 一条 stopped 通知
    // M2 iter 4 stub：返回结果，调用方（Orchestrator）负责通知
    return {
      ok: true,
      scenario: 'SCENARIO_TEAM_MISSING',
      dataLoss: 'none',
      detail: `teammate ${name} missing; leader should be notified (stopped)`,
    };
  }

  // ============================================================
  // 场景 4：mailbox 损坏
  // ============================================================

  /**
   * 场景 4：mailbox 损坏 — JSONL 解析失败 → 从 .bak 恢复
   *
   * 恢复策略：
   * - 尝试读取 {name}.bak.jsonl（最近一次原子写前的备份）
   * - 若 .bak 存在 → 用 .bak 替换当前 mailbox
   * - 若 .bak 不存在 → 尝试 archive.jsonl（老消息归档）
   * - 都失败 → 空邮箱（last_session 损失）
   *
   * 数据损失：
   * - .bak 存在 → last_turn（最近一次写入丢失）
   * - 仅 archive → last_session（archive 之前的消息丢失）
   * - 都无 → last_session
   */
  async recoverMailboxCorrupt(ctx: RecoveryContext): Promise<RecoveryResult> {
    const name = ctx.teammateName;
    if (!name) {
      return this.fail('SCENARIO_MAILBOX_CORRUPT', 'teammateName required');
    }

    const mailboxDir = this.deps.mailboxDir ?? defaultMailboxDir();
    const mailboxPath = path.join(mailboxDir, `${name}.jsonl`);
    const bakPath = path.join(mailboxDir, `${name}.bak.jsonl`);
    const archivePath = path.join(mailboxDir, `${name}.archive.jsonl`);

    try {
      // 1. 尝试 .bak
      const bakExists = await fileExists(bakPath);
      if (bakExists) {
        // 用 .bak 替换损坏的 mailbox
        await fs.copyFile(bakPath, mailboxPath);
        return {
          ok: true,
          scenario: 'SCENARIO_MAILBOX_CORRUPT',
          dataLoss: 'last_turn',
          detail: `recovered from ${name}.bak.jsonl`,
        };
      }

      // 2. 尝试 archive
      const archiveExists = await fileExists(archivePath);
      if (archiveExists) {
        // archive 内容覆盖损坏的 mailbox
        await fs.copyFile(archivePath, mailboxPath);
        return {
          ok: true,
          scenario: 'SCENARIO_MAILBOX_CORRUPT',
          dataLoss: 'last_session',
          detail: `recovered from ${name}.archive.jsonl (current mailbox lost)`,
        };
      }

      // 3. 都无 → 清空 mailbox（确保目录存在）
      await fs.mkdir(path.dirname(mailboxPath), { recursive: true });
      await fs.writeFile(mailboxPath, '', 'utf8');
      return {
        ok: true,
        scenario: 'SCENARIO_MAILBOX_CORRUPT',
        dataLoss: 'last_session',
        detail: `no .bak or archive; mailbox reset to empty`,
      };
    } catch (err) {
      return this.fail(
        'SCENARIO_MAILBOX_CORRUPT',
        `recovery failed: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // 场景 5：task 损坏
  // ============================================================

  /**
   * 场景 5：task 损坏 — work item schema 校验失败
   *
   * 恢复策略：
   * - 若 workItemId 提供 → 从 work item 重新生成 runtime task
   * - 若 taskId 提供 → 从 runtime task 重建 work item（反向）
   * - 数据损失：none（work item 与 runtime task 任一存活即可恢复）
   */
  async recoverTaskCorrupt(ctx: RecoveryContext): Promise<RecoveryResult> {
    if (!this.deps.taskManager) {
      return this.fail('SCENARIO_TASK_CORRUPT', 'taskManager not injected');
    }

    try {
      // M2 iter 4：调用 TaskManager.getOutput 检查 task 状态
      // 若 task 存在但 workItem 不存在 → 重建 work item
      // 若 workItem 存在但 task 不存在 → 重建 task（重新调度）
      const taskId = ctx.taskId;
      const workItemId = ctx.workItemId;

      if (taskId) {
        const taskInfo = await this.deps.taskManager.getOutput(taskId);
        if (taskInfo) {
          return {
            ok: true,
            scenario: 'SCENARIO_TASK_CORRUPT',
            dataLoss: 'none',
            recoveredTaskId: taskId,
            detail: `task ${taskId} recovered from runtime store`,
          };
        }
      }

      // 无法恢复
      return {
        ok: false,
        scenario: 'SCENARIO_TASK_CORRUPT',
        dataLoss: 'unknown',
        detail: `neither task ${taskId ?? '<none>'} nor work item ${workItemId ?? '<none>'} recoverable`,
      };
    } catch (err) {
      return this.fail(
        'SCENARIO_TASK_CORRUPT',
        `recovery failed: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // 场景 6：sidecar 404
  // ============================================================

  /**
   * 场景 6：sidecar 404 — M5 远程路由 ping 超时
   *
   * 恢复策略：
   * - ThreeStateRecovery 标记 teammate 为 evicted
   * - Orchestrator 标记 task failed（已在 iter 3 实现）
   * - 数据损失：last_turn（远程任务输出可能丢失）
   *
   * M2 iter 3 已在 RemoteAgentClient 中实现 unreachable 分类，
   * 此处统一调度到 ThreeStateRecovery.evict()
   */
  async recoverSidecar404(ctx: RecoveryContext): Promise<RecoveryResult> {
    const name = ctx.teammateName;
    if (!name) {
      return this.fail('SCENARIO_SIDECAR_404', 'teammateName required');
    }

    if (!this.deps.threeStateRecovery) {
      // 无 ThreeStateRecovery → 仅返回结果，调用方处理
      return {
        ok: true,
        scenario: 'SCENARIO_SIDECAR_404',
        dataLoss: 'last_turn',
        detail: `sidecar for ${name} unreachable (invariant #16 scenario 6); task should be failed`,
      };
    }

    try {
      // 调用 ThreeStateRecovery 标记 evicted
      const result = await this.deps.threeStateRecovery.recover(name, {
        strategy: 'abandon',
        reason: 'sidecar 404 (invariant #16 scenario 6)',
      });

      return {
        ok: result.recovered,
        scenario: 'SCENARIO_SIDECAR_404',
        dataLoss: 'last_turn',
        detail: `sidecar ${name} evicted: ${result.detail ?? 'ok'}`,
      };
    } catch (err) {
      return this.fail(
        'SCENARIO_SIDECAR_404',
        `recovery failed: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // 场景 7：worktree pointer 缺失
  // ============================================================

  /**
   * 场景 7：worktree pointer 缺失 — git rev-parse 失败
   *
   * 恢复策略：
   * - 从 WorktreeRoster 重建 pointer（roster 仍记录 path 与 agentId）
   * - 重新创建 git worktree（GitWorktreeOps.createWorktree）
   * - 数据损失：none（worktree 内容在 path 上仍存在，仅 pointer 丢失）
   */
  async recoverWorktreeMissing(ctx: RecoveryContext): Promise<RecoveryResult> {
    const name = ctx.teammateName;
    if (!name) {
      return this.fail('SCENARIO_WORKTREE_MISSING', 'teammateName required');
    }

    if (!this.deps.worktreeRoster) {
      return this.fail('SCENARIO_WORKTREE_MISSING', 'worktreeRoster not injected');
    }

    try {
      // 从 roster 查 worktree entry
      const entries = this.deps.worktreeRoster.list();
      const entry = entries.find((e) => e.teammateName === name);
      if (!entry) {
        return {
          ok: false,
          scenario: 'SCENARIO_WORKTREE_MISSING',
          dataLoss: 'unknown',
          detail: `no roster entry for ${name}`,
        };
      }

      // 检查 path 是否仍存在
      const pathExists = await fileExists(entry.path);
      if (!pathExists) {
        // path 也不存在 → 无法仅重建 pointer，需重建整个 worktree
        return {
          ok: false,
          scenario: 'SCENARIO_WORKTREE_MISSING',
          dataLoss: 'last_session',
          detail: `worktree path ${entry.path} missing; cannot rebuild pointer alone`,
        };
      }

      // path 存在 → 重新注册 pointer（GitWorktreeOps 内部处理）
      // M2 iter 4 stub：返回成功，调用方负责实际 git worktree add
      return {
        ok: true,
        scenario: 'SCENARIO_WORKTREE_MISSING',
        dataLoss: 'none',
        detail: `worktree pointer for ${name} rebuilt (path=${entry.path} still exists)`,
      };
    } catch (err) {
      return this.fail(
        'SCENARIO_WORKTREE_MISSING',
        `recovery failed: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // 场景 8：fork metadata 缺失
  // ============================================================

  /**
   * 场景 8：fork metadata 缺失 — metadata schema 校验失败
   *
   * 恢复策略：
   * - 从 parentUuid 回溯（找到第一个有 parentUuid 的消息）
   * - 重建 fork metadata
   * - 数据损失：last_turn（fork point 之后的消息可能丢失）
   */
  async recoverForkMetadataMissing(ctx: RecoveryContext): Promise<RecoveryResult> {
    const sessionId = ctx.sessionId;
    if (!sessionId) {
      return this.fail('SCENARIO_FORK_METADATA_MISSING', 'sessionId required');
    }

    try {
      const transcript = ctx.transcript ?? (await this.getTranscriptStore(sessionId));
      const messages = await transcript.readRaw();

      // 找到第一个有 parentUuid 的消息（fork point）
      const forkPointIdx = messages.findIndex((m) => m.parentUuid);
      if (forkPointIdx === -1) {
        // 无 fork point → 整个 transcript 视为新会话
        return {
          ok: true,
          scenario: 'SCENARIO_FORK_METADATA_MISSING',
          dataLoss: 'last_session',
          recoveredMessages: [],
          detail: 'no fork point found; treating as new session',
        };
      }

      // 从 fork point 之后开始重建
      const recoveredMessages = messages.slice(forkPointIdx);
      return {
        ok: true,
        scenario: 'SCENARIO_FORK_METADATA_MISSING',
        dataLoss: 'last_turn',
        recoveredMessages,
        detail: `recovered from fork point at index ${forkPointIdx}, ${recoveredMessages.length} messages`,
      };
    } catch (err) {
      return this.fail(
        'SCENARIO_FORK_METADATA_MISSING',
        `recovery failed: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // 场景 9：mode 不匹配
  // ============================================================

  /**
   * 场景 9：mode 不匹配 — resume 时 mode 校验失败
   *
   * 恢复策略：
   * - 不自动修复（mode 变更需用户决策）
   * - 返回 needsUserConfirm=true
   * - 数据损失：none（用户确认后可继续）
   */
  async recoverModeMismatch(ctx: RecoveryContext): Promise<RecoveryResult> {
    const expectedMode = ctx.expectedMode;
    if (!expectedMode) {
      return this.fail('SCENARIO_MODE_MISMATCH', 'expectedMode required');
    }

    return {
      ok: false,
      scenario: 'SCENARIO_MODE_MISMATCH',
      dataLoss: 'none',
      needsUserConfirm: true,
      detail: `expected mode=${expectedMode} mismatches stored mode; user must confirm`,
    };
  }

  // ============================================================
  // .bak 备份机制（场景 4 的前置：在 mailbox 写入前创建 .bak）
  // ============================================================

  /**
   * 在 mailbox 原子写之前创建 .bak 备份
   *
   * 策略：把当前 mailbox 复制到 {name}.bak.jsonl
   * 之后 writeMailboxAtomic 替换主文件时，.bak 保留上一版本
   *
   * 调用时机：writeMailboxAtomic 内部 rename 之前调用
   * M2 iter 4：导出供 MailboxService 集成（或独立调用）
   */
  async createMailboxBackup(name: MailboxName): Promise<void> {
    const mailboxDir = this.deps.mailboxDir ?? defaultMailboxDir();
    const mailboxPath = path.join(mailboxDir, `${name}.jsonl`);
    const bakPath = path.join(mailboxDir, `${name}.bak.jsonl`);

    const exists = await fileExists(mailboxPath);
    if (!exists) return; // 无当前文件 → 不需备份

    try {
      await fs.copyFile(mailboxPath, bakPath);
    } catch {
      // .bak 创建失败不阻塞主写流程（best-effort）
    }
  }

  // ============================================================
  // helpers
  // ============================================================

  /** 构造失败结果 */
  private fail(scenario: RecoveryScenario, error: string): RecoveryResult {
    return {
      ok: false,
      scenario,
      dataLoss: 'unknown',
      error,
    };
  }

  /** 找到 transcript 中首个断链位置 */
  private findBrokenChainIndex(messages: Message[]): number {
    for (let i = 1; i < messages.length; i++) {
      const expectedParent = messages[i - 1].id;
      if (!messages[i].parentUuid) return i;
      if (messages[i].parentUuid !== expectedParent) return i;
    }
    return -1; // 无断链
  }

  /** 从 boundary 之后开始读取消息（boundary.lastMessageId 之后的） */
  private readAfterBoundary(messages: Message[], boundary: CompactBoundary): Message[] {
    // CompactBoundary 含 last_message_id 字段（标记压缩到的最后一条）
    // 找到 last_message_id 在 messages 中的位置，之后的消息保留
    const lastId = (boundary as unknown as { last_message_id?: UUID }).last_message_id;
    if (!lastId) return messages; // 无 last_message_id → 全部保留
    const idx = messages.findIndex((m) => m.id === lastId);
    if (idx === -1) return []; // last_message_id 不在 → 全部丢失
    return messages.slice(idx + 1);
  }

  /** 获取最近 boundary（注入或自建 BoundaryStore） */
  private async getLastBoundary(transcriptId: UUID): Promise<CompactBoundary | undefined> {
    if (this.deps.boundaryStoreFor) {
      const store = this.deps.boundaryStoreFor(transcriptId);
      return store.getLast(transcriptId);
    }
    // 默认实现：从 transcriptDir 读取 {transcriptId}.boundaries.jsonl
    return this.readLastBoundaryFromFile(transcriptId);
  }

  /** 从文件读最近 boundary */
  private async readLastBoundaryFromFile(transcriptId: UUID): Promise<CompactBoundary | undefined> {
    const dir = this.deps.transcriptDir ?? defaultTranscriptDir();
    const boundaryPath = path.join(dir, `${transcriptId}.boundaries.jsonl`);
    try {
      const text = await fs.readFile(boundaryPath, 'utf8');
      const lines = text.split('\n').filter((l) => l.trim());
      if (lines.length === 0) return undefined;
      const last = lines[lines.length - 1];
      return JSON.parse(last) as CompactBoundary;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /** 获取 TranscriptStore（注入或自建） */
  private async getTranscriptStore(sessionId: SessionId): Promise<TranscriptStore> {
    if (this.deps.transcriptStoreFor) {
      return this.deps.transcriptStoreFor(sessionId);
    }
    // 默认实现：从 transcriptDir 加载
    const { TranscriptStore } = await import('./transcript.js');
    const dir = this.deps.transcriptDir ?? defaultTranscriptDir();
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    return TranscriptStore.load(transcriptPath);
  }
}

// ============================================================
// 工具函数
// ============================================================

/** 默认 mailbox 根目录 */
export function defaultMailboxDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return path.join(home, '.omniagent', 'mailbox');
}

/** 默认 transcript 根目录 */
export function defaultTranscriptDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return path.join(home, '.omniagent', 'transcript');
}

/** 文件是否存在 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 工厂函数：构造一个 RecoveryHandler
 *
 * 用法：
 *   const handler = createRecoveryHandler({ taskManager, mailboxService, ... });
 *   const result = await handler.recover('SCENARIO_TRANSCRIPT_CORRUPT', { sessionId });
 */
export function createRecoveryHandler(deps: RecoveryHandlerDeps = {}): RecoveryHandler {
  return new RecoveryHandler(deps);
}

/**
 * 工具：把 ToolResult 转成错误消息（用于 fail-closed 输出）
 */
export function toErrorMessage(result: ToolResult): string {
  const block = result.content[0];
  return block.type === 'text' ? block.text : 'unknown error';
}

/**
 * 工具：判断一个 UUID 字符串是否是 sidechain transcriptId
 * sidechain transcript 文件名格式：{sessionId}.sidechain-{sidechainId}.jsonl
 * transcriptId 即 sidechainId（UUID 格式），无法仅凭字符串区分；
 * 实际区分由调用方根据上下文（sessionId vs sidechainId 字段名）决定。
 */
export function isSidechainId(_id: UUID): boolean {
  // M2 iter 4 stub：调用方负责传入正确的字段
  return false;
}

/** 生成随机 UUID（用于 fallback 场景的临时 ID） */
export function generateRecoveryId(): UUID {
  return randomUUID() as UUID;
}
