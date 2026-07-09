# OmniAgent CLI — 模块 7：上下文与记忆引擎 (Context & Memory) PRD

> 模块 ID: M7
> 主负责角色: 上下文工程组
> 阻塞里程碑: M1（Walking Skeleton）
> 源章节: 原总体 PRD §4.5（内容已迁移到本模块 PRD；总体 PRD §4 重构为模块索引表后无 §4.5 子节）
> 状态: M0 已冻结

---

## 1. 模块概述

### 范围（in scope）

- 分层记忆架构：L1 工作记忆 / L2 会话记忆 / L3 项目记忆 / L4 系统提示
- 项目记忆 4 类型（user / feedback / project / reference）+ 双重上限（≤200 行 / ≤25KB）
- 召回机制：findRelevantMemories 轻量级 LLM 召回（recall@5≥0.8 / precision@5≥0.7）
- SystemPrompt 三阶段组装（getSystemPrompt → buildEffectiveSystemPrompt → buildSystemPromptBlocks）
- 三层压缩策略：L1 MicroCompact / L2 SessionMemory / L3 API 摘要
- PTL 紧急降级三步（collapse_drain → reactive_compact → error）
- 逃逸条件（6 个）：shouldAutoCompact 必须支持
- 持久化与恢复：Session transcript JSONL + Sidechain + 9 场景错误恢复矩阵
- CompactBoundary：压缩点标记，rewind 时按 boundary 还原

### 边界（out of scope）

- **LLM 调用**：由 M1 模型抽象层负责，本模块的召回与 API 摘要通过 M1 调用 LLM
- **ReAct 状态机**：由 M2 核心循环引擎负责，本模块只在 BUILD_CONTEXT 状态加载上下文、在 `ptl` stop_reason 时执行降级
- **工具结果的内容生成**：由 M3 通用工具系统负责，本模块只对工具结果做压缩/摘要
- **Mailbox 持久化**：由 M5 多 Agent 编排引擎负责，本模块只提供原子写原语

### 在整体架构中的位置

上下文与记忆引擎是 harness 层的**记忆中枢**。它决定了模型能看到什么、记住什么、在上下文逼近上限时如何降级。本模块直接影响 prompt cache 命中率、长任务可靠性、合规场景的数据持久化。

---

## 2. 设计目标

1. **分层记忆**：4 层各有不同生命周期与注入策略，避免全量注入撑爆上下文
2. **召回精准**：findRelevantMemories recall@5≥0.8（不漏）/ precision@5≥0.7（少噪声）
3. **压缩安全**：tool_use/tool_result 配对完整性，压缩不截断配对
4. **PTL 可降级**：紧急降级三步必走完，circuit breaker 3 次触发熔断
5. **持久化可靠**：JSONL append-only + 9 场景错误恢复矩阵 + 写队列节流

---

## 3. 核心概念与接口

### 3.1 分层记忆架构

OmniAgent CLI 的记忆系统分为四层，每层有不同的生命周期与注入策略：

| 层 | 内容 | 生命周期 | 注入策略 |
|----|------|---------|---------|
| L1 工作记忆 | 当前对话消息 + 工具调用结果 | 单会话 | 全量注入 |
| L2 会话记忆 | 跨 turn 的关键事实摘要 | 单会话 | 按需召回 |
| L3 项目记忆 | `~/.omniagent/memory/*.md` | 跨会话持久 | 召回注入 |
| L4 系统提示 | 品牌 + 工具说明 + 不变量 | 单会话 | 静态前缀 + 动态后缀 |

### 3.2 项目记忆 4 类型

项目记忆支持 4 种类型，模拟人类助理的记忆结构：

| 类型 | 内容 | 示例 |
|------|------|------|
| `user` | 用户角色、偏好、技能 | "用户是 Go 后端工程师，偏好函数式风格" |
| `feedback` | 用户反馈的做事方式 | "提交前必跑 `bun test`" |
| `project` | 项目状态、进行中的工作 | "正在重构 auth 模块，目标是去掉 session 依赖" |
| `reference` | 外部系统指针 | "CI 在 Linear 项目 PROJ-123" |

**双重上限**：单条记忆 ≤ 200 行 / ≤ 25KB，超限自动摘要压缩。

**Memory 文件 frontmatter schema**：

```yaml
---
name: memory-name                  # 必填，记忆唯一名（snake_case）
description: one-line description  # 必填，一行描述，用于召回相关性判定
type: user | feedback | project | reference   # 必填，4 类型之一
scope: project | user              # 可选，默认 project（~/.omniagent/memory/ 为 user）
created_at: 2026-07-08             # 可选，创建日期（ISO 8601）
updated_at: 2026-07-08             # 可选，最后更新日期
version: 1                         # 可选，版本号
---

记忆正文（Markdown）
```

- `name` + `type` 全局唯一，重名时启动期校验失败，跳过后加载的不影响前者。
- `description` 字段供 findRelevantMemories 召回时做相关性初筛，需具体不可笼统。
- frontmatter 损坏时启动期校验失败，提示行号，跳过该 memory 不影响其他。

### 3.3 召回机制接口

```
findRelevantMemories(query: string, max_tokens: number = 256): Memory[]
```

- 用轻量级 LLM 召回相关记忆
- 召回指标：`recall@5 ≥ 0.8`（不能漏掉相关记忆），`precision@5 ≥ 0.7`（允许少量噪声）
- 召回结果置信度低于阈值时不注入，避免噪声污染上下文
- 模型失败时跳过召回，对话继续不崩

### 3.4 SystemPrompt 三阶段组装

SystemPrompt 不是单个字符串，而是品牌类型 `string[]`，支持分块缓存：

```
阶段 1: getSystemPrompt()
  → 收集所有来源的 prompt 片段（品牌 / 工具说明 / 项目规范 / memory 召回）

阶段 2: buildEffectiveSystemPrompt()
  → 5 级优先级合并（override > coordinator > main-thread agent > custom/default > append）

阶段 3: buildSystemPromptBlocks()
  → 切分为静态前缀（可缓存） + 动态后缀（每轮变化）
  → 通过 STATIC_DYNAMIC_BOUNDARY 标记切分点，最大化 prompt cache 命中率
```

---

## 4. 功能详述

### 4.1 召回机制

> [M0 冻结决策 C2 更新] 召回机制选"轻量级 LLM 召回"，max_tokens=256，recall@5≥0.8 / precision@5≥0.7。合规场景本地 embedding 方案延后到 v2.x。

`findRelevantMemories(query, max_tokens=256)` 用轻量级 LLM 召回相关记忆：
- 召回指标：`recall@5 ≥ 0.8`（不能漏掉相关记忆），`precision@5 ≥ 0.7`（允许少量噪声）。
- 召回结果置信度低于阈值时不注入，避免噪声污染上下文。
- 模型失败时跳过召回，对话继续不崩。

**召回用模型**：通过 `capabilities.supportsRiskClassification` 类似的轻量级筛选逻辑，选用低延迟、低成本的 LLM（与主对话模型可不同）。召回 LLM 调用成本在 Cost Tracker 中单独统计，便于监控高频调用的成本漂移。

**评测集要求**：findRelevantMemories 评测集 ≥ 30 条标注会话，人工标好"相关 memory"标签，作为召回机制开发前 P0 前置材料。

**合规场景本地化**（v2.x）：本地 embedding 模型（如 all-MiniLM-L6-v2）作为召回替代方案，满足数据不出内网要求。

### 4.2 三层压缩策略

当上下文逼近窗口上限时，分层触发压缩：

| 层 | 触发条件 | 策略 |
|----|---------|------|
| L1 MicroCompact | 单条工具结果过大 | 截断/摘要单条工具结果 |
| L2 SessionMemory | 工具结果累计过大 | 摘要 COMPACTABLE_TOOLS 白名单中的 8 个工具结果 |
| L3 API 摘要 | 整体上下文逼近 PTL | 调用 LLM 做整体摘要 |

**保留窗口算法**：压缩时保留最近 `minTokens=10K` / `minText=5` 条消息，最多保留 `maxTokens=40K`，保证近期上下文不丢失。

**tool_use/tool_result 配对保护**：`adjustIndexToPreserveAPIInvariants()` 保证压缩不截断 `tool_use`/`tool_result` 对，无法修正则报错而非破坏配对。

**COMPACTABLE_TOOLS 白名单（8 个）**：`bash`, `edit_file`, `read_file`, `write_file`, `glob`, `grep`, `task_output`, `web_fetch`——这些工具的中间结果可安全摘要，其他工具结果保留原样。

### 4.3 PTL 紧急降级三步

当 Prompt Too Long 触发时（LLM 返回 `ptl` 错误），按三步降级：

1. **collapse_drain**：立即清空最早的可压缩消息（COMPACTABLE_TOOLS 结果），释放空间。
2. **reactive_compact**：触发 L2 SessionMemory 压缩，重新发送请求。
3. **error**：若仍失败，明确报错并提示用户手动 `/compact`，不无限重试。

**Circuit Breaker**：`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3`，连续 3 次压缩失败触发熔断，降级为报错，防止压缩死循环。

### 4.4 逃逸条件（6 个）

`shouldAutoCompact()` 必须支持 6 个逃逸条件，避免在不该压缩时压缩：

1. 用户禁用自动压缩（`/compact off`）
2. 正在压缩中（防重入）
3. 已经压缩过（不重复压缩）
4. collapse 处理中（PTL 流程中）
5. budget continuation（预算续跑模式）
6. 第三方 provider 无精确 token 计数（保守估算提前压缩）

### 4.5 持久化与恢复

#### 4.5.1 Session transcript 与 4 种视图

- **Session transcript**：JSONL append-only，`uuid`/`parentUuid` 链路。
- **4 种视图语义**：

| 视图 | 语义 | 用途 |
|------|------|------|
| Raw | JSONL 文件原始记录，按 `uuid`/`parentUuid` 链路组织的全量消息 | 调试、`/rewind` 还原、崩溃恢复 walkChain |
| UI | 渲染后用户可见的视图，过滤掉系统消息与中间工具调用细节 | 终端展示、IDE 展示、用户读 |
| Active query | 当前 turn 相关的子集，仅包含本 turn 需要注入 LLM 的消息 | 上下文组装，最小化 token |
| API wire | 转换为 LLM API 格式的消息序列，含 `role`/`content`/`tool_use`/`tool_result` 块 | 发送给 LLMProvider，符合 OpenAI/Anthropic 消息格式 |

#### 4.5.2 Sidechain

- **Sidechain**：子 agent 的独立 transcript，与主 transcript 通过 `parentUuid` 关联。
- **读写权限**：子 agent 只能写自己的 sidechain；主 agent 通过 M5 编排引擎按 name 引用 sidechain（不直接读写）。sidechain 的写队列与主 transcript 共享 drainWriteQueue 原语，并发安全。
- **CompactBoundary 同步**：sidechain 压缩时也标记 boundary，与主 transcript 的 boundary 对齐（详见 §4.6）。

#### 4.5.3 9 场景错误恢复矩阵

| # | 场景 | 检测方式 | 恢复策略 | 数据损失预期 |
|---|------|---------|---------|------------|
| 1 | main transcript 损坏 | `walkChainBeforeParse` 检测 `uuid`/`parentUuid` 断链 | 从最近 checkpoint 重建主链，断点后 turn 标记为"丢失" | 丢失断点后到 checkpoint 的 turn（≤ 1 turn） |
| 2 | sidechain 损坏 | 子 agent spawn 时校验 sidechain 完整性 | 从 sidechain 最近 boundary 重建，无法恢复的 turn 标记为"丢失" | 丢失断点后到 boundary 的子 agent turn（≤ 1 turn） |
| 3 | team 缺失（teammate 找不到） | `SendMessage` 路由时 roster 未找到 name | leader 收到 `stopped` 状态通知，按策略重启 teammate 或放弃 | teammate 未读消息保留在 mailbox（不丢失） |
| 4 | mailbox 损坏 | JSONL 解析失败 / 原子写校验和不对 | 从 `.omniagent/mailbox/{name}.bak` 备份恢复，无备份则清空重建 | 丢失最后一次成功写入后的消息（≤ 100ms 节流窗口） |
| 5 | task 损坏（work item 或 runtime task） | work item JSON schema 校验失败 | work item 从 LLM 重新生成（LLM 维护，可重放）；runtime task 从 harness 调度状态重建 | 丢失未持久化的 runtime task 调度状态（≤ 10ms flush 窗口） |
| 6 | sidecar 404（远程子进程消失） | M5 远程路由 ping 超时 | 按三态恢复（`evicted`），leader 重新 spawn 或放弃 | 丢失 sidecar 内存中未持久化的中间结果（已持久化的 sidechain 不丢） |
| 7 | worktree pointer 缺失 | worktree 启动时 `git rev-parse` 失败 | 从 teammate roster 重建 worktree pointer，roster 不在则报错 | 不丢数据（worktree 文件还在），仅 pointer 需重建 |
| 8 | fork metadata 缺失 | fork agent spawn 时 metadata schema 校验失败 | 从 parentUuid 回溯父 agent 重建 metadata，无法回溯则报错 | 丢失 fork 的独立 sidechain（主会话不受影响） |
| 9 | 模式不匹配（resume 时 mode 对不上） | `omniagent --resume <sessionId>` 时 mode 字段校验失败 | 提示用户选择：降级为 default mode 恢复 / 中止 resume | 不丢数据，仅 mode 需用户重新确认 |

每场景的恢复策略通过**场景注入测试**验证（见 §7 不变量 #16）。

#### 4.5.4 写队列

- **写队列**：100ms 节流批量写 + 10ms flush 紧急持久化，崩溃时数据不丢。
- **并发控制**：drainWriteQueue 单例锁，多 agent 并发写经排队串行化，不并发写同一 JSONL 文件。

#### 4.5.5 Resume

- **Resume**：`omniagent --resume <sessionId>` 恢复对话链 + mode + 权限规则，从 sidechain 续跑。
- **Resume 95% 成功率路径**：
  1. JSONL append-only（单条消息原子写）→ 崩溃不破坏已写消息
  2. 写队列 100ms 节流 + 10ms flush → 崩溃窗口最多丢 100ms 数据
  3. 9 场景错误恢复矩阵 → 任意 1 种损坏场景可恢复
  4. `walkChainBeforeParse` 启动期校验 → 检测断链并触发场景 1 恢复
  5. CompactBoundary 还原 → 压缩点上下文状态可回退
  - 因果映射：1+2+3+4+5 共同保障"崩溃后可恢复" → 实测 resume 成功率 ≥ 95%（M7 NFR §6.2）

### 4.6 CompactBoundary

每次压缩记录 boundary，`/rewind` 时按 boundary 还原上下文状态，支持回退到压缩前的某个完整状态，而非部分残缺状态。

**CompactBoundary 事件与 rewind 的关系**（澄清 K2 契约）：

- CompactBoundary 事件**不直接触发 rewind**。事件由 M7 在每次压缩完成时发出，记录 boundary 元数据（boundary_id / 压缩前的 message range / 时间戳）到 transcript。
- `/rewind` 是用户命令，触发时读取最近的 boundary 元数据，按 boundary 还原上下文状态。
- 即：CompactBoundary 是"记录点"，`/rewind` 是"还原操作"，二者解耦但共享 boundary 元数据。

**CompactBoundary 与 sidechain 交互**（澄清 N12）：

- 主 transcript 压缩时，sidechain 不同步标记 boundary（sidechain 独立压缩）。
- 但 sidechain 自己的压缩点也标记 boundary，与主 transcript 的 boundary 各自独立。
- `/rewind` 默认只还原主 transcript；sidechain 的 `/rewind` 通过 M5 编排引擎的 `--sidechain <id>` 参数单独触发。

---

## 5. 与其他模块的交互

| 交互模块 | 交互方式 | 数据/控制流 |
|---------|---------|------------|
| M2 核心循环引擎 | 被调用 | M2 BUILD_CONTEXT 状态调用本模块加载 system prompt + memory 召回 + tool 池；M2 `ptl` stop_reason 委托本模块 PTL 紧急降级三步 |
| M2 核心循环引擎（压缩） | 被调用 | M2 每轮结束后调用本模块 `shouldAutoCompact()` 判断是否触发压缩 |
| M1 模型抽象层 | 调用 | 本模块 `findRelevantMemories()` 与 L3 API 摘要通过 M1 调用轻量级 LLM；`countTokens()` 用于上下文体积估算 |
| M3 通用工具系统 | 数据流 | M3 工具返回的 `tool_result` 由本模块 COMPACTABLE_TOOLS 白名单（8 个工具，名称与 M3 §4.1 工具清单一致，详见 §4.2）决定是否可摘要压缩 |
| M4 权限与拦截系统 | Hook 事件 | 本模块发出的 `CompactBoundary` 事件（每次压缩完成时）经 M4 Hook 中间件触发外部 Hook；持久化文件（transcript/sidechain）受 M4 sandbox 4 类 deny 路径中的"`.omniagent/` 目录防篡改"保护（与 M3 24 项 bashSecurity 校验同源，详见 mod-04 §4.3） |
| M5 多 Agent 编排引擎 | 持久化 | M5 子 agent 的 sidechain transcript 由本模块持久化（§4.5.2）；M5 mailbox JSONL 用本模块的原子写原语（drainWriteQueue）；CompactBoundary 事件由本模块发出（M5 不触发 rewind，rewind 由用户 `/rewind` 命令触发，详见 §4.6） |

**关于 UserPromptSubmit / AssistantResponse 事件的说明**（澄清 K3）：这两个事件由 M2 核心循环引擎在用户输入到达与 LLM 响应结束时发出，经 M4 Hook 中间件触发外部 Hook，**与本模块无直接关系**（本模块不发出也不消费这两个事件）。mod-04 §5 中将这两个事件归入 M7 交互行的描述不准确，应以本模块为准。

---

## 6. 模块级非功能性需求

从总体 PRD §5 抽取与本模块相关的 NFR：

### 6.1 性能指标（摘自 §5.2.1）

| 指标 | 目标值 | 测量方式 |
|------|-------|---------|
| Prompt cache 命中率 | ≥ 80% | cache_read / input_tokens |
| Session transcript 写延迟 P99 | ≤ 100ms | drainWriteQueue 埋点 |
| 大文件（10MB JSONL）读取 | ≤ 2s | walkChainBeforeParse 埋点 |
| findRelevantMemories 召回延迟 | ≤ 2s | LLM 调用埋点 |

### 6.2 可靠性指标（摘自 §5.2.2）

| NFR | 目标值 |
|-----|-------|
| 进程崩溃后 resume 成功率 | ≥ 95% |
| PTL 紧急降级成功率 | 100% |
| autocompact 连续失败 circuit breaker | 3 次触发 |

### 6.3 召回质量指标（摘自决策 C2）

| 指标 | 目标值 |
|------|-------|
| findRelevantMemories recall@5 | ≥ 0.8 |
| findRelevantMemories precision@5 | ≥ 0.7 |

### 6.4 护栏指标（摘自 §5.2.3）

| 护栏 | 目标值 | 为什么是护栏 |
|------|-------|------------|
| autocompact 连续失败 | ≤ 3 次 | 连续失败 = PTL 风险 |

---

## 7. 模块级不变量

从附录 A 18 项不变量中抽取与本模块相关的条目：

| # | 不变量 | 守护机制（含测试用例设计） |
|---|--------|---------|
| 3 | tool_use/tool_result 配对完整性 | `adjustIndexToPreserveAPIInvariants()` 强制修正；压缩时不能截断配对；无法修正则报错。**测试用例**：构造 messages 含 `tool_use` 无配对 `tool_result` 的场景 → 调用压缩 → 断言（a）`tool_use` 被移除，或（b）配对的 `tool_result` 一并被保留；构造配对在压缩边界两侧的场景（tool_use 在保留区，tool_result 在压缩区）→ 断言报错而非截断 |
| 11 | autocompact circuit breaker 3 次触发 | 连续失败测试（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3`）。**测试用例**：mock LLM API 摘要接口连续返回 500 → 触发 3 次 reactive_compact → 断言第 3 次后熔断，不再重试，转为 error 路径；分别测试 2 次失败后成功的场景（不熔断）与 3 次全失败的场景（熔断） |
| 12 | PTL 紧急降级三步必走完 | PTL 注入测试。**测试用例**：mock LLM 返回 `stop_reason=ptl` → 断言依次执行 collapse_drain（最早 COMPACTABLE_TOOLS 结果被清空）→ reactive_compact（L2 SessionMemory 压缩被触发）→ 重发请求；若重发仍 ptl → 断言走 error 路径并提示用户手动 `/compact`，不无限重试；mock 第 2 步成功 → 断言不进入 error 路径 |
| 16 | 9 场景错误恢复矩阵全覆盖 | 场景注入测试。**测试用例**：对 §4.5.3 的 9 个场景逐个注入（如场景 1：手动破坏 JSONL 的 parentUuid 链路；场景 4：破坏 mailbox JSONL 校验和；场景 6：kill sidecar 进程）→ 断言检测机制识别到损坏 → 恢复策略执行 → 数据损失在预期范围内（见 §4.5.3 表"数据损失预期"列）→ 会话可继续而非崩溃 |

---

## 8. 开放问题与依赖

### 8.1 已冻结决策（M0）

| 决策 | 内容 | 影响 |
|------|------|------|
| C2 | 记忆召回机制：轻量级 LLM 召回 | 本模块 findRelevantMemories max_tokens=256，recall@5≥0.8 / precision@5≥0.7，合规场景本地 embedding 延后到 v2.x |

### 8.2 依赖其他模块的交付物

- M1 模型抽象层：轻量级 LLM provider 必须就绪（与主对话模型可不同）
- M2 核心循环引擎：BUILD_CONTEXT 状态调用本模块，`ptl` stop_reason 委托本模块降级
- M3 通用工具系统：工具结果由本模块压缩，COMPACTABLE_TOOLS 白名单须与 M3 工具命名一致

### 8.3 评测集引用

- **findRelevantMemories 评测集**（`omniagent-eval/memory-recall/`，30 条标注会话）：
  - 覆盖 6 种召回场景（S01-S06）+ 4 种 memory 类型（user/feedback/project/reference 各 ≥5 相关样本）
  - 验收指标：recall@5 ≥ 0.8 / precision@5 ≥ 0.7
  - 当前状态：AI 种子完成（30 条），待人工校验冻结
  - M1 启动前 P0 前置门槛，缺它不能开工

### 8.4 v2.x 演进项

- findRelevantMemories 本地 embedding（`all-MiniLM-L6-v2`，满足合规场景数据不出内网）
- 9 场景错误恢复矩阵扩展（基于生产故障案例补充）

### 8.5 v3.x 演进项

- Context Anchor 默认启用（上下文锚点，优化长对话相关性，从 v3.x 起默认 on，与总体 PRD §6.2 + mod-05 §8.5 对齐）

---

## 9. 参考链接

- 总体 PRD：`omniagent-prd.md` §4.5
- 冻结决策记录：`omniagent-prd-decisions.md`（决策 C2）
- 相关模块：M1 模型抽象层、M2 核心循环引擎、M3 通用工具系统、M4 权限与拦截系统、M5 多 Agent 编排引擎
- 评测集：`omniagent-eval/memory-recall/`（30 条，M1 启动前 P0 前置门槛）
- 里程碑：M1 Walking Skeleton（分层记忆 + 持久化 resume + findRelevantMemories 召回必须就绪）
