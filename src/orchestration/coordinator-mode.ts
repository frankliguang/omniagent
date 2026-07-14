/**
 * CoordinatorMode（L3-M5 §2.2.4 — M2 iter 1 sync/async 路径）
 *
 * 主 Agent 只编排，不直接执行写工具。
 * sync 路径：阻塞主对话，等子 agent 完成
 * async 路径：立即返回 task_id，后台 spawn，主 agent 通过 task_output 读取结果
 *
 * 不变量 #5（prompt cache prefix byte-identical）：
 * - sync 路径不继承父上下文（独立 sidechain，从空开始）
 * - fork 路径才继承父上下文（ForkAgentSpawner）
 *
 * 不变量 #4（直接工具调用率 = 0，M2 iter 3 守护）：
 * - CoordinatorMode 持有可选 baseTools 池（主 agent 工具池）
 * - 通过 mergeAndFilterTools(agentRole='coordinator') 移除 bash/edit_file/write_file
 * - spawnSync/spawnAsync 入口 fail-closed 守护：若 filtered 池含被禁工具则拒绝 spawn
 */

import type {
  AgentId,
  TaskId,
  Tool,
  ToolResult,
  ToolUseId,
} from '../types/index.js';
import type { SidechainManager } from '../memory/sidechain.js';
import type { TaskManager } from './task-manager.js';
import type { SubAgentRunnerFactory, SubAgentTurnResult } from './sub-agent-runner.js';
import { subAgentResultToToolResult } from './sub-agent-runner.js';
import {
  mergeAndFilterTools,
  checkCoordinatorInvariant,
} from '../tools/merge-filter-tools.js';

/** 路由参数（与 AgentRouterParams 一致 + 运行时注入字段） */
export interface RouteRuntimeParams {
  route: 'sync' | 'async' | 'fork';
  prompt: string;
  runtimeTaskId: TaskId;
  parentAgentId: AgentId;
  toolsWhitelist?: string[];
  timeoutMs?: number;
}

/** sync 路径：阻塞主对话直到子 agent 完成 */
export async function spawnSync(params: RouteRuntimeParams & {
  sidechain: SidechainManager;
  taskManager: TaskManager;
  runnerFactory: SubAgentRunnerFactory;
}): Promise<ToolResult> {
  // 1. 创建 sidechain（独立 transcript，不继承父上下文）
  const sidechainId = await params.sidechain.create({
    parentTranscriptId: params.parentAgentId,
    runtimeTaskId: params.runtimeTaskId,
  });

  // 2. 关联 RuntimeTask 与 sidechainId
  await params.taskManager.setSidechain(params.runtimeTaskId, sidechainId);

  // 3. spawn 子 agent（runner 绑定 sidechainId）
  const runner = params.runnerFactory(sidechainId);
  let subResult: SubAgentTurnResult;
  try {
    subResult = await runner.runTurn({
      prompt: params.prompt,
      sidechainId,
      parentAgentId: params.parentAgentId,
    });
  } catch (err) {
    subResult = {
      stopReason: 'failed',
      iterations: 0,
      finalText: '',
      error: (err as Error).message,
    };
  }

  // 4. 持久化 sidechain
  await params.sidechain.flush(sidechainId);

  // 5. 返回 ToolResult（透传子 agent 输出）
  return subAgentResultToToolResult(subResult);
}

/** async 路径：后台 spawn，立即返回 task_id */
export async function spawnAsync(params: RouteRuntimeParams & {
  sidechain: SidechainManager;
  taskManager: TaskManager;
  runnerFactory: SubAgentRunnerFactory;
}): Promise<ToolResult> {
  const taskId = params.runtimeTaskId;

  // 后台 spawn（不阻塞主对话）
  void (async () => {
    try {
      const result = await spawnSync({ ...params, route: 'sync' });
      await params.taskManager.completeTask(taskId, result);
    } catch (err) {
      await params.taskManager.failTask(taskId, (err as Error).message);
    }
  })();

  // 立即返回 task_id
  return {
    tool_use_id: '' as ToolUseId,
    content: [{ type: 'text', text: `async task started: ${taskId}` }],
    is_error: false,
    metadata: { duration_ms: 0, compactable: false },
  };
}

/**
 * CoordinatorMode（封装 sync/async 路径为类）
 *
 * 持有 sidechain / taskManager / runnerFactory 依赖。
 * Orchestrator 通过此类调用 sync/async 路径。
 *
 * M2 iter 3：可选持有 baseTools（主 agent 工具池），spawn 入口 fail-closed 守护不变量 #4。
 */
export class CoordinatorMode {
  private readonly sidechain: SidechainManager;
  private readonly taskManager: TaskManager;
  private readonly runnerFactory: SubAgentRunnerFactory;
  /** 主 agent 的工具池（可选；未注入则跳过 invariant #4 守护） */
  private readonly baseTools?: Tool[];

  constructor(
    sidechain: SidechainManager,
    taskManager: TaskManager,
    runnerFactory: SubAgentRunnerFactory,
    /** 可选：主 agent 工具池。注入后 spawnSync/spawnAsync 会做 invariant #4 守护 */
    baseTools?: Tool[],
  ) {
    this.sidechain = sidechain;
    this.taskManager = taskManager;
    this.runnerFactory = runnerFactory;
    this.baseTools = baseTools;
  }

  /**
   * 获取 coordinator 角色过滤后的工具池（不变量 #4）。
   *
   * 调用 mergeAndFilterTools({ baseTools, agentRole: 'coordinator' }) 移除
   * bash/edit_file/write_file。供主 agent BUILD_CONTEXT 阶段使用。
   *
   * @returns 过滤后的工具池；若未注入 baseTools 则返回空数组
   */
  getCoordinatorToolPool(): Tool[] {
    if (!this.baseTools || this.baseTools.length === 0) return [];
    const { filtered } = mergeAndFilterTools({
      baseTools: this.baseTools,
      agentRole: 'coordinator',
    });
    return filtered;
  }

  /**
   * 不变量 #4 fail-closed 守护器（静态方法）。
   *
   * 检查工具池是否含被禁工具（bash/edit_file/write_file）。
   * 若含 → 抛错（fail-closed，拒绝继续 spawn）。
   *
   * @param pool 待检查的工具池
   * @throws Error 若含被禁工具
   */
  static assertCoordinatorInvariant(pool: Tool[]): void {
    const violations = checkCoordinatorInvariant(pool);
    if (violations.length > 0) {
      throw new Error(
        `invariant #4 violated: coordinator tool pool contains banned tools: ${violations.join(', ')}`,
      );
    }
  }

  /**
   * 入口 fail-closed 守护：检查 coordinator 自己的工具池是否合规。
   *
   * 若 baseTools 未注入 → 跳过（兼容 M2 iter 1/2 调用方）。
   * 若 baseTools 已注入 → 检查过滤后的 pool；若仍含被禁工具（理论上不可能）→ 拒绝 spawn。
   */
  private assertCoordinatorMode(): void {
    if (!this.baseTools || this.baseTools.length === 0) return;
    const filtered = this.getCoordinatorToolPool();
    CoordinatorMode.assertCoordinatorInvariant(filtered);
  }

  async spawnSync(params: RouteRuntimeParams): Promise<ToolResult> {
    // 不变量 #4 守护：fail-closed
    this.assertCoordinatorMode();

    return spawnSync({
      ...params,
      sidechain: this.sidechain,
      taskManager: this.taskManager,
      runnerFactory: this.runnerFactory,
    });
  }

  async spawnAsync(params: RouteRuntimeParams): Promise<ToolResult> {
    // 不变量 #4 守护：fail-closed
    this.assertCoordinatorMode();

    return spawnAsync({
      ...params,
      sidechain: this.sidechain,
      taskManager: this.taskManager,
      runnerFactory: this.runnerFactory,
    });
  }
}
