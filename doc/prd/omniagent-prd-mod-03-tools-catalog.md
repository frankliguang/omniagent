# OmniAgent CLI — 内置工具目录 (Tools Catalog)

> 模块: M3 工具系统
> 主负责角色: 工具组
> 阻塞里程碑: M1（Walking Skeleton，文件 + Shell + Agent Router 必须就绪）
> 引用基线: PRD mod-03 §4.1（仅列示例）/ L3-M3 §3.3（仅补实施要点）/ `omniagent-types.ts` §7 `Tool` 接口 / §13 `COMPACTABLE_TOOLS` 白名单 / §14 `mergeAndFilterTools` 签名 / risk-classifier `spec.md` §3（C01-C24 共 24 项 bashSecurity 类别）
> 状态: M0 草稿（M1 开工前由工具组冻结）

---

## 1. 文档定位与不重复原则

### 1.1 范围

本 catalog 是 M3 内置工具的**权威清单**，列出 v1.0 全部 60 个内置工具的：

- **完整 `description`**（≤ 2048 字符，供 LLM 调用决策；超长截断由 `buildTool()` 工厂守护，不变量 #15）
- **完整 `inputSchema`**（JSON Schema 标准化，参数名/类型/必填/描述）
- **角色可用性矩阵**（main / worker / custom / teammate / fork 是否可用；coordinator 由 `mergeAndFilterTools()` 硬移除 bash/edit_file/write_file 3 个 + M4 Layer 2 权限规则软 deny 其余 23 个写/破坏性/外部工具，端到端守护不变量 #4）
- **abortSignal 协同模式分类**（A/B/C/D 四类，见 §2.4）
- **`compactable` 标注**（是否在 `COMPACTABLE_TOOLS` 8 个白名单内）
- **错误码映射**（每工具可能抛出的 `OmniAgentErrorCode`，引用 L2 §6）
- **测试要点**（每工具至少 2 条断言，引用 PRD mod-03 §7 不变量测试用例）

### 1.2 不重复原则

以下内容已在 PRD/L2/L3-M3/types.ts 定义，本 catalog 仅引用，不重述：

| 不重复内容 | 引用源 |
|-----------|--------|
| `Tool` 接口规范（5 项元数据 + 2 方法） | PRD mod-03 §3.1 + types.ts §7 |
| `buildTool()` 工厂 fail-closed 默认值 | L3-M3 §2.2.1 + §3.1.1 |
| `mergeAndFilterTools()` 实现（6 角色过滤规则） | L3-M3 §2.2.4 + §3.2.1 + types.ts §14 |
| Bash 24 项安全校验（C01-C24） | risk-classifier `spec.md` §3 + L3-M3 §3.4 |
| `BashSecurityChecker` 类 | L3-M3 §2.2.5 |
| `MCPClient` + 7 传输层 | L3-M3 §2.2.8 + §2.2.9 + §3.6 |
| `LazyToolLoader` TF-IDF 召回 | L3-M3 §2.2.10 + §3.5 |
| `ToolError` 统一错误类型 | L3-M3 §2.2.11 |
| 工具池不可变快照（写时复制 + Object.freeze） | L3-M3 §3.7 + L2 §5 |
| 工具调用埋点 schema | L3-M3 §3.10 |

### 1.3 工具总数

v1.0 内置工具总数 **60 个**（达成 PRD mod-03 §4.1「≥ 60」目标），按 7 类分组：

| 类别 | 工具数 | 章节 |
|------|--------|------|
| 文件工具 | 8 | §4 |
| Shell 工具 | 6 | §5 |
| Agent 工具 | 7 | §6 |
| 规划工具 | 6 | §7 |
| Web 工具 | 4 | §8 |
| MCP 工具 | 8 | §9 |
| 系统工具 | 21 | §10 |
| **合计** | **60** | |

---

## 2. 通用规则

### 2.1 fail-closed 默认值（引用 types.ts §7）

未显式声明的工具元数据按以下默认值（最保守）：

| 元数据 | 默认值 | 含义 |
|--------|--------|------|
| `isReadOnly` | `false` | 默认假定会修改状态 |
| `isDestructive` | `true` | 默认假定不可逆 |
| `isConcurrencySafe` | `false` | 默认假定不可并发 |
| `isBackground` | `false` | 默认非长任务 |

每个工具的 §4-§10 详目必须显式声明 4 项元数据，不依赖默认值。

### 2.2 描述 2048 截断（不变量 #15）

`description` 字段 > 2048 字符由 `buildTool()` 自动截断 + 记入 `mergeAndFilterTools()` 返回的 `errors` 数组。MCP 工具描述同规则（L3-M3 §3.6.2）。CI 强制门控测试见 PRD mod-03 §7 不变量 #15。

### 2.3 角色可用性矩阵（引用 types.ts §14 + L3-M3 §3.2.1）

| 角色 | 可用工具集 | 守护机制 |
|------|-----------|---------|
| `main` | 全部 60 个 | 默认主线程，无过滤 |
| `coordinator` | **默认白名单**：仅编排 + 只读工具（约 24 个，见 §3 表 `coordinator=✓/△` 行）；写/破坏性/外部工具（26 个，见 §3 表 `coordinator=−` 行）全部禁用 | `mergeAndFilterTools()` **硬移除** 3 个（`bash`/`edit_file`/`write_file`，PRD §3.2 + L3-M3 §3.2.1 + 不变量 #4）+ M4 Layer 2 权限规则 **软 deny** 其余 23 个写/破坏性/外部工具（Coordinator Mode 下默认 `decision='deny'`，实现"主 agent 只编排不执行"端到端守护） |
| `worker` | Coordinator 分配的白名单子集 | `customAgentTools` 参数传入 |
| `custom` | `.omniagent/agents/*.md` 定义的白名单 | `customAgentTools` 参数传入 |
| `teammate` | Swarm 团队成员白名单 | `customAgentTools` 参数传入 |
| `fork` | 继承父 agent 工具池（byte-identical） | M5 `ForkAgentSpawner` 守护（不变量 #5） |

**特殊规则**：
- `coordinator` 角色调用 `bash`/`edit_file`/`write_file` 的请求由 `mergeAndFilterTools()` 在工具池构建时即移除（不在 `filtered` 数组中）；M4 Layer 2 是二次校验（不变量 #4 测试用例 (a)(b)(c)）。
- `coordinator` 角色调用其他 23 个写/破坏性/外部工具（如 `notebook_edit`/`file_move`/`powershell`/`tmux`/`kill_process`/`web_submit`/`mcp_call`/`mcp_connect`/`mcp_disconnect`/`execute_extra_tool`/`extra_tools_unload`/`config_set`/`config_reset`/`skill_install`/`skill_uninstall`/`session_create`/`session_resume`/`session_delete`/`memory_write`/`memory_delete`/`rewind`/`cron_create`/`cron_delete`）的请求由 M4 Layer 2 权限规则在 Coordinator Mode 下默认 deny（不变量 #4 测试用例 (d)：统计 Coordinator 会话全程主 agent 直接调用写工具的次数 = 0）。
- `fork` 角色的工具池 byte-identical 复制父池，包括父池的 `removed` 历史（不变量 #5）。
- 6 角色 × 60 工具的可视化矩阵见 §3 登记表。

### 2.4 abortSignal 协同模式分类

| 类别 | 协同方式 | 适用工具 | abort 后行为 |
|------|---------|---------|-------------|
| A 类（HTTP fetch） | `fetch(url, { signal: ctx.abortSignal })` | `web_fetch` / `web_search` / `web_click` / `web_submit` / `mcp_call`（http/sse/ws 传输层） | 抛 `AbortError`，转 `is_error=true` + `content=[{type:'text', text:'aborted by user'}]` |
| B 类（子进程） | `ChildProcess.kill('SIGTERM')`，超时 120s 默认 | `bash` / `powershell` / `tmux` | 子进程 SIGTERM 终止，stdout 已收部分返回 |
| C 类（M5 编排） | 通过 M5 `ShutdownHandshake` 四步握手（sendRequest/handleRequest/waitForResponse 30s timeout 不强杀） | `agent_router`（async/fork/teammate）/ `task_stop` / `mcp_disconnect` / `skill_invoke`（fork 模式） | 子 agent 收到 shutdown_request 后清理退出，不变量 #6 |
| D 类（无 abort） | 原子本地操作，无 abort 信号 | `read_file` / `edit_file` / `write_file` / `glob` / `grep` / `notebook_edit` / `file_stat` / `file_move` / `kill_process` / `process_list` / `env_get` / `send_message` / `task_create` / `task_output` / `task_list` / `task_get` / `plan_*` / `todo_*` / `mcp_list` / `mcp_connect` / `search_extra_tools` / `extra_tools_list` / `extra_tools_unload` / `cron_create` / `cron_list` / `cron_delete` / `config_get` / `config_set` / `config_list` / `config_reset` / `skill_list` / `skill_invoke`（inline 模式） / `skill_install` / `skill_uninstall` / `session_create` / `session_resume` / `session_list` / `session_delete` / `memory_write` / `memory_read` / `memory_list` / `memory_delete` / `rewind` / `compact` | 操作原子完成或失败，无中间态 |

引用：L3-M3 §3.8「内置工具的 abortSignal 协同」。

### 2.5 COMPACTABLE_TOOLS 白名单（引用 types.ts §13）

8 个工具的 `ToolResult.metadata.compactable=true`，结果可被 M7 摘要压缩：

```
['bash', 'edit_file', 'read_file', 'write_file', 'glob', 'grep', 'task_output', 'web_fetch']
```

其他 52 个工具的结果 `compactable=false`（保留完整语义）。M7 压缩决策见 L3-M7 §3.5（三层压缩策略）+ PRD mod-07 §4.2。

### 2.6 错误码映射（引用 L2 §6.1）

L2 §6.1 定义 26 个统一错误码（types.ts §18 `OmniAgentErrorCode`）。本 catalog 引用其中与工具相关的 12 个 + 扩展 7 个工具特定子码（细化 `TOOL_EXECUTION_ERROR` 的具体场景，供 LLM 做重试/降级决策；不在 types.ts §18 枚举内，由各工具实现层抛出，统一映射到 `TOOL_EXECUTION_ERROR` + `detail` 字段）：

**L2 §6.1 通用错误码（types.ts §18 枚举内，12 个）**：

| 错误码 | 含义 | 触发工具 |
|--------|------|---------|
| `TOOL_EXECUTION_ERROR` | 工具执行失败（非权限非超时；包含下方 7 个工具特定子码） | 全部工具 |
| `TOOL_TIMEOUT` | 工具执行超时 | A/B/C 类工具 |
| `TOOL_PERMISSION_DENIED` | M4 五层拦截链 deny | 全部工具（前置） |
| `USER_INTERRUPT` | 用户 Ctrl+C / `/exit` / abort 主动中断（含 A/B/C 类 abort 后的 ToolResult） | 全部工具 |
| `PERSISTENCE_IO_ERROR` | 文件/存储 IO 失败 | 文件工具 / `session_*` / `memory_*` |
| `PERSISTENCE_CORRUPTION` | JSONL/JSON 解析失败 | `session_resume` / `memory_read` / `config_get` |
| `MAILBOX_FULL` | mailbox 容量超限 | `send_message` |
| `MAILBOX_LOCKED` | mailbox 锁竞争失败 10 次退避后 | `send_message` |
| `SANDBOX_FAILED` | sandbox-exec/bubblewrap 启动失败 | `bash` / `powershell` |
| `RISK_CLASSIFIER_FAILED` | Risk Classifier 两阶段都失败（fail-closed deny） | `bash` |
| `BUDGET_EXCEEDED` | 预算超限（maxPerTurn / maxTotal） | 全部工具（M4 Layer 5） |
| `PROVIDER_TIMEOUT` | LLM 调用超时（仅 `web_search` 走 LLM 路径时） | `web_search` |

**工具特定子码（catalog 扩展，统一映射到 `TOOL_EXECUTION_ERROR` + `detail`，7 个）**：

| 子码 | 含义 | 触发工具 |
|--------|------|---------|
| `MCP_CONNECTION_ERROR` | MCP server 连接失败 | `mcp_call` / `mcp_connect` |
| `MCP_TOOL_NOT_FOUND` | MCP 工具名不存在 | `mcp_call` / `execute_extra_tool` |
| `TASK_NOT_FOUND` | task_id 不存在 | `task_stop` / `task_output` / `task_get` |
| `SKILL_NOT_FOUND` | skill name 不存在 | `skill_invoke` / `skill_uninstall` |
| `SESSION_NOT_FOUND` | session_id 不存在 | `session_resume` / `session_delete` |
| `MEMORY_NOT_FOUND` | memory key 不存在 | `memory_read` / `memory_delete` |
| `CRON_CONFLICT` | cron schedule 冲突 | `cron_create` |

**未在本 catalog 列出但 L2 §6.1 已定义**（14 个，与工具无直接关联）：`PROVIDER_5XX` / `PROVIDER_429` / `PROVIDER_AUTH_FAILED` / `PTL_ERROR` / `AUTOCOMPACT_CIRCUIT_BREAKER` / 9 个 `SCENARIO_*` 场景恢复码（见 L2 §6.1.1 / §6.1.3 / §6.1.8）。

错误呈现策略（L2 §6.4）：
- **给用户**：简短可读（如「文件不存在：/path/to/file」）
- **仅日志**：技术细节（含 stack trace、错误码、上下文）
- **外部上报**：合规审计（`AuditLogEntry`，mod-04 §4.5）

---

## 3. 工具登记表（60 个摘要）

> 列：`#` / `name` / `类别` / `只读` / `破坏` / `并发` / `后台` / `压缩` / `abort 类` / `coordinator 可用`
> `✓`=是 / `−`=否 / `△`=视参数而定（见 §4-§10 详目）
> `coordinator 可用` 列三态：`✓` = 默认可用（只读/编排工具）；`−` = Coordinator Mode 下不可用（`bash`/`edit_file`/`write_file` 3 个由 `mergeAndFilterTools()` 硬移除，其余 23 个写/破坏性/外部工具由 M4 Layer 2 权限规则软 deny）；`△` = 可用性视 Coordinator 自身白名单配置而定（如 `agent_router` 必备、`skill_invoke` 视 skill 类型）

| # | name | 类别 | 只读 | 破坏 | 并发 | 后台 | 压缩 | abort | coordinator |
|---|------|------|------|------|------|------|------|-------|------------|
| 1 | `read_file` | 文件 | ✓ | − | ✓ | − | ✓ | D | ✓ |
| 2 | `edit_file` | 文件 | − | − | − | − | ✓ | D | − |
| 3 | `write_file` | 文件 | − | ✓ | − | − | ✓ | D | − |
| 4 | `glob` | 文件 | ✓ | − | ✓ | − | ✓ | D | ✓ |
| 5 | `grep` | 文件 | ✓ | − | ✓ | − | ✓ | D | ✓ |
| 6 | `notebook_edit` | 文件 | − | − | − | − | − | D | − |
| 7 | `file_stat` | 文件 | ✓ | − | ✓ | − | − | D | ✓ |
| 8 | `file_move` | 文件 | − | ✓ | − | − | − | D | − |
| 9 | `bash` | Shell | − | ✓ | − | ✓ | ✓ | B | − |
| 10 | `powershell` | Shell | − | ✓ | − | ✓ | − | B | − |
| 11 | `tmux` | Shell | − | △ | − | ✓ | − | B | − |
| 12 | `kill_process` | Shell | − | ✓ | − | − | − | D | − |
| 13 | `process_list` | Shell | ✓ | − | ✓ | − | − | D | ✓ |
| 14 | `env_get` | Shell | ✓ | − | ✓ | − | − | D | ✓ |
| 15 | `agent_router` | Agent | − | − | − | ✓ | − | C | △ |
| 16 | `send_message` | Agent | − | − | − | − | − | D | △ |
| 17 | `task_create` | Agent | − | − | − | − | − | D | △ |
| 18 | `task_stop` | Agent | − | ✓ | − | − | − | C | △ |
| 19 | `task_output` | Agent | ✓ | − | ✓ | − | ✓ | D | ✓ |
| 20 | `task_list` | Agent | ✓ | − | ✓ | − | − | D | ✓ |
| 21 | `task_get` | Agent | ✓ | − | ✓ | − | − | D | ✓ |
| 22 | `plan_create` | 规划 | − | − | − | − | − | D | ✓ |
| 23 | `plan_update` | 规划 | − | − | − | − | − | D | ✓ |
| 24 | `plan_exit` | 规划 | − | △ | − | − | − | D | ✓ |
| 25 | `todo_write` | 规划 | − | − | − | − | − | D | ✓ |
| 26 | `todo_list` | 规划 | ✓ | − | ✓ | − | − | D | ✓ |
| 27 | `todo_complete` | 规划 | − | − | − | − | − | D | ✓ |
| 28 | `web_fetch` | Web | ✓ | − | ✓ | ✓ | ✓ | A | ✓ |
| 29 | `web_search` | Web | ✓ | − | ✓ | ✓ | − | A | ✓ |
| 30 | `web_click` | Web | ✓ | − | − | ✓ | − | A | ✓ |
| 31 | `web_submit` | Web | − | − | − | ✓ | − | A | − |
| 32 | `mcp_list` | MCP | ✓ | − | ✓ | − | − | D | ✓ |
| 33 | `mcp_call` | MCP | − | △ | − | △ | − | A | − |
| 34 | `mcp_connect` | MCP | − | − | − | − | − | D | − |
| 35 | `mcp_disconnect` | MCP | − | − | − | − | − | C | − |
| 36 | `search_extra_tools` | MCP | ✓ | − | ✓ | − | − | D | ✓ |
| 37 | `execute_extra_tool` | MCP | − | △ | − | △ | − | A | − |
| 38 | `extra_tools_list` | MCP | ✓ | − | ✓ | − | − | D | ✓ |
| 39 | `extra_tools_unload` | MCP | − | − | − | − | − | D | − |
| 40 | `cron_create` | 系统 | − | − | − | − | − | D | − |
| 41 | `cron_list` | 系统 | ✓ | − | ✓ | − | − | D | ✓ |
| 42 | `cron_delete` | 系统 | − | ✓ | − | − | − | D | − |
| 43 | `config_get` | 系统 | ✓ | − | ✓ | − | − | D | ✓ |
| 44 | `config_set` | 系统 | − | − | − | − | − | D | − |
| 45 | `config_list` | 系统 | ✓ | − | ✓ | − | − | D | ✓ |
| 46 | `config_reset` | 系统 | − | ✓ | − | − | − | D | − |
| 47 | `skill_list` | 系统 | ✓ | − | ✓ | − | − | D | ✓ |
| 48 | `skill_invoke` | 系统 | − | △ | − | △ | − | C | △ |
| 49 | `skill_install` | 系统 | − | − | − | − | − | D | − |
| 50 | `skill_uninstall` | 系统 | − | ✓ | − | − | − | D | − |
| 51 | `session_create` | 系统 | − | − | − | − | − | D | − |
| 52 | `session_resume` | 系统 | − | − | − | − | − | D | − |
| 53 | `session_list` | 系统 | ✓ | − | ✓ | − | − | D | ✓ |
| 54 | `session_delete` | 系统 | − | ✓ | − | − | − | D | − |
| 55 | `memory_write` | 系统 | − | − | − | − | − | D | − |
| 56 | `memory_read` | 系统 | ✓ | − | ✓ | − | − | D | ✓ |
| 57 | `memory_list` | 系统 | ✓ | − | ✓ | − | − | D | ✓ |
| 58 | `memory_delete` | 系统 | − | ✓ | − | − | − | D | − |
| 59 | `rewind` | 系统 | − | ✓ | − | − | − | D | − |
| 60 | `compact` | 系统 | − | − | − | − | − | D | ✓ |

**`coordinator 可用 = △`** 表示该工具在 Coordinator Mode 下是否可用取决于 Coordinator 自身的白名单配置（如 `agent_router` 是 Coordinator 必备工具，但 `skill_invoke` 视 skill 类型决定）。

---

## 4. 文件工具详目（8 个）

引用 L3-M3 §3.3.1 + §2.2.12（`FileReadTool` 示例）。

### 4.1 `read_file`

**Description**: Read file content from local filesystem. Supports text/PDF/notebook (.ipynb). Default limit 2000 lines; PDF > 10 pages requires `pages` parameter.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "file_path": { "type": "string", "description": "Absolute file path" },
    "offset": { "type": "integer", "description": "Line offset to start reading from (default 0)", "minimum": 0 },
    "limit": { "type": "integer", "description": "Max lines to read (default 2000, max 5000)", "minimum": 1, "maximum": 5000 },
    "pages": { "type": "string", "description": "PDF page range, e.g. '1-5' (required if PDF > 10 pages)" }
  },
  "required": ["file_path"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（coordinator 可用，未在 banned 列表）

**abortSignal**: D 类（原子本地读，无 abort）

**compactable**: ✓ 在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_PERMISSION_DENIED`（沙箱路径 deny）/ `TOOL_EXECUTION_ERROR`（文件不存在/不可读）/ `PERSISTENCE_IO_ERROR`

**测试要点**:
- 默认 2000 行上限 + `offset`/`limit` 分页（> 2000 行必填 limit）
- PDF > 10 页必填 `pages`（否则 `TOOL_EXECUTION_ERROR`，PRD mod-03 §7 不变量测试）
- 沙箱路径二次校验（防 M4 Layer 3 bypass，L3-M3 §2.2.12 已示范）
- 错误返回 `is_error=true` + 文本说明（不抛异常）

**依赖**: M4 `SandboxExecutor` 路径白名单（types.ts §15 `SANDBOX_DENY_PATHS`）

### 4.2 `edit_file`

**Description**: Edit file by exact string replacement. `old_string` must be unique in file (or specify `replace_all`). Supports creating new file when `old_string` is empty.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "file_path": { "type": "string", "description": "Absolute file path" },
    "old_string": { "type": "string", "description": "Exact string to find (empty = create new file)" },
    "new_string": { "type": "string", "description": "Replacement string" },
    "replace_all": { "type": "boolean", "description": "Replace all occurrences (default false)", "default": false }
  },
  "required": ["file_path", "old_string", "new_string"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 `mergeAndFilterTools()` 强制移除**，不变量 #4）

**abortSignal**: D 类（原子写，无 abort；`fs.rename` POSIX 原子性，L2 §5）

**compactable**: ✓ 在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_PERMISSION_DENIED` / `TOOL_EXECUTION_ERROR`（`old_string` 不唯一且未 `replace_all` / 文件不存在且 `old_string` 非空 / `PERSISTENCE_IO_ERROR`）

**测试要点**:
- `old_string` 唯一性校验（不唯一 + 未 `replace_all` → `TOOL_EXECUTION_ERROR`）
- 创建新文件路径（`old_string=''` + 文件不存在 → 创建）
- `replace_all=true` 全量替换
- 沙箱路径白名单严格校验（写系统目录 `/etc`、`/usr` 必拒）

**依赖**: M4 `SandboxExecutor`（types.ts §15 4 类 deny 路径）

### 4.3 `write_file`

**Description**: Write full content to file (overwrite if exists, create if not). Subject to sandbox path whitelist.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "file_path": { "type": "string", "description": "Absolute file path" },
    "content": { "type": "string", "description": "Full content to write" }
  },
  "required": ["file_path", "content"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 `mergeAndFilterTools()` 强制移除**，不变量 #4）

**abortSignal**: D 类（原子写，无 abort）

**compactable**: ✓ 在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_PERMISSION_DENIED` / `TOOL_EXECUTION_ERROR`（路径校验失败 / `PERSISTENCE_IO_ERROR`）

**测试要点**:
- 覆盖已有文件（破坏性，必须 `isDestructive=true`）
- 创建新文件（父目录不存在 → `TOOL_EXECUTION_ERROR`）
- 沙箱路径白名单严格校验（`/etc/hosts` 等系统路径必拒）
- `SANDBOX_DENY_PATHS` 4 类路径全部 deny（types.ts §15）

**依赖**: M4 `SandboxExecutor`（types.ts §15）

### 4.4 `glob`

**Description**: Fast file pattern matching. Returns paths sorted by mtime (newest first). Supports `**/*.js` style patterns.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Glob pattern, e.g. '**/*.ts'" },
    "path": { "type": "string", "description": "Directory to search in (default cwd)" }
  },
  "required": ["pattern"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（coordinator 可用）

**abortSignal**: D 类（本地索引读，无 abort）

**compactable**: ✓ 在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_EXECUTION_ERROR`（路径不存在 / `PERSISTENCE_IO_ERROR`）

**测试要点**:
- `**/*.ts` 递归匹配 + mtime 排序
- 大目录性能（> 10000 文件 ≤ 1s，PRD mod-03 §6.1）
- `path` 不存在返回空数组（不抛异常）

### 4.5 `grep`

**Description**: Search file contents using ripgrep. Supports regex + glob filter + multiline mode. Returns matching lines with file path + line number.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Regex pattern (ripgrep syntax)" },
    "path": { "type": "string", "description": "File or directory to search (default cwd)" },
    "glob": { "type": "string", "description": "Glob filter, e.g. '*.js'" },
    "type": { "type": "string", "description": "File type filter (rg --type): js, py, rust, go, etc." },
    "output_mode": { "type": "string", "enum": ["content", "files_with_matches", "count"], "default": "files_with_matches" },
    "-i": { "type": "boolean", "description": "Case insensitive (default false)", "default": false },
    "-n": { "type": "boolean", "description": "Show line numbers in content mode (default true)", "default": true },
    "multiline": { "type": "boolean", "description": "Enable multiline mode (default false)", "default": false },
    "head_limit": { "type": "integer", "description": "Limit output lines/entries (default 250)", "minimum": 0 }
  },
  "required": ["pattern"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（coordinator 可用）

**abortSignal**: D 类（ripgrep 子进程同步，但短查询无 abort 信号；长查询（> 5s）由 M2 stall 检测处理）

**compactable**: ✓ 在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_EXECUTION_ERROR`（正则语法错误 / 路径不存在）

**测试要点**:
- 正则 + glob + type 过滤组合
- `output_mode=content` 显示行号 + `-A`/`-B`/`-C` 上下文
- `multiline=true` 跨行匹配（rg `-U`）
- `head_limit=0` 不限（PRD mod-03 §6.1 性能）

**依赖**: `ripgrep` 二进制（运行时依赖，L2 §2 第三方库选型）

### 4.6 `notebook_edit`

**Description**: Edit Jupyter notebook (.ipynb) cell. Replaces cell source by `cell_id` or inserts/deletes by `cell_number`. Supports markdown and code cells.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "notebook_path": { "type": "string", "description": "Absolute .ipynb file path" },
    "cell_id": { "type": "string", "description": "Cell ID to edit (alternative to cell_number)" },
    "cell_number": { "type": "integer", "description": "0-indexed cell position (alternative to cell_id)", "minimum": 0 },
    "edit_mode": { "type": "string", "enum": ["replace", "insert", "delete"], "default": "replace" },
    "cell_type": { "type": "string", "enum": ["code", "markdown"], "description": "Cell type (required for insert)" },
    "new_source": { "type": "string", "description": "New cell source (required for replace/insert)" }
  },
  "required": ["notebook_path"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny**（Coordinator Mode 默认禁用，写工具类，不变量 #4 端到端守护）

**abortSignal**: D 类（JSON 原子写）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单（保留完整 cell 语义，避免压缩破坏 notebook 结构）

**错误码**: `TOOL_PERMISSION_DENIED` / `TOOL_EXECUTION_ERROR`（文件非 .ipynb / cell_id 不存在 / `cell_number` 越界 / `PERSISTENCE_CORRUPTION` JSON 解析失败）

**测试要点**:
- `edit_mode=replace` 按 `cell_id` 或 `cell_number` 替换 `new_source`
- `edit_mode=insert` 必填 `cell_type` + `new_source`
- `edit_mode=delete` 仅需 `cell_id` 或 `cell_number`
- 非-notebook 文件 → `TOOL_EXECUTION_ERROR`
- JSON 解析失败 → `PERSISTENCE_CORRUPTION`（不静默修复）
- 原子写（temp + rename，避免崩溃破坏 .ipynb）

### 4.7 `file_stat`

**Description**: Get file metadata (size, mtime, mode, type) without reading content. Used to pre-check large files before `read_file`.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "file_path": { "type": "string", "description": "Absolute file path" }
  },
  "required": ["file_path"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（coordinator 可用）

**abortSignal**: D 类（`fs.stat` 原子）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_EXECUTION_ERROR`（文件不存在 / `PERSISTENCE_IO_ERROR`）

**测试要点**:
- 返回 `{ size, mtime, mode, type: 'file'|'dir'|'symlink' }`
- symlink 跟随 `fs.lstat`（不解析 target）
- 文件不存在返回 `is_error=true`（不抛异常）

### 4.8 `file_move`

**Description**: Move or rename file/directory. Cross-device moves fall back to copy + delete. Subject to sandbox path whitelist at both source and destination.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "source": { "type": "string", "description": "Absolute source path" },
    "destination": { "type": "string", "description": "Absolute destination path" },
    "overwrite": { "type": "boolean", "description": "Overwrite destination if exists (default false)", "default": false }
  },
  "required": ["source", "destination"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true`（不可逆：源文件消失）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny**（Coordinator Mode 默认禁用，写工具类，不变量 #4 端到端守护）

**abortSignal**: D 类（`fs.rename` POSIX 原子，跨设备时 copy+delete 不原子但无中间 abort）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_PERMISSION_DENIED` / `TOOL_EXECUTION_ERROR`（源不存在 / 目标存在且 `overwrite=false` / 跨设备 copy 失败 / `PERSISTENCE_IO_ERROR`）

**测试要点**:
- 同目录 rename（`fs.rename` 原子）
- 跨设备 move（copy + delete fallback，部分失败需回滚）
- `overwrite=false` + 目标存在 → `TOOL_EXECUTION_ERROR`
- 源/目标任一在 `SANDBOX_DENY_PATHS` 4 类路径 → `TOOL_PERMISSION_DENIED`

**依赖**: M4 `SandboxExecutor`（types.ts §15）

---

## 5. Shell 工具详目（6 个）

引用 L3-M3 §3.3.2 + §2.2.13（`BashTool` 示例）+ §3.4（24 项安全校验）+ risk-classifier `spec.md` §3。

### 5.1 `bash`

**Description**: Execute bash command. Subject to 24-item security check (C01-C24) + sandbox-exec/bubblewrap/WSL2. Default timeout 120s.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "Bash command to execute" },
    "timeout": { "type": "integer", "description": "Timeout in ms (default 120000, max 600000)", "minimum": 1000, "maximum": 600000 },
    "cwd": { "type": "string", "description": "Working directory (default ctx.cwd)" },
    "env": { "type": "object", "description": "Additional environment variables (subject to C05 env-injection check)", "additionalProperties": { "type": "string" } },
    "run_in_background": { "type": "boolean", "description": "Run in background, return shell_id for later retrieval (default false)", "default": false }
  },
  "required": ["command"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true`（默认）/ `isConcurrencySafe=false` / `isBackground=true`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 `mergeAndFilterTools()` 强制移除**，不变量 #4）

**abortSignal**: B 类（`ChildProcess.kill('SIGTERM')`，超时 120s 默认；后台模式保留 shell_id 供 `task_output` 读取）

**compactable**: ✓ 在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_PERMISSION_DENIED`（24 项校验 deny）/ `TOOL_TIMEOUT` / `USER_INTERRUPT`（abort）/ `SANDBOX_FAILED` / `RISK_CLASSIFIER_FAILED`（auto mode 下两阶段都失败 fail-closed deny）/ `TOOL_EXECUTION_ERROR`（exit code ≠ 0）

**24 项安全校验**（引用 risk-classifier `spec.md` §3，不重述）：
- C01 ast-parse / C02 cmd-blacklist / C03 bare-git-deny / C04 pipe-exfil / C05 env-injection / C06 system-path / C07 settings-tamper / C08 skills-inject / C09 zsh-dangerous / C10 heredoc-inject / C11 eval-exec-chain / C12 process-sub / C13 rm-rf-roots / C14 dd-device / C15 fork-bomb / C16 curl-exfil / C17 chmod-recursive / C18 sudo-escalation / C19 kill-system / C20 git-readonly / C21 build-test / C22 file-readonly / C23 file-write-project / C24 dev-tooling

**测试要点**:
- 119 条 risk-classifier 评测集验收（PRD mod-03 §8.3）：漏报 ≤ 3% / 误报 ≤ 15%（PRD mod-04 §4.1 严格档）
- C07 `git commit .omniagent/settings.json` → deny（不变量 #10 sandbox deny settings）
- C08 `cat > .omniagent/skills/evil.md` → deny（不变量 #10 sandbox deny skills）
- C03 bare-git-repo deny（`git init --bare` 在 bare repo，types.ts §15 SANDBOX_DENY_PATHS 第 3 类）
- 超时 120s 默认 + `timeout` 参数覆盖
- `run_in_background=true` 返回 `shell_id`，供 `task_output` 读取（A 类与 B 类 abort 桥接）
- M4 sandbox-exec/bubblewrap/WSL2 三平台矩阵（L2 §10 CI 矩阵）

**依赖**: M3 `BashSecurityChecker`（L3-M3 §2.2.5）+ `BashCommandAnalyzer`（§2.2.6）+ `BASH_SECURITY_RULES`（§2.2.7）+ M4 `SandboxExecutor`（L3-M4 §2.2.6）+ M4 `RiskClassifier` 两阶段（L3-M4 §2.2.9）

### 5.2 `powershell`

**Description**: Execute PowerShell command on Windows. Subject to 24-item security check (adapted for PowerShell AST) + sandbox (WSL2 recommended on Windows).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "PowerShell command to execute" },
    "timeout": { "type": "integer", "description": "Timeout in ms (default 120000, max 600000)", "minimum": 1000, "maximum": 600000 },
    "cwd": { "type": "string", "description": "Working directory (default ctx.cwd)" },
    "env": { "type": "object", "description": "Additional environment variables (subject to C05)", "additionalProperties": { "type": "string" } }
  },
  "required": ["command"]
}
```

**元数据**: 同 `bash`（`isReadOnly=false` / `isDestructive=true` / `isConcurrencySafe=false` / `isBackground=true`）

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny**（Coordinator Mode 默认禁用，破坏性 Shell 工具类，不变量 #4 端到端守护）

**abortSignal**: B 类（`ChildProcess.kill`）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单（types.ts §13 仅含 `bash`，PowerShell 输出语义与 bash 不同且 v1.x 跨平台一致性强约束不足；v1.x 演进项可考虑纳入）

**错误码**: 同 `bash`

**24 项校验适配**：
- C01 ast-parse 改用 PowerShell AST（`System.Management.Automation.LanguageParser`）
- C09 zsh-dangerous 不适用，改为 PowerShell 危险 cmdlet（`Remove-Item -Recurse -Force`、`Invoke-Expression` 等）
- 其他 22 项校验通用

**测试要点**:
- Windows 11 + PowerShell 7.x 矩阵（L2 §10 CI 矩阵）
- WSL2 fallback（PowerShell 不可用时降级 `bash` on WSL2）
- `Invoke-Expression` 链调用必拒（C11 适配）
- `Remove-Item -Recurse -Force C:\` 必拒（C13 适配）

**依赖**: 同 `bash`（PowerShell AST 解析器替换 shell-quote）

### 5.3 `tmux`

**Description**: Manage long-running shell sessions via tmux. Supports attach/detach/send-keys/capture-pane. Used for long-running tasks (e.g. dev servers).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "action": { "type": "string", "enum": ["create", "attach", "detach", "send-keys", "capture-pane", "kill-session"], "description": "Tmux action" },
    "session_name": { "type": "string", "description": "Tmux session name" },
    "command": { "type": "string", "description": "Command for send-keys action" },
    "pane_id": { "type": "string", "description": "Pane ID for capture-pane" },
    "lines": { "type": "integer", "description": "Lines to capture (default 100)", "minimum": 1 }
  },
  "required": ["action", "session_name"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=△`（`kill-session` 不可逆，其他可逆）/ `isConcurrencySafe=false` / `isBackground=true`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny**（Coordinator Mode 默认禁用，破坏性 Shell 工具类，不变量 #4 端到端守护）

**abortSignal**: B 类（`tmux kill-session` 终止子进程；detach 保留 session）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单（session 状态需保留完整）

**错误码**: `TOOL_PERMISSION_DENIED` / `TOOL_EXECUTION_ERROR`（session 不存在 / `tmux` 二进制不存在 / `TOOL_TIMEOUT`）

**测试要点**:
- `create` + `send-keys` + `capture-pane` 全流程
- `detach` 后 session 仍存活（`tmux ls` 可见）
- `kill-session` 不可逆（`isDestructive=true` for this action）
- 跨 agent 共享 session（mailbox-like 多 agent 写同一 session 需锁）

**依赖**: `tmux` 二进制 + M5 `ShutdownHandshake`（kill-session 时清理子进程）

### 5.4 `kill_process`

**Description**: Kill process by PID or name. Supports cascade kill (kill child processes). Subject to C19 kill-system check (system processes protected).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "pid": { "type": "integer", "description": "Process ID (alternative to name)", "minimum": 1 },
    "name": { "type": "string", "description": "Process name (alternative to pid, kills first match)" },
    "signal": { "type": "string", "enum": ["SIGTERM", "SIGKILL", "SIGINT"], "default": "SIGTERM" },
    "cascade": { "type": "boolean", "description": "Kill child processes recursively (default false)", "default": false }
  },
  "required": []
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true`（不可逆）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny**（Coordinator Mode 默认禁用，破坏性工具类，不变量 #4 端到端守护）

**abortSignal**: D 类（kill 信号本身是 abort 的对偶，无中间态）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_PERMISSION_DENIED` / `TOOL_EXECUTION_ERROR`（PID 不存在 / 杀系统进程拒绝 / `TOOL_TIMEOUT`）

**测试要点**:
- C19 kill-system 校验（PID < 4 = 系统进程，必拒）
- `cascade=true` 递归 kill 子进程
- `name` 模糊匹配 + 多个匹配时 kill 第一个（不歧义）
- `SIGTERM` → `SIGKILL` 升级链（5s 后未退出则 SIGKILL）

**依赖**: M3 `BashSecurityChecker` C19 规则（risk-classifier `spec.md` §3）

### 5.5 `process_list`

**Description**: List running processes. Returns PID, name, CPU%, MEM%. Filter by name pattern.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "name_pattern": { "type": "string", "description": "Filter by process name regex (default all)" },
    "include_cwd": { "type": "boolean", "description": "Include cwd column (default false, slower)", "default": false }
  },
  "required": []
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（coordinator 可用，只读）

**abortSignal**: D 类（`ps` 子进程同步）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_EXECUTION_ERROR`（`ps` 命令失败 / `TOOL_TIMEOUT`）

**测试要点**:
- 默认返回 PID + name + CPU% + MEM%
- `include_cwd=true` 增加 cwd 列（macOS 需 `lsof`，Linux 需 `/proc/<pid>/cwd`）
- `name_pattern` 正则过滤

### 5.6 `env_get`

**Description**: Get environment variable value. Read-only access to `process.env`. Subject to Safe Properties 30 whitelist (mod-04 §6.1) — non-whitelisted vars require permission ask.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "Environment variable name" },
    "include_all": { "type": "boolean", "description": "Return all env vars as object (default false, requires ask)", "default": false }
  },
  "required": ["name"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（coordinator 可用）

**abortSignal**: D 类（`process.env` 同步读）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_PERMISSION_DENIED`（非 Safe Properties 白名单变量 + ask 拒绝）/ `TOOL_EXECUTION_ERROR`（变量未定义）

**测试要点**:
- Safe Properties 30 白名单（mod-04 §6.1）的变量默认 allow
- 非白名单变量（如 `AWS_SECRET_ACCESS_KEY`）→ ask（用户拒绝则 deny，防凭证泄露，R02 合规扩展类别）
- `include_all=true` 强制 ask（防批量泄露）

**依赖**: M4 `SafePropertiesRegistry`（L3-M4 §2.2.24，30 白名单）

---

## 6. Agent 工具详目（7 个）

引用 L3-M3 §3.3.3 + §2.2.14（`AgentRouterTool`）+ §2.2.16（`TaskOutputTool`）+ L3-M5 §2.2.1（`Orchestrator.route`）。

### 6.1 `agent_router`

**Description**: Route to sub-agent. 5 paths: sync (blocking) / async (background task) / fork (isolated sidechain) / teammate (swarm member) / remote (SSH). Delegates to M5 Orchestrator.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "route": { "type": "string", "enum": ["sync", "async", "fork", "teammate", "remote"] },
    "prompt": { "type": "string", "description": "Sub-agent task prompt" },
    "parent_context_mode": { "type": "string", "enum": ["inherit", "isolated"], "description": "Context inheritance (default isolated for fork, inherit for sync)" },
    "teammate_name": { "type": "string", "description": "Teammate name (required for route=teammate)" },
    "remote_target": { "type": "string", "description": "SSH target host (required for route=remote), e.g. 'user@host'" },
    "tools_whitelist": { "type": "array", "items": { "type": "string" }, "description": "Sub-agent tools whitelist (default inherits parent pool)" },
    "timeout_ms": { "type": "integer", "description": "Timeout in ms (default 300000, max 3600000)", "minimum": 1000, "maximum": 3600000 }
  },
  "required": ["route", "prompt"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=true`（async/fork/teammate 都可后台化）

**角色可用性**: main / coordinator / worker / custom / teammate / fork（全部可用；coordinator 必备工具）

**abortSignal**: C 类（M5 `ShutdownHandshake` 四步握手，30s timeout 不强杀，不变量 #6）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单（保留完整 sub-agent 语义）

**错误码**: `TOOL_PERMISSION_DENIED` / `TOOL_TIMEOUT` / `USER_INTERRUPT`（M5 `ShutdownHandshake` 中断）/ `TOOL_EXECUTION_ERROR`（5 路径分发失败，L3-M5 §2.2.1 6 类失败模式）

**5 路径分发**（引用 L3-M5 §2.2.1）：
- `sync`: 阻塞等待 sub-agent 完成，结果回注
- `async`: 创建 background task，返回 `task_id`，供 `task_output` 读取
- `fork`: 隔离 sidechain（M7 `createSidechain`），byte-identical 复制父 messages（不变量 #5）
- `teammate`: 按 `teammate_name` 寻址（不变量 #2），写 mailbox
- `remote`: SSH 远程 agent，指数退避重试 3 次

**测试要点**:
- 5 路径分别测试（L3-M5 §6 集成测试）
- `fork` 模式 prompt prefix byte-identical（不变量 #5，M5 `ForkAgentSpawner.fillPlaceholderToolResults` 守护）
- `teammate` 模式 name 唯一性（不变量 #2，M5 `TeammateRegistry.assertNameStable` 守护）
- `remote` SSH 失败重试 3 次（指数退避 1s/2s/4s，L3-M5 §2.2.10）
- `sync` 模式结果同步返回；`async` 模式返回 `task_id`

**依赖**: M5 `Orchestrator.route()` 签名 `AgentRouterParams & { parentAgentId: AgentId; traceId: TraceId }`（types.ts §8 + L3-M5 §2.2.1）

### 6.2 `send_message`

**Description**: Send message to teammate mailbox. Subject to mailbox capacity limits (64KB per message / 4MB per mailbox / 1000 messages). Messages persist across turns.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "to": { "type": "string", "description": "Recipient teammate name (or '*' for broadcast)" },
    "message": { "type": "string", "description": "Message content (max 64KB)" },
    "summary": { "type": "string", "description": "5-10 word summary shown in UI preview" }
  },
  "required": ["to", "message"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / coordinator / worker / custom / teammate / fork（全部可用）

**abortSignal**: D 类（mailbox 原子写，L2 §5 `writeMailboxAtomic`）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单（mailbox 消息需保留完整语义）

**错误码**: `MAILBOX_FULL`（4MB 或 1000 条超限）/ `MAILBOX_LOCKED`（10 次退避后仍失败）/ `TOOL_EXECUTION_ERROR` / `PERSISTENCE_IO_ERROR`

**测试要点**:
- 容量限制 4MB + 1000 条（超限 → `MAILBOX_FULL`）
- 单消息 64KB（超限 → `TOOL_EXECUTION_ERROR`）
- 归档 200 阈值触发自动归档（L2 §5）
- 广播 `to='*'` 线性扩展（10 个 teammate 不超 1s）
- 消息丢失率 = 0（不变量 #7，L3-M5 §6 集成测试）

**依赖**: M5 `MailboxService` 包装 M7 `writeMailboxAtomic`（L3-M5 §2.2.3）+ types.ts §15 `MailboxCapacityLimits`

### 6.3 `task_create`

**Description**: Create background task (async/fork/teammate). Returns task_id immediately. Wrapper around `agent_router` with route=async/fork/teammate.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "route": { "type": "string", "enum": ["async", "fork", "teammate"], "description": "Task route (must be background-able)" },
    "prompt": { "type": "string", "description": "Task prompt" },
    "teammate_name": { "type": "string", "description": "Required for route=teammate" },
    "tools_whitelist": { "type": "array", "items": { "type": "string" } },
    "timeout_ms": { "type": "integer", "default": 300000, "maximum": 3600000 }
  },
  "required": ["route", "prompt"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`（本身不后台化，仅创建 task）

**角色可用性**: main / coordinator / worker / custom / teammate / fork

**abortSignal**: D 类（创建 task 原子操作；task 本身可被 `task_stop` 中断）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单

**错误码**: 同 `agent_router`

**测试要点**:
- `route=async` 返回 `task_id` + `status='running'`
- `route=fork` 不变量 #5 byte-identical
- `route=teammate` name 唯一性
- `WorkItem`（LLM 维护）与 `RuntimeTask`（harness 维护）双轨关联（L3-M5 §2.2.2）

**依赖**: M5 `TaskManager` + `WorkItemStore` + `RuntimeTaskStore`（L3-M5 §2.2.2）

### 6.4 `task_stop`

**Description**: Stop running task. Triggers M5 ShutdownHandshake 4-step handshake (sendRequest → handleRequest → waitForResponse 30s timeout). Does not force-kill (invariant #6).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "task_id": { "type": "string", "description": "Task ID to stop" },
    "reason": { "type": "string", "description": "Stop reason (sent to sub-agent for graceful shutdown)" },
    "force": { "type": "boolean", "description": "Force kill after 30s timeout (default false, requires ask)", "default": false }
  },
  "required": ["task_id"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true`（task 终止不可逆）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / coordinator / worker / custom / teammate / fork

**abortSignal**: C 类（本身就是 abort 信号；调 M5 `ShutdownHandshake.sendRequest`）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TASK_NOT_FOUND` / `TOOL_TIMEOUT`（30s 等待 response 超时）/ `TOOL_EXECUTION_ERROR`

**测试要点**:
- 正常 4 步握手：`sendRequest` → `handleRequest approve` → 清理 → `waitForResponse` 收到
- teammate 拒绝 shutdown（`handleRequest reject`）→ 调用方收到 reject 消息
- 30s 超时 + `force=false` → 返回 `TOOL_TIMEOUT`（不强杀）
- 30s 超时 + `force=true` → 强杀（需 ask，不变量 #6 例外）
- 三态恢复（running/stopped/evicted，L3-M5 §2.2.8 `ThreeStateRecovery`）

**依赖**: M5 `ShutdownHandshake`（L3-M5 §2.2.9）+ `ThreeStateRecovery`（§2.2.8）

### 6.5 `task_output`

**Description**: Read output of async/fork/teammate task. Supports blocking mode (wait until task completes). Output is compactable (in COMPACTABLE_TOOLS whitelist).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "task_id": { "type": "string", "description": "Task ID" },
    "block": { "type": "boolean", "description": "Block until task completes (default false)", "default": false },
    "timeout_ms": { "type": "integer", "description": "Block timeout in ms (default 30000, max 300000)", "minimum": 1000, "maximum": 300000 }
  },
  "required": ["task_id"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: main / coordinator / worker / custom / teammate / fork（coordinator 可用，只读）

**abortSignal**: D 类（读已持久化的输出；block 模式超时由 `timeout_ms`）

**compactable**: ✓ 在 `COMPACTABLE_TOOLS` 白名单（M7 可摘要压缩，避免长输出撑爆上下文）

**错误码**: `TASK_NOT_FOUND` / `TOOL_TIMEOUT`（block 模式超时）/ `TOOL_EXECUTION_ERROR`

**测试要点**:
- 非 block 模式返回当前输出快照
- block 模式等 task 完成或 `timeout_ms` 超时
- 压缩后保留 task_id + 完成状态 + 摘要（M7 LLM 摘要）
- fork task 的 sidechain 输出由 M7 `flushSidechain` 同步（L3-M7 §3.5）

**依赖**: M5 `TaskManager.getTaskOutput()` + M7 sidechain 持久化（L3-M5 §2.2.7）

### 6.6 `task_list`

**Description**: List all current tasks (running + completed). Returns task_id, route, status, created_at.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "status_filter": { "type": "string", "enum": ["running", "completed", "failed", "all"], "default": "all" },
    "route_filter": { "type": "string", "enum": ["async", "fork", "teammate", "remote"] }
  },
  "required": []
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: main / coordinator / worker / custom / teammate / fork

**abortSignal**: D 类（读 `RuntimeTaskStore`）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_EXECUTION_ERROR`

**测试要点**:
- 默认返回所有 task（按 `created_at` 降序）
- `status_filter=running` 仅运行中
- `route_filter=fork` 仅 fork task
- 大量 task 性能（> 100 个 ≤ 100ms）

**依赖**: M5 `RuntimeTaskStore`（L3-M5 §2.2.2）

### 6.7 `task_get`

**Description**: Get task details by ID. Returns full task metadata (prompt, route, status, created_at, completed_at, output summary).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "task_id": { "type": "string", "description": "Task ID" },
    "include_messages": { "type": "boolean", "description": "Include task messages (default false, large)", "default": false }
  },
  "required": ["task_id"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: main / coordinator / worker / custom / teammate / fork

**abortSignal**: D 类

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TASK_NOT_FOUND` / `TOOL_EXECUTION_ERROR`

**测试要点**:
- 默认返回 metadata（不含 messages，避免大返回）
- `include_messages=true` 返回完整 messages（fork task 从 sidechain 读，L3-M7 §3.5）
- `task_id` 不存在 → `TASK_NOT_FOUND`

**依赖**: M5 `RuntimeTaskStore` + M7 sidechain 读取（fork task）

---

## 7. 规划工具详目（6 个）

引用 L3-M3 §3.3.4。Plan Mode 与 M4 Layer 4 协同（L3-M4 §2.2.7 `PlanModeFilter`）。

### 7.1 `plan_create`

**Description**: Create new plan. Enters plan mode (M4 Layer 4 filter activates, write tools blocked). Plan stored in `~/.omniagent/plans/<plan_id>.md`.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string", "description": "Plan title (max 100 chars)" },
    "steps": { "type": "array", "items": { "type": "string" }, "description": "Initial step list" },
    "cwd": { "type": "string", "description": "Working directory snapshot (for plan context)" }
  },
  "required": ["title"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / coordinator / worker / custom / teammate / fork（全部可用）

**abortSignal**: D 类

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单

**错误码**: `TOOL_PERMISSION_DENIED`（已在 plan mode 时拒绝二次创建）/ `TOOL_EXECUTION_ERROR` / `PERSISTENCE_IO_ERROR`

**测试要点**:
- 创建后自动进 plan mode（M4 `PermissionMode='plan'`）
- plan mode 下 `bash`/`edit_file`/`write_file` 被 Layer 4 deny（白名单过滤）
- plan 文件原子写（temp + rename）

**依赖**: M4 `PlanModeFilter`（L3-M4 §2.2.7）

### 7.2 `plan_update`

**Description**: Update plan steps (add/complete/remove/reorder). Only valid in plan mode.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "plan_id": { "type": "string", "description": "Plan ID (from plan_create)" },
    "action": { "type": "string", "enum": ["add", "complete", "remove", "reorder"] },
    "step_index": { "type": "integer", "description": "Step index (0-based) for complete/remove/reorder" },
    "step": { "type": "string", "description": "Step content (for add)" },
    "new_order": { "type": "array", "items": { "type": "integer" }, "description": "New step order (for reorder)" }
  },
  "required": ["plan_id", "action"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_PERMISSION_DENIED`（非 plan mode 拒绝）/ `TOOL_EXECUTION_ERROR`（`step_index` 越界）/ `PERSISTENCE_IO_ERROR`

**测试要点**:
- 4 action 分别测试
- `step_index` 越界 → `TOOL_EXECUTION_ERROR`
- 非 plan mode 调用 → `TOOL_PERMISSION_DENIED`

### 7.3 `plan_exit`

**Description**: Exit plan mode. Submit (apply changes) or abandon (discard). Releases M4 Layer 4 filter.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "plan_id": { "type": "string", "description": "Plan ID" },
    "action": { "type": "string", "enum": ["submit", "abandon"], "description": "submit=apply changes, abandon=discard" }
  },
  "required": ["plan_id", "action"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=△`（`abandon` 丢弃 plan 不可逆）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_PERMISSION_DENIED` / `TOOL_EXECUTION_ERROR` / `PERSISTENCE_IO_ERROR`

**测试要点**:
- `submit` 退出 plan mode + 保留 plan 文件
- `abandon` 退出 plan mode + 删除 plan 文件
- 退出后 `bash`/`edit_file`/`write_file` 恢复可用（M4 Layer 4 解除）

### 7.4 `todo_write`

**Description**: Write TODO list. Replaces entire list. Used for task tracking within a turn.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "todos": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "description": "Todo ID (stable across updates)" },
          "subject": { "type": "string", "description": "Brief title" },
          "description": { "type": "string", "description": "Details" },
          "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
        },
        "required": ["id", "subject", "status"]
      }
    }
  },
  "required": ["todos"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR` / `PERSISTENCE_IO_ERROR`

**测试要点**:
- 全量替换（非增量）
- `id` 跨调用稳定（用于追踪）
- `status` 流转：pending → in_progress → completed
- 大 list 性能（> 100 项 ≤ 50ms）

### 7.5 `todo_list`

**Description**: List current TODOs. Returns array of todos with status.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "status_filter": { "type": "string", "enum": ["pending", "in_progress", "completed", "all"], "default": "all" }
  },
  "required": []
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`

**测试要点**:
- 默认返回全部
- `status_filter=pending` 仅待办

### 7.6 `todo_complete`

**Description**: Mark TODO as completed by ID. Idempotent (already-completed todo is no-op).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "description": "Todo ID to complete" }
  },
  "required": ["id"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`（id 不存在）/ `PERSISTENCE_IO_ERROR`

**测试要点**:
- 正常 complete
- 不存在 id → `TOOL_EXECUTION_ERROR`
- 已 completed 的 id → 幂等 no-op

---

## 8. Web 工具详目（4 个）

引用 L3-M3 §3.3.5 + §2.2.15（`WebFetchTool`）。

### 8.1 `web_fetch`

**Description**: Fetch URL content. Auto-convert HTML to markdown. Supports abortSignal. Private/authenticated URLs return error (no credential injection).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "format": "uri", "description": "URL to fetch" },
    "prompt": { "type": "string", "description": "What to extract from the page (passed to markdown converter)" }
  },
  "required": ["url"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=true`

**角色可用性**: 全部

**abortSignal**: A 类（`fetch(url, { signal: ctx.abortSignal })`，AbortError 转 `is_error=true`）

**compactable**: ✓ 在 `COMPACTABLE_TOOLS` 白名单（M7 可摘要压缩长 HTML）

**错误码**: `TOOL_PERMISSION_DENIED`（非白名单域名 + ask 拒绝）/ `TOOL_TIMEOUT` / `USER_INTERRUPT`（abort）/ `TOOL_EXECUTION_ERROR`（HTTP 4xx/5xx / 网络错误 / `PROVIDER_TIMEOUT` 重定向超时）

**测试要点**:
- HTTP → HTTPS 自动升级
- 重定向跟随（跨 host 返回 redirect URL）
- 15 分钟自清理缓存（重复 URL 命中）
- 私有/认证 URL → `TOOL_EXECUTION_ERROR`（不注入凭证）
- abort 后返回 `is_error=true` + 'aborted by user'

**依赖**: HTML → markdown 转换器（L2 §2 第三方库选型）

### 8.2 `web_search`

**Description**: Search via search engine. Default 8 results. Returns result blocks with links as markdown hyperlinks.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "Search query (min 2 chars)", "minLength": 2 },
    "num_results": { "type": "integer", "description": "Number of results (default 8, max 20)", "minimum": 1, "maximum": 20 },
    "allowed_domains": { "type": "array", "items": { "type": "string" }, "description": "Include only these domains" },
    "blocked_domains": { "type": "array", "items": { "type": "string" }, "description": "Exclude these domains" },
    "search_type": { "type": "string", "enum": ["auto", "fast", "deep"], "default": "auto" }
  },
  "required": ["query"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=true`

**角色可用性**: 全部

**abortSignal**: A 类（`fetch` + abortSignal）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单（搜索结果保留完整链接列表）

**错误码**: `TOOL_TIMEOUT` / `USER_INTERRUPT`（abort）/ `TOOL_EXECUTION_ERROR`（搜索 API 失败）

**测试要点**:
- 默认 8 条结果
- `allowed_domains` / `blocked_domains` 过滤
- 必须返回 `Sources:` 段（PRD 要求）
- `search_type=deep` 慢查询（≤ 30s）
- 仅 US 区域可用（PRD 要求）

### 8.3 `web_click`

**Description**: Click element on webpage via headless browser. Returns resulting page content (markdown). Used for JS-rendered pages.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "format": "uri", "description": "Starting URL" },
    "selector": { "type": "string", "description": "CSS selector for click target" },
    "wait_for": { "type": "string", "description": "Wait condition: selector or navigation (default 5s timeout)" }
  },
  "required": ["url", "selector"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=false`（headless browser 单例）/ `isBackground=true`

**角色可用性**: main / worker / custom / teammate / fork（coordinator 可用，只读浏览）

**abortSignal**: A 类（headless browser `page.close()` + abortSignal）

**compactable**: − 不在白名单

**错误码**: `TOOL_PERMISSION_DENIED` / `TOOL_TIMEOUT` / `TOOL_EXECUTION_ERROR`（selector 不存在 / headless browser 启动失败）

**测试要点**:
- CSS selector 解析 + click
- `wait_for` 等待条件（selector 出现 / navigation 完成）
- headless browser 单例（多 agent 调用排队，非并发）
- 资源清理（关闭 page，保留 browser context）

**依赖**: headless browser 库（Playwright/Puppeteer，L2 §2 第三方库选型）

### 8.4 `web_submit`

**Description**: Submit form on webpage via headless browser. Destructive (modifies remote state). Subject to ask permission.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "format": "uri", "description": "Form URL" },
    "fields": { "type": "object", "description": "Form field values (name → value)", "additionalProperties": { "type": "string" } },
    "submit_selector": { "type": "string", "description": "CSS selector for submit button" },
    "wait_for": { "type": "string", "description": "Wait condition after submit" }
  },
  "required": ["url", "fields", "submit_selector"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false`（远程状态修改但通常可逆）/ `isConcurrencySafe=false` / `isBackground=true`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny**（Coordinator Mode 默认禁用，破坏性远程操作类，不变量 #4 端到端守护）

**abortSignal**: A 类

**compactable**: − 不在白名单

**错误码**: `TOOL_PERMISSION_DENIED`（默认 ask，PRD mod-04 §4.1）/ `TOOL_TIMEOUT` / `TOOL_EXECUTION_ERROR`

**测试要点**:
- 默认 `decision='ask'`（破坏性远程操作）
- `fields` 填充 + `submit_selector` 点击
- `wait_for` 等待结果页
- 不允许提交凭证字段（`password` / `credit_card` 等，防钓鱼）

---

## 9. MCP 工具详目（8 个）

引用 L3-M3 §3.3.6 + §2.2.8（`MCPClient`）+ §2.2.9（`MCPTransport` 7 传输层）+ §3.6（MCP 接入实施矩阵）。

### 9.1 `mcp_list`

**Description**: List connected MCP servers. Returns server name, transport, tool count, status.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "include_tools": { "type": "boolean", "description": "Include tool list per server (default false)", "default": false }
  },
  "required": []
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`

**测试要点**:
- 默认仅返回 server 摘要
- `include_tools=true` 返回完整 tool 列表（描述已截断至 2048）
- 离线 server 标记 `status='disconnected'`

### 9.2 `mcp_call`

**Description**: Call tool on MCP server. Subject to 2048-char description truncation. Transport layer determines abort behavior.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "server": { "type": "string", "description": "MCP server name" },
    "tool": { "type": "string", "description": "Tool name on server" },
    "input": { "type": "object", "description": "Tool input (schema from server)" },
    "timeout_ms": { "type": "integer", "description": "Timeout in ms (default 60000)", "minimum": 1000, "maximum": 600000 }
  },
  "required": ["server", "tool", "input"]
}
```

**元数据**: `isReadOnly=false`（fail-closed 默认）/ `isDestructive=△`（视 tool 而定，fail-closed 默认 true）/ `isConcurrencySafe=false` / `isBackground=△`（视传输层）

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny**（Coordinator Mode 默认禁用，外部工具调用类，不变量 #4 端到端守护）

**abortSignal**: A 类（http/sse/ws 传输层）/ D 类（stdio/in-process 传输层）

**compactable**: − 不在 `COMPACTABLE_TOOLS` 白名单（外部工具结果保留完整语义）

**错误码**: `MCP_CONNECTION_ERROR` / `MCP_TOOL_NOT_FOUND` / `TOOL_TIMEOUT` / `TOOL_PERMISSION_DENIED` / `TOOL_EXECUTION_ERROR`

**测试要点**:
- 描述 > 2048 字符自动截断 + `errors` 数组登记（不变量 #15，L3-M3 §3.6.2）
- 7 传输层分别测试（stdio/sse/http/sse-ide/ws-ide/ws/in-process）
- `in-process` 零开销（linked pair，不 spawn 子进程）
- 离线 server → `MCP_CONNECTION_ERROR`
- 不存在 tool → `MCP_TOOL_NOT_FOUND`

**依赖**: M3 `MCPClient` + `MCPTransport`（L3-M3 §2.2.8 + §2.2.9）+ M4 沙箱（stdio 传输层子进程沙箱）

### 9.3 `mcp_connect`

**Description**: Connect to new MCP server. Subject to M4 sandbox (stdio transport child process sandboxed).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "Local name for the server" },
    "transport": { "type": "string", "enum": ["stdio", "sse", "http", "sse-ide", "ws-ide", "ws", "in-process"] },
    "command": { "type": "string", "description": "Command for stdio transport (e.g. 'npx -y @mcp/server')" },
    "args": { "type": "array", "items": { "type": "string" } },
    "url": { "type": "string", "description": "URL for sse/http/ws transports" },
    "env": { "type": "object", "additionalProperties": { "type": "string" } }
  },
  "required": ["name", "transport"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护），配置类操作）

**abortSignal**: D 类（连接建立后保留；disconnect 时 C 类握手）

**compactable**: − 不在白名单

**错误码**: `MCP_CONNECTION_ERROR`（连接超时/失败）/ `TOOL_PERMISSION_DENIED` / `TOOL_EXECUTION_ERROR`

**测试要点**:
- stdio 传输层 spawn 子进程（M4 沙箱）
- sse/http/ws 传输层 `fetch` 连接
- `in-process` 零开销（linked pair）
- 连接超时 10s → `MCP_CONNECTION_ERROR`
- 重名 server → `TOOL_EXECUTION_ERROR`

### 9.4 `mcp_disconnect`

**Description**: Disconnect from MCP server. Triggers ShutdownHandshake for stdio transport (graceful child process termination).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "Server name" },
    "force": { "type": "boolean", "description": "Force kill after 30s timeout (default false)", "default": false }
  },
  "required": ["name"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: C 类（stdio 子进程 ShutdownHandshake）

**compactable**: − 不在白名单

**错误码**: `MCP_CONNECTION_ERROR`（server 不存在）/ `TOOL_TIMEOUT`（30s 超时）/ `TOOL_EXECUTION_ERROR`

**测试要点**:
- stdio 传输层：子进程 SIGTERM → 30s 等待 → force kill
- sse/http/ws 传输层：关闭连接（无握手）
- 不存在 server → `MCP_CONNECTION_ERROR`

### 9.5 `search_extra_tools`

**Description**: Search for lazy-loaded tools by TF-IDF similarity. Returns top-K candidates. Used to discover MCP/Skill tools without bloating context.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "Search query (natural language)" },
    "k": { "type": "integer", "description": "Top-K results (default 5, max 20)", "minimum": 1, "maximum": 20 },
    "category_filter": { "type": "string", "enum": ["mcp", "skill", "all"], "default": "all" }
  },
  "required": ["query"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`（TF-IDF 索引未建立）

**测试要点**:
- 余弦相似度召回 top-K
- `category_filter=mcp` 仅 MCP 工具
- 召回结果含工具名 + 描述（截断至 2048）
- 索引性能（> 1000 工具 ≤ 100ms）

**依赖**: M3 `LazyToolLoader`（L3-M3 §2.2.10 + §3.5）

### 9.6 `execute_extra_tool`

**Description**: Execute lazy-loaded tool by name. Tool description was returned by `search_extra_tools`. Subject to fail-closed permission check.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "Tool name (from search_extra_tools results)" },
    "input": { "type": "object", "description": "Tool input (schema from tool description)" },
    "timeout_ms": { "type": "integer", "default": 60000, "maximum": 600000 }
  },
  "required": ["name", "input"]
}
```

**元数据**: `isReadOnly=false`（fail-closed 默认）/ `isDestructive=△`（fail-closed 默认 true）/ `isConcurrencySafe=false` / `isBackground=△`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: A/D 类（视工具传输层）

**compactable**: − 不在白名单

**错误码**: `MCP_TOOL_NOT_FOUND` / `TOOL_PERMISSION_DENIED` / `TOOL_TIMEOUT` / `TOOL_EXECUTION_ERROR`

**测试要点**:
- 不存在工具名 → `MCP_TOOL_NOT_FOUND`
- fail-closed 默认 ask（未配置白名单时）
- 工具描述截断后注入 system prompt（避免上下文撑爆）

### 9.7 `extra_tools_list`

**Description**: List currently loaded lazy tools (loaded via `execute_extra_tool` in this session). Returns tool names + categories.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {}
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`

**测试要点**:
- 返回当前 session 已加载的延迟工具列表
- 跨 agent 隔离（fork 不继承父的延迟工具）

### 9.8 `extra_tools_unload`

**Description**: Unload lazy tool to free context. Tool description removed from system prompt.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "Tool name to unload" }
  },
  "required": ["name"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `MCP_TOOL_NOT_FOUND`（工具未加载）/ `TOOL_EXECUTION_ERROR`

**测试要点**:
- 卸载后 system prompt 缩减
- 正在执行中的工具不可卸载（→ `TOOL_EXECUTION_ERROR`）

---

## 10. 系统工具详目（21 个）

引用 L3-M3 §3.3.7。

### 10.1 `cron_create`

**Description**: Create cron job. Scheduled prompt is executed at specified time. Wrapper around `CronCreate` deferred tool.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "schedule": { "type": "string", "description": "Cron expression (5-field: min hour dom mon dow)" },
    "prompt": { "type": "string", "description": "Prompt to execute at scheduled time" },
    "name": { "type": "string", "description": "Cron job name (unique)" }
  },
  "required": ["schedule", "prompt"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护），配置类）

**abortSignal**: D 类（cron 持久化到 `~/.omniagent/cron.json`）

**compactable**: − 不在白名单

**错误码**: `CRON_CONFLICT`（schedule 冲突）/ `TOOL_EXECUTION_ERROR` / `PERSISTENCE_IO_ERROR`

**测试要点**:
- 5-field cron 表达式校验
- 重名 → `CRON_CONFLICT`
- 持久化 + 启动时恢复

**依赖**: M5 `CronCreate` deferred tool（L3-M3 §2.2.1 组件 #16-17）

### 10.2 `cron_list`

**Description**: List all cron jobs. Returns name, schedule, next_run_at, last_run_at.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {}
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`

**测试要点**:
- 返回所有 cron job
- 按 `next_run_at` 升序

### 10.3 `cron_delete`

**Description**: Delete cron job by name. Irreversible.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "Cron job name" }
  },
  "required": ["name"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true`（不可逆）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`（name 不存在）/ `PERSISTENCE_IO_ERROR`

**测试要点**:
- 正常删除
- 不存在 name → `TOOL_EXECUTION_ERROR`
- 删除后 cron 不再触发

### 10.4 `config_get`

**Description**: Get config value by key. Reads from `~/.omniagent/settings.json` + project `.omniagent/settings.json` (project overrides user).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "key": { "type": "string", "description": "Config key (dotted path, e.g. 'permission.defaultMode')" }
  },
  "required": ["key"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`（key 不存在）/ `PERSISTENCE_CORRUPTION`（JSON 解析失败）

**测试要点**:
- 项目 settings 优先于用户 settings
- dotted path 解析（`a.b.c` → `settings.a.b.c`）
- `PERSISTENCE_CORRUPTION` 不静默修复

### 10.5 `config_set`

**Description**: Set config value. Writes to project `.omniagent/settings.json` (default) or user settings. Subject to sandbox deny (settings.json is in SANDBOX_DENY_PATHS, requires direct config_set tool not fs.write).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "key": { "type": "string", "description": "Config key (dotted path)" },
    "value": { "type": "string", "description": "Config value (JSON-encoded)" },
    "scope": { "type": "string", "enum": ["project", "user"], "default": "project" }
  },
  "required": ["key", "value"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类（原子写 settings.json）

**compactable**: − 不在白名单

**错误码**: `TOOL_PERMISSION_DENIED`（写 `SANDBOX_DENY_PATHS` 第 1 类 `.omniagent/settings.json` 必须经此工具，不可 `fs.write`）/ `PERSISTENCE_IO_ERROR`

**测试要点**:
- 仅通过此工具可改 settings（C07 settings-tamper 防护，risk-classifier spec §3）
- `bash` 调 `echo > .omniagent/settings.json` 必拒（24 项校验 C07）
- 项目 scope 优先于用户 scope
- 原子写（temp + rename）

**依赖**: M4 `SANDBOX_DENY_PATHS` 第 1 类（types.ts §15）

### 10.6 `config_list`

**Description**: List all config keys. Returns flattened dotted paths with values.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "scope": { "type": "string", "enum": ["project", "user", "all"], "default": "all" }
  },
  "required": []
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR` / `PERSISTENCE_CORRUPTION`

**测试要点**:
- 默认合并 project + user（project 优先）
- `scope=project` 仅项目
- dotted path 展平

### 10.7 `config_reset`

**Description**: Reset config key to default value. Irreversible (current value lost).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "key": { "type": "string", "description": "Config key" },
    "scope": { "type": "string", "enum": ["project", "user"], "default": "project" }
  },
  "required": ["key"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true`（当前值丢失）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`（key 不存在）/ `PERSISTENCE_IO_ERROR`

**测试要点**:
- 重置到默认值（来自 `OmniAgentConfig` 默认 schema，types.ts §21）
- 不存在 key → `TOOL_EXECUTION_ERROR`

### 10.8 `skill_list`

**Description**: List loaded skills. Wrapper around M6 `SkillRegistry.list()`. Returns name, mode (inline/fork), source (builtin/bundled/disk/mcp/legacy).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "source_filter": { "type": "string", "enum": ["builtin", "bundled", "disk", "mcp", "legacy", "all"], "default": "all" }
  },
  "required": []
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`

**测试要点**:
- 5 来源优先级覆盖（builtin > bundled > disk > mcp > legacy，L3-M6 §2.2.4 `SkillRegistry`）
- `source_filter` 过滤
- 热插拔后列表实时更新

**依赖**: M6 `SkillRegistry`（L3-M6 §2.2.4）

### 10.9 `skill_invoke`

**Description**: Invoke skill by name. Subject to skill mode (inline injects prompt, fork delegates to M5). Wrapper around M6 `SkillExecutor.execute()`.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "Skill name" },
    "args": { "type": "string", "description": "Skill arguments (passed to skill prompt)" },
    "mode_override": { "type": "string", "enum": ["inline", "fork"], "description": "Override skill mode" }
  },
  "required": ["name"]
}
```

**元数据**: `isReadOnly=false`（fail-closed 默认）/ `isDestructive=△`（视 skill 行为）/ `isConcurrencySafe=false` / `isBackground=△`（fork 模式可后台化）

**角色可用性**: main / coordinator（视 skill 白名单，`△`）/ worker / custom / teammate / fork

**abortSignal**: C 类（fork 模式 M5 ShutdownHandshake）/ D 类（inline 模式原子注入）

**compactable**: − 不在白名单

**错误码**: `SKILL_NOT_FOUND` / `TOOL_PERMISSION_DENIED` / `TOOL_TIMEOUT` / `TOOL_EXECUTION_ERROR`

**测试要点**:
- inline 模式：注入 M7 SystemPromptBuilder priority=4 'custom' 层（L3-M6 §2.2.8 `InlineSkillExecutor`）
- fork 模式：委托 M5 `route=fork`，不变量 #5 byte-identical（L3-M6 §2.2.9 `ForkSkillExecutor`）
- 不存在 skill → `SKILL_NOT_FOUND`
- SkillSandboxGuard 启动期权限校验（L3-M6 §2.2.17）

**依赖**: M6 `SkillExecutor` + `InlineSkillExecutor` + `ForkSkillExecutor`（L3-M6 §2.2.7 + §2.2.8 + §2.2.9）

### 10.10 `skill_install`

**Description**: Install new skill from URL or local path. Validates frontmatter (16 fields, L3-M6 §2.2.3 `SkillValidator`) + sandbox guard.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "source": { "type": "string", "description": "URL or local path to skill file" },
    "name": { "type": "string", "description": "Skill name (must match frontmatter)" }
  },
  "required": ["source"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_PERMISSION_DENIED`（写 `.omniagent/skills/` SANDBOX_DENY_PATHS 第 2 类必经此工具）/ `TOOL_EXECUTION_ERROR`（frontmatter 校验失败）/ `PERSISTENCE_IO_ERROR`

**测试要点**:
- SkillValidator 16 字段校验链（L3-M6 §2.2.3）
- SkillNameRegistry 内置命令冲突检测（18 个保留命令，L3-M6 §2.2.5）
- 写 `.omniagent/skills/` 必经此工具（C08 skills-inject 防护）

**依赖**: M6 `SkillValidator` + `SkillNameRegistry`（L3-M6 §2.2.3 + §2.2.5）+ M4 `SANDBOX_DENY_PATHS` 第 2 类

### 10.11 `skill_uninstall`

**Description**: Uninstall skill by name. Irreversible (skill file deleted).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "Skill name" }
  },
  "required": ["name"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true`（不可逆）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `SKILL_NOT_FOUND` / `TOOL_PERMISSION_DENIED` / `PERSISTENCE_IO_ERROR`

**测试要点**:
- 删除 skill 文件
- 热插拔立即生效（运行中 agent 旧快照隔离，L3-M6 §2.2.6 `SkillHotReloader`）
- 内置 skill 不可卸载（L3-M6 §2.2.4 优先级覆盖）

### 10.12 `session_create`

**Description**: Create new session. Returns session_id. Session transcript stored in `~/.omniagent/sessions/<session_id>.jsonl`.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string", "description": "Session title (optional)" },
    "cwd": { "type": "string", "description": "Working directory snapshot" }
  },
  "required": []
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR` / `PERSISTENCE_IO_ERROR`

**测试要点**:
- session_id UUID v4 生成
- transcript 文件创建（空 JSONL）
- 持久化 cwd 快照

### 10.13 `session_resume`

**Description**: Resume session by ID. Loads transcript + memory + plan. Subject to corruption check (auto-compact if corrupted).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "session_id": { "type": "string", "description": "Session ID" },
    "rewind_to": { "type": "string", "description": "Rewind to CompactBoundary ID (optional)" }
  },
  "required": ["session_id"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `SESSION_NOT_FOUND` / `PERSISTENCE_CORRUPTION`（transcript 损坏，触发 auto-compact，L3-M7 §3.9 场景 9）/ `TOOL_EXECUTION_ERROR`

**测试要点**:
- 正常 resume：加载 transcript + memory + plan
- `rewind_to` 回退到 CompactBoundary（M7 `CompactBoundary.rewind`，L3-M7 §3.8）
- transcript 损坏 → `PERSISTENCE_CORRUPTION` + auto-compact 恢复
- 9 场景恢复矩阵（L3-M7 §3.9）

**依赖**: M7 `CompactBoundary` + 9 场景恢复（L3-M7 §3.8 + §3.9）

### 10.14 `session_list`

**Description**: List all sessions. Returns session_id, title, created_at, last_active_at, message_count.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "sort_by": { "type": "string", "enum": ["last_active", "created"], "default": "last_active" },
    "limit": { "type": "integer", "default": 50, "maximum": 500 }
  },
  "required": []
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`

**测试要点**:
- 默认按 `last_active_at` 降序
- `limit=50` 默认

### 10.15 `session_delete`

**Description**: Delete session by ID. Irreversible (transcript + memory + plan deleted).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "session_id": { "type": "string", "description": "Session ID" }
  },
  "required": ["session_id"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true`（不可逆）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `SESSION_NOT_FOUND` / `TOOL_PERMISSION_DENIED` / `PERSISTENCE_IO_ERROR`

**测试要点**:
- 删除 transcript + memory + plan + sidechain
- 不存在 session → `SESSION_NOT_FOUND`
- 删除后不可恢复

### 10.16 `memory_write`

**Description**: Write memory entry. Wrapper around M7 memory system. Subject to memory type validation.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "type": { "type": "string", "enum": ["user", "feedback", "project", "reference"], "description": "Memory type" },
    "name": { "type": "string", "description": "Memory name (unique within type)" },
    "description": { "type": "string", "description": "One-line description" },
    "content": { "type": "string", "description": "Memory content (markdown)" }
  },
  "required": ["type", "name", "description", "content"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false` / `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`（name 重复 / frontmatter 校验失败）/ `PERSISTENCE_IO_ERROR`

**测试要点**:
- frontmatter 校验（name + description + type，L3-M7 §2.2.4）
- 4 类型分类目录（user/feedback/project/reference）
- 重名 → `TOOL_EXECUTION_ERROR`

**依赖**: M7 memory system（L3-M7 §2）

### 10.17 `memory_read`

**Description**: Read memory entry by name. Returns full content + frontmatter.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "type": { "type": "string", "enum": ["user", "feedback", "project", "reference"] },
    "name": { "type": "string", "description": "Memory name" }
  },
  "required": ["type", "name"]
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `MEMORY_NOT_FOUND` / `PERSISTENCE_CORRUPTION` / `TOOL_EXECUTION_ERROR`

**测试要点**:
- 正常读取
- 不存在 → `MEMORY_NOT_FOUND`
- 损坏 frontmatter → `PERSISTENCE_CORRUPTION`

### 10.18 `memory_list`

**Description**: List memory entries by type. Returns name + description (not full content).

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "type_filter": { "type": "string", "enum": ["user", "feedback", "project", "reference", "all"], "default": "all" }
  },
  "required": []
}
```

**元数据**: `isReadOnly=true` / `isDestructive=false` / `isConcurrencySafe=true` / `isBackground=false`

**角色可用性**: 全部

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_EXECUTION_ERROR`

**测试要点**:
- 默认全部
- `type_filter=user` 仅用户记忆
- 按 name 字母序

### 10.19 `memory_delete`

**Description**: Delete memory entry. Irreversible.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "type": { "type": "string", "enum": ["user", "feedback", "project", "reference"] },
    "name": { "type": "string", "description": "Memory name" }
  },
  "required": ["type", "name"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true`（不可逆）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 由 M4 Layer 2 权限规则 deny（Coordinator Mode 默认禁用，不变量 #4 端到端守护））

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `MEMORY_NOT_FOUND` / `TOOL_PERMISSION_DENIED` / `PERSISTENCE_IO_ERROR`

**测试要点**:
- 删除文件
- 不存在 → `MEMORY_NOT_FOUND`
- 删除后 `findRelevantMemories` 不再召回

### 10.20 `rewind`

**Description**: Rewind current session to CompactBoundary. User command (not LLM-callable). Triggers M7 `CompactBoundary.rewind()`.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "boundary_id": { "type": "string", "description": "CompactBoundary ID (from /boundaries command)" }
  },
  "required": ["boundary_id"]
}
```

**元数据**: `isReadOnly=false` / `isDestructive=true`（boundary 之后的消息丢弃）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: **仅用户命令**（`/rewind`），LLM 不可调用

**abortSignal**: D 类

**compactable**: − 不在白名单

**错误码**: `TOOL_PERMISSION_DENIED`（LLM 调用拒绝）/ `TOOL_EXECUTION_ERROR`（boundary 不存在）/ `PERSISTENCE_IO_ERROR`

**测试要点**:
- LLM 调用 → `TOOL_PERMISSION_DENIED`（PRD §5 澄清 K2）
- 用户 `/rewind <boundary_id>` 触发 M7 实现
- boundary 后消息丢弃，tool_use/tool_result 配对完整性（不变量 #3，L3-M2 §2.2.7 `ToolUsePairGuard`）
- M5 CompactBoundary 解耦（M5 不触发 rewind，由 M7 实现 + 用户命令触发，PRD §5 澄清 K2）

**依赖**: M7 `CompactBoundary.rewind`（L3-M7 §3.8）

### 10.21 `compact`

**Description**: Manually trigger context compaction. LLM-callable when context approaches limit. Delegates to M7 auto-compact.

**InputSchema**:
```json
{
  "type": "object",
  "properties": {
    "strategy": { "type": "string", "enum": ["l1_truncate", "l2_compact_tools", "l3_llm_summary"], "description": "Compaction strategy (default auto-select based on size)" },
    "retain_messages": { "type": "array", "items": { "type": "string" }, "description": "Message IDs to retain (optional)" }
  },
  "required": []
}
```

**元数据**: `isReadOnly=false` / `isDestructive=false`（消息摘要保留语义）/ `isConcurrencySafe=false` / `isBackground=false`

**角色可用性**: main / worker / custom / teammate / fork（**coordinator 可用**，编排场景常需手动压缩）

**abortSignal**: D 类（同步压缩；大压缩可拆为 background task）

**compactable**: − 不在白名单（自身是压缩入口）

**错误码**: `TOOL_PERMISSION_DENIED` / `TOOL_EXECUTION_ERROR`（压缩失败 / PTL 熔断 3 试后）/ `AUTOCOMPACT_CIRCUIT_BREAKER`

**测试要点**:
- 3 层压缩策略（L1 50KB 截断 / L2 COMPACTABLE_TOOLS+retain 窗口 / L3 LLM 摘要，L3-M7 §3.5）
- shouldAutoCompact 6 逃逸条件（L3-M7 §3.7 + PRD mod-07 §4.4 + L3-M2 §2.2.8）
- PTL 3 步降级（collapse_drain → reactive_compact → error，熔断 3 试，L3-M7 §3.6）
- CompactBoundary 标记 + rewind 解耦（L3-M7 §3.8）
- 9 场景恢复矩阵（L3-M7 §3.9）

**依赖**: M7 `AutoCompactChecker` + `CompactBoundary`（L3-M7 §3.5 + §3.6 + §3.8）+ M2 `AutoCompactChecker`（L3-M2 §2.2.8）

---

## 11. 跨工具测试要点

### 11.1 不变量测试（引用 PRD mod-03 §7）

| 不变量 # | 测试范围 | 工具涉及 | 断言 |
|---------|---------|---------|------|
| #3 | tool_use/tool_result 配对完整性 | 全部 | 每 tool_use 必有对应 tool_result（M2 `ToolUsePairGuard` 守护） |
| #4 | Coordinator 主 Agent 直接工具调用率 = 0 | **硬移除 3 个**（`bash`/`edit_file`/`write_file`，由 `mergeAndFilterTools()` 在工具池构建时移除）+ **软 deny 23 个**（`notebook_edit`/`file_move`/`powershell`/`tmux`/`kill_process`/`web_submit`/`mcp_call`/`mcp_connect`/`mcp_disconnect`/`execute_extra_tool`/`extra_tools_unload`/`config_set`/`config_reset`/`skill_install`/`skill_uninstall`/`session_create`/`session_resume`/`session_delete`/`memory_write`/`memory_delete`/`rewind`/`cron_create`/`cron_delete`，由 M4 Layer 2 权限规则在 Coordinator Mode 下默认 deny） | **(a)(b)(c)** 硬移除 3 个：`mergeAndFilterTools({agentRole:'coordinator'})` 返回的 `filtered` 数组不含 `bash`/`edit_file`/`write_file`，`removed` 数组 reason 含 "coordinator role"；**(d)** 软 deny 23 个：Coordinator Mode 下 LLM 调用这 23 个工具的请求被 M4 Layer 2 deny（`decision='deny'`），统计 Coordinator 会话全程主 agent 直接调用写/破坏性/外部工具的次数 = 0 |
| #5 | fork agent prompt prefix byte-identical | `agent_router`（route=fork） | M5 `ForkAgentSpawner.fillPlaceholderToolResults` 守护，M3 工具池 byte-identical 复制 |
| #7 | mailbox 消息丢失率 = 0 | `send_message` | 4MB/1000 条容量 + 归档 200 阈值 + 跨 turn 持久化 |
| #10 | sandbox 4 类 deny 路径始终生效 | `bash`/`edit_file`/`write_file`/`notebook_edit`/`file_move` | settings/skills/bare-git-repo/system-dirs 4 类 deny（types.ts §15） |
| #15 | MCP 工具描述 2048 字符截断 | `mcp_call`/`mcp_connect`/`search_extra_tools`/`execute_extra_tool` | 描述 > 2048 自动截断 + `errors` 数组登记 |

### 11.2 角色可用性矩阵测试

```typescript
// 6 角色 × 60 工具的可用性矩阵
// coordinator 硬移除 3 个（bash/edit_file/write_file，mergeAndFilterTools 实现）
// 其他 23 个写/破坏性/外部工具由 M4 Layer 2 权限规则在 Coordinator Mode 下软 deny
const ROLE_TOOL_MATRIX: Record<AgentRole, Set<string>> = {
  main: ALL_TOOLS,
  coordinator: ALL_TOOLS_MINUS_HARD_BANNED,  // 60 - 3 = 57 个进入 filtered（M4 Layer 2 再 deny 23 个）
  worker: WHITELIST_SUBSET,
  custom: CUSTOM_WHITELIST,
  teammate: TEAMMATE_WHITELIST,
  fork: PARENT_POOL_SNAPSHOT,
};

const COORDINATOR_HARD_BANNED = new Set(['bash', 'edit_file', 'write_file']);
const COORDINATOR_SOFT_DENIED = new Set([
  'notebook_edit', 'file_move', 'powershell', 'tmux', 'kill_process', 'web_submit',
  'mcp_call', 'mcp_connect', 'mcp_disconnect', 'execute_extra_tool', 'extra_tools_unload',
  'config_set', 'config_reset', 'skill_install', 'skill_uninstall',
  'session_create', 'session_resume', 'session_delete', 'memory_write', 'memory_delete',
  'rewind', 'cron_create', 'cron_delete',
]);

describe('角色可用性矩阵', () => {
  it('coordinator 角色：mergeAndFilterTools 硬移除 3 个', () => {
    const result = mergeAndFilterTools({ baseTools: ALL_TOOLS, agentRole: 'coordinator' });
    // filtered 数组不含 3 个硬移除工具
    for (const name of COORDINATOR_HARD_BANNED) {
      expect(result.filtered.find(t => t.name === name)).toBeUndefined();
      expect(result.removed.find(r => r.tool.name === name)?.reason).toContain('coordinator role');
    }
    // 但 filtered 数组含 23 个软 deny 工具（M4 Layer 2 在调用时 deny）
    for (const name of COORDINATOR_SOFT_DENIED) {
      expect(result.filtered.find(t => t.name === name)).toBeDefined();
    }
    // 总数 = 60 - 3 = 57
    expect(result.filtered.length).toBe(57);
  });

  it('coordinator Mode：M4 Layer 2 软 deny 23 个写/破坏性/外部工具', () => {
    for (const name of COORDINATOR_SOFT_DENIED) {
      const tool = ToolPool.get(name);
      const decision = tool.checkPermissions(SAMPLE_INPUT);
      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('coordinator mode');
    }
  });
});
```

### 11.3 abortSignal 4 类协同测试

| 类别 | 测试工具 | 断言 |
|------|---------|------|
| A 类 | `web_fetch`/`web_search`/`web_click`/`mcp_call`（http） | `fetch` 传 `signal`，abort 后返回 `is_error=true` + 'aborted by user' |
| B 类 | `bash`/`powershell`/`tmux` | `ChildProcess.kill('SIGTERM')`，stdout 部分返回 |
| C 类 | `agent_router`/`task_stop`/`mcp_disconnect`/`skill_invoke`（fork） | M5 `ShutdownHandshake` 4 步握手，30s timeout 不强杀 |
| D 类 | `read_file`/`edit_file`/`write_file`/`glob`/`grep`/`notebook_edit`/`file_stat`/`file_move`/`kill_process`/`process_list`/`env_get`/`send_message`/`task_create`/`task_output`/`task_list`/`task_get`/`plan_*`/`todo_*`/`mcp_list`/`mcp_connect`/`search_extra_tools`/`extra_tools_list`/`extra_tools_unload`/`cron_create`/`cron_list`/`cron_delete`/`config_get`/`config_set`/`config_list`/`config_reset`/`skill_list`/`skill_invoke`（inline）/`skill_install`/`skill_uninstall`/`session_*`/`memory_*`/`rewind`/`compact` | 原子操作，无 abort 信号；kill 信号本身是 abort 的对偶 |

### 11.4 COMPACTABLE_TOOLS 白名单一致性测试

```typescript
import { COMPACTABLE_TOOLS } from '../omniagent-types';

describe('COMPACTABLE_TOOLS 白名单一致性', () => {
  for (const toolName of COMPACTABLE_TOOLS) {
    it(`${toolName} 的 metadata.compactable=true`, () => {
      const tool = ToolPool.get(toolName);
      const result = tool.call(SAMPLE_INPUT, SAMPLE_CTX);
      expect(result.metadata?.compactable).toBe(true);
    });
  }

  // 其他 52 个工具 compactable=false
  for (const toolName of ALL_TOOL_NAMES.filter(n => !COMPACTABLE_TOOLS.includes(n as never))) {
    it(`${toolName} 的 metadata.compactable=false`, () => {
      const tool = ToolPool.get(toolName);
      const result = tool.call(SAMPLE_INPUT, SAMPLE_CTX);
      expect(result.metadata?.compactable).toBe(false);
    });
  }
});
```

### 11.5 错误码覆盖率测试

每个工具至少 2 条错误码测试（引用 §2.6 错误码映射表）：

- 正常路径：返回 `is_error=false`
- 权限拒绝：`TOOL_PERMISSION_DENIED`
- 执行失败：`TOOL_EXECUTION_ERROR` 或更具体的错误码（如 `MCP_TOOL_NOT_FOUND`、`TASK_NOT_FOUND` 等）

### 11.6 Bash 24 项校验 + 119 条评测集

引用 risk-classifier `spec.md` §3 + dataset.jsonl（119 条）：

- 漏报率 ≤ 3%（PRD mod-04 §4.1 严格档）
- 误报率 ≤ 15%
- 24 项 bashSecurity 类别全覆盖（C01-C24）

---

## 12. 开放问题与 v2.x 演进

### 12.1 v1.0 待确认

- **Q1**: `web_click`/`web_submit` 是否纳入 v1.0（headless browser 依赖较重）？候选：v1.0 仅 `web_fetch`/`web_search`，v1.1 引入 headless browser。
- **Q2**: `tmux` 是否在 v1.0 必备？候选：v1.0 仅 `bash` + `bash run_in_background=true`，v1.1 引入 `tmux`。
- **Q3**: `process_list`/`env_get` 是否合并到 `bash`（`ps aux` / `echo $VAR`）？候选：独立工具避免 LLM 调用 `bash` 的开销。

### 12.2 v1.x 演进（PRD mod-03 §8.4）

- 自定义工具签名机制（GPG 签名 + 白名单登记）
- MCP 协议版本协商（M4 启动前就绪）
- `web_click`/`web_submit` headless browser 工具（v1.1）
- `tmux` 长会话管理（v1.1）

### 12.3 v2.x 演进

- 工具结果 streaming（`ToolResult.content` 增量返回，长输出不撑爆上下文）
- 工具调用并行执行（M2 `ReActLoop` 多 tool_use 并行，不变量 #3 配对完整性需扩展）
- 跨 agent 工具池共享（teammate 间工具白名单互相调用，需 M5 桥接）

---

## 13. 参考链接

- PRD mod-03：`omniagent-prd-mod-03-tools.md`（§4.1 工具示例 + §3.1 Tool 接口 + §3.2 mergeAndFilterTools）
- L3-M3：`/Users/liguang/ccwork/omniagent/doc/design/l3-mod-03-tools.md`（§2.2 组件清单 + §3.3 7 类工具实施要点 + §3.4 Bash 24 项校验 + §3.6 MCP 接入 + §3.7 工具池不可变快照 + §3.8 abortSignal 协同 + §3.9 compactable 元数据 + §3.10 工具调用埋点）
- L2 整体系统设计：`omniagent-system-design.md`（§6 错误处理 + §7 可观测性 + §10 CI 矩阵）
- 类型契约：`omniagent-types.ts`（§7 Tool 接口 + §13 COMPACTABLE_TOOLS + §14 mergeAndFilterTools 签名 + §15 SANDBOX_DENY_PATHS + §21 OmniAgentConfig）
- 评测集：`omniagent-eval/risk-classifier/spec.md`（§3 C01-C24 共 24 项 bashSecurity 类别）+ `dataset.jsonl`（119 条）
- 相关模块 PRD：mod-04（权限与拦截）/ mod-05（编排）/ mod-06（Skills）/ mod-07（上下文与记忆）
- 里程碑：M1 Walking Skeleton（文件 + Shell + Agent Router 必须就绪，L2 §11）
