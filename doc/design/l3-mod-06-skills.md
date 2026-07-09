# OmniAgent CLI — L3 模块设计：M6 Skills 插件系统 (Skills Plugin)

> 模块 ID: M6
> 主负责角色: 工具组
> 阻塞里程碑: M4（扩展生态）
> 源章节: 总体 PRD §4.4 + mod-06 PRD + L2 §1.5（启动期第 8 步加载 Skills）+ §5.4.3（热加载场景）+ §8.1.3（sandbox deny `.omniagent/skills/`）+ omniagent-types.ts §16
> 状态: 草稿（2026-07-08）
> 文档定位: L3 模块级（PRD 是 L1 产品级，L2 是 L2 技术级，L3 是 L2 的细化到类/函数级）

---

## 文档定位与不重复原则

本文档是 M6 Skills 插件系统的 L3 模块设计，**不重复** PRD mod-06 与 L2 §5.4.3 / §8.1.3 的已有内容，仅引用并补到类/函数级实施粒度：

- **PRD mod-06 §3.1 的 Skill 定义** → 本文 §3.1 引用，补 SkillLoader + 5 来源 Provider 实施
- **PRD mod-06 §3.2 的 16 字段 frontmatter 规范** → 本文 §3.2 引用，补 SkillValidator 校验链实施
- **PRD mod-06 §4.1 的 5 种来源 + 优先级** → 本文 §3.3 引用，补 5 Provider + SkillRegistry 优先级覆盖算法
- **PRD mod-06 §4.2 的双模式执行** → 本文 §3.4 / §3.5 引用，补 InlineSkillExecutor + ForkSkillExecutor 实施
- **PRD mod-06 §4.3 的热插拔** → 本文 §3.6 引用，补 SkillHotReloader 实施
- **PRD mod-06 §5 的跨模块交互** → 本文 §4 引用，补 M3/M4/M5/M7 调用图
- **L2 §5.4.3 的工具池热加载场景** → 本文 §3.6 / §4.2 引用不复制
- **L2 §8.1.3 的 sandbox deny 路径** → 本文 §3.7 引用，补 SkillSandboxGuard 实施（依赖 M4）
- **L2 §6 的 26 个错误码** → 本文 §5.1 引用，补 M6 触发的错误码子集
- **L2 §11.5 的 M4 里程碑交付物** → 本文 §7 引用，补 M6 在每迭代交付的组件
- **omniagent-types.ts §16 的 SkillFrontmatter / Skill / SkillSource** → 本文 §2.1 引用，不重定义

**引用约定**：本文引用 PRD 章节时格式为"PRD §X"（指 mod-06），引用总体 PRD 为"总体 §X"，引用 L2 为"L2 §X"，引用类型契约为"`omniagent-types.ts` §N"。

---

## 1. 模块概述

### 1.1 范围（引用 PRD §1.1，不重复）

M6 负责定义并实现 Skills 插件系统，覆盖 PRD mod-06 §1.1 列出的 5 项 in-scope：

1. Skill 定义：Prompt + 权限配置 + 工具白名单的声明式封装，基于 Markdown + YAML frontmatter
2. 5 种来源：内置 / Bundled / 磁盘 / MCP / Legacy
3. 16 字段 frontmatter 规范（omniagent-types.ts §16 已定义）
4. 双模式执行：inline 模式（注入当前 Agent 上下文）+ fork 模式（独立 fork agent 执行）
5. 热插拔：文件系统 watch `.omniagent/skills/`，新增/修改/删除即时生效

### 1.2 边界（引用 PRD §1.2，不重复）

M6 只做"声明式 Skill 加载 + 执行分发"，不做工具执行与上下文分叉：

- **工具接口与执行** → M3 通用工具系统；M6 Skills 工具白名单通过 M3 的 `mergeAndFilterTools()` 接入工具池
- **fork agent 的上下文分叉与 sidechain** → M5 多 Agent 编排引擎 + M7 上下文与记忆引擎；M6 只触发 fork 模式（通过 `agent_router(route=fork)`）
- **`.omniagent/skills/` 目录的沙箱保护** → M4 权限与拦截系统（sandbox deny + Safe Properties 30 白名单）
- **权限拦截** → M4 五层拦截链；Skills 触发的工具调用经 Layer 2 权限规则 + Layer 3 沙箱 + Layer 5 Hooks
- **LLM 调用** → M1 模型抽象层；M6 inline 模式注入的 prompt 经 M2 ReAct Loop 调用 LLM
- **审计日志** → M4 审计日志；M6 触发的 Skill 工具调用记入审计（layer 字段标注来源）

### 1.3 在整体架构中的位置（引用 L2 §1，不重复）

Skills 插件系统是 harness 层的**扩展点**。Skill 是用户自定义的"高级工具"——封装了 Prompt + 权限 + 工具白名单，比 MCP 工具更重（带 prompt 与权限配置），比 Custom Agent 更轻（不定义独立 agent 角色）。Skills 让用户能快速封装团队工作流（如 code-review、commit、review-pr）。

在 L2 §1.5 启动期流程的第 8 步加载 M6 Skills（扫描 `.omniagent/skills/*.md`，校验 16 字段 frontmatter）。在 L2 §5.4.3 的热加载场景中，Skills 文件变化触发 chokidar → `toolPool.reload(...)` → 新 agent BUILD_CONTEXT 取新快照。

---

## 2. 组件清单

### 2.1 组件总览

| # | 组件 | 类型 | 文件路径 | 职责 |
|---|------|------|---------|------|
| 1 | `SkillFrontmatter` | interface | `omniagent-types.ts` §16 | 16 字段 frontmatter schema（已定义） |
| 2 | `Skill` | interface | `omniagent-types.ts` §16 | Skill 定义（frontmatter + body + source + filePath）（已定义） |
| 3 | `SkillSource` | type | `omniagent-types.ts` §16 | 5 来源枚举（builtin/bundled/disk/mcp/legacy，已定义） |
| 4 | `SkillProvider` | interface | `src/skills/provider.ts` | 5 来源统一接口（loadAll/list/get） |
| 5 | `BuiltinSkillProvider` | class | `src/skills/providers/builtin.ts` | 内置来源（编译进二进制，最高优先级） |
| 6 | `BundledSkillProvider` | class | `src/skills/providers/bundled.ts` | Bundled 来源（随发行版附带） |
| 7 | `DiskSkillProvider` | class | `src/skills/providers/disk.ts` | 磁盘来源（`.omniagent/skills/*.md`） |
| 8 | `McpSkillProvider` | class | `src/skills/providers/mcp.ts` | MCP 来源（通过 MCP server 提供） |
| 9 | `LegacySkillProvider` | class | `src/skills/providers/legacy.ts` | Legacy 兼容旧格式 |
| 10 | `SkillLoader` | class | `src/skills/loader.ts` | 加载入口（按优先级聚合 5 Provider） |
| 11 | `SkillValidator` | class | `src/skills/validator.ts` | 16 字段 frontmatter 校验（gray-matter + schema） |
| 12 | `SkillRegistry` | class | `src/skills/registry.ts` | 注册表 + 优先级覆盖 + 与内置命令冲突检测 |
| 13 | `SkillNameRegistry` | class | `src/skills/name-registry.ts` | name 唯一性 + 内置命令冲突检测 |
| 14 | `SkillHotReloader` | class | `src/skills/hot-reloader.ts` | chokidar watch `.omniagent/skills/` |
| 15 | `SkillExecutor` | class | `src/skills/executor.ts` | 执行入口（dispatch inline/fork） |
| 16 | `InlineSkillExecutor` | class | `src/skills/executors/inline.ts` | inline 模式（注入当前 Agent 上下文） |
| 17 | `ForkSkillExecutor` | class | `src/skills/executors/fork.ts` | fork 模式（委托 M5 `agent_router(route=fork)`） |
| 18 | `SkillTool` | class | `src/skills/skill-tool.ts` | 注册为 M3 系统工具（skill_invoke / skill_list / skill_install / skill_uninstall） |
| 19 | `SkillTriggerMatcher` | class | `src/skills/trigger-matcher.ts` | 命令/事件双触发匹配 |
| 20 | `SkillPermissionResolver` | class | `src/skills/permission-resolver.ts` | Skill 的 permissions 字段解析为 PermissionRule[] |
| 21 | `SkillToolWhitelist` | class | `src/skills/tool-whitelist.ts` | Skill 的 tools 字段解析为工具白名单 |
| 22 | `SkillRetryPolicy` | class | `src/skills/retry-policy.ts` | retry/timeout/fallback 策略实施 |
| 23 | `SkillFallbackHandler` | class | `src/skills/fallback-handler.ts` | 失败降级（error/skip/inline） |
| 24 | `SkillEventBridge` | class | `src/skills/event-bridge.ts` | 事件触发桥接（PreToolUse/PostToolUse 等 Hook 事件） |
| 25 | `SkillSandboxGuard` | class | `src/skills/sandbox-guard.ts` | `.omniagent/skills/` 防注入守护（依赖 M4 sandbox deny） |

### 2.2 公共接口签名

#### 2.2.1 `SkillProvider`（5 来源统一接口）

```typescript
/**
 * 5 来源统一接口（PRD mod-06 §4.1）
 * 每个来源实现此接口，SkillLoader 按优先级聚合
 */
interface SkillProvider {
  /** 来源标识 */
  readonly source: SkillSource;
  /** 优先级（builtin=1 > bundled=2 > disk=3 > mcp=4 > legacy=5，数字越小优先级越高） */
  readonly priority: number;
  /** 加载所有 skill（启动期与热加载期调用） */
  loadAll(): Promise<{ skills: Skill[]; errors: SkillLoadError[] }>;
  /** 单条获取（运行期 trigger 匹配用） */
  get(name: string): Skill | undefined;
  /** 是否支持热加载（builtin/bundled 编译进二进制，不支持热加载；disk/mcp/legacy 支持） */
  readonly supportsHotReload: boolean;
}

/** Skill 加载错误（单个 skill 失败不影响其他） */
interface SkillLoadError {
  filePath: string;
  field?: string;
  message: string;
  /** 错误码（参考 §5.1） */
  code: 'SKILL_FRONTMATTER_INVALID' | 'SKILL_NAME_CONFLICT' | 'SKILL_NAME_BUILTIN_CLASH' | 'SKILL_PERMISSION_INVALID' | 'SKILL_TOOL_UNKNOWN' | 'SKILL_OVER_LIMIT';
}
```

#### 2.2.2 `SkillLoader`（加载入口）

```typescript
class SkillLoader {
  constructor(
    private providers: SkillProvider[],  // 按 priority 升序排列
    private validator: SkillValidator,
    private nameRegistry: SkillNameRegistry,
    private registry: SkillRegistry,
  ) {}

  /**
   * 启动期加载（L2 §1.5 第 8 步）
   * 按 priority 顺序加载 5 来源，校验 16 字段 frontmatter，冲突检测，注册
   */
  static async create(): Promise<SkillLoader> {
    const providers: SkillProvider[] = [
      new BuiltinSkillProvider(),
      new BundledSkillProvider(),
      new DiskSkillProvider(),
      new McpSkillProvider(),
      new LegacySkillProvider(),
    ].sort((a, b) => a.priority - b.priority);

    const validator = new SkillValidator();
    const nameRegistry = new SkillNameRegistry();
    const registry = new SkillRegistry();
    const loader = new SkillLoader(providers, validator, nameRegistry, registry);
    await loader.loadAll();
    return loader;
  }

  /** 加载所有来源（启动期 + 热加载期复用） */
  async loadAll(): Promise<{ loaded: number; errors: SkillLoadError[] }> {
    const allErrors: SkillLoadError[] = [];
    let loadedCount = 0;

    for (const provider of this.providers) {
      const { skills, errors } = await provider.loadAll();
      allErrors.push(...errors);

      for (const skill of skills) {
        // 1. 校验 16 字段 frontmatter
        const validation = this.validator.validate(skill);
        if (!validation.ok) {
          allErrors.push({ filePath: skill.filePath ?? '<inline>', message: validation.error, code: 'SKILL_FRONTMATTER_INVALID' });
          continue;  // 校验失败的 skill 不影响其他
        }

        // 2. name 唯一性 + 内置命令冲突检测
        const nameCheck = this.nameRegistry.check(skill.frontmatter.name, skill.source);
        if (!nameCheck.ok) {
          allErrors.push({ filePath: skill.filePath ?? '<inline>', message: nameCheck.error, code: nameCheck.code });
          continue;
        }

        // 3. 注册（按优先级覆盖：高优先级 source 已注册的同名 skill 不被低优先级覆盖）
        this.registry.register(skill);
        loadedCount++;
      }
    }

    // 4. 错误日志（不 fail-closed 启动，单个 skill 失败不影响其他，PRD §4.3 + §6.1）
    if (allErrors.length > 0) {
      console.warn(`[Skills] ${allErrors.length} skill(s) failed to load:`);
      for (const err of allErrors) {
        console.warn(`  - ${err.filePath}: ${err.message}`);
      }
    }

    return { loaded: loadedCount, errors: allErrors };
  }

  /** 热加载（chokidar 触发，仅 disk/mcp/legacy 来源） */
  async reload(): Promise<{ loaded: number; errors: SkillLoadError[] }> {
    this.registry.clear();  // 清空 disk/mcp/legacy（保留 builtin/bundled）
    return this.loadAll();
  }
}
```

#### 2.2.3 `SkillValidator`（16 字段校验）

```typescript
class SkillValidator {
  /** 校验 16 字段 frontmatter（PRD §3.2 + omniagent-types.ts §16） */
  validate(skill: Skill): { ok: true } | { ok: false; error: string } {
    const fm = skill.frontmatter;

    // 1. 必填字段（name/description/tools/scope）
    if (!fm.name || typeof fm.name !== 'string') return { ok: false, error: 'name is required and must be string' };
    if (!fm.description || typeof fm.description !== 'string') return { ok: false, error: 'description is required' };
    if (!Array.isArray(fm.tools) || fm.tools.length === 0) return { ok: false, error: 'tools must be non-empty array' };
    if (!['project', 'user', 'builtin'].includes(fm.scope)) return { ok: false, error: 'scope must be project|user|builtin' };

    // 2. name 命名规范（snake_case 或 kebab-case，禁内置命令前缀冲突）
    if (!/^[a-z][a-z0-9_-]{2,63}$/.test(fm.name)) {
      return { ok: false, error: 'name must match ^[a-z][a-z0-9_-]{2,63}$ (snake_case or kebab-case)' };
    }

    // 3. description 长度（≤ 500 字符，避免 system prompt 膨胀）
    if (fm.description.length > 500) return { ok: false, error: 'description must be ≤ 500 chars' };

    // 4. tools 数组元素校验（每项必须是已知工具名，避免引用不存在的工具）
    for (const t of fm.tools) {
      if (typeof t !== 'string' || t.length === 0) return { ok: false, error: `tool name "${t}" invalid` };
      // 工具名是否存在于 M3 工具池，由 SkillToolWhitelist 二次校验
    }

    // 5. permissions 字段值校验
    if (fm.permissions) {
      for (const [tool, decision] of Object.entries(fm.permissions)) {
        if (!['allow', 'deny', 'ask'].includes(decision)) {
          return { ok: false, error: `permissions.${tool} must be allow|deny|ask` };
        }
      }
    }

    // 6. mode 校验
    if (fm.mode && !['inline', 'fork'].includes(fm.mode)) {
      return { ok: false, error: 'mode must be inline|fork' };
    }

    // 7. retry 校验
    if (fm.retry) {
      if (typeof fm.retry.max !== 'number' || fm.retry.max < 0 || fm.retry.max > 5) {
        return { ok: false, error: 'retry.max must be 0-5' };
      }
      if (!['linear', 'exponential'].includes(fm.retry.backoff)) {
        return { ok: false, error: 'retry.backoff must be linear|exponential' };
      }
    }

    // 8. fallback 校验
    if (fm.fallback && !['error', 'skip', 'inline'].includes(fm.fallback)) {
      return { ok: false, error: 'fallback must be error|skip|inline' };
    }

    // 9. timeout 校验（>0 且 ≤ 600s）
    if (fm.timeout !== undefined && (fm.timeout <= 0 || fm.timeout > 600_000)) {
      return { ok: false, error: 'timeout must be (0, 600000] ms' };
    }

    // 10. body 非空（Skill 必须有 Instructions）
    if (!skill.body || skill.body.trim().length === 0) {
      return { ok: false, error: 'body (Instructions) must be non-empty' };
    }

    return { ok: true };
  }
}
```

#### 2.2.4 `SkillRegistry`（注册表 + 优先级覆盖）

```typescript
class SkillRegistry {
  /** name → Skill 映射（按优先级覆盖：高优先级已注册的同名 skill 不被低优先级覆盖） */
  private skills = new Map<string, Skill>();
  /** name → source 映射（用于冲突提示） */
  private sourceBy = new Map<string, SkillSource>();

  /** 注册（按 priority 升序调用，先 builtin → bundled → disk → mcp → legacy） */
  register(skill: Skill): void {
    const existing = this.skills.get(skill.frontmatter.name);
    if (existing) {
      // 已有更高优先级的同名 skill，跳过（PRD §4.1：内置不可覆盖）
      // 但不报错（多来源同名时取最高优先级是预期行为）
      return;
    }
    this.skills.set(skill.frontmatter.name, skill);
    this.sourceBy.set(skill.frontmatter.name, skill.source);
  }

  /** 获取（trigger 匹配用） */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** 列出所有（skill_list 工具用） */
  list(): Skill[] {
    return [...this.skills.values()];
  }

  /** 清空（热加载期：保留 builtin/bundled，重载 disk/mcp/legacy） */
  clear(filter?: (source: SkillSource) => boolean): void {
    const keep = filter ?? ((s) => s === 'builtin' || s === 'bundled');
    for (const [name, source] of this.sourceBy) {
      if (!keep(source)) {
        this.skills.delete(name);
        this.sourceBy.delete(name);
      }
    }
  }
}
```

#### 2.2.5 `SkillNameRegistry`（name 唯一性 + 内置命令冲突检测）

```typescript
class SkillNameRegistry {
  /** 内置命令保留名（PRD §4.1：skill 名与内置命令重名时，内置优先，提示用户改名，不覆盖内置） */
  private static BUILTIN_RESERVED = new Set([
    '/help', '/exit', '/compact', '/rewind', '/resume', '/clear',
    '/agents', '/skills', '/hooks', '/config', '/memory', '/mode',
    '/fast', '/slow', '/share', '/issue', '/model', '/tools',
  ]);

  /** 同 source 内 name 唯一性 + 内置命令冲突检测 */
  check(name: string, source: SkillSource): { ok: true } | { ok: false; error: string; code: SkillLoadError['code'] } {
    // 1. 内置命令冲突（/code-review 与 /code-review 已存在的内置命令冲突）
    if (name.startsWith('/')) {
      if (SkillNameRegistry.BUILTIN_RESERVED.has(name)) {
        return { ok: false, error: `name "${name}" conflicts with built-in command`, code: 'SKILL_NAME_BUILTIN_CLASH' };
      }
    }

    // 2. 不以 / 开头的 name（命令触发 /<name> 仍可用，但需检查不与已有的 /<name> 冲突）
    // 此处只做命名规范检查，name 唯一性由 SkillRegistry.register 的覆盖逻辑保证
    return { ok: true };
  }
}
```

#### 2.2.6 `SkillHotReloader`（热插拔）

```typescript
import chokidar from 'chokidar';

class SkillHotReloader {
  private watcher: chokidar.FSWatcher | undefined;

  constructor(
    private skillsDir: string,  // .omniagent/skills/
    private loader: SkillLoader,
    private toolPool: ToolPool,  // M3 工具池（reload 后新 agent 取新快照）
  ) {}

  /** 启动 chokidar watch */
  start(): void {
    this.watcher = chokidar.watch(`${this.skillsDir}/*.md`, {
      ignoreInitial: true,  // 启动期已加载，不重复触发
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },  // 防止写一半触发
    });

    this.watcher.on('add', (path) => this.handleChange(path, 'add'));
    this.watcher.on('change', (path) => this.handleChange(path, 'change'));
    this.watcher.on('unlink', (path) => this.handleChange(path, 'unlink'));
  }

  /** 文件变化处理（reload + 触发 ToolPool 热加载） */
  private async handleChange(path: string, event: 'add' | 'change' | 'unlink'): Promise<void> {
    console.log(`[Skills] hot reload: ${event} ${path}`);

    // 1. 重载 SkillRegistry（保留 builtin/bundled，重载 disk/mcp/legacy）
    const { loaded, errors } = await this.loader.reload();

    // 2. 重建 SkillToolWhitelist（已注册 skill 的 tools 字段聚合）
    const skillTools = this.buildSkillTools();
    this.toolPool.reload(skillTools);  // L2 §5.4.3：写时复制，新 agent BUILD_CONTEXT 取新快照

    // 3. 错误日志（单个 skill 校验失败不影响其他）
    if (errors.length > 0) {
      console.warn(`[Skills] ${errors.length} skill(s) failed to reload`);
    }

    // 4. metrics 埋点（L2 §7.4）
    metrics.counter('skills.hot_reload.total', { event });
    metrics.gauge('skills.loaded', loaded);
  }

  /** 停止 watch（关闭期） */
  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  private buildSkillTools(): Tool[] {
    // 把每个 Skill 包装为 skill_invoke 工具（详见 §3.8 SkillTool）
    return [];
  }
}
```

#### 2.2.7 `SkillExecutor`（执行入口）

```typescript
class SkillExecutor {
  constructor(
    private inlineExecutor: InlineSkillExecutor,
    private forkExecutor: ForkSkillExecutor,
    private retryPolicy: SkillRetryPolicy,
    private fallbackHandler: SkillFallbackHandler,
  ) {}

  /**
   * Skill 执行入口（被 SkillTool.call 调用，或被 SkillEventBridge 触发）
   * 按 frontmatter.mode 分发到 inline/fork 执行器
   */
  async execute(params: SkillExecuteParams): Promise<SkillExecuteResult> {
    const { skill, args, parentAgentId, traceId } = params;
    const mode = skill.frontmatter.mode ?? 'inline';  // 默认 inline（PRD §3.2 mode 可选）

    // 1. retry 包装（PRD §3.2 retry 字段）
    const result = await this.retryPolicy.runWithRetry(
      () => mode === 'fork'
        ? this.forkExecutor.execute({ skill, args, parentAgentId, traceId })
        : this.inlineExecutor.execute({ skill, args, parentAgentId, traceId }),
      skill.frontmatter.retry ?? { max: 0, backoff: 'linear' },
    );

    // 2. 失败降级（PRD §3.2 fallback 字段）
    if (!result.ok && skill.frontmatter.fallback) {
      return this.fallbackHandler.handle(skill, result.error, params);
    }

    return result;
  }
}

interface SkillExecuteParams {
  skill: Skill;
  args?: Record<string, unknown>;
  parentAgentId: AgentId;
  traceId: TraceId;
}

interface SkillExecuteResult {
  ok: boolean;
  output?: string;
  error?: OmniAgentError;
}
```

#### 2.2.8 `InlineSkillExecutor`（inline 模式）

```typescript
class InlineSkillExecutor {
  constructor(
    private systemPromptBuilder: SystemPromptBuilder,  // M7 §3.4 三阶段组装
    private permissionResolver: SkillPermissionResolver,
    private toolWhitelist: SkillToolWhitelist,
  ) {}

  /**
   * inline 模式：Skill 的 prompt 直接注入当前 Agent 上下文（PRD §4.2）
   * 共享工具池与权限（不是新 spawn agent）
   */
  async execute(params: SkillExecuteParams): Promise<SkillExecuteResult> {
    const { skill, args, parentAgentId, traceId } = params;

    // 1. 解析 Skill 的 permissions → PermissionRule[]（注入 M4 Layer 2）
    const permRules = this.permissionResolver.resolve(skill);

    // 2. 解析 Skill 的 tools → 工具白名单（注入 M3 mergeAndFilterTools）
    const whitelist = this.toolWhitelist.resolve(skill);

    // 3. 构造 Skill prompt（frontmatter + body + args）
    const skillPrompt = this.buildSkillPrompt(skill, args);

    // 4. 通过 M7 SystemPromptBuilder 注入（priority=4 'custom' 层）
    //    M7 §3.4 三阶段组装：getSystemPrompt → buildEffectiveSystemPrompt → buildSystemPromptBlocks
    this.systemPromptBuilder.injectCustomPrompt(parentAgentId, {
      source: `skill:${skill.frontmatter.name}`,
      priority: 4,  // 'custom' 优先级
      content: skillPrompt,
      permRules,    // M4 Layer 2 用
      toolWhitelist: whitelist,  // M3 工具池过滤用
    });

    // 5. inline 模式不立即返回 output（prompt 注入后，M2 ReAct Loop 下一轮 LLM 调用时会用到）
    //    SkillExecutor 的调用方（SkillTool）收到的是"已注入"的确认
    return {
      ok: true,
      output: `Skill "${skill.frontmatter.name}" injected into agent context`,
    };
  }

  private buildSkillPrompt(skill: Skill, args?: Record<string, unknown>): string {
    const fm = skill.frontmatter;
    return [
      `# Skill: ${fm.name}`,
      fm.description,
      '',
      '## Instructions',
      skill.body,
      ...(args ? ['','## Args', JSON.stringify(args, null, 2)] : []),
    ].join('\n');
  }
}
```

#### 2.2.9 `ForkSkillExecutor`（fork 模式 + 不变量 #5 契约）

```typescript
class ForkSkillExecutor {
  constructor(
    private orchestrator: Orchestrator,  // M5 主入口（route=fork）
  ) {}

  /**
   * fork 模式：Skill 在独立 fork agent 执行（PRD §4.2 + §5 不变量 #5 契约）
   * 委托 M5 agent_router(route=fork)（不变量 #5 由 M5 ForkAgentSpawner 守护，本模块只触发）
   */
  async execute(params: SkillExecuteParams): Promise<SkillExecuteResult> {
    const { skill, args, parentAgentId, traceId } = params;

    // 1. 构造 fork prompt（Skill prompt + args）
    const forkPrompt = this.buildForkPrompt(skill, args);

    // 2. 委托 M5 agent_router route=fork
    //    M5 Orchestrator.route() 签名：AgentRouterParams & { parentAgentId, traceId }（L3-M5 §2.2.1）
    //    → ForkAgentSpawner.spawn()
    //    ForkAgentSpawner.fillPlaceholderToolResults() 守护不变量 #5（prompt cache prefix byte-identical）
    //    fork agent 继承父 agent 工具池（byte-identical）+ 独立 sidechain（M7 createSidechain）
    //
    //    AgentRouterParams 字段（omniagent-types.ts §8）：
    //      - route: 'fork'
    //      - prompt: forkPrompt
    //      - parent_context_mode: 'isolated'（fork 模式默认隔离，独立 sidechain）
    //      - tools_whitelist: skill.frontmatter.tools（fork agent 工具池白名单，继承父后再过滤）
    //      - timeout_ms: skill.frontmatter.timeout
    //    额外 harness 字段（L3-M5 §2.2.1 Orchestrator.route 签名扩展）：
    //      - parentAgentId, traceId
    //
    //    Skill 的 permissions 字段不通过 AgentRouterParams 传递（AgentRouterParams 无此字段）；
    //    由 SkillPermissionResolver 解析为 PermissionRule[] 后，经 M4 PermissionEngine
    //    在 fork agent 的工具调用时生效（Layer 2 三维匹配）。
    const result: AgentRouterResult = await this.orchestrator.route({
      route: 'fork',
      prompt: forkPrompt,
      parent_context_mode: 'isolated',
      tools_whitelist: skill.frontmatter.tools,
      timeout_ms: skill.frontmatter.timeout,
      parentAgentId,
      traceId,
    } as AgentRouterParams & { parentAgentId: AgentId; traceId: TraceId });

    // 3. fork agent 完成后，结果回注（M5 route=fork 默认 sync，等待结果）
    if (result.status === 'completed') {
      return {
        ok: true,
        output: result.output ?? `Skill "${skill.frontmatter.name}" completed in fork agent`,
      };
    }

    return {
      ok: false,
      error: {
        code: 'TOOL_EXECUTION_ERROR',
        message: `Skill fork failed: ${result.status}`,
        module: 'M6',
        retryable: false,
        fallbackAction: skill.frontmatter.fallback,
        traceId,
      },
    };
  }

  private buildForkPrompt(skill: Skill, args?: Record<string, unknown>): string {
    // 与 inline 模式相同的 prompt 结构（fork agent 接收完整 Skill prompt）
    return [
      `# Skill: ${skill.frontmatter.name}`,
      skill.frontmatter.description,
      '',
      '## Instructions',
      skill.body,
      ...(args ? ['', '## Args', JSON.stringify(args, null, 2)] : []),
    ].join('\n');
  }
}
```

#### 2.2.10 `SkillTool`（M3 系统工具注册）

```typescript
import { buildTool } from './tools/builder';  // M3 §3.1

/**
 * 注册为 M3 系统工具（PRD §4.1 工具接入 + M3 §3.1 buildTool）
 * 4 个工具：skill_invoke / skill_list / skill_install / skill_uninstall
 * （M3 §3.7 已声明这 4 个工具，本类提供实施）
 */
class SkillTool {
  constructor(
    private registry: SkillRegistry,
    private executor: SkillExecutor,
    private loader: SkillLoader,
  ) {}

  /** skill_invoke：调用 skill（用户 /skill-name 或 LLM 触发） */
  buildInvokeTool(): Tool {
    return buildTool({
      name: 'skill_invoke',
      description: 'Invoke a skill by name with optional args',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name' },
          args: { type: 'object', description: 'Optional args' },
        },
        required: ['name'],
      },
      isReadOnly: false,  // fail-closed 默认（M3 §3.1 buildTool 默认值）
      isDestructive: false,  // skill 本身不破坏（具体破坏性由其触发的工具决定）
      isConcurrencySafe: true,
      isBackground: false,
      compactable: true,  // 工具结果可被 M7 压缩
    }, async (input, ctx) => {
      const skill = this.registry.get(input.name);
      if (!skill) {
        return { content: `Skill "${input.name}" not found`, is_error: true };
      }
      const result = await this.executor.execute({
        skill,
        args: input.args,
        parentAgentId: ctx.agentId,
        traceId: ctx.traceId,
      });
      if (!result.ok) {
        return { content: result.error?.message ?? 'skill execution failed', is_error: true };
      }
      return { content: result.output ?? '', is_error: false };
    });
  }

  /** skill_list：列出已加载 skill */
  buildListTool(): Tool {
    return buildTool({
      name: 'skill_list',
      description: 'List all loaded skills',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isBackground: false,
      compactable: true,
    }, async (_input, _ctx) => {
      const skills = this.registry.list();
      const summary = skills.map(s => `- ${s.frontmatter.name} (${s.source}): ${s.frontmatter.description}`).join('\n');
      return { content: summary, is_error: false };
    });
  }

  /** skill_install：安装新 skill（写入 .omniagent/skills/） */
  buildInstallTool(): Tool {
    return buildTool({
      name: 'skill_install',
      description: 'Install a new skill by writing to .omniagent/skills/',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          content: { type: 'string', description: 'Full skill markdown (frontmatter + body)' },
        },
        required: ['name', 'content'],
      },
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isBackground: false,
      compactable: false,
    }, async (input, ctx) => {
      // 1. 写文件到 .omniagent/skills/<name>.md
      const filePath = `${ctx.cwd}/.omniagent/skills/${input.name}.md`;
      await fs.promises.writeFile(filePath, input.content, { mode: 0o644 });

      // 2. chokidar 自动触发 reload（SkillHotReloader 监听 add 事件）
      //    不直接调 loader.reload()，避免重复
      return { content: `Skill "${input.name}" installed at ${filePath}, hot reload will pick it up`, is_error: false };
    });
  }

  /** skill_uninstall：卸载 skill（删除文件） */
  buildUninstallTool(): Tool {
    return buildTool({
      name: 'skill_uninstall',
      description: 'Uninstall a skill by deleting its file',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      isReadOnly: false,
      isDestructive: true,  // 删除文件 → 标 destructive（fail-closed 默认）
      isConcurrencySafe: false,
      isBackground: false,
      compactable: false,
    }, async (input, ctx) => {
      const skill = this.registry.get(input.name);
      if (!skill?.filePath) {
        return { content: `Skill "${input.name}" not found or has no file path`, is_error: true };
      }
      // 内置/bundled 不允许卸载
      if (skill.source === 'builtin' || skill.source === 'bundled') {
        return { content: `Skill "${input.name}" is ${skill.source}, cannot uninstall`, is_error: true };
      }
      await fs.promises.unlink(skill.filePath);
      return { content: `Skill "${input.name}" uninstalled`, is_error: false };
    });
  }

  /** 暴露给 M3 工具池的所有 4 个工具 */
  buildAll(): Tool[] {
    return [this.buildInvokeTool(), this.buildListTool(), this.buildInstallTool(), this.buildUninstallTool()];
  }
}
```

#### 2.2.11 `SkillTriggerMatcher`（命令/事件双触发）

```typescript
class SkillTriggerMatcher {
  constructor(private registry: SkillRegistry) {}

  /**
   * 命令触发匹配（PRD §3.2 triggers 字段）
   * 用户输入 /code-review → 匹配 triggers: ['/code-review'] 的 skill
   */
  matchByCommand(command: string): Skill | undefined {
    for (const skill of this.registry.list()) {
      const triggers = skill.frontmatter.triggers ?? [];
      for (const t of triggers) {
        if (t.startsWith('/')) {
          // 命令触发：精确匹配或前缀匹配
          if (t === command || command.startsWith(t + ' ')) {
            return skill;
          }
        }
      }
    }
    return undefined;
  }

  /**
   * 事件触发匹配（PRD §3.2 triggers 字段）
   * M4 Hook 事件 PreToolUse:edit_file → 匹配 triggers: ['PreToolUse:edit_file'] 的 skill
   */
  matchByEvent(eventName: HookEventName, payload: HookPayload): Skill[] {
    const matches: Skill[] = [];
    for (const skill of this.registry.list()) {
      const triggers = skill.frontmatter.triggers ?? [];
      for (const t of triggers) {
        if (t.startsWith(eventName + ':')) {
          // 事件触发：匹配事件 + 工具名
          const [, toolName] = t.split(':');
          if (toolName === '*' || toolName === payload.tool_name) {
            matches.push(skill);
          }
        }
      }
    }
    return matches;
  }
}
```

#### 2.2.12 `SkillPermissionResolver`（权限配置解析）

```typescript
class SkillPermissionResolver {
  /**
   * 解析 Skill 的 permissions 字段为 PermissionRule[]（注入 M4 Layer 2）
   * PRD §3.1 示例：permissions: { bash: ask, edit_file: deny }
   */
  resolve(skill: Skill): PermissionRule[] {
    const fm = skill.frontmatter;
    if (!fm.permissions) return [];

    const rules: PermissionRule[] = [];
    for (const [tool, decision] of Object.entries(fm.permissions)) {
      rules.push({
        tool,
        decision,  // 'allow' | 'deny' | 'ask'
        source: `skill:${fm.name}`,  // PermissionRuleSource 8 层优先级中的 'skill' 层
        // scope 字段控制 priority：project=6, user=5, builtin=3
        priority: fm.scope === 'builtin' ? 3 : fm.scope === 'user' ? 5 : 6,
      });
    }
    return rules;
  }
}
```

#### 2.2.13 `SkillToolWhitelist`（工具白名单解析）

```typescript
class SkillToolWhitelist {
  constructor(
    private toolPool: ToolPool,  // M3 工具池（验证工具名是否存在）
  ) {}

  /**
   * 解析 Skill 的 tools 字段为工具白名单
   * PRD §3.1 示例：tools: [read_file, glob, grep, bash]
   * 校验：每项必须是 M3 工具池中已注册的工具（fail-closed 拒绝引用不存在的工具）
   */
  resolve(skill: Skill): { ok: true; whitelist: string[] } | { ok: false; error: string; missingTools: string[] } {
    const fm = skill.frontmatter;
    const whitelist: string[] = [];
    const missing: string[] = [];

    for (const t of fm.tools) {
      if (this.toolPool.get(t)) {
        whitelist.push(t);
      } else {
        missing.push(t);
      }
    }

    if (missing.length > 0) {
      // fail-closed：引用不存在的工具时拒绝整个 Skill 加载
      return {
        ok: false,
        error: `Skill "${fm.name}" references unknown tools: ${missing.join(', ')}`,
        missingTools: missing,
      };
    }

    return { ok: true, whitelist };
  }
}
```

#### 2.2.14 `SkillRetryPolicy`（retry/timeout 策略）

```typescript
class SkillRetryPolicy {
  /**
   * 带 retry 的执行包装（PRD §3.2 retry 字段）
   * retry: { max: 3, backoff: 'exponential' }
   */
  async runWithRetry<T>(
    fn: () => Promise<T>,
    retry: { max: number; backoff: 'linear' | 'exponential' },
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retry.max; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e;
        if (attempt < retry.max) {
          const delay = retry.backoff === 'exponential'
            ? Math.min(100 * Math.pow(2, attempt), 5000)  // 100ms, 200ms, 400ms... 上限 5s
            : 100 * (attempt + 1);  // 100ms, 200ms, 300ms...
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }
}
```

#### 2.2.15 `SkillFallbackHandler`（失败降级）

```typescript
class SkillFallbackHandler {
  constructor(
    private inlineExecutor: InlineSkillExecutor,  // fallback: 'inline' 时降级到 inline
  ) {}

  /**
   * 失败降级（PRD §3.2 fallback 字段）
   * fallback: 'error' | 'skip' | 'inline'
   */
  async handle(
    skill: Skill,
    error: OmniAgentError,
    params: SkillExecuteParams,
  ): Promise<SkillExecuteResult> {
    const fallback = skill.frontmatter.fallback ?? 'error';

    switch (fallback) {
      case 'error':
        return { ok: false, error };

      case 'skip':
        // 跳过 skill 执行，返回空结果
        return { ok: true, output: `Skill "${skill.frontmatter.name}" skipped due to error: ${error.message}` };

      case 'inline':
        // fork 模式失败时降级为 inline（PRD §4.2 双模式灵活）
        if (skill.frontmatter.mode === 'fork') {
          const inlineResult = await this.inlineExecutor.execute(params);
          return inlineResult.ok
            ? { ...inlineResult, output: `(fallback to inline) ${inlineResult.output}` }
            : inlineResult;
        }
        return { ok: false, error };

      default:
        return { ok: false, error };
    }
  }
}
```

#### 2.2.16 `SkillEventBridge`（事件触发桥接）

```typescript
class SkillEventBridge {
  constructor(
    private triggerMatcher: SkillTriggerMatcher,
    private executor: SkillExecutor,
  ) {}

  /**
   * M4 Hook 事件桥接（PRD §3.2 triggers 字段 + L2 §8.1 Layer 5 Hooks）
   * 当 M4 触发 PreToolUse:edit_file 等事件时，调用此方法
   */
  async onHookEvent(eventName: HookEventName, payload: HookPayload, parentAgentId: AgentId): Promise<HookResponse> {
    const matches = this.triggerMatcher.matchByEvent(eventName, payload);
    if (matches.length === 0) {
      return { permissionDecision: 'allow' };  // 无 skill 匹配，不干预
    }

    // 触发匹配的所有 skill（按 priority 顺序）
    for (const skill of matches) {
      const result = await this.executor.execute({
        skill,
        args: { event: eventName, payload },
        parentAgentId,
        traceId: payload.traceId,
      });
      if (!result.ok) {
        // skill 执行失败不阻断主流程（fallback 由 SkillExecutor 处理）
        console.warn(`[Skills] event-triggered skill "${skill.frontmatter.name}" failed: ${result.error?.message}`);
      }
    }

    // skill 触发的工具调用经 M4 五层拦截链重新评估
    return { permissionDecision: 'allow' };
  }
}
```

#### 2.2.17 `SkillSandboxGuard`（防注入守护）

```typescript
class SkillSandboxGuard {
  /**
   * .omniagent/skills/ 目录防注入守护（PRD §6.2 + 不变量 #10）
   * 依赖 M4 sandbox deny（L2 §8.1.3 sandbox-exec profile 第 2 项 deny 路径）
   *
   * 本类不做沙箱执行（M4 负责），只做：
   * 1. 启动期校验 .omniagent/skills/ 目录权限（0o755，owner 仅用户）
   * 2. 监控 skills 目录是否被外部进程修改（chokidar 已监听，异常变化告警）
   * 3. skill_install / skill_uninstall 工具调用前的路径校验（防 ../ 路径穿越）
   */
  async validateSkillsDir(skillsDir: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const stat = await fs.promises.stat(skillsDir);
      if (!stat.isDirectory()) return { ok: false, error: `${skillsDir} is not a directory` };
      // 权限校验（owner 必须是当前用户，mode 不超过 0o755）
      const mode = stat.mode & 0o777;
      if (mode > 0o755) {
        return { ok: false, error: `${skillsDir} mode ${mode.toString(8)} too permissive (max 0o755)` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `skills dir stat failed: ${(e as Error).message}` };
    }
  }

  /**
   * 路径穿越防护（skill_install 工具用）
   * 防止 name 包含 ../ 或绝对路径，写入到 skills 目录外
   */
  sanitizeSkillName(name: string): { ok: true; name: string } | { ok: false; error: string } {
    // 仅允许 [a-z][a-z0-9_-]{2,63}（与 SkillValidator.name 校验一致）
    if (!/^[a-z][a-z0-9_-]{2,63}$/.test(name)) {
      return { ok: false, error: `skill name "${name}" invalid (path traversal risk)` };
    }
    return { ok: true, name };
  }
}
```

---

## 3. 详细设计

### 3.1 5 来源分层与优先级（引用 PRD §4.1，不重复）

PRD mod-06 §4.1 已定 5 来源与优先级（内置 > Bundled > 磁盘 > MCP > Legacy，内置不可覆盖）。omniagent-types.ts §16 已定义 `SkillSource` 类型。本节补 5 Provider 的实施矩阵：

| 来源 | Provider 类 | 路径 | 优先级 | 热加载支持 | 加载时机 |
|------|-----------|------|--------|---------|---------|
| 内置 | `BuiltinSkillProvider` | 编译进二进制（`src/skills/builtin/*.md`） | 1（最高） | 否 | 启动期 |
| Bundled | `BundledSkillProvider` | 随发行版附带（`~/.omniagent/bundled-skills/*.md`） | 2 | 否 | 启动期 |
| 磁盘 | `DiskSkillProvider` | `.omniagent/skills/*.md`（项目级，git tracked） | 3 | 是 | 启动期 + chokidar |
| MCP | `McpSkillProvider` | 通过 MCP server 提供 | 4 | 是 | MCP 连接时 |
| Legacy | `LegacySkillProvider` | 兼容旧格式（`~/.omniagent/legacy-skills/*.json`） | 5 | 是 | 启动期 |

#### 3.1.1 优先级覆盖算法

`SkillLoader.loadAll()` 按 priority 升序调用 5 Provider，先 builtin → bundled → disk → mcp → legacy。`SkillRegistry.register()` 检查同名 skill：

- 已注册（更高优先级）→ 跳过低优先级同名 skill（不报错，多来源同名取最高优先级是预期）
- 未注册 → 写入 `skills` Map

#### 3.1.2 内置命令冲突检测

PRD §4.1 已定"skill 名与内置命令重名时，内置优先，提示用户改名，不覆盖内置"。`SkillNameRegistry.check()` 在 register 前检测：

- name 以 `/` 开头且在 `BUILTIN_RESERVED` 集合中 → 报 `SKILL_NAME_BUILTIN_CLASH` 错误，跳过加载
- 提示用户改名（错误日志含建议名，如 `/code-review` → `code-review`）

`BUILTIN_RESERVED` 集合见 §2.2.5，包含 `/help`/`/exit`/`/compact`/`/rewind`/`/resume`/`/clear`/`/agents`/`/skills`/`/hooks`/`/config`/`/memory`/`/mode`/`/fast`/`/slow`/`/share`/`/issue`/`/model`/`/tools` 共 18 个内置命令。

### 3.2 16 字段 frontmatter 校验（引用 PRD §3.2 + omniagent-types.ts §16，不重复）

PRD mod-06 §3.2 已列 16 字段表，omniagent-types.ts §16 已定义 `SkillFrontmatter` 接口。本节补 `SkillValidator` 校验链实施（§2.2.3 已给代码骨架）：

| # | 字段 | 类型 | 校验规则 | 错误码 |
|---|------|------|---------|--------|
| 1 | `name` | string | 必填，匹配 `^[a-z][a-z0-9_-]{2,63}$` | `SKILL_FRONTMATTER_INVALID` |
| 2 | `description` | string | 必填，≤ 500 字符 | `SKILL_FRONTMATTER_INVALID` |
| 3 | `tools` | string[] | 必填，非空数组，元素为已知工具名 | `SKILL_TOOL_UNKNOWN` |
| 4 | `permissions` | Record<string,'allow'\|'deny'\|'ask'> | 可选，值枚举校验 | `SKILL_PERMISSION_INVALID` |
| 5 | `triggers` | string[] | 可选，元素格式 `/command` 或 `Event:tool` | `SKILL_FRONTMATTER_INVALID` |
| 6 | `scope` | 'project'\|'user'\|'builtin' | 必填，枚举校验 | `SKILL_FRONTMATTER_INVALID` |
| 7 | `mode` | 'inline'\|'fork' | 可选，默认 inline | `SKILL_FRONTMATTER_INVALID` |
| 8 | `async` | boolean | 可选 | `SKILL_FRONTMATTER_INVALID` |
| 9 | `timeout` | number | 可选，范围 (0, 600000] ms | `SKILL_FRONTMATTER_INVALID` |
| 10 | `retry` | { max: 0-5; backoff: 'linear'\|'exponential' } | 可选，max 范围 0-5 | `SKILL_FRONTMATTER_INVALID` |
| 11 | `fallback` | 'error'\|'skip'\|'inline' | 可选，默认 error | `SKILL_FRONTMATTER_INVALID` |
| 12 | `metadata` | Record<string, unknown> | 可选 | — |
| 13 | `version` | string | 可选，建议 semver | — |
| 14 | `author` | string | 可选 | — |
| 15 | `tags` | string[] | 可选 | — |
| 16 | `examples` | string[] | 可选 | — |

**校验失败容错**（PRD §4.3 + §6.1）：单个 skill 校验失败不影响其他 skill 加载，错误记入 `SkillLoadError[]`，日志输出文件路径与行号，跳过该 skill。

### 3.3 SkillRegistry 注册表 + 优先级覆盖（已给代码骨架 §2.2.4）

`SkillRegistry` 维护 `name → Skill` 映射，`register()` 实施优先级覆盖（高优先级已注册时不被低优先级覆盖）。`clear()` 用于热加载期，保留 builtin/bundled（编译进二进制，不变），重载 disk/mcp/legacy。

### 3.4 InlineSkillExecutor 实施（引用 PRD §4.2，不重复）

PRD mod-06 §4.2 已定 inline 模式：Skill 的 prompt 直接注入当前 Agent 上下文，共享工具池与权限。本节补 `InlineSkillExecutor` 类实施（§2.2.8 已给代码骨架）：

#### 3.4.1 inline 注入路径

```
用户输入 /code-review args="src/"
   ↓
SkillTriggerMatcher.matchByCommand('/code-review') → 命中 skill "code-review"
   ↓
SkillExecutor.execute({ skill, args, parentAgentId, traceId })
   ↓
mode === 'inline' → InlineSkillExecutor.execute()
   ↓
1. SkillPermissionResolver.resolve(skill) → PermissionRule[]（注入 M4 Layer 2）
2. SkillToolWhitelist.resolve(skill) → 工具白名单（注入 M3 mergeAndFilterTools）
3. buildSkillPrompt(skill, args) → 完整 prompt
4. SystemPromptBuilder.injectCustomPrompt(parentAgentId, { priority: 4, content: skillPrompt, ... })
   ↓
M7 SystemPromptBuilder 把 skill prompt 作为 'custom' 层（priority 4）合并入 system prompt
   ↓
M2 下一轮 BUILD_CONTEXT → CALL_LLM → LLM 看到 skill prompt + 工具白名单 → 按 Instructions 执行
```

#### 3.4.2 inline 模式与 M7 SystemPromptBuilder 的契约

inline 模式不立即返回 output，而是通过 M7 `SystemPromptBuilder.injectCustomPrompt()` 注入到 system prompt 的 'custom' 层（priority 4）。M7 §3.4 三阶段组装：

1. `getSystemPrompt(ctx)` → 收集所有来源片段，其中 `source: 'skill:<name>', priority: 4` 是 inline 注入的
2. `buildEffectiveSystemPrompt(fragments)` → 5 级优先级合并
3. `buildSystemPromptBlocks(combined)` → 切分静态前缀 + 动态后缀（最大化 prompt cache 命中率）

inline 模式注入的 skill prompt 进入**动态后缀**（每次可能不同），不影响静态前缀的 cache 命中。

### 3.5 ForkSkillExecutor 实施（引用 PRD §4.2 + §5 不变量 #5 契约，不重复）

PRD mod-06 §4.2 + §5 已定 fork 模式：Skill 在独立 fork agent 执行，独立 sidechain，完成后结果回注。**不变量 #5 契约**：fork agent 的 system prompt 与父 agent 完全一致（共享 prefix），工具池继承自父 agent（不重排顺序），通过占位 `tool_result` 填充 fork 点之前的所有 `tool_use`，保证 prefix 字节级一致。此要求由 M5 在 fork 路由中守护，M6 触发 fork 时不需额外操作（M5 已封装 `fillPlaceholderToolResults`）。

本节补 `ForkSkillExecutor` 类实施（§2.2.9 已给代码骨架）：

#### 3.5.1 fork 触发路径

```
用户输入 /big-refactor args="..."
   ↓
SkillTriggerMatcher.matchByCommand('/big-refactor') → 命中 skill "big-refactor" (mode: fork)
   ↓
SkillExecutor.execute({ skill, args, parentAgentId, traceId })
   ↓
mode === 'fork' → ForkSkillExecutor.execute()
   ↓
委托 M5 Orchestrator.route({ route: 'fork', prompt: forkPrompt, parent_context_mode: 'isolated', tools_whitelist, timeout_ms, parentAgentId, traceId })
   ↓
M5 ForkAgentSpawner.spawn()
   ├── 1. 读取父 agent 当前 messages（byte-identical 复制）
   ├── 2. fillPlaceholderToolResults(parentMessages)  ← 守护不变量 #5
   ├── 3. M7 createSidechain({ parentSessionId, initialMessages: forkedMessages })
   ├── 4. spawn fork agent（独立 ReActLoop，继承父工具池 byte-identical）
   ├── 5. fork agent 执行 Skill Instructions
   └── 6. 完成后结果回注（M5 route=fork 默认 sync，等待结果）
   ↓
SkillExecutor 收到 result，返回给 SkillTool
```

#### 3.5.2 不变量 #5 守护责任划分

| 责任 | 守护方 | 实施位置 |
|------|-------|---------|
| fork agent system prompt 与父一致 | M5 | `ForkAgentSpawner.spawn()` 继承父 messages |
| 工具池继承不重排顺序 | M5 + M3 | `ForkAgentSpawner` 传入 `parentToolPool`（不调 `mergeAndFilterTools` 重排） |
| 占位 tool_result 填充 | M5 | `ForkAgentSpawner.fillPlaceholderToolResults()` |
| 触发 fork（不需额外操作） | M6 | `ForkSkillExecutor.execute()` 只调 `orchestrator.route({ route: 'fork', ... })` |

M6 触发 fork 时**不直接操作 messages**，避免破坏不变量 #5。所有 byte-identical 保证由 M5 封装。

### 3.6 热插拔实施（引用 PRD §4.3 + L2 §5.4.3，不重复）

PRD mod-06 §4.3 已定热插拔：文件系统 watch `.omniagent/skills/`，新增/修改/删除即时生效。L2 §5.4.3 已给热加载场景：chokidar 触发 → `toolPool.reload(...)` → 新 agent BUILD_CONTEXT 取新快照，运行中 agent 仍用旧快照直到下次 BUILD_CONTEXT。本节补 `SkillHotReloader` 类实施（§2.2.6 已给代码骨架）：

#### 3.6.1 chokidar watch 配置

```typescript
chokidar.watch(`${this.skillsDir}/*.md`, {
  ignoreInitial: true,  // 启动期已加载，不重复触发
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },  // 防止写一半触发
  // L2 §2.3 选型：chokidar 跨平台稳定（macOS FSEvents / Linux inotify / Windows ReadDirectoryChanges）
});
```

#### 3.6.2 热加载触发链

```
.omniagent/skills/code-review.md 文件变化
   ↓
chokidar 'change' 事件
   ↓
SkillHotReloader.handleChange(path, 'change')
   ↓
1. loader.reload()
   ├── clear(filter=(s => s === 'builtin' || s === 'bundled'))  // 保留内置
   ├── loadAll()  // 重载 disk/mcp/legacy
   └── 返回 { loaded, errors }
   ↓
2. toolPool.reload(skillTools)  // M3 写时复制，新 agent 取新快照
   ↓
3. metrics 埋点（L2 §7.4）：skills.hot_reload.total + skills.loaded gauge
   ↓
4. 错误日志（单个 skill 校验失败不影响其他）
```

#### 3.6.3 运行中 agent 的快照隔离

L2 §5.4.3 已述：MCP server 连接成功新增工具或 Skills 热插拔时，`toolPool.reload(...)` 写时复制，**运行中 agent 仍用旧快照直到下次 BUILD_CONTEXT**。这意味着：

- agent A 正在执行 ReAct Loop（已取旧 ToolPoolSnapshot）
- chokidar 触发 reload → 新 ToolPoolSnapshot 生成
- agent A 继续用旧快照（不含新 skill），直到下一轮 BUILD_CONTEXT 才取新快照
- agent B（新启动）取新快照（含新 skill）

此设计避免运行中 agent 工具池中途变化导致的不可预测行为。

### 3.7 sandbox 防注入（引用 L2 §8.1.3 + 不变量 #10，不重复）

L2 §8.1.3 sandbox-exec profile 模板第 2 项 deny 路径已包含 `(subpath "/Users/liguang/.omniagent/skills")`，由 M4 守护（不变量 #10：sandbox 4 类 deny 路径始终生效）。本节补 `SkillSandboxGuard` 类实施（§2.2.17 已给代码骨架）：

#### 3.7.1 SkillSandboxGuard 的三项职责

1. **启动期校验 `.omniagent/skills/` 目录权限**：mode ≤ 0o755，owner 是当前用户
2. **监控 skills 目录异常变化**：chokidar 已监听，异常变化（如外部进程修改）告警
3. **skill_install / skill_uninstall 路径校验**：防 `../` 路径穿越（`sanitizeSkillName()` 校验 name 仅 `[a-z][a-z0-9_-]{2,63}`）

#### 3.7.2 与 M4 sandbox 的责任划分

| 责任 | 守护方 | 实施 |
|------|-------|------|
| sandbox deny `.omniagent/skills/` 写入 | M4 | sandbox-exec profile `(deny file-write* (subpath ".../skills"))` |
| 启动期目录权限校验 | M6 | `SkillSandboxGuard.validateSkillsDir()` |
| 路径穿越防护 | M6 | `SkillSandboxGuard.sanitizeSkillName()` |
| 异常变化告警 | M6 | chokidar 事件 + metrics 埋点 |

M6 不重复实现沙箱（M4 已守护），只做应用层的权限校验与路径穿越防护。

### 3.8 Skills 工具接入 M3（引用 PRD §5 + L2 §5.4.3，不重复）

PRD mod-06 §5 已定 M6 与 M3 的交互：Skills 加载后其工具白名单通过 M3 的 `mergeAndFilterTools()` 接入工具池；Skills 触发的工具调用经 M3 执行。L2 §5.4.3 已给工具池热加载场景。本节补 `SkillTool` 类实施（§2.2.10 已给代码骨架）：

#### 3.8.1 4 个 Skill 系统工具

M3 §3.7 已声明 4 个系统工具，本模块提供实施：

| 工具名 | isReadOnly | isDestructive | 描述 |
|--------|-----------|--------------|------|
| `skill_invoke` | false（fail-closed） | false | 调用 skill |
| `skill_list` | true | false | 列出已加载 skill |
| `skill_install` | false | false | 安装新 skill（写文件） |
| `skill_uninstall` | false | true（fail-closed） | 卸载 skill（删文件） |

#### 3.8.2 Skills 工具白名单接入流程

```
1. SkillLoader.loadAll() 加载所有 skill
   ↓
2. 对每个 skill 调 SkillToolWhitelist.resolve(skill)
   ├── 校验 tools 字段每项是 M3 工具池中已注册的工具
   └── fail-closed：引用不存在的工具时拒绝整个 skill 加载
   ↓
3. SkillTool.buildAll() 构造 4 个系统工具（skill_invoke/list/install/uninstall）
   ↓
4. M3 ToolPool.create({ baseTools, customAgentTools: skillTools, agentRole: 'main' })
   └── mergeAndFilterTools 把 skill_* 工具接入工具池
   ↓
5. M2 BUILD_CONTEXT → mergeAndFilterTools → 工具池含 skill_* + 其他基础工具
   ↓
6. LLM 可调 skill_invoke({ name: 'code-review', args: {...} })
   ↓
7. M3 工具调度 → SkillTool.invoke 的 callback → SkillExecutor.execute()
```

### 3.9 触发：命令触发 + 事件触发（引用 PRD §3.2 triggers 字段，不重复）

PRD mod-06 §3.2 已定 triggers 字段（命令/事件触发）。本节补 `SkillTriggerMatcher` 类实施（§2.2.11 已给代码骨架）：

#### 3.9.1 命令触发

用户输入 `/code-review src/` → `SkillTriggerMatcher.matchByCommand('/code-review')` → 命中 `triggers: ['/code-review']` 的 skill → 执行。

#### 3.9.2 事件触发

M4 Hook 事件 `PreToolUse:edit_file` → `SkillEventBridge.onHookEvent('PreToolUse', payload, agentId)` → `SkillTriggerMatcher.matchByEvent('PreToolUse', payload)` → 命中 `triggers: ['PreToolUse:edit_file']` 的 skill → 执行。

事件触发的 skill 不阻断主流程（`HookResponse.permissionDecision: 'allow'`），skill 触发的工具调用经 M4 五层拦截链重新评估。

### 3.10 retry/timeout/fallback 实施（引用 PRD §3.2，不重复）

PRD mod-06 §3.2 已定 retry/timeout/fallback 三字段。本节补 `SkillRetryPolicy` + `SkillFallbackHandler` 类实施（§2.2.14 + §2.2.15 已给代码骨架）：

#### 3.10.1 retry 实施

- `retry: { max: 3, backoff: 'exponential' }` → 100ms / 200ms / 400ms 重试，上限 5s
- `retry: { max: 2, backoff: 'linear' }` → 100ms / 200ms 重试

#### 3.10.2 fallback 实施

- `fallback: 'error'`（默认）→ 返回错误
- `fallback: 'skip'` → 跳过 skill，返回空结果
- `fallback: 'inline'` → fork 模式失败时降级为 inline（PRD §4.2 双模式灵活）

### 3.11 Legacy 来源兼容

`LegacySkillProvider` 兼容旧格式（`~/.omniagent/legacy-skills/*.json`），将 JSON 转换为 SkillFrontmatter + body：

```typescript
class LegacySkillProvider implements SkillProvider {
  readonly source = 'legacy';
  readonly priority = 5;
  readonly supportsHotReload = true;

  async loadAll(): Promise<{ skills: Skill[]; errors: SkillLoadError[] }> {
    // 1. 扫描 ~/.omniagent/legacy-skills/*.json
    // 2. 解析 JSON 旧格式（{ name, prompt, tools, ... }）
    // 3. 转换为 SkillFrontmatter（映射字段，可能丢失部分 16 字段）
    // 4. body = prompt 字段（旧格式无 Markdown body 概念）
    // 5. 标 source: 'legacy'，返回
  }
}
```

Legacy 来源最低优先级，仅用于迁移期，新 skill 应使用 Markdown + frontmatter 格式。

### 3.12 Skills 与 Custom Agents 的边界

| 维度 | Skills | Custom Agents |
|------|--------|---------------|
| 定义文件 | `.omniagent/skills/*.md` | `.omniagent/agents/*.md` |
| 触发方式 | 命令/事件触发 | 由 LLM 通过 agent_router 调用 |
| 执行模式 | inline（注入当前 Agent）/ fork（独立 sidechain） | 独立 agent（always fork-like） |
| 工具白名单 | frontmatter.tools | agent definition.tools |
| 权限配置 | frontmatter.permissions | agent definition.permissions |
| 角色定位 | "高级工具"（带 prompt + 权限） | 独立 agent 角色 |
| 实施模块 | M6 | M5（agent_router route=custom） |

边界清晰：Skills 是"轻量扩展点"（不定义新 agent 角色），Custom Agents 是"重量扩展点"（定义独立 agent）。复杂团队工作流优先用 Custom Agents；快速封装单步操作（如 code-review、commit）用 Skills。

---

## 4. 与其他模块的交互

### 4.1 调用图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          M2 ReAct Loop                                    │
│   BUILD_CONTEXT ────▶ M3 mergeAndFilterTools ◀─── M3 ToolPool.create()   │
│                                   ▲                                       │
│                                   │ skill_invoke/list/install/uninstall  │
│                                   │                                       │
│                              ┌────┴────────┐                              │
│                              │  SkillTool  │ (M6)                         │
│                              └────┬────────┘                              │
│                                   │                                       │
│                       SkillExecutor.execute({ skill, args, mode })       │
│                                   │                                       │
│              ┌────────────────────┴────────────────────┐                 │
│              │                                         │                 │
│      inline mode                                  fork mode              │
│              │                                         │                 │
│   ┌──────────▼──────────┐               ┌──────────────▼──────────────┐  │
│   │ InlineSkillExecutor │               │   ForkSkillExecutor         │  │
│   │  - 注入 M7 SystemPrompt │           │  - 委托 M5 route=fork       │  │
│   │  - 注入 M4 PermissionRule│          │  - 不变量 #5 由 M5 守护     │  │
│   │  - 注入 M3 ToolWhitelist │          └──────────────┬──────────────┘  │
│   └─────────────────────┘                              │                 │
│              ▲                              M5 Orchestrator.route()      │
│              │                                         │                 │
│              │                              M5 ForkAgentSpawner.spawn()  │
│              │                                         │                 │
│              │                              M7 createSidechain()         │
│              │                                         │                 │
│              │                              M2 子 ReActLoop.runTurn()   │
│              │                                         │                 │
│              │                              LLM 调用（M1）              │
│              │                                         │                 │
│              └─── 结果回注 ◀───────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────────────┘

外部触发：
- 用户输入 /<skill-name> → SkillTriggerMatcher.matchByCommand() → SkillExecutor.execute()
- M4 Hook 事件（PreToolUse 等） → SkillEventBridge.onHookEvent() → SkillExecutor.execute()

热加载：
- chokidar watch .omniagent/skills/ → SkillHotReloader.handleChange() → loader.reload() + toolPool.reload()

防注入：
- M4 sandbox deny .omniagent/skills/（不变量 #10，L2 §8.1.3）
- M6 SkillSandboxGuard 启动期校验 + 路径穿越防护
```

### 4.2 与 M3 工具系统的交互（引用 PRD §5 + L2 §5.4.3，不重复）

| 交互点 | M6 提供 | M3 调用 |
|--------|---------|--------|
| 工具池接入 | `SkillTool.buildAll()` 返回 4 个系统工具 | `ToolPool.create({ baseTools, customAgentTools: skillTools, agentRole })` |
| 工具白名单 | `SkillToolWhitelist.resolve(skill)` 返回白名单 | `mergeAndFilterTools()` 按白名单过滤（worker/custom/teammate 角色） |
| 工具执行 | `SkillTool.invoke callback` → `SkillExecutor.execute()` | M3 工具调度器调 `tool.call(input, ctx)` |
| 热加载 | `SkillHotReloader` 调 `toolPool.reload(newSkillTools)` | `ToolPool.reload()` 写时复制（L2 §5.4.1） |
| 描述截断 | Skill 工具描述 ≤ 500 字符（与 SkillFrontmatter.description 一致） | M3 `mergeAndFilterTools` 二次校验 ≤ 2048（不变量 #15） |

**契约**：Skills 加载后其工具白名单通过 M3 的 `mergeAndFilterTools()` 接入工具池。Skills 工具的 `call()` 由 M6 实现，M3 只负责注册与调度。

### 4.3 与 M4 权限与拦截系统的交互（引用 PRD §5 + L2 §8.1，不重复）

| 交互点 | M6 提供 | M4 调用 |
|--------|---------|--------|
| 权限规则注入 | `SkillPermissionResolver.resolve(skill)` 返回 `PermissionRule[]` | M4 Layer 2 权限规则匹配（8 层优先级，skill 层 priority 6） |
| 沙箱 deny | M6 依赖 M4 sandbox deny `.omniagent/skills/` | M4 sandbox-exec profile 第 2 项 deny 路径（不变量 #10） |
| Hooks 事件桥接 | `SkillEventBridge.onHookEvent(eventName, payload, agentId)` | M4 Layer 5 Hooks 调度器（27 事件 × 6 类型） |
| 审计日志 | Skill 工具调用记入审计（layer=2 或更高） | M4 审计日志 schema（L2 §7.8） |
| DenialTracker | Skill 触发的工具调用失败累计到 DenialTracker | M4 DenialTracker 双上下文（risk_classifier / hooks，fail-closed degrade_to_ask） |

**契约**：Skills 触发的工具调用经 M4 五层拦截链；`.omniagent/skills/` 目录由 M4 sandbox deny 保护（防注入）。

### 4.4 与 M5 多 Agent 编排引擎的交互（引用 PRD §5 + 不变量 #5，不重复）

| 交互点 | M6 提供 | M5 调用 |
|--------|---------|--------|
| fork 路由 | `ForkSkillExecutor.execute()` 调 `orchestrator.route({ route: 'fork', ... })` | M5 `Orchestrator.route()` → `ForkAgentSpawner.spawn()` |
| 不变量 #5 守护 | M6 只触发 fork，不操作 messages | M5 `ForkAgentSpawner.fillPlaceholderToolResults()` 守护 byte-identical |
| sidechain 持久化 | M6 不直接调 M7 sidechain | M5 `SidechainManager.create()` 委托 M7 `createSidechain()` |
| 工具池继承 | M6 不重排工具池 | M5 `ForkAgentSpawner` 传入 `parentToolPool`（不调 `mergeAndFilterTools` 重排） |
| 结果回注 | M6 收到 `AgentRouterResult`，返回给 `SkillTool` | M5 route=fork 默认 sync，等待结果 |

**契约**（PRD §5 澄清 K5）：Skill fork 模式 spawn 的 fork agent 必须遵循不变量 #5（prompt cache prefix byte-identical）。具体要求：
- fork agent 的 system prompt 与父 agent 完全一致（共享 prefix）
- 工具池继承自父 agent（不重排顺序，避免 prefix hash 变化）
- 通过占位 `tool_result`（空 content）填充 fork 点之前的所有 `tool_use`，保证 prefix 字节级一致
- 此要求由 M5 在 fork 路由中守护，M6 触发 fork 时不需额外操作（M5 已封装）

### 4.5 与 M7 上下文与记忆引擎的交互（引用 PRD §5，不重复）

| 交互点 | M6 提供 | M7 调用 |
|--------|---------|--------|
| inline 注入 | `InlineSkillExecutor` 调 `SystemPromptBuilder.injectCustomPrompt()` | M7 §3.4 三阶段组装（getSystemPrompt → buildEffectiveSystemPrompt → buildSystemPromptBlocks） |
| fork sidechain | M6 不直接调 M7 sidechain | M5 `SidechainManager.create()` 委托 M7 `createSidechain()` |
| 工具结果压缩 | M6 Skill 工具结果标 `compactable: true` | M7 `MicroCompactor` / `SessionCompactor` 压缩（COMPACTABLE_TOOLS 白名单） |
| 记忆召回 | M6 不直接调 M7 召回 | M7 `findRelevantMemories()` 在 M2 BUILD_CONTEXT 时调用，与 M6 无直接交互 |

**契约**：Skill fork 模式的 sidechain transcript 由 M7 持久化；inline 模式注入的 prompt 进入 M7 的上下文管理。

### 4.6 与 M1 LLM 抽象层的交互

M6 不直接调 M1 LLMProvider。所有 LLM 调用经 M2 ReAct Loop（inline 模式注入 prompt 后，M2 下一轮调 LLM）或 M5 fork agent（fork 模式 spawn 的子 agent 通过 M2 调 LLM）。

### 4.7 与 M2 核心循环的交互

| 交互点 | M6 提供 | M2 调用 |
|--------|---------|--------|
| BUILD_CONTEXT 工具池 | M6 SkillTool 注册到 M3 工具池 | M2 BUILD_CONTEXT 调 M3 `mergeAndFilterTools`（含 skill_* 工具） |
| LLM tool_use 分发 | M6 SkillTool.invoke callback | M2 TOOL_EXECUTE 状态调 `tool.call(input, ctx)` |
| inline 注入触发下一轮 | M6 注入 skill prompt 到 M7 SystemPromptBuilder | M2 下一轮 BUILD_CONTEXT → CALL_LLM 看到 skill prompt |

---

## 5. 错误处理与降级

### 5.1 错误码映射

M6 触发的错误码子集（L2 §6.1 的 26 个错误码中，M6 相关 6 个）：

| 错误码 | 触发场景 | 降级路径 |
|--------|---------|---------|
| `TOOL_EXECUTION_ERROR` | Skill 工具 `call()` 抛异常（skill_invoke/install/uninstall 失败） | tool_result 标 is_error，回注 LLM 决策；fallback 字段决定是否降级 |
| `TOOL_TIMEOUT` | Skill 执行超时（frontmatter.timeout 到期） | retry 字段决定重试；retry 用尽后 fallback |
| `TOOL_PERMISSION_DENIED` | M4 五层拦截链 deny Skill 触发的工具调用 | tool_result 标 is_error（permission denied），回注 LLM |
| `PERSISTENCE_IO_ERROR` | skill_install 写文件失败 / skill_uninstall 删文件失败 | 退避重试 3 次，仍失败则 END_TURN + 错误提示 |
| `SANDBOX_FAILED` | SkillSandboxGuard.validateSkillsDir 失败（目录权限过宽） | fail-closed 启动失败，提示用户修复权限 |
| `SKILL_FRONTMATTER_INVALID`（M6 专用，非 OmniAgentErrorCode 枚举） | frontmatter 校验失败 | 跳过该 skill 加载，不影响其他（PRD §4.3 容错） |

**注**：`SKILL_FRONTMATTER_INVALID` / `SKILL_NAME_CONFLICT` / `SKILL_NAME_BUILTIN_CLASH` / `SKILL_PERMISSION_INVALID` / `SKILL_TOOL_UNKNOWN` / `SKILL_OVER_LIMIT` 是 `SkillLoadError.code`（M6 内部错误码，不入 OmniAgentErrorCode 全局枚举），仅用于 SkillLoader 错误日志。

### 5.2 fail-closed 场景

M6 的 5 个 fail-closed 场景：

1. **Skill 工具描述超 2048 字符**：M3 `mergeAndFilterTools` 二次截断 + 记入 errors（不变量 #15）
2. **Skill 引用未知工具**：`SkillToolWhitelist.resolve()` 返回 `{ ok: false, missingTools }`，拒绝整个 skill 加载（不部分加载）
3. **Skill 名与内置命令冲突**：`SkillNameRegistry.check()` 返回 `SKILL_NAME_BUILTIN_CLASH`，跳过加载，提示用户改名
4. **`.omniagent/skills/` 目录权限过宽**：`SkillSandboxGuard.validateSkillsDir()` 返回 `{ ok: false }`，启动 fail-closed
5. **skill_install 路径穿越**：`SkillSandboxGuard.sanitizeSkillName()` 返回 `{ ok: false }`，拒绝写入（防 `../` 逃逸）

### 5.3 校验失败容错（引用 PRD §4.3 + §6.1，不重复）

PRD mod-06 §4.3 + §6.1 已定"单个 skill 校验失败不影响其他 skill 加载"。本节补实施：

- `SkillLoader.loadAll()` 收集所有 `SkillLoadError` 到数组，不抛异常
- 错误日志输出文件路径 + 字段 + 错误消息（含行号，gray-matter 解析时记录）
- 启动期不因 skill 校验失败而 fail-closed 退出（与 L2 §1.5 启动期 fail-closed 不同，此处是"软失败"）
- metrics 埋点：`skills.load_errors.total` counter

### 5.4 触发失败降级（引用 PRD §3.2 fallback 字段，不重复）

PRD mod-06 §3.2 已定 fallback 三值（error/skip/inline）。本节补 `SkillFallbackHandler` 实施（§2.2.15 已给代码骨架）：

- `fallback: 'error'`（默认）→ 返回 `OmniAgentError`，tool_result 标 is_error
- `fallback: 'skip'` → 跳过 skill，返回空结果（不阻断主流程）
- `fallback: 'inline'` → fork 模式失败时降级为 inline（PRD §4.2 双模式灵活）

### 5.5 hot reload 失败回滚

`SkillHotReloader.handleChange()` 失败时的回滚策略：

1. **reload 失败**（如新文件 frontmatter 校验失败）：保留旧 SkillRegistry（builtin/bundled 不变），日志记录失败 skill，不回滚文件系统变化（用户可能正在编辑）
2. **toolPool.reload 失败**：理论上不会失败（写时复制是内存操作），若失败则保留旧 ToolPoolSnapshot，日志记录
3. **chokidar watch 异常**：自动重连（chokidar 内置），3 次失败后告警 + 提示用户重启

---

## 6. 测试用例骨架

### 6.1 单元测试

#### 6.1.1 `SkillValidator` 测试

```typescript
describe('SkillValidator', () => {
  const validator = new SkillValidator();

  it('合法 frontmatter 通过', () => {
    const skill: Skill = {
      frontmatter: {
        name: 'code-review',
        description: 'Perform code review',
        tools: ['read_file', 'glob', 'grep'],
        scope: 'project',
        mode: 'inline',
      },
      body: '## Instructions\n1. Read changed files',
      source: 'disk',
    };
    expect(validator.validate(skill)).toEqual({ ok: true });
  });

  it('name 缺失失败', () => {
    const skill = { /* ... name 缺失 ... */ } as Skill;
    const result = validator.validate(skill);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('name is required');
  });

  it('name 不匹配 snake_case 失败', () => {
    const skill = { /* frontmatter: { name: 'CodeReview', ... } */ } as Skill;
    expect(validator.validate(skill).ok).toBe(false);
  });

  it('description 超 500 字符失败', () => { /* ... */ });
  it('tools 数组空失败', () => { /* ... */ });
  it('permissions 值非 allow/deny/ask 失败', () => { /* ... */ });
  it('mode 非 inline/fork 失败', () => { /* ... */ });
  it('retry.max 超 5 失败', () => { /* ... */ });
  it('timeout 超 600000 失败', () => { /* ... */ });
  it('body 空失败', () => { /* ... */ });
});
```

#### 6.1.2 `SkillRegistry` 优先级覆盖测试

```typescript
describe('SkillRegistry 优先级覆盖', () => {
  it('高优先级不被低优先级覆盖（builtin 不被 disk 覆盖）', () => {
    const registry = new SkillRegistry();
    const builtinSkill: Skill = { frontmatter: { name: 'review', /* ... */ }, body: '...', source: 'builtin' };
    const diskSkill: Skill = { frontmatter: { name: 'review', /* ... */ }, body: '...', source: 'disk' };

    registry.register(builtinSkill);
    registry.register(diskSkill);  // 低优先级，跳过

    expect(registry.get('review')?.source).toBe('builtin');
  });

  it('低优先级先注册时被高优先级覆盖', () => {
    const registry = new SkillRegistry();
    const legacySkill: Skill = { frontmatter: { name: 'review', /* ... */ }, body: '...', source: 'legacy' };
    const builtinSkill: Skill = { frontmatter: { name: 'review', /* ... */ }, body: '...', source: 'builtin' };

    registry.register(legacySkill);  // 先注册低优先级
    registry.register(builtinSkill);  // 高优先级覆盖

    expect(registry.get('review')?.source).toBe('builtin');
  });

  it('clear 保留 builtin/bundled，重载 disk/mcp/legacy', () => {
    const registry = new SkillRegistry();
    // 注册 5 来源各 1 个 skill
    // ...
    registry.clear();
    expect(registry.list().filter(s => s.source === 'builtin')).toHaveLength(1);
    expect(registry.list().filter(s => s.source === 'disk')).toHaveLength(0);
  });
});
```

#### 6.1.3 `SkillNameRegistry` 内置命令冲突测试

```typescript
describe('SkillNameRegistry 内置命令冲突', () => {
  const registry = new SkillNameRegistry();

  it('/compact 与内置命令冲突', () => {
    const result = registry.check('/compact', 'disk');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SKILL_NAME_BUILTIN_CLASH');
  });

  it('/code-review 不与内置命令冲突', () => {
    const result = registry.check('/code-review', 'disk');
    expect(result.ok).toBe(true);
  });

  it('code-review（无 / 前缀）不冲突', () => {
    const result = registry.check('code-review', 'disk');
    expect(result.ok).toBe(true);
  });
});
```

#### 6.1.4 `SkillToolWhitelist` 工具白名单测试

```typescript
describe('SkillToolWhitelist', () => {
  it('所有工具存在时通过', () => {
    const toolPool = new ToolPool([readFileTool, bashTool]);  // mock
    const whitelist = new SkillToolWhitelist(toolPool);
    const skill: Skill = { frontmatter: { name: 'review', tools: ['read_file', 'bash'], /* ... */ }, /* ... */ };
    const result = whitelist.resolve(skill);
    expect(result.ok).toBe(true);
    expect(result.whitelist).toEqual(['read_file', 'bash']);
  });

  it('引用未知工具时 fail-closed', () => {
    const toolPool = new ToolPool([readFileTool]);  // 不含 bash
    const whitelist = new SkillToolWhitelist(toolPool);
    const skill: Skill = { frontmatter: { name: 'review', tools: ['read_file', 'bash'], /* ... */ }, /* ... */ };
    const result = whitelist.resolve(skill);
    expect(result.ok).toBe(false);
    expect(result.missingTools).toEqual(['bash']);
  });
});
```

#### 6.1.5 `SkillTriggerMatcher` 触发匹配测试

```typescript
describe('SkillTriggerMatcher', () => {
  it('命令触发精确匹配', () => {
    const registry = new SkillRegistry();
    registry.register({ frontmatter: { name: 'code-review', triggers: ['/code-review'], /* ... */ }, /* ... */ });
    const matcher = new SkillTriggerMatcher(registry);
    expect(matcher.matchByCommand('/code-review')?.frontmatter.name).toBe('code-review');
  });

  it('命令触发前缀匹配（带参数）', () => {
    expect(matcher.matchByCommand('/code-review src/')).toBeDefined();
  });

  it('事件触发匹配 PreToolUse:edit_file', () => {
    registry.register({ frontmatter: { name: 'lint-after-edit', triggers: ['PreToolUse:edit_file'], /* ... */ }, /* ... */ });
    const matches = matcher.matchByEvent('PreToolUse', { tool_name: 'edit_file' } as HookPayload);
    expect(matches).toHaveLength(1);
  });

  it('事件触发通配符匹配 PreToolUse:*', () => {
    registry.register({ frontmatter: { name: 'log-all-tools', triggers: ['PreToolUse:*'], /* ... */ }, /* ... */ });
    const matches = matcher.matchByEvent('PreToolUse', { tool_name: 'bash' } as HookPayload);
    expect(matches).toHaveLength(1);
  });
});
```

#### 6.1.6 `SkillRetryPolicy` 重试测试

```typescript
describe('SkillRetryPolicy', () => {
  it('exponential 退避：100ms / 200ms / 400ms', async () => {
    const policy = new SkillRetryPolicy();
    const delays: number[] = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((cb, ms) => { delays.push(ms); cb(); return {} as any; });

    let attempts = 0;
    await expect(policy.runWithRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'ok';
    }, { max: 3, backoff: 'exponential' })).resolves.toBe('ok');

    expect(delays).toEqual([100, 200]);  // 重试 2 次（max=3 → 总尝试 4 次，但第 3 次成功）
  });

  it('linear 退避：100ms / 200ms / 300ms', async () => { /* ... */ });
  it('retry 用尽后抛最后错误', async () => { /* ... */ });
});
```

#### 6.1.7 `SkillFallbackHandler` 降级测试

```typescript
describe('SkillFallbackHandler', () => {
  it('fallback: error → 返回错误', async () => {
    const handler = new SkillFallbackHandler(/* inlineExecutor mock */);
    const result = await handler.handle(
      { frontmatter: { name: 'review', fallback: 'error', /* ... */ } } as Skill,
      { code: 'TOOL_EXECUTION_ERROR', message: 'fail' } as OmniAgentError,
      {} as SkillExecuteParams,
    );
    expect(result.ok).toBe(false);
  });

  it('fallback: skip → 返回空结果', async () => { /* ... */ });

  it('fallback: inline + mode=fork → 降级为 inline', async () => {
    const inlineExecutor = { execute: jest.fn().mockResolvedValue({ ok: true, output: 'inline ok' }) };
    const handler = new SkillFallbackHandler(inlineExecutor as any);
    const result = await handler.handle(
      { frontmatter: { name: 'big-refactor', mode: 'fork', fallback: 'inline', /* ... */ } } as Skill,
      { code: 'TOOL_EXECUTION_ERROR', message: 'fork fail' } as OmniAgentError,
      {} as SkillExecuteParams,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('fallback to inline');
  });

  it('fallback: inline + mode=inline → 不降级（已是 inline）', async () => { /* ... */ });
});
```

#### 6.1.8 `SkillHotReloader` 热加载测试

```typescript
describe('SkillHotReloader', () => {
  it('add 事件触发 reload + toolPool.reload', async () => {
    const loader = { reload: jest.fn().mockResolvedValue({ loaded: 5, errors: [] }) };
    const toolPool = { reload: jest.fn() };
    const reloader = new SkillHotReloader('/tmp/skills', loader as any, toolPool as any);

    // 模拟 chokidar 'add' 事件
    await (reloader as any).handleChange('/tmp/skills/new-skill.md', 'add');

    expect(loader.reload).toHaveBeenCalled();
    expect(toolPool.reload).toHaveBeenCalled();
  });

  it('change 事件触发 reload', async () => { /* ... */ });
  it('unlink 事件触发 reload（删除 skill）', async () => { /* ... */ });
  it('reload 失败时保留旧 Registry', async () => { /* ... */ });
});
```

#### 6.1.9 `SkillSandboxGuard` 防注入测试

```typescript
describe('SkillSandboxGuard', () => {
  it('目录权限 0o755 通过', async () => {
    const guard = new SkillSandboxGuard();
    jest.spyOn(fs.promises, 'stat').mockResolvedValue({ isDirectory: () => true, mode: 0o755 } as any);
    const result = await guard.validateSkillsDir('/tmp/skills');
    expect(result.ok).toBe(true);
  });

  it('目录权限 0o777 失败', async () => {
    jest.spyOn(fs.promises, 'stat').mockResolvedValue({ isDirectory: () => true, mode: 0o777 } as any);
    const result = await guard.validateSkillsDir('/tmp/skills');
    expect(result.ok).toBe(false);
  });

  it('skill name 含 ../ 拒绝（路径穿越）', () => {
    const guard = new SkillSandboxGuard();
    expect(guard.sanitizeSkillName('../etc/passwd').ok).toBe(false);
    expect(guard.sanitizeSkillName('valid-name').ok).toBe(true);
  });
});
```

#### 6.1.10 `SkillTool` 4 工具测试

```typescript
describe('SkillTool', () => {
  it('skill_invoke 调用已注册 skill', async () => {
    const registry = { get: jest.fn().mockReturnValue({ frontmatter: { name: 'review' } }) };
    const executor = { execute: jest.fn().mockResolvedValue({ ok: true, output: 'done' }) };
    const skillTool = new SkillTool(registry as any, executor as any, /* loader */ {} as any);

    const tool = skillTool.buildInvokeTool();
    const result = await tool.call({ name: 'review' }, { agentId: 'a1', traceId: 't1' } as any);

    expect(result.is_error).toBe(false);
    expect(result.content).toBe('done');
  });

  it('skill_invoke 未注册 skill 返回 is_error', async () => { /* ... */ });
  it('skill_list 列出所有 skill', async () => { /* ... */ });
  it('skill_install 写文件（chokidar 自动触发 reload）', async () => { /* ... */ });
  it('skill_uninstall 删文件（builtin/bundled 拒绝）', async () => { /* ... */ });
  it('skill_uninstall 路径穿越防护', async () => { /* ... */ });
});
```

### 6.2 集成测试

#### 6.2.1 M3 + M6 集成：Skills 工具接入

```typescript
describe('M3 + M6 集成：Skills 工具接入', () => {
  it('Skill 加载后通过 mergeAndFilterTools 接入工具池', async () => {
    const skillLoader = await SkillLoader.create();
    const skillTool = new SkillTool(skillLoader.registry, /* ... */, skillLoader);
    const skillTools = skillTool.buildAll();

    const toolPool = ToolPool.create({
      baseTools: [readFileTool, bashTool, ...skillTools],
      agentRole: 'main',
    });

    expect(toolPool.get('skill_invoke')).toBeDefined();
    expect(toolPool.get('skill_list')).toBeDefined();
  });

  it('Skill 工具调用 → M6 实现 → ToolResult', async () => {
    const toolPool = /* ... */;
    const skillInvoke = toolPool.get('skill_invoke')!;
    const result = await skillInvoke.call({ name: 'code-review' }, { agentId: 'a1', traceId: 't1' } as any);
    expect(result.is_error).toBe(false);
  });

  it('Coordinator 角色过滤：skill_install/uninstall 不被移除（仅 bash/edit/write 移除）', () => {
    const toolPool = ToolPool.create({
      baseTools: [bashTool, editTool, writeTool, skillInvokeTool, skillInstallTool, skillUninstallTool],
      agentRole: 'coordinator',
    });
    expect(toolPool.get('bash')).toBeUndefined();  // 不变量 #4
    expect(toolPool.get('edit_file')).toBeUndefined();
    expect(toolPool.get('write_file')).toBeUndefined();
    expect(toolPool.get('skill_invoke')).toBeDefined();  // skill 工具保留
  });

  it('Worker 角色白名单过滤：仅白名单内 skill 工具保留', () => { /* ... */ });
});
```

#### 6.2.2 M4 + M6 集成：sandbox 防注入 + Hooks 事件桥接

```typescript
describe('M4 + M6 集成', () => {
  it('sandbox deny .omniagent/skills/ 写入（不变量 #10）', async () => {
    // 在沙箱内尝试写 .omniagent/skills/evil.md
    const result = await runInSandbox('echo "evil" > .omniagent/skills/evil.md');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Operation not permitted');
  });

  it('SkillEventBridge 监听 PreToolUse:edit_file 事件', async () => {
    const skillEventBridge = new SkillEventBridge(/* ... */);
    m4.hooks.on('PreToolUse', (payload) => skillEventBridge.onHookEvent('PreToolUse', payload, agentId));

    // 触发 edit_file 工具调用
    await editFileTool.call({ /* ... */ }, ctx);

    // 应触发 skill "lint-after-edit"
    expect(skillExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({
      skill: expect.objectContaining({ frontmatter: { name: 'lint-after-edit' } }),
    }));
  });

  it('Skill permissions 注入 M4 Layer 2（bash: deny 阻止 bash 调用）', async () => {
    const skill: Skill = {
      frontmatter: { name: 'review', tools: ['bash'], permissions: { bash: 'deny' }, /* ... */ },
      /* ... */
    };
    const permRules = new SkillPermissionResolver().resolve(skill);
    m4.permissionEngine.addRules(permRules);

    // skill 触发 bash 调用 → Layer 2 deny
    const decision = await m4.permissionEngine.match({ tool_name: 'bash', command: 'ls' });
    expect(decision.decision).toBe('deny');
  });
});
```

#### 6.2.3 M5 + M6 集成：fork 模式 + 不变量 #5

```typescript
describe('M5 + M6 集成：fork 模式', () => {
  it('Skill fork 模式委托 M5 route=fork', async () => {
    const forkExecutor = new ForkSkillExecutor(m5.orchestrator);
    const result = await forkExecutor.execute({
      skill: { frontmatter: { name: 'big-refactor', mode: 'fork', /* ... */ } } as Skill,
      args: { target: 'src/' },
      parentAgentId: 'a1',
      traceId: 't1',
    });

    expect(m5.orchestrator.route).toHaveBeenCalledWith(expect.objectContaining({
      route: 'fork',
      parent_context_mode: 'isolated',
      tools_whitelist: expect.arrayContaining(['Read', 'Edit', 'Write']),
      parentAgentId: 'a1',
      traceId: 't1',
    }));
  });

  it('fork agent prompt prefix 与父 agent byte-identical（不变量 #5）', async () => {
    // 由 M5 ForkAgentSpawner.fillPlaceholderToolResults 守护
    // 此测试在 L3-M5 §6.1.4 已定义，本处只验证 M6 不破坏（不操作 messages）
    const forkExecutor = new ForkSkillExecutor(m5.orchestrator);
    await forkExecutor.execute({ /* ... */ });

    // M6 不直接调 fillPlaceholderToolResults（M5 内部调）
    expect(m5.forkAgentSpawner.fillPlaceholderToolResults).toHaveBeenCalled();
  });

  it('fork 失败 + fallback: inline → 降级为 inline', async () => {
    m5.orchestrator.route = jest.fn().mockResolvedValue({ status: 'failed' });
    const executor = new SkillExecutor(inlineExecutor, forkExecutor, /* ... */);
    const result = await executor.execute({
      skill: { frontmatter: { name: 'big-refactor', mode: 'fork', fallback: 'inline', /* ... */ } } as Skill,
      /* ... */
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('fallback to inline');
  });
});
```

#### 6.2.4 M7 + M6 集成：inline 注入 + 工具结果压缩

```typescript
describe('M7 + M6 集成', () => {
  it('inline 模式注入 M7 SystemPromptBuilder 的 custom 层', async () => {
    const inlineExecutor = new InlineSkillExecutor(m7.systemPromptBuilder, /* ... */);
    await inlineExecutor.execute({
      skill: { frontmatter: { name: 'review', /* ... */ }, body: '## Instructions\n...' } as Skill,
      /* ... */
    });

    expect(m7.systemPromptBuilder.injectCustomPrompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        source: 'skill:review',
        priority: 4,
        content: expect.stringContaining('# Skill: review'),
      }),
    );
  });

  it('skill_invoke 工具结果标 compactable=true，被 M7 MicroCompactor 压缩', async () => {
    const skillInvokeTool = /* ... */;
    const result = await skillInvokeTool.call({ name: 'long-output-skill' }, ctx);
    // result.content 超 50KB → M7 MicroCompactor 截断
    expect(m7.microCompactor.microCompact).toHaveBeenCalled();
  });
});
```

#### 6.2.5 端到端：命令触发 + inline 执行 + 工具调用

```typescript
describe('端到端：/code-review 命令', () => {
  it('用户输入 /code-review src/ → 全流程跑通', async () => {
    // 1. 用户输入
    const command = '/code-review src/';

    // 2. SkillTriggerMatcher 匹配
    const skill = skillTriggerMatcher.matchByCommand('/code-review');
    expect(skill).toBeDefined();

    // 3. SkillExecutor.execute (mode=inline)
    const result = await skillExecutor.execute({
      skill: skill!,
      args: { path: 'src/' },
      parentAgentId: 'a1',
      traceId: 't1',
    });

    // 4. inline 注入到 M7 SystemPromptBuilder
    expect(m7.systemPromptBuilder.injectCustomPrompt).toHaveBeenCalled();

    // 5. M2 下一轮 BUILD_CONTEXT → CALL_LLM
    //    LLM 收到 skill prompt + 工具白名单（read_file/glob/grep/bash）
    //    LLM 调 read_file(glob(*.ts)) → M3 工具调度 → 工具结果回注
    //    LLM 调 bash(git diff) → M4 五层拦截 → 工具结果回注
    //    LLM 输出 review 报告
    expect(mockLLM.call).toHaveBeenCalled();
  });
});
```

### 6.3 不变量测试

#### 6.3.1 不变量 #10：sandbox 4 类 deny 路径始终生效（含 `.omniagent/skills/` 防注入）

```typescript
describe('不变量 #10: sandbox deny .omniagent/skills/', () => {
  it('沙箱内写 .omniagent/skills/evil.md → deny', async () => {
    const result = await runInSandbox('echo "evil" > .omniagent/skills/evil.md');
    expect(result.exitCode).not.toBe(0);
  });

  it('沙箱内读 .omniagent/skills/ → allow（只读挂载，ro-bind）', async () => {
    const result = await runInSandbox('cat .omniagent/skills/code-review.md');
    expect(result.exitCode).toBe(0);
  });

  it('SkillSandboxGuard 启动期校验目录权限', async () => {
    const guard = new SkillSandboxGuard();
    const result = await guard.validateSkillsDir('/Users/liguang/.omniagent/skills');
    expect(result.ok).toBe(true);
  });
});
```

#### 6.3.2 不变量 #5：Fork agent prompt cache prefix byte-identical（关联不变量，M5 守护）

```typescript
describe('不变量 #5: fork byte-identical（M6 不破坏）', () => {
  it('M6 ForkSkillExecutor 不直接操作 messages', async () => {
    const forkExecutor = new ForkSkillExecutor(m5.orchestrator);
    await forkExecutor.execute({ /* ... */ });

    // 验证 M6 只调 orchestrator.route，不调 fillPlaceholderToolResults
    expect(m5.orchestrator.route).toHaveBeenCalled();
    // fillPlaceholderToolResults 是 M5 ForkAgentSpawner 内部方法，由 M5 调用
  });
});
```

#### 6.3.3 不变量 #4：Coordinator 模式下主 Agent 直接工具调用率 = 0（关联不变量，M3+M5 守护）

```typescript
describe('不变量 #4: Coordinator 工具池硬隔离（M6 不破坏）', () => {
  it('Coordinator 角色 skill 工具保留（skill_invoke/list 仍可用）', () => {
    const toolPool = ToolPool.create({
      baseTools: [bashTool, editTool, writeTool, skillInvokeTool],
      agentRole: 'coordinator',
    });
    expect(toolPool.get('bash')).toBeUndefined();  // 移除
    expect(toolPool.get('edit_file')).toBeUndefined();
    expect(toolPool.get('write_file')).toBeUndefined();
    expect(toolPool.get('skill_invoke')).toBeDefined();  // skill 工具保留
  });
});
```

#### 6.3.4 不变量 #15：MCP 工具描述截断 2048 字符（关联不变量，M3 守护，M6 Skills 经 MCP 来源时遵循）

```typescript
describe('不变量 #15: Skills 经 MCP 来源时描述截断', () => {
  it('McpSkillProvider 加载的 skill 描述超 2048 截断', () => {
    const longDescSkill: Skill = {
      frontmatter: { name: 'long-desc', description: 'x'.repeat(3000), /* ... */ },
      /* ... */
      source: 'mcp',
    };
    // M3 mergeAndFilterTools 二次校验 + 截断
    const result = mergeAndFilterTools({ baseTools: [/* 含 longDescSkill 包装的工具 */], agentRole: 'main' });
    expect(result.filtered[0].description.length).toBeLessThanOrEqual(2048);
  });
});
```

### 6.4 性能测试

| 测试项 | 目标 | 测量方式 |
|--------|------|---------|
| Skills 启动期加载延迟 | ≤ 200ms（10 个 skill） | 启动期 SkillLoader.loadAll 计时 |
| Skills 热加载延迟 | ≤ 100ms（单个 skill 变化） | chokidar 事件 → toolPool.reload 计时 |
| skill_invoke 工具调用延迟 | ≤ 50ms（不含 LLM 调用） | SkillTool.call 计时 |
| inline 注入延迟 | ≤ 10ms | InlineSkillExecutor.execute 计时（注入到 SystemPromptBuilder） |
| fork 模式触发延迟 | ≤ 100ms（不含 fork agent 执行） | ForkSkillExecutor.execute 计时（委托 M5） |
| 校验失败容错：100 个 skill 5 个校验失败 | 其他 95 个正常加载 | 启动期 loadAll 后 list().length === 95 |

---

## 7. 里程碑对齐

### 7.1 M4 扩展生态三迭代（引用 L2 §11.5，不重复）

L2 §11.5 已定 M4 扩展生态（4-6 周，2-3 迭代）的迭代拆分。本节补 M6 在每迭代交付的组件：

#### 7.1.1 迭代 1（2 周）：Skills 5 来源 + frontmatter

| M6 组件 | 交付物 | 验收标准 |
|---------|-------|---------|
| `SkillProvider` + 5 Provider | builtin/bundled/disk/mcp/legacy 5 来源 | 优先级正确，内置不可覆盖 |
| `SkillLoader` | 加载入口 | 5 来源聚合 + 优先级覆盖 |
| `SkillValidator` | 16 字段 frontmatter 校验 | YAML 解析 + 校验 + 容错 |
| `SkillRegistry` + `SkillNameRegistry` | 注册表 + 冲突检测 | 内置命令冲突检测 PASS |
| `SkillHotReloader` | chokidar watch | 文件变化即时生效 |
| `SkillTool`（4 工具） | skill_invoke/list/install/uninstall | M3 工具池接入 |

**迭代 1 退出标准**：
- Skills 5 来源加载测试全 PASS
- 16 字段 frontmatter 校验测试全 PASS
- 热插拔延迟 ≤ 100ms（单个 skill 变化）
- 内置命令冲突检测 PASS

#### 7.1.2 迭代 2（2 周）：MCP 7 传输层 + Custom Agents（M3 主导，M6 配合）

本迭代以 M3 为主（MCP 7 传输层 + Custom Agents），M6 仅配合：
- `McpSkillProvider` 完善（依赖 M3 MCP 7 传输层）
- Skills 与 Custom Agents 边界测试（§3.12）

#### 7.1.3 迭代 3（2 周）：边缘代理 + Workflow（M5/M10 主导，M6 不参与）

本迭代 M6 不直接交付，但需验证：
- Skills 在 Cloudflare Worker / Deno Deploy 边缘代理场景下的兼容性
- Skills 与 Workflow Orchestrator（实验 feature）的交互测试

### 7.2 并行开发契约冻结点（引用 L2 §11.7，不重复）

L2 §11.7 已定 M4 开工前冻结点：Skills 16 字段 frontmatter schema + MCP 7 传输层接口 + Custom Agent schema。

**M6 开工前必须冻结的契约**：
- `omniagent-types.ts` §16 SkillFrontmatter / Skill / SkillSource（L2 §3 已冻结）
- M3 `mergeAndFilterTools` 接口（M3 L3 已完成，§2.2.4 引用）
- M5 `Orchestrator.route` 接口（M5 L3 已完成，§2.2.1 引用）
- M7 `SystemPromptBuilder.injectCustomPrompt` 接口（M7 L3 已完成，§2.2.3 引用）
- M4 sandbox deny 路径配置（L2 §8.1.3 已给 sandbox-exec profile 模板）

### 7.3 与 M1/M2/M3 的依赖关系

| 依赖模块 | 依赖内容 | M6 使用方式 |
|---------|---------|------------|
| M1 LLM 抽象 | LLMProvider 接口 | 不直接调（经 M2/M5） |
| M2 核心循环 | ReAct Loop + BUILD_CONTEXT | inline 注入触发下一轮 LLM 调用 |
| M3 工具系统 | mergeAndFilterTools + ToolPool + buildTool | SkillTool 注册 + 工具白名单过滤 |
| M4 权限与拦截 | sandbox deny + Layer 2 权限规则 + Layer 5 Hooks | sandbox 防注入 + 权限注入 + 事件触发 |
| M5 多 Agent 编排 | Orchestrator.route(route=fork) + ForkAgentSpawner | fork 模式委托 + 不变量 #5 守护 |
| M7 上下文与记忆 | SystemPromptBuilder + createSidechain + MicroCompactor | inline 注入 + fork sidechain + 工具结果压缩 |

---

## 8. 开放问题

### 8.1 Skills 签名校验（v2.x 演进项，引用 PRD §8.4，不重复）

PRD mod-06 §8.4 已列 v2.x 演进项：用户 Skills 经 GPG 签名 + 白名单登记，防恶意 Skills。本节补设计思路（不在 M4 实施范围内）：

- frontmatter 增 `signature` 字段（GPG 签名）
- SkillLoader 加载时校验签名（公钥分发在 `~/.omniagent/trusted-keys/`）
- 未签名或签名校验失败的 skill 标 `untrusted`，触发时强制 ask（M4 Layer 2）

### 8.2 Skills 市场（v2.x 演进项，引用 PRD §8.4）

PRD mod-06 §8.4 已列 v2.x 演进项：社区共享 Skills。本节补设计思路：

- `omniagent skills install <name>` 从市场拉取（类似 npm install）
- 市场端 API（Cloudflare Worker 部署，限流自动切 Deno Deploy）
- 本地缓存 `~/.omniagent/cache/skills/<name>/<version>.md` + SHA-256 校验

### 8.3 Skills 与 Custom Agents 合并（v2.x 演进项，引用 PRD §8.4）

PRD mod-06 §8.4 已列 v2.x 演进项：Skills 与 Custom Agents 合并（统一扩展点）。本节补设计思路：

- 合并后 `~/.omniagent/extensions/*.md` 统一格式
- frontmatter 增 `role` 字段（'tool' / 'agent'），区分 Skills 与 Custom Agents
- 向后兼容：旧 `.omniagent/skills/` 与 `.omniagent/agents/` 目录仍扫描，标 `source: 'legacy'`

### 8.4 Skills 异步执行（PRD §3.2 async 字段）

PRD mod-06 §3.2 已列 `async` 字段（是否异步），但未详述异步执行的设计。本节补开放问题：

- `async: true` 的 skill 触发后立即返回（不等待结果），结果通过 mailbox 通知（M5 mailbox）
- 异步 skill 必须用 fork 模式（inline 模式 inherently 同步）
- 异步 skill 的 timeout 字段从触发时计时，不是从 fork agent 启动时计时

此设计在 M4 迭代 1 暂不实施，仅占位字段，v2.x 演进。

### 8.5 Skills 与 Workflow Orchestrator 的关系

PRD mod-05 §4.4 的 Workflow Orchestrator（决策 A3 默认 off）与 M6 Skills 的关系：

- Workflow 是声明式 YAML 工作流（拓扑排序 + parallel N + resume）
- Skills 是声明式 Markdown + frontmatter（Prompt + 权限 + 工具白名单）
- 两者不重叠：Workflow 描述**多步编排**，Skills 描述**单步封装**
- 未来可能合并：YAML 工作流的每个 step 可以是 skill 调用

此关系在 M4 迭代 3 验证（Workflow Orchestrator 实验 feature 启用时）。

---

## 附录 A：L2 / PRD 章节映射

| L3-M6 章节 | 引用 PRD 章节 | 引用 L2 章节 | 引用 omniagent-types.ts 节 | 补充内容 |
|-----------|-------------|------------|-------------------|---------|
| §1 模块概述 | mod-06 §1 | L2 §1.5 + §5.4.3 | — | 启动期第 8 步 + 热加载场景引用 |
| §2 组件清单 | — | — | §16 SkillFrontmatter/Skill/SkillSource | 25 个组件（5 Provider + Loader + Validator + Registry + HotReloader + Executor + 2 Executor + SkillTool + TriggerMatcher + PermissionResolver + ToolWhitelist + RetryPolicy + FallbackHandler + EventBridge + SandboxGuard + NameRegistry） |
| §3.1 5 来源分层 | mod-06 §4.1 | — | §16 SkillSource | 5 Provider 实施矩阵 + 优先级覆盖算法 + 内置命令冲突检测 |
| §3.2 16 字段 frontmatter 校验 | mod-06 §3.2 | — | §16 SkillFrontmatter | SkillValidator 16 字段校验链 + 错误码 |
| §3.3 SkillRegistry | — | — | — | 注册表 + 优先级覆盖实施 |
| §3.4 InlineSkillExecutor | mod-06 §4.2 | — | — | inline 模式注入路径 + M7 SystemPromptBuilder 契约 |
| §3.5 ForkSkillExecutor | mod-06 §4.2 + §5 | L2 §4.2.4 | — | fork 触发路径 + 不变量 #5 守护责任划分 |
| §3.6 热插拔 | mod-06 §4.3 | L2 §5.4.3 | — | SkillHotReloader chokidar 实施 + 运行中 agent 快照隔离 |
| §3.7 sandbox 防注入 | mod-06 §6.2 + §7 | L2 §8.1.3 | §15 SANDBOX_DENY_PATHS | SkillSandboxGuard 三项职责 + 与 M4 责任划分 |
| §3.8 Skills 工具接入 M3 | mod-06 §5 | L2 §5.4.3 | §7 Tool | SkillTool 4 工具 + 接入流程 |
| §3.9 触发：命令 + 事件 | mod-06 §3.2 triggers | — | — | SkillTriggerMatcher 命令/事件双触发 |
| §3.10 retry/timeout/fallback | mod-06 §3.2 | — | — | SkillRetryPolicy + SkillFallbackHandler 实施 |
| §3.11 Legacy 来源兼容 | mod-06 §4.1 | — | — | LegacySkillProvider JSON 转换 |
| §3.12 Skills 与 Custom Agents 边界 | — | — | — | 7 维度对比表 |
| §4 与其他模块的交互 | mod-06 §5 | L2 §5.4.3 + §8.1.3 | — | 调用图 + M3/M4/M5/M7 交互矩阵 |
| §5 错误处理与降级 | mod-06 §4.3 + §6.1 | L2 §6 | §18 OmniAgentErrorCode | 6 错误码映射 + 5 fail-closed 场景 + 校验容错 + 触发降级 + hot reload 回滚 |
| §6 测试用例骨架 | mod-06 §6.1 + §7 | L2 §9 | — | 单元/集成/不变量/性能测试 |
| §7 里程碑对齐 | mod-06 §1 阻塞 M4 | L2 §11.5 + §11.7 | — | M4 三迭代 + 契约冻结点 + 依赖关系 |
| §8 开放问题 | mod-06 §8.4 | — | — | 签名校验 + 市场 + 合并 + 异步 + Workflow 关系 |

---

## 附录 B：文档不变量

1. **不重复 PRD**：PRD mod-06 §3.1 的 Skill 定义、§3.2 的 16 字段表、§4.1 的 5 来源表、§4.2 的双模式、§4.3 的热插拔、§5 的交互矩阵、§6 的 NFR、§7 的不变量、§8 的开放问题，本文仅引用并补实施细节
2. **不重复 L2**：L2 §5.4.3 的工具池热加载、§8.1.3 的 sandbox-exec profile、§6 的 26 个错误码、§11.5 的 M4 里程碑，本文仅引用不复制
3. **不重复 omniagent-types.ts**：§16 SkillFrontmatter/Skill/SkillSource 已定义，本文 §2.1 引用不重定义
4. **接口签名一致**：本文新增的 `SkillProvider` / `SkillLoader` / `SkillValidator` / `SkillRegistry` / `SkillNameRegistry` / `SkillHotReloader` / `SkillExecutor` / `InlineSkillExecutor` / `ForkSkillExecutor` / `SkillTool` / `SkillTriggerMatcher` / `SkillPermissionResolver` / `SkillToolWhitelist` / `SkillRetryPolicy` / `SkillFallbackHandler` / `SkillEventBridge` / `SkillSandboxGuard` 与 PRD mod-06 §3-§4 描述一致
5. **错误码一致**：本文 §5.1 引用的 6 个错误码（TOOL_EXECUTION_ERROR/TOOL_TIMEOUT/TOOL_PERMISSION_DENIED/PERSISTENCE_IO_ERROR/SANDBOX_FAILED）与 L2 §6.1 的 26 个错误码一致；SKILL_* 是 M6 内部错误码（SkillLoadError.code），不入全局枚举
6. **里程碑一致**：本文 §7.1 的 M4 三迭代交付物与 L2 §11.5 一致
7. **不变量一致**：本文守护的不变量 #10（sandbox 4 类 deny 路径含 .omniagent/skills/）与附录 A 18 项不变量一致；关联不变量 #5（Fork prompt cache prefix byte-identical）与 M5 共同守护（M6 不破坏，M5 守护）；关联不变量 #4（Coordinator 工具池硬隔离）与 M3+M5 共同守护（M6 skill 工具不被 Coordinator 角色过滤）；关联不变量 #15（MCP 工具描述截断 2048）与 M3 共同守护（M6 Skills 经 MCP 来源时遵循）
