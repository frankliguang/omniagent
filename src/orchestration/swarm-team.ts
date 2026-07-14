/**
 * SwarmTeam（L3-M5 §2.2.5 — M2 iter 2）
 *
 * Teammate 路径入口：route=teammate 时由 Orchestrator 调用。
 *
 * 职责：
 * - 注册 teammate 到 TeammateRegistry（不变量 #2：name 唯一）
 * - 分配 worktree（不变量 #1：worktree 唯一归属）
 * - 启动 teammate ReActLoop（M2 iter 2 stub；iter 3+ 接入 SubAgentRunner / 独立进程）
 *
 * 不变量 #2 守护：
 * - teammate_name 必传（缺失抛错）
 * - register() 内部检测重复 name
 *
 * 不变量 #1 守护：
 * - worktreeRoster.assign() 内部检测 path 冲突
 * - 任一步骤失败需回滚（register 成功但 worktree 失败 → unregister）
 *
 * M2 iter 2 范围：
 * - joinTeam: register + worktree + 返回 task_id（不实际启动 sub-agent）
 * - sendMessage: 委托 MailboxService.send
 * - 实际 sub-agent ReActLoop 启动留 iter 3+（需 SubAgentRunner + 进程隔离）
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentId,
  MailboxMessage,
  MailboxName,
  TaskId,
  ToolResult,
  ToolUseId,
  TraceId,
} from '../types/index.js';
import type { MailboxService } from './mailbox-service.js';
import type { TeammateRegistry } from './teammate-registry.js';
import type { WorktreeRoster } from './worktree-roster.js';

// ============================================================
// 类型
// ============================================================

export interface JoinTeamParams {
  /** teammate 名称（按 name 寻址，不变量 #2） */
  teammateName: MailboxName;
  /** 父 agent 的 agentId（leader） */
  parentAgentId: AgentId;
  /** 运行时 task id（Orchestrator 创建，便于 task_output 查询） */
  runtimeTaskId: TaskId;
  /** trace id（贯穿调用链） */
  traceId: TraceId;
  /** 自定义 worktree 路径（测试用；默认自动生成） */
  worktreePath?: string;
  /** prompt（teammate 启动时的初始 prompt，iter 3+ 用） */
  prompt?: string;
}

export interface JoinTeamResult {
  /** teammate 的 agentId（随机生成） */
  agentId: AgentId;
  /** 分配的 worktree 路径 */
  worktreePath: string;
  /** runtimeTaskId（透传） */
  taskId: TaskId;
}

export interface SendMessageParams {
  to: MailboxName;
  from: AgentId | MailboxName;
  type: MailboxMessage['type'];
  payload: unknown;
}

// ============================================================
// SwarmTeam
// ============================================================

export class SwarmTeam {
  constructor(
    private readonly mailbox: MailboxService,
    private readonly teammateRegistry: TeammateRegistry,
    private readonly worktreeRoster: WorktreeRoster,
  ) {}

  /**
   * 加入 Swarm Team（route=teammate）
   *
   * 步骤：
   * 1. 校验 teammate_name 必传
   * 2. 生成 teammate agentId
   * 3. 注册 teammate（不变量 #2）
   * 4. 分配 worktree（不变量 #1）
   * 5. 失败回滚：worktree 失败 → unregister
   * 6. 返回结果
   *
   * 不实际启动 sub-agent ReActLoop（iter 3+）
   */
  async joinTeam(params: JoinTeamParams): Promise<JoinTeamResult> {
    if (!params.teammateName) {
      throw new Error('teammate_name required for route=teammate (invariant #2: name addressing)');
    }

    // 1. 生成 teammate agentId
    const teammateAgentId = randomUUID() as AgentId;

    // 2. 注册 teammate
    try {
      await this.teammateRegistry.register({
        name: params.teammateName,
        agentId: teammateAgentId,
        parentAgentId: params.parentAgentId,
      });
    } catch (err) {
      // register 失败 → 直接抛错（不变量 #2 违反）
      throw err;
    }

    // 3. 分配 worktree（失败时回滚 registry）
    let worktreePath: string;
    try {
      const wt = await this.worktreeRoster.assign({
        teammateName: params.teammateName,
        agentId: teammateAgentId,
        worktreePath: params.worktreePath,
      });
      worktreePath = wt.path;
    } catch (err) {
      // 回滚 registry
      await this.teammateRegistry.unregister(params.teammateName).catch(() => {});
      throw err;
    }

    // 4. (iter 3+) 启动 teammate ReActLoop
    // 当前 stub：不实际启动 sub-agent
    // teammate 通信通过 mailbox（leader → send_message → teammate mailbox → teammate 轮询读取）

    return {
      agentId: teammateAgentId,
      worktreePath,
      taskId: params.runtimeTaskId,
    };
  }

  /**
   * 给 teammate 发消息（leader 用）
   *
   * 委托 MailboxService.send，写失败抛错。
   */
  async sendMessage(params: SendMessageParams): Promise<void> {
    const result = await this.mailbox.send(params);
    if (!result.written) {
      throw new Error(`mailbox write to "${params.to}" failed: ${result.error}`);
    }
  }

  /** 解除 teammate 注册（shutdown 完成后调用） */
  async leaveTeam(teammateName: MailboxName): Promise<void> {
    await this.worktreeRoster.release(teammateName);
    await this.teammateRegistry.unregister(teammateName);
  }

  /**
   * 把 JoinTeamResult 转换为 ToolResult（Orchestrator 用）
   */
  toToolResult(
    params: JoinTeamParams,
    result: JoinTeamResult,
    toolUseId: ToolUseId = '' as ToolUseId,
  ): ToolResult {
    return {
      tool_use_id: toolUseId,
      content: [{
        type: 'text',
        text: `teammate "${params.teammateName}" joined at worktree ${result.worktreePath} (task_id=${result.taskId})`,
      }],
      is_error: false,
      metadata: { duration_ms: 0, compactable: false },
    };
  }
}
