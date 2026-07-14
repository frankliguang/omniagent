/**
 * 子 agent 运行器接口（L3-M5 §2.2.4/§2.2.6 — M2 iter 1）
 *
 * CoordinatorMode / ForkAgentSpawner 通过此接口调用子 agent 的 ReActLoop，
 * 不直接依赖具体 ReActLoop 实现，便于测试与解耦。
 *
 * M2 iter 1：runTurn 返回简化的 SubAgentTurnResult（足够 task_output 透传）。
 * M2 iter 2+：接入完整 TurnResult（含 tokenUsage / cost / stopReason 等）。
 */

import type { StopReason, ToolUseId, ToolResult, UUID, AgentId } from '../types/index.js';

/** 子 agent 单 turn 运行结果（简化版） */
export interface SubAgentTurnResult {
  /** 终止原因（end_turn / tool_use / max_output_tokens / failed 等） */
  stopReason: StopReason | 'failed';
  /** 迭代次数 */
  iterations: number;
  /** 最终 assistant 输出文本（最后一条 assistant 消息的文本拼接） */
  finalText: string;
  /** 错误信息（stopReason=failed 时） */
  error?: string;
}

/** 子 agent 运行器：CoordinatorMode/ForkAgentSpawner 调用 */
export interface SubAgentRunner {
  /**
   * 在 sidechain 中跑一轮子 agent
   *
   * @param params.prompt 用户 prompt
   * @param params.sidechainId 子 agent 的 sidechain ID（已注入 initialMessages）
   * @param params.parentAgentId 父 agent ID（trace 关联用）
   */
  runTurn(params: {
    prompt: string;
    sidechainId: UUID;
    parentAgentId: AgentId;
  }): Promise<SubAgentTurnResult>;
}

/** 工厂函数签名：给定 sidechainId，返回绑定的 SubAgentRunner */
export type SubAgentRunnerFactory = (sidechainId: UUID) => SubAgentRunner;

/** 把 SubAgentTurnResult 转为 ToolResult（透传给主 agent） */
export function subAgentResultToToolResult(
  result: SubAgentTurnResult,
  toolUseId: ToolUseId = '' as ToolUseId,
): ToolResult {
  return {
    tool_use_id: toolUseId,
    content: [{ type: 'text', text: result.finalText || JSON.stringify(result) }],
    is_error: result.stopReason === 'failed' || result.stopReason === 'max_output_tokens',
    metadata: {
      duration_ms: 0,
      compactable: false,
    },
  };
}
