/**
 * GrepTool（L3-M3 §2.3.5 — grep）
 *
 * 文件内容搜索。基于正则表达式。
 * 不依赖外部 ripgrep 二进制（M1 stub 自实现，M3 完整版可 wrap ripgrep）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { PermissionDecision, ToolInput, ToolResult } from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';

const MAX_MATCHES = 500;
const MAX_FILE_BYTES = 5_000_000;  // 单文件最大 5MB（防 OOM）
const MAX_LINE_BYTES = 10_000;     // 跳过超长行（减少 ReDoS 回溯燃料）

// ReDoS 防护：拒绝嵌套量词模式（如 (a+)+, (a*)*, (a+)?）
// 这类模式在特定输入下会导致指数级回溯，同步 regex.test() 会挂死事件循环。
// 启发式：捕获组内含 +/*/?，且紧随其后又有 +/*/? 即视为可疑。
const NESTED_QUANTIFIER_RE = /\([^()]*[+*?][^()]*\)[+*?{]/;

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

async function walk(dir: string, ignoreDirs: Set<string>, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ignoreDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, ignoreDirs, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

export const GrepTool = buildTool({
  name: 'grep',
  description:
    'Search file contents using regular expressions. Returns matching lines with file paths and line numbers. ' +
    'Supports case-insensitive search and file glob filtering.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for.',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search in. Default: cwd.',
      },
      glob: {
        type: 'string',
        description: 'File glob filter (e.g., "*.ts"). Only matching files are searched.',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'If true, perform case-insensitive search. Default: false.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,

  checkPermissions(_input: ToolInput): PermissionDecision {
    return { decision: 'allow', matchedRule: 'm1-stub', layer: 2 };
  },

  async call(input: ToolInput, ctx): Promise<ToolResult> {
    const startMs = Date.now();
    const toolUseId = ctx.toolUseId ?? ('' as ToolResult['tool_use_id']);
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) ?? ctx.cwd;
    const fileGlob = input.glob as string | undefined;
    const caseInsensitive = (input.case_insensitive as boolean) ?? false;

    if (!pattern) {
      return errorResult(toolUseId, 'grep: pattern is required', { duration_ms: Date.now() - startMs });
    }

    // ReDoS 防护：拒绝嵌套量词模式
    if (NESTED_QUANTIFIER_RE.test(pattern)) {
      return errorResult(
        toolUseId,
        'grep: pattern rejected (potential ReDoS: nested quantifiers like (a+)+ can cause catastrophic backtracking). ' +
          'Refactor the pattern to avoid nested quantifiers on overlapping character classes.',
        { duration_ms: Date.now() - startMs },
      );
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
    } catch (err) {
      return errorResult(toolUseId, `grep: invalid regex: ${(err as Error).message}`, { duration_ms: Date.now() - startMs });
    }

    // glob filter 转 RegExp
    let globRe: RegExp | undefined;
    if (fileGlob) {
      // 复用 glob tool 的转换逻辑（简化版）
      let re = '';
      for (let i = 0; i < fileGlob.length; i++) {
        const c = fileGlob[i];
        if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
        else re += c;
      }
      globRe = new RegExp(re + '$');
    }

    try {
      const stat = await fs.stat(searchPath);
      const files: string[] = [];

      if (stat.isFile()) {
        files.push(searchPath);
      } else if (stat.isDirectory()) {
        const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage']);
        await walk(searchPath, ignoreDirs, files);
      } else {
        return errorResult(toolUseId, `grep: ${searchPath} is not a file or directory`, { duration_ms: Date.now() - startMs });
      }

      const matches: GrepMatch[] = [];

      for (const file of files) {
        if (matches.length >= MAX_MATCHES) break;
        if (globRe && !globRe.test(path.basename(file))) continue;

        try {
          const fileStat = await fs.stat(file);
          if (fileStat.size > MAX_FILE_BYTES) continue;

          const content = await fs.readFile(file, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= MAX_MATCHES) break;
            // 跳过超长行：减少 ReDoS 触发面 + 避免内存膨胀
            if (Buffer.byteLength(lines[i], 'utf8') > MAX_LINE_BYTES) continue;
            if (regex.test(lines[i])) {
              matches.push({ file, line: i + 1, text: lines[i] });
            }
          }
        } catch {
          // 跳过无法读取的文件（二进制 / 权限）
        }
      }

      if (matches.length === 0) {
        return okResult(toolUseId, 'grep: no matches found', { compactable: true, duration_ms: Date.now() - startMs });
      }

      const truncated = matches.length >= MAX_MATCHES;
      const display = matches
        .map(m => `${m.file}:${m.line}:${m.text.length > 200 ? m.text.slice(0, 200) + '...' : m.text}`)
        .join('\n');
      const footer = truncated
        ? `\n\n(${MAX_MATCHES} of more matches shown; refine pattern for more)`
        : `\n\n(${matches.length} matches in ${new Set(matches.map(m => m.file)).size} files)`;

      return okResult(toolUseId, display + footer, { compactable: true, duration_ms: Date.now() - startMs });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return errorResult(toolUseId, `grep: path not found: ${searchPath}`, { duration_ms: Date.now() - startMs });
      }
      return errorResult(toolUseId, `grep: ${(err as Error).message}`, { duration_ms: Date.now() - startMs });
    }
  },
});
