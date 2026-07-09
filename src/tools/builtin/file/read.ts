/**
 * FileReadTool（L3-M3 §2.3.1 — read_file）
 *
 * 读取文件内容，返回带行号的文本。
 * 支持 offset + limit 分页读取大文件。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { PermissionDecision, ToolInput, ToolResult } from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';

const MAX_READ_BYTES = 200_000;  // 200KB 默认上限（防 OOM）

export const FileReadTool = buildTool({
  name: 'read_file',
  description:
    'Read the contents of a text file. Returns content with line number prefixes (1-based). ' +
    'Use offset and limit to paginate large files. Default limit is 2000 lines.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to read. Relative paths are resolved against cwd.',
      },
      offset: {
        type: 'integer',
        description: 'Line number to start reading from (1-based). Default: 1.',
        minimum: 1,
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of lines to read. Default: 2000.',
        minimum: 1,
      },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,

  checkPermissions(_input: ToolInput): PermissionDecision {
    // M1 stub：read_file 默认 allow（M3 完整版走 M4 五层拦截）
    // M4 接入后：检查路径白名单 + read-only 权限规则
    return { decision: 'allow', matchedRule: 'm1-stub', layer: 2 };
  },

  async call(input: ToolInput, ctx): Promise<ToolResult> {
    const startMs = Date.now();
    const toolUseId = ctx.toolUseId ?? ('' as ToolResult['tool_use_id']);
    const filePath = input.file_path as string;
    if (!filePath) {
      return errorResult(toolUseId, 'read_file: file_path is required', { duration_ms: Date.now() - startMs });
    }

    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx?.cwd ?? process.cwd(), filePath);
    const offset = Math.max(1, (input.offset as number) ?? 1);
    const limit = Math.min(2000, (input.limit as number) ?? 2000);

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        return errorResult(toolUseId, `read_file: ${filePath} is not a regular file`, { duration_ms: Date.now() - startMs });
      }
      if (stat.size > MAX_READ_BYTES * 2) {
        // 超大文件：强制走 offset/limit 分页，提示用户
        return errorResult(
          toolUseId,
          `read_file: file is ${stat.size} bytes, too large. Use offset/limit to paginate.`,
          { duration_ms: Date.now() - startMs },
        );
      }

      const content = await fs.readFile(resolved, 'utf8');
      const lines = content.split('\n');
      const startIdx = offset - 1;
      const endIdx = Math.min(lines.length, startIdx + limit);
      const selected = lines.slice(startIdx, endIdx);

      // 带行号格式（与 cat -n 一致）
      const numbered = selected
        .map((line, i) => `${String(startIdx + i + 1).padStart(6, ' ')}\t${line}`)
        .join('\n');

      const totalLines = lines.length;
      const truncated = endIdx < lines.length;

      const footer = truncated
        ? `\n\n(${endIdx - startIdx} of ${totalLines} lines shown; use offset=${offset + limit} to read more)`
        : `\n(${totalLines} lines total)`;

      return okResult(
        toolUseId,
        numbered + footer,
        { compactable: true, duration_ms: Date.now() - startMs },
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return errorResult(toolUseId, `read_file: file not found: ${filePath}`, { duration_ms: Date.now() - startMs });
      }
      if (code === 'EACCES') {
        return errorResult(toolUseId, `read_file: permission denied: ${filePath}`, { duration_ms: Date.now() - startMs });
      }
      return errorResult(toolUseId, `read_file: ${(err as Error).message}`, { duration_ms: Date.now() - startMs });
    }
  },
});
