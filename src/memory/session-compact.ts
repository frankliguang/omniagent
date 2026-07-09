/**
 * SessionCompactor（L3-M7 §3.5.2 — L2 会话记忆压缩）
 *
 * 触发条件：tool_result 累计 > 30% 上下文窗口
 *
 * 压缩策略：
 * 1. 找 COMPACTABLE_TOOLS 白名单内的 tool_result（bash/edit_file/read_file/write_file/glob/grep/task_output/web_fetch）
 * 2. adjustIndexToPreserveAPIInvariants 保证 tool_use/tool_result 配对完整
 * 3. 保留窗口：minTokens=10K / minText=5 条 / maxTokens=40K
 * 4. 从末尾反向保留：最近的 5 条 text 消息 + 10K token 必保留
 *
 * M1 迭代 2 范围：
 * - compact() 同步实现（不调 LLM 做摘要，M3 接入 ApiSummarizer）
 * - 保留窗口算法
 * - tool_use/tool_result 配对完整性校验
 */

import type { Message } from '../types/index.js';
import { COMPACTABLE_TOOLS } from '../types/index.js';

// ============================================================
// 常量
// ============================================================

/** 保留窗口：最少 token 数 */
const MIN_TOKENS = 10_000;
/** 保留窗口：最少 text 消息数 */
const MIN_TEXT_MESSAGES = 5;
/** 保留窗口：最大 token 数 */
const MAX_TOKENS = 40_000;

// ============================================================
// 类型
// ============================================================

export interface CompactOptions {
  /** 最少保留 token 数（默认 10000） */
  minTokens?: number;
  /** 最少保留 text 消息数（默认 5） */
  minTextMessages?: number;
  /** 最大保留 token 数（默认 40000） */
  maxTokens?: number;
}

export interface CompactResult {
  /** 压缩后的消息（保留窗口 + 未压缩消息） */
  retained: Message[];
  /** 被移除的消息索引（原始 messages 中的下标） */
  removedIndices: number[];
  /** 压缩前 token 数估算 */
  tokensBefore: number;
  /** 压缩后 token 数估算 */
  tokensAfter: number;
}

// ============================================================
// SessionCompactor
// ============================================================

export class SessionCompactor {
  /** 入口：压缩消息数组 */
  compact(messages: Message[], opts: CompactOptions = {}): CompactResult {
    const minTokens = opts.minTokens ?? MIN_TOKENS;
    const minText = opts.minTextMessages ?? MIN_TEXT_MESSAGES;
    const maxTokens = opts.maxTokens ?? MAX_TOKENS;

    // 1. 找 COMPACTABLE_TOOLS 白名单内的 tool_result 所在消息
    const compactableIndices = this.findCompactableRanges(messages);

    // 2. adjustIndexToPreserveAPIInvariants：保证 tool_use/tool_result 配对
    // 工具对（tool_use, tool_result）作为原子单元：要么都移除，要么都保留
    const adjusted = this.adjustIndexToPreserveAPIInvariants({
      messages,
      compactableIndices,
    });

    // 3. 保留窗口（含配对修复：若 tool_use 被保留，对应 tool_result 也保留，反之亦然）
    const { retained, removedIndices } = this.applyRetainWindow(messages, adjusted.indicesToRemove, {
      minTokens,
      minText,
      maxTokens,
    });

    const tokensBefore = this.estimateTokens(messages);
    const tokensAfter = this.estimateTokens(retained);

    return {
      retained,
      removedIndices: [...removedIndices].sort((a, b) => a - b),
      tokensBefore,
      tokensAfter,
    };
  }

  /** 找出可压缩的消息索引（含 COMPACTABLE_TOOLS 内的 tool_result） */
  private findCompactableRanges(messages: Message[]): number[] {
    const indices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          // 通过 tool_use 配对反查 tool name
          const toolName = this.findToolNameForResult(block.tool_use_id, messages);
          if (toolName && (COMPACTABLE_TOOLS as readonly string[]).includes(toolName)) {
            indices.push(i);
            break;
          }
        }
      }
    }
    return indices;
  }

  /** 根据 tool_use_id 反查 tool name */
  private findToolNameForResult(toolUseId: unknown, messages: Message[]): string | undefined {
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id === toolUseId) {
          return block.name;
        }
      }
    }
    return undefined;
  }

  /**
   * 调整待移除索引，保证 tool_use/tool_result 配对完整
   *
   * 规则：
   * - tool_use 与 tool_result 是原子对：若任一被移除，另一也必须移除
   * - 此处仅处理 compactable 工具的反向传播（tool_result 移除 → tool_use 也移除）
   * - 反向（tool_use 移除 → tool_result 也移除）在 applyRetainWindow 中处理
   */
  private adjustIndexToPreserveAPIInvariants(params: {
    messages: Message[];
    compactableIndices: number[];
  }): { indicesToRemove: Set<number>; ok: boolean } {
    const { messages, compactableIndices } = params;
    const indicesToRemove = new Set<number>(compactableIndices);

    // 对每个可压缩消息（含 tool_result），找其对应的 tool_use 消息，一并标记移除
    for (const idx of compactableIndices) {
      const msg = messages[idx];
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const toolUseId = block.tool_use_id;
          // 找对应的 tool_use 所在消息
          for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            for (const b of m.content) {
              if (b.type === 'tool_use' && b.id === toolUseId) {
                indicesToRemove.add(i);
                break;
              }
            }
          }
        }
      }
    }

    return { indicesToRemove, ok: true };
  }

  /**
   * 保留窗口算法 + 配对修复
   *
   * 步骤：
   * 1. 从末尾反向保留：必保留最近 5 条 text + 10K token；不在 removeIndices 的也保留
   * 2. 修复配对：若 tool_use 被保留但对应 tool_result 不在 retained，添加 tool_result；反之亦然
   *
   * 配对修复确保不变量 #3：tool_use/tool_result 配对完整性
   */
  private applyRetainWindow(
    messages: Message[],
    removeIndices: Set<number>,
    opts: { minTokens: number; minText: number; maxTokens: number },
  ): { retained: Message[]; removedIndices: Set<number> } {
    const retainedSet = new Set<number>();  // 保留的索引
    let retainedTokens = 0;
    let retainedTextCount = 0;

    // 从末尾反向保留
    for (let i = messages.length - 1; i >= 0; i--) {
      if (retainedTokens >= opts.maxTokens) break;
      const msg = messages[i];

      const hasText = msg.content.some(b => b.type === 'text');
      const isRecentText = retainedTextCount < opts.minText && hasText;
      const isUnderMinTokens = retainedTokens < opts.minTokens;

      if (isRecentText || isUnderMinTokens) {
        retainedSet.add(i);
        retainedTokens += this.estimateTokens([msg]);
        if (hasText) retainedTextCount++;
      } else if (!removeIndices.has(i)) {
        // 不在压缩范围内的也保留
        retainedSet.add(i);
        retainedTokens += this.estimateTokens([msg]);
      }
      // 在 removeIndices 内且不满足必保留条件 → 跳过
    }

    // 配对修复：扫两遍确保 tool_use ↔ tool_result 完整
    // Pass 1: 若 tool_use 在 retainedSet，对应 tool_result 也加入
    for (let i = 0; i < messages.length; i++) {
      if (!retainedSet.has(i)) continue;
      const msg = messages[i];
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          // 找对应 tool_result
          for (let j = 0; j < messages.length; j++) {
            const m = messages[j];
            if (m.content.some(b => b.type === 'tool_result' && b.tool_use_id === block.id)) {
              retainedSet.add(j);
              break;
            }
          }
        }
      }
    }
    // Pass 2: 若 tool_result 在 retainedSet，对应 tool_use 也加入
    for (let i = 0; i < messages.length; i++) {
      if (!retainedSet.has(i)) continue;
      const msg = messages[i];
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          // 找对应 tool_use
          for (let j = 0; j < messages.length; j++) {
            const m = messages[j];
            if (m.content.some(b => b.type === 'tool_use' && b.id === block.tool_use_id)) {
              retainedSet.add(j);
              break;
            }
          }
        }
      }
    }

    // 构造 retained 消息数组（按原顺序）
    const retained = messages.filter((_, i) => retainedSet.has(i));
    // 计算实际被移除的索引
    const removedIndices = new Set<number>();
    for (let i = 0; i < messages.length; i++) {
      if (!retainedSet.has(i)) removedIndices.add(i);
    }
    return { retained, removedIndices };
  }

  /** 估算 token 数（粗略：4 字符 ≈ 1 token） */
  estimateTokens(messages: Message[]): number {
    let chars = 0;
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          chars += block.text.length;
        } else if (block.type === 'tool_use') {
          chars += JSON.stringify(block.input).length + block.name.length;
        } else if (block.type === 'tool_result') {
          for (const sub of block.content) {
            if (sub.type === 'text') chars += sub.text.length;
          }
        }
      }
    }
    return Math.ceil(chars / 4);
  }
}

// ============================================================
// 单例
// ============================================================

export const sessionCompactor = new SessionCompactor();
