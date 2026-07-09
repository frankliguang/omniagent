/**
 * BashTool（L3-M3 §2.2.13 — bash）
 *
 * bash 命令执行工具。集成 24 项安全校验（BashSecurityChecker）+ 超时 + abort 信号。
 *
 * M1 迭代 2 范围：
 * - 24 项校验通过 BashSecurityChecker 实现（Fast 阶段决策）
 * - 实际执行：child_process.spawn（不集成 sandbox-exec / bubblewrap，M3 完整版接入）
 * - 超时：默认 120s，可配置
 * - abort 信号：通过 ctx.abortSignal 传播到 child_process
 *
 * 安全决策流程（L3-M3 §3.4）：
 * 1. checkPermissions() 调 BashSecurityChecker.check() → 返回 allow/deny/ask
 * 2. call() 内再次校验（防止 checkPermissions 与 call 间状态变化）
 * 3. deny → 直接返回错误，不执行
 * 4. allow/ask → 实际执行（ask 由 M2 ReAct Loop 在 TOOL_EXECUTE 前处理用户确认）
 */

import { spawn } from 'node:child_process';

import type { PermissionDecision, ToolInput, ToolResult } from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';
import { BashSecurityChecker } from '../../bash/security-checker.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;  // 10 分钟硬上限
const MAX_OUTPUT_BYTES = 1_000_000;  // 1MB stdout 截断

/** 共享 checker 实例（无状态，可全局复用） */
const sharedChecker = new BashSecurityChecker();

export const BashTool = buildTool({
  name: 'bash',
  description:
    'Execute a bash command. Subject to 24-item security check (BashSecurityChecker). ' +
    'Returns stdout (max 1MB, truncated) + exit code. Default timeout 120s, max 600s. ' +
    'Supports abort via ctx.abortSignal. High-risk commands (rm -rf /, dd to device, fork bomb, ' +
    'pipe exfil, env injection, etc.) are denied even in bypassPermissions mode.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Bash command to execute. Subject to 24-item security check.',
      },
      timeout: {
        type: 'integer',
        description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms.`,
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  isReadOnly: false,
  isDestructive: true,            // 默认破坏性（fail-closed）
  isConcurrencySafe: false,       // bash 命令可能修改共享状态
  isBackground: true,             // 可后台化（长命令）

  checkPermissions(input: ToolInput): PermissionDecision {
    const command = (input.command as string) ?? '';
    if (!command.trim()) {
      return {
        decision: 'deny',
        reason: 'bash: empty command',
        matchedRule: 'input-validation',
        layer: 2,
      };
    }
    // M1 stub：调用 BashSecurityChecker 做静态分析
    // 注意：此处无 ctx.permissionMode（checkPermissions 不接收 ctx），故使用默认模式
    // 实际 permissionMode 由 M2 ReAct Loop 在 TOOL_EXECUTE 时通过 M4 注入
    const result = sharedChecker.check(command);
    return {
      decision: result.recommendation,
      reason: `riskScore=${result.riskScore.toFixed(2)}, rules=${result.matchedRules.join(',') || 'none'}, ${result.reason}`,
      matchedRule: result.matchedRules[0] ?? 'none',
      layer: 2,
    };
  },

  async call(input: ToolInput, ctx): Promise<ToolResult> {
    const startMs = Date.now();
    const toolUseId = ctx.toolUseId ?? ('' as ToolResult['tool_use_id']);
    const command = (input.command as string) ?? '';
    const timeoutMs = Math.min(
      Math.max(1, (input.timeout as number) ?? DEFAULT_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );

    if (!command.trim()) {
      return errorResult(toolUseId, 'bash: command is required', { duration_ms: Date.now() - startMs });
    }

    // 1. 24 项安全校验（前置，防止 checkPermissions 与 call 间状态变化）
    const check = sharedChecker.check(command, { permissionMode: ctx.permissionMode });
    if (check.recommendation === 'deny') {
      return errorResult(
        toolUseId,
        `bash: denied by security check (riskScore=${check.riskScore.toFixed(2)}, rules=${check.matchedRules.join(',')}). ` +
          `Command not executed. Reason: ${check.reason}`,
        { duration_ms: Date.now() - startMs },
      );
    }

    // 2. 执行命令（child_process.spawn + bash -c）
    try {
      const { stdout, exitCode, durationMs } = await executeBash(command, {
        cwd: ctx.cwd,
        timeoutMs,
        abortSignal: ctx.abortSignal,
      });

      // 截断超长输出
      const truncated = stdout.length > MAX_OUTPUT_BYTES;
      const display = truncated
        ? stdout.slice(0, MAX_OUTPUT_BYTES) + `\n...[truncated, ${stdout.length - MAX_OUTPUT_BYTES} more bytes]`
        : stdout;

      const footer = `\n\n[exit ${exitCode}, ${durationMs}ms]`;
      const text = display + footer;

      if (exitCode === 0) {
        return okResult(toolUseId, text, { compactable: true, duration_ms: durationMs });
      }
      return errorResult(toolUseId, text, { duration_ms: durationMs });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { name?: string };
      if (e.name === 'AbortError' || ctx.abortSignal?.aborted) {
        return errorResult(toolUseId, 'bash: aborted by user', { duration_ms: Date.now() - startMs });
      }
      if ((e as { code?: string }).code === 'ETIMEDOUT') {
        return errorResult(toolUseId, `bash: command timed out after ${timeoutMs}ms`, { duration_ms: Date.now() - startMs });
      }
      return errorResult(toolUseId, `bash: ${(e as Error).message}`, { duration_ms: Date.now() - startMs });
    }
  },
});

// ============================================================
// 命令执行（child_process.spawn）
// ============================================================

interface ExecuteResult {
  stdout: string;
  exitCode: number;
  durationMs: number;
}

interface ExecuteOptions {
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

function executeBash(command: string, opts: ExecuteOptions): Promise<ExecuteResult> {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const child = spawn('bash', ['-c', command], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],  // stdin 忽略，stdout/stderr 捕获
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // 超时处理
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const err = new Error(`command timed out after ${opts.timeoutMs}ms`) as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      err.name = 'TimeoutError';
      reject(err);
    }, opts.timeoutMs);

    // abort 信号处理
    let onAbort: (() => void) | undefined;
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        child.kill('SIGKILL');
        const err = new Error('aborted by user') as NodeJS.ErrnoException;
        err.name = 'AbortError';
        clearTimeout(timer);
        reject(err);
        return;
      }
      onAbort = () => {
        child.kill('SIGKILL');
        const err = new Error('aborted by user') as NodeJS.ErrnoException;
        err.name = 'AbortError';
        clearTimeout(timer);
        reject(err);
      };
      opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (onAbort && opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', onAbort);
      }
      const durationMs = Date.now() - startMs;
      // 合并 stdout + stderr（stderr 追加在末尾，便于诊断）
      const combined = stderr ? stdout + `\n[stderr]\n${stderr}` : stdout;
      // 信号终止（如 SIGKILL）→ 非零退出码
      const exitCode = code ?? (signal ? 128 + 1 : 1);
      resolve({ stdout: combined, exitCode, durationMs });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      if (onAbort && opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', onAbort);
      }
      // spawn 失败（如 bash 不存在）
      const e = err as NodeJS.ErrnoException;
      if (!e.code) e.code = 'EBASH_SPAWN_FAILED';
      reject(e);
    });
  });
}
