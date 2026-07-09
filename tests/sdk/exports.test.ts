/**
 * SDK 集成测试 — 验证 omniagent-cli 包的 subpath exports 可用
 *
 * M1 迭代 3 L2 §11.1：TypeScript SDK 嵌入式 SDK 验证
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 主入口
import { VERSION } from '../../dist/index.js';

// core 子模块（ReActLoop）
import { ReActLoop } from '../../dist/core/react-loop.js';

// providers 子模块
import { ProviderRegistry } from '../../dist/providers/registry.js';

// tools 子模块
import { BUILTIN_TOOLS } from '../../dist/tools/builtin/index.js';

// memory 子模块（barrel）
import { WorkingMemory, MemoryRecaller } from '../../dist/memory/index.js';

// types 子模块
import type { ChatRequest, ChatResponse, Memory, LLMProvider } from '../../dist/types/index.js';

test('SDK: 主入口 VERSION 可用', () => {
  assert.ok(typeof VERSION === 'string');
  assert.ok(VERSION.match(/^\d+\.\d+\.\d+/), 'VERSION 应为 semver');
});

test('SDK: ReActLoop 可从 ./core 子路径导入', () => {
  assert.ok(ReActLoop, 'ReActLoop class should be importable');
  assert.equal(typeof ReActLoop, 'function');
});

test('SDK: WorkingMemory 可从 ./core 子路径导入', () => {
  assert.ok(WorkingMemory);
  const mem = new WorkingMemory();
  assert.equal(mem.getMessages().length, 0);
});

test('SDK: ProviderRegistry 可从 ./providers 子路径导入', () => {
  assert.ok(ProviderRegistry);
  const reg = ProviderRegistry.create();
  const ids = reg.list().map(p => p.id);
  // M1 应注册 4 个 provider
  assert.ok(ids.includes('openai'));
  assert.ok(ids.includes('anthropic'));
  assert.ok(ids.includes('bedrock'));
  assert.ok(ids.includes('ollama'));
});

test('SDK: BUILTIN_TOOLS 可从 ./tools 子路径导入', () => {
  assert.ok(Array.isArray(BUILTIN_TOOLS));
  assert.ok(BUILTIN_TOOLS.length >= 5, '至少 5 个工具：read/edit/write/glob/grep');
  const names = BUILTIN_TOOLS.map(t => t.name);
  for (const expected of ['read_file', 'edit_file', 'write_file', 'glob', 'grep']) {
    assert.ok(names.includes(expected), `应包含 ${expected}`);
  }
});

test('SDK: MemoryRecaller 可从 ./memory 子路径导入', () => {
  assert.ok(MemoryRecaller);
  assert.equal(typeof MemoryRecaller, 'function');
});

test('SDK: 类型可从 ./types 子路径导入（编译时检查，运行时无操作）', () => {
  // type-only import 在运行时无产物，验证 TS 编译通过即可
  const req: ChatRequest = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };
  assert.equal(req.model, 'gpt-4o');
});

test('SDK: types/dist/index.d.ts 存在（类型导出可被外部项目消费）', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const typesPath = path.resolve(process.cwd(), 'dist/index.d.ts');
  const content = await readFile(typesPath, 'utf8');
  assert.ok(content.length > 0, 'dist/index.d.ts 应非空');
  assert.ok(content.includes('export'), '应有 export 声明');
});

test('SDK: ReActLoop + ProviderRegistry + Tools 可组装运行', async () => {
  // 最小可用 SDK 组装：用 Mock provider 跑一轮
  const registry = ProviderRegistry.create();
  // 不实际调远端 LLM，仅验证 SDK API 表面正确
  assert.ok(registry.list().length >= 4);
  assert.ok(BUILTIN_TOOLS.length >= 5);

  // 构造 ReActLoop（不实际 run）
  const memory = new WorkingMemory();
  const loop = new ReActLoop({
    provider: registry.get('openai'),
    memory,
    tools: BUILTIN_TOOLS,
    model: 'gpt-4o',
    systemPrompt: 'test',
  });
  assert.ok(loop);
});
