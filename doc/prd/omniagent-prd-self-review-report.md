# OmniAgent CLI PRD 拆解后自审报告

> 自审日期：2026-07-08
> 自审范围：1 份总体 PRD + 7 份模块 PRD + 冻结记录 + 评测集 README（共 10 份文件）
> 自审依据：`omniagent-prd-review-checklist.md`（222 项 checklist）
> 自审方式：4 个并行 self-review agent 按角色分工（通用+产品 / 架构师+交叉确认 / 安全工程师 / 上下文+工具组）
> 自审状态：**FAIL**（4 个 agent 全部判 FAIL，去重后 21 项关键问题 + 19 项非关键问题）

---

## 1. 自审统计汇总

| Agent | 角色 | 总项 | ☑ | ☐ | 关键 ☐ | 非关键 ☐ | 判定 |
|------|------|------|---|---|--------|----------|------|
| 1 | 通用（§2）+ 产品（§7） | 50 | 45 | 5 | 0 | 5 | FAIL（非关键超 3 项阈值） |
| 2 | 架构师（§3）+ 交叉确认（§8） | 60 | 41 | 19 | 13 | 6 | FAIL（关键项 13） |
| 3 | 安全工程师（§4） | 39 | 26 | 13 | 7 | 6 | FAIL（关键项 7） |
| 4 | 上下文工程组（§5）+ 工具组（§6） | 71 | 59 | 12 | 6 | 6 | FAIL（关键项 6） |
| **合计** | — | **220** | **171** | **49** | **26** | **23** | — |
| **去重后** | — | — | — | **40** | **21** | **19** | — |

> 去重说明：M1/M3 评测集就绪状态矛盾被 Agent 1（§7.3）和 Agent 2（§3.6）重复发现；M5 §5 不含 M6 被 Agent 1（§2.1）和 Agent 2（§8.8）重复发现；不变量守护机制泛泛被 Agent 3（§4.8）和 Agent 4（§5.9）重复发现（不同模块）。去重后 21 关键 + 19 非关键 = 40 个独立问题。

---

## 2. 关键问题清单（21 项，必须修复才能签字）

### 2.1 跨模块边界与接口契约（10 项）

#### K1. M5 §5 交互表不包含 M6
- **文件**：`omniagent-prd-mod-05-orchestration.md:156-161`
- **问题**：M6 §5 L132 确认"由 M5 提供 fork 路由"，但 M5 §5 交互表仅列 M2/M3/M4/M7，**不含 M6**。M5 全文无"M6"或"Skills"（grep No matches found）。总体 PRD §4.2 L205 确认 M6 依赖 M5（fork 模式），但 M5 模块 PRD 未对齐。
- **建议**：M5 §5 交互表新增 M6 行，描述 fork 路由接口契约。
- **发现者**：Agent 2（§3.1 + §8.8）+ Agent 1（§2.1 间接发现）

#### K2. CompactBoundary→rewind 契约 M5/M7 不一致
- **文件**：`omniagent-prd-mod-05-orchestration.md:161` vs `omniagent-prd-mod-07-context-memory.md:180,167`
- **问题**：M5 §5 L161 称"CompactBoundary 事件触发 M7 rewind"；M7 §5 L180（M5 交互行）未提及 CompactBoundary/rewind；M7 §4.6 L167 描述 rewind 为 `/rewind` 用户命令触发，非事件触发。
- **建议**：明确 CompactBoundary 事件与 rewind 的关系——是 CompactBoundary 事件触发 M7 记录 boundary（供后续 /rewind 使用），还是事件直接触发 rewind。双方统一措辞并在 §5 交互表对齐。
- **发现者**：Agent 2（§3.1 + §8.4）

#### K3. UserPromptSubmit/AssistantResponse 事件归属 M4/M7 不一致
- **文件**：`omniagent-prd-mod-04-permission.md:249` vs `omniagent-prd-mod-07-context-memory.md:179`
- **问题**：M4 §5 L249（M7 交互行）列出"UserPromptSubmit/AssistantResponse 事件触发 Hook"；M7 全文无这两个事件名（grep No matches found）。这两个事件更可能由 M2（核心循环）触发，但 M4 将其归入 M7 交互行。
- **建议**：明确这两个事件的触发源（M2 vs M7），M4 §5 交互表修正归属行，或 M7 §5 确认触发。
- **发现者**：Agent 2（§3.1 + §8.9）

#### K4. M7 持久化文件 sandbox 保护未双向确认
- **文件**：`omniagent-prd-mod-07-context-memory.md:179` vs `omniagent-prd-mod-04-permission.md`
- **问题**：M7 §5 L179 称"持久化文件（transcript/sidechain）受 M4 sandbox 保护"；M4 全文无"transcript"或"sidechain"（grep No matches found）；M4 §4.3 L211-215 沙箱 4 类 deny 路径（settings.json/skills/bare git repo/系统目录）不含 transcript/sidechain。
- **建议**：M4 确认 sandbox 对 transcript/sidechain 的保护机制（通用隔离 vs deny 路径），或 M7 修正描述。
- **发现者**：Agent 2（§8.9）

#### K5. M6 未确认 prompt cache prefix byte-identical（#5）
- **文件**：`omniagent-prd-mod-06-skills.md`（全文）
- **问题**：M5 §4.1 L95 + §7 L200 守护不变量 #5（fork agent prompt cache prefix byte-identical），但 M6 全文无"byte-identical"/"prefix"/"cache"/"#5"（grep No matches found）。M6 fork 模式触发时未确认遵循此要求。
- **建议**：M6 §5 或 §7 新增对 fork 模式 prompt cache prefix byte-identical 要求的确认。
- **发现者**：Agent 2（§8.8）

#### K6. agent_router 工具调用失败模式未定义
- **文件**：`omniagent-prd-mod-03-tools.md` + `omniagent-prd-mod-05-orchestration.md`
- **问题**：M3/M5 全文无"失败模式"/"路由失败"/"远端不可达"/"mailbox 满"（grep No matches found）。agent_router/send_message/task_create/task_stop 工具调用的失败模式及处理策略缺失。
- **建议**：M3 或 M5 §5 新增 agent_router 工具调用失败模式（路由失败/远端不可达/mailbox 满）及处理策略。
- **发现者**：Agent 2（§8.2）

#### K7. 多个跨模块函数缺接口签名
- **文件**：M3/M5/M7/M2 多处
- **问题**：以下跨模块函数仅提及函数名，无参数类型/返回值/失败模式签名：
  - `mergeAndFilterTools()`（M3 L85/L197）
  - `shouldAutoCompact()`（M7 L148/L176）
  - `agent_router`（M5 §3.1 仅描述 5 路径无签名）
  - `writeMailboxAtomic`（M5 §6.1 L173 仅提及埋点名）
  - `adjustIndexToPreserveAPIInvariants()`（M2 L165/L221、M7 L132/L226）
- **建议**：各模块 §3 或 §5 补充这些跨模块函数的 TypeScript 签名（参数/返回值/失败模式）。
- **发现者**：Agent 2（§3.2）

#### K8. 跨模块事件缺 payload 契约
- **文件**：`omniagent-prd-mod-04-permission.md:173-174,188-195`
- **问题**：CompactBoundary/UserPromptSubmit/AssistantResponse 等事件仅有事件名和粗粒度触发时机（"会话级"/"消息级"），无事件负载 JSON Schema。Hook 响应契约存在但事件触发 payload 未定义。
- **建议**：M4 §4.2 补充关键事件的 payload 定义（字段名/类型/语义）。
- **发现者**：Agent 2（§3.2）

#### K9. 跨模块共享状态并发控制不完整
- **文件**：M7 §4.5 + M3 §3.2
- **问题**：mailbox 有并发控制（M5 §3.3 L71 原子写+退避）；session transcript 有写队列（M7 §4.5 L162 100ms 节流）。但 **sidechain 的读写权限**（谁可读/写/并发策略）未明确；**tool pool 的并发访问规则**（多 agent 同时读写工具池）未明确。
- **建议**：M7 §4.5 补充 sidechain 并发控制；M3 §3.2 补充 tool pool 并发访问规则。
- **发现者**：Agent 2（§3.2）

#### K10. 接口契约版本兼容策略缺失
- **文件**：全部模块 PRD
- **问题**：grep 确认所有模块 PRD 无"版本兼容"/"backward"相关内容。PRD 提及 v1.0 锁定与 v2.x 演进，但无接口契约的版本兼容策略（semver 规则、向后兼容约束、breaking change 流程）。
- **建议**：总体 PRD 或 M1 §3 新增接口契约版本兼容策略。
- **发现者**：Agent 2（§3.2）

### 2.2 文档一致性问题（3 项）

#### K11. v2.x/v3.x 分类不一致
- **文件**：`omniagent-prd.md:597-598` vs `omniagent-prd-mod-05-orchestration.md:227`、`omniagent-prd-mod-07-context-memory.md:258`
- **问题**：总体 PRD §6.2 将"Team Recommender 默认启用"和"Context Anchor 默认启用"列为 **v3.x**；M5 §8.3 和 M7 §8.4 分别列为 **v2.x**。
- **建议**：统一分类，总体 PRD §6.2 与模块 §8.4/§8.3 对齐。
- **发现者**：Agent 2（§3.6）

#### K12. M1/M3 前置门槛就绪状态矛盾
- **文件**：`omniagent-prd.md:515,550` vs `omniagent-prd-decisions.md:247-248,266`
- **问题**：总体 PRD §6.2 称 findRelevantMemories 评测集"已就绪"（L515）、Risk Classifier 评测集"已就绪 119 条"（L550）；冻结记录 §五 L247-248 称"AI 种子完成，待人工校验"；同文件 L266 又称"已就绪"。内部矛盾，可能误导 M1/M3 开工门槛判定。
- **建议**：统一状态描述——人工校验完成前标注"AI 种子完成（N 条），待人工校验冻结"，不称"已就绪"。
- **发现者**：Agent 1（§7.3）+ Agent 2（§3.6）双重发现

#### K13. 关键路径未明确陈述
- **文件**：`omniagent-prd.md`（§4.2 + §6.2）
- **问题**：grep 确认全文无"关键路径"/"critical path"/"最长依赖"。§4.2 依赖图未标注最长依赖链。里程碑章节 §6.2 可推断最长链为 M1→M7→M2→M5→M6（5 节点），但未在 PRD 中明确陈述。
- **建议**：§4.2 或 §6.2 显式标注关键路径（最长依赖链）。
- **发现者**：Agent 2（§3.3）

### 2.3 mod-07 持久化与恢复（3 项）

#### K14. 9 场景错误恢复矩阵仅列场景名，0 个恢复策略被描述
- **文件**：`omniagent-prd-mod-07-context-memory.md:161`
- **问题**：§4.5 L161 仅列出 9 个场景名（main 损坏/sidechain 损坏/team 缺失/mailbox 损坏/task 损坏/sidecar 404/worktree pointer 缺失/fork metadata 缺失/模式不匹配），后接"每种有明确恢复策略"断言，但 **0 个场景的恢复策略被描述**。`grep '恢复策略'` 全文仅此 1 处。
- **建议**：补 9 行表格（场景 / 检测方式 / 恢复策略 / 数据损失预期），如"main 损坏 → walkChain 检测断链 → 从最近 checkpoint 重建 + 标记丢失 turn"等。
- **发现者**：Agent 4（§5.7 K1）

#### K15. 4 种视图仅列名称，无语义描述
- **文件**：`omniagent-prd-mod-07-context-memory.md:159`
- **问题**：§4.5 L159 仅列出"4 种视图（Raw / UI / Active query / API wire）"名称，无任何语义描述。Raw 与 UI 区别？Active query 含什么？API wire 格式？全部未定义。
- **建议**：每视图补一行描述（如 Raw=JSONL 原始记录 / UI=渲染后用户可见 / Active query=当前 turn 相关子集 / API wire=LLM 消息格式）。
- **发现者**：Agent 4（§5.7 K2）

#### K16. resume 成功率 ≥95% 实现路径断裂
- **文件**：`omniagent-prd-mod-07-context-memory.md:161,201`
- **问题**：§6.2 L201 仅给目标值"≥ 95%"，§4.5 的实现路径依赖 JSONL append-only + 写队列 + 9 场景恢复矩阵，但 9 场景恢复策略本身缺失（K14）。实现路径链条断裂。
- **建议**：先补全 K14 的 9 场景恢复策略，再给出从持久化机制到 95% 目标的因果映射。
- **发现者**：Agent 4（§5.7 K3）

### 2.4 不变量守护机制泛标签（2 项，影响 8 个不变量）

#### K17. mod-07 §7 不变量守护 3 项均无具体测试用例设计
- **文件**：`omniagent-prd-mod-07-context-memory.md:227-229`
- **问题**：
  - #11 circuit breaker 守护机制原文 = "连续失败测试（MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3）"——仅测试名+常量，无测试用例设计
  - #12 PTL 降级守护机制原文 = "PTL 注入测试"——恰为 checklist 任务注意事项点名的反例
  - #16 9 场景恢复守护机制原文 = "场景注入测试"——无任何用例设计，且被测对象（9 场景恢复策略）本身在 §4.5 缺失（K14）
- **建议**：每项补具体测试用例设计（如 #12："注入 ptl stop_reason → 验证依次执行 collapse_drain → reactive_compact → error；断言三步均被调用且顺序正确"）。
- **发现者**：Agent 4（§5.9 K4/K5/K6）

#### K18. mod-04 §7 不变量守护 5 项均无具体测试用例设计
- **文件**：`omniagent-prd-mod-04-permission.md:299-303`
- **问题**：5 项不变量守护机制均为泛标签：
  - #8 "渗透测试"——无具体测试场景设计
  - #9 "规则冲突测试"——无冲突场景设计
  - #10 "沙箱日志校验"——无校验方式描述
  - #13 "故障注入测试"——无故障注入场景设计
  - #14 "死循环测试"——无测试设计
- **建议**：每项补至少 1-2 个具体测试场景（输入/期望输出/校验方式），如 #13 应写"mock Risk Classifier LLM endpoint 返回 HTTP 500 → 验证决策=default ask 而非 allow"。
- **发现者**：Agent 3（§4.8）

### 2.5 mod-04 Risk Classifier 与沙箱（2 项）

#### K19. DenialTracking 在 Risk Classifier 与 Hooks 上下文语义冲突
- **文件**：`omniagent-prd-mod-04-permission.md:153,197`
- **问题**：
  - **问题 A**：§4.1 L153 Risk Classifier 上下文 only 提及"连续 3 次误报触发 DenialTracking"（maxConsecutive=3），**未提及 maxTotal=20**。maxTotal=20 仅出现在 §4.2 Hooks（L197）、§6.1 NFR（L266）、§7 不变量（L303）。
  - **问题 B**：DenialTracking 语义冲突——§4.1 L153 Risk Classifier 上下文"自动降级为 ask 模式"（更严格）；§4.2 L197 Hooks 上下文"达上限后放行并告警"（更宽松）。同名机制、同 maxConsecutive=3 阈值、相反结果，机制不"明确"。
- **建议**：明确 DenialTracking 在 Risk Classifier 与 Hooks 两个上下文中的各自完整阈值（maxConsecutive + maxTotal）与各自降级行为，或区分命名以消除歧义。
- **发现者**：Agent 3（§4.3）

#### K20. 沙箱降级未说明 4 类 deny 路径是否仍生效
- **文件**：`omniagent-prd-mod-04-permission.md:217`
- **问题**：§4.3 L217 沙箱不启用场景（root/容器）仅说"降级为纯权限规则"，**未说明 4 类 deny 路径在无沙箱时是否仍生效**。checklist §4.4 要求"4 类 deny 路径始终生效"。实际上 4 类 deny 路径同时存在于 M3 24 项 bashSecurity（mod-03 行109/112/113/115），M3 校验始终运行，故设计上成立——但 mod-04 未在沙箱降级段落交叉引用 M3 24 项校验。
- **建议**：L217 补充"4 类 deny 路径由 M3 24 项 bashSecurity 校验始终保障（详见 mod-03 §4.2 items 3/6/7/8），沙箱降级不影响其生效"。
- **发现者**：Agent 3（§4.4）

### 2.6 跨模块命名一致性（1 项）

#### K21. COMPACTABLE_TOOLS 白名单含 task_output，mod-03 无此工具
- **文件**：`omniagent-prd-mod-07-context-memory.md:134` vs `omniagent-prd-mod-03-tools.md:97`
- **问题**：mod-07 §4.2 L134 COMPACTABLE_TOOLS 白名单 8 个工具含 `task_output`，但 mod-03 §4.1 工具清单中 Agent 工具为 `agent_router`/`send_message`/`task_create`/`task_stop`，无 `task_output`。`grep -c 'task_output' mod-03` = 0。跨模块命名不一致。
- **建议**：mod-03 补 `task_output` 工具定义，或 mod-07 改为与 mod-03 一致的工具名（如 `task_stop`）。
- **发现者**：Agent 4（§5.5 N2，虽标为非关键但影响跨模块一致性，本报告升为关键）

---

## 3. 非关键问题清单（19 项，可保留通过 ≤3 项）

### 3.1 §8 子节结构不完整（4 项，Agent 1 发现）

| # | 文件 | 问题 | 建议 |
|---|------|------|------|
| N1 | mod-02:243 | §8 缺 §8.3 评测集引用，v2.x 错编为 §8.3 | 补占位 §8.3"本模块无直接评测集依赖"，v2.x 改为 §8.4 |
| N2 | mod-03:208 | §8 缺 §8.1 已冻结决策 | 补占位 §8.1"本模块无直接冻结决策" |
| N3 | mod-05:224 | §8 缺 §8.3 评测集引用，v2.x 错编为 §8.3 | 补占位 §8.3，v2.x 改为 §8.4 |
| N4 | mod-06:172 | §8 仅 2 子节（缺 §8.1 + §8.3） | 补占位 §8.1 + §8.3 |

### 3.2 mod-04 细节（6 项，Agent 3 发现）

| # | 文件:行号 | 问题 | 建议 |
|---|----------|------|------|
| N5 | mod-04:83 | "单层失效不导致越权"仅结论性陈述，无具体保障机制 | 补各层 crash 时 fail-closed 策略 |
| N6 | mod-04:52-81 | 无"不可跳层"显式规则；沙箱降级是跳过 Layer 3 的场景但未在 §3.1 标注 | §3.1 补"不可跳层"规则 + 交叉链接 §4.3 降级 |
| N7 | mod-04:167-177 | 27 事件矩阵只列了 18 个示例事件，缺 9 个 | 补完整 27 事件清单 + 事件×类型矩阵 |
| N8 | mod-04:229 | Shadow 测试"定期"无具体频率，无测试集维护责任方 | 补频率（如每里程碑）+ 维护责任方 |
| N9 | mod-04:230 | 文件内容审查未定义"可疑指令"判定标准 | 补判定规则（shell 命令模式/注入 prompt/base64 等） |
| N10 | mod-04:236 | "监控系统上报"无机制描述 | 补告警路径（stderr/日志/外部 API）、级别、方式 |

### 3.3 mod-07 细节（2 项，Agent 4 发现）

| # | 文件:行号 | 问题 | 建议 |
|---|----------|------|------|
| N11 | mod-07:61-72 | memory 文件 frontmatter 格式未定义（grep frontmatter 全文 0 次） | 补 YAML frontmatter schema（type/scope/created_at 等） |
| N12 | mod-07:165-167 | CompactBoundary 与 sidechain 交互语义未定义（§4.6 全文 2 句未提 sidechain） | 补交互规则（sidechain 是否同步标记 boundary、/rewind 是否回退 sidechain） |

### 3.4 mod-03 细节（3 项，Agent 4 发现）

| # | 文件:行号 | 问题 | 建议 |
|---|----------|------|------|
| N13 | mod-03:66 | ToolResult 类型被引用但未定义 | 补 ToolResult 结构（content array + is_error + metadata） |
| N14 | mod-03:91-101 | 60+ 工具不可枚举，实测仅 26 个示例 | 补完整工具清单或分类计数 |
| N15 | mod-03:197 | #4 守护机制仅写"工具池硬隔离校验"，无测试用例设计 | 补 Coordinator Mode 注入+验证用例 |

### 3.5 总体 PRD 细节（3 项，Agent 1 + Agent 2 发现）

| # | 文件:行号 | 问题 | 建议 |
|---|----------|------|------|
| N16 | omniagent-prd.md:44 | §1.3 写"四条核心价值"（REPL优先/多后端中立/多Agent编排内建/权限即边界），与 checklist §7.1 期望的"3 条"名称与条数不符 | 统一 checklist 与 PRD 的价值主张命名/条数 |
| N17 | omniagent-prd.md:328-334 | §5.2.2 可靠性指标表无"测量方式"列 | 补埋点位置/统计口径列 |
| N18 | omniagent-prd.md:339-346 | §5.2.3 护栏指标仅 autocompact 有处置策略，其余 5 项缺 | 补告警阈值与处置策略 |

### 3.6 冻结记录 + NFR 依赖（2 项）

| # | 文件:行号 | 问题 | 建议 |
|---|----------|------|------|
| N19 | omniagent-prd-decisions.md:100-102,170-172 | 决策 B1/C3 的"对 PRD 的影响"条目未回引模块 PRD | B1 补"详见 mod-04 §4.3/§8.1"，C3 补"详见 mod-01 §8.1" |
| N20 | omniagent-prd.md | NFR 之间依赖关系未显式陈述（如 Prompt cache 命中率依赖 M1 prefix cache + M7 STATIC_DYNAMIC_BOUNDARY） | 补"NFR 依赖关系"章节或在 §5 各指标下标注 |

---

## 4. 修复优先级建议

### 4.1 P0 修复（M1 开工前必须完成，影响 M1 涉及模块）

M1 Walking Skeleton 涉及 mod-01/02/03/07，以下问题在 M1 开工前必须修复：

| 优先级 | 问题 | 影响模块 | 修复工作量 |
|--------|------|---------|-----------|
| P0 | K14 9 场景错误恢复矩阵补全 | mod-07（M1 涉及） | 大（需写 9 行恢复策略） |
| P0 | K15 4 种视图语义补全 | mod-07（M1 涉及） | 小（4 行描述） |
| P0 | K16 resume 95% 路径映射 | mod-07（M1 涉及） | 中（依赖 K14） |
| P0 | K17 mod-07 §7 不变量守护测试用例 | mod-07（M1 涉及） | 中（3 项测试用例设计） |
| P0 | K21 COMPACTABLE_TOOLS 命名一致 | mod-07 + mod-03（M1 涉及） | 小（统一工具名） |
| P0 | K12 评测集就绪状态统一 | 总体 PRD + 冻结记录 | 小（统一描述） |
| P0 | N1-N4 §8 子节结构补全 | mod-02/03/05/06 | 小（补占位子节） |
| P0 | N11 memory frontmatter 格式 | mod-07 | 小（补 schema） |
| P0 | N13 ToolResult 类型定义 | mod-03 | 小（补类型定义） |

### 4.2 P1 修复（M2 开工前必须完成，影响多 Agent 协作）

M2 多 Agent 协作涉及 mod-05，以下问题在 M2 开工前必须修复：

| 优先级 | 问题 | 影响模块 |
|--------|------|---------|
| P1 | K1 M5 §5 补 M6 交互 | mod-05（M2 涉及） |
| P1 | K2 CompactBoundary→rewind 契约 | mod-05 + mod-07 |
| P1 | K5 M6 确认 #5 byte-identical | mod-06 |
| P1 | K6 agent_router 失败模式 | mod-03 + mod-05 |
| P1 | K7 跨模块函数接口签名 | 多模块 |
| P1 | K9 sidechain 并发控制 | mod-07 + mod-05 |

### 4.3 P2 修复（M3 开工前必须完成，影响安全纵深）

M3 安全纵深涉及 mod-04，以下问题在 M3 开工前必须修复：

| 优先级 | 问题 | 影响模块 |
|--------|------|---------|
| P2 | K18 mod-04 §7 不变量守护测试用例 | mod-04（M3 涉及） |
| P2 | K19 DenialTracking 语义统一 | mod-04 |
| P2 | K20 沙箱降级 4 deny 路径交叉引用 | mod-04 |
| P2 | N7 27 事件矩阵补全 | mod-04 |
| P2 | N8/N9 Prompt Injection 防御细节 | mod-04 |
| P2 | N10 监控系统上报机制 | mod-04 |

### 4.4 P3 修复（GA 前完成即可）

| 优先级 | 问题 | 说明 |
|--------|------|------|
| P3 | K3/K4 事件归属与 sandbox 保护双向确认 | 跨模块文档对齐 |
| P3 | K8 事件 payload 契约 | 跨模块事件 payload 定义 |
| P3 | K10 接口契约版本兼容策略 | 总体 PRD 新增章节 |
| P3 | K11 v2.x/v3.x 分类统一 | 文档一致性 |
| P3 | K13 关键路径标注 | 总体 PRD §4.2 标注 |
| P3 | N5/N6/N12 mod-04/mod-07 细节 | 各模块补全 |
| P3 | N14 60+ 工具清单补全 | mod-03 补完整清单 |
| P3 | N15-N20 各类细节 | 文档完善 |

---

## 5. 签字建议

### 5.1 当前状态

按 checklist §10.2 通过标准："不通过：≥ 4 项 checklist 项有遗留，或任何关键项有遗留"。当前 **21 项关键项 ☐**，4 个角色自审全部判 FAIL。

**不能签字**。所有模块 PRD 状态保持"M0 已冻结"，不升级为"已 review 冻结"。

### 5.2 签字路径

1. **P0 修复**（M1 开工前必须）：修复 K12/K14/K15/K16/K17/K21 + N1-N4/N11/N13 共 15 项
2. **P0 复审**：4 个 agent 重跑自审，确认 P0 项全部 ☑
3. **M1 开工**：mod-01/02/03/07 升级为"已 review 冻结（M1 范围）"
4. **P1 修复**（M2 开工前）：修复 K1/K2/K5/K6/K7/K9 共 6 项
5. **P1 复审**：架构师 + 交叉确认 agent 重跑
6. **M2 开工**：mod-05 升级为"已 review 冻结（M2 范围）"
7. **P2 修复**（M3 开工前）：修复 K18/K19/K20 + N7-N10 共 7 项
8. **P2 复审**：安全工程师 agent 重跑
9. **M3 开工**：mod-04 升级为"已 review 冻结（M3 范围）"
10. **P3 修复**（GA 前）：修复剩余 P3 项
11. **GA 前复审**：4 个 agent 全量重跑自审，全部 ☑ 后升级全部模块为"已 review 冻结"

### 5.3 风险提示

- **K12（评测集就绪状态矛盾）** 是 P0 中最紧急的——如果 M1 团队误以为评测集"已就绪"而开工，到验收时才发现人工校验未完成，会导致 M1 验收失败返工。建议立即修复。
- **K14（9 场景恢复矩阵）** 是 P0 中工作量最大的——需要设计 9 个场景的检测方式、恢复策略、数据损失预期。建议上下文工程组优先投入。
- **K17/K18（不变量守护测试用例）** 工作量中等但数量多（8 个不变量），建议各模块主负责角色并行编写。

---

## 6. 各 Agent 自审报告索引

| Agent | 范围 | 关键 ☐ | 非关键 ☐ | 报告位置 |
|------|------|--------|----------|---------|
| 1 | 通用（§2）+ 产品（§7） | 0 | 5 | task a7ac91e2c5bcb97c5 输出文件 |
| 2 | 架构师（§3）+ 交叉确认（§8） | 13 | 6 | task a3012a487333fb01d 输出文件 |
| 3 | 安全工程师（§4） | 7 | 6 | task a325bc78e0b80eb13 输出文件 |
| 4 | 上下文工程组（§5）+ 工具组（§6） | 6 | 6 | task a815cf50b7742d2e5 输出文件 |

> 各 agent 详细报告（含每项 ☑/☐ 判定与证据）保存在 task 输出文件中，可按需查阅。

---

## 7. 自审结论

PRD 模块化拆解在**结构与一致性**层面已通过验证（前次 verification agent PASS：内容完整、无重复、交叉引用有效、不变量/NFR/决策覆盖完整、品牌中立性无回归）。

但在**开发指导性**层面（本自审关注点）发现 21 项关键问题，主要集中在：

1. **跨模块接口契约不完整**（K1-K10，10 项）——接口签名/事件 payload/并发控制/失败模式/版本兼容等开发契约缺失，无法直接指导 M1 开发
2. **mod-07 持久化与恢复设计不完整**（K14-K16，3 项）——9 场景恢复矩阵仅列名无策略，resume 95% 路径断裂
3. **不变量守护机制泛标签**（K17-K18，2 项，影响 8 个不变量）——守护机制仅写测试类型名，无具体测试用例设计，无法指导 QA 团队编写守护测试
4. **文档一致性矛盾**（K11-K13，3 项）——v2.x/v3.x 分类、评测集就绪状态、关键路径等内部矛盾

**建议路径**：按 P0→P1→P2→P3 分阶段修复，每阶段修复后重跑对应 agent 自审，确认 ☑ 后再升级模块 PRD 状态。M1 开工前必须完成 P0（15 项），预计工作量 2-3 个角色日。

---

*本自审报告由 4 个并行 self-review agent 完成，由主 agent 汇总去重。报告保存于 `/Users/liguang/ccwork/omniagent/doc/prd/omniagent-prd-self-review-report.md`，作为 review 流程的基线文档。修复完成后各 agent 重跑自审，本报告同步更新。*
