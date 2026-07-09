import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { FileReadTool, FileEditTool, FileWriteTool, GlobTool, GrepTool } from '../../../../src/tools/builtin/index.js';
import type { ToolContext, ToolResult } from '../../../../src/types/index.js';

async function tmpDir(prefix: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `omniagent-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeCtx(dir: string): ToolContext {
  return {
    cwd: dir,
    permissionMode: 'bypassPermissions',
    agentId: 'test-agent' as never,
    abortSignal: new AbortController().signal,
    agentRole: 'main',
    toolUseId: 'test-tool-use' as never,
  };
}

async function callTool(tool: typeof FileReadTool, input: unknown, dir: string): Promise<ToolResult> {
  return tool.call(input as never, makeCtx(dir));
}

function getText(result: ToolResult): string {
  const block = result.content[0];
  return block.type === 'text' ? block.text : '';
}

// ------------------------------------------------------------

test('FileReadTool: 读取小文件带行号', async () => {
  const dir = await tmpDir('read-small');
  const file = path.join(dir, 'test.txt');
  await fs.writeFile(file, 'line1\nline2\nline3\n');

  const result = await callTool(FileReadTool, { file_path: file }, dir);
  assert.equal(result.is_error, false);
  const text = getText(result);
  assert.match(text, /1\s+line1/);
  assert.match(text, /2\s+line2/);
  assert.match(text, /3\s+line3/);
});

test('FileReadTool: offset + limit 分页', async () => {
  const dir = await tmpDir('read-paginate');
  const file = path.join(dir, 'big.txt');
  const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n');
  await fs.writeFile(file, lines);

  const result = await callTool(FileReadTool, { file_path: file, offset: 10, limit: 5 }, dir);
  const text = getText(result);
  assert.match(text, /10\s+line10/);
  assert.match(text, /14\s+line14/);
  assert.doesNotMatch(text, /15\s+line15/);
});

test('FileReadTool: 文件不存在报错', async () => {
  const dir = await tmpDir('read-missing');
  const result = await callTool(FileReadTool, { file_path: path.join(dir, 'nope.txt') }, dir);
  assert.equal(result.is_error, true);
  assert.match(getText(result), /not found/);
});

test('FileReadTool: 相对路径基于 cwd 解析', async () => {
  const dir = await tmpDir('read-rel');
  await fs.writeFile(path.join(dir, 'rel.txt'), 'hello');

  const result = await callTool(FileReadTool, { file_path: 'rel.txt' }, dir);
  assert.equal(result.is_error, false);
  assert.match(getText(result), /hello/);
});

test('FileReadTool: checkPermissions 返回 allow（只读）', () => {
  const decision = FileReadTool.checkPermissions({});
  assert.equal(decision.decision, 'allow');
});

test('FileReadTool: isReadOnly=true, isDestructive=false', () => {
  assert.equal(FileReadTool.isReadOnly, true);
  assert.equal(FileReadTool.isDestructive, false);
});

// ------------------------------------------------------------

test('FileWriteTool: 创建新文件', async () => {
  const dir = await tmpDir('write-new');
  const file = path.join(dir, 'subdir', 'new.txt');
  const result = await callTool(FileWriteTool, { file_path: file, content: 'hello world' }, dir);
  assert.equal(result.is_error, false);
  const written = await fs.readFile(file, 'utf8');
  assert.equal(written, 'hello world');
});

test('FileWriteTool: 覆盖现有文件', async () => {
  const dir = await tmpDir('write-overwrite');
  const file = path.join(dir, 'existing.txt');
  await fs.writeFile(file, 'old content');
  const result = await callTool(FileWriteTool, { file_path: file, content: 'new content' }, dir);
  assert.equal(result.is_error, false);
  assert.match(getText(result), /overwrote/);
  const written = await fs.readFile(file, 'utf8');
  assert.equal(written, 'new content');
});

test('FileWriteTool: isDestructive=true（覆盖是破坏性）', () => {
  assert.equal(FileWriteTool.isDestructive, true);
});

// ------------------------------------------------------------

test('FileEditTool: 唯一匹配替换', async () => {
  const dir = await tmpDir('edit-unique');
  const file = path.join(dir, 'edit.txt');
  await fs.writeFile(file, 'foo bar baz');

  const result = await callTool(FileEditTool, {
    file_path: file,
    old_string: 'bar',
    new_string: 'QUX',
  }, dir);
  assert.equal(result.is_error, false);
  const after = await fs.readFile(file, 'utf8');
  assert.equal(after, 'foo QUX baz');
});

test('FileEditTool: 多匹配拒绝（需 replace_all）', async () => {
  const dir = await tmpDir('edit-multi');
  const file = path.join(dir, 'multi.txt');
  await fs.writeFile(file, 'foo foo foo');

  const result = await callTool(FileEditTool, {
    file_path: file,
    old_string: 'foo',
    new_string: 'bar',
  }, dir);
  assert.equal(result.is_error, true);
  assert.match(getText(result), /3 times/);
});

test('FileEditTool: replace_all=true 全替换', async () => {
  const dir = await tmpDir('edit-all');
  const file = path.join(dir, 'all.txt');
  await fs.writeFile(file, 'foo foo foo');

  const result = await callTool(FileEditTool, {
    file_path: file,
    old_string: 'foo',
    new_string: 'bar',
    replace_all: true,
  }, dir);
  assert.equal(result.is_error, false);
  const after = await fs.readFile(file, 'utf8');
  assert.equal(after, 'bar bar bar');
});

test('FileEditTool: old_string 不存在报错', async () => {
  const dir = await tmpDir('edit-miss');
  const file = path.join(dir, 'miss.txt');
  await fs.writeFile(file, 'hello world');

  const result = await callTool(FileEditTool, {
    file_path: file,
    old_string: 'nonexistent',
    new_string: 'x',
  }, dir);
  assert.equal(result.is_error, true);
  assert.match(getText(result), /not found/);
});

test('FileEditTool: 文件不存在报错（提示用 write_file）', async () => {
  const dir = await tmpDir('edit-no-file');
  const result = await callTool(FileEditTool, {
    file_path: path.join(dir, 'nope.txt'),
    old_string: 'x',
    new_string: 'y',
  }, dir);
  assert.equal(result.is_error, true);
  assert.match(getText(result), /write_file/);
});

test('FileEditTool: 空 old_string 拒绝（防 indexOf 死循环）', async () => {
  const dir = await tmpDir('edit-empty');
  const file = path.join(dir, 'empty.txt');
  await fs.writeFile(file, 'some content');

  const result = await callTool(FileEditTool, {
    file_path: file,
    old_string: '',
    new_string: 'x',
  }, dir);
  assert.equal(result.is_error, true);
  assert.match(getText(result), /empty/);
  // 原文件未被修改
  const after = await fs.readFile(file, 'utf8');
  assert.equal(after, 'some content');
});

// ------------------------------------------------------------

test('GlobTool: 匹配 .ts 文件', async () => {
  const dir = await tmpDir('glob-ts');
  await fs.writeFile(path.join(dir, 'a.ts'), '');
  await fs.writeFile(path.join(dir, 'b.ts'), '');
  await fs.writeFile(path.join(dir, 'c.js'), '');
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'd.ts'), '');

  const result = await callTool(GlobTool, { pattern: '*.ts' }, dir);
  const text = getText(result);
  assert.match(text, /a\.ts/);
  assert.match(text, /b\.ts/);
  assert.doesNotMatch(text, /c\.js/);
});

test('GlobTool: 跨目录通配匹配', async () => {
  const dir = await tmpDir('glob-recursive');
  await fs.mkdir(path.join(dir, 'src', 'deep'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'top.ts'), '');
  await fs.writeFile(path.join(dir, 'src', 'deep', 'nested.ts'), '');

  const result = await callTool(GlobTool, { pattern: 'src/**/*.ts' }, dir);
  const text = getText(result);
  assert.match(text, /top\.ts/);
  assert.match(text, /nested\.ts/);
});

test('GlobTool: 无匹配返回提示', async () => {
  const dir = await tmpDir('glob-empty');
  const result = await callTool(GlobTool, { pattern: '*.xyz' }, dir);
  assert.equal(result.is_error, false);
  assert.match(getText(result), /no files matched/);
});

test('GlobTool: 忽略 node_modules', async () => {
  const dir = await tmpDir('glob-ignore');
  await fs.mkdir(path.join(dir, 'node_modules'));
  await fs.writeFile(path.join(dir, 'node_modules', 'dep.ts'), '');
  await fs.writeFile(path.join(dir, 'real.ts'), '');

  const result = await callTool(GlobTool, { pattern: '*.ts' }, dir);
  const text = getText(result);
  assert.match(text, /real\.ts/);
  assert.doesNotMatch(text, /node_modules/);
});

// ------------------------------------------------------------

test('GrepTool: 正则搜索匹配行', async () => {
  const dir = await tmpDir('grep-basic');
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello world\nfoo bar\nHELLO again');

  const result = await callTool(GrepTool, { pattern: 'hello' }, dir);
  const text = getText(result);
  assert.match(text, /a\.txt:1:hello world/);
  assert.doesNotMatch(text, /HELLO/);  // 默认大小写敏感
});

test('GrepTool: case_insensitive=true', async () => {
  const dir = await tmpDir('grep-ci');
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello world\nHELLO again');

  const result = await callTool(GrepTool, {
    pattern: 'hello',
    case_insensitive: true,
  }, dir);
  const text = getText(result);
  assert.match(text, /hello world/);
  assert.match(text, /HELLO again/);
});

test('GrepTool: glob 过滤文件', async () => {
  const dir = await tmpDir('grep-glob');
  await fs.writeFile(path.join(dir, 'a.ts'), 'target');
  await fs.writeFile(path.join(dir, 'b.js'), 'target');

  const result = await callTool(GrepTool, {
    pattern: 'target',
    glob: '*.ts',
  }, dir);
  const text = getText(result);
  assert.match(text, /a\.ts/);
  assert.doesNotMatch(text, /b\.js/);
});

test('GrepTool: 无匹配返回提示', async () => {
  const dir = await tmpDir('grep-miss');
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello');

  const result = await callTool(GrepTool, { pattern: 'nonexistent' }, dir);
  assert.equal(result.is_error, false);
  assert.match(getText(result), /no matches/);
});

test('GrepTool: 指定单文件搜索', async () => {
  const dir = await tmpDir('grep-single');
  const file = path.join(dir, 'single.txt');
  await fs.writeFile(file, 'line1\nmatch here\nline3');

  const result = await callTool(GrepTool, { pattern: 'match', path: file }, dir);
  const text = getText(result);
  assert.match(text, /single\.txt:2:match here/);
});

test('GrepTool: 无效正则报错', async () => {
  const dir = await tmpDir('grep-bad-regex');
  const result = await callTool(GrepTool, { pattern: '[invalid' }, dir);
  assert.equal(result.is_error, true);
  assert.match(getText(result), /invalid regex/);
});

test('GrepTool: 嵌套量词模式拒绝（防 ReDoS 死循环）', async () => {
  const dir = await tmpDir('grep-redos');
  // 经典 ReDoS 模式：(a+)+b 对 aaa...! 输入会指数级回溯
  const evilInput = 'a'.repeat(50) + '!';
  await fs.writeFile(path.join(dir, 'evil.txt'), evilInput);

  const result = await callTool(GrepTool, { pattern: '(a+)+b' }, dir);
  assert.equal(result.is_error, true);
  assert.match(getText(result), /ReDoS|nested quantifier/i);
});

test('GrepTool: 嵌套量词变体也拒绝（(a*)*）', async () => {
  const dir = await tmpDir('grep-redos-2');
  await fs.writeFile(path.join(dir, 'x.txt'), 'aaa');
  const result = await callTool(GrepTool, { pattern: '(a*)*b' }, dir);
  assert.equal(result.is_error, true);
  assert.match(getText(result), /ReDoS|nested quantifier/i);
});

test('GrepTool: 合法量词模式仍可用', async () => {
  const dir = await tmpDir('grep-valid-quant');
  await fs.writeFile(path.join(dir, 'a.txt'), 'aaab');
  const result = await callTool(GrepTool, { pattern: 'a+b' }, dir);
  assert.equal(result.is_error, false);
  assert.match(getText(result), /aaab/);
});

// ------------------------------------------------------------

test('所有文件工具：metadata.duration_ms 必填', async () => {
  const dir = await tmpDir('meta');
  const file = path.join(dir, 'x.txt');
  await fs.writeFile(file, 'x');

  const result = await callTool(FileReadTool, { file_path: file }, dir);
  assert.ok(result.metadata);
  assert.equal(typeof result.metadata!.duration_ms, 'number');
});

test('所有文件工具：tool_use_id 从 ctx 回填', async () => {
  const dir = await tmpDir('id');
  const file = path.join(dir, 'x.txt');
  await fs.writeFile(file, 'x');

  const result = await callTool(FileReadTool, { file_path: file }, dir);
  assert.equal(result.tool_use_id, 'test-tool-use');
});
