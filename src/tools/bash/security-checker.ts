/**
 * BashSecurityChecker（L3-M3 §2.2.5 + §3.4）
 *
 * 24 项安全校验 + Risk Classifier Fast 阶段决策。
 * 包装 BashCommandAnalyzer，输出 allow/deny/ask 决策。
 *
 * 决策阈值（L3-M3 §3.4.1）：
 * - riskScore >= 0.8 → deny（明确危险）
 * - riskScore 0.5-0.8 → ask（中等风险，需用户确认）
 * - riskScore < 0.5 → allow（明确安全）
 *
 * 不变量 #8（五层纵深防御链任一层可独立拦截）：
 * - bypassPermissions 模式下，riskScore >= 0.8 仍 deny
 * - 即使用户显式授权绕过，也不放过高风险命令
 *
 * 同时作为 M4 Risk Classifier Fast 阶段的规则表来源（L3-M3 §3.4.4）。
 */

import type { PermissionMode } from '../../types/index.js';
import {
  analyzeBashCommand,
  type AnalyzeBashOptions,
  type BashAnalysisResult,
} from './analyzer.js';

/** BashSecurityChecker.check 返回值 */
export interface BashSecurityCheckResult {
  /** 风险评分 0-1 */
  riskScore: number;
  /** 命中的 24 项规则 ID（C01-C24 / PARSE_ERROR） */
  matchedRules: string[];
  /** 决策建议（allow / deny / ask） */
  recommendation: 'allow' | 'deny' | 'ask';
  /** 完整分析结果（供审计日志与用户提示） */
  analysis: BashAnalysisResult;
  /** 决策原因（用于审计日志与用户提示） */
  reason: string;
}

/** 风险阈值常量（L3-M3 §3.4.1） */
export const RISK_THRESHOLD_DENY = 0.8;
export const RISK_THRESHOLD_ASK = 0.5;

export class BashSecurityChecker {
  constructor(private opts: AnalyzeBashOptions = {}) {}

  /**
   * 校验 bash 命令并给出决策建议
   *
   * @param command 原始 bash 命令字符串
   * @param ctx 工具上下文（用于 permissionMode 判断）
   * @returns BashSecurityCheckResult
   */
  check(command: string, ctx?: { permissionMode?: PermissionMode }): BashSecurityCheckResult {
    // 1. AST 解析 + 24 规则匹配 + 风险评分
    const analysis = analyzeBashCommand(command, this.opts);

    // 2. 决策阈值
    let recommendation: 'allow' | 'deny' | 'ask';
    if (analysis.riskScore >= RISK_THRESHOLD_DENY) {
      recommendation = 'deny';
    } else if (analysis.riskScore >= RISK_THRESHOLD_ASK) {
      recommendation = 'ask';
    } else {
      recommendation = 'allow';
    }

    // 3. bypassPermissions 模式：仍校验高风险（不变量 #8）
    if (ctx?.permissionMode === 'bypassPermissions' && analysis.riskScore >= RISK_THRESHOLD_DENY) {
      recommendation = 'deny';
    }

    // 4. 原因说明
    const reason = this.buildReason(analysis, recommendation, ctx?.permissionMode);

    return {
      riskScore: analysis.riskScore,
      matchedRules: analysis.matchedRules,
      recommendation,
      analysis,
      reason,
    };
  }

  /** 构建决策原因（用于审计日志 + 用户提示） */
  private buildReason(
    analysis: BashAnalysisResult,
    recommendation: 'allow' | 'deny' | 'ask',
    permissionMode?: PermissionMode,
  ): string {
    if (analysis.parseError) {
      return `parse error: command syntax could not be analyzed (fail-closed deny)`;
    }

    const parts: string[] = [];

    if (analysis.matchedRules.length > 0) {
      parts.push(`matched rules: ${analysis.matchedRules.join(', ')}`);
    }
    if (analysis.injectionPatterns.length > 0) {
      parts.push(`injection patterns: ${analysis.injectionPatterns.join(', ')}`);
    }
    if (analysis.hasNetworkCommand) {
      parts.push('contains network command');
    }
    if (analysis.commandList.length > 0) {
      parts.push(`commands: ${analysis.commandList.join(', ')}`);
    }

    const ctx =
      permissionMode === 'bypassPermissions' && recommendation === 'deny'
        ? ' (bypassPermissions mode still denies high-risk)'
        : '';

    if (parts.length === 0) {
      return `no risk indicators${ctx}`;
    }
    return parts.join('; ') + ctx;
  }
}

/**
 * 快速判定：是否需要进入 Risk Classifier Thinking 阶段（M4 LLM 评估）
 *
 * Fast 阶段（规则表）能明确判断的返回最终决策；
 * 否则返回 ask 并触发 Thinking 阶段。
 *
 * 阈值（L3-M3 §3.4.4）：
 * - riskScore >= 0.8 → deny（Fast 阶段终结）
 * - riskScore < 0.5 → allow（Fast 阶段终结）
 * - 0.5 ≤ riskScore < 0.8 → ask（触发 Thinking 阶段）
 */
export function shouldEscalateToThinking(result: BashSecurityCheckResult): boolean {
  return result.recommendation === 'ask';
}
