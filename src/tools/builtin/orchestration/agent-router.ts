/**
 * AgentRouterTool（L3-M5 §5.1 — agent_router）
 *
 * LLM 调用：
 *   agent_router(route="sync", prompt="list files")
 *   agent_router(route="async", prompt="run full test suite")
 *   agent_router(route="fork", prompt="refactor this module")
 *   agent_router(route="teammate", teammate_name="alice", prompt="review PR #42")
 *   agent_router(route="remote", remote_target="user@host", prompt="run tests on remote")
 *
 * 分发到 Orchestrator.route()，返回 task_id + work_item_id + status。
 *
 * M2 iter 1 范围：sync/async/fork 3 路径
 * M2 iter 2 范围：teammate 路径（按 name 寻址，不变量 #2）
 * M2 iter 3 范围：remote 路径（SSH 远程委托，不变量 #16 场景 6/7/8）
 * M2 iter 4+ 范围：跨 provider fallback chain（v2.x 评估）
 */

import type {
  AgentRoute,
  MailboxName,
  PermissionDecision,
  Tool,
  ToolInput,
  ToolResult,
  ToolUseId,
} from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';
import type { Orchestrator } from '../../../orchestration/orchestrator.js';

/** 构造依赖 */
export interface AgentRouterToolDeps {
  orchestrator: Orchestrator;
  /** 父 agent ID（主 agent 调用时注入） */
  parentAgentId: () => string;
  /** trace ID 生成器（M2 stub：用 randomUUID） */
  traceIdGen?: () => string;
}

export function createAgentRouterTool(deps: AgentRouterToolDeps): Tool {
  return buildTool({
    name: 'agent_router',
    description:
      'Dispatch a sub-agent task via sync/async/fork/teammate/remote routing. ' +
      'sync: block main conversation until sub-agent completes. ' +
      'async: return task_id immediately, sub-agent runs in background (use task_output to read result). ' +
      'fork: inherit parent context + independent sidechain (prompt cache prefix byte-identical). ' +
      'teammate: register a teammate by name (invariant #2) + assign worktree (invariant #1); use send_message to communicate. ' +
      'remote: SSH delegate to a remote OmniAgent instance (invariant #16 scenario 6: sidecar 404 → unreachable). ' +
      'Returns {task_id, work_item_id, status, result?}.',
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          enum: ['sync', 'async', 'fork', 'teammate', 'remote'],
          description: 'Routing mode: sync (blocking), async (background), fork (inherit parent context), teammate (named sub-agent), or remote (SSH delegate).',
        },
        prompt: {
          type: 'string',
          description: 'Sub-agent prompt to execute.',
        },
        teammate_name: {
          type: 'string',
          description: 'Required for route=teammate. Teammate name (MailboxName, invariant #2: name addressing). Must be unique across the team.',
        },
        remote_target: {
          type: 'string',
          description: 'Required for route=remote. SSH target (e.g. "user@host[:port]" or ssh alias).',
        },
        parent_context_mode: {
          type: 'string',
          enum: ['inherit', 'isolated'],
          description: 'fork path defaults to inherit; sync/async default to isolated.',
        },
        tools_whitelist: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tools allowed for the sub-agent (default: inherit parent tools).',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Timeout in milliseconds (default: provider-specific).',
          minimum: 1000,
        },
      },
      required: ['route', 'prompt'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: true,
    isBackground: false,

    checkPermissions(_input: ToolInput): PermissionDecision {
      // agent_router 涉及子 agent 执行，默认 ask（M3 完整版接入 M4 五层拦截）
      // M2 stub：allow（orchestrator 内部 fail-closed）
      return { decision: 'allow', matchedRule: 'm2-stub', layer: 2 };
    },

    async call(input: ToolInput, ctx): Promise<ToolResult> {
      const startMs = Date.now();
      const toolUseId = (ctx?.toolUseId ?? ('' as ToolUseId)) as ToolUseId;
      const route = input.route as AgentRoute;
      const prompt = input.prompt as string;

      if (!route) {
        return errorResult(toolUseId, 'agent_router: route is required', { duration_ms: Date.now() - startMs });
      }
      if (!prompt) {
        return errorResult(toolUseId, 'agent_router: prompt is required', { duration_ms: Date.now() - startMs });
      }
      const validRoutes = ['sync', 'async', 'fork', 'teammate', 'remote'];
      if (!validRoutes.includes(route)) {
        return errorResult(
          toolUseId,
          `agent_router: unsupported route "${route}" in M2 iter 3 (sync/async/fork/teammate/remote)`,
          { duration_ms: Date.now() - startMs },
        );
      }
      // teammate 路径必须有 teammate_name（不变量 #2）
      if (route === 'teammate' && !input.teammate_name) {
        return errorResult(
          toolUseId,
          'agent_router: teammate_name is required for route=teammate (invariant #2: name addressing)',
          { duration_ms: Date.now() - startMs },
        );
      }
      // remote 路径必须有 remote_target
      if (route === 'remote' && !input.remote_target) {
        return errorResult(
          toolUseId,
          'agent_router: remote_target is required for route=remote (e.g. "user@host")',
          { duration_ms: Date.now() - startMs },
        );
      }

      const parentAgentId = deps.parentAgentId();
      const traceId = (deps.traceIdGen ?? (() => crypto.randomUUID()))() as never;

      try {
        const result = await deps.orchestrator.route({
          route,
          prompt,
          teammate_name: input.teammate_name as MailboxName | undefined,
          remote_target: input.remote_target as string | undefined,
          parent_context_mode: input.parent_context_mode as 'inherit' | 'isolated' | undefined,
          tools_whitelist: input.tools_whitelist as string[] | undefined,
          timeout_ms: input.timeout_ms as number | undefined,
          parentAgentId: parentAgentId as never,
          traceId,
        });

        const summary = JSON.stringify({
          task_id: result.task_id,
          work_item_id: result.work_item_id,
          status: result.status,
          has_result: !!result.result,
        });

        return okResult(
          toolUseId,
          `agent_router: ${route} path dispatched.\n\n${summary}`,
          { compactable: false, duration_ms: Date.now() - startMs },
        );
      } catch (err) {
        return errorResult(
          toolUseId,
          `agent_router: ${(err as Error).message}`,
          { duration_ms: Date.now() - startMs },
        );
      }
    },
  });
}
