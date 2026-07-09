# OmniAgent CLI 产品需求文档（PRD）

> 版本：v1.0（架构重构版，含 M0 评审冻结决策，模块化拆解）
> 状态：架构草案 → M0 已冻结
> 设计原则：模型无关、协议标准、品牌中立、资产复用
> 本 PRD 基于对一款终端原生 AI 编程助手（代号 CCB）的逆向 PRD 重构而来，剔除其与单一模型供应商的耦合，沉淀为通用、开源、模型无关的智能体 CLI 架构。
> 附件 A（`omniagent-prd-decisions.md`）记录 M0 评审冻结的 10 项未决问题决策，与本 PRD 具有同等约束力。
> **本 PRD 为总体产品方案**，各模块详细产品方案见模块 PRD（§4 模块索引表）。模块 PRD 自洽可独立交付，本总体 PRD 仅保留产品级内容与跨模块约束。

---

## 1. 产品概述 (Product Overview)

### 1.1 产品愿景与问题陈述

**问题陈述**：后端工程师、DevOps、安全工程师、远程协作者在 SSH 终端、远程开发、合规、团队协作场景下难以有效使用 AI 编程助手。现有工具存在三重割裂：
1. **形态割裂**：主流 AI 编程助手绑定 IDE 或云端 Web 控制台，SSH 终端用户被迫绕开或拼凑 `tmux + curl` 方案；
2. **模型割裂**：工具深度绑定单一模型供应商，企业按合规、成本、地区差异切换模型时被迫改造源码或放弃使用；
3. **能力割裂**：多 Agent 协作、权限审计、上下文压缩、可扩展插件等能力被碎片化为不同工具，难以在单一可审计的边界内闭环。

**产品愿景**：打造一款**终端原生、模型无关、协议标准、能力内建**的通用智能体 CLI。用户在终端内完成全部开发协作工作，可按成本/合规/性能自由切换任意 LLM 后端，并通过标准化的 MCP 协议与 JSON Schema 工具调用接入广阔生态。OmniAgent CLI 不绑定任何特定模型行为，"模型是 Agent，代码是 Harness"——harness 提供循环、权限、记忆、编排，模型负责推理与决策。

### 1.2 产品定位

OmniAgent CLI 是一款**终端原生的通用智能体工具**，定位为"开发者操作系统的 Agent 层"。

| 属性 | 说明 |
|------|------|
| 包名 | `omniagent-cli`（npm 已确认可用，2026-07-08 查询） |
| 入口命令 | `omniagent`（通过 package.json bin 字段映射，与包名解耦） |
| 短别名 | 不设官方短别名（避免与未来 npm 包冲突），用户可自行 `alias` |
| 运行时 | Node.js ≥ 20 LTS（首选 Bun ≥ 1.3 性能档；产物双兼容） |
| 实现语言 | TypeScript（strict 模式） |
| 许可 | 开源（Apache 2.0） |
| 部署形态 | CLI（主形态） + 自托管 Remote Server + IDE 协议接入 + 常驻 Daemon |
| 配置目录 | `~/.omniagent/`（用户级） + `.omniagent/`（项目级） |
| 配置入口 | `AGENT.md`（项目规范） + `.omniagent/settings.json`（机器配置） |
| 保护性占位 | 建议同时注册 `omni-agent` 作为 npm 保护性占位，防止抢注 |

**关键边界声明**：OmniAgent CLI 不是某款商业产品的复刻或反向工程版本，而是一款**独立设计、模型无关**的通用智能体工具。其架构汲取业界终端 Agent 工具的优秀设计思想（ReAct 循环、分层记忆、纵深防御、多 Agent 编排），但实现完全独立，不引用任何特定厂商的专有协议、专有认证或专有内部代号。

### 1.3 核心价值主张

四条核心价值，每条对应可验证的架构决策：

1. **REPL 优先 (REPL First)**：所有交互以终端 UI 为主形态，headless / SDK / IDE 协议 / Remote 为同构派生模式。用户在终端内完成代码生成、多 Agent 协作、安全审计、远程开发全部工作，无需切换到 Web IDE。派生模式共享同一套 ReAct 循环、权限链、记忆引擎，不存在"CLI 版功能阉割"。

2. **多后端中立 (Backend Neutral)**：harness 不绑定任何 LLM 供应商。通过标准 `LLMProvider` 接口，支持 OpenAI、AWS Bedrock、Azure OpenAI、Google Vertex AI、Ollama、任何兼容 OpenAI Function Calling 的第三方模型（DeepSeek、Qwen、GLM、Grok、本地 vLLM 等）。模型切换不改 harness 行为，工具调用、权限、记忆、编排逻辑模型无关。用户按成本/合规/性能自由切换。

3. **多 Agent 编排内建 (Multi-Agent Native)**：从单条 query 到 Fork、Async Subagent、Coordinator Worker、Swarm Teammate、Remote Agent，共享同一套 task/mailbox/sidechain 基础设施。用户按任务复杂度选择协作模式——单 Agent / 后台任务 / 并行 fork / 主从编排 / 对等团队 / 远程委托，范式统一、原语可组合。

4. **权限即边界 (Permission as Boundary)**：模型能力受**五层纵深防御链**约束——System Prompt → 权限规则 → OS 沙箱 → Plan Mode → Hooks/预算。工具调用先过权限、再过沙箱、再过 Plan、最后过 Hooks/预算，任一层可独立拦截。用户按风险容忍度选择权限模式（default / acceptEdits / plan / bypassPermissions / auto / dontAsk）。Auto Mode 由独立的 Risk Classifier 决策，分类器失败必降级为 ask，永不臆造批准。

> check list §7.1 期望"3 条"价值主张，本 PRD 实际是 4 条——本 PRD 以 4 条为准（已与产品确认，价值主张不可合并）。checklist 在下次 review 时同步更新。

---

## 2. 目标用户与场景 (Target Users & Scenarios)

### 2.1 目标用户群体

> [M0 冻结决策 A1 更新] Risk Classifier 阈值选"严格档"（漏报≤3%），表明目标用户含强合规场景，安全工程师占比从 12% 提升至 18%，新增"金融/政府合规工程师"细分。

| 群体 | 占比预估 | 核心诉求 |
|------|---------|---------|
| 后端/全栈工程师 | 33% | 代码生成、跨文件重构、调试、测试编写 |
| DevOps/SRE | 17% | 脚本编写、CI 配置、IaC、长任务后台执行 |
| 前端工程师 | 14% | 组件生成、UI 调试、按项目规范生成代码 |
| 安全工程师（含金融/政府合规工程师） | 18% | 代码审计、漏洞分析、沙箱测试、命令审计、合规开发 |
| 数据工程师/AI 工程师 | 10% | 数据管道、SQL/Notebook 编辑、模型评估 |
| 远程/跨地区协作团队 | 5% | SSH 终端开发、自托管部署、多 Agent 协作 |
| 学习者/研究者 | 3% | 代码学习、项目脚手架、多模型对比 |

**安全工程师细分**：金融/政府/医疗合规工程师是 Risk Classifier 严格档的核心用户基础，诉求包括全公司数据不出内网（自托管 Remote Server + 本地 Ollama）、所有 Bash 调用可审计、沙箱隔离、Auto Mode 漏报率严控。

### 2.2 核心使用场景

| 场景 | 描述 | 关键能力 |
|------|------|---------|
| 单文件修改 | "把这个函数改成异步" | FileEdit + 系统提示工程 + diff 审批 |
| 跨文件重构 | "把所有 .forEach 改成 for...of" | Glob + Grep + 多轮 Edit |
| 代码探索 | "这个模块是干什么的" | Explore subagent + 文件历史 |
| Bug 调查 | "为什么测试失败了" | Bash + 测试运行 + 日志分析 |
| 长任务后台 | "跑完整测试套件并修复所有失败" | Async subagent + task notification |
| 多 Agent 协作 | "前端和后端同时改造" | Swarm Team + worktree 隔离 + mailbox |
| 远程协作 | "在 dev 机器上跑构建" | SSH Remote + Remote agent |
| 自定义工作流 | "每次提交前自动跑 lint" | Hooks + Skills + Task Scheduler |
| 跨模型对比 | "用 GPT-4 和本地 Llama 都跑一遍" | 多 LLMProvider 切换 + 历史快照 |
| 合规开发 | "全公司数据不能出内网" | 自托管 Remote Server + 本地 Ollama |
| 安全审计 | "审计所有 Bash 调用" | PreToolUse Hook + audit log + sandbox |
| IDE 集成 | "在 VS Code 里调用 Agent" | IDE Agent Protocol 接入 |

---

## 3. 核心架构设计 (Core Architecture)

### 3.1 整体架构图描述

OmniAgent CLI 采用**四层解耦架构**，自上而下依次为 UI 层、Agent Harness 层、LLM 抽象层、工具层。各层之间通过明确契约通信，可独立替换。

```
┌────────────────────────────────────────────────────────────────────┐
│  UI 层 (Terminal UI / Headless / IDE Protocol / Remote)            │
│  - React + Ink 终端渲染（60fps，五态显示规范）                       │
│  - Headless SDK（无 UI，脚本化调用）                                 │
│  - IDE Agent Protocol（VS Code / JetBrains 接入）                   │
│  - Remote Client/Server（SSH 远程会话）                             │
└────────────┬───────────────────────────────────────────────────────┘
             │ 统一消息协议（messages[] + tool_calls + permissions）
┌────────────▼───────────────────────────────────────────────────────┐
│  Agent Harness 层（模型无关的核心中间件）                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ ReAct    │ │ Permission│ │ Memory   │ │ Multi-   │ │ Hooks &  │ │
│  │ Loop     │ │ Engine   │ │ Engine   │ │ Agent    │ │ Skills   │ │
│  │ (状态机) │ │ (5 层纵深)│ │ (分层+压缩)│ │ Router   │ │ (扩展点) │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│  │ Cost     │ │ Persistence│ │ Task    │ │ Risk     │               │
│  │ Tracker  │ │ (JSONL+  │ │ Scheduler│ │Classifier│               │
│  │          │ │ sidechain)│ │ (定时)  │ │ (Auto)   │               │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘               │
└────────────┬───────────────────────────────────────────────────────┘
             │ LLMProvider 标准接口（chat/complete + tool_calls + stream）
┌────────────▼───────────────────────────────────────────────────────┐
│  LLM 抽象层 (Model Backend Layer)                                  │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐      │
│  │ OpenAI  │ │ Bedrock │ │ Azure   │ │ Vertex  │ │ Ollama  │      │
│  │Provider │ │Provider │ │Provider │ │Provider │ │Provider │      │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ OpenAI-Compatible Provider（DeepSeek/Qwen/GLM/Grok/vLLM 等） │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  流适配器（Stream Adapter）：各家协议 → 统一内部消息格式             │
└────────────┬───────────────────────────────────────────────────────┘
             │ 工具调用（JSON Schema 标准化 / MCP 协议）
┌────────────▼───────────────────────────────────────────────────────┐
│  工具层 (Tool Layer)                                               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐      │
│  │ File    │ │ Shell   │ │ Search  │ │ Web     │ │ Agent   │      │
│  │ Tools   │ │ Tools   │ │ Tools   │ │ Tools   │ │ Router  │      │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘      │
│  ┌─────────┐ ┌─────────┐ ┌─────────────────────────────────────┐  │
│  │ Plan    │ │ System  │ │ MCP Tools（外部进程，7 种传输层）      │  │
│  │ Tools   │ │ Tools   │ │                                     │  │
│  └─────────┘ └─────────┘ └─────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

**关键解耦原则**：
- UI 层只与 Harness 层通信，不直接接触 LLM 或工具；
- Harness 层通过 `LLMProvider` 接口调用任意模型后端，harness 代码不出现任何供应商专有名词；
- 工具层通过 JSON Schema 标准化工具定义，通过 MCP 协议接入外部进程；
- 任意层可独立替换：UI 可换（终端/IDE/Web）、模型可换（云/本地）、工具可换（内置/自定义/MCP）。

### 3.2 模型抽象层设计

> 本节为架构总览。详细产品方案见模块 PRD [`omniagent-prd-mod-01-model-abstraction.md`](./omniagent-prd-mod-01-model-abstraction.md)（M1 模型抽象层）。

模型抽象层通过标准 `LLMProvider` 接口抽象所有模型后端（OpenAI / Bedrock / Azure / Vertex / Ollama / OpenAI 兼容协议），harness 代码不出现任何供应商专有名词。核心要素：

- **`LLMProvider` 接口**：`chatStream()` / `chat()` / `countTokens()` / `estimateCost()` + `capabilities` 能力声明（含 `supportsRiskClassification` 标记，决策 A2）
- **流适配器（Stream Adapter）**：各家 SSE/EventStream 协议 → 统一内部消息格式（`role` / `content` / `tool_use` / `tool_result` / `stop_reason`）
- **认证标准化**：API Key + OAuth 2.0 两类标准流程，不依赖专有认证
- **模型降级**：同 provider 内 `fallbackModel` 自动降级（v1.0，决策 C1），跨 provider chain 延后到 M2 里程碑

v1.0 支持 3 个 provider（OpenAI / Bedrock / Ollama，覆盖云/合规/本地三大场景），M2-M4 补全 Azure / Vertex / OpenAI 兼容协议。

### 3.3 核心循环机制（ReAct Loop 状态机）

> 本节为架构总览。详细产品方案见模块 PRD [`omniagent-prd-mod-02-core-loop.md`](./omniagent-prd-mod-02-core-loop.md)（M2 核心循环引擎）。

ReAct Loop 是 harness 的心脏，定义为**有限状态机（FSM）**：IDLE → BUILD_CONTEXT → CALL_LLM → STREAM_RENDER → EVAL_STOP_REASON → TOOL_EXECUTE / PTL_DEGRADE → END_TURN。核心要素：

- **10+ 种终止条件处理**（end_turn / tool_use / max_tokens / ptl / user_interrupt / stall / 5xx / 429 / tool_error / budget_exceeded）
- **模型降级 5 步**（同 provider 内 fallback，最多重试 1 次，决策 C1）
- **流式 stall 检测**（被动 30s + 主动 90s，触发切非流式降级）
- **tool_use/tool_result 配对完整性**（`adjustIndexToPreserveAPIInvariants()` 守护，不变量 #3）
- **abort 信号传播**（用户中断时不留僵尸进程）

PTL 紧急降级三步（collapse_drain → reactive_compact → error）委托 M7 上下文与记忆引擎执行。

---

## 4. 功能模块详述 (Functional Modules)

> 本总体 PRD 仅提供模块索引。各模块的详细产品方案见对应模块 PRD，每份模块 PRD 自洽可独立交付，包含模块概述/设计目标/核心概念/功能详述/模块交互/模块级 NFR/模块级不变量/开放问题 8 节。

### 4.1 模块索引表

| 模块 ID | 模块名 | 范围 | 主负责角色 | PRD 链接 | 阻塞里程碑 |
|---------|--------|------|-----------|---------|-----------|
| M1 | 模型抽象层 | LLMProvider 接口、能力声明、流适配器、认证、fallback | 架构师 | [`mod-01`](./omniagent-prd-mod-01-model-abstraction.md) | M1 |
| M2 | 核心循环引擎 | ReAct Loop 状态机、终止条件、降级、stall 检测 | 架构师 | [`mod-02`](./omniagent-prd-mod-02-core-loop.md) | M1 |
| M3 | 通用工具系统 | Tool 接口、60+ 内置工具、Bash 24 项校验、工具池隔离 | 工具组 | [`mod-03`](./omniagent-prd-mod-03-tools.md) | M1 |
| M4 | 权限与拦截系统 | 五层纵深防御、权限规则、Risk Classifier、Hooks、沙箱 | 安全工程师 | [`mod-04`](./omniagent-prd-mod-04-permission.md) | M3 |
| M5 | 多 Agent 编排引擎 | agent_router 5 路径、Coordinator/Swarm/Fork/Remote、Task 双轨、Mailbox | 架构师 | [`mod-05`](./omniagent-prd-mod-05-orchestration.md) | M2 |
| M6 | Skills 插件系统 | Skill 定义、5 来源、16 字段 frontmatter、双模式、热插拔 | 工具组 | [`mod-06`](./omniagent-prd-mod-06-skills.md) | M4 |
| M7 | 上下文与记忆引擎 | 分层记忆、findRelevantMemories、三阶段 SystemPrompt、三层压缩、PTL 降级、持久化 | 上下文工程组 | [`mod-07`](./omniagent-prd-mod-07-context-memory.md) | M1 |

### 4.2 模块间依赖关系

```
M1 模型抽象层 ─┬─→ M2 核心循环引擎 ─┬─→ M3 通用工具系统
               │                    ├─→ M5 多 Agent 编排引擎
               │                    └─→ M7 上下文与记忆引擎
               └─→ M4 权限与拦截系统（Risk Classifier thinking 阶段查询 supportsRiskClassification）
M6 Skills 插件系统 ──依赖──→ M3（工具池接入）+ M4（沙箱保护）+ M5（fork 模式）+ M7（sidechain）
```

- M1 是所有模块的基础（提供 LLMProvider 接口）
- M2 核心循环引擎是 harness 心脏，调用 M1/M3/M4/M5/M7
- M4 权限与拦截系统在 M2 TOOL_EXECUTE 状态拦截所有工具调用
- M3 通用工具系统提供工具接口，被 M2/M5/M6 调用
- M5 多 Agent 编排引擎的子 agent 通过 M2 ReAct Loop 运行
- M6 Skills 插件系统依赖 M3/M4/M5/M7
- M7 上下文与记忆引擎为 M2/M5 提供持久化与压缩

**关键路径**（最长依赖链，澄清 K13）：M1 → M7 → M2 → M5 → M6（5 节点）。含义：M6 Skills 上线必须先有 M5 编排 + M2 循环 + M7 持久化 + M1 模型抽象。任一节点延期则 M6 延期。M3 与 M4 不在关键路径上（M3 可与 M7 并行，M4 可与 M5 并行）。M1 是绝对前置（所有模块依赖）。

### 4.3 模块级不变量与 NFR 分配

附录 A 18 项不变量与 §5 NFR 指标已按模块职责分配到各模块 PRD 的 §6（模块级 NFR）与 §7（模块级不变量）节：

| 模块 | 守护的不变量 # | 相关 NFR |
|------|--------------|---------|
| M1 模型抽象层 | #17, #18 | TTFT, cache 命中率, stall 率, fallback 成功率 |
| M2 核心循环引擎 | #3 | TTFT, stall 率, PTL 降级成功率 |
| M3 通用工具系统 | #4, #15 | 工具调用延迟, Tools 注册失败率, 危险命令黑名单覆盖 |
| M4 权限与拦截系统 | #8, #9, #10, #13, #14 | 全部安全 NFR, Risk Classifier FN/FP, 沙箱逃逸拦截 |
| M5 多 Agent 编排引擎 | #1, #2, #4, #5, #6, #7 | mailbox 写延迟, mailbox 丢失率, resume 成功率 |
| M6 Skills 插件系统 | #10（关联）, #5（关联） | Skills 目录防注入, 热加载延迟 |
| M7 上下文与记忆引擎 | #3, #11, #12, #16 | cache 命中率, transcript 写延迟, resume 成功率, recall@5/precision@5 |

跨模块不变量（如 #3 tool_use/result 配对由 M2+M7 联合守护，#16 9 场景错误恢复由 M7 守护但依赖 M5 mailbox/task 持久化）在相关模块 PRD 的 §7 节标注关联关系。

### 4.4 评测集归属

| 评测集 | 归属模块 | 验收指标 | 阻塞里程碑 | 当前状态 |
|--------|---------|---------|-----------|---------|
| `omniagent-eval/risk-classifier/`（119 条标注 bash） | M4 权限与拦截系统 | 漏报≤3% / 误报≤15%（严格档） | M3 启动前 | AI 种子完成（119 条），待人工校验冻结 |
| `omniagent-eval/memory-recall/`（30 条标注会话） | M7 上下文与记忆引擎 | recall@5≥0.8 / precision@5≥0.7 | M1 启动前 | AI 种子完成（30 条），待人工校验冻结 |

> 评测集状态说明（澄清 K12）：本表中"AI 种子完成，待人工校验冻结"是当前真实状态——AI 生成了种子样本，但尚未经过人工校验签字冻结，**不能视为"已就绪"**。M1/M3 启动前的人工校验冻结是 P0 前置门槛，未冻结则不能开工。

### 4.5 接口契约版本兼容策略

**版本兼容策略**（澄清 K10）：所有跨模块函数/事件/数据结构的接口契约遵循 semver 规则：

| 变更类型 | 规则 | 流程 |
|---------|------|------|
| Patch（补丁） | 新增可选字段 / 修复 bug 不改语义 | 模块负责人自决，记录在 changelog |
| Minor（次版本） | 新增可选参数 / 新增事件类型 / 新增返回字段 | 模块负责人评审，需通知所有调用方模块 |
| Major（主版本） | 删除字段 / 修改字段类型 / 修改语义 / 修改必填性 | 架构师评审 + 所有调用方模块签字 + 双向兼容期 ≥ 1 个里程碑 |

- v1.0 锁定期间的接口契约变更默认 Patch/Minor，Major 变更需走"解冻流程"（见 `omniagent-prd-decisions.md` §四）。
- 跨模块函数签名（如 `mergeAndFilterTools`/`shouldAutoCompact`/`agent_router`/`adjustIndexToPreserveAPIInvariants`/`writeMailboxAtomic`）的版本号在函数注释中标注（如 `@since 1.0.0` / `@changed 1.1.0`）。
- 事件 payload schema 在 `omniagent-prd-mod-04-hook-payloads.md` 中维护版本号（M3 开工前补全）。
- 向后兼容约束：Major 变更时提供双向兼容期（旧契约仍可用，但标记 deprecated），至少 1 个里程碑后才可移除。

---

## 5. 非功能性需求 (Non-Functional Requirements)

> 本节为跨模块 NFR 总表。各模块 PRD 的 §6 节抽取与本模块相关的 NFR 并明确指标值。

### 5.1 安全性设计

#### 5.1.1 沙箱机制

> [M0 冻结决策 B1 + B2 更新] Windows 平台 NAPI 不支持，沙箱用纯权限规则 + 推荐 WSL。Windows 沙箱逃逸拦截率不设目标（无沙箱）。

| 平台 | 沙箱技术 | 覆盖范围 | 说明 |
|------|---------|---------|------|
| macOS | `sandbox-exec` | 文件系统 + 网络 + 进程 | 原生支持，CI 矩阵覆盖 |
| Linux | `bubblewrap` | 文件系统 + 网络 + 进程 | 原生支持，CI 矩阵覆盖 |
| Windows | 纯权限规则（推荐 WSL） | 仅权限层 | 无原生沙箱，推荐 WSL2 + bubblewrap 获得沙箱能力 |

**沙箱启用时 Bash 自动 allow**，但 4 类 deny 路径仍生效：
1. `.omniagent/settings.json` 防篡改
2. `.omniagent/skills/` 防注入
3. bare git repo 防供应链攻击
4. 系统目录（`/etc`, `/usr`, `/bin`）防破坏

**沙箱不启用的场景**：root 用户、容器内（容器本身已是隔离层），此时降级为纯权限规则，文档明示。

**Windows 用户安全建议**（独立文档章节）：
- 推荐使用 WSL2 + bubblewrap 获得完整沙箱能力
- 不使用 WSL 时，Windows 仅靠纯权限规则 + 24 项 bashSecurity 校验，安全基线弱于 macOS/Linux
- 金融/政府合规场景的用户强烈建议在 WSL2 内运行 OmniAgent CLI

#### 5.1.2 Prompt Injection 防御

四道防线：
1. **AST 解析**：Bash 命令经 shell grammar AST 解析，识别注入模式（管道、子 shell、here-doc）。
2. **工具结果隔离**：工具返回的内容标记为 `tool_result`，不作为 `user`/`assistant` 消息参与下一轮决策，防注入指令被当作用户指令。
3. **Shadow 测试**：定期用红队 prompt injection 测试集验证防御有效性。
4. **文件内容审查**：模型读取外部文件（网页、文档）时，文件内容经过审查层，识别并标记可疑指令。

#### 5.1.3 命令审计

- 所有 Bash 调用经 `PreToolUse` Hook 可写审计日志。
- 审计日志含：时间戳、命令、cwd、user、permission decision、exit code。
- 审计日志写入失败不影响主流程（磁盘满/权限），监控系统上报。
- 支持 `--audit-log <path>` 全局开关。

#### 5.1.4 安全 NFR 指标

| NFR | 目标值 |
|-----|-------|
| Prompt injection 越权执行次数 | 0 |
| 沙箱逃逸尝试拦截率（macOS/Linux） | 100% |
| bare git repo 攻击拦截率 | 100% |
| 4 类 deny 路径触发率 | 100% deny |
| 危险命令黑名单覆盖 | 24 项 + Zsh 13 命令 |
| DenialTracking 死循环 | maxConsecutive=3 / maxTotal=20 |
| Settings 文件防篡改 | 100%（沙箱 deny） |
| Skills 目录防注入 | 100%（沙箱 deny + Safe Properties 30 白名单） |
| MCP 工具描述截断 | 2048 字符 |
| Windows 沙箱逃逸拦截率 | 不设目标（无沙箱，纯权限规则） |
| Risk Classifier 漏报率 | ≤ 3%（严格档） |
| Risk Classifier 误报率 | ≤ 15%（严格档） |

### 5.2 性能指标

#### 5.2.1 启动与运行时性能

| 指标 | 目标值 | 测量方式 |
|------|-------|---------|
| `--version` RSS | ≤ 50MB | `ps -o rss` |
| 完整加载 RSS | ≤ 500MB | 同上 |
| 冷启动延迟（无 fast-path） | ≤ 500ms | `time omniagent --version` |
| TTFT（首 token） | ≤ 2s | LLMProvider 埋点 |
| Prompt cache 命中率 | ≥ 80% | cache_read / input_tokens |
| 流式 stall 率 | ≤ 1% | stall_count / total_streams |
| 工具调用平均延迟（除 Bash/Web） | ≤ 1s | tool.call() 埋点 |
| Mailbox 写延迟 P99 | ≤ 50ms | writeMailboxAtomic 埋点 |
| Session transcript 写延迟 P99 | ≤ 100ms | drainWriteQueue 埋点 |
| 大文件（10MB JSONL）读取 | ≤ 2s | walkChainBeforeParse 埋点 |
| 终端 UI 响应延迟 | ≤ 16ms（60fps） | React render 埋点 |
| 权限弹窗响应延迟 | ≤ 100ms | UI 埋点 |
| Risk Classifier Fast 阶段延迟 | ≤ 100ms | 规则表执行埋点 |
| Risk Classifier Thinking 阶段延迟 | ≤ 1s | LLM 调用埋点 |
| findRelevantMemories 召回延迟 | ≤ 2s | LLM 调用埋点 |

#### 5.2.2 可靠性指标

| NFR | 目标值 | 测量方式 |
|-----|-------|---------|
| 进程崩溃后 resume 成功率 | ≥ 95% | M7 9 场景错误恢复矩阵测试覆盖率 + 实测 resume 成功次数 / 总崩溃次数 |
| mailbox 消息丢失率 | 0% | writeMailboxAtomic 写入/读取对账（写入条数 == 读取条数） |
| 持续运行 24h 内存泄漏 | ≤ 100MB | `ps -o rss` 24h 间隔采样差值 |
| API 5xx 重试成功率（含 fallback model 降级） | ≥ 95% | M2 降级 5 步执行后请求成功次数 / 5xx 总次数 |
| PTL 紧急降级成功率 | 100% | M7 PTL 注入测试中三步走完且恢复的比例 |
| autocompact 连续失败 circuit breaker | 3 次触发 | M7 circuit breaker 触发次数 / autocompact 失败次数（应 = 1，即每 3 次失败必触发熔断） |
| Tools 注册失败率 | 0% | M3 启动期工具加载失败次数 / 总工具数 |
| Risk Classifier 调用失败降级率 | 100%（失败必降级为 ask，不臆造批准） | M4 Risk Classifier 故障注入测试中降级为 ask 的次数 / 故障总次数 |

#### 5.2.3 护栏指标（防局部赢全局输）

| 护栏 | 目标值 | 为什么是护栏 | 告警阈值 | 处置策略 |
|------|-------|------------|---------|---------|
| 权限拒绝率 | ≤ 5% | 拒率飙升 = Auto Mode 在乱批 | > 5% 持续 1h | 触发 Risk Classifier 复评 + 告警用户检查 Auto Mode 配置 |
| autocompact 连续失败 | ≤ 3 次 | 连续失败 = PTL 风险 | ≥ 3 次 | circuit breaker 熔断，转为 error 路径，提示用户手动 `/compact` |
| mailbox 消息丢失率 | = 0 | 丢失 = 协作失败 | > 0（任意 1 条） | 立即告警 + 触发 9 场景恢复矩阵场景 4（mailbox 损坏恢复） |
| 流式 stall 率 | ≤ 1% | stall = 用户感知卡顿 | > 1% 持续 1h | 触发主动 stall 检测阈值下调（90s → 60s）+ 告警 LLM provider 状态 |
| Risk Classifier 漏报率 | ≤ 3% | 漏报 = 越权执行（严格档护栏） | > 3% | 立即降级 Auto Mode 为 default ask + 触发 Risk Classifier 评测集复审 |
| Risk Classifier 成本漂移 | 单次 ≤ $0.001 | 高频调用成本失控 | > $0.001 持续 24h | 告警 + 触发 Risk Classifier provider 切换（更换为更便宜的轻量级 LLM） |

### 5.2.4 NFR 依赖关系

**NFR 跨模块依赖**（澄清 N20）：单个 NFR 的达成通常依赖多模块协同，关键依赖关系如下：

| NFR | 直接责任模块 | 依赖模块 | 依赖说明 |
|-----|------------|---------|---------|
| Prompt cache 命中率 ≥ 80% | M7（STATIC_DYNAMIC_BOUNDARY 切分） | M1（provider 支持 prompt cache）+ M5（fork agent prefix byte-identical） | 三者共同保障：M7 切静态前缀 + M1 provider cache + M5 fork 不破坏 prefix |
| 进程崩溃后 resume 成功率 ≥ 95% | M7（持久化与恢复） | M5（mailbox/task 持久化）+ M1（fallback model 续跑） | M7 主导，M5 mailbox 不丢 + M1 LLM 续跑 |
| PTL 紧急降级成功率 100% | M7（三步降级） | M2（识别 ptl stop_reason）+ M1（API 摘要 LLM 可用） | M2 识别后委托 M7，M7 调 M1 做摘要 |
| mailbox 消息丢失率 = 0 | M5（mailbox 逻辑） | M7（原子写原语 drainWriteQueue） | M5 调用 M7 提供的 writeMailboxAtomic |
| 4 类 deny 路径触发率 100% | M4（沙箱 deny） | M3（24 项 bashSecurity 校验，沙箱降级时兜底） | 沙箱降级场景 M3 兜底 |
| Risk Classifier 漏报率 ≤ 3% | M4（分类器） | M1（supportsRiskClassification provider）+ M3（24 项规则表） | M4 调 M1 provider + M3 规则表作为 fast 阶段来源 |

### 5.3 可扩展性与生态兼容

#### 5.3.1 MCP 协议兼容

OmniAgent CLI 完全兼容 Model Context Protocol（MCP），支持 7 种传输层：

| 传输层 | 用途 |
|--------|------|
| `stdio` | 本地子进程，最常用 |
| `sse` | Server-Sent Events，单向流 |
| `http` | 标准 HTTP，无状态 |
| `sse-ide` | IDE 集成的 SSE |
| `ws-ide` | IDE 集成的 WebSocket |
| `ws` | 标准 WebSocket，双向 |
| `in-process` | 内置 MCP，零开销（linked pair） |

**MCP 工具描述超 2048 字符自动截断**，防止单个工具描述撑爆上下文。

**In-Process Transport**：内置 MCP server（如内置工具）通过 linked pair 零开销接入，不 spawn 子进程。

#### 5.3.2 IDE Agent Protocol 接入

OmniAgent CLI 可作为 agent 接入 IDE（VS Code / JetBrains），通过 WebSocket 协议：
- `session/start`, `session/end`：会话生命周期
- `tool/invoke`：IDE 调用 OmniAgent 工具
- `event/notify`：OmniAgent 通知 IDE 状态变化
- `cancel`：取消进行中的操作

断连自动重连，协议版本不匹配时启动期协商失败，提示升级。

#### 5.3.3 Remote Server（自托管）

提供自托管 Remote Server Docker 镜像（~150MB，多阶段构建），支持团队协作：
- REST API：`/v1/sessions`, `/v1/sessions/{id}/messages`, `/v1/teams`, `/v1/health`
- WebSocket：实时消息推送
- 认证：API Key 或 OAuth 2.0
- 部署：≤ 5 分钟，`docker run -p 8080:8080`

#### 5.3.4 多语言 SDK

> [M0 冻结决策 C3 更新] v1.0 仅发布 TypeScript SDK，Python/Go SDK 延后到 M4 启动前再决协议选型（子进程 vs gRPC），基于 v1.0 用户反馈。

| SDK | 语言 | v1.0 范围 | 协议 |
|-----|------|----------|------|
| `omniagent-sdk-ts` | TypeScript / JavaScript | **v1.0 发布** | 内嵌（同进程） |
| `omniagent-sdk-py` | Python | **延后到 M4** | 待定（子进程 / gRPC） |
| `omniagent-sdk-go` | Go | **延后到 M4** | 待定（子进程 / gRPC） |

TypeScript SDK 共享同一套消息协议，允许 Node.js 生态接入 OmniAgent 能力。Python/Go SDK 的协议选型在 M4 启动前评审，基于 v1.0 用户反馈确定（若用户主要用 Python，倾向子进程协议；若主要用 Go，倾向 gRPC）。

#### 5.3.5 分发渠道

> [M0 冻结决策 B3 + D1 更新] Cloudflare Worker 支持 + Deno Deploy 兜底。npm 包名 `omniagent-cli`，建议同时注册 `omni-agent` 作为保护性占位。

| 渠道 | 命令 / 方式 | 覆盖用户 |
|------|-----------|---------|
| npm | `npm i -g omniagent-cli` | 主流 |
| Homebrew | `brew install omniagent` | macOS |
| Docker | `docker pull omniagent/cli` | 容器化 |
| GitHub Release | 二进制 download | 离线/企业 |
| Cloudflare Worker | 边缘代理（主） | 远程协作 |
| Deno Deploy | 边缘代理（兜底） | Cloudflare 限流时切换 |

**自动更新**：启动检查 npm registry + hash 校验 + atomic rename + 旧版本回滚，失败保留旧版本不破坏运行。

**保护性占位**：建议在 npm 同时注册 `omni-agent`（连字符版本）作为保护性占位，防止抢注，指向 `omniagent-cli`。

#### 5.3.6 国际化与无障碍

- 中英文双语（命令 + 错误信息 + 文档），通过 `locale` 切换。
- 支持 screen reader（终端兼容）。
- 30+ 键盘快捷键，vim 模式可选。

---

## 6. 迁移与演进路线 (Migration & Roadmap)

### 6.1 从 CCB 到新架构的重构步骤

从原 CCB 架构迁移到 OmniAgent CLI 模型无关架构，分 7 步重构：

#### 步骤 1：剥离品牌与术语（1-2 周）

- 全局重命名：`claude-code-best` → `omniagent-cli`，`ccb` → `omniagent` / `oa`。
- 配置文件：`CLAUDE.md` → `AGENT.md`，`.claude/` → `.omniagent/`。
- 内部代号去专有化（已冻结，见附件 A 决策 D2）：

  | 原代号 | 新名称 | 说明 |
  |--------|--------|------|
  | KAIROS | **Task Scheduler** | 定时任务/后台触发系统 |
  | PROACTIVE | **Proactive Planner** | 主动规划模块 |
  | Undercover | **Covert Mode** | 隐身模式 |
  | BUDDY | **Risk Classifier** | 风险分类器（Auto Mode 决策） |
  | ULTRAPLAN | **Workflow Orchestrator** | 多 Agent 工作流编排 |
  | TEAMMEM | **Team Recommender** | 基于 memory 的 teammate 推荐 |
  | Lodestone | **Context Anchor** | 上下文锚点 |
  | yoloClassifier | **Risk Classifier** | 风险分类器（同上） |
  | firstParty | **Direct API Provider** | 直连模型供应商 |

- 环境变量统一规范：`OMNIAGENT_TASK_SCHEDULER` / `OMNIAGENT_RISK_CLASSIFIER` 等（全大写下划线）。

#### 步骤 2：抽象 LLMProvider 接口（2-3 周）

- 定义 `LLMProvider` 标准接口（见模块 PRD M1 §3.1，含 `supportsRiskClassification` 能力字段）。
- 将原 7 个 provider 的专有逻辑封装为流适配器，统一输出内部消息格式。
- 移除所有对单一供应商的硬编码依赖（认证方式、消息格式、工具调用字段）。
- 新增 Ollama provider 支持本地模型，覆盖合规场景。
- 所有 harness 代码不出现任何供应商专有名词。

#### 步骤 3：协议标准化（2-3 周）

- 工具调用全面采用 JSON Schema 标准（inputSchema 字段）。
- 外部工具接入统一通过 MCP 协议（7 种传输层）。
- 认证统一为 API Key 或 OAuth 2.0 标准，移除专有认证流程。
- IDE 接入协议更名为 IDE Agent Protocol，基于 WebSocket 标准化。

#### 步骤 4：Harness 与 Agent 解耦（2-3 周）

- ReAct 循环、权限引擎、记忆引擎、多 Agent 编排引擎全部抽象为模型无关的中间件。
- 验证：用同一套 harness 代码，切换不同 LLMProvider，行为一致。
- 所有模型特定的行为（如 prompt cache、token 计数精度）通过 `capabilities` 字段声明，harness 据此适配。

#### 步骤 5：配置与文档迁移（1-2 周）

- 所有文档、Wiki、AGENT.md 品牌词替换。
- 环境变量重命名：所有专有前缀 → `OMNIAGENT_*` 或通用名（如 `LLM_API_KEY`）。
- 配置文件 schema 文档化，提供迁移指南。

#### 步骤 6：测试与验证（2-3 周）

- 多 provider 端到端测试：OpenAI / Bedrock / Azure / Vertex / Ollama / OpenAI 兼容（DeepSeek/Qwen/GLM）全部跑通。
- 行为一致性测试：同一任务在不同 provider 下行为一致（工具调用、权限、记忆）。
- 安全测试：红队 prompt injection 测试，五层防御链验证。
- 性能测试：启动速度、TTFT、cache 命中率达标。

#### 步骤 7：生态开源化（1-2 周）

- 许可证切换：明确开源协议（Apache 2.0）。
- 贡献指南、行为准则、Roadmap 公开。
- 文档网站、API 参考、快速上手指南发布。
- 社区接入：Discord / GitHub Discussions。

### 6.2 阶段性里程碑规划

#### M0：架构草案与设计冻结（2 周）— **已完成**

> [M0 冻结] 本里程碑已完成，10 项未决问题决策见附件 A（`omniagent-prd-decisions.md`）。本 PRD 与 7 份模块 PRD 已按冻结决策更新。

- 本 PRD 评审通过，设计冻结。
- 关键不变量清单（18 项）确立。
- 10 项未决问题已冻结（见附件 A）。
- 7 份模块 PRD 已拆解完成（M1-M7）。

#### M1：Walking Skeleton（4-6 周，2-3 个迭代）

**目标**：最小可运行版本，验证架构可行性。

**范围**：
- 3 个 LLMProvider（OpenAI / Bedrock / Ollama，覆盖云 / 合规 / 本地三大场景）—— 模块 PRD M1
- 2 条 Agent 路由（sync / async，覆盖单 Agent + 后台任务）—— 模块 PRD M5
- 4 种 PermissionMode（default / acceptEdits / plan / bypassPermissions）—— 模块 PRD M4
- 持久化 resume（JSONL + sidechain）—— 模块 PRD M7
- npm + Homebrew 分发
- TypeScript SDK（v1.0 仅此一个，Python/Go 延后到 M4）

**涉及模块**：M1 模型抽象层 + M2 核心循环引擎 + M3 通用工具系统（核心工具）+ M7 上下文与记忆引擎（findRelevantMemories + 持久化）

**前置依赖**：findRelevantMemories 评测集就绪（≥30 条标注会话，AI 种子完成 30 条，待人工校验冻结，**人工校验前不视为"已就绪"**）。

**验收**：`omniagent` 启动 → 输入"加一个函数" → FileEdit 完成 → diff 审批 → 写入文件 → resume 后状态恢复。

#### M2：多 Agent 协作（6-8 周，3-4 个迭代）

**目标**：多 Agent 编排能力上线。

**范围**：
- 3 条 Agent 路由（fork / teammate / remote）—— 模块 PRD M5
- Coordinator Mode + Swarm Team
- mailbox + task files
- Docker 分发（含 Remote Server）
- 跨 provider fallback chain（C1 决策延后到此里程碑补）—— 模块 PRD M1

**涉及模块**：M5 多 Agent 编排引擎（主）+ M1 模型抽象层（跨 provider fallback）+ M7 上下文与记忆引擎（sidechain + mailbox 持久化）

**前置依赖**：M1 完成 + mailbox 文件锁方案就绪（退避 + 原子写验证）。

**验收**：`/team create` → spawn 前端 + 后端 teammate → 各自 worktree 工作 → mailbox 同步 → shutdown 四步握手。

#### M3：安全纵深（4-6 周，2-3 个迭代）

**目标**：五层纵深防御链完整上线，Auto Mode 灰度。

**范围**：
- auto PermissionMode + Risk Classifier 上线（严格档：漏报≤3% / 误报≤15%）—— 模块 PRD M4
- 规则表（fast）+ 云端轻量级 LLM（thinking）两阶段决策
- Hooks 27 事件完整支持（function 类型 v1.0 仅内置）
- sandbox-exec (macOS) + bubblewrap (Linux) CI 矩阵
- Prompt injection 红队测试

**涉及模块**：M4 权限与拦截系统（主）+ M1 模型抽象层（Risk Classifier provider 选型）+ M3 通用工具系统（Bash 24 项校验规则表）

**前置依赖**：
- Risk Classifier 评测集就绪（**≥ 100 条**标注 bash 命令，AI 种子完成 119 条，覆盖 24 项 bashSecurity 类别 + 金融/政府合规相关命令模式，待人工校验冻结，**人工校验前不视为"已就绪"**）
- Risk Classifier 规则表就绪（24 项 bashSecurity 映射）
- Risk Classifier provider 选型确认（基于 `supportsRiskClassification` 标记，确定具体用哪个云端轻量级 LLM）
- sandbox-exec CI 矩阵就绪（macOS 版本覆盖）

**验收**：Auto Mode 漏报率 ≤ 3% / 误报率 ≤ 15%；五层防御链下无越权执行。

#### M4：扩展生态（4-6 周，2-3 个迭代）

**目标**：MCP / Skills / Custom Agents 生态完整。

**范围**：
- MCP 7 传输层完整支持
- Skills 5 来源 + 16 frontmatter 字段—— 模块 PRD M6
- Custom Agents（`.omniagent/agents/*.md`）
- Cloudflare Worker + Deno Deploy 双边缘代理
- Python/Go SDK 协议选型与开发启动

**涉及模块**：M6 Skills 插件系统（主）+ M3 通用工具系统（MCP 接入）+ M5 多 Agent 编排引擎（Custom Agents）

**前置依赖**：M2 完成 + MCP spec 版本协商方案就绪。

**验收**：用户能在 ≤ 30 分钟内添加新工具 / LLMProvider / Skill / 命令。

#### M5：GA 候选（2-4 周，1-2 个迭代）

**目标**：全量发布。

**范围**：
- 全部 Must 项交付
- precheck 100% 通过
- verification agent 4 轮全 PASS
- 4 轮内部 dogfood

**前置依赖**：M1-M4 完成 + 4 轮内部 dogfood 通过。

**验收**：
- 北极星指标（周均有效编程会话数）基线建立
- 4 条护栏全绿（权限拒绝率 / autocompact 连续失败 / mailbox 丢失率 / 流式 stall 率）
- Risk Classifier 严格档护栏全绿（漏报率 ≤ 3% / 成本漂移 ≤ $0.001/次）
- 18 项关键不变量 100% 满足
- 9 场景错误恢复矩阵全部通过
- 7 provider 端到端测试全部通过
- 5 条 AgentTool 路由各跑 24h 稳定性测试无崩溃

#### M6+：长期演进

- **v2.x**：Computer Use（桌面自动化）、Voice Mode（Whisper 本地模型）、Workflow Scripts 增强、Risk Classifier 本地小模型（合规场景）、findRelevantMemories 本地 embedding（合规场景）、跨 provider fallback chain、Python/Go SDK、用户自定义 function hook 签名机制、Skills 签名校验、Skills 市场、Skills 与 Custom Agents 合并、Workflow Scripts 增强、Remote Agent 多区域路由。
- **v3.x**：插件与技能市场（v2.x Skills 市场演进）、签名校验（v2.x Skills 签名演进）、多模态输入（图片/视频）、Team Recommender 默认启用、Context Anchor 默认启用。
- **v4.x**：Autofix-PR 生产化、企业 SSO 集成（企业版）、Windows NAPI 支持评估。

> v2.x/v3.x 分类统一（澄清 K11）：Team Recommender 与 Context Anchor 默认启用列在 v3.x（与 mod-05 §8.5 / mod-07 §8.5 对齐，**两个模块 PRD 已统一为 v3.x**）。Skills 签名校验/市场/合并列在 v2.x（与 mod-06 §8.4 对齐）。Workflow Scripts 增强与 Remote Agent 多区域路由列在 v2.x（与 mod-05 §8.4 对齐）。

---

## 附录 A：关键不变量清单（18 项）

> 本附录与 `omniagent-prd-decisions.md`（M0 评审冻结记录）互为补充。不变量是架构正确性的硬约束，决策是产品方向的选择。两者共同构成 M1-M5 开工的前置门槛。
> 18 项不变量已按模块职责分配到各模块 PRD 的 §7 节（模块级不变量），本附录为跨模块总表。

以下不变量是架构正确性的硬约束，任何变更必须经架构师评审：

| # | 不变量 | 验证方式 | 守护模块 |
|---|--------|---------|---------|
| 1 | worktree 唯一归属（一个 worktree 同时只属于一个 teammate） | roster 校验 | M5 |
| 2 | teammate 按 name 寻址（不是 agentId） | SendMessage 路径校验 | M5 |
| 3 | tool_use/tool_result 配对完整性 | adjustIndexToPreserveAPIInvariants | M2 + M7 |
| 4 | Coordinator 模式下主 Agent 直接工具调用率 = 0 | 工具池硬隔离校验 | M3 + M5 |
| 5 | Fork agent 的 prompt cache prefix byte-identical | 占位 tool_result 校验 | M5 |
| 6 | Shutdown 四步握手（不强杀） | 协议状态机校验 | M5 |
| 7 | mailbox 消息丢失率 = 0 | 写入/读取对账 | M5 |
| 8 | 五层纵深防御链任一层可独立拦截 | 渗透测试 | M4 |
| 9 | 权限规则 8 层优先级严格生效 | 规则冲突测试 | M4 |
| 10 | sandbox 4 类 deny 路径始终生效 | 沙箱日志校验 | M4 |
| 11 | autocompact circuit breaker 3 次触发 | 连续失败测试 | M7 |
| 12 | PTL 紧急降级三步必走完 | PTL 注入测试 | M7 |
| 13 | Risk Classifier 失败必降级为 ask | 故障注入测试 | M4 |
| 14 | DenialTracking maxConsecutive=3 / maxTotal=20 | 死循环测试 | M4 |
| 15 | MCP 工具描述 2048 字符截断 | 长描述测试 | M3 |
| 16 | 9 场景错误恢复矩阵全覆盖 | 场景注入测试 | M7 |
| 17 | harness 代码不含任何供应商专有名词 | grep 检查 | M1 |
| 18 | 同一任务在不同 LLMProvider 下行为一致 | 行为一致性测试 | M1 |

---

## 附录 B：术语表

| 术语 | 说明 |
|------|------|
| OmniAgent CLI | 本项目，通用终端智能体工具 |
| Harness | 模型无关的核心中间件（循环、权限、记忆、编排） |
| LLMProvider | 模型后端的标准接口，支持多供应商 |
| Stream Adapter | 流适配器，将各家协议转为统一内部消息格式 |
| MCP | Model Context Protocol，模型上下文协议（开放标准） |
| IDE Agent Protocol | IDE 接入 OmniAgent 的 WebSocket 协议 |
| Remote Server | 自托管远程控制服务器，支持团队协作 |
| ReAct Loop | 推理-行动循环，harness 的核心状态机 |
| PTL | Prompt Too Long，触发紧急降级 |
| CompactBoundary | 上下文压缩点标记，rewind 时按 boundary 还原 |
| Sidechain | 子 agent 的独立 JSONL transcript |
| Mailbox | teammate 间通信，按 name 寻址 |
| Task Scheduler | 定时任务/后台触发系统（原 KAIROS） |
| Risk Classifier | 风险分类器，Auto Mode 决策（原 yoloClassifier / BUDDY） |
| Workflow Orchestrator | 多 Agent 工作流编排（原 ULTRAPLAN） |
| Context Anchor | 上下文锚点，优化长对话相关性（原 Lodestone） |
| Swarm / Team | 多 teammate 协作，共享 task list + mailbox |
| Coordinator Mode | 主 Agent 只编排不执行，全部 spawn worker |
| Fork Agent | 继承父上下文和工具池的分叉 agent |
| Worktree | 独立 git worktree，文件级隔离 |
| Skills | Prompt + 权限配置 + 工具白名单的声明式封装 |
| Custom Agents | `.omniagent/agents/*.md` 定义的自定义 agent |
| AGENT.md | 项目规范文件（原 CLAUDE.md） |
| Five-Layer Defense | 五层纵深防御链（System Prompt → 权限 → 沙箱 → Plan → Hooks/预算） |
| DenialTracking | 防止权限拒绝死循环的计数器（maxConsecutive=3 / maxTotal=20） |
| TTFT | Time To First Token，首 token 延迟 |
| RSS | Resident Set Size，进程常驻内存 |
| supportsRiskClassification | LLMProvider 能力字段，标识是否适合做 Risk Classifier |

---

## 附录 C：M0 评审冻结决策摘要

> 完整决策记录见 `omniagent-prd-decisions.md`（附件 A）。本附录为摘要，便于快速查阅。
> 12 项决策已按模块职责分配到各模块 PRD 的 §8 节（开放问题与依赖），本附录为跨模块总表。

| # | 问题 | 决策 | 影响章节 | 影响模块 |
|---|------|------|---------|---------|
| A1 | Risk Classifier 误报/漏报阈值 | 严格档：漏报≤3%，误报≤15% | §2.1, §4.2.5, §5.1.4 | M4 |
| A2 | Risk Classifier 决策模型 | 规则表（fast）+ 云端轻量级 LLM（thinking） | §3.2.1, §4.2.5 | M1 + M4 |
| A3 | 实验 feature 默认值 | 全部 off，env 显式启用 | §4.3.5 | M5 |
| A4 | Hooks function 边界 | 仅内置 function（v1.0） | §4.2.6 | M4 |
| B1 | Windows NAPI 支持 | 不支持，沿用 Node 兼容层 | §5.1.1, §6.2 M6+ | M4 |
| B2 | Windows 沙箱方案 | 纯权限规则 + 推荐 WSL | §5.1.1, §5.1.4 | M4 |
| B3 | Cloudflare Worker 边缘代理 | 支持 + Deno Deploy 兜底 | §5.3.5 | 总体（分发） |
| C1 | Fallback model 链策略 | 同 provider 内自动降级（v1.0） | §3.3.2 | M1 + M2 |
| C2 | 记忆召回机制 | 轻量级 LLM 召回 | §4.5.3 | M7 |
| C3 | 多语言 SDK 协议 | v1.0 仅 TypeScript，Python/Go 延后到 M4 | §5.3.4, §6.2 M4 | M1（SDK） |
| D1 | 包名/命令名 | 包名 `omniagent-cli`，命令 `omniagent` | §1.2, §5.3.5 | 总体（定位） |
| D2 | 内部代号重命名映射 | 按 §6.1 步骤 1 的 9 项映射冻结 | §6.1 | 总体（重构） |

---

*本 PRD 为总体产品方案，基于 CCB 逆向 PRD 重构而来，剔除单一供应商耦合，沉淀为通用、开源、模型无关的智能体 CLI 架构。各模块详细产品方案见 7 份模块 PRD（M1-M7）。所有功能需求均可追溯到原 CCB 设计章节，所有非功能需求均有可验证的测量方式。架构设计遵循"模型是 Agent，代码是 Harness"原则，harness 完全模型无关，可接入任意兼容 OpenAI Function Calling 的 LLM 后端。*

*M0 评审已于 2026-07-08 完成，10 项未决问题决策已冻结（见附件 A `omniagent-prd-decisions.md`）。本总体 PRD 与 7 份模块 PRD 已按冻结决策更新。M1-M5 各里程碑的开工前置门槛以本总体 PRD + 模块 PRD + 附件 A 为准。*

*模块化拆解于 2026-07-08 完成：1 份总体 PRD（本文件）+ 7 份模块 PRD（`omniagent-prd-mod-01` 至 `omniagent-prd-mod-07`）。附录 A 18 项不变量与 §5 NFR 指标已按模块职责分配到各模块 PRD 的 §6/§7 节。*
