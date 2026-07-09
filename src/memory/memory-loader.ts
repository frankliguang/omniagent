/**
 * MemoryFileLoader（L3-M7 §3.2 — L3 项目记忆文件加载）
 *
 * 从 `~/.omniagent/memory/*.md` 加载项目记忆文件，解析 YAML frontmatter + body。
 *
 * 文件格式：
 * ```
 * ---
 * name: user_role
 * description: 用户是后端工程师，偏好 Go
 * type: user
 * ---
 * 记忆正文...
 * ```
 *
 * M1 实现：自实现 minimal YAML frontmatter parser（避免引入 gray-matter 依赖）。
 * 仅支持 flat key: value（无嵌套对象/数组），满足记忆 frontmatter schema。
 *
 * 错误处理：
 *  - 文件不存在：跳过（返回 null）
 *  - frontmatter 损坏：跳过该文件（mod-07 §3.2 "frontmatter 损坏时跳过"）
 *  - body 为空：仍加载（body 可空）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Memory, MemoryFrontmatter, MemoryType } from '../types/index.js';

const FRONTMATTER_DELIMITER = /^---\s*$/;
const VALID_MEMORY_TYPES = new Set<MemoryType>(['user', 'feedback', 'project', 'reference']);

/** 加载单个记忆文件 */
export async function loadMemoryFile(filePath: string): Promise<Memory | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  return parseMemoryFile(content, filePath);
}

/** 解析记忆文件内容（导出供测试用） */
export function parseMemoryFile(content: string, filePath?: string): Memory | null {
  const lines = content.split('\n');

  // 首行必须是 ---
  if (lines.length === 0 || !FRONTMATTER_DELIMITER.test(lines[0]!)) {
    return null;
  }

  // 找结束 ---
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIMITER.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return null;  // frontmatter 未闭合
  }

  const frontmatterLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join('\n').trim();

  const frontmatter = parseFrontmatter(frontmatterLines, filePath);
  if (!frontmatter) {
    return null;
  }

  return { frontmatter, body, filePath };
}

/** 解析 frontmatter 行（flat key: value） */
function parseFrontmatter(lines: string[], filePath?: string): MemoryFrontmatter | null {
  const kv: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;  // 空行/注释跳过
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      continue;  // 无冒号，跳过
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key) kv[key] = value;
  }

  // 必填字段校验
  if (!kv.name || !kv.description || !kv.type) {
    return null;
  }

  // type 合法性
  if (!VALID_MEMORY_TYPES.has(kv.type as MemoryType)) {
    return null;
  }

  const frontmatter: MemoryFrontmatter = {
    name: kv.name,
    description: kv.description,
    type: kv.type as MemoryType,
  };

  if (kv.scope === 'project' || kv.scope === 'user') {
    frontmatter.scope = kv.scope;
  }
  if (kv.created_at) {
    frontmatter.created_at = kv.created_at as MemoryFrontmatter['created_at'];
  }
  if (kv.updated_at) {
    frontmatter.updated_at = kv.updated_at as MemoryFrontmatter['updated_at'];
  }
  if (kv.version) {
    const v = Number(kv.version);
    if (!Number.isNaN(v)) {
      frontmatter.version = v;
    }
  }

  // filePath 用于错误诊断（不在此抛错，仅校验失败返回 null）
  void filePath;

  return frontmatter;
}

/** 加载目录下所有记忆文件（按 name 去重，先加载的优先） */
export async function loadMemoryDir(dir: string): Promise<Memory[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const memories: Memory[] = [];
  const seenNames = new Set<string>();

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const full = path.join(dir, entry);
    const mem = await loadMemoryFile(full);
    if (!mem) continue;
    if (seenNames.has(mem.frontmatter.name)) {
      // mod-07 §3.2：重名时跳过后加载的
      continue;
    }
    seenNames.add(mem.frontmatter.name);
    memories.push(mem);
  }

  return memories;
}
