/**
 * TaskStopTool（L3-M5 §5.1 — task_stop, M2 iter 2）
 *
 * LLM 调用：
 *   task_stop(task_id="task_001", strategy="graceful")  // 走 ShutdownHandshake 四步握手
 *   task_stop(task_id="task_001", strategy="force", reason="budget_exceeded")  // 走 abandon
 *
 * 职责：
 * - graceful: 发起 ShutdownHandshake（leader 发 request → teammate response → 清理 / 继续）
 *   - approve=true → 触发 cleanup，task 标记 completed
 *   - approve=false (pending work) → task 继续运行，返回 reject 信息（不强杀，不变量 #6）
 *   - 超时（30s 默认）→ 标记 task timeout，不强杀
 * - force: 调用 ThreeStateRecovery.recover('abandon')
 *   - 注销 teammate registry + 释放 worktree + task 标记 failed
 *   - 不走握手，立即清理（仅在 teammate 无响应 / budget 超限时用）
 *
 * 不变量 #6（优雅退出，不强杀）：
 * - graceful 路径只发 shutdown_request，不 kill 进程
 * - 超时仅标记 timeout，不强杀
 * - force 路径用于已确认 teammate 无响应的场景（进程已死 + mailbox 无未读）
 *
 * M2 iter 2 范围：
 * - graceful 完整四步握手（依赖 ShutdownHandshake）
 * - force 走 abandon（依赖 ThreeStateRecovery）
 * - 不实现 restart 路径（iter 3+ 接入 SubAgentRunner）
 */

import type {
  MailboxName,
  PermissionDecision,
  TaskId,
  Tool,
  ToolInput,
  ToolResult,
  ToolUseId,
} from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';
import type { TaskManager } from '../../../orchestration/task-manager.js';
import type { ShutdownHandshake } from '../../../orchestration/shutdown-handshake.js';
import type { ThreeStateRecovery } from '../../../orchestration/three-state-recovery.js';
import type { TeammateRegistry } from '../../../orchestration/teammate-registry.js';
import type { SwarmTeam } from '../../../orchestration/swarm-team.js';

/** 构造依赖 */
export interface TaskStopToolDeps {
  taskManager: TaskManager;
  /** 握手器（graceful 路径用） */
  shutdownHandshake?: ShutdownHandshake;
  /** 三态恢复（force 路径用） */
  threeStateRecovery?: ThreeStateRecovery;
  /** teammate registry（task_id → teammate_name 解析；可选） */
  teammateRegistry?: TeammateRegistry;
  /** Swarm Team 句柄（graceful approve 后清理 worktree + 注销 teammate） */
  swarmTeam?: SwarmTeam;
  /** 父 agent 的 agentId（leader，发起 shutdown_request） */
  parentAgentId: () => string;
  /** leader 的 mailbox name（接收 shutdown_response） */
  leaderName: () => MailboxName;
  /** 默认握手超时（ms，默认 30000） */
  defaultTimeoutMs?: number;
}

export function createTaskStopTool(deps: TaskStopToolDeps): Tool {
  return buildTool({
    name: 'task_stop',
    description:
      'Stop a running task. strategy=graceful initiates 4-step handshake (shutdown_request → response → cleanup/continue); ' +
      'does NOT kill the process (invariant #6). strategy=force abandons the teammate (unregister + release worktree + mark task failed); ' +
      'use only when teammate is unresponsive. Returns {strategy, status, recovered, approve?, reason?}.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The runtime task ID to stop (returned by task_create or agent_router).',
        },
        strategy: {
          type: 'string',
          enum: ['graceful', 'force'],
          description: 'graceful: 4-step handshake (default). force: abandon teammate immediately.',
        },
        teammate_name: {
          type: 'string',
          description: 'Teammate name. Required for graceful (to send shutdown_request). For force, resolved from registry if omitted.',
        },
        reason: {
          type: 'string',
          description: 'Reason for stopping (e.g. user_exit, budget_exceeded, abort_signal). Recorded in task error.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Handshake timeout in ms (graceful only, default 30000).',
          minimum: 1000,
        },
      },
      required: ['task_id', 'strategy'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isDestructive: true,  // task_stop 可能 abandon teammate（释放 worktree + 注销 registry）
    isConcurrencySafe: false,
    isBackground: false,

    checkPermissions(_input: ToolInput): PermissionDecision {
      // task_stop 涉及终止 sub-agent（不可逆），M2 stub：allow
      // M3 完整版：默认 ask（destructive 操作）
      return { decision: 'allow', matchedRule: 'm2-stub', layer: 2 };
    },

    async call(input: ToolInput, ctx): Promise<ToolResult> {
      const startMs = Date.now();
      const toolUseId = (ctx?.toolUseId ?? ('' as ToolUseId)) as ToolUseId;
      const taskId = input.task_id as string;
      const strategy = input.strategy as string;
      const teammateNameRaw = input.teammate_name as string | undefined;
      const reason = (input.reason as string | undefined) ?? 'user_shutdown';
      const timeoutMs = (input.timeout_ms as number | undefined) ?? deps.defaultTimeoutMs ?? 30_000;

      if (!taskId) {
        return errorResult(toolUseId, 'task_stop: task_id is required', { duration_ms: Date.now() - startMs });
      }
      if (strategy !== 'graceful' && strategy !== 'force') {
        return errorResult(
          toolUseId,
          `task_stop: strategy must be "graceful" or "force" (got "${strategy}")`,
          { duration_ms: Date.now() - startMs },
        );
      }

      // 1. 校验 task 存在
      const taskOutput = await deps.taskManager.getOutput(taskId as TaskId);
      if (!taskOutput) {
        return errorResult(
          toolUseId,
          `task_stop: task not found: ${taskId}`,
          { duration_ms: Date.now() - startMs },
        );
      }
      if (taskOutput.status !== 'running') {
        return okResult(
          toolUseId,
          `task_stop: task ${taskId} already in status=${taskOutput.status} (no action)`,
          { compactable: true, duration_ms: Date.now() - startMs },
        );
      }

      // 2. teammate_name 必须显式传入（graceful 和 force 均需要，避免歧义）
      const teammateName: string | undefined = teammateNameRaw;
      void deps.teammateRegistry; // 保留为依赖，iter 3+ 扩展 task_id → teammate_name 反查

      // 3. 分发
      if (strategy === 'graceful') {
        return await gracefulStop({
          deps, toolUseId, taskId, teammateName, reason, timeoutMs, startMs,
        });
      } else {
        return await forceStop({
          deps, toolUseId, taskId, teammateName, reason, startMs,
        });
      }
    },
  });
}

// ============================================================
// graceful 路径
// ============================================================

async function gracefulStop(params: {
  deps: TaskStopToolDeps;
  toolUseId: ToolUseId;
  taskId: string;
  teammateName?: string;
  reason: string;
  timeoutMs: number;
  startMs: number;
}): Promise<ToolResult> {
  const { deps, toolUseId, taskId, teammateName, reason, timeoutMs, startMs } = params;

  if (!deps.shutdownHandshake) {
    return errorResult(
      toolUseId,
      'task_stop: shutdownHandshake not injected (graceful strategy unavailable)',
      { duration_ms: Date.now() - startMs },
    );
  }
  if (!teammateName) {
    return errorResult(
      toolUseId,
      'task_stop: teammate_name is required for graceful strategy (could not resolve from registry)',
      { duration_ms: Date.now() - startMs },
    );
  }

  // 1. leader 发 shutdown_request
  try {
    await deps.shutdownHandshake.sendRequest(
      teammateName as MailboxName,
      {
        agentId: deps.parentAgentId() as never,
        leaderName: deps.leaderName(),
        reason,
      },
    );
  } catch (err) {
    await deps.taskManager.failTask(
      taskId as TaskId,
      `graceful stop failed (sendRequest): ${(err as Error).message}`,
    ).catch(() => {});
    return errorResult(
      toolUseId,
      `task_stop: sendRequest failed: ${(err as Error).message}`,
      { duration_ms: Date.now() - startMs },
    );
  }

  // 2. 等待 teammate 回 response（轮询 leader mailbox）
  try {
    const response = await deps.shutdownHandshake.waitForResponse(
      teammateName as MailboxName,
      timeoutMs,
    );

    if (response.approve) {
      // approve → 触发 cleanup（不变量 #6：不强杀，但需释放 worktree + 注销 teammate）
      // M2 iter 5：调 swarmTeam.leaveTeam 释放 worktree + unregister registry
      let cleanupError: string | undefined;
      if (deps.swarmTeam && teammateName) {
        try {
          await deps.swarmTeam.leaveTeam(teammateName as MailboxName);
        } catch (err) {
          cleanupError = (err as Error).message;
        }
      }
      // 标记 task completed
      await deps.taskManager.completeTask(taskId as TaskId).catch(() => {});

      const summary = JSON.stringify({
        strategy: 'graceful',
        task_id: taskId,
        teammate_name: teammateName,
        approve: true,
        reason: response.reason,
        state: deps.shutdownHandshake.getRecord(teammateName as MailboxName)?.state,
        cleanup: cleanupError ? { ok: false, error: cleanupError } : { ok: true },
      });

      return okResult(
        toolUseId,
        `task_stop: graceful shutdown approved by "${teammateName}".\n\n${summary}`,
        { compactable: false, duration_ms: Date.now() - startMs },
      );
    } else {
      // reject (pending_work) → task 继续运行，不强杀（不变量 #6）
      const summary = JSON.stringify({
        strategy: 'graceful',
        task_id: taskId,
        teammate_name: teammateName,
        approve: false,
        reason: response.reason,
        state: deps.shutdownHandshake.getRecord(teammateName as MailboxName)?.state,
      });

      return okResult(
        toolUseId,
        `task_stop: graceful shutdown REJECTED by "${teammateName}" (pending work). Task continues to run. ` +
          `Wait for teammate to finish or use strategy="force" to abandon.\n\n${summary}`,
        { compactable: false, duration_ms: Date.now() - startMs },
      );
    }
  } catch (err) {
    // 超时（不变量 #6：不强杀）
    await deps.taskManager.failTask(
      taskId as TaskId,
      `graceful stop timeout (${timeoutMs}ms): ${(err as Error).message}`,
    ).catch(() => {});

    const state = deps.shutdownHandshake.getRecord(teammateName as MailboxName)?.state;
    return errorResult(
      toolUseId,
      `task_stop: graceful shutdown timed out (${timeoutMs}ms, state=${state}). ` +
        `Task marked failed (invariant #6: no force kill). Consider strategy="force" to abandon.`,
      { duration_ms: Date.now() - startMs },
    );
  }
}

// ============================================================
// force 路径
// ============================================================

async function forceStop(params: {
  deps: TaskStopToolDeps;
  toolUseId: ToolUseId;
  taskId: string;
  teammateName?: string;
  reason: string;
  startMs: number;
}): Promise<ToolResult> {
  const { deps, toolUseId, taskId, teammateName, reason, startMs } = params;

  if (!deps.threeStateRecovery) {
    return errorResult(
      toolUseId,
      'task_stop: threeStateRecovery not injected (force strategy unavailable)',
      { duration_ms: Date.now() - startMs },
    );
  }
  if (!teammateName) {
    return errorResult(
      toolUseId,
      'task_stop: teammate_name is required for force strategy (could not resolve from registry)',
      { duration_ms: Date.now() - startMs },
    );
  }

  // 调用 ThreeStateRecovery.recover('abandon')
  // 内部：release worktree + unregister registry + 标记 task failed
  try {
    const result = await deps.threeStateRecovery.recover(
      teammateName as MailboxName,
      { strategy: 'abandon', reason },
    );

    // 标记 task failed（ThreeStateRecovery 当前不直接修改 task，由本工具统一处理）
    await deps.taskManager.failTask(
      taskId as TaskId,
      `force stop: ${reason} (teammate "${teammateName}" abandoned, status=${result.status})`,
    ).catch(() => {});

    const summary = JSON.stringify({
      strategy: 'force',
      task_id: taskId,
      teammate_name: teammateName,
      recovered: result.recovered,
      status: result.status,
      detail: result.detail,
      reason,
    });

    return okResult(
      toolUseId,
      `task_stop: force abandoned "${teammateName}".\n\n${summary}`,
      { compactable: false, duration_ms: Date.now() - startMs },
    );
  } catch (err) {
    await deps.taskManager.failTask(
      taskId as TaskId,
      `force stop error: ${(err as Error).message}`,
    ).catch(() => {});

    return errorResult(
      toolUseId,
      `task_stop: force abandon failed for "${teammateName}": ${(err as Error).message}`,
      { duration_ms: Date.now() - startMs },
    );
  }
}
