# OmniAgent CLI — 模块 6：Skills 插件系统 (Skills Plugin) PRD

> 模块 ID: M6
> 主负责角色: 工具组
> 阻塞里程碑: M4（扩展生态）
> 源章节: 原总体 PRD §4.4（内容已迁移到本模块 PRD，总体 PRD §4.4 现为评测集归属）
> 状态: M0 已冻结

---

## 1. 模块概述

### 范围（in scope）

- Skill 定义：Prompt + 权限配置 + 工具白名单的声明式封装，基于 Markdown + YAML frontmatter
- 5 种来源：内置 / Bundled / 磁盘 / MCP / Legacy
- 16 字段 frontmatter 规范
- 双模式执行：inline 模式（注入当前 Agent 上下文）+ fork 模式（独立 fork agent 执行）
- 热插拔：文件系统 watch `.omniagent/skills/`，新增/修改/删除即时生效

### 边界（out of scope）

- **工具接口与执行**：由 M3 通用工具系统负责，本模块的 Skills 工具白名单通过 M3 的 `mergeAndFilterTools()` 接入工具池
- **fork agent 的上下文分叉与 sidechain**：由 M5 多 Agent 编排引擎 + M7 上下文与记忆引擎负责，本模块只触发 fork 模式
- **`.omniagent/skills/` 目录的沙箱保护**：由 M4 权限与拦截系统负责（sandbox deny + Safe Properties 30 白名单）

### 在整体架构中的位置

Skills 插件系统是 harness 层的**扩展点**。Skill 是用户自定义的"高级工具"——封装了 Prompt + 权限 + 工具白名单，比 MCP 工具更重（带 prompt 与权限配置），比 Custom Agent 更轻（不定义独立 agent 角色）。Skills 让用户能快速封装团队工作流（如 code-review、commit、review-pr）。

---

## 2. 设计目标

1. **声明式封装**：Skill = Markdown + YAML frontmatter，用户无需写代码即可定义
2. **5 来源分层优先级**：内置 > Bundled > 磁盘 > MCP > Legacy，内置不可覆盖
3. **双模式灵活**：inline 模式共享上下文（轻量），fork 模式独立 sidechain（避免污染）
4. **热插拔**：文件系统 watch，不需重启 OmniAgent CLI
5. **校验容错**：单个 skill 校验失败不影响其他 skill 加载

---

## 3. 核心概念与接口

### 3.1 Skill 定义

Skill 是 **Prompt + 权限配置 + 工具白名单** 的声明式封装，基于 Markdown + YAML frontmatter：

```markdown
---
name: code-review
description: Perform a structured code review on changed files
tools: [read_file, glob, grep, bash]   # 工具白名单
permissions:
  bash: ask
  edit_file: deny                       # code-review 不应修改代码
triggers:
  - /code-review                        # 命令触发
  - PreToolUse: edit_file               # 事件触发（可选）
scope: project                          # project | user | builtin
---

## Instructions
1. Read all changed files via `git diff`
2. Check style, security, performance
3. Output structured review report
```

### 3.2 16 字段 frontmatter 规范

Skill 支持的 16 个 frontmatter 字段：

| 字段 | 用途 |
|------|------|
| `name` | Skill 唯一名 |
| `description` | 描述 |
| `tools` | 工具白名单 |
| `permissions` | 权限配置 |
| `triggers` | 触发条件（命令/事件） |
| `scope` | 作用域（project/user/builtin） |
| `mode` | 执行模式（inline/fork） |
| `async` | 是否异步 |
| `timeout` | 超时 |
| `retry` | 重试策略 |
| `fallback` | 失败降级 |
| `metadata` | 元数据 |
| `version` | 版本 |
| `author` | 作者 |
| `tags` | 标签 |
| `examples` | 示例 |

YAML frontmatter 损坏时启动期校验失败，提示行号，跳过该 skill 不影响其他。

---

## 4. 功能详述

### 4.1 5 种来源

| 来源 | 路径 | 优先级 |
|------|------|--------|
| 内置 | 编译进二进制 | 最高（不可覆盖） |
| Bundled | 随发行版附带 | 高 |
| 磁盘 | `.omniagent/skills/*.md` | 中 |
| MCP | 通过 MCP server 提供 | 低 |
| Legacy | 兼容旧格式 | 最低 |

skill 名与内置命令重名时，内置优先，提示用户改名，不覆盖内置。

### 4.2 双模式执行

- **inline 模式**：Skill 的 prompt 直接注入当前 Agent 上下文，共享工具池与权限。
- **fork 模式**：Skill 在独立 fork agent 执行，独立 sidechain，完成后结果回注。

复杂 Skill（如涉及多轮工具调用）用 fork 模式，避免污染主对话上下文。

### 4.3 热插拔

Skills 支持运行时热加载：
- 文件系统 watch `.omniagent/skills/`，新增/修改/删除即时生效。
- 不需重启 OmniAgent CLI。
- 校验失败的 skill 不影响其他 skill 加载。

---

## 5. 与其他模块的交互

| 交互模块 | 交互方式 | 数据/控制流 |
|---------|---------|------------|
| M3 通用工具系统 | 工具池接入 | Skills 加载后其工具白名单通过 M3 的 `mergeAndFilterTools()` 接入工具池；Skills 触发的工具调用经 M3 执行 |
| M4 权限与拦截系统 | 拦截 | Skills 触发的工具调用经 M4 五层拦截链；`.omniagent/skills/` 目录由 M4 sandbox deny 保护（防注入） |
| M5 多 Agent 编排引擎 | fork 模式 | Skill fork 模式执行时，spawn 独立 fork agent（继承父上下文 + 独立 sidechain），由 M5 提供 fork 路由；fork 模式必须遵循不变量 #5（prompt cache prefix byte-identical，详见 §7） |
| M7 上下文与记忆引擎 | 持久化 | Skill fork 模式的 sidechain transcript 由 M7 持久化；inline 模式注入的 prompt 进入 M7 的上下文管理 |

**Skill fork 模式与不变量 #5 的契约**（澄清 K5）：Skill fork 模式 spawn 的 fork agent 必须遵循不变量 #5（prompt cache prefix byte-identical）。具体要求：
- fork agent 的 system prompt 与父 agent 完全一致（共享 prefix）。
- 工具池继承自父 agent（不重排顺序，避免 prefix hash 变化）。
- 通过占位 `tool_result`（空 content）填充 fork 点之前的所有 `tool_use`，保证 prefix 字节级一致。
- 此要求由 M5 在 fork 路由中守护，M6 触发 fork 时不需额外操作（M5 已封装）。

---

## 6. 模块级非功能性需求

从总体 PRD §5 抽取与本模块相关的 NFR：

### 6.1 性能指标（摘自 §5.2.1）

| 指标 | 目标值 | 测量方式 |
|------|-------|---------|
| Skills 热加载延迟 | 即时（文件系统 watch 触发） | fs watch 埋点 |
| Skills 启动期校验失败不影响其他 | 100% | 启动期校验测试 |

### 6.2 安全 NFR（摘自 §5.1.4）

| NFR | 目标值 |
|-----|-------|
| Skills 目录防注入 | 100%（沙箱 deny + Safe Properties 30 白名单） |
| MCP 工具描述截断 | 2048 字符（Skills 通过 MCP 来源时） |

---

## 7. 模块级不变量

从附录 A 18 项不变量中抽取与本模块相关的条目：

| # | 不变量 | 守护机制 |
|---|--------|---------|
| 10 | sandbox 4 类 deny 路径始终生效（含 `.omniagent/skills/` 防注入） | 沙箱日志校验（M4 守护，本模块依赖） |

**关联不变量**（由其他模块守护但本模块依赖）：
- #4 Coordinator 模式下主 Agent 直接工具调用率 = 0（M3+M5 守护，Skills 在 Coordinator 模式下工具白名单受 `mergeAndFilterTools()` 约束）
- #5 Fork agent 的 prompt cache prefix byte-identical（M5 守护，Skill fork 模式触发时遵循，详见 §5 契约说明）

---

## 8. 开放问题与依赖

### 8.1 已冻结决策（M0）

本模块无直接冻结决策。涉及 Skills 的决策（A4 Hooks function 边界、A3 实验 feature 默认值）由 M4/M5 承接，本模块仅消费决策结果（Skills 触发的工具调用经 M4 拦截链；Skills 不在实验 feature 列表内）。

### 8.2 依赖其他模块的交付物

- M3 通用工具系统：`mergeAndFilterTools()` 接口必须就绪，Skills 工具白名单接入工具池
- M4 权限与拦截系统：`.omniagent/skills/` 目录的沙箱 deny 保护必须就绪
- M5 多 Agent 编排引擎：fork 路由必须就绪（Skill fork 模式依赖，遵循不变量 #5 byte-identical）
- M7 上下文与记忆引擎：sidechain 持久化必须就绪（Skill fork 模式依赖）

### 8.3 评测集引用

本模块无直接评测集依赖。涉及 Skills 的验收（5 来源加载、16 字段 frontmatter 校验、热插拔延迟）通过启动期校验测试覆盖，不单独建评测集。

### 8.4 v2.x 演进项

- Skills 签名校验（用户 Skills 经 GPG 签名 + 白名单登记，防恶意 Skills）
- Skills 市场（社区共享 Skills）
- Skills 与 Custom Agents 合并（统一扩展点）

---

## 9. 参考链接

- 总体 PRD：`omniagent-prd.md` §4.4
- 冻结决策记录：`omniagent-prd-decisions.md`
- 相关模块：M3 通用工具系统、M4 权限与拦截系统、M5 多 Agent 编排引擎、M7 上下文与记忆引擎
- 里程碑：M4 扩展生态（Skills 5 来源 + 16 frontmatter 字段 + Custom Agents 完整支持）
