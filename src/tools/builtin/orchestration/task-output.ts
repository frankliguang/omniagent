/**
 * TaskOutputTool（L3-M5 §5.1 — task_output）
 *
 * 读取 RuntimeTask 的状态与结果。LLM 调用：
 *   task_output(task_id="task_001")
 *
 * 返回：
 * - status=running → "still running, started at X"
 * - status=completed + result → result.content（透传 sidechain 输出）
 * - status=completed + 无 result → 读取 sidechain 最后一条 assistant 消息作为输出
 * - status=failed → error 信息
 * - status=timeout / evicted / stopped → 对应文案
 * - task not found → error
 *
 * 工具构造：通过 createTaskOutputTool(taskManager, sidechainManager?) 工厂注入依赖，
 * 避免污染 ToolContext（M2 iter 1 其他工具不需要 orchestration 句柄）。
 */

import type {
  PermissionDecision,
  Tool,
  ToolInput,
  ToolResult,
  ToolUseId,
} from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';
import type { TaskManager, TaskOutputResult } from '../../../orchestration/task-manager.js';
import type { SidechainManager } from '../../../memory/sidechain.js';

/** 构造参数 */
export interface TaskOutputToolDeps {
  taskManager: TaskManager;
  /** 可选 sidechain 读取器（completed 但无 inline result 时回退读取 sidechain） */
  sidechainManager?: SidechainManager;
}

/** 格式化输出 */
function formatOutput(out: TaskOutputResult): string {
  const lines: string[] = [
    `task_id: ${out.task_id}`,
    `status: ${out.status}`,
    `subtype: ${out.subtype}`,
    `started_at: ${out.startedAt}`,
  ];
  if (out.finishedAt) lines.push(`finished_at: ${out.finishedAt}`);
  if (out.sidechainId) lines.push(`sidechain_id: ${out.sidechainId}`);
  if (out.error) lines.push(`error: ${out.error}`);
  return lines.join('\n');
}

/** 从 ToolResult.content 提取纯文本 */
function extractTextFromToolResult(result: ToolResult): string {
  return result.content
    .map(block => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_use') return `[tool_use: ${block.name}]`;
      if (block.type === 'tool_result') {
        // 嵌套 tool_result（不常见，递归提取）
        if (Array.isArray(block.content)) {
          return block.content
            .map(b => (b.type === 'text' ? b.text : `[${b.type}]`))
            .join('');
        }
        return '[tool_result]';
      }
      return `[${block.type}]`;
    })
    .join('');
}

export function createTaskOutputTool(deps: TaskOutputToolDeps): Tool {
  return buildTool({
    name: 'task_output',
    description:
      'Read the status and output of a runtime task created by agent_router (sync/async/fork) ' +
      'or task_create. Returns task_id, status (running/completed/failed/timeout/evicted/stopped), ' +
      'subtype, timestamps, and the result content. For completed tasks without inline result, ' +
      'reads the sidechain transcript to extract the last assistant message.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The runtime task ID returned by agent_router or task_create.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,

    checkPermissions(_input: ToolInput): PermissionDecision {
      // task_output 只读，不修改外部状态
      return { decision: 'allow', matchedRule: 'm2-stub', layer: 2 };
    },

    async call(input: ToolInput, ctx): Promise<ToolResult> {
      const startMs = Date.now();
      const toolUseId = (ctx?.toolUseId ?? ('' as ToolUseId)) as ToolUseId;
      const taskId = input.task_id as string;
      if (!taskId) {
        return errorResult(toolUseId, 'task_output: task_id is required', { duration_ms: Date.now() - startMs });
      }

      const out = await deps.taskManager.getOutput(taskId as never);
      if (!out) {
        return errorResult(toolUseId, `task_output: task not found: ${taskId}`, { duration_ms: Date.now() - startMs });
      }

      // 1. running → 返回状态快照
      if (out.status === 'running') {
        return okResult(
          toolUseId,
          `task_output: task ${taskId} is still running.\n\n${formatOutput(out)}`,
          { compactable: true, duration_ms: Date.now() - startMs },
        );
      }

      // 2. completed + inline result → 透传 result content
      if (out.status === 'completed' && out.result) {
        const resultText = extractTextFromToolResult(out.result);
        return okResult(
          toolUseId,
          `task_output: task ${taskId} completed.\n\n${formatOutput(out)}\n\n--- output ---\n${resultText}`,
          { compactable: true, duration_ms: Date.now() - startMs },
        );
      }

      // 3. completed + 无 inline result → 读 sidechain 最后一条 assistant 消息
      if (out.status === 'completed' && out.sidechainId && deps.sidechainManager) {
        try {
          const sideMsgs = await deps.sidechainManager.read(out.sidechainId);
          // 倒序找最后一条 assistant 消息
          let lastAssistant: string | undefined;
          for (let i = sideMsgs.length - 1; i >= 0; i--) {
            const m = sideMsgs[i];
            if (m.role === 'assistant') {
              lastAssistant = m.content
                .map(b => (b.type === 'text' ? b.text : ''))
                .join('');
              if (lastAssistant) break;
            }
          }
          if (lastAssistant) {
            return okResult(
              toolUseId,
              `task_output: task ${taskId} completed (sidechain).\n\n${formatOutput(out)}\n\n--- output (from sidechain) ---\n${lastAssistant}`,
              { compactable: true, duration_ms: Date.now() - startMs },
            );
          }
          // sidechain 为空 / 无 assistant 消息 → 返回状态
          return okResult(
            toolUseId,
            `task_output: task ${taskId} completed but sidechain has no assistant output.\n\n${formatOutput(out)}`,
            { compactable: true, duration_ms: Date.now() - startMs },
          );
        } catch (err) {
          return errorResult(
            toolUseId,
            `task_output: failed to read sidechain for task ${taskId}: ${(err as Error).message}`,
            { duration_ms: Date.now() - startMs },
          );
        }
      }

      // 4. failed / timeout / evicted / stopped → 返回状态 + error
      if (out.error) {
        return okResult(
          toolUseId,
          `task_output: task ${taskId} ended with ${out.status}.\n\n${formatOutput(out)}`,
          { compactable: true, duration_ms: Date.now() - startMs },
        );
      }

      // 5. fallback：只返回状态
      return okResult(
        toolUseId,
        `task_output: task ${taskId} status=${out.status}.\n\n${formatOutput(out)}`,
        { compactable: true, duration_ms: Date.now() - startMs },
      );
    },
  });
}
