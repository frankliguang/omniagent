/**
 * FileWriteTool（L3-M3 §2.3.3 — write_file）
 *
 * 创建或覆盖文件。父目录自动创建。
 * 拒绝写入二进制路径（M1 stub：简单检测 null bytes）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { PermissionDecision, ToolInput, ToolResult } from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';

export const FileWriteTool = buildTool({
  name: 'write_file',
  description:
    'Create a new file or overwrite an existing file with the given content. ' +
    'Parent directories are created automatically if they do not exist. ' +
    'Use this for creating new files or replacing entire file contents.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to write.',
      },
      content: {
        type: 'string',
        description: 'The full content to write to the file.',
      },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  isReadOnly: false,
  isDestructive: true,  // 覆盖现有文件是破坏性
  isConcurrencySafe: false,

  checkPermissions(_input: ToolInput): PermissionDecision {
    // M1 stub：write_file 默认 ask（M3 完整版走 M4 五层拦截）
    return { decision: 'ask', matchedRule: 'm1-stub', layer: 2 };
  },

  async call(input: ToolInput, ctx): Promise<ToolResult> {
    const startMs = Date.now();
    const toolUseId = ctx.toolUseId ?? ('' as ToolResult['tool_use_id']);
    const filePath = input.file_path as string;
    const content = input.content as string;

    if (!filePath) {
      return errorResult(toolUseId, 'write_file: file_path is required', { duration_ms: Date.now() - startMs });
    }
    if (content === undefined) {
      return errorResult(toolUseId, 'write_file: content is required', { duration_ms: Date.now() - startMs });
    }

    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);

    try {
      // 父目录自动创建
      const dir = path.dirname(resolved);
      await fs.mkdir(dir, { recursive: true });

      // 检测是否覆盖现有文件
      let existed = false;
      try {
        await fs.stat(resolved);
        existed = true;
      } catch {
        // 文件不存在，正常
      }

      await fs.writeFile(resolved, content, 'utf8');

      const action = existed ? 'overwrote' : 'created';
      const bytes = Buffer.byteLength(content, 'utf8');
      return okResult(
        toolUseId,
        `write_file: ${action} ${filePath} (${bytes} bytes)`,
        { compactable: true, duration_ms: Date.now() - startMs },
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES') {
        return errorResult(toolUseId, `write_file: permission denied: ${filePath}`, { duration_ms: Date.now() - startMs });
      }
      return errorResult(toolUseId, `write_file: ${(err as Error).message}`, { duration_ms: Date.now() - startMs });
    }
  },
});
