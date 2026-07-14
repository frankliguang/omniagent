/**
 * ForkAgentSpawner（L3-M5 §2.2.6 — M2 iter 1 fork 路径）
 *
 * 继承父 Agent 的上下文与工具池，独立 sidechain（不污染父会话）。
 *
 * 不变量 #5（prompt cache prefix byte-identical）：
 * - byte-identical 复制父 agent 当前 messages
 * - 对未配对的 tool_use 填占位 tool_result（fillPlaceholderToolResults）
 * - 使 fork agent 的 prompt prefix 与父 agent 完全一致，最大化 cache 命中
 *
 * 不变量 #6（独立 sidechain）：
 * - sidechain transcript 与父 transcript 物理隔离
 * - sidechain 的 CompactBoundary 用 sidechainId 作为 transcriptId
 */

import type {
  AgentId,
  ContentBlock,
  Message,
  TaskId,
  ToolResult,
  ToolUseId,
} from '../types/index.js';
import type { MemoryEngine } from '../memory/sidechain.js';
import type { SidechainManager } from '../memory/sidechain.js';
import type { TaskManager } from './task-manager.js';
import type { SubAgentRunnerFactory, SubAgentTurnResult } from './sub-agent-runner.js';
import { subAgentResultToToolResult } from './sub-agent-runner.js';

/** fork 路径参数 */
export interface ForkSpawnParams {
  prompt: string;
  runtimeTaskId: TaskId;
  parentAgentId: AgentId;
  toolsWhitelist?: string[];
  timeoutMs?: number;
}

/** fork 路径依赖 */
export interface ForkAgentSpawnerDeps {
  sidechain: SidechainManager;
  memoryEngine: MemoryEngine;
  runnerFactory: SubAgentRunnerFactory;
  /** TaskManager 用于关联 RuntimeTask 与 sidechainId（可选，Orchestrator 注入） */
  taskManager?: TaskManager;
}

export class ForkAgentSpawner {
  constructor(private readonly deps: ForkAgentSpawnerDeps) {}

  /** fork 路径：继承父上下文 + 独立 sidechain + 占位 tool_result */
  async spawn(params: ForkSpawnParams): Promise<ToolResult> {
    // 1. 读取父 agent 当前 messages（byte-identical 复制）
    const parentMessages = await this.deps.memoryEngine.getCurrentMessages(params.parentAgentId);

    // 2. 占位 tool_result（不变量 #5：prompt cache prefix byte-identical）
    const forkedMessages = fillPlaceholderToolResults(parentMessages);

    // 3. 创建 sidechain（独立 transcript，initialMessages = 继承的父上下文）
    const sidechainId = await this.deps.sidechain.create({
      parentTranscriptId: params.parentAgentId,
      runtimeTaskId: params.runtimeTaskId,
      initialMessages: forkedMessages,
    });

    // 3.1 关联 RuntimeTask 与 sidechainId（供 task_output 读取）
    if (this.deps.taskManager) {
      await this.deps.taskManager.setSidechain(params.runtimeTaskId, sidechainId);
    }

    // 4. spawn fork agent（runner 绑定 sidechainId）
    const runner = this.deps.runnerFactory(sidechainId);
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

    // 5. 持久化 sidechain
    await this.deps.sidechain.flush(sidechainId);

    // 6. 返回 ToolResult
    return subAgentResultToToolResult(subResult);
  }
}

// ============================================================
// fillPlaceholderToolResults（不变量 #5）
// ============================================================

/**
 * 对未配对的 tool_use 填占位 tool_result
 *
 * 父 agent 的 messages 中可能存在 tool_use 还没收到 tool_result（如被打断的 turn）。
 * fork agent 继承这些 messages 时，若不补齐 tool_result，LLM 会报错或 cache prefix 不一致。
 *
 * 补齐策略：
 * 1. 收集所有 tool_use 的 id（toolUseIds）
 * 2. 收集所有 tool_result 的 tool_use_id（toolResultIds）
 * 3. orphan = toolUseIds - toolResultIds
 * 4. 若 orphan 非空，构造一条 user message，含 N 个 tool_result block（content="placeholder"）
 *
 * 不修改原 messages（immutable copy），保证 byte-identical 复制语义。
 */
export function fillPlaceholderToolResults(messages: Message[]): Message[] {
  const result: Message[] = messages.map(m => ({ ...m, content: [...m.content] }));

  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of result) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id);
      if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id);
    }
  }

  const orphanToolUseIds = Array.from(toolUseIds).filter(id => !toolResultIds.has(id));
  if (orphanToolUseIds.length === 0) {
    return result;  // 全部配对，无需补齐
  }

  // 构造占位 user message（含 N 个 tool_result block）
  const placeholderBlocks: ContentBlock[] = orphanToolUseIds.map(id => ({
    type: 'tool_result' as const,
    tool_use_id: id as ToolUseId,
    content: [{ type: 'text' as const, text: 'placeholder' }],
    is_error: false,
  }));

  result.push({
    role: 'user',
    content: placeholderBlocks,
  });

  return result;
}

// ============================================================
// 校验函数（测试用，验证 byte-identical 不变量）
// ============================================================

/**
 * 校验 forked messages 满足不变量 #5：
 * - 原 messages 的所有 tool_use 都有对应 tool_result（orphan 为空）
 * - forked messages 前 N 条与原 messages byte-identical（N = 原 messages 长度）
 */
export function verifyByteIdenticalPrefix(original: Message[], forked: Message[]): {
  ok: boolean;
  detail?: string;
} {
  // 1. 前 original.length 条应与原 messages 一致
  for (let i = 0; i < original.length; i++) {
    const origJson = JSON.stringify(original[i]);
    const forkJson = JSON.stringify(forked[i]);
    if (origJson !== forkJson) {
      return {
        ok: false,
        detail: `message ${i} not byte-identical: orig=${origJson.slice(0, 80)}... fork=${forkJson.slice(0, 80)}...`,
      };
    }
  }

  // 2. forked 应等于 original.length 或 original.length + 1（占位 message）
  const extraCount = forked.length - original.length;
  if (extraCount !== 0 && extraCount !== 1) {
    return { ok: false, detail: `unexpected extra messages: ${extraCount}` };
  }

  // 3. 若有占位 message，应为 user role + 全 tool_result blocks
  if (extraCount === 1) {
    const placeholder = forked[original.length];
    if (placeholder.role !== 'user') {
      return { ok: false, detail: 'placeholder message should be user role' };
    }
    for (const block of placeholder.content) {
      if (block.type !== 'tool_result') {
        return { ok: false, detail: 'placeholder content should all be tool_result' };
      }
      if (block.type === 'tool_result') {
        const text = block.content[0];
        if (text.type !== 'text' || text.text !== 'placeholder') {
          return { ok: false, detail: 'placeholder text should be "placeholder"' };
        }
      }
    }
  }

  return { ok: true };
}
