/**
 * FileEditTool（L3-M3 §2.3.2 — edit_file）
 *
 * 字符串精确替换。old_string 必须在文件中唯一出现（不唯一则报错）。
 * 支持 replace_all 选项（多匹配全替换）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { PermissionDecision, ToolInput, ToolResult } from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';

export const FileEditTool = buildTool({
  name: 'edit_file',
  description:
    'Edit a file by performing a string replacement. The old_string must appear exactly once ' +
    'in the file (unless replace_all is true). The file must exist. Use this for precise edits ' +
    'where you know the exact text to replace.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit.',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to replace. Must be unique in the file unless replace_all is true.',
      },
      new_string: {
        type: 'string',
        description: 'The text to replace old_string with.',
      },
      replace_all: {
        type: 'boolean',
        description: 'If true, replace all occurrences of old_string. Default: false.',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  isReadOnly: false,
  isDestructive: false,  // edit_file 是精确修改，非破坏性
  isConcurrencySafe: false,

  checkPermissions(_input: ToolInput): PermissionDecision {
    // M1 stub：edit_file 默认 ask（M3 完整版走 M4 五层拦截）
    return { decision: 'ask', matchedRule: 'm1-stub', layer: 2 };
  },

  async call(input: ToolInput, ctx): Promise<ToolResult> {
    const startMs = Date.now();
    const toolUseId = ctx.toolUseId ?? ('' as ToolResult['tool_use_id']);
    const filePath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;

    if (!filePath) {
      return errorResult(toolUseId, 'edit_file: file_path is required', { duration_ms: Date.now() - startMs });
    }
    if (oldString === undefined || newString === undefined) {
      return errorResult(toolUseId, 'edit_file: old_string and new_string are required', { duration_ms: Date.now() - startMs });
    }
    if (oldString === newString) {
      return errorResult(toolUseId, 'edit_file: old_string and new_string are identical (no change needed)', { duration_ms: Date.now() - startMs });
    }
    // 防御：空 old_string 会使 indexOf("") 永远返回 0，导致死循环
    if (oldString.length === 0) {
      return errorResult(toolUseId, 'edit_file: old_string must not be empty (use write_file to create a file from scratch)', { duration_ms: Date.now() - startMs });
    }

    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);

    try {
      const content = await fs.readFile(resolved, 'utf8');

      // 统计匹配数
      let matchCount = 0;
      let idx = content.indexOf(oldString);
      while (idx !== -1) {
        matchCount++;
        idx = content.indexOf(oldString, idx + oldString.length);
      }

      if (matchCount === 0) {
        return errorResult(
          toolUseId,
          `edit_file: old_string not found in ${filePath}. Make sure the string matches exactly (including whitespace and indentation).`,
          { duration_ms: Date.now() - startMs },
        );
      }

      if (matchCount > 1 && !replaceAll) {
        return errorResult(
          toolUseId,
          `edit_file: old_string appears ${matchCount} times in ${filePath}. Set replace_all=true to replace all, or provide a more specific old_string with surrounding context.`,
          { duration_ms: Date.now() - startMs },
        );
      }

      // 执行替换
      let newContent: string;
      if (replaceAll) {
        newContent = content.split(oldString).join(newString);
      } else {
        newContent = content.replace(oldString, newString);
      }

      await fs.writeFile(resolved, newContent, 'utf8');

      const replacedCount = replaceAll ? matchCount : 1;
      return okResult(
        toolUseId,
        `edit_file: replaced ${replacedCount} occurrence(s) in ${filePath}`,
        { compactable: true, duration_ms: Date.now() - startMs },
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return errorResult(toolUseId, `edit_file: file not found: ${filePath} (use write_file to create new files)`, { duration_ms: Date.now() - startMs });
      }
      if (code === 'EACCES') {
        return errorResult(toolUseId, `edit_file: permission denied: ${filePath}`, { duration_ms: Date.now() - startMs });
      }
      return errorResult(toolUseId, `edit_file: ${(err as Error).message}`, { duration_ms: Date.now() - startMs });
    }
  },
});
