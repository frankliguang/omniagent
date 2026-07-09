# OmniAgent CLI PRD 拆解后 Review Checklist

> 目的：在 M1 开工前，对模块化拆解后的 10 份文件做人工专家 review，确认拆解质量满足开发指导要求。
> Review 通过后各模块 PRD 进入"已 review 冻结"状态，作为 M1-M5 开发的产品方案基线。
> 创建日期：2026-07-08
> 适用文件：1 份总体 PRD + 7 份模块 PRD + 冻结记录 + 评测集 README（共 10 份）

---

## 1. Review 流程总览

### 1.1 Review 阶段

1. **准备**：分发 10 份文件给各 review 角色，每角色领取本 checklist 中适用部分
2. **自审**：各角色按本 checklist 逐项检查自己负责的模块 PRD，填写 ☑/☐ 与备注
3. **交叉确认**：相关模块的双方对接口契约做交叉对齐（如 M3+M4 对 Risk Classifier 边界）
4. **评审会**：架构师主持，处理争议项与跨模块不一致，形成决议
5. **签字**：各角色在 §9 签字模板上签字，标注"通过/有保留通过/不通过"
6. **冻结**：签字完成后模块 PRD 头部"状态"字段从"M0 已冻结"升级为"已 review 冻结"

### 1.2 签字要求

| 模块 PRD | 必须签字角色 | 交叉确认角色 |
|---------|------------|------------|
| 总体 PRD | 架构师 + 产品 | 全部角色 |
| mod-01 模型抽象层 | 架构师 | 安全工程师（supportsRiskClassification 能力声明） |
| mod-02 核心循环引擎 | 架构师 | 上下文工程组（PTL 降级委托） |
| mod-03 通用工具系统 | 工具组 | 安全工程师（24 项 bashSecurity）+ M5 编排（agent_router 工具接口） |
| mod-04 权限与拦截系统 | 安全工程师 | 架构师（不变量 #8 五层防御）+ 工具组（沙箱叠加 24 项校验之上） |
| mod-05 多 Agent 编排引擎 | 架构师 | 上下文工程组（sidechain 持久化）+ 工具组（agent_router 工具接口） |
| mod-06 Skills 插件系统 | 工具组 | 安全工程师（.omniagent/skills/ 沙箱保护）+ 架构师（fork 模式路由） |
| mod-07 上下文与记忆引擎 | 上下文工程组 | 架构师（PTL 降级委托）+ 工具组（COMPACTABLE_TOOLS 白名单） |
| 冻结记录 | 架构师 | 全部角色 |
| 评测集 README | 架构师 | 安全工程师 + 上下文工程组 |

### 1.3 Review 时长建议

- 自审：每模块 PRD ≤ 2 小时（10 份 × 2 小时 = 单角色最多 20 小时，但实际只审自己负责的几份）
- 交叉确认：每对 ≤ 1 小时（7 对 ≈ 7 小时）
- 评审会：≤ 4 小时（一次性）
- 总计：约 1-2 周日历日完成全部 review

---

## 2. 通用 Checklist（所有角色都要过）

### 2.1 结构完整性

- [ ] 模块 PRD 8 节结构完整：§1 模块概述 / §2 设计目标 / §3 核心概念与接口 / §4 功能详述 / §5 模块交互 / §6 模块级 NFR / §7 模块级不变量 / §8 开放问题与依赖 / §9 参考链接
- [ ] §1 范围（in scope）与边界（out of scope）划分清晰，无职责重叠或真空
- [ ] §1 "在整体架构中的位置"1 段描述与总体 PRD §3.1 一致
- [ ] §2 设计目标 3-5 条，与总体 PRD §1.3 核心价值主张可追溯
- [ ] §3 核心概念与接口对外暴露的 API/契约定义完整（签名、参数、返回值、失败模式）
- [ ] §4 功能详述覆盖原 PRD 对应章节的全部技术内容（无遗漏）
- [ ] §5 与其他模块的交互表覆盖所有依赖关系（调用/事件/共享状态 三类清晰）
- [ ] §6 模块级 NFR 指标值明确且可测量（验收方式有埋点位置或统计口径）
- [ ] §7 模块级不变量每条都有守护机制描述（测试名或校验方式）
- [ ] §8 开放问题与依赖明确列出 4 子节（已冻结决策 / 依赖其他模块交付物 / 评测集引用 / v2.x 演进项）
- [ ] §9 参考链接有效（总体 PRD 章节 / 冻结决策记录 / 相关模块 PRD / 评测集 / 里程碑）

### 2.2 与总体 PRD 一致性

- [ ] 模块 PRD §1"在整体架构中的位置"与总体 PRD §3.1 整体架构图描述一致
- [ ] 模块 PRD §5 与其他模块的交互与总体 PRD §4.2 模块间依赖关系一致（不漏不增）
- [ ] 模块 PRD §6 NFR 指标值与总体 PRD §5 NFR 章节一致或更细（不可放松）
- [ ] 模块 PRD §7 不变量与总体 PRD 附录 A 一致（不漏不增）
- [ ] 模块 PRD §8.1 已冻结决策与附录 C 一致

### 2.3 与冻结决策一致性

- [ ] 模块 PRD §8.1 已冻结决策与 `omniagent-prd-decisions.md` 一致
- [ ] 模块 PRD 正文中决策影响点（如"严格档"/"轻量级 LLM 召回"/"function v1.0 仅内置"等）描述与冻结记录一致
- [ ] v2.x 演进项与冻结记录的 v2.x 路线图一致

### 2.4 品牌中立性

- [ ] 模块 PRD 正文中无供应商专有名词作为结构性依赖
- [ ] 出现的供应商名称（openai/bedrock/claude/deepseek 等）均为示例或历史迁移上下文
- [ ] 接口定义中 provider 字段为字符串枚举，不绑定特定供应商
- [ ] v2.x 演进项不预设特定供应商方案

### 2.5 交叉引用有效性

- [ ] "源章节"字段指向总体 PRD 中存在的章节（或在迁移说明中注明原章节号）
- [ ] §5 与其他模块的交互引用的模块 ID（M1-M7）正确
- [ ] §8.2 依赖其他模块的交付物引用的模块 ID 正确
- [ ] §9 参考链接中模块 PRD 文件名正确（`omniagent-prd-mod-0X-*.md`）
- [ ] §8.3 评测集引用路径正确（`omniagent-eval/<dataset-name>/`）

---

## 3. 架构师 Review Checklist（全部 10 份）

### 3.1 跨模块边界清晰度

- [ ] M1 模型抽象层与 M2 核心循环的接口清晰：LLMProvider 接口由 M1 提供，M2 通过 ReAct Loop 调用
- [ ] M2 核心循环与 M3 工具系统的接口清晰：TOOL_EXECUTE 状态调用 M3 工具接口
- [ ] M2 核心循环与 M7 上下文记忆的接口清晰：BUILD_CONTEXT 调用 M7 加载 system prompt + memory 召回 + tool 池；`ptl` stop_reason 委托 M7 降级；每轮结束调用 `shouldAutoCompact()`
- [ ] M3 工具系统与 M4 权限拦截的接口清晰：M3 工具调用经 M4 五层拦截链
- [ ] M3 工具系统与 M5 编排引擎的接口清晰：`agent_router`/`send_message`/`task_create`/`task_stop` 工具由 M5 提供路由逻辑，M3 提供工具接口
- [ ] M3 工具系统与 M6 Skills 插件的接口清晰：Skills 工具白名单通过 M3 `mergeAndFilterTools()` 接入工具池
- [ ] M5 编排引擎与 M7 上下文记忆的接口清晰：sidechain transcript 由 M7 持久化；mailbox JSONL 用 M7 原子写原语；CompactBoundary 事件触发 M7 rewind
- [ ] M4 权限拦截与 M7 上下文记忆的接口清晰：CompactBoundary/UserPromptSubmit/AssistantResponse 事件触发 M4 Hook
- [ ] M1 模型抽象层与 M4 权限拦截的接口清晰：`capabilities.supportsRiskClassification` 由 M1 定义，M4 Risk Classifier thinking 阶段消费
- [ ] M1 模型抽象层与 M2 核心循环的 fallback 接口清晰：同 provider 内 fallback（决策 C1）由 M1 实现，M2 触发

### 3.2 接口契约完整性

- [ ] 每个跨模块调用都有明确的接口签名（函数名、参数类型、返回值、失败模式）
- [ ] 每个跨模块事件都有明确的触发时机与契约（JSON Schema 或等价描述）
- [ ] 每个跨模块共享状态都有明确的读写权限与并发控制策略
- [ ] 接口契约的版本兼容策略明确（v1.0 锁定，v2.x 演进路径明确）

### 3.3 依赖关系图一致性

- [ ] 总体 PRD §4.2 模块间依赖关系图与各模块 PRD §5 交互表一致
- [ ] 依赖关系无环（DAG），如有环需明确打破策略
- [ ] 阻塞里程碑（M1-M5）与依赖关系一致：被依赖模块先交付
- [ ] 关键路径（最长依赖链）明确：M1 → M2 → M3 → M4 → M5/M6/M7

### 3.4 不变量分配合理性

- [ ] 附录 A 18 项不变量每项至少分配到一个模块 PRD §7（参考 verification report 表）
- [ ] 不变量分配无遗漏（与总体 PRD 附录 A 完全对齐）
- [ ] 共享不变量（如 #3 tool_use/result 配对 → M2+M7）双方都确认职责边界
- [ ] 每个不变量的守护机制具体可实现（如"渗透测试"/"规则冲突测试"/"故障注入测试"等有明确测试用例设计）

### 3.5 NFR 可达性

- [ ] 每个模块级 NFR 指标值在当前技术栈下可达（如 TTFT P99 ≤ 2s 在主流 provider 上可达）
- [ ] NFR 验收方式明确（埋点位置、统计口径、采样方法）
- [ ] 护栏指标（§5.2.3）有明确的告警阈值与处置策略（如 autocompact 连续失败 3 次触发熔断）
- [ ] NFR 之间的依赖关系明确（如 Prompt cache 命中率 ≥ 80% 依赖 M1 prefix cache 设计 + M7 STATIC_DYNAMIC_BOUNDARY 切分）

### 3.6 里程碑路线图

- [ ] M0-M5 里程碑定义清晰，每个里程碑的交付物明确
- [ ] 每个里程碑的阻塞模块与前置门槛明确
- [ ] v2.x 演进项与各模块 PRD §8.4 一致
- [ ] M1 Walking Skeleton 的前置门槛（findRelevantMemories 评测集 30 条）已就绪

---

## 4. 安全工程师 Review Checklist（mod-04 + 相关章节）

### 4.1 五层纵深防御链（mod-04 §3.1 + §4）

- [ ] 五层顺序正确：System Prompt → 权限规则 → OS 沙箱 → Plan Mode → Hooks/预算
- [ ] 任一层可独立拦截的设计明确（前一层放行后后一层仍可 deny）
- [ ] 单层失效不导致越权的具体保障机制描述清晰
- [ ] 五层之间的执行顺序明确（不可跳层，除非有明确降级策略）

### 4.2 权限规则 8 层优先级（mod-04 §3.2）

- [ ] 8 层优先级从高到低正确：CLI 参数 → 会话内动态 → 命令级 → 策略文件 → 用户级 → 项目级 → 本地级 → 默认值
- [ ] 高优先级覆盖低优先级的冲突解决规则明确
- [ ] 三维权限匹配（工具 / 命令 / 路径）的语义清晰
- [ ] fail-closed 默认值明确（未配置时保守拒绝）

### 4.3 Risk Classifier（mod-04 §4.1 + 决策 A1/A2）

- [ ] Fast 阶段（规则表，<100ms）+ Thinking 阶段（云端轻量级 LLM，~1s）边界清晰
- [ ] 置信度分流阈值（≥0.95 自动 / 0.80-0.95 ask / <0.80 needs_review）与决策 A1 严格档一致
- [ ] 错误代价不对称设计（漏报≤3% / 误报≤15%）的依据充分
- [ ] 降级机制明确：分类器 LLM 调用失败必降级为 `default ask`，永不臆造批准
- [ ] DenialTracking（maxConsecutive=3 / maxTotal=20）防死循环机制明确
- [ ] 评测集引用（119 条，§8.3）与 M3 启动前门槛对齐
- [ ] 合规场景本地化（v2.x，`OMNIAGENT_RISK_CLASSIFIER_LOCAL=1`）路径明确

### 4.4 沙箱机制（mod-04 §4.3 + 决策 B1/B2）

- [ ] macOS sandbox-exec / Linux bubblewrap / Windows 纯权限规则三平台方案完整
- [ ] 4 类 deny 路径（`.omniagent/settings.json` / `.omniagent/skills/` / bare git repo / 系统目录）始终生效
- [ ] 沙箱启用时 Bash 自动 allow，但 4 类 deny 仍生效的设计明确
- [ ] 沙箱不启用场景（root 用户 / 容器内）的降级策略明确
- [ ] Windows 用户安全建议（WSL2 + bubblewrap）描述清晰，独立章节
- [ ] Windows 沙箱逃逸拦截率不设目标（决策 B2）的依据充分

### 4.5 Hook 中间件机制（mod-04 §4.2 + 决策 A4）

- [ ] 27 事件 × 6 类型矩阵完整（工具/Agent/会话/消息/权限/模型/系统 7 大类事件）
- [ ] `function` 类型 v1.0 仅限内置扩展（决策 A4），用户配置文件不支持 `type: function`
- [ ] Hook 契约（permissionDecision / updatedInput / additionalContext / continue）字段完整
- [ ] async hook（首行 `{"async":true}` + asyncRewake 退出码 2）机制明确
- [ ] v2.x 评估放开签名+白名单机制的路径明确

### 4.6 Prompt Injection 防御（mod-04 §4.4）

- [ ] 四道防线（AST 解析 / 工具结果隔离 / Shadow 测试 / 文件内容审查）完整
- [ ] 工具结果隔离的语义清晰（`tool_result` 不作为 `user`/`assistant` 消息参与下一轮决策）
- [ ] Shadow 测试的执行频率与测试集维护责任明确
- [ ] 文件内容审查的判定标准（什么算"可疑指令"）明确

### 4.7 命令审计（mod-04 §4.5）

- [ ] 审计日志字段（时间戳 / 命令 / cwd / user / permission decision / exit code）完整
- [ ] 审计日志写入失败不影响主流程的设计明确
- [ ] `--audit-log <path>` 全局开关支持
- [ ] 监控系统上报机制明确（磁盘满/权限时的告警路径）

### 4.8 不变量守护（mod-04 §7）

- [ ] #8 五层纵深防御链任一层可独立拦截 → 渗透测试用例设计明确
- [ ] #9 权限规则 8 层优先级严格生效 → 规则冲突测试用例设计明确
- [ ] #10 sandbox 4 类 deny 路径始终生效 → 沙箱日志校验方式明确
- [ ] #13 Risk Classifier 失败必降级为 ask → 故障注入测试用例设计明确
- [ ] #14 DenialTracking maxConsecutive=3 / maxTotal=20 → 死循环测试用例设计明确

---

## 5. 上下文工程组 Review Checklist（mod-07 + 相关章节）

### 5.1 分层记忆架构（mod-07 §3.1）

- [ ] 4 层记忆（L1 工作记忆 / L2 会话记忆 / L3 项目记忆 / L4 系统提示）生命周期与注入策略明确
- [ ] 各层注入策略（全量注入 / 按需召回 / 召回注入 / 静态前缀+动态后缀）实现可行
- [ ] 各层之间的数据流明确（L1 → L2 摘要触发时机 / L3 召回注入到 L1 的路径）

### 5.2 项目记忆 4 类型与双重上限（mod-07 §3.2）

- [ ] 4 类型（user / feedback / project / reference）语义清晰，示例合理
- [ ] 双重上限（≤200 行 / ≤25KB）的超限压缩策略明确
- [ ] memory 文件位置（`~/.omniagent/memory/*.md`）与 frontmatter 格式明确

### 5.3 召回机制（mod-07 §3.3 + §4.1 + 决策 C2）

- [ ] `findRelevantMemories(query, max_tokens=256)` 接口签名与返回值定义完整
- [ ] 召回指标（recall@5≥0.8 / precision@5≥0.7）与决策 C2 一致
- [ ] 召回用模型选型逻辑（轻量级 LLM，与主对话模型可不同）明确
- [ ] 召回结果置信度低于阈值时不注入的策略明确
- [ ] 模型失败时跳过召回、对话继续不崩的设计明确
- [ ] 评测集引用（30 条，§8.3）与 M1 启动前门槛对齐
- [ ] 召回 LLM 调用成本在 Cost Tracker 单独统计的机制明确
- [ ] 合规场景本地 embedding（v2.x，`all-MiniLM-L6-v2`）路径明确

### 5.4 SystemPrompt 三阶段组装（mod-07 §3.4）

- [ ] 三阶段（`getSystemPrompt()` → `buildEffectiveSystemPrompt()` → `buildSystemPromptBlocks()`）顺序清晰
- [ ] 5 级优先级合并（override > coordinator > main-thread agent > custom/default > append）规则明确
- [ ] STATIC_DYNAMIC_BOUNDARY 切分点设计可实现 prompt cache 最大化
- [ ] 品牌 `string[]` 类型设计可实现分块缓存

### 5.5 三层压缩策略（mod-07 §4.2）

- [ ] 三层（L1 MicroCompact / L2 SessionMemory / L3 API 摘要）触发条件与策略明确
- [ ] 保留窗口算法（minTokens=10K / minText=5 / maxTokens=40K）参数合理
- [ ] `adjustIndexToPreserveAPIInvariants()` 的 tool_use/tool_result 配对保护机制明确
- [ ] COMPACTABLE_TOOLS 白名单（8 个：bash / edit_file / read_file / write_file / glob / grep / task_output / web_fetch）与 M3 工具命名一致
- [ ] 无法修正配对时报错而非破坏配对的设计明确

### 5.6 PTL 紧急降级三步（mod-07 §4.3 + 不变量 #12）

- [ ] 三步（collapse_drain → reactive_compact → error）顺序明确
- [ ] Circuit Breaker（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3`）熔断机制明确
- [ ] 熔断后明确报错并提示用户手动 `/compact`，不无限重试
- [ ] 6 个逃逸条件完整：
  - [ ] 用户禁用自动压缩（`/compact off`）
  - [ ] 正在压缩中（防重入）
  - [ ] 已经压缩过（不重复压缩）
  - [ ] collapse 处理中（PTL 流程中）
  - [ ] budget continuation（预算续跑模式）
  - [ ] 第三方 provider 无精确 token 计数（保守估算提前压缩）

### 5.7 持久化与恢复（mod-07 §4.5 + 不变量 #16）

- [ ] Session transcript JSONL append-only + uuid/parentUuid 链路设计明确
- [ ] 4 种视图（Raw / UI / Active query / API wire）的语义清晰
- [ ] Sidechain（子 agent 独立 transcript）与主 transcript 通过 parentUuid 关联的机制明确
- [ ] 9 场景错误恢复矩阵每场明确：
  - [ ] main 损坏 / sidechain 损坏 / team 缺失 / mailbox 损坏 / task 损坏 / sidecar 404 / worktree pointer 缺失 / fork metadata 缺失 / 模式不匹配
- [ ] 写队列（100ms 节流批量写 + 10ms flush 紧急持久化）设计明确
- [ ] Resume（`omniagent --resume <sessionId>`）恢复对话链 + mode + 权限规则的设计明确
- [ ] 进程崩溃后 resume 成功率 ≥ 95% 的实现路径明确

### 5.8 CompactBoundary（mod-07 §4.6）

- [ ] 压缩点 boundary 记录机制明确
- [ ] `/rewind` 按 boundary 还原上下文状态的设计可实现
- [ ] boundary 与 sidechain 的交互语义明确

### 5.9 不变量守护（mod-07 §7）

- [ ] #3 tool_use/tool_result 配对完整性 → `adjustIndexToPreserveAPIInvariants()` 强制修正机制明确（与 M2 共享，确认职责边界）
- [ ] #11 autocompact circuit breaker 3 次触发 → 连续失败测试用例设计明确
- [ ] #12 PTL 紧急降级三步必走完 → PTL 注入测试用例设计明确
- [ ] #16 9 场景错误恢复矩阵全覆盖 → 场景注入测试用例设计明确

---

## 6. 工具组 Review Checklist（mod-03 + mod-06）

### 6.1 工具接口（mod-03 §3）

- [ ] Tool 接口签名（name / description / inputSchema / execute）完整
- [ ] 工具池隔离机制 `mergeAndFilterTools()` 明确，支持 Coordinator Mode 主 Agent 写工具移除
- [ ] 工具结果格式（tool_result content array）符合 LLM Provider 接口
- [ ] 工具命名规范一致（snake_case）

### 6.2 60+ 内置工具 7 类（mod-03 §4.1）

- [ ] 7 类（文件操作 / 代码搜索 / Bash 执行 / 网络访问 / 任务管理 / Agent 编排 / 系统配置）覆盖完整
- [ ] 每类工具命名规范一致
- [ ] 工具描述（description）简洁且能指导 LLM 选择
- [ ] 60+ 工具清单可枚举（不是模糊"60+"，应有具体列表或分类计数）

### 6.3 Bash 24 项安全校验（mod-03 §4.2 + 不变量 #15）

- [ ] 24 项 bashSecurity 校验规则完整（C01-C24 类别清晰）
- [ ] 24 项规则与 M4 Risk Classifier Fast 阶段规则表一致（M3 实现，M4 消费）
- [ ] Zsh 13 命令黑名单覆盖
- [ ] MCP 工具描述截断 2048 字符（不变量 #15）机制明确

### 6.4 工具池隔离（mod-03 §4.3 + 不变量 #4）

- [ ] `mergeAndFilterTools()` 在 Coordinator Mode 下移除主 Agent 写工具的机制明确
- [ ] Skills 工具白名单接入机制明确
- [ ] Coordinator 模式下主 Agent 直接工具调用率 = 0 的守护机制（工具池硬隔离校验）明确

### 6.5 Skill 定义（mod-06 §3.1）

- [ ] Skill = Markdown + YAML frontmatter 的声明式封装可实现
- [ ] 16 字段 frontmatter 规范完整（name / description / tools / permissions / triggers / scope / mode / async / timeout / retry / fallback / metadata / version / author / tags / examples）
- [ ] YAML frontmatter 损坏时启动期校验失败提示行号、跳过该 skill 不影响其他的机制明确

### 6.6 5 种来源与优先级（mod-06 §4.1）

- [ ] 5 来源（内置 / Bundled / 磁盘 / MCP / Legacy）优先级正确
- [ ] 内置不可覆盖规则明确
- [ ] skill 名与内置命令重名时的处理（内置优先，提示用户改名，不覆盖内置）明确

### 6.7 双模式执行（mod-06 §4.2）

- [ ] inline 模式（注入当前 Agent 上下文）与 fork 模式（独立 fork agent + 独立 sidechain）边界清晰
- [ ] fork 模式与 M5 编排引擎的接口（fork 路由）明确
- [ ] 复杂 Skill（多轮工具调用）用 fork 模式避免污染主对话上下文的判定标准明确

### 6.8 热插拔（mod-06 §4.3）

- [ ] 文件系统 watch `.omniagent/skills/` 机制明确
- [ ] 新增/修改/删除即时生效的实现可行
- [ ] 校验失败的 skill 不影响其他 skill 加载的隔离机制明确

### 6.9 不变量守护（mod-03 §7 + mod-06 §7）

- [ ] #4 Coordinator 模式下主 Agent 直接工具调用率 = 0 → 工具池硬隔离校验用例设计明确（与 M5 共享，确认职责边界）
- [ ] #15 MCP 工具描述 2048 字符截断 → 截断测试用例设计明确
- [ ] #10 sandbox 4 类 deny 路径（关联不变量，`.omniagent/skills/` 防注入）→ 依赖 M4 守护，本模块依赖关系明确

---

## 7. 产品 Review Checklist（总体 PRD §1-2 + §6 + 附录 C）

### 7.1 产品定位（总体 PRD §1）

- [ ] 产品定位（harness 层，不是 Agent）描述清晰
- [ ] 核心价值主张 3 条（harness 透明 / 模型自由 / 真开放）与模块 PRD §2 设计目标可追溯
- [ ] 包名（`omniagent-cli`）/ 命令名（`omniagent`）确认（决策 D1）
- [ ] 状态字段说明本 PRD 为总体产品方案，模块详细方案见模块 PRD（§4 模块索引表）

### 7.2 目标用户与场景（总体 PRD §2）

- [ ] 目标用户群体占比（架构师 28% / 资深用户 25% / 安全工程师 18% / 上下文工程组 12% / 工具组 10% / 其他 7%）与决策 A1（安全工程师提升到 18%）一致
- [ ] 6 个核心场景（多模型对比 / 长任务委派 / 安全沙箱 / 长对话稳定 / 多 Agent 协作 / 工作流自动化）与模块 PRD 功能对齐
- [ ] 金融/政府/医疗合规场景用户的需求覆盖（决策 A1 严格档的依据）明确

### 7.3 里程碑路线图（总体 PRD §6）

- [ ] M0-M5 里程碑定义清晰
- [ ] 每个里程碑的阻塞模块与前置门槛明确
- [ ] M1 Walking Skeleton 的前置门槛（findRelevantMemories 评测集 30 条）状态明确
- [ ] M3 安全纵深的前置门槛（Risk Classifier 评测集 119 条）状态明确
- [ ] v2.x 演进项与各模块 PRD §8.4 一致

### 7.4 决策冻结状态（附录 C + 冻结记录）

- [ ] 12 项决策（A1-A4 / B1-B3 / C1-C3 / D1-D2）全部已冻结
- [ ] 附录 C "影响模块"列与各模块 PRD §8.1 已冻结决策一致
- [ ] 冻结记录中的"对 PRD 的影响"条目都有对应模块 PRD 引用（详见 mod-XX §Y）
- [ ] 解冻流程明确（发起 → 评估 → 评审 → 记录 → 通知）

### 7.5 总体 PRD lean 化质量

- [ ] §3.2 / §3.3 替换为 1 段摘要 + 模块链接，摘要内容准确
- [ ] §4 替换为模块索引表 + 依赖关系 + 不变量/NFR 分配 + 评测集归属，4 个子节完整
- [ ] §5 NFR 章节保留全文，跨模块约束清晰
- [ ] 附录 A 18 项不变量保留全文，"守护模块"列正确
- [ ] 附录 B 术语表保留全文
- [ ] 附录 C 12 项决策保留全文，"影响模块"列正确

---

## 8. 交叉确认 Checklist（相关模块双方对齐）

> 交叉确认不是单方检查，是相关模块的双方对接口契约达成一致。每对需双方签字。

### 8.1 M3 + M4（Risk Classifier 边界 + 沙箱叠加）

- [ ] 24 项 bashSecurity 校验规则表归 M3 实现，M4 Risk Classifier Fast 阶段消费——双方对规则表维护责任达成一致
- [ ] M4 沙箱与 M3 24 项校验叠加顺序明确（先 24 项校验后沙箱）
- [ ] M3 Bash 工具调用经 M4 五层拦截链的责任归属明确
- [ ] MCP 工具描述 2048 截断（M3 实现）与 M4/M6 消费的一致性

### 8.2 M3 + M5（agent_router 工具接口）

- [ ] `agent_router` / `send_message` / `task_create` / `task_stop` 工具的接口由 M3 定义，路由逻辑由 M5 提供——双方对接口契约达成一致
- [ ] 工具调用的失败模式（路由失败 / 远端不可达 / mailbox 满）的处理达成一致
- [ ] Coordinator Mode 下主 Agent 工具池硬隔离（M3 `mergeAndFilterTools()` 实现，M5 触发）的责任分工明确

### 8.3 M3 + M6（Skills 工具白名单接入）

- [ ] Skills 工具白名单通过 `mergeAndFilterTools()` 接入工具池的顺序明确
- [ ] Skills 触发的工具调用经 M4 五层拦截链的责任归属明确
- [ ] Skills 工具命名与 M3 工具命名规范一致（snake_case）

### 8.4 M5 + M7（sidechain 与 mailbox 持久化）

- [ ] sidechain transcript 由 M7 持久化，M5 触发——双方对触发时机与持久化接口达成一致
- [ ] mailbox JSONL 用 M7 原子写原语（temp + rename + 10 次退避）——双方对原子写语义达成一致
- [ ] CompactBoundary 事件触发 M7 rewind 的契约明确
- [ ] mailbox 容量限制（单条 64KB / 文件 4MB / 1000 条消息）的执行责任归 M5，持久化责任归 M7——双方达成一致

### 8.5 M2 + M7（PTL 降级委托 + autocompact 判定）

- [ ] M2 在 `ptl` stop_reason 时委托 M7 PTL 紧急降级三步的接口明确
- [ ] M2 每轮结束调用 M7 `shouldAutoCompact()` 的接口明确
- [ ] 6 个逃逸条件的判定责任归 M7，M2 只负责调用——双方达成一致
- [ ] M2 fallback 5 步（同 provider 内降级，决策 C1）与 M7 PTL 降级三步的边界清晰（前者是模型失败，后者是上下文超限）

### 8.6 M1 + M4（supportsRiskClassification 能力声明）

- [ ] LLMProvider 接口的 `capabilities.supportsRiskClassification` 字段由 M1 定义，M4 Risk Classifier thinking 阶段消费——双方对能力声明维护责任达成一致
- [ ] provider 选型确认（M3 启动前）的责任归 M1 + M4 双方
- [ ] 召回用模型选型（M7 `findRelevantMemories`）通过 M1 provider 接口调用——三方对接口达成一致

### 8.7 M1 + M2（fallback 链 + token 计数）

- [ ] 同 provider 内 fallback（决策 C1）由 M1 实现，M2 触发——双方对触发时机与降级接口达成一致
- [ ] `fallbackModel` 字段配置 schema 由 M1 定义
- [ ] `countTokens()` 用于上下文体积估算的接口由 M1 提供，M7 调用——双方达成一致

### 8.8 M5 + M6（Skills fork 模式路由）

- [ ] Skills fork 模式由 M6 触发，M5 提供 fork 路由——双方对 fork 接口达成一致
- [ ] fork agent 的 sidechain transcript 由 M7 持久化（M5 中转）——三方达成一致
- [ ] fork agent 的 prompt cache prefix byte-identical（不变量 #5）由 M5 守护，M6 Skills 触发时遵循——双方达成一致

### 8.9 M4 + M7（Hook 事件 + CompactBoundary）

- [ ] CompactBoundary 事件触发 M4 Hook 的时机与契约明确
- [ ] UserPromptSubmit / AssistantResponse 事件触发 M4 Hook 的时机与契约明确
- [ ] M7 持久化文件（transcript / sidechain）受 M4 sandbox 保护的责任分工明确

---

## 9. 签字模板

每个模块 PRD 签字时填写以下模板（追加到模块 PRD 末尾，作为 §10 节）：

```markdown
---

## 10. Review 签字记录

| 角色 | 姓名 | 签字日期 | 签字状态 | 备注 |
|------|------|---------|---------|------|
| 主负责角色 | | | ☐ 通过 ☐ 有保留通过 ☐ 不通过 | |
| 交叉确认角色 | | | ☐ 通过 ☐ 有保留通过 ☐ 不通过 | |
| 架构师 | | | ☐ 通过 ☐ 有保留通过 ☐ 不通过 | |

**Review 日期**：YYYY-MM-DD
**Review 方式**：☐ 自审 ☐ 交叉确认 ☐ 评审会
**遗留项**（有保留通过时必填）：
- [ ] 遗留项 1，跟进人：__，截止日期：YYYY-MM-DD
- [ ] 遗留项 2，跟进人：__，截止日期：YYYY-MM-DD

**冻结状态升级**：M0 已冻结 → 已 review 冻结
```

### 9.1 总体 PRD 与冻结记录签字模板

总体 PRD 与冻结记录的签字模板额外增加"全部角色"行：

```markdown
| 角色 | 姓名 | 签字日期 | 签字状态 | 备注 |
|------|------|---------|---------|------|
| 架构师 | | | ☐ 通过 ☐ 有保留通过 ☐ 不通过 | |
| 产品 | | | ☐ 通过 ☐ 有保留通过 ☐ 不通过 | |
| 安全工程师 | | | ☐ 通过 ☐ 有保留通过 ☐ 不通过 | |
| 上下文工程组 | | | ☐ 通过 ☐ 有保留通过 ☐ 不通过 | |
| 工具组 | | | ☐ 通过 ☐ 有保留通过 ☐ 不通过 | |
```

---

## 10. Review 通过标准

### 10.1 通过等级定义

- **通过**：所有适用 checklist 项全部 ☑，无遗留项
- **有保留通过**：≤ 3 项非关键 checklist 项有遗留，遗留项有明确跟进计划与截止日期
- **不通过**：≥ 4 项 checklist 项有遗留，或任何关键项有遗留

### 10.2 关键项定义（不可遗留）

以下 checklist 项为关键项，任何遗留都判为"不通过"：

- §2.2 与总体 PRD 一致性（全部子项）
- §2.3 与冻结决策一致性（全部子项）
- §3.1 跨模块边界清晰度（全部子项）
- §3.2 接口契约完整性（全部子项）
- §3.4 不变量分配合理性（全部子项）
- §4.3 Risk Classifier（全部子项，决策 A1/A2 落地）
- §4.4 沙箱机制（全部子项，决策 B1/B2 落地）
- §5.3 召回机制（全部子项，决策 C2 落地）
- §5.6 PTL 紧急降级三步（全部子项，不变量 #12 落地）
- §5.7 持久化与恢复（全部子项，不变量 #16 落地）
- §6.3 Bash 24 项安全校验（全部子项，不变量 #15 落地）
- §8 全部交叉确认项（接口契约不可遗留）

### 10.3 非关键项定义（可保留通过）

以下项可保留通过（≤ 3 项）：

- §2.1 结构完整性中的格式类项（如"§9 参考链接有效"等可后补）
- §2.4 品牌中立性中的示例审视（如有边界案例可后补）
- §2.5 交叉引用有效性中的非断链类问题
- §6.5 Skill 定义中的字段示例补全
- §7.5 总体 PRD lean 化质量中的格式优化

---

## 11. Review 完成后的后续行动

1. **冻结状态升级**：各模块 PRD 头部"状态"字段从"M0 已冻结"升级为"已 review 冻结"，并追加 §10 签字记录
2. **遗留项跟进**：有保留通过的模块 PRD，遗留项按计划跟进闭环，全部闭环后升级为"已 review 冻结"
3. **进入 M1 开工**：所有 M1 涉及的模块 PRD（mod-01 / mod-02 / mod-03 / mod-07）签字完成后，M1 Walking Skeleton 可开工
4. **M3/M5/M6 模块延后 review**：mod-04 / mod-05 / mod-06 可在对应里程碑（M3 / M2 / M4）启动前再 review，但建议一次性 review 闭环（避免重复劳动）
5. **Review 报告归档**：评审会决议、遗留项跟进记录、签字模板归档到 `/Users/liguang/ccwork/omniagent/review-records/`（如有此目录）

---

## 12. Review 角色 RACI 矩阵

| 模块 PRD | 架构师 | 产品 | 安全工程师 | 上下文工程组 | 工具组 |
|---------|-------|------|----------|------------|------|
| 总体 PRD | A/R | R | C | C | C |
| mod-01 | A/R | I | C | I | I |
| mod-02 | A/R | I | I | C | I |
| mod-03 | C | I | C | I | A/R |
| mod-04 | C | I | A/R | I | C |
| mod-05 | A/R | I | I | C | C |
| mod-06 | C | I | C | I | A/R |
| mod-07 | C | I | I | A/R | C |
| 冻结记录 | A/R | C | C | C | C |
| 评测集 README | A/R | I | C | C | I |

> R = Responsible（执行） / A = Accountable（负责） / C = Consulted（咨询） / I = Informed（知情）

---

*本 checklist 是 OmniAgent CLI PRD 模块化拆解后的 review 流程指导文档，由架构师负责维护。Review 完成后各模块 PRD 升级为"已 review 冻结"状态，作为 M1-M5 开发的产品方案基线。*
