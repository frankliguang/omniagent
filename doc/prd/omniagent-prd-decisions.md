# OmniAgent CLI PRD 未决问题评审冻结记录

> 评审日期：2026-07-08
> 评审依据：OmniAgent CLI PRD v1.0 §6.2 M0 未决问题清单
> 评审范围：10 项未决问题（PRD §6.2 列 5 项 + 通读全 PRD 补充 5 项）
> 评审方式：4 项 P0 决策经问卷收集，6 项 P1 决策按一致性推导推荐默认值冻结
> 状态：**已冻结**（M0 产出物，作为 M1-M5 开工前置门槛）
>
> **模块化拆解说明**（2026-07-08）：PRD 已拆解为 1 份总体 PRD + 7 份模块 PRD。本记录中"对 PRD 的影响"列出的章节号仍有效（总体 PRD 保留章节骨架），但详细技术内容已迁移到对应模块 PRD，相关条目后标注"详见 mod-XX §Y"。模块 PRD 文件命名：`omniagent-prd-mod-{01-07}-*.md`。模块映射见总体 PRD §4.1 模块索引表。

---

## 一、决策总览

| # | 问题 | 决策 | 拍板人 | 阻塞里程碑 | 优先级 |
|---|------|------|--------|-----------|--------|
| A1 | Risk Classifier 误报/漏报阈值 | **严格**：漏报≤3%，误报≤15% | 安全工程师+产品 | M3 | P0 |
| A2 | Risk Classifier 决策模型 | 规则表（fast）+ 云端轻量级 LLM（thinking） | 架构师+安全工程师 | M3 | P0 |
| A3 | 实验 feature 默认值 | **全部 off**，env 显式启用 | 产品 | GA | P0 |
| A4 | Hooks function 边界 | 仅内置 function（v1.0） | 安全工程师 | M4 | P1 |
| B1 | Windows NAPI 支持 | 不支持，沿用 Node 兼容层 | 架构师 | M1 | P0 |
| B2 | Windows 沙箱方案 | 纯权限规则 + 推荐 WSL | 安全工程师+产品 | M1 | P0 |
| B3 | Cloudflare Worker 边缘代理 | 支持 + Deno Deploy 兜底 | DevOps | M4 | P1 |
| C1 | Fallback model 链策略 | 同 provider 内自动降级（v1.0），跨 provider M2 后补 | 架构师 | M1 | P0 |
| C2 | 记忆召回机制 | 轻量级 LLM 召回 | 架构师+上下文工程组 | M1 | P0 |
| C3 | 多语言 SDK 协议 | v1.0 仅 TypeScript SDK，Python/Go 延后到 M4 | 架构师 | M4 | P1 |
| D1 | 包名/命令名 | 包名 `omniagent-cli`，命令 `omniagent` | 产品 | M1 发布前 | P1 |
| D2 | 内部代号重命名映射 | 按 PRD §6.1 步骤 1 的 9 项映射冻结 | 架构师 | 重构步骤 1 | P1 |

---

## 二、详细决策记录

### A1. Risk Classifier 误报/漏报阈值

**决策**：严格档（漏报≤3%，误报≤15%）

**理由**：
- 用户选择严格档而非推荐的平衡档，表明 OmniAgent CLI 目标用户含强合规场景（金融/政府/医疗）。
- 错误代价不对称分析支持更严的漏报阈值：漏报=越权执行（不可逆，安全风险），误报=用户被打断（可接受）。
- 严格档对 Risk Classifier 的准确率要求更高，直接影响 A2 决策（必须用 LLM，不能纯规则）。

**对 PRD 的影响**：
- §4.2.5 Risk Classifier 置信度分流需调整：高置信度≥0.95 → 自动批准；中置信度 0.8-0.95 → ask；低置信度<0.8 → needs_review（详见 mod-04 §4.1）。
- §2.1 目标用户群体占比需调整：安全工程师占比从 12% 提升到 18%，新增"金融/政府合规工程师"细分（总体 PRD 保留）。
- §5.1.4 Risk Classifier 评测集规模需扩大：从 ≥50 条提升到 ≥100 条标注 bash，覆盖更多合规相关命令模式（详见 mod-04 §6.1 + §8.3）。
- M3 前置门槛中 yoloClassifier 评测集的验收阈值更新为漏报≤3% / 误报≤15%（详见 mod-04 §8.3）。

### A2. Risk Classifier 决策模型

**决策**：规则表（fast 阶段）+ 云端轻量级 LLM（thinking 阶段）

**理由**：
- A1 选择严格档（漏报≤3%），纯规则表表达不到该准确率，必须有 LLM 参与。
- v1.0 简化优先：云端轻量级 LLM（如 GPT-4o-mini / Claude Haiku / DeepSeek-V3-lite 级别）准确率高、零运维。
- 合规场景的本地小模型方案延后到 v2.x，届时提供 `OMNIAGENT_RISK_CLASSIFIER_LOCAL=1` 环境变量切换。

**对 PRD 的影响**：
- §4.2.5 Risk Classifier 两阶段明确：Fast 阶段（规则表，<100ms）+ Thinking 阶段（云端轻量级 LLM，~1s）（详见 mod-04 §4.1）。
- §3.2 LLMProvider 接口的 `capabilities` 字段需新增 `supportsRiskClassification` 标记，标识该 provider 是否适合做 Risk Classifier（要求低延迟、低成本）（详见 mod-01 §3.1）。
- M3 前置门槛新增"Risk Classifier 模型选型确认"，需在 M3 启动前确定具体用哪个云端轻量级 LLM（详见 mod-04 §8.2）。

### A3. 实验 feature 默认值

**决策**：全部 off，env 显式启用

**理由**：
- v1.0 透明优先，降低用户对"隐藏功能"的不信任感。
- 开源项目中立原则：不替用户预设哪些实验功能该开。
- 降低 v1.0 风险面，实验 feature 不稳定行为不影响默认用户体验。

**对 PRD 的影响**：
- §6.2 M0 未决问题表中"默认开启哪些内部实验 feature"冻结为"全部 off"（总体 PRD 保留）。
- 环境变量命名规范：`OMNIAGENT_TASK_SCHEDULER=1` / `OMNIAGENT_PROACTIVE_PLANNER=1` / `OMNIAGENT_COVERT_MODE=1` / `OMNIAGENT_WORKFLOW_ORCHESTRATOR=1` / `OMNIAGENT_TEAM_RECOMMENDER=1` / `OMNIAGENT_CONTEXT_ANCHOR=1`（详见 mod-05 §4.4 工作流编排器）。
- 文档需明示这些 feature 是实验性的，API 行为可能在 v2.x 变更（详见 mod-05 §4.4）。
- v2.x 路线图中评估哪些 feature 转为默认 on（需基于使用率与稳定性数据）（详见 mod-05 §8.3）。

### A4. Hooks function 边界

**决策**：仅内置 function（v1.0），用户用 command/http hook

**理由**：
- v1.0 最安全，避免用户自定义 JS/TS 函数的代码注入风险。
- command hook（执行 shell 命令）+ http hook（调用外部端点）已覆盖 90% 扩展需求。
- 签名+白名单机制复杂度高，延后到 M4 后评估。

**对 PRD 的影响**：
- §4.2.6 Hooks 6 种类型中，`function` 类型在 v1.0 仅限内置扩展（如 `execCommandHook` 回调），用户配置文件中不支持 `type: function`（详见 mod-04 §4.2）。
- v2.x 评估放开签名机制：用户 function 须经过 GPG 签名 + 白名单登记（详见 mod-04 §8.4）。

### B1. Windows NAPI 支持

**决策**：不支持，沿用 Node 兼容层

**理由**：
- M1 立即开工优先，Windows NAPI 增加原生模块构建复杂度。
- Node.js 兼容层在 Windows 上性能可接受（非核心场景）。
- v2.x 评估 Windows NAPI 支持，基于用户反馈与性能基线数据。

**对 PRD 的影响**：
- §5.3 兼容性矩阵中 Windows 性能基线标注"弱（Node 兼容层）"。
- 文档明示 Windows 用户推荐使用 WSL 获得更好体验（详见 mod-04 §4.3 + §8.4）。

### B2. Windows 沙箱方案

**决策**：纯权限规则 + 推荐 WSL

**理由**：
- Windows 原生沙箱方案不成熟，bubblewrap/sandbox-exec 无 Windows 等价物。
- 强制 WSL 会增加用户安装负担，不符合 v1.0 易用性目标。
- 纯权限规则 + 文档明示 + 推荐 WSL 是最佳平衡。

**对 PRD 的影响**：
- §5.1.1 沙箱矩阵中 Windows 行标注"纯权限规则，推荐 WSL"（详见 mod-04 §4.3）。
- §5.1.4 安全 NFR 指标中 Windows 沙箱逃逸拦截率不设目标（无沙箱）（详见 mod-04 §6.1）。
- 文档需有"Windows 用户安全建议"章节，推荐 WSL2 + bubblewrap（详见 mod-04 §4.3）。

### B3. Cloudflare Worker 边缘代理

**决策**：支持 + Deno Deploy 兜底

**理由**：
- Cloudflare Worker 限流是不可控风险，需有兜底方案。
- Deno Deploy 与 Cloudflare Worker API 兼容度高，切换成本低。
- 远程协作场景的高可用值得额外运维成本。

**对 PRD 的影响**：
- §5.3.5 分发渠道中 Cloudflare Worker 标注"主，限流时切 Deno Deploy"。
- DevOps 需准备双部署模板（Cloudflare Worker + Deno Deploy）。
- 监控需同时覆盖两个边缘节点，限流时自动切换。

### C1. Fallback model 链策略

**决策**：同 provider 内自动降级（v1.0），跨 provider M2 后补

**理由**：
- v1.0 简化优先：同 provider 内降级（如 GPT-4 → GPT-4o-mini）配置简单，无认证复杂度。
- 跨 provider 降级（OpenAI 失败切 Bedrock）涉及多 provider 认证状态管理，复杂度高。
- M2 后补跨 provider 容灾，基于 v1.0 用户反馈确定必要性。

**对 PRD 的影响**：
- §3.3.2 模型降级 5 步明确为"同 provider 内降级"（详见 mod-02 §4）。
- 配置文件 schema 新增 `fallbackModel` 字段（单值，同 provider 内）（详见 mod-01 §3.1）。
- v2.x 路线图新增"跨 provider fallback chain"特性（详见 mod-01 §8.4 + mod-02 §8.3）。

### C2. 记忆召回机制

**决策**：轻量级 LLM 召回

**理由**：
- recall@5≥0.8 的指标要求高，本地 embedding 模型精度可能不达标。
- 轻量级 LLM 召回准确率高，API 成本可控（每次召回 ~256 tokens）。
- 合规场景的本地 embedding 方案延后到 v2.x。

**对 PRD 的影响**：
- §4.5.3 召回机制明确为"轻量级 LLM 召回，max_tokens=256"（详见 mod-07 §4.1）。
- LLMProvider 接口需支持配置"召回用模型"（可与主对话模型不同，用更便宜的）（详见 mod-01 §3.1）。
- M1 前置门槛中 findRelevantMemories 评测集（≥30 条标注会话）必须就绪，验收 recall@5≥0.8 / precision@5≥0.7（详见 mod-07 §8.3）。
- 成本追踪需单独统计召回 LLM 调用成本（详见 mod-07 §4.1）。

### C3. 多语言 SDK 协议

**决策**：v1.0 仅 TypeScript SDK，Python/Go 延后到 M4

**理由**：
- v1.0 聚焦核心 CLI 能力，多语言 SDK 是生态扩展，延后合理。
- TypeScript SDK 覆盖 Node.js 生态，已是主流开发者群体。
- Python/Go SDK 的协议选型（子进程 vs gRPC）在 M4 启动前再决，基于 v1.0 用户反馈。

**对 PRD 的影响**：
- §5.3.4 多语言 SDK 调整为"v1.0 仅 TypeScript，M4 启动 Python/Go 选型"（详见 mod-01 §8.1 决策 C3）。
- v1.0 GA 范围不含 Python/Go SDK。

### D1. 包名/命令名

**决策**：包名 `omniagent-cli`，命令 `omniagent`

**依据**：npm registry 查询（2026-07-08）：
- `omniagent` — 已占用
- `omniagent-cli` — **可用（404）**
- `omni-agent` — 可用（404）
- `omni-agent-cli` — 已占用
- `oa-cli` — 已占用
- `omniagentcli` — 可用（404）

**理由**：
- `omniagent-cli` 明确表达"OmniAgent 的 CLI"，语义清晰。
- 命令 `omniagent` 通过 package.json 的 bin 字段映射，与包名解耦。
- 备选名 `omni-agent`（连字符版本）作为备选，若 `omniagent-cli` 后续被抢注可切换。

**对 PRD 的影响**：
- §1.2 产品定位表中包名确认为 `omniagent-cli`，入口命令为 `omniagent`。
- 短别名 `oa` 不再作为官方别名（避免与未来 npm 包冲突），用户可自行 alias。
- 发布前需在 npm 注册 `omniagent-cli` 包名（建议同时注册 `omni-agent` 作为保护性占位）。

### D2. 内部代号重命名映射

**决策**：按 PRD §6.1 步骤 1 的 9 项映射冻结

| 原代号 | 新名称 |
|--------|--------|
| KAIROS | Task Scheduler |
| PROACTIVE | Proactive Planner |
| Undercover | Covert Mode |
| BUDDY | Risk Classifier |
| ULTRAPLAN | Workflow Orchestrator |
| TEAMMEM | Team Recommender |
| Lodestone | Context Anchor |
| yoloClassifier | Risk Classifier |
| firstParty | Direct API Provider |

**对 PRD 的影响**：
- 全局代码、文档、配置文件、环境变量统一使用新名称。
- 环境变量命名规范：`OMNIAGENT_TASK_SCHEDULER` / `OMNIAGENT_RISK_CLASSIFIER` 等（全大写下划线）。

---

## 三、冻结声明

1. **本记录自 2026-07-08 起冻结**，作为 M1-M5 各里程碑开工的前置门槛。
2. **冻结的决策项**在 v1.0 GA 前不得变更；如需变更，需走"解冻流程"（见下节）。
3. **未列入本记录的决策项**按 PRD 默认值执行，不视为冻结。
4. **本记录是 PRD 的附件**，与 PRD 具有同等约束力；PRD 相关章节需按本记录更新。

---

## 四、解冻流程

如需变更已冻结的决策：

1. **发起**：任一利益相关者可发起解冻申请，提交至架构师。
2. **评估**：架构师评估变更影响范围，确定是否需要重新评审。
3. **评审**：影响 P0 项的变更需原拍板人 + 架构师 + 产品三方签字；影响 P1 项的变更需原拍板人签字。
4. **记录**：解冻后更新本记录，标注"变更日期 / 变更理由 / 变更影响"，旧决策保留为历史记录。
5. **通知**：变更后通知所有相关里程碑负责人，评估对排期的影响。

---

## 五、后续行动项

基于本冻结记录，以下行动项需在对应里程碑启动前完成：

| 行动项 | 负责人 | 截止时间 | 状态 |
|--------|--------|---------|------|
| 更新 PRD §4.2.5 Risk Classifier 置信度分流（严格档） | 架构师 | M3 启动前 | 已完成 |
| 更新 PRD §2.1 目标用户占比（安全工程师提升到 18%） | 产品 | M1 启动前 | 已完成 |
| 扩大 Risk Classifier 评测集到 ≥100 条标注 bash | 安全工程师 | M3 启动前 | AI 种子完成（119 条），**待人工校验冻结**（人工校验前不视为"已就绪"） |
| findRelevantMemories 评测集 ≥30 条标注会话 | 上下文工程组 | M1 启动前 | AI 种子完成（30 条），**待人工校验冻结**（人工校验前不视为"已就绪"） |
| 更新 PRD §3.2 LLMProvider 接口（新增 supportsRiskClassification） | 架构师 | M3 启动前 | 已完成 |
| npm 注册 `omniagent-cli` 与 `omni-agent` 保护性占位 | 产品 | M1 发布前 | 待办（发布操作，非文档） |
| 更新 PRD §5.1.1 沙箱矩阵（Windows 行标注纯权限规则） | 架构师 | M1 启动前 | 已完成 |
| 更新 PRD §5.3.4 多语言 SDK 范围（v1.0 仅 TypeScript） | 架构师 | M1 启动前 | 已完成 |
| 更新 PRD §3.3.2 模型降级 5 步（同 provider 内降级） | 架构师 | M1 启动前 | 已完成 |
| 更新 PRD §6.2 M0 未决问题表（标注已冻结） | 架构师 | 即时 | 已完成 |

**完成情况说明**（2026-07-08 第二次更新）：

- 7 项文档更新行动项已于 2026-07-08 完成，PRD 各章节已按冻结决策更新完毕。**2026-07-08 PRD 已完成模块化拆解**：原 1257 行单体 PRD 已 lean 化为约 620 行总体产品方案（`/Users/liguang/ccwork/omniagent/doc/prd/omniagent-prd.md`）+ 7 份模块 PRD（`omniagent-prd-mod-01-07-*.md`，同目录下）。本记录中各决策"对 PRD 的影响"列出的章节号在总体 PRD 中保留为骨架，详细技术内容已迁移到对应模块 PRD（条目后标注"详见 mod-XX §Y"）。模块映射见总体 PRD §4.1 模块索引表。
- 2 项评测集行动项 AI 种子已完成（2026-07-08），**仍需人工校验冻结后才能视为"已就绪"**（M1/M3 启动前 P0 前置门槛）：
  - **Risk Classifier 评测集**：119 条标注 bash 命令（覆盖 24 项 bashSecurity + 5 类合规扩展 + 2 类边界用例），见 `/Users/liguang/ccwork/omniagent/eval/risk-classifier/`。漏报率/误报率验收待 M3 Risk Classifier 上线后测试。
  - **findRelevantMemories 评测集**：30 条标注会话（覆盖 4 种 memory 类型 + 6 种召回场景），见 `/Users/liguang/ccwork/omniagent/eval/memory-recall/`。recall@5/precision@5 验收待 M1 召回机制开发后测试。
  - 评测集覆盖度验证脚本 `coverage_check.py` 已运行通过（20 项检查全 PASS）。
  - 评测集仍需安全工程师 + 上下文工程组人工校验后冻结（见评测集 README §3.2 工作流）。**在人工校验冻结完成前，不能视为"已就绪"，M1/M3 不能开工**。
- 1 项非文档行动项仍待办：
  - **npm 注册**：发布前操作，需在 M1 发布前完成 `omniagent-cli` 注册与 `omni-agent` 保护性占位。
- M0 里程碑正式收尾，M1（Walking Skeleton）的前置门槛（findRelevantMemories 评测集）AI 种子已完成（30 条），但需人工校验冻结后 M1 才可开工。

---

*本记录是 OmniAgent CLI PRD v1.0 的附件 A，与 PRD 主体具有同等约束力。所有 M1-M5 里程碑的开工前置门槛以本记录为准。PRD 已于 2026-07-08 完成模块化拆解，本记录引用的 PRD 章节号在总体 PRD 中保留骨架，详细内容见对应模块 PRD（详见本记录开头"模块化拆解说明"）。*
