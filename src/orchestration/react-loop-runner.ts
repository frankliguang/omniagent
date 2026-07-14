/**
 * ReActLoopSubAgentRunner（L3-M5 §2.2.4 — M2 iter 5）
 *
 * 把 ReActLoop 包装为 SubAgentRunner，让 CoordinatorMode / ForkAgentSpawner
 * 通过统一的 SubAgentRunner 接口调用实际 ReActLoop。
 *
 * M2 iter 1-4：SubAgentRunner 仅有 mock 实现（ConcurrentMockRunner），
 * CoordinatorMode 注入的是 mock runner。
 * M2 iter 5：实现真实 runner，CLI 入口可注入此 runner，
 * agent_router(sync/async) 路径实际跑通子 agent ReActLoop。
 *
 * 职责：
 * - 接收 {prompt, sidechainId, parentAgentId}
 * - 调用 ReActLoop.runTurn(prompt)
 * - 将 TurnResult.messages 写入 sidechain（按顺序 append）
 * - 返回 SubAgentTurnResult {stopReason, iterations, finalText}
 *
 * 不变量 #5（fork prompt cache prefix byte-identical）：
 * - fork 路径在 ForkAgentSpawner 内已注入 initialMessages 到 sidechain
 * - 本 runner 只追加 turn 后产生的新消息，不修改 prefix
 */

import type { AgentId, UUID, Message } from '../types/index.js';
import type { ReActLoop, TurnResult } from '../core/react-loop.js';
import type { SidechainManager } from '../memory/sidechain.js';
import type {
  SubAgentRunner,
  SubAgentRunnerFactory,
  SubAgentTurnResult,
} from './sub-agent-runner.js';

/** 构造依赖 */
export interface ReActLoopRunnerDeps {
  sidechain: SidechainManager;
  /** ReActLoop 工厂（每个 sidechainId 一个独立 loop，独立 WorkingMemory） */
  makeLoop: (sidechainId: UUID, parentAgentId: AgentId) => ReActLoop;
}

/**
 * ReActLoopSubAgentRunner：把 ReActLoop 适配为 SubAgentRunner
 *
 * 每次 runTurn 创建新的 ReActLoop（共享 provider/tools，独立 WorkingMemory），
 * 跑完后把 messages 写入 sidechain。
 */
export class ReActLoopSubAgentRunner implements SubAgentRunner {
  constructor(private readonly deps: ReActLoopRunnerDeps) {}

  async runTurn(params: {
    prompt: string;
    sidechainId: UUID;
    parentAgentId: AgentId;
  }): Promise<SubAgentTurnResult> {
    const loop = this.deps.makeLoop(params.sidechainId, params.parentAgentId);
    let turn: TurnResult;
    try {
      turn = await loop.runTurn(params.prompt);
    } catch (err) {
      return {
        stopReason: 'failed',
        iterations: 0,
        finalText: '',
        error: (err as Error).message,
      };
    }

    // 持久化 turn 产生的 messages 到 sidechain（不变量 #5：只追加，不修改 prefix）
    for (const msg of turn.messages) {
      await this.deps.sidechain.append(params.sidechainId, msg as Message);
    }

    // 提取最后一条 assistant 消息的文本作为 finalText
    const finalText = extractFinalAssistantText(turn.messages);

    return {
      stopReason: turn.stopReason,
      iterations: turn.iterations,
      finalText,
    };
  }
}

/** 从 TurnResult.messages 末尾找最后一条 assistant 文本 */
function extractFinalAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant') {
      const textBlocks = m.content.filter(
        (b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: string }).text === 'string',
      );
      if (textBlocks.length > 0) {
        return textBlocks.map(b => b.text).join('');
      }
    }
  }
  return '';
}

/**
 * 工厂函数：返回 SubAgentRunnerFactory
 *
 * CoordinatorMode / Orchestrator 注入此 factory，每次 spawn 时按 sidechainId 创建独立 runner。
 */
export function makeReActLoopRunnerFactory(deps: ReActLoopRunnerDeps): SubAgentRunnerFactory {
  return (_sidechainId: UUID) => new ReActLoopSubAgentRunner(deps);
}
