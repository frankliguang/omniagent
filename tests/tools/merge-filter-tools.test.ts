import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeAndFilterTools,
  checkCoordinatorInvariant,
  isCoordinatorRole,
  COORDINATOR_BANNED_TOOLS,
  DESCRIPTION_MAX_LENGTH,
} from '../../src/tools/merge-filter-tools.js';
import { buildTool } from '../../src/tools/build-tool.js';
import type { AgentRole, Tool } from '../../src/types/index.js';

// ============================================================
// helpers
// ============================================================

function makeTool(name: string, opts: { description?: string } = {}): Tool {
  return buildTool({
    name,
    description: opts.description ?? `tool ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isBackground: false,
    checkPermissions: () => ({ decision: 'allow', matchedRule: 'test', layer: 2 }),
    call: async () => ({
      tool_use_id: '' as never,
      content: [{ type: 'text', text: 'ok' }],
      is_error: false,
    }),
  });
}

// ============================================================
// main 角色：全部工具通过
// ============================================================

test('main 角色：全部 baseTools 通过', () => {
  const baseTools = [makeTool('bash'), makeTool('read_file')];
  const result = mergeAndFilterTools({ baseTools, agentRole: 'main' });
  assert.equal(result.filtered.length, 2);
  assert.equal(result.removed.length, 0);
});

test('main 角色：包含 mcpTools', () => {
  const baseTools = [makeTool('bash')];
  const mcpTools = [makeTool('mcp_slack')];
  const result = mergeAndFilterTools({ baseTools, agentRole: 'main', mcpTools });
  assert.equal(result.filtered.length, 2);
  assert.deepEqual(
    result.filtered.map((t) => t.name).sort(),
    ['bash', 'mcp_slack'].sort(),
  );
});

// ============================================================
// coordinator 角色：移除 bash/edit_file/write_file（不变量 #4）
// ============================================================

test('coordinator 角色：移除 bash/edit_file/write_file（不变量 #4）', () => {
  const baseTools = [
    makeTool('bash'),
    makeTool('edit_file'),
    makeTool('write_file'),
    makeTool('read_file'),
    makeTool('glob'),
  ];
  const result = mergeAndFilterTools({ baseTools, agentRole: 'coordinator' });
  const names = result.filtered.map((t) => t.name);
  assert.deepEqual(names.sort(), ['glob', 'read_file'].sort());
  assert.equal(result.removed.length, 3);
  const removedNames = result.removed.map((r) => r.tool.name).sort();
  assert.deepEqual(removedNames, ['bash', 'edit_file', 'write_file']);
});

test('coordinator 角色：removed 中的 reason 含 invariant #4 标记', () => {
  const baseTools = [makeTool('bash')];
  const result = mergeAndFilterTools({ baseTools, agentRole: 'coordinator' });
  assert.equal(result.removed.length, 1);
  assert.match(result.removed[0].reason, /coordinator role banned/);
  assert.match(result.removed[0].reason, /invariant #4/);
});

test('coordinator 角色：filtered 池不含被禁工具', () => {
  const baseTools = [
    makeTool('bash'),
    makeTool('edit_file'),
    makeTool('write_file'),
    makeTool('read_file'),
  ];
  const result = mergeAndFilterTools({ baseTools, agentRole: 'coordinator' });
  for (const banned of COORDINATOR_BANNED_TOOLS) {
    const filteredNames = result.filtered.map((t) => t.name);
    assert.equal(
      filteredNames.includes(banned),
      false,
      `filtered 池不应含 "${banned}"`,
    );
  }
});

test('coordinator 角色：mcpTools 中的 bash 也被移除', () => {
  const baseTools = [makeTool('read_file')];
  const mcpTools = [makeTool('bash')];  // MCP 重名 bash 也算违规
  const result = mergeAndFilterTools({
    baseTools,
    agentRole: 'coordinator',
    mcpTools,
  });
  const names = result.filtered.map((t) => t.name);
  assert.deepEqual(names, ['read_file']);
});

// ============================================================
// custom/teammate/worker 角色：白名单过滤
// ============================================================

test('custom 角色：仅 customAgentTools 白名单保留', () => {
  const baseTools = [makeTool('bash'), makeTool('read_file')];
  const customAgentTools = [makeTool('read_file')];
  const result = mergeAndFilterTools({
    baseTools,
    customAgentTools,
    agentRole: 'custom',
  });
  assert.deepEqual(result.filtered.map((t) => t.name), ['read_file']);
  const bashRemoval = result.removed.find((r) => r.tool.name === 'bash');
  assert.ok(bashRemoval);
  assert.match(bashRemoval!.reason, /whitelist/);
});

test('teammate 角色：仅 customAgentTools 白名单保留', () => {
  const baseTools = [makeTool('bash'), makeTool('read_file')];
  const customAgentTools = [makeTool('read_file')];
  const result = mergeAndFilterTools({
    baseTools,
    customAgentTools,
    agentRole: 'teammate',
  });
  assert.deepEqual(result.filtered.map((t) => t.name), ['read_file']);
});

test('worker 角色：仅 customAgentTools 白名单保留', () => {
  const baseTools = [makeTool('bash'), makeTool('read_file'), makeTool('grep')];
  const customAgentTools = [makeTool('read_file')];
  const result = mergeAndFilterTools({
    baseTools,
    customAgentTools,
    agentRole: 'worker',
  });
  assert.deepEqual(result.filtered.map((t) => t.name), ['read_file']);
});

test('custom 角色：无 customAgentTools → 全部通过（fallback）', () => {
  // 未传 customAgentTools → 等价于无白名单过滤
  const baseTools = [makeTool('bash'), makeTool('read_file')];
  const result = mergeAndFilterTools({ baseTools, agentRole: 'custom' });
  assert.equal(result.filtered.length, 2);
});

// ============================================================
// fork 角色：继承父工具池（不过滤）
// ============================================================

test('fork 角色：继承父工具池（不过滤）', () => {
  const baseTools = [makeTool('bash'), makeTool('edit_file'), makeTool('read_file')];
  const result = mergeAndFilterTools({ baseTools, agentRole: 'fork' });
  assert.equal(result.filtered.length, 3);
  assert.equal(result.removed.length, 0);
});

// ============================================================
// 去重：同名工具保留第一次出现
// ============================================================

test('去重：baseTools + mcpTools 同名 → 保留第一次，记入 removed', () => {
  const baseTools = [makeTool('bash')];
  const mcpTools = [makeTool('bash')];  // 重复
  const result = mergeAndFilterTools({ baseTools, agentRole: 'main', mcpTools });
  assert.equal(result.filtered.length, 1);
  const dup = result.removed.find((r) => r.reason === 'duplicate name');
  assert.ok(dup, '应记入 duplicate name');
  assert.equal(dup!.tool.name, 'bash');
});

test('去重：3 个同名 → 保留第一个，记入 2 个 removed', () => {
  const baseTools = [makeTool('grep')];
  const mcpTools = [makeTool('grep'), makeTool('grep')];
  const result = mergeAndFilterTools({ baseTools, agentRole: 'main', mcpTools });
  assert.equal(result.filtered.length, 1);
  assert.equal(result.removed.length, 2);
  assert.equal(
    result.removed.every((r) => r.reason === 'duplicate name'),
    true,
  );
});

// ============================================================
// 描述截断（不变量 #15）
// ============================================================

test('描述 > 2048 字符 → 截断 + 记入 errors', () => {
  const longDesc = 'a'.repeat(3000);
  const tool = makeTool('mcp_long', { description: longDesc });
  const result = mergeAndFilterTools({ baseTools: [tool], agentRole: 'main' });
  assert.equal(result.filtered.length, 1);
  assert.ok(result.filtered[0].description.length <= DESCRIPTION_MAX_LENGTH);
  assert.match(result.filtered[0].description, /\.\.\.\[truncated\]$/);
  assert.equal(result.errors?.length, 1);
  assert.equal(result.errors![0].error, 'description truncated');
});

test('描述 = 2048 字符 → 不截断', () => {
  const desc = 'a'.repeat(2048);
  const tool = makeTool('mcp_exact', { description: desc });
  const result = mergeAndFilterTools({ baseTools: [tool], agentRole: 'main' });
  assert.equal(result.filtered.length, 1);
  assert.equal(result.filtered[0].description.length, 2048);
  assert.equal(result.errors?.length ?? 0, 0);
});

test('描述 < 2048 字符 → 不截断', () => {
  const tool = makeTool('mcp_short', { description: 'short description' });
  const result = mergeAndFilterTools({ baseTools: [tool], agentRole: 'main' });
  assert.equal(result.filtered.length, 1);
  assert.equal(result.errors?.length ?? 0, 0);
});

// ============================================================
// checkCoordinatorInvariant 守护器
// ============================================================

test('checkCoordinatorInvariant: 无违规 → 返回空数组', () => {
  const filtered = [makeTool('read_file'), makeTool('grep')];
  const violations = checkCoordinatorInvariant(filtered);
  assert.equal(violations.length, 0);
});

test('checkCoordinatorInvariant: 含 bash → 返回 [bash]', () => {
  const filtered = [makeTool('bash'), makeTool('read_file')];
  const violations = checkCoordinatorInvariant(filtered);
  assert.deepEqual(violations, ['bash']);
});

test('checkCoordinatorInvariant: 含全部 3 个被禁 → 返回 3 个', () => {
  const filtered = [makeTool('bash'), makeTool('edit_file'), makeTool('write_file')];
  const violations = checkCoordinatorInvariant(filtered);
  assert.equal(violations.length, 3);
  assert.deepEqual(violations.sort(), ['bash', 'edit_file', 'write_file']);
});

// ============================================================
// isCoordinatorRole
// ============================================================

test('isCoordinatorRole: coordinator → true', () => {
  assert.equal(isCoordinatorRole('coordinator'), true);
});

test('isCoordinatorRole: main/worker/custom/teammate/fork → false', () => {
  const roles: AgentRole[] = ['main', 'worker', 'custom', 'teammate', 'fork'];
  for (const r of roles) {
    assert.equal(isCoordinatorRole(r), false, `${r} 不应被识别为 coordinator`);
  }
});

// ============================================================
// 综合场景
// ============================================================

test('综合：coordinator + mcpTools 含写工具 → 全部移除', () => {
  const baseTools = [makeTool('read_file'), makeTool('grep')];
  const mcpTools = [
    makeTool('mcp_slack'),
    makeTool('edit_file'),  // MCP 工具叫 edit_file 也应被移除
  ];
  const result = mergeAndFilterTools({ baseTools, agentRole: 'coordinator', mcpTools });
  const names = result.filtered.map((t) => t.name).sort();
  assert.deepEqual(names, ['grep', 'mcp_slack', 'read_file'].sort());
  // edit_file 应在 removed（coordinator banned）
  const editRemoved = result.removed.find((r) => r.tool.name === 'edit_file');
  assert.ok(editRemoved);
  assert.match(editRemoved!.reason, /coordinator role banned/);
});

test('综合：custom + mcpTools 同名去重 + 白名单筛选', () => {
  const baseTools = [makeTool('read_file')];
  const customAgentTools = [makeTool('read_file')];
  const mcpTools = [makeTool('read_file'), makeTool('mcp_extra')];  // 1 重复 + 1 不在白名单
  const result = mergeAndFilterTools({
    baseTools,
    customAgentTools,
    agentRole: 'custom',
    mcpTools,
  });
  // read_file 保留，mcp_extra 不在白名单 → removed，read_file 重复 → removed
  assert.deepEqual(result.filtered.map((t) => t.name), ['read_file']);
  const dupRemoved = result.removed.find((r) => r.reason === 'duplicate name');
  assert.ok(dupRemoved);
  assert.equal(dupRemoved!.tool.name, 'read_file');
  const whitelistRemoved = result.removed.find((r) => r.tool.name === 'mcp_extra');
  assert.ok(whitelistRemoved);
  assert.match(whitelistRemoved!.reason, /whitelist/);
});

test('综合：fork + mcpTools 含重复 → 去重生效', () => {
  const baseTools = [makeTool('bash')];
  const mcpTools = [makeTool('bash')];  // 重复
  const result = mergeAndFilterTools({ baseTools, agentRole: 'fork', mcpTools });
  // fork 不过滤被禁工具，但去重仍生效
  assert.equal(result.filtered.length, 1);
  assert.equal(result.filtered[0].name, 'bash');
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].reason, 'duplicate name');
});

// ============================================================
// 常量导出
// ============================================================

test('COORDINATOR_BANNED_TOOLS: 含 bash/edit_file/write_file', () => {
  assert.ok(COORDINATOR_BANNED_TOOLS.has('bash'));
  assert.ok(COORDINATOR_BANNED_TOOLS.has('edit_file'));
  assert.ok(COORDINATOR_BANNED_TOOLS.has('write_file'));
  assert.equal(COORDINATOR_BANNED_TOOLS.size, 3);
});

test('DESCRIPTION_MAX_LENGTH: 2048', () => {
  assert.equal(DESCRIPTION_MAX_LENGTH, 2048);
});
