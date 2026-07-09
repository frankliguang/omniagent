# OmniAgent CLI — L3 模块设计：M5 多 Agent 编排引擎 (Orchestration)

> 模块 ID: M5
> 主负责角色: 架构师
> 阻塞里程碑: M2（多 Agent 协作）
> 源章节: 总体 PRD §4.3 + mod-05 PRD + L2 §5.3（writeMailboxAtomic）+ §4.2.4/§4.2.6（fork/shutdown 时序图）+ omniagent-types.ts §8/§9/§10
> 状态: 草稿（2026-07-08）
> 文档定位: L3 模块级（PRD 是 L1 产品级，L2 是 L2 技术级，L3 是 L2 的细化到类/函数级）

---

## 文档定位与不重复原则

本文档是 M5 多 Agent 编排引擎的 L3 模块设计，**不重复** PRD mod-05 与 L2 §5/§4.2 的已有内容，仅引用并补到类/函数级实施粒度：

- **PRD mod-05 §3.1 的 agent_router 5 路径** → 本文 §3.1 引用，补 Orchestrator.route() 实施 + 5 路径分发代码
- **PRD mod-05 §3.2 的 Task 双轨设计** → 本文 §3.2 引用，补 TaskManager + WorkItemStore + RuntimeTaskStore 实施
- **PRD mod-05 §3.3 的 Mailbox 通信契约** → 本文 §3.3 引用 + L2 §5.3 的 writeMailboxAtomic 实现
- **PRD mod-05 §4.1 的 4 协作模式** → 本文 §3.4-§3.7 引用，补 CoordinatorMode / SwarmTeam / ForkAgentSpawner / RemoteAgentClient 实施
- **PRD mod-05 §4.2 的三态恢复** → 本文 §3.8 引用，补 ThreeStateRecovery 实施
- **PRD mod-05 §4.3 的 Shutdown 四步握手** → 本文 §3.9 引用 + L2 §4.2.6 时序图
- **PRD mod-05 §4.4 的 Workflow Orchestrator** → 本文 §3.10 引用，补 WorkflowOrchestrator 实施（决策 A3 默认 off）
- **L2 §5.3 的 writeMailboxAtomic 实现** → 本文 §3.3 引用，补 MailboxService 包装
- **L2 §4.2.4 的 agent_router fork 时序图** → 本文 §3.6 引用不复制
- **L2 §4.2.6 的 Shutdown 四步握手时序图** → 本文 §3.9 引用不复制
- **L2 §6 的 26 个错误码** → 本文 §5.1 引用，补 M5 触发的错误码子集
- **L2 §11 的 M2 里程碑交付物** → 本文 §7 引用，补 M5 在每迭代交付的组件

---

## 1. 模块概述

### 1.1 范围（引用 PRD §1.1，不重复）

M5 负责定义并实现多 Agent 编排引擎，覆盖 PRD mod-05 §1.1 列出的 7 项 in-scope：

1. 单一入口路由：所有多 Agent 操作通过 `agent_router` 工具路由，5 条路径（sync / async / fork / teammate / remote）
2. 协作模式标准化：Coordinator Mode（主从编排）、Swarm/Team（对等团队）、Fork Agent（上下文分叉）、Remote Agent（远程委托）
3. Task 双轨设计：Work item JSON（LLM 维护）+ Runtime task（harness 维护，7 种 subtypes）
4. Mailbox 通信：文件系统 JSONL，按 name 寻址，原子写 + 退避
5. 三态恢复：running / stopped / evicted
6. Shutdown 四步握手
7. 工作流编排器（Workflow Orchestrator，实验 feature 默认 off，决策 A3）

### 1.2 边界（引用 PRD §1.2，不重复）

M5 只做"路由与协作原语"，不做工具执行与 LLM 调用：

- **工具接口实现** → M3 通用工具系统；M5 提供 `agent_router` / `send_message` / `task_create` / `task_stop` / `task_output` 工具的路由逻辑
- **权限拦截** → M4 权限与拦截系统；M5 agent spawn 同样经五层拦截链
- **上下文压缩与 sidechain 持久化** → M7 上下文与记忆引擎；M5 只触发 sidechain 创建
- **LLM 调用** → M1 模型抽象层；M5 spawn 的子 agent 通过 M2 ReAct Loop 调用 LLM

### 1.3 在整体架构中的位置（引用 L2 §1，不重复）

多 Agent 编排引擎是 harness 层的**协作枢纽**。从单条 query 到 Fork、Async Subagent、Coordinator Worker、Swarm Teammate、Remote Agent，共享同一套 task / mailbox / sidechain 基础设施。用户按任务复杂度选择协作模式，范式统一、原语可组合。

---

## 2. 组件清单

### 2.1 组件总览

| # | 组件 | 类型 | 文件路径 | 职责 |
|---|------|------|---------|------|
| 1 | `AgentRoute` / `RuntimeTaskSubtype` / `TaskStatus` | type | `omniagent-types.ts` §8 | 5 路径 + 7 subtypes + 6 状态（已定义） |
| 2 | `WorkItem` / `RuntimeTask` | interface | `omniagent-types.ts` §8 | Task 双轨（已定义） |
| 3 | `AgentRouterParams` / `AgentRouterResult` | interface | `omniagent-types.ts` §8 | agent_router 工具签名（已定义） |
| 4 | `MailboxMessage` / `MailboxCapacityLimits` | interface | `omniagent-types.ts` §9 | Mailbox 消息 + 容量限制（已定义） |
| 5 | `WriteMailboxAtomicParams` / `Result` | interface | `omniagent-types.ts` §9 | 原子写原语签名（已定义） |
| 6 | `CompactBoundary` | interface | `omniagent-types.ts` §10 | 压缩点元数据（M7 定义，M5 依赖） |
| 7 | `Orchestrator` | class | `src/orchestration/orchestrator.ts` | 主入口，路由 5 路径 |
| 8 | `AgentRouter` | class | `src/orchestration/agent-router.ts` | 实现 agent_router 工具逻辑 |
| 9 | `TaskManager` | class | `src/orchestration/task-manager.ts` | WorkItem + RuntimeTask 双轨管理 |
| 10 | `WorkItemStore` | class | `src/orchestration/work-item-store.ts` | work item JSON 持久化（LLM 维护） |
| 11 | `RuntimeTaskStore` | class | `src/orchestration/runtime-task-store.ts` | runtime task 状态持久化（harness 维护） |
| 12 | `MailboxService` | class | `src/orchestration/mailbox.ts` | mailbox 读写（包装 M7 writeMailboxAtomic） |
| 13 | `CoordinatorMode` | class | `src/orchestration/modes/coordinator.ts` | 主从编排模式 |
| 14 | `SwarmTeam` | class | `src/orchestration/modes/swarm.ts` | 对等团队模式 |
| 15 | `ForkAgentSpawner` | class | `src/orchestration/modes/fork.ts` | 上下文分叉 + prompt cache prefix byte-identical |
| 16 | `RemoteAgentClient` | class | `src/orchestration/modes/remote.ts` | SSH 远程委托 |
| 17 | `ThreeStateRecovery` | class | `src/orchestration/recovery.ts` | running/stopped/evicted 三态恢复 |
| 18 | `ShutdownHandshake` | class | `src/orchestration/shutdown.ts` | 四步握手协议状态机 |
| 19 | `WorkflowOrchestrator` | class | `src/orchestration/workflow.ts` | 声明式 YAML 工作流（决策 A3 默认 off） |
| 20 | `SidechainManager` | class | `src/orchestration/sidechain.ts` | sidechain transcript（委托 M7 持久化） |
| 21 | `WorktreeRoster` | class | `src/orchestration/worktree-roster.ts` | worktree 唯一归属（不变量 #1） |
| 22 | `TeammateRegistry` | class | `src/orchestration/teammate-registry.ts` | name→agentId 映射（不变量 #2） |

### 2.2 公共接口签名

#### 2.2.1 `Orchestrator`（主入口）

```typescript
class Orchestrator {
  constructor(
    private taskManager: TaskManager,
    private mailbox: MailboxService,
    private sidechain: SidechainManager,
    private worktreeRoster: WorktreeRoster,
    private teammateRegistry: TeammateRegistry,
    private recovery: ThreeStateRecovery,
    private shutdown: ShutdownHandshake,
    private modes: {
      coordinator: CoordinatorMode;
      swarm: SwarmTeam;
      fork: ForkAgentSpawner;
      remote: RemoteAgentClient;
    },
    private workflow?: WorkflowOrchestrator,  // 决策 A3 默认 off
  ) {}

  /**
   * agent_router 工具入口（PRD mod-05 §5.1）
   * 实现 M3 暴露的 agent_router 工具的 route 逻辑
   */
  async route(params: AgentRouterParams & { parentAgentId: AgentId; traceId: TraceId }): Promise<AgentRouterResult> {
    // 1. 创建 WorkItem + RuntimeTask
    const { workItemId, runtimeTaskId } = await this.taskManager.createDualTrack({
      route: params.route,
      prompt: params.prompt,
      parentAgentId: params.parentAgentId,
    });

    // 2. 按 route 分发
    try {
      let result: ToolResult | undefined;
      switch (params.route) {
        case 'sync':
          result = await this.modes.coordinator.spawnSync({ ...params, runtimeTaskId });
          break;
        case 'async':
          result = await this.modes.coordinator.spawnAsync({ ...params, runtimeTaskId });
          break;
        case 'fork':
          result = await this.modes.fork.spawn({ ...params, runtimeTaskId });
          break;
        case 'teammate':
          result = await this.modes.swarm.joinTeam({ ...params, runtimeTaskId });
          break;
        case 'remote':
          result = await this.modes.remote.delegate({ ...params, runtimeTaskId });
          break;
        default:
          return { task_id: runtimeTaskId, work_item_id: workItemId, status: 'failed' };
      }
      await this.taskManager.completeTask(runtimeTaskId, result);
      return { task_id: runtimeTaskId, work_item_id: workItemId, status: 'completed', result };
    } catch (err) {
      await this.taskManager.failTask(runtimeTaskId, err);
      return { task_id: runtimeTaskId, work_item_id: workItemId, status: 'failed', result: this.toErrorResult(err) };
    }
  }

  /** 发送 shutdown_request（M2 AbortCoordinator 场景 C 调用） */
  async sendShutdownRequest(teammateName: MailboxName, ctx: any): Promise<void> {
    await this.shutdown.sendRequest(teammateName, ctx);
  }

  /** 读取 task 输出（task_output 工具调用） */
  async getTaskOutput(taskId: TaskId, opts: { block: boolean; abortSignal: AbortSignal }): Promise<any> {
    return this.taskManager.getOutput(taskId, opts);
  }

  private toErrorResult(err: Error): ToolResult {
    return {
      tool_use_id: '' as ToolUseId,
      content: [{ type: 'text', text: err.message }],
      is_error: true,
    };
  }
}
```

#### 2.2.2 `TaskManager`（双轨管理）

```typescript
class TaskManager {
  constructor(
    private workItemStore: WorkItemStore,
    private runtimeTaskStore: RuntimeTaskStore,
  ) {}

  /** 创建 WorkItem + RuntimeTask 双轨 */
  async createDualTrack(params: {
    route: AgentRoute;
    prompt: string;
    parentAgentId: AgentId;
  }): Promise<{ workItemId: WorkItemId; runtimeTaskId: TaskId }> {
    const workItemId = generateId() as WorkItemId;
    const runtimeTaskId = generateId() as TaskId;

    const workItem: WorkItem = {
      id: workItemId,
      description: params.prompt,
      runtimeTaskIds: [runtimeTaskId],
      status: 'in_progress',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const runtimeTask: RuntimeTask = {
      id: runtimeTaskId,
      workItemId,
      subtype: params.route as RuntimeTaskSubtype,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    await this.workItemStore.save(workItem);
    await this.runtimeTaskStore.save(runtimeTask);
    return { workItemId, runtimeTaskId };
  }

  async completeTask(taskId: TaskId, result?: ToolResult): Promise<void> {
    const task = await this.runtimeTaskStore.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    task.status = 'completed';
    task.finishedAt = new Date().toISOString();
    await this.runtimeTaskStore.save(task);

    const workItem = await this.workItemStore.get(task.workItemId);
    if (workItem) {
      workItem.status = 'completed';
      workItem.updatedAt = new Date().toISOString();
      await this.workItemStore.save(workItem);
    }
  }

  async failTask(taskId: TaskId, err: Error): Promise<void> {
    const task = await this.runtimeTaskStore.get(taskId);
    if (!task) return;
    task.status = err.message.includes('timeout') ? 'timeout' : 'failed';
    task.finishedAt = new Date().toISOString();
    await this.runtimeTaskStore.save(task);
  }

  async getOutput(taskId: TaskId, opts: { block: boolean; abortSignal: AbortSignal }): Promise<any> {
    if (opts.block) {
      // 阻塞直到 task 完成 / 失败 / 中断
      return this.runtimeTaskStore.waitForCompletion(taskId, opts.abortSignal);
    }
    return this.runtimeTaskStore.get(taskId);
  }
}
```

#### 2.2.3 `MailboxService`（包装 M7 writeMailboxAtomic）

```typescript
/**
 * Mailbox 读写服务（包装 M7 writeMailboxAtomic 原语）
 * 引用 L2 §5.3 的 writeMailboxAtomic 实现
 */
class MailboxService {
  constructor(
    // M7 提供的原子写原语（types.ts §9 WriteMailboxAtomicFn）
    private writeMailboxAtomicFn: (params: WriteMailboxAtomicParams) => Promise<WriteMailboxAtomicResult>,
  ) {}

  /** 写消息（按 name 寻址，不变量 #2） */
  async send(params: {
    to: MailboxName;
    from: AgentId | MailboxName;
    type: MailboxMessage['type'];
    payload: unknown;
  }): Promise<{ written: boolean; archiveTriggered: boolean; error?: string }> {
    const message: MailboxMessage = {
      id: generateId() as UUID,
      from: params.from,
      to: params.to,
      type: params.type,
      payload: params.payload,
      timestamp: new Date().toISOString(),
      read: false,
    };

    // 调用 M7 writeMailboxAtomic（L2 §5.3 实现）
    const result = await this.writeMailboxAtomicFn({
      teammate_name: params.to,
      message,
    });

    return {
      written: result.written,
      archiveTriggered: result.archive_triggered ?? false,
      error: result.error,
    };
  }

  /** 读取未读消息（按 name 寻址） */
  async readUnread(name: MailboxName): Promise<MailboxMessage[]> {
    const mailboxPath = `~/.omniagent/mailbox/${name}.jsonl`;
    const messages = await this.readJsonl(mailboxPath);
    const unread = messages.filter(m => !m.read);
    // 标记已读
    for (const m of unread) {
      m.read = true;
    }
    await this.writeJsonl(mailboxPath, messages);
    return unread;
  }

  /** 读取所有消息（含已读，用于 leader 重启后恢复） */
  async readAll(name: MailboxName): Promise<MailboxMessage[]> {
    return this.readJsonl(`~/.omniagent/mailbox/${name}.jsonl`);
  }

  private async readJsonl(path: string): Promise<MailboxMessage[]> { /* ... */ }
  private async writeJsonl(path: string, messages: MailboxMessage[]): Promise<void> { /* ... */ }
}
```

#### 2.2.4 `CoordinatorMode`（主从编排）

```typescript
/**
 * Coordinator Mode（PRD mod-05 §4.1）
 * 主 Agent 只编排，不直接执行 Bash/Edit/Write
 * mergeAndFilterTools 强制移除主 Agent 的写工具（不变量 #4，M3 实现）
 */
class CoordinatorMode {
  constructor(
    private taskManager: TaskManager,
    private sidechain: SidechainManager,
    private reactLoopFactory: () => ReActLoop,  // 子 agent 用 M2 ReActLoop
  ) {}

  /** sync 路径：同步子 agent，阻塞主对话 */
  async spawnSync(params: AgentRouterParams & { runtimeTaskId: TaskId; parentAgentId: AgentId }): Promise<ToolResult> {
    // 1. 创建 sidechain（独立 transcript，不污染父会话）
    const sidechainId = await this.sidechain.create({
      parentTranscriptId: params.parentAgentId,
      runtimeTaskId: params.runtimeTaskId,
    });

    // 2. spawn 子 agent（独立进程或同进程独立 ReActLoop）
    const subLoop = this.reactLoopFactory();
    const result = await subLoop.runTurn({
      text: params.prompt,
      sessionId: sidechainId as any,
      traceId: generateTraceId(),
    });

    // 3. 持久化 sidechain transcript（M7）
    await this.sidechain.flush(sidechainId);

    return {
      tool_use_id: '' as ToolUseId,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      is_error: result.stopReason === 'failed',
      metadata: { duration_ms: 0, compactable: false },
    };
  }

  /** async 路径：异步后台子 agent，不阻塞 */
  async spawnAsync(params: AgentRouterParams & { runtimeTaskId: TaskId; parentAgentId: AgentId }): Promise<ToolResult> {
    // 后台 spawn，立即返回 task_id（主 agent 通过 task_output 工具读取结果）
    setImmediate(async () => {
      await this.spawnSync({ ...params, route: 'sync' as any });
    });
    return {
      tool_use_id: '' as ToolUseId,
      content: [{ type: 'text', text: `async task started: ${params.runtimeTaskId}` }],
      is_error: false,
      metadata: { duration_ms: 0, compactable: false },
    };
  }
}
```

#### 2.2.5 `SwarmTeam`（对等团队）

```typescript
/**
 * Swarm/Team 模式（PRD mod-05 §4.1）
 * 多 teammate 共享 task list + mailbox
 * 按 name 寻址（不是 agentId，不变量 #2）
 */
class SwarmTeam {
  constructor(
    private mailbox: MailboxService,
    private teammateRegistry: TeammateRegistry,
    private worktreeRoster: WorktreeRoster,
  ) {}

  /** 加入 Swarm Team（route=teammate） */
  async joinTeam(params: AgentRouterParams & { runtimeTaskId: TaskId; parentAgentId: AgentId }): Promise<ToolResult> {
    if (!params.teammate_name) {
      throw new Error('teammate_name required for route=teammate');
    }

    // 1. 注册 teammate（name → agentId 映射，不变量 #2）
    const teammateAgentId = generateId() as AgentId;
    await this.teammateRegistry.register({
      name: params.teammate_name,
      agentId: teammateAgentId,
      parentAgentId: params.parentAgentId,
    });

    // 2. 分配 worktree（不变量 #1：worktree 唯一归属）
    const worktree = await this.worktreeRoster.assign({
      teammateName: params.teammate_name,
      agentId: teammateAgentId,
    });

    // 3. 启动 teammate ReActLoop（独立进程）
    // teammate 通信通过 mailbox（跨 turn 持久化）
    // 此处返回 task_id，主 agent 通过 task_output / send_message 通信
    return {
      tool_use_id: '' as ToolUseId,
      content: [{ type: 'text', text: `teammate ${params.teammate_name} joined at worktree ${worktree.path}` }],
      is_error: false,
      metadata: { duration_ms: 0, compactable: false },
    };
  }

  /** 发送消息给 teammate */
  async sendMessage(params: {
    to: MailboxName;
    from: AgentId | MailboxName;
    type: MailboxMessage['type'];
    payload: unknown;
  }): Promise<void> {
    const result = await this.mailbox.send(params);
    if (!result.written) {
      throw new Error(`mailbox write failed: ${result.error}`);
    }
  }
}
```

#### 2.2.6 `ForkAgentSpawner`（上下文分叉）

```typescript
/**
 * Fork Agent 模式（PRD mod-05 §4.1）
 * 继承父 Agent 的上下文与工具池
 * prompt cache prefix byte-identical（不变量 #5）
 */
class ForkAgentSpawner {
  constructor(
    private sidechain: SidechainManager,
    private reactLoopFactory: () => ReActLoop,
    private memoryEngine: MemoryEngine,  // M7 注入，用于读取父上下文
  ) {}

  /** fork 路径：继承父上下文 + 独立 sidechain */
  async spawn(params: AgentRouterParams & { runtimeTaskId: TaskId; parentAgentId: AgentId }): Promise<ToolResult> {
    // 1. 读取父 agent 当前 messages（byte-identical 复制）
    const parentMessages = await this.memoryEngine.getCurrentMessages(params.parentAgentId);

    // 2. 占位 tool_result（不变量 #5：保证 prompt cache prefix byte-identical）
    // 对未完成的 tool_use 填入占位 tool_result，使 prefix 完全一致
    const forkedMessages = this.fillPlaceholderToolResults(parentMessages);

    // 3. 创建 sidechain（独立 transcript，不污染父会话）
    const sidechainId = await this.sidechain.create({
      parentTranscriptId: params.parentAgentId,
      runtimeTaskId: params.runtimeTaskId,
      initialMessages: forkedMessages,  // 继承父上下文
    });

    // 4. spawn fork agent（独立 ReActLoop，继承父工具池 byte-identical）
    const forkLoop = this.reactLoopFactory();
    const result = await forkLoop.runTurn({
      text: params.prompt,
      sessionId: sidechainId as any,
      traceId: generateTraceId(),
    });

    // 5. 持久化 sidechain
    await this.sidechain.flush(sidechainId);

    return {
      tool_use_id: '' as ToolUseId,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      is_error: result.stopReason === 'failed',
      metadata: { duration_ms: 0, compactable: false },
    };
  }

  /**
   * 占位 tool_result 填充（不变量 #5）
   * 对每个未配对的 tool_use，填入占位 tool_result（content="placeholder"）
   * 使 fork agent 的 prompt prefix 与父 agent byte-identical，最大化 cache 命中
   */
  private fillPlaceholderToolResults(messages: Message[]): Message[] {
    const result = [...messages];
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (const msg of result) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolUseIds.add(block.id);
        if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id);
      }
    }

    // 对未配对的 tool_use 填占位
    const orphanToolUseIds = [...toolUseIds].filter(id => !toolResultIds.has(id));
    if (orphanToolUseIds.length > 0) {
      const placeholderMessage: Message = {
        role: 'user',
        content: orphanToolUseIds.map(id => ({
          type: 'tool_result',
          tool_use_id: id as ToolUseId,
          content: [{ type: 'text', text: 'placeholder' }],
          is_error: false,
        })),
      };
      result.push(placeholderMessage);
    }

    return result;
  }
}
```

#### 2.2.7 `RemoteAgentClient`（远程委托）

```typescript
/**
 * Remote Agent 模式（PRD mod-05 §4.1）
 * 委托到 SSH 远程 OmniAgent 实例
 */
class RemoteAgentClient {
  constructor(private sshClient: SSHClient) {}

  /** remote 路径：委托到远程实例 */
  async delegate(params: AgentRouterParams & { runtimeTaskId: TaskId }): Promise<ToolResult> {
    if (!params.remote_target) {
      throw new Error('remote_target required for route=remote');
    }

    const timeoutMs = params.timeout_ms ?? 30_000;

    try {
      // 1. SSH 连接（指数退避重试 3 次）
      const conn = await this.sshClient.connect(params.remote_target, {
        retries: 3,
        backoffMs: 1000,
        timeoutMs: 10_000,
      });

      // 2. 远程执行 agent_router（远程 OmniAgent 实例）
      const result = await conn.exec('omniagent', ['--headless', '--prompt', params.prompt], {
        timeoutMs,
      });

      return {
        tool_use_id: '' as ToolUseId,
        content: [{ type: 'text', text: result.stdout }],
        is_error: result.exitCode !== 0,
        metadata: { duration_ms: 0, compactable: false },
      };
    } catch (err) {
      if (err.message.includes('SSH') || err.message.includes('TCP')) {
        // 远端不可达 → 三态恢复 evicted
        throw new Error(`remote unreachable: ${err.message}`);
      }
      throw err;
    }
  }
}

interface SSHClient {
  connect(target: string, opts: { retries: number; backoffMs: number; timeoutMs: number }): Promise<SSHConnection>;
}

interface SSHConnection {
  exec(cmd: string, args: string[], opts: { timeoutMs: number }): Promise<{ stdout: string; exitCode: number }>;
}
```

#### 2.2.8 `ThreeStateRecovery`（三态恢复）

```typescript
/**
 * 三态恢复（PRD mod-05 §4.2）
 * running / stopped / evicted
 */
class ThreeStateRecovery {
  constructor(
    private taskManager: TaskManager,
    private teammateRegistry: TeammateRegistry,
    private mailbox: MailboxService,
  ) {}

  /** 检测 teammate 状态 */
  async checkStatus(teammateName: MailboxName): Promise<'running' | 'stopped' | 'evicted'> {
    const teammate = await this.teammateRegistry.get(teammateName);
    if (!teammate) return 'evicted';

    // 1. 进程存活检测
    const alive = await this.isProcessAlive(teammate.agentId);
    if (alive) return 'running';

    // 2. 进程停止 → 检查 mailbox 是否有未读消息（stopped vs evicted）
    const unread = await this.mailbox.readUnread(teammateName);
    if (unread.length > 0) {
      // 有未读消息 → stopped（leader 可重启）
      return 'stopped';
    }
    // 无未读消息 → evicted（可能内存压力被回收）
    return 'evicted';
  }

  /** 按策略重启或放弃 */
  async recover(teammateName: MailboxName, strategy: 'restart' | 'abandon'): Promise<void> {
    const status = await this.checkStatus(teammateName);
    if (status === 'running') return;  // 无需恢复

    if (strategy === 'restart') {
      // 重启 teammate（保留 mailbox 未读消息）
      const teammate = await this.teammateRegistry.get(teammateName);
      if (teammate) {
        await this.restartTeammate(teammate);
      }
    } else {
      // 放弃：从 registry 注销，释放 worktree
      await this.teammateRegistry.unregister(teammateName);
      await this.worktreeRoster.release(teammateName);
    }
  }

  private async isProcessAlive(agentId: AgentId): Promise<boolean> { /* ... */ }
  private async restartTeammate(teammate: any): Promise<void> { /* ... */ }
  private worktreeRoster: any;  // injected
}
```

#### 2.2.9 `ShutdownHandshake`（四步握手）

```typescript
/**
 * Shutdown 四步握手（PRD mod-05 §4.3 + L2 §4.2.6 时序图）
 * 1. leader 发 shutdown_request
 * 2. teammate 回 shutdown_response（approve/reject）
 * 3. approve → 清理资源；reject → 继续运行
 * 4. 不强杀，优雅退出
 */
class ShutdownHandshake {
  constructor(private mailbox: MailboxService) {}

  /** leader 发 shutdown_request */
  async sendRequest(teammateName: MailboxName, ctx: any): Promise<void> {
    const result = await this.mailbox.send({
      to: teammateName,
      from: ctx.agentId,
      type: 'shutdown_request',
      payload: { request_id: generateId(), reason: ctx.reason ?? 'user_shutdown' },
    });
    if (!result.written) {
      throw new Error(`failed to send shutdown_request: ${result.error}`);
    }
    // 等待 shutdown_response（teammate 自行决定 approve/reject）
  }

  /** teammate 收到 shutdown_request 后处理 */
  async handleRequest(teammateName: MailboxName, requestId: string, ctx: any): Promise<void> {
    // teammate 自行评估能否 shutdown
    const canShutdown = await this.evaluateCanShutdown(ctx);

    const responsePayload = {
      request_id: requestId,
      approve: canShutdown,
      reason: canShutdown ? 'all_done' : 'pending_work',
    };

    await this.mailbox.send({
      to: ctx.leaderName,
      from: teammateName,
      type: 'shutdown_response',
      payload: responsePayload,
    });

    if (canShutdown) {
      // 清理资源（drainWriteQueue flush / close MCP / release worktree）
      await this.cleanupResources(ctx);
    }
  }

  /** leader 拉取 shutdown_response */
  async waitForResponse(teammateName: MailboxName, timeoutMs: number = 30_000): Promise<{ approve: boolean; reason?: string }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const unread = await this.mailbox.readUnread(teammateName);
      const response = unread.find(m => m.type === 'shutdown_response');
      if (response) {
        return response.payload as any;
      }
      await sleep(100);
    }
    throw new Error('shutdown_response timeout');
  }

  private async evaluateCanShutdown(ctx: any): Promise<boolean> { /* ... */ return true; }
  private async cleanupResources(ctx: any): Promise<void> { /* drainWriteQueue / close MCP / release worktree */ }
}
```

#### 2.2.10 `WorkflowOrchestrator`（声明式 YAML 工作流，决策 A3 默认 off）

```typescript
/**
 * Workflow Orchestrator（PRD mod-05 §4.4 + 决策 A3）
 * 默认 off，通过 OMNIAGENT_WORKFLOW_ORCHESTRATOR=1 环境变量显式启用
 */
class WorkflowOrchestrator {
  private enabled: boolean;

  constructor(
    private orchestrator: Orchestrator,
  ) {
    this.enabled = process.env.OMNIAGENT_WORKFLOW_ORCHESTRATOR === '1';
  }

  /** 执行声明式 YAML 工作流 */
  async run(workflowPath: string, ctx: any): Promise<{ completed: boolean; stepResults: any[] }> {
    if (!this.enabled) {
      throw new Error('Workflow Orchestrator is experimental, set OMNIAGENT_WORKFLOW_ORCHESTRATOR=1 to enable');
    }

    // 1. 解析 YAML
    const workflow = await this.parseYaml(workflowPath);

    // 2. 拓扑排序（按 depends_on）
    const sorted = this.topologicalSort(workflow.steps);

    // 3. 调度执行（支持 parallel 并行）
    const stepResults: any[] = [];
    for (const step of sorted) {
      if (step.parallel) {
        // 并行 spawn N 个子 agent
        const parallelResults = await Promise.all(
          Array.from({ length: step.parallel }, () =>
            this.orchestrator.route({
              route: 'async',
              prompt: step.prompt,
              parentAgentId: ctx.agentId,
              traceId: ctx.traceId,
            } as any)
          )
        );
        stepResults.push({ step: step.name, parallelResults });
      } else {
        const result = await this.orchestrator.route({
          route: 'sync',
          prompt: step.prompt,
          parentAgentId: ctx.agentId,
          traceId: ctx.traceId,
        } as any);
        stepResults.push({ step: step.name, result });
      }
    }

    return { completed: true, stepResults };
  }

  /** resume（从完成的 step 续跑） */
  async resume(workflowPath: string, completedSteps: string[], ctx: any): Promise<{ completed: boolean; stepResults: any[] }> {
    if (!this.enabled) throw new Error('Workflow Orchestrator is experimental');
    // 跳过 completedSteps，从下一个 step 开始
    // ...
  }

  private async parseYaml(path: string): Promise<{ name: string; steps: any[] }> { /* ... */ }
  private topologicalSort(steps: any[]): any[] { /* ... */ }
}
```

#### 2.2.11 `SidechainManager`（sidechain transcript，委托 M7）

```typescript
/**
 * Sidechain transcript 管理（PRD mod-05 §5 与 M7 的契约）
 * M5 只触发 sidechain 创建，持久化由 M7 负责
 */
class SidechainManager {
  constructor(private memoryEngine: MemoryEngine) {}

  /** 创建 sidechain（fork/teammate/async 路径用） */
  async create(params: {
    parentTranscriptId: AgentId;
    runtimeTaskId: TaskId;
    initialMessages?: Message[];  // fork 路径继承父上下文
  }): Promise<UUID> {
    return this.memoryEngine.createSidechain({
      parentUuid: params.parentTranscriptId,
      runtimeTaskId: params.runtimeTaskId,
      initialMessages: params.initialMessages,
    });
  }

  /** 持久化 sidechain（drainWriteQueue flush） */
  async flush(sidechainId: UUID): Promise<void> {
    await this.memoryEngine.flushSidechain(sidechainId);
  }

  /** 读取 sidechain transcript（用户 /rewind --sidechain <id> 用） */
  async read(sidechainId: UUID): Promise<Message[]> {
    return this.memoryEngine.readSidechain(sidechainId);
  }
}
```

#### 2.2.12 `WorktreeRoster`（worktree 唯一归属，不变量 #1）

```typescript
/**
 * Worktree roster（不变量 #1：worktree 唯一归属）
 * 一个 worktree 同时只属于一个 teammate
 */
class WorktreeRoster {
  private roster: Map<string, { teammateName: MailboxName; agentId: AgentId; path: string }> = new Map();

  /** 分配 worktree 给 teammate */
  async assign(params: { teammateName: MailboxName; agentId: AgentId }): Promise<{ path: string }> {
    // 检查 worktree 是否已被占用
    const existing = this.roster.get(params.teammateName);
    if (existing) {
      throw new Error(`worktree already assigned to ${params.teammateName}`);
    }

    // 创建新 worktree（git worktree add）
    const worktreePath = await this.createGitWorktree(params.teammateName);
    this.roster.set(params.teammateName, {
      teammateName: params.teammateName,
      agentId: params.agentId,
      path: worktreePath,
    });
    return { path: worktreePath };
  }

  /** 释放 worktree */
  async release(teammateName: MailboxName): Promise<void> {
    const entry = this.roster.get(teammateName);
    if (!entry) return;
    await this.removeGitWorktree(entry.path);
    this.roster.delete(teammateName);
  }

  /** 检查 worktree 归属 */
  getOwner(worktreePath: string): MailboxName | undefined {
    for (const [name, entry] of this.roster) {
      if (entry.path === worktreePath) return name;
    }
    return undefined;
  }

  private async createGitWorktree(name: MailboxName): Promise<string> { /* git worktree add */ }
  private async removeGitWorktree(path: string): Promise<void> { /* git worktree remove */ }
}
```

#### 2.2.13 `TeammateRegistry`（name→agentId 映射，不变量 #2）

```typescript
/**
 * Teammate 注册表（不变量 #2：teammate 按 name 寻址）
 * name 变更时报错提示更新引用
 */
class TeammateRegistry {
  private registry: Map<MailboxName, { agentId: AgentId; parentAgentId: AgentId; registeredAt: ISO8601Timestamp }> = new Map();

  async register(params: { name: MailboxName; agentId: AgentId; parentAgentId: AgentId }): Promise<void> {
    if (this.registry.has(params.name)) {
      throw new Error(`teammate name "${params.name}" already registered`);
    }
    this.registry.set(params.name, {
      agentId: params.agentId,
      parentAgentId: params.parentAgentId,
      registeredAt: new Date().toISOString(),
    });
  }

  async get(name: MailboxName): Promise<{ agentId: AgentId; parentAgentId: AgentId; registeredAt: ISO8601Timestamp } | undefined> {
    return this.registry.get(name);
  }

  async unregister(name: MailboxName): Promise<void> {
    this.registry.delete(name);
  }

  /** name 变更检测（name 变更时报错） */
  assertNameStable(oldName: MailboxName, newName: MailboxName): void {
    if (oldName !== newName) {
      throw new Error(`teammate name changed from "${oldName}" to "${newName}"; please update references`);
    }
  }

  /** 列出所有 teammate name */
  listNames(): MailboxName[] {
    return Array.from(this.registry.keys());
  }
}
```

---

## 3. 详细设计

### 3.1 agent_router 5 路径路由实施（引用 PRD §3.1，不重复）

PRD mod-05 §3.1 已定 5 路径（sync / async / fork / teammate / remote）。omniagent-types.ts §8 已定义 `AgentRouterParams` / `AgentRouterResult`。本节补 Orchestrator.route() 的分发实施：

#### 3.1.1 5 路径分发流程

```
agent_router(params={route, prompt, ...})
  │
  ▼
Orchestrator.route(params)
  │
  ├──1. TaskManager.createDualTrack() → workItemId + runtimeTaskId
  │
  ├──2. 按 route 分发：
  │     ├──sync──▶ CoordinatorMode.spawnSync() → 阻塞主对话，返回结果
  │     ├──async──▶ CoordinatorMode.spawnAsync() → 立即返回 task_id，后台执行
  │     ├──fork──▶ ForkAgentSpawner.spawn() → 继承父上下文 + 独立 sidechain
  │     ├──teammate──▶ SwarmTeam.joinTeam() → 加入 Swarm，按 name 寻址
  │     └──remote──▶ RemoteAgentClient.delegate() → SSH 远程委托
  │
  ├──3. TaskManager.completeTask() / failTask()
  │
  └──4. 返回 AgentRouterResult（task_id / work_item_id / status / result）
```

#### 3.1.2 5 路径的原语可组合性

PRD mod-05 §2 列出"模式可组合"目标。本节补组合规则：

| 组合 | 实施方式 | 用例 |
|------|---------|------|
| fork + teammate | Fork 路径 spawn 的子 agent 加入 Swarm | 团队成员分叉试验 |
| async + fork | Fork 路径的 spawn 改为后台 | 上下文分支长任务 |
| teammate + remote | Remote 路径委托的远程实例加入 Swarm | 跨主机协作 |
| sync + fork | Fork 路径同步执行（默认） | 上下文分支单次试验 |

组合实施：`Orchestrator.route()` 根据 `route` + 可选的 `parent_context_mode` + `teammate_name` + `remote_target` 组合参数决定走哪个模式的哪个方法。

### 3.2 Task 双轨设计（引用 PRD §3.2，不重复）

PRD mod-05 §3.2 + omniagent-types.ts §8 已定义 `WorkItem` + `RuntimeTask` 双轨。本节补 TaskManager 实施：

#### 3.2.1 双轨关联

```
LLM 调 task_create(prompt="迁移数据库")
  │
  ▼
TaskManager.createDualTrack()
  │
  ├──WorkItem（LLM 维护）
  │   id: work_item_001
  │   description: "迁移数据库"
  │   runtimeTaskIds: [task_001]
  │   status: in_progress
  │
  └──RuntimeTask（harness 维护）
      id: task_001
      workItemId: work_item_001
      subtype: async
      status: running
      startedAt: 2026-07-08T10:00:00Z

LLM 调 task_output(task_id="task_001")
  │
  ▼
TaskManager.getOutput(task_001)
  │
  ▼
返回 RuntimeTask 状态 + 结果
  │
  ▼
LLM 调 task_stop(task_id="task_001")
  │
  ▼
TaskManager 调 ShutdownHandshake.sendRequest() → teammate 优雅退出
```

#### 3.2.2 7 种 RuntimeTask subtypes

| subtype | 来源 | 用途 |
|---------|------|------|
| sync | route=sync | 同步子 agent |
| async | route=async | 异步后台子 agent |
| fork | route=fork | 上下文分叉 |
| teammate | route=teammate | Swarm 成员 |
| remote | route=remote | 远程委托 |
| daemon | 系统 | 后台 daemon（如 fs watcher） |
| scheduled | CronCreate | 定时触发 |

### 3.3 Mailbox 通信（引用 PRD §3.3 + L2 §5.3，不重复）

PRD mod-05 §3.3 + L2 §5.3 已定义 `writeMailboxAtomic` 完整实现。本节补 MailboxService 包装：

#### 3.3.1 容量限制实施

引用 L2 §5.3 + omniagent-types.ts §9 的 `MailboxCapacityLimits`：

- 单条 ≤ 64KB（超限立即拒绝）
- 单个 mailbox 文件 ≤ 4MB（超限触发归档）
- 单个 mailbox 消息数 ≤ 1000（超限触发归档）
- 归档阈值 200（超限后最老 200 条移到 `.archive.jsonl`）

#### 3.3.2 按 name 寻址（不变量 #2）

- mailbox 文件路径：`~/.omniagent/mailbox/{name}.jsonl`
- 不按 agentId 寻址（agentId 可能变，name 稳定）
- name 变更时 TeammateRegistry.assertNameStable() 报错

#### 3.3.3 跨 turn 持久化

- mailbox 是文件系统 JSONL，进程重启后未读消息仍可达
- leader 重启后调 `MailboxService.readAll(name)` 恢复未读消息
- 不变量 #7（mailbox 消息丢失率 = 0）：writeMailboxAtomic 保证 appendFile + fsync，绝返回 written=true 但未写入

### 3.4 Coordinator Mode 实施（引用 PRD §4.1，不重复）

PRD mod-05 §4.1 已定 Coordinator Mode 设计。本节补 CoordinatorMode 类实施：

#### 3.4.1 工具池硬隔离（不变量 #4）

- 主 Agent 的 `mergeAndFilterTools()` 强制移除 `bash` / `edit_file` / `write_file`（M3 实现）
- 主 Agent 只能用编排工具（`agent_router` / `send_message` / `task_create` / `task_stop` / `task_output`）
- 主 Agent spawn worker 执行，worker 完成后结果回注

#### 3.4.2 sync vs async 区别

| 路径 | 阻塞主对话 | 返回时机 | 用途 |
|------|-----------|---------|------|
| sync | 是 | 子 agent 完成后返回完整结果 | 单次复杂查询（如 Explore） |
| async | 否 | 立即返回 task_id，结果通过 task_output 读取 | 长任务（完整测试套件） |

### 3.5 Swarm/Team 实施（引用 PRD §4.1，不重复）

PRD mod-05 §4.1 已定 Swarm/Team 设计。本节补 SwarmTeam 类实施：

#### 3.5.1 按 name 寻址

- teammate 注册时 TeammateRegistry 记录 name → agentId 映射
- 通信时用 name（不用 agentId）
- name 变更时 assertNameStable() 报错，提示更新引用

#### 3.5.2 跨 turn 持久化

- mailbox 消息持久化到 `~/.omniagent/mailbox/{name}.jsonl`
- leader 重启后 readAll(name) 恢复未读消息
- teammate 重启后 readAll(leaderName) 恢复 leader 消息

### 3.6 Fork Agent 实施（引用 PRD §4.1，不重复）

PRD mod-05 §4.1 + L2 §4.2.4 时序图已定 Fork Agent 设计。本节补 ForkAgentSpawner 类实施：

#### 3.6.1 prompt cache prefix byte-identical（不变量 #5）

- 继承父 agent 的 messages（byte-identical 复制）
- 对未配对的 tool_use 填占位 tool_result（`fillPlaceholderToolResults()`）
- 使 fork agent 的 prompt prefix 与父 agent 完全一致，最大化 cache 命中

#### 3.6.2 独立 sidechain（不污染父会话）

- fork agent 的 transcript 写入独立 sidechain（M7 `createSidechain()`）
- 父 transcript 不变
- sidechain ID 通过 RuntimeTask.sidechainId 关联

### 3.7 Remote Agent 实施（引用 PRD §4.1，不重复）

PRD mod-05 §4.1 已定 Remote Agent 设计。本节补 RemoteAgentClient 类实施：

#### 3.7.1 SSH 远程委托

- SSH 连接（指数退避重试 3 次）
- 远程执行 `omniagent --headless --prompt <prompt>`
- 支持自托管 Remote Server（HTTP API 替代 SSH）

#### 3.7.2 断连自动重连

- TCP 断连后指数退避重连
- 未完成请求按三态恢复（`evicted` 状态，leader 决定重启或放弃）

### 3.8 三态恢复实施（引用 PRD §4.2，不重复）

PRD mod-05 §4.2 已定三态恢复（running / stopped / evicted）。本节补 ThreeStateRecovery 类实施：

#### 3.8.1 三态判定

| 状态 | 检测条件 | 处理 |
|------|---------|------|
| running | 进程存活 | 无需恢复 |
| stopped | 进程停止 + mailbox 有未读消息 | leader 按策略重启（保留 mailbox） |
| evicted | 进程停止 + mailbox 无未读消息 | leader 重新 spawn 或放弃 |

#### 3.8.2 恢复策略

- `restart`：重启 teammate（保留 worktree + mailbox + 已读消息状态）
- `abandon`：从 registry 注销，释放 worktree（roster.release）

### 3.9 Shutdown 四步握手实施（引用 PRD §4.3 + L2 §4.2.6，不重复）

PRD mod-05 §4.3 + L2 §4.2.6 时序图已定 Shutdown 四步握手。本节补 ShutdownHandshake 类实施：

#### 3.9.1 四步流程

```
Step 1: leader → teammate
  mailbox.send({to: teammate_name, type: 'shutdown_request', payload: {request_id, reason}})

Step 2: teammate → leader
  teammate 评估能否 shutdown（evaluateCanShutdown）
  mailbox.send({to: leader_name, type: 'shutdown_response', payload: {request_id, approve, reason}})

Step 3a: approve → 清理资源
  teammate: drainWriteQueue flush / close MCP / release worktree
  teammate: 进程退出

Step 3b: reject → 继续运行
  teammate: 继续运行（pending_work）

Step 4: leader 拉取 shutdown_response
  mailbox.readUnread(leader_name) → 找 shutdown_response
  全部 teammate approve → 主进程退出
```

#### 3.9.2 不强杀原则（不变量 #6）

- 不用 SIGKILL 强杀 teammate
- 即使 leader abort，teammate 也可继续运行（独立进程）
- teammate 收到 shutdown_request 后自行决定 approve/reject

### 3.10 Workflow Orchestrator 实施（引用 PRD §4.4 + 决策 A3，不重复）

PRD mod-05 §4.4 + 决策 A3 已定 Workflow Orchestrator 默认 off。本节补 WorkflowOrchestrator 类实施：

#### 3.10.1 默认 off（决策 A3）

- 启动期检查 `process.env.OMNIAGENT_WORKFLOW_ORCHESTRATOR === '1'`
- 未启用时 `run()` 抛错提示"experimental feature"
- 6 个实验 feature 全部默认 off（PRD mod-05 §4.4 列出）

#### 3.10.2 声明式 YAML 工作流

```yaml
name: migrate-and-verify
steps:
  - name: explore
    agent: explore
    prompt: "find all usages of deprecated API"
  - name: verify
    agent: verification
    parallel: 3
    prompt: "adversarially verify the migration plan"
    depends_on: [explore]
  - name: execute
    agent: worker
    prompt: "execute the migration"
    depends_on: [verify]
```

#### 3.10.3 调度算法

- 拓扑排序（按 `depends_on`）
- `parallel: N` 字段指定并行度（Promise.all spawn N 个子 agent）
- `resume(workflowPath, completedSteps)` 从完成的 step 续跑

### 3.11 Sidechain 与 CompactBoundary 解耦（引用 PRD §5，不重复）

PRD mod-05 §5 澄清 K2：CompactBoundary 事件由 M7 发出并写入 transcript 元数据，**不直接触发 rewind**。`/rewind` 是用户命令，由 M7 读取 boundary 元数据后还原上下文。

#### 3.11.1 sidechain 的独立性

- M5 的 sidechain 与主 transcript 各自独立标记 CompactBoundary
- sidechain 的 `/rewind` 通过 M5 的 `--sidechain <id>` 参数单独触发
- 主 transcript 的 `/rewind` 不影响 sidechain

#### 3.11.2 M5 不触发 rewind

- M5 只触发 sidechain 创建（SidechainManager.create）
- CompactBoundary 事件由 M7 在压缩时发出
- 用户通过 `/rewind` 命令触发还原（M7 实现）

---

## 4. 与其他模块的交互

### 4.1 调用图

```
                  ┌──────────────┐
                  │  M2 ReActLoop│
                  │ (TOOL_EXEC)  │
                  └──────┬───────┘
                         │ tool_use(agent_router)
                         ▼
                  ┌──────────────┐
                  │  M3 Tool     │
                  │  (agent_router)│
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │  M5 Orchestrator│
                  │  .route()    │
                  └──────┬───────┘
                         │
            ┌────────────┼────────────┐
            │            │            │
            ▼            ▼            ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │Coordinator│ │  Swarm  │ │   Fork   │
      │  Mode    │ │  Team   │ │  Spawner │
      └────┬─────┘ └────┬─────┘ └────┬─────┘
           │            │            │
           ▼            ▼            ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │ M2 子 Loop│ │  Mailbox│ │ M7 Side  │
      │ (sync/   │ │ (name   │ │  chain   │
      │  async)  │ │ 寻址)   │ │ (fork)   │
      └──────────┘ └──────────┘ └──────────┘
                                        │
                                        ▼
                                  ┌──────────┐
                                  │ Remote   │
                                  │  Agent   │
                                  │  Client  │
                                  └────┬─────┘
                                       │
                                       ▼
                                  ┌──────────┐
                                  │   SSH    │
                                  │ 远程实例 │
                                  └──────────┘
```

### 4.2 数据流

```
M2 tool_use(agent_router, {route, prompt, ...})
  │
  ▼
M3 AgentRouterTool.call() → M5 Orchestrator.route()
  │
  ▼
TaskManager.createDualTrack() → WorkItem + RuntimeTask
  │
  ▼
按 route 分发：
  │
  ├──sync/async──▶ CoordinatorMode.spawnSync/Async()
  │                  │
  │                  ▼
  │                SidechainManager.create() → M7 createSidechain
  │                  │
  │                  ▼
  │                M2 子 ReActLoop.runTurn() → 子 agent 执行
  │                  │
  │                  ▼
  │                SidechainManager.flush() → M7 flushSidechain
  │                  │
  │                  ▼
  │                ToolResult 回注父 agent
  │
  ├──fork──▶ ForkAgentSpawner.spawn()
  │            │
  │            ▼
  │          memoryEngine.getCurrentMessages() → 父上下文
  │            │
  │            ▼
  │          fillPlaceholderToolResults() → 占位 tool_result（不变量 #5）
  │            │
  │            ▼
  │          SidechainManager.create({initialMessages}) → 继承父上下文
  │            │
  │            ▼
  │          M2 子 ReActLoop.runTurn() → fork agent 执行
  │
  ├──teammate──▶ SwarmTeam.joinTeam()
  │              │
  │              ▼
  │            TeammateRegistry.register() → name→agentId（不变量 #2）
  │              │
  │              ▼
  │            WorktreeRoster.assign() → worktree 唯一归属（不变量 #1）
  │              │
  │              ▼
  │            后台启动 teammate ReActLoop（独立进程）
  │              │
  │              ▼
  │            通信通过 mailbox（MailboxService.send → M7 writeMailboxAtomic）
  │
  └──remote──▶ RemoteAgentClient.delegate()
                │
                ▼
              SSHClient.connect() → 远程 OmniAgent 实例
                │
                ▼
              远程执行 → 返回结果
                │
                ▼
              ToolResult 回注父 agent
```

### 4.3 接口契约表

| M5 接口 | 调用方 | 被调方 | 契约（types.ts 章节） |
|---------|--------|--------|---------------------|
| `Orchestrator.route()` | M3 AgentRouterTool | M5 | §8 AgentRouterParams/Result |
| `Orchestrator.sendShutdownRequest()` | M2 AbortCoordinator（场景 C） | M5 | §9 MailboxMessage |
| `Orchestrator.getTaskOutput()` | M3 TaskOutputTool | M5 | §8 RuntimeTask |
| `TaskManager.createDualTrack()` | M5 Orchestrator | M5 | §8 WorkItem + RuntimeTask |
| `MailboxService.send()` | M5 SwarmTeam / ShutdownHandshake | M5（包装 M7） | §9 WriteMailboxAtomicFn |
| `SidechainManager.create()` | M5 ForkAgentSpawner / CoordinatorMode | M5（委托 M7） | §17 MemoryEngine |
| `WorktreeRoster.assign()` | M5 SwarmTeam | M5 | 不变量 #1 |
| `TeammateRegistry.register()` | M5 SwarmTeam | M5 | 不变量 #2 |
| `ThreeStateRecovery.checkStatus()` | M5（leader 周期调用） | M5 | §8 TaskStatus |
| `ShutdownHandshake.sendRequest()` | M5 / M2 AbortCoordinator | M5 | §9 MailboxMessage.shutdown_request |
| `WorkflowOrchestrator.run()` | M3 SkillTool（如 Skill 调工作流） | M5 | 决策 A3 |

### 4.4 澄清契约（PRD §5）

PRD mod-05 §5 已列出 5 项交互。本节补澄清：

- **M5 与 M2 的契约**：M2 通过 `agent_router` 工具触发 M5 路由；子 agent spawn 后通过 M2 ReAct Loop 运行。M2 不感知 5 路径细节，只看到 tool_use → tool_result。
- **M5 与 M3 的契约**：M5 提供 `agent_router` / `send_message` / `task_create` / `task_stop` / `task_output` 工具的路由逻辑，M3 提供工具接口（`Tool.call()` 转发到 M5）。
- **M5 与 M4 的契约**：agent spawn 与 mailbox 写入经 M4 五层拦截链。Coordinator Mode 下的工具池隔离由 M3 `mergeAndFilterTools()` 实现，M4 Layer 2 权限规则二次校验。
- **M5 与 M6 的契约**：M6 Skill fork 模式执行时通过 `agent_router(route=fork)` 调用 M5 fork 路径。
- **M5 与 M7 的契约**：sidechain transcript 由 M7 持久化（SidechainManager 委托）；mailbox 原子写原语由 M7 提供（MailboxService 包装 `writeMailboxAtomic`）；CompactBoundary 事件由 M7 发出，M5 不触发 rewind。

---

## 5. 错误处理与降级

### 5.1 错误码映射（引用 L2 §6，不重复）

L2 §6 已定义 26 个 OmniAgentErrorCode。M5 触发的错误码子集：

| 错误码 | 触发场景 | M5 处理 | 用户呈现 |
|--------|---------|---------|---------|
| `MAILBOX_FULL` | writeMailboxAtomic 返回 over_capacity | 触发归档，仍满则返回 failed | "mailbox 容量超限，老消息已归档" |
| `MAILBOX_LOCKED` | writeMailboxAtomic 10 次退避后仍锁竞争 | 返回 failed | "mailbox 锁竞争，请重试" |
| `PERSISTENCE_IO_ERROR` | writeMailboxAtomic 返回 io_error | 返回 failed | "mailbox 写入失败：{message}" |
| `PERSISTENCE_CORRUPTION` | mailbox JSONL 解析失败 | 从 .bak 恢复，无备份则清空重建 | "mailbox 损坏，已从备份恢复" |
| `TOOL_EXECUTION_ERROR` | 子 agent spawn 失败（worktree 占用 / 权限拒绝） | 返回 failed + 拒绝原因 | "子 agent 启动失败：{reason}" |
| `TOOL_TIMEOUT` | timeout_ms 到期 | 发 SIGTERM → 等 5s → SIGKILL，返回 timeout + 部分结果 | "子 agent 超时（{timeout}ms）" |
| `USER_INTERRUPT` | 用户 abort + shutdown_request 四步握手 | teammate 自行 approve/reject | "已发送 shutdown_request，等待 teammate 响应" |
| `PROVIDER_TIMEOUT` | Remote Agent SSH 连接超时 | 重试 3 次失败后 evicted | "远端不可达，已标记 evicted" |

### 5.2 fail-closed 策略

M5 的 fail-closed 场景：

1. **mailbox 写入失败**：返回 `written=false`，主 agent 收到 failed 后决定是否重试（不臆造消息成功）
2. **worktree 唯一归属违反**（不变量 #1）：WorktreeRoster.assign() 检测到 worktree 已被占用，抛错（不强制覆盖）
3. **teammate name 冲突**（不变量 #2）：TeammateRegistry.register() 检测到 name 已注册，抛错（不覆盖）
4. **teammate name 变更**：TeammateRegistry.assertNameStable() 抛错，提示更新引用
5. **Remote Agent 远端不可达**：重试 3 次失败后标 evicted（不臆造结果）
6. **Shutdown 四步握手 timeout**：30s 未收到 shutdown_response，抛错（不强杀 teammate，不变量 #6）
7. **prompt cache prefix 不一致**（不变量 #5）：ForkAgentSpawner.fillPlaceholderToolResults() 必须填充所有 orphan tool_use，否则 cache miss（不强制 cache 命中）

### 5.3 错误呈现

- **简短可读消息**：用户可见（通过 tool_result.content 的 text 块）
- **技术细节**：仅日志（stderr 或文件，L2 §7 日志格式规范）
- **审计日志**：合规审计（L2 §7 审计 schema，含 teammate_name / route / status）
- **不显示敏感信息**：SSH 主机 / 远程实例 URL / mailbox 消息内容

---

## 6. 测试用例骨架

### 6.1 单元测试

#### 6.1.1 `Orchestrator.route` 5 路径分发测试

```typescript
describe('Orchestrator.route 5 路径', () => {
  it('sync 路径：阻塞主对话，返回完整结果', async () => {
    const orch = createOrchestratorWithMocks();
    const result = await orch.route({
      route: 'sync',
      prompt: 'test',
      parentAgentId: 'agent_1' as any,
      traceId: 't1' as any,
    });
    expect(result.status).toBe('completed');
    expect(result.result).toBeDefined();
  });

  it('async 路径：立即返回 task_id，后台执行', async () => {
    const orch = createOrchestratorWithMocks();
    const result = await orch.route({
      route: 'async',
      prompt: 'test',
      parentAgentId: 'agent_1' as any,
      traceId: 't1' as any,
    });
    expect(result.task_id).toBeDefined();
    expect(result.status).toBe('running');  // 立即返回 running
  });

  it('fork 路径：继承父上下文 + 占位 tool_result', async () => {
    // ...
  });

  it('teammate 路径：加入 Swarm，按 name 寻址', async () => {
    const orch = createOrchestratorWithMocks();
    const result = await orch.route({
      route: 'teammate',
      prompt: 'test',
      teammate_name: 'alice' as any,
      parentAgentId: 'agent_1' as any,
      traceId: 't1' as any,
    });
    expect(result.status).toBe('completed');
  });

  it('remote 路径：SSH 远程委托', async () => {
    // ...
  });

  it('路由失败（route 参数非法）→ status=failed', async () => {
    const orch = createOrchestratorWithMocks();
    const result = await orch.route({
      route: 'invalid' as any,
      prompt: 'test',
      parentAgentId: 'agent_1' as any,
      traceId: 't1' as any,
    });
    expect(result.status).toBe('failed');
  });
});
```

#### 6.1.2 `TaskManager` 双轨测试

```typescript
describe('TaskManager 双轨', () => {
  it('createDualTrack 创建 WorkItem + RuntimeTask', async () => {
    const tm = new TaskManager(/* ... */);
    const { workItemId, runtimeTaskId } = await tm.createDualTrack({
      route: 'async',
      prompt: 'test',
      parentAgentId: 'agent_1' as any,
    });
    expect(workItemId).toBeDefined();
    expect(runtimeTaskId).toBeDefined();
    // 验证 WorkItem.runtimeTaskIds 包含 runtimeTaskId
  });

  it('completeTask 更新两轨状态为 completed', async () => {
    // ...
  });

  it('failTask 根据 err 区分 failed / timeout', async () => {
    // ...
  });

  it('getOutput block=true 阻塞到完成', async () => {
    // ...
  });

  it('getOutput block=false 立即返回当前状态', async () => {
    // ...
  });
});
```

#### 6.1.3 `MailboxService` 测试

```typescript
describe('MailboxService', () => {
  it('send 调用 M7 writeMailboxAtomic', async () => {
    const writeFn = jest.fn().mockResolvedValue({ written: true });
    const svc = new MailboxService(writeFn);
    const result = await svc.send({
      to: 'alice' as any,
      from: 'agent_1' as any,
      type: 'text',
      payload: 'hello',
    });
    expect(writeFn).toHaveBeenCalled();
    expect(result.written).toBe(true);
  });

  it('writeMailboxAtomic 返回 over_capacity → written=false', async () => {
    const writeFn = jest.fn().mockResolvedValue({ written: false, error: 'over_capacity' });
    const svc = new MailboxService(writeFn);
    const result = await svc.send({ /* ... */ });
    expect(result.written).toBe(false);
    expect(result.error).toBe('over_capacity');
  });

  it('writeMailboxAtomic 返回 archive_triggered=true → 消息已写入', async () => {
    const writeFn = jest.fn().mockResolvedValue({ written: true, archive_triggered: true });
    const svc = new MailboxService(writeFn);
    const result = await svc.send({ /* ... */ });
    expect(result.written).toBe(true);
    expect(result.archiveTriggered).toBe(true);
  });

  it('readUnread 返回未读消息 + 标记已读', async () => {
    // ...
  });

  it('readAll 返回所有消息（含已读，leader 重启用）', async () => {
    // ...
  });
});
```

#### 6.1.4 `ForkAgentSpawner` 占位 tool_result 测试（不变量 #5）

```typescript
describe('ForkAgentSpawner 不变量 #5', () => {
  it('fillPlaceholderToolResults 对未配对 tool_use 填占位', () => {
    const spawner = new ForkAgentSpawner(/* ... */);
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1' as any, name: 'read_file', input: {} }] },
      // 无配对的 tool_result
    ];
    const filled = (spawner as any).fillPlaceholderToolResults(messages);
    // 验证添加了占位 tool_result
    const lastMsg = filled[filled.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content[0]).toHaveProperty('type', 'tool_result');
    expect(lastMsg.content[0]).toHaveProperty('tool_use_id', 'tu1');
  });

  it('已有配对 tool_result 不重复填占位', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1' as any, name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1' as any, content: [], is_error: false }] },
    ];
    // 不应添加占位
  });

  it('多个未配对 tool_use 全部填占位', () => {
    // ...
  });

  it('fork agent prompt prefix 与父 agent byte-identical', async () => {
    // 跑端到端，验证 prompt prefix 完全一致
  });
});
```

#### 6.1.5 `WorktreeRoster` 测试（不变量 #1）

```typescript
describe('WorktreeRoster 不变量 #1', () => {
  it('assign 分配 worktree 给 teammate', async () => {
    const roster = new WorktreeRoster();
    const result = await roster.assign({ teammateName: 'alice' as any, agentId: 'agent_1' as any });
    expect(result.path).toBeDefined();
  });

  it('重复 assign 同一 teammate → 抛错', async () => {
    const roster = new WorktreeRoster();
    await roster.assign({ teammateName: 'alice' as any, agentId: 'agent_1' as any });
    await expect(roster.assign({ teammateName: 'alice' as any, agentId: 'agent_2' as any }))
      .rejects.toThrow('already assigned');
  });

  it('getOwner 返回 worktree 的归属', async () => {
    // ...
  });

  it('release 释放 worktree', async () => {
    // ...
  });
});
```

#### 6.1.6 `TeammateRegistry` 测试（不变量 #2）

```typescript
describe('TeammateRegistry 不变量 #2', () => {
  it('register + get 按 name 寻址', async () => {
    const reg = new TeammateRegistry();
    await reg.register({ name: 'alice' as any, agentId: 'agent_1' as any, parentAgentId: 'agent_0' as any });
    const result = await reg.get('alice' as any);
    expect(result?.agentId).toBe('agent_1');
  });

  it('重复 register 同一 name → 抛错', async () => {
    const reg = new TeammateRegistry();
    await reg.register({ name: 'alice' as any, agentId: 'agent_1' as any, parentAgentId: 'agent_0' as any });
    await expect(reg.register({ name: 'alice' as any, agentId: 'agent_2' as any, parentAgentId: 'agent_0' as any }))
      .rejects.toThrow('already registered');
  });

  it('assertNameStable name 变更 → 抛错', () => {
    const reg = new TeammateRegistry();
    expect(() => reg.assertNameStable('alice' as any, 'bob' as any))
      .toThrow('teammate name changed');
  });

  it('unregister 注销 + 后续 get 返回 undefined', async () => {
    // ...
  });
});
```

#### 6.1.7 `ThreeStateRecovery` 测试

```typescript
describe('ThreeStateRecovery', () => {
  it('running 状态：进程存活', async () => {
    // mock isProcessAlive 返回 true
  });

  it('stopped 状态：进程停止 + mailbox 有未读', async () => {
    // ...
  });

  it('evicted 状态：进程停止 + mailbox 无未读', async () => {
    // ...
  });

  it('recover restart 重启 teammate', async () => {
    // ...
  });

  it('recover abandon 注销 + 释放 worktree', async () => {
    // ...
  });
});
```

#### 6.1.8 `ShutdownHandshake` 四步握手测试（不变量 #6）

```typescript
describe('ShutdownHandshake 不变量 #6', () => {
  it('sendRequest 写 shutdown_request 到 mailbox', async () => {
    const hs = new ShutdownHandshake(/* mock mailbox */);
    await hs.sendRequest('alice' as any, { agentId: 'leader' as any, reason: 'user_exit' });
    // 验证 mailbox 写入 shutdown_request
  });

  it('handleRequest approve → 清理资源', async () => {
    // mock evaluateCanShutdown 返回 true
    // 验证 cleanupResources 被调用
  });

  it('handleRequest reject → 继续运行', async () => {
    // mock evaluateCanShutdown 返回 false
    // 验证 cleanupResources 未被调用
  });

  it('waitForResponse 30s 超时 → 抛错（不强杀）', async () => {
    const hs = new ShutdownHandshake(/* mock mailbox 永远无响应 */);
    await expect(hs.waitForResponse('alice' as any, 100))
      .rejects.toThrow('timeout');
  });

  it('全部 teammate approve → 主进程退出', async () => {
    // ...
  });
});
```

#### 6.1.9 `WorkflowOrchestrator` 测试（决策 A3）

```typescript
describe('WorkflowOrchestrator 决策 A3', () => {
  it('默认 off：未设环境变量 → run 抛错', async () => {
    delete process.env.OMNIAGENT_WORKFLOW_ORCHESTRATOR;
    const wo = new WorkflowOrchestrator(/* ... */);
    await expect(wo.run('test.yaml', {})).rejects.toThrow('experimental');
  });

  it('OMNIAGENT_WORKFLOW_ORCHESTRATOR=1 → 启用', async () => {
    process.env.OMNIAGENT_WORKFLOW_ORCHESTRATOR = '1';
    const wo = new WorkflowOrchestrator(/* ... */);
    // ...
  });

  it('拓扑排序按 depends_on', () => {
    // ...
  });

  it('parallel: N 并行 spawn N 个子 agent', async () => {
    // ...
  });

  it('resume 跳过 completedSteps', async () => {
    // ...
  });
});
```

### 6.2 集成测试

#### 6.2.1 M2 + M3 + M5 端到端：agent_router sync 路径

```typescript
describe('M2+M3+M5 集成：agent_router sync', () => {
  it('完整流程：M2 tool_use → M3 AgentRouterTool → M5 route sync → 子 agent → 结果回注', async () => {
    // mock M1 返回 tool_use(agent_router, {route: 'sync', prompt: '...'})
    // 真实 M2 ReActLoop + M3 + M5
    const loop = createReActLoopWithRealM5();
    const result = await loop.runTurn({ text: 'spawn sync subtask', sessionId: 's1', traceId: 't1' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.toolUseCount).toBe(1);
  });
});
```

#### 6.2.2 M5 + M7 集成：sidechain 持久化

```typescript
describe('M5+M7 集成：sidechain', () => {
  it('fork 路径：SidechainManager.create → M7 createSidechain', async () => {
    // ...
  });

  it('子 agent 完成后 SidechainManager.flush → M7 flushSidechain', async () => {
    // ...
  });

  it('sidechain /rewind --sidechain <id> 不影响主 transcript', async () => {
    // ...
  });
});
```

#### 6.2.3 M5 mailbox 端到端（不变量 #7）

```typescript
describe('M5 mailbox 不变量 #7', () => {
  it('writeMailboxAtomic 写入成功 + 读取一致', async () => {
    // ...
  });

  it('mailbox 消息丢失率 = 0（1000 次写入测试）', async () => {
    // 并发 1000 次 send
    // 验证全部 written=true
    // 验证 readAll 返回 1000 条
  });

  it('归档后消息仍可读取（从 .archive.jsonl）', async () => {
    // ...
  });

  it('leader 重启后未读消息仍可达', async () => {
    // ...
  });
});
```

#### 6.2.4 M5 Shutdown 端到端（引用 L2 §4.2.6 时序图）

```typescript
describe('M5 Shutdown 端到端', () => {
  it('leader shutdown_request → teammate approve → 清理退出', async () => {
    // ...
  });

  it('teammate reject → 继续运行', async () => {
    // ...
  });

  it('全部 teammate approve → 主进程退出', async () => {
    // ...
  });
});
```

#### 6.2.5 M5 Remote Agent 端到端

```typescript
describe('M5 Remote Agent', () => {
  it('SSH 连接 + 远程执行 + 结果返回', async () => {
    // mock SSH
  });

  it('远端不可达 → 重试 3 次 → evicted', async () => {
    // ...
  });
});
```

#### 6.2.6 M5 Coordinator Mode 端到端（不变量 #4）

```typescript
describe('M5 Coordinator Mode 不变量 #4', () => {
  it('主 agent 工具池不含 bash/edit_file/write_file', async () => {
    // ...
  });

  it('主 agent 调用 bash → M4 Layer 2 deny', async () => {
    // ...
  });

  it('主 agent spawn worker 执行 bash → worker 完成 → 结果回注', async () => {
    // ...
  });

  it('Coordinator 会话全程主 agent 直接调用写工具次数 = 0', async () => {
    // ...
  });
});
```

### 6.3 不变量测试

#### 6.3.1 不变量 #1：worktree 唯一归属

```typescript
describe('不变量 #1: worktree 唯一归属', () => {
  it('一个 worktree 同时只属于一个 teammate', async () => {
    // ...
  });
});
```

#### 6.3.2 不变量 #2：teammate 按 name 寻址

```typescript
describe('不变量 #2: teammate 按 name 寻址', () => {
  it('通信按 name（不按 agentId）', async () => {
    // ...
  });

  it('name 变更 → 报错提示更新引用', async () => {
    // ...
  });
});
```

#### 6.3.3 不变量 #5：Fork agent prompt cache prefix byte-identical

```typescript
describe('不变量 #5: prompt cache prefix byte-identical', () => {
  it('fork agent 的 prompt prefix 与父 agent 完全一致', async () => {
    // ...
  });

  it('占位 tool_result 填充所有未配对 tool_use', async () => {
    // ...
  });
});
```

#### 6.3.4 不变量 #6：Shutdown 四步握手（不强杀）

```typescript
describe('不变量 #6: Shutdown 四步握手', () => {
  it('shutdown_request + shutdown_response 协议', async () => {
    // ...
  });

  it('timeout 不强杀 teammate', async () => {
    // ...
  });

  it('teammate reject 后继续运行', async () => {
    // ...
  });
});
```

#### 6.3.5 不变量 #7：mailbox 消息丢失率 = 0

```typescript
describe('不变量 #7: mailbox 消息丢失率 = 0', () => {
  it('1000 次并发写入全部成功', async () => {
    // ...
  });

  it('归档后消息仍可读取', async () => {
    // ...
  });

  it('leader 重启后未读消息可达', async () => {
    // ...
  });
});
```

#### 6.3.6 关联不变量 #16：9 场景错误恢复矩阵

```typescript
describe('关联不变量 #16: 9 场景恢复', () => {
  it('场景 3：team 缺失 → 三态恢复', async () => {
    // ...
  });

  it('场景 4：mailbox 损坏 → 从 .bak 恢复', async () => {
    // ...
  });

  it('场景 6：task 损坏 → 从 work item 恢复', async () => {
    // ...
  });

  it('场景 7：sidechain 损坏 → 从父 transcript 恢复', async () => {
    // ...
  });
});
```

### 6.4 性能基准测试（引用 L2 §9.4，不重复）

M5 相关性能指标（PRD mod-05 §6.1）：

| 指标 | 目标值 | 测量方式 |
|------|-------|---------|
| Mailbox 写延迟 P99 | ≤ 50ms | writeMailboxAtomic 埋点 |
| Session transcript 写延迟 P99 | ≤ 100ms | drainWriteQueue 埋点（sidechain 持久化） |
| 进程崩溃后 resume 成功率 | ≥ 95% | 三态恢复 + sidechain 恢复测试 |
| mailbox 消息丢失率 | 0% | 1000 次并发写入测试 |

L2 §9.4 已设计完整性能基准测试方案，本文不重复。

---

## 7. 里程碑对齐

### 7.1 M2 多 Agent 协作（6-8 周，3-4 迭代）

PRD mod-05 阻塞 M2 里程碑（不是 M1）。M5 在 M2 三迭代交付：

#### 7.1.1 M2 迭代 1（2 周）

| 组件 | 文件路径 | 验收标准 |
|------|---------|---------|
| `Orchestrator.route` + 5 路径分发 | `src/orchestration/orchestrator.ts` | 5 路径分发 PASS / 失败模式（route 非法）PASS |
| `TaskManager` 双轨 | `src/orchestration/task-manager.ts` | createDualTrack / completeTask / failTask / getOutput PASS |
| `CoordinatorMode`（sync + async） | `src/orchestration/modes/coordinator.ts` | sync 阻塞 / async 立即返回 PASS |
| `SidechainManager` | `src/orchestration/sidechain.ts` | create + flush + read PASS |

#### 7.1.2 M2 迭代 2（2 周）

| 组件 | 文件路径 | 验收标准 |
|------|---------|---------|
| `MailboxService`（包装 M7 writeMailboxAtomic） | `src/orchestration/mailbox.ts` | send + readUnread + readAll PASS / 不变量 #7 PASS |
| `SwarmTeam` | `src/orchestration/modes/swarm.ts` | joinTeam + sendMessage PASS / 不变量 #2 PASS |
| `WorktreeRoster` | `src/orchestration/worktree-roster.ts` | assign + release + getOwner PASS / 不变量 #1 PASS |
| `TeammateRegistry` | `src/orchestration/teammate-registry.ts` | register + get + unregister + assertNameStable PASS |
| `ForkAgentSpawner` | `src/orchestration/modes/fork.ts` | spawn + fillPlaceholderToolResults PASS / 不变量 #5 PASS |

#### 7.1.3 M2 迭代 3（2 周）

| 组件 | 文件路径 | 验收标准 |
|------|---------|---------|
| `RemoteAgentClient` | `src/orchestration/modes/remote.ts` | SSH 连接 + 远程执行 + 断连重连 PASS |
| `ThreeStateRecovery` | `src/orchestration/recovery.ts` | running / stopped / evicted 判定 + recover PASS |
| `ShutdownHandshake` | `src/orchestration/shutdown.ts` | 四步握手 + timeout 不强杀 PASS / 不变量 #6 PASS |
| `WorkflowOrchestrator`（决策 A3 默认 off） | `src/orchestration/workflow.ts` | 默认 off + OMNIAGENT_WORKFLOW_ORCHESTRATOR=1 启用 PASS / 拓扑排序 + parallel PASS |

引用 L2 §11.4 M2 交付物，本文不重复。

### 7.2 M2 退出标准

L2 §11 已设计 M2 退出标准。M5 相关：

- 5 路径端到端跑通（sync / async / fork / teammate / remote）
- Coordinator Mode + Swarm Team + Fork Agent + Remote Agent 4 模式全部就绪
- 不变量 #1 / #2 / #4 / #5 / #6 / #7 相关测试全 PASS
- Mailbox 写延迟 P99 ≤ 50ms 实测
- 进程崩溃后 resume 成功率 ≥ 95% 实测
- mailbox 消息丢失率 = 0 实测

---

## 8. 开放问题

### 8.1 v2.x 演进项（引用 PRD §8.4，不重复）

PRD mod-05 §8.4 已列 v2.x 演进项：

- **Workflow Scripts 增强**：声明式工作流 + 脚本混合
- **Remote Agent 多区域路由**：按延迟选择最近实例

### 8.2 v3.x 演进项（引用 PRD §8.5，不重复）

PRD mod-05 §8.5 已列 v3.x 演进项：

- **Team Recommender 默认启用**：基于 memory 的 teammate 推荐，从 v3.x 起默认 on

### 8.3 待定决策

| # | 待定项 | 评估时间 | 影响 |
|---|--------|---------|------|
| 1 | SSH 客户端选型（node-ssh vs 自实现 ssh2 wrapper） | M2 迭代 3 | 影响 RemoteAgentClient 实施 |
| 2 | worktree 创建策略（git worktree add vs cp -r） | M2 迭代 2 | 影响 WorktreeRoster 性能与隔离性 |
| 3 | Workflow YAML 解析库选型（js-yaml vs yaml） | M2 迭代 3 | 影响 WorkflowOrchestrator 实施 |
| 4 | teammate 心跳机制（mailbox ping vs process signal） | M2 迭代 3 | 影响 ThreeStateRecovery 检测精度 |

### 8.4 依赖其他模块的交付物

M5 开工前需就绪的交付物（M2 启动前）：

- **M2 核心循环引擎**：子 agent spawn 后通过 M2 ReAct Loop 运行，M2 必须就绪（子 agent 的 runTurn）
- **M3 通用工具系统**：`agent_router` / `send_message` / `task_create` / `task_stop` / `task_output` 工具接口必须就绪（M3 AgentRouterTool 调 M5 Orchestrator.route）
- **M7 上下文与记忆引擎**：sidechain transcript 持久化 + mailbox 原子写原语必须就绪
- **mailbox 文件锁方案**：M2 启动前必须就绪（退避 + 原子写验证，L2 §5.3 已设计）
- **omniagent-types.ts §8/§9/§10**：`AgentRoute` / `RuntimeTaskSubtype` / `TaskStatus` / `WorkItem` / `RuntimeTask` / `AgentRouterParams/Result` / `MailboxMessage` / `MailboxCapacityLimits` / `WriteMailboxAtomicParams/Result` / `CompactBoundary` 必须定义

### 8.5 评测集依赖

本模块无直接评测集依赖（PRD mod-05 §8.3 已说明）。涉及多 Agent 协作的验收（mailbox 丢失率、resume 成功率、shutdown 四步握手）通过 M7 的 9 场景错误恢复矩阵测试覆盖（mod-07 §4.5.3 场景 3/4/6/7）。

---

## 附录 A：与本模块相关的 L2/PRD 章节映射

| L3 章节 | 引用 PRD 章节 | 引用 L2 章节 | 补充内容 |
|---------|-------------|------------|---------|
| §1 模块概述 | mod-05 §1 | L2 §1 | 范围 / 边界 / 架构位置引用 |
| §2 组件清单 | mod-05 §3 + §4 | L2 §3 + types.ts §8/§9/§10 | 22 个组件 |
| §3.1 agent_router 5 路径 | mod-05 §3.1 + §5.1 | — | Orchestrator.route 分发实施 |
| §3.2 Task 双轨 | mod-05 §3.2 | — | TaskManager + WorkItemStore + RuntimeTaskStore |
| §3.3 Mailbox 通信 | mod-05 §3.3 + §5.2 | L2 §5.3 | MailboxService 包装 writeMailboxAtomic |
| §3.4 Coordinator Mode | mod-05 §4.1 | — | CoordinatorMode 类 + 不变量 #4 |
| §3.5 Swarm/Team | mod-05 §4.1 | — | SwarmTeam 类 + 不变量 #2 |
| §3.6 Fork Agent | mod-05 §4.1 | L2 §4.2.4 | ForkAgentSpawner + 不变量 #5 |
| §3.7 Remote Agent | mod-05 §4.1 | — | RemoteAgentClient + SSH |
| §3.8 三态恢复 | mod-05 §4.2 | — | ThreeStateRecovery |
| §3.9 Shutdown 四步握手 | mod-05 §4.3 | L2 §4.2.6 | ShutdownHandshake + 不变量 #6 |
| §3.10 Workflow Orchestrator | mod-05 §4.4 | — | 决策 A3 默认 off |
| §3.11 Sidechain 与 CompactBoundary 解耦 | mod-05 §5 | L2 §3.10 | 澄清 K2：M5 不触发 rewind |
| §4 与其他模块的交互 | mod-05 §5 | — | 调用图 + 数据流 + 契约表 |
| §5 错误处理与降级 | mod-05 §5.1 | L2 §6 | 8 个错误码 + 7 fail-closed 场景 |
| §6 测试用例骨架 | mod-05 §7 | L2 §9 | 单元 + 集成 + 不变量 + 性能 |
| §7 里程碑对齐 | mod-05 §8 | L2 §11 | M2 三迭代组件级交付物 |
| §8 开放问题 | mod-05 §8.4 + §8.5 | — | v2.x/v3.x 演进 + 待定决策 |

---

## 附录 B：L3-M5 文档不变量

1. **不重复 PRD**：PRD mod-05 已有的 5 路径表、Task 双轨设计、Mailbox 容量限制、4 协作模式、三态恢复、Shutdown 四步、Workflow Orchestrator 决策 A3，本文仅引用不复制
2. **不重复 L2**：L2 §5.3 的 writeMailboxAtomic 完整实现、§4.2.4 的 fork 时序图、§4.2.6 的 shutdown 时序图，本文仅引用不复制
3. **类型契约一致**：本文引用的 `AgentRoute` / `RuntimeTaskSubtype` / `TaskStatus` / `WorkItem` / `RuntimeTask` / `AgentRouterParams/Result` / `MailboxMessage` / `MailboxCapacityLimits` / `WriteMailboxAtomicParams/Result` / `CompactBoundary` 签名与 omniagent-types.ts §8/§9/§10 一致
4. **接口签名一致**：本文新增的 `Orchestrator` / `TaskManager` / `MailboxService` / `CoordinatorMode` / `SwarmTeam` / `ForkAgentSpawner` / `RemoteAgentClient` / `ThreeStateRecovery` / `ShutdownHandshake` / `WorkflowOrchestrator` / `SidechainManager` / `WorktreeRoster` / `TeammateRegistry` 与 PRD mod-05 §3-§4 描述一致
5. **错误码一致**：本文引用的 8 个错误码（MAILBOX_FULL / MAILBOX_LOCKED / PERSISTENCE_IO_ERROR / PERSISTENCE_CORRUPTION / TOOL_EXECUTION_ERROR / TOOL_TIMEOUT / USER_INTERRUPT / PROVIDER_TIMEOUT）与 L2 §6 + omniagent-types.ts §19 一致
6. **里程碑一致**：本文 M2 三迭代交付物与 L2 §11.4 一致
7. **不变量一致**：本文守护的不变量 #1（worktree 唯一归属）+ #2（teammate 按 name 寻址）+ #5（Fork prompt cache prefix byte-identical）+ #6（Shutdown 四步握手不强杀）+ #7（mailbox 消息丢失率 = 0）与附录 A 18 项不变量一致；关联不变量 #4（Coordinator 工具池硬隔离）与 M3 共同守护；关联不变量 #16（9 场景错误恢复矩阵）与 M7 共同守护
8. **决策一致**：本文实现的 Workflow Orchestrator 默认 off（决策 A3）与 PRD mod-05 §8.1 决策 A3 一致
9. **不引入新供应商专有名词**：示例用 SSH / OmniAgent 等已有术语，不新增
10. **解耦一致**：M5 不触发 rewind（PRD mod-05 §5 澄清 K2），rewind 由用户 `/rewind` 命令触发，M7 实现
