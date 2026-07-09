# OmniAgent CLI — 模块 5：多 Agent 编排引擎 (Orchestration) PRD

> 模块 ID: M5
> 主负责角色: 架构师
> 阻塞里程碑: M2（多 Agent 协作）
> 源章节: 原总体 PRD §4.3（内容已迁移到本模块 PRD，总体 PRD §4.3 现为模块级不变量与 NFR 分配）
> 状态: M0 已冻结

---

## 1. 模块概述

### 范围（in scope）

- 单一入口路由：所有多 Agent 操作通过 `agent_router` 工具路由，5 条路径（sync / async / fork / teammate / remote）
- 协作模式标准化：Coordinator Mode（主从编排）、Swarm/Team（对等团队）、Fork Agent（上下文分叉）、Remote Agent（远程委托）
- Task 双轨设计：Work item JSON（LLM 维护）+ Runtime task（harness 维护，7 种 subtypes）
- Mailbox 通信：文件系统 JSONL，按 name 寻址，原子写 + 退避
- 三态恢复：running / stopped / evicted
- Shutdown 四步握手
- 工作流编排器（Workflow Orchestrator，实验 feature 默认 off）

### 边界（out of scope）

- **工具接口实现**：由 M3 通用工具系统负责，本模块只提供 `agent_router`/`send_message`/`task_create`/`task_stop` 等工具的路由逻辑
- **权限拦截**：由 M4 权限与拦截系统负责，本模块的 agent spawn 同样经五层拦截链
- **上下文压缩与 sidechain 持久化**：由 M7 上下文与记忆引擎负责，本模块只触发 sidechain 创建
- **LLM 调用**：由 M1 模型抽象层负责，本模块 spawn 的子 agent 通过 M2 ReAct Loop 调用 LLM

### 在整体架构中的位置

多 Agent 编排引擎是 harness 层的**协作枢纽**。从单条 query 到 Fork、Async Subagent、Coordinator Worker、Swarm Teammate、Remote Agent，共享同一套 task/mailbox/sidechain 基础设施。用户按任务复杂度选择协作模式，范式统一、原语可组合。

---

## 2. 设计目标

1. **单一入口**：所有多 Agent 操作通过 `agent_router` 路由，避免分散的 spawn 逻辑
2. **模式可组合**：sync/async/fork/teammate/remote 五条路径原语可组合（如 fork + teammate = 团队成员分叉）
3. **name 寻址**：teammate 按 name 寻址（不是 agentId），name 变更时报错提示更新引用
4. **三态恢复**：teammate 状态明确（running/stopped/evicted），leader 按策略重启或放弃
5. **优雅退出**：Shutdown 四步握手，不强杀

---

## 3. 核心概念与接口

### 3.1 单一入口路由

所有多 Agent 操作通过 `agent_router` 工具单一入口路由，避免分散的 spawn 逻辑。路由支持 5 条路径：

| 路由路径 | 说明 | 典型用途 |
|---------|------|---------|
| `sync` | 同步子 agent，阻塞主对话 | 单次复杂查询（如 Explore） |
| `async` | 异步后台子 agent，不阻塞 | 长任务（完整测试套件） |
| `fork` | 继承父上下文的临时分叉 | 上下文分支试验 |
| `teammate` | 加入 Swarm Team，对等协作 | 多角色并行开发 |
| `remote` | 委托到远程 OmniAgent 实例 | SSH 远程执行 |

### 3.2 Task 双轨

Task 系统采用双轨设计：
- **Work item JSON**（LLM 维护）：高层任务概念，由 LLM 创建/更新/完成。
- **Runtime task**（harness 维护）：底层执行单元，7 种 subtypes（sync/async/fork/teammate/remote/daemon/scheduled）。

两轨通过 `taskId` 关联，LLM 操作 work item，harness 调度 runtime task。

### 3.3 Mailbox 通信契约

- 文件系统 JSONL，按 name 寻址（不是 agentId）
- 原子写（temp + rename）+ 10 次退避，应对文件锁竞争
- 容量限制：单条 64KB / 文件 4MB / 1000 条消息
- teammate 通信跨 turn 持久化，leader 重启后未读消息仍可达

---

## 4. 功能详述

### 4.1 协作模式标准化

**Coordinator Mode（主从编排）**：
- 主 Agent 只编排，不直接执行 Bash/Edit/Write。
- `mergeAndFilterTools()` 强制移除主 Agent 的写工具。
- 主 Agent spawn worker 执行，worker 完成后结果回注主 Agent。
- 不变量：Coordinator 模式下主 Agent 直接工具调用率 = 0。

**Swarm / Team（对等团队）**：
- 多 teammate 共享 task list + mailbox。
- 按 name 寻址（不是 agentId），name 变更时报错提示更新引用。
- mailbox 容量限制：单条 64KB / 文件 4MB / 1000 条消息，超限老消息归档。
- teammate 通信跨 turn 持久化，leader 重启后未读消息仍可达。

**Fork Agent（上下文分叉）**：
- 继承父 Agent 的上下文与工具池。
- **prompt cache prefix byte-identical**：通过占位 `tool_result` 保证 prefix 完全一致，最大化 cache 命中。
- 独立 sidechain（子 JSONL transcript），不污染父会话。

**Remote Agent（远程委托）**：
- 委托到 SSH 远程 OmniAgent 实例。
- 远程实例可自托管 Remote Server，支持团队协作。
- 断连自动重连，未完成请求按三态恢复。

### 4.2 三态恢复（SendMessage）

- `running`：teammate 正常运行，消息可达。
- `stopped`：teammate 进程停止，leader 收到通知，按策略重启或放弃。
- `evicted`：teammate 被回收（如内存压力），leader 重新 spawn 或放弃。

### 4.3 Shutdown 四步握手

1. leader 发 `shutdown_request`
2. teammate 回 `shutdown_response`（approve/reject）
3. approve → 清理资源；reject → 继续运行
4. 不强杀，优雅退出。

### 4.4 工作流编排器（Workflow Orchestrator）

> [M0 冻结决策 A3 更新] Workflow Orchestrator 默认 off，通过 `OMNIAGENT_WORKFLOW_ORCHESTRATOR=1` 环境变量显式启用。

对于复杂的多 Agent 工作流（如"找问题 → 对抗式验证 → 修复"），OmniAgent CLI 提供声明式工作流编排：

```yaml
# .omniagent/workflows/migrate-and-verify.yaml
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

工作流引擎负责调度、并行控制、依赖管理、失败重试。工作流可 resume（从完成的 step 续跑）。

**实验 feature 环境变量命名规范**（全部默认 off，显式启用）：
- `OMNIAGENT_TASK_SCHEDULER=1`（定时任务/后台触发）
- `OMNIAGENT_PROACTIVE_PLANNER=1`（主动规划）
- `OMNIAGENT_COVERT_MODE=1`（隐身模式）
- `OMNIAGENT_WORKFLOW_ORCHESTRATOR=1`（工作流编排）
- `OMNIAGENT_TEAM_RECOMMENDER=1`（基于 memory 的 teammate 推荐）
- `OMNIAGENT_CONTEXT_ANCHOR=1`（上下文锚点）

文档需明示这些 feature 是实验性的，API 行为可能在 v2.x 变更。

---

## 5. 与其他模块的交互

| 交互模块 | 交互方式 | 数据/控制流 |
|---------|---------|------------|
| M2 核心循环引擎 | 被调用 | M2 通过 `agent_router` 工具触发本模块路由；子 agent spawn 后通过 M2 ReAct Loop 运行 |
| M3 通用工具系统 | 工具实现 | 本模块提供 `agent_router`/`send_message`/`task_create`/`task_stop`/`task_output` 工具的路由逻辑，M3 提供工具接口 |
| M4 权限与拦截系统 | 拦截 | agent spawn 与 mailbox 写入经 M4 五层拦截链（特别是 Coordinator Mode 下的工具池隔离） |
| M6 Skills 插件系统 | fork 路由 | M6 Skill fork 模式执行时，spawn 独立 fork agent（继承父上下文 + 独立 sidechain），由本模块提供 fork 路由；M6 触发 fork 模式后通过 `agent_router` 工具传入 `route=fork` 参数调用本模块 |
| M7 上下文与记忆引擎 | 持久化 | 子 agent 的 sidechain transcript 由 M7 持久化；mailbox JSONL 由 M7 提供原子写原语（drainWriteQueue）；CompactBoundary 事件由 M7 在每次压缩时发出（本模块不触发 rewind，rewind 由用户 `/rewind` 命令触发，作用于 M7 transcript） |

**关于 CompactBoundary 与 rewind 的契约**（澄清 K2）：CompactBoundary 事件由 M7 发出并写入 transcript 元数据，**不直接触发 rewind**。`/rewind` 是用户命令，由 M7 读取 boundary 元数据后还原上下文。本模块（M5）的 sidechain 与主 transcript 各自独立标记 boundary，sidechain 的 `/rewind` 通过本模块的 `--sidechain <id>` 参数单独触发。

### 5.1 `agent_router` 工具接口签名与失败模式

```typescript
// M5 实现，M3 暴露为工具
agent_router(params: {
  route: 'sync' | 'async' | 'fork' | 'teammate' | 'remote';
  prompt: string;                       // 子 agent 的初始 prompt
  parent_context_mode?: 'inherit' | 'isolated';  // fork 默认 inherit，async 默认 isolated
  teammate_name?: string;               // route=teammate 时的 name（按 name 寻址，不变量 #2）
  remote_target?: string;              // route=remote 时的 SSH 主机或 Remote Server URL
  tools_whitelist?: string[];          // 子 agent 工具白名单（Custom Agent / Skill 用）
  timeout_ms?: number;                 // 超时（async/remote 常用）
}): {
  task_id: string;                     // runtime task ID（harness 维护）
  work_item_id: string;                // work item ID（LLM 维护）
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'evicted';
  result?: ToolResult;                 // sync 路径直接返回结果；async/fork/teammate/remote 通过 task_output 工具读取
}
```

**失败模式与处理策略**：

| 失败模式 | 检测方式 | 处理策略 |
|---------|---------|---------|
| 路由失败（route 参数非法） | M5 启动期 schema 校验 | 立即返回 `status=failed`，`result.is_error=true`，错误信息回注主 agent |
| 远端不可达（route=remote，SSH 失败） | TCP 连接超时 / SSH 握手失败 | 重试 3 次（指数退避），仍失败则按三态恢复 `evicted`，主 agent 收到 `status=evicted` |
| mailbox 满（route=teammate，容量超限） | writeMailboxAtomic 检测容量超 64KB/单条或 4MB/文件 | 触发老消息归档，仍满则返回 `status=failed`，主 agent 决定是否重试 |
| 子 agent spawn 失败（worktree 占用 / 权限拒绝） | spawn 时 M4 拦截链 deny 或 worktree roster 冲突 | 返回 `status=failed` + 拒绝原因，主 agent 可换 route 或放弃 |
| 子 agent 超时 | timeout_ms 到期 | 发送 SIGTERM → 等 5s → SIGKILL，返回 `status=timeout` + 部分结果（如有） |
| 子 agent 崩溃 | 进程退出码非 0 / sidechain 写入中断 | 三态恢复 `stopped`，leader 按策略重启或放弃，未读消息保留在 mailbox |

### 5.2 `writeMailboxAtomic` 接口签名

```typescript
// M7 提供原子写原语，M5 调用
function writeMailboxAtomic(params: {
  teammate_name: string;                // 收件人（按 name 寻址）
  message: MailboxMessage;              // 消息体（≤ 64KB）
  retries?: number;                     // 默认 10 次退避
}): {
  written: boolean;
  error?: 'file_locked' | 'over_capacity' | 'io_error';
  archive_triggered?: boolean;          // 是否触发了老消息归档
}
```

- 原子写：写入 `tmp` 文件 → `rename` 到目标路径，保证崩溃时文件不损坏。
- 退避：文件锁竞争时 1ms/2ms/4ms/.../512ms 共 10 次退避，仍失败则返回 `error=file_locked`。
- 容量超限：单条 > 64KB 立即拒绝；文件 > 4MB 触发归档（最老 200 条移到 `.omniagent/mailbox/{name}.archive.jsonl`）。
- 不变量 #7 守护：写入/读取对账，丢失率 = 0。

---

## 6. 模块级非功能性需求

从总体 PRD §5 抽取与本模块相关的 NFR：

### 6.1 性能指标（摘自 §5.2.1）

| 指标 | 目标值 | 测量方式 |
|------|-------|---------|
| Mailbox 写延迟 P99 | ≤ 50ms | writeMailboxAtomic 埋点 |
| Session transcript 写延迟 P99 | ≤ 100ms | drainWriteQueue 埋点（sidechain 持久化） |

### 6.2 可靠性指标（摘自 §5.2.2）

| NFR | 目标值 |
|-----|-------|
| 进程崩溃后 resume 成功率 | ≥ 95% |
| mailbox 消息丢失率 | 0% |

### 6.3 护栏指标（摘自 §5.2.3）

| 护栏 | 目标值 | 为什么是护栏 |
|------|-------|------------|
| mailbox 消息丢失率 | = 0 | 丢失 = 协作失败 |

---

## 7. 模块级不变量

从附录 A 18 项不变量中抽取与本模块相关的条目：

| # | 不变量 | 守护机制 |
|---|--------|---------|
| 1 | worktree 唯一归属（一个 worktree 同时只属于一个 teammate） | roster 校验 |
| 2 | teammate 按 name 寻址（不是 agentId） | SendMessage 路径校验 |
| 4 | Coordinator 模式下主 Agent 直接工具调用率 = 0 | 工具池硬隔离校验（`mergeAndFilterTools()`） |
| 5 | Fork agent 的 prompt cache prefix byte-identical | 占位 `tool_result` 校验 |
| 6 | Shutdown 四步握手（不强杀） | 协议状态机校验 |
| 7 | mailbox 消息丢失率 = 0 | 写入/读取对账 |

**关联不变量**（由其他模块守护但本模块依赖）：
- #16 9 场景错误恢复矩阵全覆盖（M7 守护，包含 team 缺失 / mailbox 损坏 / task 损坏等场景）

---

## 8. 开放问题与依赖

### 8.1 已冻结决策（M0）

| 决策 | 内容 | 影响 |
|------|------|------|
| A3 | 实验 feature 默认值：全部 off，env 显式启用 | 本模块 Workflow Orchestrator 默认 off，`OMNIAGENT_WORKFLOW_ORCHESTRATOR=1` 显式启用 |

### 8.2 依赖其他模块的交付物

- M2 核心循环引擎：子 agent spawn 后通过 M2 ReAct Loop 运行，M2 必须就绪
- M3 通用工具系统：`agent_router`/`send_message`/`task_create`/`task_stop`/`task_output` 工具接口必须就绪
- M7 上下文与记忆引擎：sidechain transcript 持久化与 mailbox 原子写原语必须就绪
- **mailbox 文件锁方案**：M2 启动前必须就绪（退避 + 原子写验证）

### 8.3 评测集引用

本模块无直接评测集依赖。涉及多 Agent 协作的验收（mailbox 丢失率、resume 成功率、shutdown 四步握手）通过 M7 的 9 场景错误恢复矩阵测试覆盖（mod-07 §4.5.3 场景 3/4/6/7），不单独建评测集。

### 8.4 v2.x 演进项

- Workflow Scripts 增强（声明式工作流 + 脚本混合）
- Remote Agent 多区域路由（按延迟选择最近实例）

### 8.5 v3.x 演进项

- Team Recommender 默认启用（基于 memory 的 teammate 推荐，从 v3.x 起默认 on，与总体 PRD §6.2 + mod-07 §8.5 对齐）

---

## 9. 参考链接

- 总体 PRD：`omniagent-prd.md` §4.3
- 冻结决策记录：`omniagent-prd-decisions.md`（决策 A3）
- 相关模块：M2 核心循环引擎、M3 通用工具系统、M4 权限与拦截系统、M7 上下文与记忆引擎
- 里程碑：M2 多 Agent 协作（fork/teammate/remote 路由 + Coordinator Mode + Swarm Team + mailbox + task files + Docker 分发 + 跨 provider fallback chain）
