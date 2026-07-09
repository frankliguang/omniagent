/**
 * ToolUsePairGuard（L3-M2 §3.7 — tool_use/tool_result 配对完整性守护，不变量 #3）
 *
 * 不变量 #3：tool_use 与 tool_result 必须一一配对，不允许 orphan。
 *
 * M2 侧负责"检查 + 拒绝"：
 * - orphan tool_result（无配对 tool_use）：拒绝写入 transcript + 记审计 + 抛错
 * - orphan tool_use（无配对 tool_result）：不进入 CALL_LLM（避免 LLM 困惑）+ 走 fallback
 *
 * M7 侧负责"压缩时修正"（adjustIndexToPreserveAPIInvariants），M2 在压缩前调用。
 *
 * M1 迭代 2 stub：实现检查 + fail-closed 拒绝，不实现 M7 调用。
 */

import type { Message, ToolResult, ToolUseBlock, ToolUseId } from '../types/index.js';

export interface PairingCheckResult {
  /** 配对完整，可写 transcript */
  ok: boolean;
  /** orphan tool_use 的 IDs（无配对 tool_result） */
  orphanToolUseIds: ToolUseId[];
  /** orphan tool_result 的 tool_use_ids（无配对 tool_use） */
  orphanToolResultIds: ToolUseId[];
  /** 错误原因（ok=false 时填） */
  error?: string;
}

export class ToolUsePairGuard {
  /**
   * 检查单个 tool_result 是否有配对的 tool_use（在 messages 中）
   *
   * 调用时机：TOOL_EXECUTE 状态，每次 tool_result 进入 transcript 前
   */
  checkToolResultHasPairing(toolResult: ToolResult, messages: Message[]): boolean {
    const toolUseId = toolResult.tool_use_id;
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id === toolUseId) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 检查 messages 数组中所有 tool_use 是否都有配对 tool_result
   *
   * 调用时机：TOOL_EXECUTE → CALL_LLM 转换前
   */
  checkAllToolUsesPaired(messages: Message[]): PairingCheckResult {
    const toolUseIds = new Set<ToolUseId>();
    const toolResultIds = new Set<ToolUseId>();

    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolUseIds.add(block.id);
        } else if (block.type === 'tool_result') {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }

    const orphanToolUseIds: ToolUseId[] = [];
    for (const id of toolUseIds) {
      if (!toolResultIds.has(id)) {
        orphanToolUseIds.push(id);
      }
    }

    const orphanToolResultIds: ToolUseId[] = [];
    for (const id of toolResultIds) {
      if (!toolUseIds.has(id)) {
        orphanToolResultIds.push(id);
      }
    }

    const ok = orphanToolUseIds.length === 0 && orphanToolResultIds.length === 0;
    let error: string | undefined;
    if (orphanToolResultIds.length > 0) {
      error = `orphan tool_result without pairing tool_use: ${orphanToolResultIds.join(', ')}`;
    } else if (orphanToolUseIds.length > 0) {
      error = `orphan tool_use without pairing tool_result: ${orphanToolUseIds.join(', ')}`;
    }

    return { ok, orphanToolUseIds, orphanToolResultIds, error };
  }

  /**
   * 检查单个 assistant message中的 tool_use 块是否都有配对 tool_result
   *
   * 调用时机：EVAL_STOP_REASON 状态，stream_end 时检查
   */
  checkAssistantMessagePaired(message: Message, allMessages: Message[]): PairingCheckResult {
    const toolUseIds: ToolUseId[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        toolUseIds.push(block.id);
      }
    }

    if (toolUseIds.length === 0) {
      return { ok: true, orphanToolUseIds: [], orphanToolResultIds: [] };
    }

    const toolResultIds = new Set<ToolUseId>();
    for (const msg of allMessages) {
      if (msg.role !== 'tool') continue;
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }

    const orphanToolUseIds = toolUseIds.filter(id => !toolResultIds.has(id));
    return {
      ok: orphanToolUseIds.length === 0,
      orphanToolUseIds,
      orphanToolResultIds: [],
      error: orphanToolUseIds.length > 0
        ? `assistant message has ${orphanToolUseIds.length} tool_use(s) without pairing tool_result (expected: tool_result will be added by TOOL_EXECUTE next)`
        : undefined,
    };
  }

  /**
   * 提取 messages 中所有 tool_use 块（按出现顺序）
   *
   * 用于 ReActLoop 在 EVAL_STOP_REASON 后确定要执行的 tool_use 列表
   */
  extractToolUses(message: Message): ToolUseBlock[] {
    return message.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );
  }
}
