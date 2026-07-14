/**
 * TaskManager（L3-M5 §2.2.2 — M2 iter 1 minimal + M2 iter 5 boundary recording）
 *
 * 双轨管理：WorkItem（LLM 维护，高层任务）+ RuntimeTask（harness 维护，运行时实例）。
 * M2 iter 1 范围：
 * - createDualTrack: 创建 WorkItem + RuntimeTask（in-memory）
 * - completeTask: 标记 RuntimeTask 完成 + 保存 result
 * - failTask: 标记 RuntimeTask 失败 + 保存 error
 * - getOutput: 返回 RuntimeTask 状态 + 结果
 * - setSidechain: 关联 RuntimeTask 与 sidechainId（fork/async/teammate 路径）
 *
 * M2 iter 5 范围：
 * - completeTask/failTask 在 task 含 sidechainId 时记录 CompactBoundary
 *   - triggerLayer = 'L2_session'（session 级别边界，允许后续 /rewind 到 task 完成点）
 *   - compactRange = sidechain 当前消息范围 [0, count-1]
 *   - 通过依赖注入的 BoundaryStore 写入 ~/.omniagent/transcript/<sessionId>.boundaries.jsonl
 *
 * M2 iter 2+ 范围（不在本迭代）：
 * - 持久化到 ~/.omniagent/tasks/ JSONL
 * - waitForCompletion(block=true)
 * - 任务超时 / evict
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentRoute,
  ISO8601Timestamp,
  RuntimeTask,
  RuntimeTaskSubtype,
  TaskId,
  TaskStatus,
  ToolResult,
  UUID,
  WorkItem,
  WorkItemId,
} from '../types/index.js';
import type { BoundaryStore } from '../memory/boundary.js';
import { createBoundary } from '../memory/boundary.js';
import type { SidechainManager } from '../memory/sidechain.js';

// ============================================================
// 内存存储（M2 iter 1：不持久化，进程退出即丢失；iter 2 接入 JSONL 持久化）
// ============================================================

class InMemoryRuntimeTaskStore {
  private readonly tasks: Map<TaskId, RuntimeTask> = new Map();

  async save(task: RuntimeTask): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async get(taskId: TaskId): Promise<RuntimeTask | undefined> {
    return this.tasks.get(taskId);
  }

  async list(): Promise<RuntimeTask[]> {
    return Array.from(this.tasks.values());
  }

  async delete(taskId: TaskId): Promise<void> {
    this.tasks.delete(taskId);
  }
}

class InMemoryWorkItemStore {
  private readonly items: Map<WorkItemId, WorkItem> = new Map();

  async save(item: WorkItem): Promise<void> {
    this.items.set(item.id, item);
  }

  async get(itemId: WorkItemId): Promise<WorkItem | undefined> {
    return this.items.get(itemId);
  }

  async list(): Promise<WorkItem[]> {
    return Array.from(this.items.values());
  }
}

// ============================================================
// TaskManager
// ============================================================

/** createDualTrack 参数 */
export interface CreateDualTrackParams {
  route: AgentRoute;
  prompt: string;
  parentAgentId: string;
  /** 传入的 tools whitelist（fork/teammate 路径用） */
  toolsWhitelist?: string[];
  /** 超时配置（ms） */
  timeoutMs?: number;
}

/** createDualTrack 返回 */
export interface DualTrackHandle {
  workItemId: WorkItemId;
  runtimeTaskId: TaskId;
}

/** getOutput 返回结构 */
export interface TaskOutputResult {
  task_id: TaskId;
  status: TaskStatus;
  startedAt: ISO8601Timestamp;
  finishedAt?: ISO8601Timestamp;
  /** RuntimeTask.subtype */
  subtype: RuntimeTaskSubtype;
  /** sidechain ID（fork/async/teammate 路径会有） */
  sidechainId?: UUID;
  /** 完成时保存的结果（task_output 工具透传给 LLM） */
  result?: ToolResult;
  /** 失败时的错误信息 */
  error?: string;
}

/** TaskManager 可选依赖（M2 iter 5：boundary recording） */
export interface TaskManagerDeps {
  /** BoundaryStore：注入后 completeTask/failTask 会写 CompactBoundary */
  boundaryStore?: BoundaryStore;
  /** SidechainManager：用于读取 sidechain 消息数以构造 compactRange */
  sidechain?: SidechainManager;
}

export class TaskManager {
  private readonly runtimeTaskStore: InMemoryRuntimeTaskStore;
  private readonly workItemStore: InMemoryWorkItemStore;
  private readonly deps: TaskManagerDeps;

  constructor(deps: TaskManagerDeps = {}) {
    this.runtimeTaskStore = new InMemoryRuntimeTaskStore();
    this.workItemStore = new InMemoryWorkItemStore();
    this.deps = deps;
  }

  /** 创建 WorkItem + RuntimeTask 双轨 */
  async createDualTrack(params: CreateDualTrackParams): Promise<DualTrackHandle> {
    const workItemId = randomUUID() as WorkItemId;
    const runtimeTaskId = randomUUID() as TaskId;
    const now = new Date().toISOString() as ISO8601Timestamp;

    const workItem: WorkItem = {
      id: workItemId,
      description: params.prompt,
      runtimeTaskIds: [runtimeTaskId],
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    };

    const runtimeTask: RuntimeTask = {
      id: runtimeTaskId,
      workItemId,
      subtype: params.route as RuntimeTaskSubtype,
      status: 'running',
      startedAt: now,
      timeoutMs: params.timeoutMs,
    };

    await this.workItemStore.save(workItem);
    await this.runtimeTaskStore.save(runtimeTask);
    return { workItemId, runtimeTaskId };
  }

  /** 关联 RuntimeTask 与 sidechainId（fork/async/teammate 路径） */
  async setSidechain(taskId: TaskId, sidechainId: UUID): Promise<void> {
    const task = await this.runtimeTaskStore.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    task.sidechainId = sidechainId;
    await this.runtimeTaskStore.save(task);
  }

  /** 完成 task（保存 result） */
  async completeTask(taskId: TaskId, result?: ToolResult): Promise<void> {
    const task = await this.runtimeTaskStore.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    task.status = 'completed';
    task.finishedAt = new Date().toISOString() as ISO8601Timestamp;
    await this.runtimeTaskStore.save(task);

    const workItem = await this.workItemStore.get(task.workItemId);
    if (workItem) {
      workItem.status = 'completed';
      workItem.updatedAt = new Date().toISOString() as ISO8601Timestamp;
      await this.workItemStore.save(workItem);
    }

    // 保存 result 到 RuntimeTask metadata（M2 iter 1：直接挂到 task 对象）
    if (result) {
      (task as RuntimeTask & { result?: ToolResult }).result = result;
    }

    // M2 iter 5：若 task 含 sidechainId，记录 CompactBoundary（triggerLayer='L2_session'）
    // 允许后续 /rewind 到 task 完成点。失败不阻断 task completed（boundary 写入是辅助功能）。
    await this.recordBoundary(task).catch(() => {});
  }

  /** 失败 task（保存 error） */
  async failTask(taskId: TaskId, error: string): Promise<void> {
    const task = await this.runtimeTaskStore.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    task.status = 'failed';
    task.finishedAt = new Date().toISOString() as ISO8601Timestamp;
    (task as RuntimeTask & { error?: string }).error = error;
    await this.runtimeTaskStore.save(task);

    const workItem = await this.workItemStore.get(task.workItemId);
    if (workItem) {
      workItem.status = 'cancelled';
      workItem.updatedAt = new Date().toISOString() as ISO8601Timestamp;
      await this.workItemStore.save(workItem);
    }

    // M2 iter 5：失败 task 也记录 boundary（允许 /rewind 到失败点排查）
    await this.recordBoundary(task).catch(() => {});
  }

  /**
   * 记录 CompactBoundary（M2 iter 5）
   *
   * 仅当 boundaryStore + sidechain + task.sidechainId 三者齐备时写入。
   * compactRange = sidechain 全量消息范围 [0, count-1]。
   * tokensBefore/After = 0（TaskManager 不跟踪 token 数；仅记录位置标记）。
   */
  private async recordBoundary(task: RuntimeTask): Promise<void> {
    if (!this.deps.boundaryStore || !this.deps.sidechain) return;
    if (!task.sidechainId) return;

    // 读取 sidechain 消息数（用于 compactRange end）
    let end = 0;
    try {
      const messages = await this.deps.sidechain.read(task.sidechainId);
      end = Math.max(0, messages.length - 1);
    } catch {
      // sidechain 已关闭或不可读 → compactRange.end = 0（仅记录起点）
      end = 0;
    }

    const boundary = createBoundary({
      transcriptId: task.sidechainId,
      compactRange: { start: 0, end },
      tokensBefore: 0,
      tokensAfter: 0,
      triggerLayer: 'L2_session',
    });
    await this.deps.boundaryStore.append(boundary);
  }

  /** 读取 task 输出（task_output 工具调用） */
  async getOutput(taskId: TaskId): Promise<TaskOutputResult | undefined> {
    const task = await this.runtimeTaskStore.get(taskId);
    if (!task) return undefined;
    const ext = task as RuntimeTask & { result?: ToolResult; error?: string };
    return {
      task_id: task.id,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      subtype: task.subtype,
      sidechainId: task.sidechainId,
      result: ext.result,
      error: ext.error,
    };
  }

  /** 获取 RuntimeTask 完整对象（orchestrator 内部用） */
  async getRuntimeTask(taskId: TaskId): Promise<RuntimeTask | undefined> {
    return this.runtimeTaskStore.get(taskId);
  }

  /** 列出所有 RuntimeTask（监控用） */
  async listTasks(): Promise<RuntimeTask[]> {
    return this.runtimeTaskStore.list();
  }

  /** 列出所有 WorkItem */
  async listWorkItems(): Promise<WorkItem[]> {
    return this.workItemStore.list();
  }
}
