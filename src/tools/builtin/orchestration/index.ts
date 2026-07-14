/**
 * 编排工具注册（L3-M5 §5.1 — M2 iter 1 + iter 2）
 *
 * agent_router / task_create / task_stop / task_output / send_message 工具
 * 这些工具需要注入 TaskManager / SidechainManager 等依赖，
 * 不像文件/Shell 工具那样全局共享，通过工厂函数按需创建。
 *
 * M2 iter 1 范围：
 * - agent_router（sync/async/fork 3 路径分发）
 * - task_output（task_output 工具）
 *
 * M2 iter 2 范围：
 * - send_message（按 name 寻址，写 teammate mailbox）
 * - task_create（teammate 路径：register + worktree）
 * - task_stop（graceful 走 ShutdownHandshake；force 走 abandon）
 */

import type { Tool } from '../../../types/index.js';
import { createTaskOutputTool } from './task-output.js';
import type { TaskOutputToolDeps } from './task-output.js';
import { createAgentRouterTool } from './agent-router.js';
import type { AgentRouterToolDeps } from './agent-router.js';
import { createSendMessageTool } from './send-message.js';
import type { SendMessageToolDeps } from './send-message.js';
import { createTaskCreateTool } from './task-create.js';
import type { TaskCreateToolDeps } from './task-create.js';
import { createTaskStopTool } from './task-stop.js';
import type { TaskStopToolDeps } from './task-stop.js';

export {
  createTaskOutputTool,
  createAgentRouterTool,
  createSendMessageTool,
  createTaskCreateTool,
  createTaskStopTool,
};
export type {
  TaskOutputToolDeps,
  AgentRouterToolDeps,
  SendMessageToolDeps,
  TaskCreateToolDeps,
  TaskStopToolDeps,
};

/**
 * 创建编排工具集合
 *
 * @param deps 依赖：TaskManager / SidechainManager / Orchestrator / SwarmTeam / ShutdownHandshake / ThreeStateRecovery
 * @returns 编排工具数组
 */
export function createOrchestrationTools(deps: {
  taskOutput: TaskOutputToolDeps;
  agentRouter: AgentRouterToolDeps;
  sendMessage?: SendMessageToolDeps;
  taskCreate?: TaskCreateToolDeps;
  taskStop?: TaskStopToolDeps;
}): Tool[] {
  const tools: Tool[] = [
    createTaskOutputTool(deps.taskOutput),
    createAgentRouterTool(deps.agentRouter),
  ];
  if (deps.sendMessage) tools.push(createSendMessageTool(deps.sendMessage));
  if (deps.taskCreate) tools.push(createTaskCreateTool(deps.taskCreate));
  if (deps.taskStop) tools.push(createTaskStopTool(deps.taskStop));
  return tools;
}
