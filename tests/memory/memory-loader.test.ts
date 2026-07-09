import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadMemoryFile, loadMemoryDir, parseMemoryFile } from '../../src/memory/memory-loader.js';

// ============================================================
// parseMemoryFile 单元测试
// ============================================================

test('parseMemoryFile: 标准格式（user 类型）', () => {
  const content = `---
name: user_role
description: 用户是后端工程师，偏好 Go
type: user
scope: project
version: 1
---
用户偏好 Go 和 PostgreSQL，正在开发 OmniAgent CLI。`;
  const mem = parseMemoryFile(content, '/test/user_role.md');
  assert.ok(mem);
  assert.equal(mem!.frontmatter.name, 'user_role');
  assert.equal(mem!.frontmatter.description, '用户是后端工程师，偏好 Go');
  assert.equal(mem!.frontmatter.type, 'user');
  assert.equal(mem!.frontmatter.scope, 'project');
  assert.equal(mem!.frontmatter.version, 1);
  assert.ok(mem!.body.includes('Go 和 PostgreSQL'));
});

test('parseMemoryFile: 4 种 type 都支持', () => {
  for (const type of ['user', 'feedback', 'project', 'reference'] as const) {
    const content = `---
name: mem_${type}
description: desc
type: ${type}
---
body`;
    const mem = parseMemoryFile(content);
    assert.ok(mem, `${type} 类型应可解析`);
    assert.equal(mem!.frontmatter.type, type);
  }
});

test('parseMemoryFile: 无 frontmatter → null', () => {
  const content = '# Just markdown\n\nNo frontmatter here.';
  const mem = parseMemoryFile(content);
  assert.equal(mem, null);
});

test('parseMemoryFile: frontmatter 未闭合 → null', () => {
  const content = `---
name: test
description: desc
type: user
body without closing delimiter`;
  const mem = parseMemoryFile(content);
  assert.equal(mem, null);
});

test('parseMemoryFile: 缺必填字段 → null', () => {
  // 缺 name
  assert.equal(parseMemoryFile(`---\ndescription: desc\ntype: user\n---\nbody`), null);
  // 缺 description
  assert.equal(parseMemoryFile(`---\nname: test\ntype: user\n---\nbody`), null);
  // 缺 type
  assert.equal(parseMemoryFile(`---\nname: test\ndescription: desc\n---\nbody`), null);
});

test('parseMemoryFile: 非法 type → null', () => {
  const content = `---
name: test
description: desc
type: invalid_type
---\nbody`;
  assert.equal(parseMemoryFile(content), null);
});

test('parseMemoryFile: 空 body 合法', () => {
  const content = `---
name: empty
description: empty body
type: project
---`;
  const mem = parseMemoryFile(content);
  assert.ok(mem);
  assert.equal(mem!.body, '');
});

test('parseMemoryFile: 注释行跳过', () => {
  const content = `---
# this is a comment
name: with_comment
description: has comments
type: project
---\nbody`;
  const mem = parseMemoryFile(content);
  assert.ok(mem);
  assert.equal(mem!.frontmatter.name, 'with_comment');
});

test('parseMemoryFile: filePath 透传', () => {
  const content = `---
name: test
description: desc
type: user
---
body`;
  const mem = parseMemoryFile(content, '/path/to/mem.md');
  assert.equal(mem!.filePath, '/path/to/mem.md');
});

// ============================================================
// loadMemoryFile / loadMemoryDir 文件系统集成
// ============================================================

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `omniagent-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

test('loadMemoryFile: 加载真实文件', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'test.md');
  await fs.writeFile(file, `---
name: file_test
description: loaded from fs
type: user
---
real body`);
  const mem = await loadMemoryFile(file);
  assert.ok(mem);
  assert.equal(mem!.frontmatter.name, 'file_test');
  assert.equal(mem!.frontmatter.description, 'loaded from fs');
  assert.ok(mem!.body.includes('real body'));
});

test('loadMemoryFile: 文件不存在 → null', async () => {
  const mem = await loadMemoryFile('/nonexistent/path/mem.md');
  assert.equal(mem, null);
});

test('loadMemoryDir: 加载多文件', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'a.md'), `---
name: mem_a
description: memory A
type: user
---
body A`);
  await fs.writeFile(path.join(dir, 'b.md'), `---
name: mem_b
description: memory B
type: project
---
body B`);
  await fs.writeFile(path.join(dir, 'c.txt'), 'not a memory file');  // 非 .md 跳过

  const memories = await loadMemoryDir(dir);
  assert.equal(memories.length, 2);
  const names = memories.map(m => m.frontmatter.name).sort();
  assert.deepEqual(names, ['mem_a', 'mem_b']);
});

test('loadMemoryDir: 空目录 → []', async () => {
  const dir = await makeTempDir();
  const memories = await loadMemoryDir(dir);
  assert.equal(memories.length, 0);
});

test('loadMemoryDir: 不存在目录 → []', async () => {
  const memories = await loadMemoryDir('/nonexistent/dir');
  assert.equal(memories.length, 0);
});

test('loadMemoryDir: 损坏文件跳过，不影响其他', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'good.md'), `---
name: good
description: valid
type: user
---
body`);
  await fs.writeFile(path.join(dir, 'bad.md'), 'no frontmatter at all');
  await fs.writeFile(path.join(dir, 'bad2.md'), `---
name: bad
description: missing type
---
body`);

  const memories = await loadMemoryDir(dir);
  assert.equal(memories.length, 1);
  assert.equal(memories[0]!.frontmatter.name, 'good');
});

test('loadMemoryDir: 同名记忆去重（先加载优先）', async () => {
  const dir = await makeTempDir();
  // 文件名顺序：a.md 先于 z.md（readdir 顺序依系统，但同目录字母序通常一致）
  await fs.writeFile(path.join(dir, 'a.md'), `---
name: dup
description: first loaded
type: user
---
A`);
  await fs.writeFile(path.join(dir, 'z.md'), `---
name: dup
description: second loaded (should be skipped)
type: user
---
Z`);

  const memories = await loadMemoryDir(dir);
  const dup = memories.filter(m => m.frontmatter.name === 'dup');
  assert.equal(dup.length, 1, '同名应去重，只保留 1 个');
});
