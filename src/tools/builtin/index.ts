/**
 * 内置工具注册（L3-M3 §2.2 + §2.3）
 *
 * 集中导出 M1 迭代 1-2 的内置工具：
 *  - 文件工具（迭代 1）：read_file / edit_file / write_file / glob / grep
 *  - Shell 工具（迭代 2）：bash（24 项安全校验 + abort/timeout）
 */

import type { Tool } from '../../types/index.js';
import { FileReadTool } from './file/read.js';
import { FileEditTool } from './file/edit.js';
import { FileWriteTool } from './file/write.js';
import { GlobTool } from './file/glob.js';
import { GrepTool } from './file/grep.js';
import { BashTool } from './shell/bash.js';

export { FileReadTool, FileEditTool, FileWriteTool, GlobTool, GrepTool, BashTool };

/** M1 迭代 1 文件工具集合（供 M2 ToolPool 注册用） */
export const FILE_TOOLS: Tool[] = [
  FileReadTool,
  FileEditTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
];

/** M1 迭代 2 Shell 工具集合 */
export const SHELL_TOOLS: Tool[] = [
  BashTool,
];

/** 全部内置工具（M1 迭代 1 + 2） */
export const BUILTIN_TOOLS: Tool[] = [
  ...FILE_TOOLS,
  ...SHELL_TOOLS,
];
