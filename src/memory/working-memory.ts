/**
 * WorkingMemory（L3-M7 §3.1 — L1_working 层）
 *
 * 当前对话的消息 + 工具调用结果，单会话全量注入。
 *
 * M1 迭代 1：纯内存实现，无持久化、无召回、无压缩。
 *  - addMessage(): 追加消息（user/assistant/tool_result）
 *  - getMessages(): 全量返回（L1 = full injection，无筛选）
 *  - clear(): 重置（新会话）
 *
 * M1 迭代 2：补 L2 SessionMemory（跨 turn 摘要，替换 L3-M7 §3.5.2）
 * M1 迭代 3：补 L3 findRelevantMemories 召回（L3-M7 §3.3）
 */

import type { Message, MessageRole } from '../types/index.js';

export class WorkingMemory {
  private readonly messages: Message[] = [];
  private readonly createdAt = Date.now();

  /** 追加消息 */
  addMessage(message: Message): void {
    // 基本校验：role 合法、content 非空
    if (!message.role) {
      throw new Error('WorkingMemory.addMessage: message.role is required');
    }
    if (!Array.isArray(message.content)) {
      throw new Error('WorkingMemory.addMessage: message.content must be an array');
    }
    this.messages.push(message);
  }

  /** 批量追加 */
  addMessages(messages: Message[]): void {
    for (const m of messages) this.addMessage(m);
  }

  /**
   * 全量返回当前对话消息（L1 = full injection）。
   * L2/L3 在上层按需替换/筛选，L1 不做任何处理。
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** 返回最近 N 条消息（M2 ReAct Loop BUILD_CONTEXT 用） */
  getRecentMessages(n: number): Message[] {
    if (n <= 0) return [];
    return this.messages.slice(-n);
  }

  /** 按角色筛选 */
  getMessagesByRole(role: MessageRole): Message[] {
    return this.messages.filter(m => m.role === role);
  }

  /** 当前消息数 */
  size(): number {
    return this.messages.length;
  }

  /** 是否为空 */
  isEmpty(): boolean {
    return this.messages.length === 0;
  }

  /** 最后一条消息（M2 EVAL_STOP_REASON 用） */
  getLastMessage(): Message | undefined {
    return this.messages[this.messages.length - 1];
  }

  /** 移除最后一条消息（M2 5xx 降级清 partial 用，避免污染下一模型） */
  removeLastMessage(): Message | undefined {
    return this.messages.pop();
  }

  /** 重置（新会话） */
  clear(): void {
    this.messages.length = 0;
  }

  /** 会话创建时间（M1 stub，M1 迭代 2 持久化时用） */
  getCreatedAt(): number {
    return this.createdAt;
  }

  /**
   * 估算当前上下文 token 数（M1 stub：4 char/token 估算）。
   * M2 shouldAutoCompact 用此判断是否触发压缩。
   */
  estimateTokenCount(): number {
    let chars = 0;
    for (const m of this.messages) {
      for (const block of m.content) {
        if (block.type === 'text') {
          chars += block.text.length;
        } else if (block.type === 'tool_use') {
          chars += JSON.stringify(block.input).length;
        } else if (block.type === 'tool_result') {
          for (const sub of block.content) {
            if (sub.type === 'text') chars += sub.text.length;
          }
        } else if (block.type === 'json') {
          chars += JSON.stringify(block.json).length;
        }
      }
    }
    return Math.ceil(chars / 4);
  }
}
