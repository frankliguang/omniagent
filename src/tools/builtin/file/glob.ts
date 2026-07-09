/**
 * GlobTool（L3-M3 §2.3.4 — glob）
 *
 * 文件名模式匹配。基于 minimatch 语法（如 .ts 扩展、跨目录通配、src 子树）。
 * 不读取文件内容，仅返回路径列表。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { PermissionDecision, ToolInput, ToolResult } from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';

const MAX_RESULTS = 1000;

/** minimatch 兼容的 glob → RegExp 转换（简化版，支持 * / ** / ?） */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // ** = 跨目录通配
      re += '.*';
      i += 2;
      // 吃掉后跟的 /
      if (pattern[i] === '/') i++;
    } else if (c === '*') {
      // * = 单层通配（不含 /）
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '.') {
      re += '\\.';
      i++;
    } else if ('+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/** 递归遍历目录，收集匹配的文件路径 */
async function walk(dir: string, base: string, patterns: RegExp[], results: string[], ignoreDirs: Set<string>): Promise<void> {
  if (results.length >= MAX_RESULTS) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ignoreDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(base, fullPath);

    if (entry.isDirectory()) {
      await walk(fullPath, base, patterns, results, ignoreDirs);
    } else if (entry.isFile()) {
      // 任意一个 pattern 匹配即加入结果
      for (const re of patterns) {
        if (re.test(relPath) || re.test(entry.name)) {
          results.push(fullPath);
          break;
        }
      }
      if (results.length >= MAX_RESULTS) return;
    }
  }
}

export const GlobTool = buildTool({
  name: 'glob',
  description:
    'Find files matching one or more glob patterns. Returns matching file paths sorted by modification time (most recent first). ' +
    'Supports patterns like "**/*.ts" or "src/*.js". Does not read file contents.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.js").',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Default: cwd.',
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
    const searchDir = (input.path as string) ?? ctx.cwd;

    if (!pattern) {
      return errorResult(toolUseId, 'glob: pattern is required', { duration_ms: Date.now() - startMs });
    }

    // 支持多 pattern（空格分隔或数组）
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    const regexes = patterns.map((p: string) => globToRegExp(p));

    const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage']);

    try {
      const results: string[] = [];
      await walk(searchDir, searchDir, regexes, results, ignoreDirs);

      // 按修改时间排序（最新在前）
      const withMtime = await Promise.all(
        results.map(async p => {
          try {
            const stat = await fs.stat(p);
            return { path: p, mtime: stat.mtimeMs };
          } catch {
            return { path: p, mtime: 0 };
          }
        }),
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const sorted = withMtime.map(x => x.path);

      if (sorted.length === 0) {
        return okResult(toolUseId, 'glob: no files matched', { compactable: true, duration_ms: Date.now() - startMs });
      }

      const truncated = sorted.length >= MAX_RESULTS;
      const display = (truncated ? sorted.slice(0, MAX_RESULTS) : sorted).join('\n');
      const footer = truncated ? `\n\n(${MAX_RESULTS} of ${sorted.length}+ results shown; refine pattern for more)` : `\n\n(${sorted.length} files matched)`;

      return okResult(toolUseId, display + footer, { compactable: true, duration_ms: Date.now() - startMs });
    } catch (err) {
      return errorResult(toolUseId, `glob: ${(err as Error).message}`, { duration_ms: Date.now() - startMs });
    }
  },
});
