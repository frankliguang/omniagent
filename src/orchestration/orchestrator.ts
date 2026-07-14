/**
 * Orchestrator（L3-M5 §2.2.1 — M2 iter 1 + iter 2）
 *
 * 主入口：agent_router 工具调用 → Orchestrator.route() → 按 route 分发
 *
 * M2 iter 1 范围：
 * - sync 路径：阻塞主对话，等子 agent 完成
 * - async 路径：立即返回 task_id，后台 spawn
 * - fork 路径：继承父上下文 + 独立 sidechain + prompt cache prefix byte-identical
 *
 * M2 iter 2 范围：
 * - teammate 路径：SwarmTeam.joinTeam（register + worktree，不实际 spawn sub-agent）
 *
 * M2 iter 3+ 范围：
 * - remote 路径：SSH 远程 OmniAgent
 * - teammate 实际 sub-agent ReActLoop 启动（SubAgentRunner）
 */

import type {
  AgentId,
  AgentRouterParams,
  AgentRouterResult,
  MailboxName,
  TaskId,
  ToolResult,
  ToolUseId,
  TraceId,
} from '../types/index.js';
import type { TaskManager } from './task-manager.js';
import type { SidechainManager, MemoryEngine } from '../memory/sidechain.js';
import { CoordinatorMode } from './coordinator-mode.js';
import { ForkAgentSpawner } from './fork-agent-spawner.js';
import type { SubAgentRunnerFactory } from './sub-agent-runner.js';
import type { SwarmTeam } from './swarm-team.js';
import type { RemoteAgentClient } from './remote-agent-client.js';

/** Orchestrator 依赖 */
export interface OrchestratorDeps {
  taskManager: TaskManager;
  sidechain: SidechainManager;
  memoryEngine: MemoryEngine;
  runnerFactory: SubAgentRunnerFactory;
  /** teammate 路径入口（M2 iter 2；可选，未注入则 teammate 路径返回 error） */
  swarmTeam?: SwarmTeam;
  /** remote 路径入口（M2 iter 3；可选，未注入则 remote 路径返回 error） */
  remoteAgentClient?: RemoteAgentClient;
}

/** route() 参数（AgentRouterParams + 运行时注入字段） */
export interface RouteParams extends AgentRouterParams {
  parentAgentId: AgentId;
  traceId: TraceId;
}

/** 错误 ToolResult 构造 */
function toErrorResult(err: Error, toolUseId: ToolUseId = '' as ToolUseId): ToolResult {
  return {
    tool_use_id: toolUseId,
    content: [{ type: 'text', text: err.message }],
    is_error: true,
  };
}

/** 从 ToolResult 提取文本（用于 failTask 的 error message） */
function getTextFromResult(result: ToolResult): string {
  const block = result.content[0];
  return block.type === 'text' ? block.text : 'unknown error';
}

export class Orchestrator {
  private readonly coordinator: CoordinatorMode;
  private readonly fork: ForkAgentSpawner;

  constructor(private readonly deps: OrchestratorDeps) {
    this.coordinator = new CoordinatorMode(
      deps.sidechain,
      deps.taskManager,
      deps.runnerFactory,
    );
    this.fork = new ForkAgentSpawner({
      sidechain: deps.sidechain,
      memoryEngine: deps.memoryEngine,
      runnerFactory: deps.runnerFactory,
      taskManager: deps.taskManager,
    });
  }

  /**
   * agent_router 工具入口
   *
   * 1. 创建 WorkItem + RuntimeTask（双轨）
   * 2. 按 route 分发到 sync/async/fork/teammate 路径
   * 3. 标记 RuntimeTask completed/failed（async/teammate 路径保持 running）
   * 4. 返回 AgentRouterResult
   */
  async route(params: RouteParams): Promise<AgentRouterResult> {
    // 校验 route 合法性
    const supportedRoutes = ['sync', 'async', 'fork', 'teammate', 'remote'];
    if (!supportedRoutes.includes(params.route)) {
      const { workItemId, runtimeTaskId } = await this.deps.taskManager.createDualTrack({
        route: params.route,
        prompt: params.prompt,
        parentAgentId: params.parentAgentId,
      });
      await this.deps.taskManager.failTask(runtimeTaskId, `unsupported route: ${params.route}`);
      return {
        task_id: runtimeTaskId,
        work_item_id: workItemId,
        status: 'failed',
      };
    }

    // 1. 创建 WorkItem + RuntimeTask
    const { workItemId, runtimeTaskId } = await this.deps.taskManager.createDualTrack({
      route: params.route,
      prompt: params.prompt,
      parentAgentId: params.parentAgentId,
      toolsWhitelist: params.tools_whitelist,
      timeoutMs: params.timeout_ms,
    });

    // 2. 按 route 分发
    try {
      let result: ToolResult | undefined;
      const runtimeParams = {
        route: params.route as 'sync' | 'async' | 'fork',
        prompt: params.prompt,
        runtimeTaskId,
        parentAgentId: params.parentAgentId,
        toolsWhitelist: params.tools_whitelist,
        timeoutMs: params.timeout_ms,
      };

      switch (params.route) {
        case 'sync':
          result = await this.coordinator.spawnSync(runtimeParams);
          break;
        case 'async':
          result = await this.coordinator.spawnAsync(runtimeParams);
          break;
        case 'fork':
          result = await this.fork.spawn({
            prompt: params.prompt,
            runtimeTaskId,
            parentAgentId: params.parentAgentId,
            toolsWhitelist: params.tools_whitelist,
            timeoutMs: params.timeout_ms,
          });
          break;
        case 'teammate':
          // teammate 路径：注册 teammate + 分配 worktree，不实际 spawn（iter 3+）
          result = await this.spawnTeammate({
            teammateName: params.teammate_name,
            runtimeTaskId,
            parentAgentId: params.parentAgentId,
            traceId: params.traceId,
            prompt: params.prompt,
          });
          break;
        case 'remote':
          // remote 路径：SSH 远程委托（iter 3）
          result = await this.spawnRemote({
            remoteTarget: params.remote_target,
            prompt: params.prompt,
            runtimeTaskId,
            timeoutMs: params.timeout_ms,
            toolsWhitelist: params.tools_whitelist,
          });
          break;
      }

      // async/teammate 路径不在此标记 completed（teammate 后台运行，通过 mailbox 通信）
      // 但 teammate 路径若返回 is_error=true（如 teammate_name 缺失 / swarmTeam 未注入），
      // 应标记 failed 而非保持 running
      // remote 路径若返回 is_error=true（unreachable/timeout/exit!=0），同样标记 failed
      const isAsyncLike = params.route === 'async' || params.route === 'teammate';
      if (!isAsyncLike) {
        if (result?.is_error) {
          // remote 路径 unreachable/timeout/exit!=0 → task failed
          await this.deps.taskManager.failTask(runtimeTaskId, getTextFromResult(result));
        } else {
          await this.deps.taskManager.completeTask(runtimeTaskId, result);
        }
      } else if (params.route === 'teammate' && result?.is_error) {
        await this.deps.taskManager.failTask(runtimeTaskId, getTextFromResult(result));
      }

      let status: AgentRouterResult['status'];
      if (result?.is_error) {
        // teammate / remote 路径返回错误 → failed
        status = 'failed';
      } else if (params.route === 'async' || params.route === 'teammate') {
        status = 'running';
      } else {
        status = 'completed';
      }
      return {
        task_id: runtimeTaskId,
        work_item_id: workItemId,
        status,
        result,
      };
    } catch (err) {
      await this.deps.taskManager.failTask(runtimeTaskId, (err as Error).message);
      return {
        task_id: runtimeTaskId,
        work_item_id: workItemId,
        status: 'failed',
        result: toErrorResult(err as Error),
      };
    }
  }

  /** 读取 task 输出（task_output 工具调用转发） */
  async getTaskOutput(taskId: TaskId): Promise<unknown> {
    return this.deps.taskManager.getOutput(taskId);
  }

  // ============================================================
  // teammate 路径（M2 iter 2）
  // ============================================================

  /**
   * teammate 路径：注册 teammate + 分配 worktree
   *
   * 不变量 #2（按 name 寻址）：
   * - teammate_name 必传（缺失返回错误 ToolResult）
   * - SwarmTeam.joinTeam 内部检测重复 name
   *
   * 不变量 #1（worktree 唯一归属）：
   * - SwarmTeam.joinTeam 内部检测 path 冲突
   * - 失败时回滚 registry（joinTeam 内部处理）
   *
   * M2 iter 2: 不实际启动 sub-agent ReActLoop
   * iter 3+: 接入 SubAgentRunner 启动独立进程
   */
  private async spawnTeammate(params: {
    teammateName?: MailboxName;
    runtimeTaskId: TaskId;
    parentAgentId: AgentId;
    traceId: TraceId;
    prompt: string;
  }): Promise<ToolResult> {
    if (!this.deps.swarmTeam) {
      return {
        tool_use_id: '' as ToolUseId,
        content: [{ type: 'text', text: 'teammate route unavailable: swarmTeam not injected' }],
        is_error: true,
      };
    }
    if (!params.teammateName) {
      return {
        tool_use_id: '' as ToolUseId,
        content: [{ type: 'text', text: 'teammate route requires teammate_name (invariant #2: name addressing)' }],
        is_error: true,
      };
    }

    const joinResult = await this.deps.swarmTeam.joinTeam({
      teammateName: params.teammateName,
      parentAgentId: params.parentAgentId,
      runtimeTaskId: params.runtimeTaskId,
      traceId: params.traceId,
      prompt: params.prompt,
    });

    return {
      tool_use_id: '' as ToolUseId,
      content: [{
        type: 'text',
        text: `teammate "${params.teammateName}" joined at worktree ${joinResult.worktreePath} (task_id=${params.runtimeTaskId}, agent_id=${joinResult.agentId})`,
      }],
      is_error: false,
      metadata: { duration_ms: 0, compactable: false },
    };
  }

  // ============================================================
  // remote 路径（M2 iter 3）
  // ============================================================

  /**
   * remote 路径：SSH 远程委托
   *
   * 流程：
   * - RemoteAgentClient.delegate() → SSH 连接（3 次重试 + 退避）+ 远程 exec
   * - 失败分类：unreachable（场景 6）/ timeout（场景 7）/ remote_failure（场景 8）
   *
   * 不变量 #16 场景 6 (sidecar 404)：
   * - SSH/TCP 不可达 → delegate 返回 is_error=true + unreachable message
   * - Orchestrator 据此标记 task failed（iter 3 简化）
   * - iter 4+: 接入 ThreeStateRecovery 自动 evict
   */
  private async spawnRemote(params: {
    remoteTarget?: string;
    prompt: string;
    runtimeTaskId: TaskId;
    timeoutMs?: number;
    toolsWhitelist?: string[];
  }): Promise<ToolResult> {
    if (!this.deps.remoteAgentClient) {
      return {
        tool_use_id: '' as ToolUseId,
        content: [{ type: 'text', text: 'remote route unavailable: remoteAgentClient not injected' }],
        is_error: true,
      };
    }
    if (!params.remoteTarget) {
      return {
        tool_use_id: '' as ToolUseId,
        content: [{ type: 'text', text: 'remote route requires remote_target (e.g. "user@host")' }],
        is_error: true,
      };
    }

    return this.deps.remoteAgentClient.delegate({
      remote_target: params.remoteTarget,
      prompt: params.prompt,
      runtimeTaskId: params.runtimeTaskId,
      timeout_ms: params.timeoutMs,
      tools_whitelist: params.toolsWhitelist,
    });
  }
}
