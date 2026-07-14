/**
 * mergeAndFilterTools（L3-M3 §2.2.4 — 工具池隔离实施）
 *
 * 实现 omniagent-types.ts §7 的 MergeAndFilterToolsFn。
 * 跨模块函数（M2 ReActLoop BUILD_CONTEXT / M5 / M6 共享）。
 *
 * 6 种角色的工具池过滤规则（PRD mod-03 §3.2）：
 * - main：全部工具（baseTools + mcpTools）
 * - coordinator：必移除 bash/edit_file/write_file（不变量 #4：直接工具调用率 = 0）
 * - worker：由 Coordinator 分配的白名单（customAgentTools）
 * - custom：仅 customAgentTools 白名单
 * - teammate：仅 customAgentTools 白名单
 * - fork：继承父工具池（不过滤）
 *
 * 其他职责：
 * - 去重（同名工具：baseTools 优先，重复项记入 removed）
 * - 描述截断（不变量 #15：> 2048 字符截断 + 记入 errors）
 *
 * 不变量 #4 守护：Coordinator Mode 的 filtered 池中绝不含 bash/edit_file/write_file。
 */

import type {
  AgentRole,
  MergeAndFilterToolsParams,
  MergeAndFilterToolsResult,
  Tool,
} from '../types/index.js';

/** Coordinator 角色禁用的直接写工具（不变量 #4） */
export const COORDINATOR_BANNED_TOOLS = new Set<string>([
  'bash',
  'edit_file',
  'write_file',
]);

/** 描述截断阈值（不变量 #15） */
export const DESCRIPTION_MAX_LENGTH = 2048;

/** 截断后缀（不变量 #15） */
export const DESCRIPTION_TRUNCATED_SUFFIX = '...[truncated]';

/**
 * 截断描述到 ≤ DESCRIPTION_MAX_LENGTH 字符（含后缀）。
 *
 * 不变量 #15：description.length <= 2048。
 * 实施要点：当原描述超长时，slice 到 (2048 - suffix.length) 字符后追加后缀，
 * 保证最终长度恰好 = 2048。
 */
function truncateDescription(desc: string): string {
  if (desc.length <= DESCRIPTION_MAX_LENGTH) return desc;
  const keep = DESCRIPTION_MAX_LENGTH - DESCRIPTION_TRUNCATED_SUFFIX.length;
  return desc.slice(0, keep) + DESCRIPTION_TRUNCATED_SUFFIX;
}

/**
 * 工具池隔离实施（PRD mod-03 §3.2）
 *
 * 实现 omniagent-types.ts §7 的 MergeAndFilterToolsFn。
 *
 * 不变量 #4：coordinator 角色的 filtered 池必不含 bash/edit_file/write_file。
 * 不变量 #15：description > 2048 字符的工具截断 + 记入 errors。
 *
 * @param params.baseTools       父/全局工具池（fork 继承、main 全量、coordinator 过滤、worker/custom/teammate 用 customAgentTools 白名单筛选）
 * @param params.customAgentTools custom/teammate/worker 角色的白名单（仅这些工具可保留）
 * @param params.agentRole       当前 agent 角色
 * @param params.mcpTools        MCP 工具（合并到最后，遵守同样规则）
 * @returns { filtered, removed, errors }
 */
export function mergeAndFilterTools(
  params: MergeAndFilterToolsParams,
): MergeAndFilterToolsResult {
  const { baseTools, customAgentTools, agentRole, mcpTools } = params;
  const filtered: Tool[] = [];
  const removed: { tool: Tool; reason: string }[] = [];
  const errors: { tool: Tool; error: string }[] = [];

  // 1. 合并工具来源（baseTools + customAgentTools + mcpTools）
  const allTools: Tool[] = [
    ...baseTools,
    ...(customAgentTools ?? []),
    ...(mcpTools ?? []),
  ];

  // 2. 白名单集合（worker/custom/teammate 用）
  const whitelistNames =
    customAgentTools && customAgentTools.length > 0
      ? new Set(customAgentTools.map((t) => t.name))
      : null;

  // 3. 去重 + 角色过滤 + 描述截断
  const seen = new Set<string>();
  for (const tool of allTools) {
    // 去重：同名工具保留第一次出现，后续记入 removed
    if (seen.has(tool.name)) {
      removed.push({ tool, reason: 'duplicate name' });
      continue;
    }
    seen.add(tool.name);

    // Coordinator 角色：移除直接写工具（不变量 #4）
    if (agentRole === 'coordinator' && COORDINATOR_BANNED_TOOLS.has(tool.name)) {
      removed.push({
        tool,
        reason: `coordinator role banned: ${tool.name} (invariant #4)`,
      });
      continue;
    }

    // Custom/Teammate/Worker 角色：仅保留白名单内工具
    if (
      (agentRole === 'custom' ||
        agentRole === 'teammate' ||
        agentRole === 'worker') &&
      whitelistNames
    ) {
      if (!whitelistNames.has(tool.name)) {
        removed.push({
          tool,
          reason: `not in ${agentRole} whitelist`,
        });
        continue;
      }
    }

    // Fork 角色：继承父工具池（baseTools 已是父快照，不过滤）
    // → 直接通过

    // Main 角色：全部通过
    // → 直接通过

    // 描述截断（不变量 #15：final length ≤ 2048 含后缀）
    if (tool.description.length > DESCRIPTION_MAX_LENGTH) {
      const truncated: Tool = {
        ...tool,
        description: truncateDescription(tool.description),
      };
      filtered.push(truncated);
      errors.push({ tool, error: 'description truncated' });
      continue;
    }

    filtered.push(tool);
  }

  return { filtered, removed, errors };
}

/**
 * 不变量 #4 守护器：检查 filtered 池是否含被禁工具。
 *
 * Coordinator Mode 在 BUILD_CONTEXT 调用 mergeAndFilterTools 后调用此守护器，
 * 若返回非空数组 → fail-closed（拒绝进入 ReAct Loop）。
 *
 * @returns 被禁工具名列表（空 = 通过，非空 = 违反不变量 #4）
 */
export function checkCoordinatorInvariant(
  filtered: Tool[],
): string[] {
  const violations: string[] = [];
  for (const tool of filtered) {
    if (COORDINATOR_BANNED_TOOLS.has(tool.name)) {
      violations.push(tool.name);
    }
  }
  return violations;
}

/**
 * 判断角色是否需要应用 Coordinator 不变量 #4 过滤
 */
export function isCoordinatorRole(role: AgentRole): boolean {
  return role === 'coordinator';
}
