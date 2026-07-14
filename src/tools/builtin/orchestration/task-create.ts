/**
 * TaskCreateTool（L3-M5 §5.1 — task_create, M2 iter 2）
 *
 * LLM 调用：
 *   task_create(route="teammate", teammate_name="alice", prompt="refactor module X")
 *
 * 职责：
 * - 创建 WorkItem + RuntimeTask 双轨（TaskManager.createDualTrack）
 * - teammate 路径：调用 SwarmTeam.joinTeam（注册 teammate + 分配 worktree）
 * - 返回 task_id + work_item_id + agent_id + worktree_path
 *
 * 与 agent_router 区别：
 * - agent_router 用于 sync/async/fork 路径（内部 spawn）
 * - task_create 主要用于 teammate 路径（外部 sub-agent，按 name 寻址）
 *
 * 不变量 #2（按 name 寻址）：
 * - teammate 路径必须传 teammate_name（缺失返回错误）
 * - teammate_name 重复由 TeammateRegistry.register 检测
 *
 * 不变量 #1（worktree 唯一归属）：
 * - worktree 分配由 WorktreeRoster.assign 保证
 * - worktree 失败时回滚 registry（SwarmTeam.joinTeam 内部处理）
 *
 * M2 iter 2 范围：
 * - teammate 路径完整支持（register + worktree）
 * - 实际 sub-agent ReActLoop 启动留 iter 3+（SwarmTeam 当前 stub）
 */

import type {
  AgentId,
  MailboxName,
  PermissionDecision,
  TaskId,
  Tool,
  ToolInput,
  ToolResult,
  ToolUseId,
  TraceId,
} from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';
import type { TaskManager } from '../../../orchestration/task-manager.js';
import type { SwarmTeam } from '../../../orchestration/swarm-team.js';

/** 构造依赖 */
export interface TaskCreateToolDeps {
  taskManager: TaskManager;
  /** teammate 路径入口（注入；若不提供则 teammate 路径抛错） */
  swarmTeam?: SwarmTeam;
  /** 父 agent 的 agentId */
  parentAgentId: () => AgentId;
  /** trace id 生成器（默认 randomUUID） */
  traceIdGen?: () => TraceId;
}

export function createTaskCreateTool(deps: TaskCreateToolDeps): Tool {
  return buildTool({
    name: 'task_create',
    description:
      'Create a runtime task. For route=teammate, registers a teammate (by name, invariant #2) ' +
      'and assigns a worktree (invariant #1). Returns {task_id, work_item_id, agent_id, worktree_path}. ' +
      'Unlike agent_router (sync/async/fork), task_create with teammate route is for spawning external ' +
      'sub-agents addressed by name. Use send_message to communicate with the teammate after creation.',
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          enum: ['teammate'],
          description: 'Routing mode. M2 iter 2: only "teammate" (sync/async/fork use agent_router).',
        },
        teammate_name: {
          type: 'string',
          description: 'Teammate name (MailboxName). Required for route=teammate (invariant #2: name addressing). Must be unique across the team.',
        },
        prompt: {
          type: 'string',
          description: 'Initial prompt for the teammate (used when ReActLoop starts in iter 3+).',
        },
        tools_whitelist: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tools allowed for the teammate (default: inherit parent tools).',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Task timeout in milliseconds (default: provider-specific).',
          minimum: 1000,
        },
      },
      required: ['route', 'teammate_name', 'prompt'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,  // 注册 teammate + 分配 worktree（共享状态）
    isBackground: false,

    checkPermissions(_input: ToolInput): PermissionDecision {
      // task_create 创建外部 sub-agent，M2 stub：allow
      // M3 完整版：默认 ask（涉及子 agent 执行）
      return { decision: 'allow', matchedRule: 'm2-stub', layer: 2 };
    },

    async call(input: ToolInput, ctx): Promise<ToolResult> {
      const startMs = Date.now();
      const toolUseId = (ctx?.toolUseId ?? ('' as ToolUseId)) as ToolUseId;
      const route = input.route as string;
      const teammateName = input.teammate_name as string;
      const prompt = input.prompt as string;

      if (!route) {
        return errorResult(toolUseId, 'task_create: route is required', { duration_ms: Date.now() - startMs });
      }
      if (route !== 'teammate') {
        return errorResult(
          toolUseId,
          `task_create: route "${route}" not supported (M2 iter 2 only teammate; for sync/async/fork use agent_router)`,
          { duration_ms: Date.now() - startMs },
        );
      }
      if (!teammateName) {
        return errorResult(
          toolUseId,
          'task_create: teammate_name is required for route=teammate (invariant #2: name addressing)',
          { duration_ms: Date.now() - startMs },
        );
      }
      if (!prompt) {
        return errorResult(toolUseId, 'task_create: prompt is required', { duration_ms: Date.now() - startMs });
      }
      if (!deps.swarmTeam) {
        return errorResult(
          toolUseId,
          'task_create: swarmTeam not injected (teammate route unavailable)',
          { duration_ms: Date.now() - startMs },
        );
      }

      const parentAgentId = deps.parentAgentId();
      const traceId = (deps.traceIdGen ?? (() => crypto.randomUUID() as TraceId))();

      // 1. 创建 WorkItem + RuntimeTask 双轨
      let dualTrack: { workItemId: string; runtimeTaskId: TaskId };
      try {
        dualTrack = await deps.taskManager.createDualTrack({
          route: 'teammate',
          prompt,
          parentAgentId: parentAgentId as string,
          toolsWhitelist: input.tools_whitelist as string[] | undefined,
          timeoutMs: input.timeout_ms as number | undefined,
        });
      } catch (err) {
        return errorResult(
          toolUseId,
          `task_create: failed to create dual-track: ${(err as Error).message}`,
          { duration_ms: Date.now() - startMs },
        );
      }

      // 2. joinTeam：register teammate + assign worktree
      try {
        const joinResult = await deps.swarmTeam.joinTeam({
          teammateName: teammateName as MailboxName,
          parentAgentId,
          runtimeTaskId: dualTrack.runtimeTaskId,
          traceId,
          prompt,
        });

        const summary = JSON.stringify({
          task_id: dualTrack.runtimeTaskId,
          work_item_id: dualTrack.workItemId,
          agent_id: joinResult.agentId,
          worktree_path: joinResult.worktreePath,
          teammate_name: teammateName,
        });

        return okResult(
          toolUseId,
          `task_create: teammate "${teammateName}" joined team.\n\n${summary}\n\n` +
            `Use send_message(to="${teammateName}", ...) to deliver work. ` +
            `Use task_output(task_id="${dualTrack.runtimeTaskId}") to read status.`,
          { compactable: false, duration_ms: Date.now() - startMs },
        );
      } catch (err) {
        // joinTeam 失败 → 标记 task failed
        await deps.taskManager.failTask(
          dualTrack.runtimeTaskId,
          `joinTeam failed: ${(err as Error).message}`,
        ).catch(() => {});

        return errorResult(
          toolUseId,
          `task_create: joinTeam failed for "${teammateName}": ${(err as Error).message}`,
          { duration_ms: Date.now() - startMs },
        );
      }
    },
  });
}
