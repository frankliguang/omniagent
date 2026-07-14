import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { ReActLoop } from '../../src/core/react-loop.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { TranscriptStore } from '../../src/memory/transcript.js';
import { LocalMemoryEngine, SidechainManager } from '../../src/memory/sidechain.js';
import { BoundaryStore, defaultBoundaryPath } from '../../src/memory/boundary.js';
import {
  TaskManager,
  Orchestrator,
  SwarmTeam,
  TeammateRegistry,
  WorktreeRoster,
  InMemoryWorktreeOps,
  MailboxService,
  ShutdownHandshake,
  ThreeStateRecovery,
  makeReActLoopRunnerFactory,
} from '../../src/orchestration/index.js';
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js';
import { createOrchestrationTools } from '../../src/tools/builtin/orchestration/index.js';
import type { AgentId, MailboxName, Tool } from '../../src/types/index.js';
import type { LLMProvider, Credentials, ChatRequest, ChatChunk } from '../../src/types/index.js';

// ============================================================
// helpers
// ============================================================

function tmpHome(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-iter5-wiring-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const tmp = tmpHome();
  const oldHome = process.env.HOME;
  process.env.HOME = tmp;
  return fn().finally(async () => {
    process.env.HOME = oldHome;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
}

/** Mock LLM provider：返回固定 text_delta + end_turn */
function makeMockProvider(): LLMProvider {
  return {
    id: 'mock',
    displayName: 'Mock',
    capabilities: { streaming: true, toolUse: true, vision: false, audio: false },
    async authenticate(_creds: Credentials) {
      return { success: true, providerId: 'mock' };
    },
    async *chatStream(_req: ChatRequest): AsyncIterable<ChatChunk> {
      yield { type: 'text_delta', text: 'mock response' };
      yield { type: 'message_end', stopReason: 'end_turn', tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    },
  } as unknown as LLMProvider;
}

/** 构造与 src/index.ts main() 等价的编排组件 */
async function makeLiveFixture() {
  const sessionId = randomUUID();
  const home = process.env.HOME!;
  const mainTranscriptPath = path.join(home, '.omniagent', 'transcripts', `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(mainTranscriptPath), { recursive: true });
  const mainTranscript = await TranscriptStore.load(mainTranscriptPath);
  const engine = new LocalMemoryEngine(sessionId, mainTranscript);
  const sidechainManager = new SidechainManager(engine);
  const boundaryStore = new BoundaryStore({
    boundaryPath: defaultBoundaryPath(sessionId),
  });
  const taskManager = new TaskManager({ boundaryStore, sidechain: sidechainManager });
  const teammateRegistry = new TeammateRegistry();
  const worktreeBaseDir = path.join(home, '.omniagent', 'worktrees');
  const worktreeRoster = new WorktreeRoster(new InMemoryWorktreeOps(worktreeBaseDir));
  const mailboxService = new MailboxService();
  const swarmTeam = new SwarmTeam(mailboxService, teammateRegistry, worktreeRoster);
  const threeStateRecovery = new ThreeStateRecovery(
    teammateRegistry,
    mailboxService,
    worktreeRoster,
    taskManager,
    {
      // M2 iter 5: 注入 restart 回调（用 mock provider 跑一轮新 sidechain）
      restart: async (teammateName) => {
        const teammate = await teammateRegistry.get(teammateName);
        if (!teammate) {
          throw new Error(`cannot restart unregistered teammate "${teammateName}"`);
        }
        const sidechainId = await sidechainManager.create({
          parentTranscriptId: sessionId as never,
          runtimeTaskId: `restart-${Date.now()}` as never,
        });
        const runner = runnerFactory(sidechainId);
        const result = await runner.runTurn({
          prompt: `restart ${teammateName}`,
          sidechainId,
          parentAgentId: teammate.agentId,
        });
        await sidechainManager.flush(sidechainId);
        return {
          newAgentId: teammate.agentId,
          detail: `restart turn stopReason=${result.stopReason}, iterations=${result.iterations}`,
        };
      },
    },
  );
  const shutdownHandshake = new ShutdownHandshake(mailboxService);

  const provider = makeMockProvider();
  const runnerFactory = makeReActLoopRunnerFactory({
    sidechain: sidechainManager,
    makeLoop: () =>
      new ReActLoop({
        provider,
        memory: new WorkingMemory(),
        tools: BUILTIN_TOOLS,
        model: 'mock-model',
        systemPrompt: 'mock',
        cwd: process.cwd(),
        maxIterations: 5,
      }),
  });

  const orchestrator = new Orchestrator({
    taskManager,
    sidechain: sidechainManager,
    memoryEngine: engine,
    runnerFactory,
    swarmTeam,
  });

  const mainAgentId = 'omniagent-main' as AgentId;
  const mainMailboxName = 'omniagent-main' as MailboxName;

  const orchestrationTools: Tool[] = createOrchestrationTools({
    taskOutput: { taskManager, sidechainManager },
    agentRouter: { orchestrator, parentAgentId: () => mainAgentId },
    sendMessage: { mailboxService, parentAgentId: () => mainMailboxName },
    taskCreate: {
      taskManager,
      swarmTeam,
      parentAgentId: () => mainAgentId,
    },
    taskStop: {
      taskManager,
      shutdownHandshake,
      threeStateRecovery,
      teammateRegistry,
      swarmTeam,
      parentAgentId: () => mainAgentId,
      leaderName: () => mainMailboxName,
    },
  });

  return {
    engine,
    mainTranscript,
    sidechainManager,
    boundaryStore,
    taskManager,
    teammateRegistry,
    worktreeRoster,
    mailboxService,
    swarmTeam,
    threeStateRecovery,
    shutdownHandshake,
    orchestrator,
    orchestrationTools,
    mainAgentId,
    mainMailboxName,
    provider,
  };
}

// ============================================================
// 测试：编排工具完整构造 + 注册
// ============================================================

test('M2 iter 5: 编排工具 5 个全部构造成功（agent_router/task_create/task_stop/send_message/task_output）', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();
    const names = fix.orchestrationTools.map(t => t.name);
    assert.ok(names.includes('agent_router'), '应含 agent_router');
    assert.ok(names.includes('task_create'), '应含 task_create');
    assert.ok(names.includes('task_stop'), '应含 task_stop');
    assert.ok(names.includes('send_message'), '应含 send_message');
    assert.ok(names.includes('task_output'), '应含 task_output');
    assert.equal(fix.orchestrationTools.length, 5, '应构造 5 个编排工具');
    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});

test('M2 iter 5: BUILTIN_TOOLS + orchestrationTools 合并后无重名', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();
    const all = [...BUILTIN_TOOLS, ...fix.orchestrationTools];
    const names = all.map(t => t.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size, '工具名应唯一（无重名）');
    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});

test('M2 iter 5: agent_router(route=sync) 端到端跑通（真实 ReActLoop + mock provider）', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();
    // 找到 agent_router 工具
    const agentRouterTool = fix.orchestrationTools.find(t => t.name === 'agent_router')!;
    assert.ok(agentRouterTool, 'agent_router 工具应存在');

    // 调用 agent_router(route=sync, prompt="hello")
    const result = await agentRouterTool.call(
      { route: 'sync', prompt: 'hello' },
      { toolUseId: 'tu-test' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );

    assert.equal(result.is_error, false, 'agent_router(sync) 应成功');
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    // 工具返回的是摘要 "agent_router: sync path dispatched.\n\n{task_id, status, has_result}"
    assert.match(text, /sync path dispatched/, '应返回 dispatch 摘要');
    assert.match(text, /"status":"completed"/, 'task 应为 completed 状态');
    assert.match(text, /"has_result":true/, '应含子 agent 输出结果');

    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});

test('M2 iter 5: task_create(route=teammate) 注册 teammate + 分配 worktree', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();
    const taskCreateTool = fix.orchestrationTools.find(t => t.name === 'task_create')!;

    const result = await taskCreateTool.call(
      { route: 'teammate', teammate_name: 'alice', prompt: 'review PR' },
      { toolUseId: 'tu-1' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );

    assert.equal(result.is_error, false, 'task_create(teammate) 应成功');
    assert.equal(await fix.teammateRegistry.exists('alice' as MailboxName), true, 'teammate alice 应已注册');
    const worktree = fix.worktreeRoster.get('alice' as MailboxName);
    assert.ok(worktree, '应已分配 worktree');

    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});

test('M2 iter 5: send_message 写入 teammate mailbox（不变量 #7）', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();
    // 先创建 teammate
    const taskCreateTool = fix.orchestrationTools.find(t => t.name === 'task_create')!;
    await taskCreateTool.call(
      { route: 'teammate', teammate_name: 'bob', prompt: 'hello' },
      { toolUseId: 'tu-1' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );

    // 发消息给 bob（send_message 用 to/text 参数，非 teammate_name/content）
    const sendMessageTool = fix.orchestrationTools.find(t => t.name === 'send_message')!;
    const result = await sendMessageTool.call(
      { to: 'bob', text: 'hello bob', type: 'text' },
      { toolUseId: 'tu-2' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );

    assert.equal(result.is_error, false, 'send_message 应成功');
    const unread = await fix.mailboxService.readUnread('bob' as MailboxName);
    assert.equal(unread.length, 1, 'bob mailbox 应有 1 条未读消息');

    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});

test('M2 iter 5: task_output 读取已完成的 task 输出', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();

    // 先 agent_router(sync) 创建一个完成的 task
    const agentRouterTool = fix.orchestrationTools.find(t => t.name === 'agent_router')!;
    const routeResult = await agentRouterTool.call(
      { route: 'sync', prompt: 'hello' },
      { toolUseId: 'tu-1' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );
    // 从摘要 JSON 中提取 task_id
    const text = (routeResult.content[0] as { type: 'text'; text: string }).text;
    const taskIdMatch = text.match(/"task_id":"([^"]+)"/);
    const taskId = taskIdMatch?.[1] ?? '';
    assert.ok(taskId, `应能解析 task_id，实际 text="${text.slice(0, 100)}..."`);

    // 读取 task_output
    const taskOutputTool = fix.orchestrationTools.find(t => t.name === 'task_output')!;
    const result = await taskOutputTool.call(
      { task_id: taskId },
      { toolUseId: 'tu-2' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );

    assert.equal(result.is_error, false, 'task_output 应成功');
    const outText = (result.content[0] as { type: 'text'; text: string }).text;
    assert.match(outText, /status:\s*completed/i, 'task 应为 completed 状态');

    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});

test('M2 iter 5: graceful shutdown approve → 释放 worktree + 注销 teammate（不变量 #6 + 资源清理）', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();

    // 1. 创建 teammate（task_create teammate）
    const taskCreateTool = fix.orchestrationTools.find(t => t.name === 'task_create')!;
    const createResult = await taskCreateTool.call(
      { route: 'teammate', teammate_name: 'carol', prompt: 'work' },
      { toolUseId: 'tu-1' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );
    assert.equal(createResult.is_error, false, 'task_create 应成功');
    assert.equal(await fix.teammateRegistry.exists('carol' as MailboxName), true, 'carol 应已注册');
    assert.ok(fix.worktreeRoster.get('carol' as MailboxName), 'carol 应有 worktree');

    // 从 create 结果中提取 task_id
    const createText = (createResult.content[0] as { type: 'text'; text: string }).text;
    const taskId = createText.match(/"task_id":"([^"]+)"/)?.[1] ?? '';

    // 2. 模拟 teammate 同意 shutdown：直接在 teammate mailbox 写一条 shutdown_response
    //    （实际生产中 teammate 会调 ShutdownHandshake.handleRequest，本测试直接构造 response）
    await fix.mailboxService.send({
      from: 'carol' as MailboxName,
      to: fix.mainMailboxName,
      type: 'shutdown_response',
      payload: { request_id: 'test-req-1', approve: true, reason: 'all_done' },
    });

    // 3. leader 发 shutdown_request（写入 carol mailbox）
    //    这一步是握手协议 step 1，waitForResponse 会先轮询 leader mailbox
    const taskStopTool = fix.orchestrationTools.find(t => t.name === 'task_stop')!;
    // 先发 shutdown_request（waitForResponse 要求先有 record）
    await fix.shutdownHandshake.sendRequest('carol' as MailboxName, {
      agentId: fix.mainAgentId,
      leaderName: fix.mainMailboxName,
      reason: 'user_exit',
    });

    // 4. 调 task_stop(graceful) — 内部调 waitForResponse，发现 approve=true 后
    //    应触发 swarmTeam.leaveTeam（释放 worktree + 注销 registry）
    const stopResult = await taskStopTool.call(
      { task_id: taskId, strategy: 'graceful', teammate_name: 'carol' },
      { toolUseId: 'tu-2' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );

    assert.equal(stopResult.is_error, false, 'task_stop(graceful) 应成功');
    const stopText = (stopResult.content[0] as { type: 'text'; text: string }).text;
    assert.match(stopText, /"approve":true/, '应 approve=true');
    assert.match(stopText, /"cleanup":\{"ok":true\}/, 'cleanup 应成功（worktree 释放 + registry 注销）');

    // 5. 验证资源已清理
    assert.equal(
      await fix.teammateRegistry.exists('carol' as MailboxName),
      false,
      'graceful approve 后 carol 应已从 registry 注销',
    );
    assert.equal(
      !!fix.worktreeRoster.get('carol' as MailboxName),
      false,
      'graceful approve 后 carol 的 worktree 应已释放',
    );

    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});

test('M2 iter 5: async task 完成后记录 CompactBoundary（triggerLayer=L2_session）', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();

    // agent_router(sync) 创建并完成一个 task（带 sidechainId）
    const agentRouterTool = fix.orchestrationTools.find(t => t.name === 'agent_router')!;
    const routeResult = await agentRouterTool.call(
      { route: 'sync', prompt: 'hello' },
      { toolUseId: 'tu-1' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );
    assert.equal(routeResult.is_error, false, 'agent_router(sync) 应成功');

    // 验证 BoundaryStore 中应有至少 1 条 boundary 记录
    // （completeTask 在 task.sidechainId 存在时调 recordBoundary）
    const { promises: fsP } = await import('node:fs');
    const boundaryPath = fix.boundaryStore['boundaryPath' as keyof typeof fix.boundaryStore] as string;
    const boundaryContent = await fsP.readFile(boundaryPath, 'utf8').catch(() => '');
    const boundaryLines = boundaryContent.split('\n').filter(l => l.trim());
    assert.ok(boundaryLines.length >= 1, `应有 ≥1 条 boundary 记录，实际 ${boundaryLines.length}`);

    // 解析最后一条 boundary
    const lastBoundary = JSON.parse(boundaryLines[boundaryLines.length - 1]!);
    assert.equal(lastBoundary.triggerLayer, 'L2_session', 'triggerLayer 应为 L2_session');
    assert.ok(lastBoundary.boundary_id, '应有 boundary_id');
    assert.ok(lastBoundary.transcriptId, '应有 transcriptId（= sidechainId）');
    assert.ok(typeof lastBoundary.compactRange.start === 'number', 'compactRange.start 应为数字');
    assert.ok(typeof lastBoundary.compactRange.end === 'number', 'compactRange.end 应为数字');
    assert.ok(lastBoundary.timestamp, '应有 timestamp');

    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});

test('M2 iter 5: failTask 也记录 CompactBoundary（允许 /rewind 到失败点排查）', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();

    // 手动创建一个带 sidechainId 的 task 然后调 failTask
    const { workItemId, runtimeTaskId } = await fix.taskManager.createDualTrack({
      route: 'sync',
      prompt: 'will fail',
      parentAgentId: 'parent-1',
    });
    void workItemId;
    // 关联 sidechain
    const sidechainId = await fix.sidechainManager.create({
      parentTranscriptId: 'parent-1' as never,
      runtimeTaskId,
    });
    await fix.taskManager.setSidechain(runtimeTaskId, sidechainId);

    // 调 failTask
    await fix.taskManager.failTask(runtimeTaskId, 'test failure');

    // 验证 boundary 文件应有 1 条记录
    const { promises: fsP } = await import('node:fs');
    const boundaryPath = fix.boundaryStore['boundaryPath' as keyof typeof fix.boundaryStore] as string;
    const boundaryContent = await fsP.readFile(boundaryPath, 'utf8').catch(() => '');
    const boundaryLines = boundaryContent.split('\n').filter(l => l.trim());
    assert.ok(boundaryLines.length >= 1, `failTask 应记录 boundary，实际 ${boundaryLines.length} 条`);

    const lastBoundary = JSON.parse(boundaryLines[boundaryLines.length - 1]!);
    assert.equal(lastBoundary.triggerLayer, 'L2_session', 'failTask boundary 也应为 L2_session');
    assert.equal(lastBoundary.transcriptId, sidechainId, 'transcriptId 应等于 sidechainId');

    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});

test('M2 iter 5: three-state recovery restart — stopped 状态 + 注入 restart 回调 → 重启成功', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();

    // 1. 创建 teammate（task_create teammate）
    const taskCreateTool = fix.orchestrationTools.find(t => t.name === 'task_create')!;
    await taskCreateTool.call(
      { route: 'teammate', teammate_name: 'dave', prompt: 'work' },
      { toolUseId: 'tu-1' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );

    // 2. 给 dave 发一条未读消息（确保 stopped 而非 evicted）
    await fix.mailboxService.send({
      from: fix.mainMailboxName,
      to: 'dave' as MailboxName,
      type: 'text',
      payload: { text: 'pending work item' },
    });

    // 3. 默认 processAliveChecker 返回 false（无 subprocess）→ checkStatus 应为 'stopped'
    //    （teammate 已注册 + 进程不存活 + mailbox 有未读 → stopped）
    const status = await fix.threeStateRecovery.checkStatus('dave' as MailboxName);
    assert.equal(status, 'stopped', `dave 应为 stopped（进程不存活 + mailbox 有未读），实际 ${status}`);

    // 4. 调 recover('restart') — 注入的 restart 回调应执行（用 mock runner）
    const result = await fix.threeStateRecovery.recover('dave' as MailboxName, {
      strategy: 'restart',
      reason: 'teammate process killed',
    });

    assert.equal(result.recovered, true, 'restart 应成功');
    assert.equal(result.status, 'stopped', 'recover 前状态应为 stopped');
    assert.match(result.detail ?? '', /restarted/i, 'detail 应标注 restarted');

    // 5. 验证 teammate 仍在 registry（restart 不注销）
    assert.equal(
      await fix.teammateRegistry.exists('dave' as MailboxName),
      true,
      'restart 后 dave 应仍在 registry（restart 不注销）',
    );
    // 6. 验证 worktree 仍分配（restart 不释放）
    assert.ok(
      fix.worktreeRoster.get('dave' as MailboxName),
      'restart 后 dave 的 worktree 应仍分配',
    );
    // 7. mailbox 未读消息应保留（restart 不消费 mailbox）
    //    注意：restart 内部可能产生新 sidechain，但 mailbox 不变
    const unread = await fix.mailboxService.readUnread('dave' as MailboxName);
    assert.equal(unread.length, 1, 'mailbox 未读消息应保留（restart 不消费）');

    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});

test('M2 iter 5: three-state recovery — running 状态调 restart 不重启', async () => {
  await withTempHome(async () => {
    const fix = await makeLiveFixture();

    // 创建 teammate
    const taskCreateTool = fix.orchestrationTools.find(t => t.name === 'task_create')!;
    await taskCreateTool.call(
      { route: 'teammate', teammate_name: 'eve', prompt: 'work' },
      { toolUseId: 'tu-1' as never, cwd: process.cwd(), permissionMode: 'default' as never, agentId: fix.mainAgentId, abortSignal: new AbortController().signal, agentRole: 'main' as never },
    );

    // 注入 processAliveChecker 返回 true → status 应为 running
    // （需要重新构造 ThreeStateRecovery with 注入 checker）
    const { ThreeStateRecovery } = await import('../../src/orchestration/index.js');
    const aliveRecovery = new ThreeStateRecovery(
      fix.teammateRegistry,
      fix.mailboxService,
      fix.worktreeRoster,
      fix.taskManager,
      {
        processAliveChecker: async () => true,
        restart: async () => { throw new Error('should not be called'); },
      },
    );
    const status = await aliveRecovery.checkStatus('eve' as MailboxName);
    assert.equal(status, 'running', 'eve 应为 running（processAliveChecker 返回 true）');

    const result = await aliveRecovery.recover('eve' as MailboxName, { strategy: 'restart' });
    assert.equal(result.recovered, false, 'running 状态调 restart 不应重启');
    assert.match(result.detail ?? '', /still running/i, 'detail 应标注 still running');

    await fix.engine.closeAll();
    await fix.mainTranscript.close();
  });
});
