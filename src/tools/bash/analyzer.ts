/**
 * BashCommandAnalyzer（L3-M3 §2.2.6 + L2 §8.2）
 *
 * shell-quote 1.9.0 适配版：parse 返回扁平数组 (string | ControlOperator | GlobPattern | Comment)[]
 * 不再假设嵌套 AST 节点（node.nodes / node.command / node.suffix / node.block / node.commands）
 *
 * 分析维度：
 * 1. AST 操作符检测（; / && / || / | / & / < / > / >> / << / <( / >( / ( / )）
 * 2. 命令名提取（NETWORK_COMMANDS / eval 系检测）
 * 3. 命令替换检测（$() / 反引号，shell-quote 1.9.0 不解析为 op，需 regex 补充）
 * 4. Here-doc 检测（<<EOF / <<-EOF，shell-quote 1.9.0 不解析为 op，需 regex 补充）
 * 5. 环境变量展开检测（${VAR} / $VAR，shell-quote 1.9.0 不展开则需 regex 补充）
 * 6. 24 项 bashSecurity 规则匹配（BASH_SECURITY_RULES）
 * 7. computeRiskScore 综合评分
 *
 * fail-closed：解析失败 → riskScore=1（保守，命令语法错误可能是有意混淆）
 */

import { parse as parseShell } from 'shell-quote';

import {
  BASH_SECURITY_RULES,
  NETWORK_COMMANDS,
  SENSITIVE_ENV_VARS,
  type BashSecurityRule,
} from './rules.js';

// ============================================================
// 类型定义
// ============================================================

/** Bash 命令分析结果（L3-M3 §2.2.6 BashAnalysisResult） */
export interface BashAnalysisResult {
  /** shell-quote 解析的扁平 AST（不嵌套，原样返回供审计） */
  ast: unknown[];
  /** 风险评分 0-1，1 = 最危险 */
  riskScore: number;
  /** 命中的 24 项 bashSecurity 规则 ID */
  matchedRules: string[];
  /** 检测到的注入模式（sequence / pipe / command_substitution / process_substitution / heredoc / redirect / background / subshell / dynamic_exec / sensitive_env） */
  injectionPatterns: string[];
  /** 提取的所有命令名（用于黑名单匹配） */
  commandList: string[];
  /** 是否含 curl/wget/nc/ssh 等网络命令 */
  hasNetworkCommand: boolean;
  /** 是否解析失败（fail-closed 标记） */
  parseError: boolean;
}

/** analyzeBashCommand 入参 */
export interface AnalyzeBashOptions {
  /** 自定义规则表（默认 BASH_SECURITY_RULES；测试时可注入） */
  rules?: BashSecurityRule[];
  /** 自定义 shell-quote parser（默认 parseShell；测试时可注入抛异常的 mock） */
  parser?: (input: string) => unknown[];
}

// ============================================================
// 常量（L2 §8.2.4）
// ============================================================

/** 命令替换检测：$() 或反引号 */
const COMMAND_SUBSTITUTION_RE = /\$\([^)]*\)|`[^`]+`/;

/** Here-doc 检测：<<EOF 或 <<-EOF */
const HEREDOC_RE = /<<-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/;

/** 环境变量展开检测：${VAR} 或 $VAR */
const ENV_VAR_EXPANSION_RE = /\$\{(\w+)\}|\$(\w+)/g;

/** 敏感环境变量赋值检测：VAR=value 前缀（PATH=...: LD_PRELOAD=... 等） */
const SENSITIVE_ENV_ASSIGNMENT_RE = /\b([A-Z][A-Z0-9_]*)\s*=/g;

/** 命令名提取：第一个非选项 token */
const COMMAND_NAME_RE = /^([a-zA-Z_][\w.-]*)$/;

// ============================================================
// 主函数
// ============================================================

/**
 * 分析 bash 命令字符串，返回风险评估结果
 *
 * @param command 原始命令字符串
 * @param opts 可选配置（自定义规则表）
 * @returns BashAnalysisResult
 */
export function analyzeBashCommand(command: string, opts: AnalyzeBashOptions = {}): BashAnalysisResult {
  const rules = opts.rules ?? BASH_SECURITY_RULES;
  const parser = opts.parser ?? parseShell;
  const commandStr = command.trim();

  const matchedRules: string[] = [];
  const injectionPatterns: string[] = [];
  const commandList: string[] = [];
  let hasNetworkCommand = false;
  let parseError = false;

  // ----------------------------------------------------------
  // 1. shell-quote 解析（fail-closed：异常 → riskScore=1）
  // ----------------------------------------------------------
  let ast: unknown[] = [];
  try {
    ast = parser(commandStr);
  } catch {
    // 解析失败 → 返回最保守结果
    return {
      ast: [],
      riskScore: 1,
      matchedRules: ['PARSE_ERROR'],
      injectionPatterns: ['parse_error'],
      commandList: [],
      hasNetworkCommand: true,
      parseError: true,
    };
  }

  // ----------------------------------------------------------
  // 2. 扁平 AST 遍历（shell-quote 1.9.0 不嵌套）
  // ----------------------------------------------------------
  let expectingCommand = true; // 下一个 string 节点（非选项）应是命令名
  for (const node of ast) {
    if (typeof node === 'string') {
      // string 节点：可能是命令名 / 选项 / 参数
      if (expectingCommand && COMMAND_NAME_RE.test(node)) {
        commandList.push(node);
        if (NETWORK_COMMANDS.has(node)) hasNetworkCommand = true;
        if (node === 'eval' || node === 'source' || node === '.') {
          injectionPatterns.push(`dynamic_exec_${node}`);
        }
        expectingCommand = false;
      } else if (node.startsWith('-')) {
        // 选项，不重置 expectingCommand
      } else {
        // 参数，命令结束后遇到非选项 string
        expectingCommand = false;
      }
      continue;
    }

    if (typeof node !== 'object' || node === null) continue;

    // ControlOperator: { op: '||' | '&&' | ... }
    const op = (node as { op?: string }).op;
    if (typeof op === 'string') {
      // 顺序操作符 → 下一个 string 是命令名
      if (op === ';' || op === '&&' || op === '||' || op === '|' || op === '&' || op === '|&') {
        if (op === ';' || op === '&&' || op === '||') {
          injectionPatterns.push(`sequence_${op}`);
        }
        if (op === '|' || op === '|&') {
          injectionPatterns.push('pipe');
        }
        if (op === '&') {
          injectionPatterns.push('background');
        }
        expectingCommand = true;
      }
      // 重定向
      if (op === '>' || op === '>>' || op === '<' || op === '>&' || op === '<&' || op === '<<<') {
        injectionPatterns.push(`redirect_${op}`);
      }
      // 进程替换（shell-quote 1.9.0 仅识别 <( ，不识别 >( ）
      if (op === '<(') {
        injectionPatterns.push('process_substitution');
      }
      // 子 shell
      if (op === '(' || op === ')') {
        injectionPatterns.push('subshell');
        if (op === '(') expectingCommand = true;
      }
      continue;
    }

    // GlobPattern: { op: 'glob', pattern: 'xxx' } — 不视为注入
    // Comment: { comment: 'xxx' } — 不视为注入
  }

  // ----------------------------------------------------------
  // 3. 命令替换检测（shell-quote 1.9.0 不解析 $() 与反引号）
  // ----------------------------------------------------------
  if (COMMAND_SUBSTITUTION_RE.test(commandStr)) {
    injectionPatterns.push('command_substitution');
  }

  // ----------------------------------------------------------
  // 4. Here-doc 检测（shell-quote 1.9.0 不解析 <<EOF）
  // ----------------------------------------------------------
  if (HEREDOC_RE.test(commandStr)) {
    injectionPatterns.push('heredoc');
  }

  // ----------------------------------------------------------
  // 5. 环境变量展开检测（敏感变量赋值 + 引用）
  // ----------------------------------------------------------
  // 5a. 敏感变量赋值前缀（PATH=...:$PATH）
  let match: RegExpExecArray | null;
  const assignmentRe = new RegExp(SENSITIVE_ENV_ASSIGNMENT_RE.source, 'g');
  while ((match = assignmentRe.exec(commandStr)) !== null) {
    const varName = match[1];
    if (SENSITIVE_ENV_VARS.has(varName)) {
      injectionPatterns.push(`sensitive_env_${varName}`);
    }
  }

  // 5b. 敏感变量引用（${PATH} / $PATH）
  const refRe = new RegExp(ENV_VAR_EXPANSION_RE.source, 'g');
  while ((match = refRe.exec(commandStr)) !== null) {
    const varName = match[1] ?? match[2];
    if (varName && SENSITIVE_ENV_VARS.has(varName)) {
      injectionPatterns.push(`sensitive_env_ref_${varName}`);
    }
  }

  // ----------------------------------------------------------
  // 6. 24 项 bashSecurity 规则匹配（对原始命令字符串）
  // ----------------------------------------------------------
  for (const rule of rules) {
    if (rule.pattern.test(commandStr)) {
      matchedRules.push(rule.id);
    }
  }

  // ----------------------------------------------------------
  // 7. 风险评分（综合 AST 注入模式 + 规则匹配）
  // ----------------------------------------------------------
  const riskScore = computeRiskScore({
    matchedRules,
    injectionPatterns,
    hasNetworkCommand,
    parseError,
  });

  return {
    ast,
    riskScore,
    matchedRules,
    injectionPatterns,
    commandList,
    hasNetworkCommand,
    parseError,
  };
}

// ============================================================
// 风险评分（L2 §8.2.2 computeRiskScore）
// ============================================================

export interface RiskScoreInput {
  matchedRules: string[];
  injectionPatterns: string[];
  hasNetworkCommand: boolean;
  parseError: boolean;
}

/**
 * 综合风险评分
 *
 * 评分层次（高优先级先返回）：
 * 1. 命中规则表（非 PARSE_ERROR）→ 1.0（最高，明确危险）
 * 2. 解析失败 → 0.9（命令语法错误可能是有意混淆）
 * 3. 网络命令 + 管道/命令替换 → 0.8（exfil 模式）
 * 4. eval/source 动态执行 → 0.8（绕过静态分析）
 * 5. 命令替换 / 进程替换 → 0.6（注入风险）
 * 6. 管道 + 网络命令 → 0.5（潜在 exfil）
 * 7. here-doc / 重定向 → 0.4（潜在注入）
 * 8. 敏感环境变量 → 0.3（注入风险）
 * 9. 简单命令（无注入模式）→ 0
 */
export function computeRiskScore(input: RiskScoreInput): number {
  // 命中规则表 → 最高风险
  if (input.matchedRules.length > 0 && !input.matchedRules.includes('PARSE_ERROR')) {
    return 1;
  }
  // 解析失败 → 高风险
  if (input.parseError) return 0.9;
  // 有网络命令 + 命令替换/管道 → 高风险（exfil 模式）
  if (
    input.hasNetworkCommand &&
    (input.injectionPatterns.includes('pipe') ||
      input.injectionPatterns.includes('command_substitution'))
  ) {
    return 0.8;
  }
  // eval/source 动态执行 → 高风险
  if (input.injectionPatterns.some(p => p.startsWith('dynamic_exec_'))) return 0.8;
  // 命令替换 / 进程替换 → 中高风险
  if (
    input.injectionPatterns.includes('command_substitution') ||
    input.injectionPatterns.includes('process_substitution')
  ) {
    return 0.6;
  }
  // 管道 + 网络命令 → 中风险
  if (input.injectionPatterns.includes('pipe') && input.hasNetworkCommand) return 0.5;
  // here-doc / 重定向 → 中风险
  if (
    input.injectionPatterns.includes('heredoc') ||
    input.injectionPatterns.some(p => p.startsWith('redirect_'))
  ) {
    return 0.4;
  }
  // 子 shell / 后台 / 顺序操作 → 中低风险
  if (
    input.injectionPatterns.includes('subshell') ||
    input.injectionPatterns.includes('background') ||
    input.injectionPatterns.some(p => p.startsWith('sequence_'))
  ) {
    return 0.3;
  }
  // 敏感环境变量 → 中低风险
  if (
    input.injectionPatterns.some(p => p.startsWith('sensitive_env_')) ||
    input.injectionPatterns.some(p => p.startsWith('sensitive_env_ref_'))
  ) {
    return 0.3;
  }
  // 简单命令 → 低风险
  return 0;
}

// ============================================================
// 便捷方法
// ============================================================

/** 判断命令是否危险（riskScore >= 0.8 视为 deny） */
export function isDangerous(result: BashAnalysisResult): boolean {
  return result.riskScore >= 0.8;
}

/** 判断命令是否需要 ask（0.3 < riskScore < 0.8） */
export function shouldAsk(result: BashAnalysisResult): boolean {
  return result.riskScore > 0.3 && result.riskScore < 0.8;
}

/** 提取命令简短摘要（用于权限提示） */
export function summarizeCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 77) + '...';
}
