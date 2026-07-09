/**
 * OmniAgent CLI — 跨模块共享 TypeScript 类型契约
 *
 * 本文件是 L2 系统设计文档（omniagent-system-design.md §3）的代码附件，
 * 集中定义 PRD 体系中分散引用但未在某单一处完整定义的跨模块共享类型。
 *
 * 层次：L2 技术级（PRD 是 L1 产品级，本文件是 L2 §3 的可执行契约）
 * 状态：草稿 → 评审 → 冻结（与 L2 文档同步冻结）
 *
 * 引用来源：
 * - mod-01 §3.1 LLMProvider 接口
 * - mod-02 §3.1 ReAct FSM 状态 + §4.4 adjustIndexToPreserveAPIInvariants / shouldAutoCompact
 * - mod-03 §3.1 Tool/ToolResult/ToolContext/PermissionDecision + §3.2 mergeAndFilterTools
 * - mod-04 §3.1 五层防御 + §3.2 权限规则 + §4.1 Risk Classifier + §4.2 Hook + §4.5 审计
 * - mod-05 §3.1 agent_router + §3.3 Mailbox + §5.1 agent_router 签名 + §5.2 writeMailboxAtomic
 * - mod-06 §3.1 Skill 定义 + §3.2 16 字段 frontmatter
 * - mod-07 §3.1 分层记忆 + §3.2 项目记忆 + §3.3 召回 + §4.5 持久化 + §4.6 CompactBoundary
 *
 * 设计原则：
 * 1. 品牌中立：本文件不含任何供应商专有名词（不变量 #17）
 * 2. fail-closed 默认值：未显式声明的元数据默认最保守值
 * 3. 不可变快照：工具池与配置对象构建后不可变
 * 4. JSON 可序列化：所有跨进程/跨模块传输的类型必须 JSON.stringify 安全
 */

// ============================================================
// 1. 基础类型与 Brand types
// ============================================================

/** JSON Schema 标准化定义（RFC 2020-12） */
export type JSONSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | JSONSchema[];
  required?: string[];
  enum?: unknown[];
  description?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  additionalProperties?: boolean | JSONSchema;
  $ref?: string;
  [key: string]: unknown;
};

/** 工具输入是 JSON Schema 验证后的任意对象 */
export type ToolInput = Record<string, unknown>;

/** ISO 8601 时间戳 */
export type ISO8601Timestamp = string;

/** 全局唯一标识符（UUID v4 或合法替代） */
export type UUID = string;

/** 品牌 ID 类型，防止混淆 */
export type AgentId = string & { readonly __brand: 'AgentId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type TaskId = string & { readonly __brand: 'TaskId' };
export type WorkItemId = string & { readonly __brand: 'WorkItemId' };
export type MailboxName = string & { readonly __brand: 'MailboxName' };
export type BoundaryId = string & { readonly __brand: 'BoundaryId' };
export type ToolUseId = string & { readonly __brand: 'ToolUseId' };
export type TraceId = string & { readonly __brand: 'TraceId' };
export type SpanId = string & { readonly __brand: 'SpanId' };

// ============================================================
// 2. 消息与内容块（mod-01 §3.2 + mod-03 §3.1）
// ============================================================

/** 消息角色（统一 harness 内部格式，mod-01 §3.2） */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 内容块类型（mod-01 §3.2 + mod-03 §3.1 ToolResult.content） */
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | JsonBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  /** base64 编码的图片数据或 data URL */
  source: { type: 'base64' | 'url'; media_type: string; data: string };
  /** alt 描述，accessibility 用 */
  alt?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: ToolUseId;
  name: string;
  input: ToolInput;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: ToolUseId;
  content: ContentBlock[];
  is_error: boolean;
}

export interface JsonBlock {
  type: 'json';
  json: unknown;
}

/** 统一消息格式（mod-01 §3.2，harness 内部只认此格式） */
export interface Message {
  role: MessageRole;
  content: ContentBlock[];
  /** 消息 ID（transcript 追踪用） */
  id?: UUID;
  /** 父消息 ID（JSONL transcript uuid/parentUuid 链路，mod-07 §4.5.1） */
  parentUuid?: UUID;
  /** 创建时间戳 */
  createdAt?: ISO8601Timestamp;
  /** 消息元数据（如 cost / token usage / model name） */
  metadata?: MessageMetadata;
}

export interface MessageMetadata {
  model?: string;
  provider?: string;
  stop_reason?: StopReason;
  tokenUsage?: TokenUsage;
  costEstimate?: CostEstimate;
  /** 该消息是否在压缩后保留 */
  preserved?: boolean;
  /** 该消息所属的 boundary（若跨越压缩点） */
  boundaryId?: BoundaryId;
}

// ============================================================
// 3. LLM 调用接口（mod-01 §3.1 + §3.2）
// ============================================================

/** 终止原因（mod-01 §3.2 stop_reason + mod-02 §4.1 11 种终止条件） */
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_output_tokens'
  | 'ptl'                  // Prompt Too Long
  | 'user_interrupt'
  | 'stall_passive_30s'
  | 'stall_active_90s'
  | 'provider_5xx'
  | 'provider_429'
  | 'tool_execution_error'
  | 'budget_exceeded';

/** Chat 请求（mod-01 §3.1 chatStream/chat 入参） */
export interface ChatRequest {
  messages: Message[];
  /** 系统提示分块（mod-07 §3.4 buildSystemPromptBlocks 输出） */
  systemPromptBlocks?: string[];
  /** 工具池快照（mod-03 §3.2 mergeAndFilterTools 输出） */
  tools?: Tool[];
  /** 模型 ID（如 "gpt-4"，具体 provider 实现解析） */
  model: string;
  /** Fallback 模型（同 provider 内，mod-02 §4.2 降级 5 步用） */
  fallbackModel?: string;
  /** 最大输出 tokens */
  maxOutputTokens?: number;
  /** 温度（0-2） */
  temperature?: number;
  /** 是否启用 prompt cache（mod-01 §6.1 命中率 ≥80%） */
  enablePromptCache?: boolean;
  /** Abort 信号（mod-02 §3.3 abort 传播） */
  abortSignal?: AbortSignal;
  /** Trace 上下文（mod-07 §7 跨模块同 trace_id） */
  traceId?: TraceId;
}

/** Chat 响应（非流式降级用，mod-01 §3.1 chat() 返回） */
export interface ChatResponse {
  message: Message;
  stopReason: StopReason;
  tokenUsage: TokenUsage;
  /** provider 返回的原始 metadata（如 rate-limit 头） */
  providerMetadata?: Record<string, unknown>;
}

/** Chat 流式 chunk（mod-01 §3.1 chatStream() 输出） */
export type ChatChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: ToolUseId; name: string }
  | { type: 'tool_use_delta'; id: ToolUseId; input: ToolInput }
  | { type: 'tool_use_end'; id: ToolUseId }
  | { type: 'message_start'; message: Message }
  | { type: 'message_delta'; metadata: Partial<MessageMetadata> }
  | { type: 'message_end'; stopReason: StopReason; tokenUsage: TokenUsage }
  | { type: 'error'; error: OmniAgentError };

// ============================================================
// 4. 认证与成本（mod-01 §3.1 + §4.2）
// ============================================================

/** 认证凭证（统一为 API Key 或 OAuth 2.0，mod-01 §4.2） */
export type Credentials =
  | { type: 'api_key'; apiKey: string; providerId: string }
  | { type: 'oauth'; accessToken: string; refreshToken?: string; expiresAt: ISO8601Timestamp; providerId: string };

/** 认证结果 */
export interface AuthResult {
  success: boolean;
  providerId: string;
  error?: OmniAgentErrorCode;
  errorMessage?: string;
  /** 认证失败时不进入运行态（fail-closed，mod-01 §4.2） */
}

/** Token 计数（mod-01 §3.1 countTokens 返回） */
export interface TokenCount {
  inputTokens: number;
  outputTokens: number;
  /** cache 命中读出的 tokens（mod-01 §6.1 命中率指标） */
  cacheReadTokens?: number;
  /** cache 写入的 tokens */
  cacheCreationTokens?: number;
  /** 精确度（第三方 provider 可能只有估算，mod-07 §4.4 逃逸条件 6） */
  accuracy: 'exact' | 'estimated';
}

/** Token 用量（单次调用累计） */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** 成本估算（mod-01 §3.1 estimateCost 返回） */
export interface CostEstimate {
  /** 美元金额 */
  usd: number;
  /** 估算依据（每百万 token 价格） */
  basis?: { inputPerMillion: number; outputPerMillion: number };
}

// ============================================================
// 5. LLMProvider 接口（mod-01 §3.1）
// ============================================================

/** Provider 能力声明（mod-01 §3.1，含 A2 冻结的 supportsRiskClassification） */
export interface Capabilities {
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  supportsPromptCaching: boolean;
  supportsMultiModal: boolean;
  /** [A2 冻结] 是否适合做 Risk Classifier（低延迟、低成本、高准确率） */
  supportsRiskClassification: boolean;
  maxContextWindow: number;
  maxOutputTokens: number;
  tokenCountAccuracy: 'exact' | 'estimated';
}

/** LLMProvider 标准接口（mod-01 §3.1，所有模型后端必须实现） */
export interface LLMProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: Capabilities;

  authenticate(credentials: Credentials): Promise<AuthResult>;
  chatStream(req: ChatRequest): AsyncIterable<ChatChunk>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  countTokens(messages: Message[]): Promise<TokenCount>;
  estimateCost(usage: TokenUsage): CostEstimate;
}

// ============================================================
// 6. 权限系统（mod-04 §3 + mod-03 §3.1）
// ============================================================

/** 六种 PermissionMode（mod-04 §3.4） */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'auto'
  | 'dontAsk';

/** 权限决策（mod-03 §3.1 + mod-04 §3.3 三维匹配） */
export interface PermissionDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
  /** 命中的权限规则来源（如 "cli-arg" / "project-settings" / "default"） */
  matchedRule?: string;
  /** 命中的拦截层（1-5，mod-04 §3.1 五层防御链） */
  layer?: 1 | 2 | 3 | 4 | 5;
}

/** 权限规则三维匹配（mod-04 §3.3） */
export interface PermissionRule {
  tool: string;
  /** 可选，正则匹配命令（Bash 等命令工具用） */
  command?: string;
  /** 可选，glob 匹配路径 */
  path?: string;
  decision: 'allow' | 'deny' | 'ask';
  /** 规则来源（8 层优先级，mod-04 §3.2） */
  source: PermissionRuleSource;
}

/** 权限规则 8 层优先级（mod-04 §3.2） */
export type PermissionRuleSource =
  | 'cli-arg'           // 优先级 1
  | 'session-dynamic'   // 优先级 2
  | 'command-level'     // 优先级 3
  | 'policy-file'       // 优先级 4
  | 'user-settings'     // 优先级 5
  | 'project-settings'  // 优先级 6
  | 'local-settings'    // 优先级 7
  | 'default';          // 优先级 8（fail-closed）

// ============================================================
// 7. 工具系统（mod-03 §3.1 + §3.2）
// ============================================================

/** 工具执行上下文（mod-03 §3.1） */
export interface ToolContext {
  cwd: string;
  permissionMode: PermissionMode;
  agentId: AgentId;
  /** 中断信号（mod-02 §3.3 abort 传播） */
  abortSignal: AbortSignal;
  /** Trace 上下文（跨模块同 trace_id） */
  traceId?: TraceId;
  /** 当前 agent 角色（影响权限规则匹配） */
  agentRole: AgentRole;
}

/** Agent 角色（mod-03 §3.2 工具池隔离） */
export type AgentRole =
  | 'main'
  | 'coordinator'
  | 'worker'
  | 'custom'
  | 'teammate'
  | 'fork';

/** 工具元数据（mod-03 §3.1，fail-closed 默认值） */
export interface Tool {
  name: string;
  description: string;           // ≤ 2048 字符（超长截断，不变量 #15）
  inputSchema: JSONSchema;

  isReadOnly: boolean;           // 默认 false（fail-closed）
  isDestructive: boolean;        // 默认 true（fail-closed）
  isConcurrencySafe: boolean;    // 默认 false（fail-closed）
  isBackground: boolean;         // 默认 false

  checkPermissions(input: ToolInput): PermissionDecision;
  call(input: ToolInput, ctx: ToolContext): Promise<ToolResult>;
}

/** 工具结果（mod-03 §3.1，与 M7 压缩、M2 状态机共享） */
export interface ToolResult {
  tool_use_id: ToolUseId;
  content: ContentBlock[];
  is_error: boolean;
  metadata?: {
    duration_ms: number;
    cost_estimate?: CostEstimate;
    /** 是否可被 M7 压缩（COMPACTABLE_TOOLS 白名单内） */
    compactable?: boolean;
  };
}

/** COMPACTABLE_TOOLS 白名单（mod-07 §4.2，8 个工具） */
export const COMPACTABLE_TOOLS = [
  'bash',
  'edit_file',
  'read_file',
  'write_file',
  'glob',
  'grep',
  'task_output',
  'web_fetch',
] as const;

export type CompactableTool = (typeof COMPACTABLE_TOOLS)[number];

/** mergeAndFilterTools 签名（mod-03 §3.2，跨模块函数 M3/M5/M6 共享） */
export interface MergeAndFilterToolsParams {
  baseTools: Tool[];
  customAgentTools?: Tool[];
  agentRole: AgentRole;
  mcpTools?: Tool[];
}

export interface MergeAndFilterToolsResult {
  filtered: Tool[];
  removed: { tool: Tool; reason: string }[];
  errors?: { tool: Tool; error: string }[];
}

export type MergeAndFilterToolsFn = (params: MergeAndFilterToolsParams) => MergeAndFilterToolsResult;

// ============================================================
// 8. 多 Agent 编排（mod-05 §3 + §5.1 + §5.2）
// ============================================================

/** agent_router 5 路径（mod-05 §3.1） */
export type AgentRoute =
  | 'sync'
  | 'async'
  | 'fork'
  | 'teammate'
  | 'remote';

/** Runtime task 7 种 subtypes（mod-05 §3.2） */
export type RuntimeTaskSubtype =
  | 'sync'
  | 'async'
  | 'fork'
  | 'teammate'
  | 'remote'
  | 'daemon'
  | 'scheduled';

/** Task 状态（mod-05 §3.1 + §4.2 三态恢复） */
export type TaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'evicted'
  | 'stopped';

/** Work item（LLM 维护，mod-05 §3.2） */
export interface WorkItem {
  id: WorkItemId;
  /** 高层任务描述 */
  description: string;
  /** 关联的 runtime task IDs */
  runtimeTaskIds: TaskId[];
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  createdAt: ISO8601Timestamp;
  updatedAt: ISO8601Timestamp;
}

/** Runtime task（harness 维护，mod-05 §3.2） */
export interface RuntimeTask {
  id: TaskId;
  workItemId: WorkItemId;
  subtype: RuntimeTaskSubtype;
  status: TaskStatus;
  /** spawn 时分配的 agent name（teammate 路径用） */
  teammateName?: MailboxName;
  /** 远程目标（remote 路径用，SSH host 或 Remote Server URL） */
  remoteTarget?: string;
  /** 子 agent 的 sidechain ID（fork/teammate/async 路径用） */
  sidechainId?: UUID;
  startedAt: ISO8601Timestamp;
  finishedAt?: ISO8601Timestamp;
  /** 超时配置（ms） */
  timeoutMs?: number;
}

/** agent_router 工具接口签名（mod-05 §5.1） */
export interface AgentRouterParams {
  route: AgentRoute;
  prompt: string;
  parent_context_mode?: 'inherit' | 'isolated';
  teammate_name?: MailboxName;
  remote_target?: string;
  tools_whitelist?: string[];
  timeout_ms?: number;
}

export interface AgentRouterResult {
  task_id: TaskId;
  work_item_id: WorkItemId;
  status: TaskStatus;
  result?: ToolResult;
}

// ============================================================
// 9. Mailbox 通信（mod-05 §3.3 + §5.2）
// ============================================================

/** Mailbox 消息（mod-05 §3.3，文件系统 JSONL 按 name 寻址） */
export interface MailboxMessage {
  id: UUID;
  from: AgentId | MailboxName;
  to: MailboxName;
  /** 消息类型（plain text / structured / shutdown protocol） */
  type: 'text' | 'json' | 'shutdown_request' | 'shutdown_response' | 'task_update';
  payload: unknown;
  timestamp: ISO8601Timestamp;
  /** 是否已读（跨 turn 持久化，leader 重启后未读消息仍可达） */
  read?: boolean;
}

/** Mailbox 容量限制（mod-05 §3.3 + §5.2） */
export interface MailboxCapacityLimits {
  /** 单条消息上限 64KB */
  maxSingleMessageBytes: 64 * 1024;
  /** 单个 mailbox 文件上限 4MB */
  maxMailboxFileBytes: 4 * 1024 * 1024;
  /** 单个 mailbox 消息数上限 1000 */
  maxMessagesPerMailbox: 1000;
  /** 老消息归档阈值（超限后最老 200 条移到 .archive.jsonl） */
  archiveThreshold: 200;
}

/** writeMailboxAtomic 签名（mod-05 §5.2，M7 提供原子写原语 M5 调用） */
export interface WriteMailboxAtomicParams {
  teammate_name: MailboxName;
  message: MailboxMessage;
  retries?: number;             // 默认 10
}

export interface WriteMailboxAtomicResult {
  written: boolean;
  error?: 'file_locked' | 'over_capacity' | 'io_error';
  archive_triggered?: boolean;
}

// ============================================================
// 10. CompactBoundary（mod-07 §4.6）
// ============================================================

/** CompactBoundary 元数据（mod-07 §4.6，M7 发出，/rewind 读取） */
export interface CompactBoundary {
  boundary_id: BoundaryId;
  /** 压缩前的 message range（索引） */
  compactRange: { start: number; end: number };
  /** 压缩前的 token 数 */
  tokensBefore: number;
  /** 压缩后的 token 数 */
  tokensAfter: number;
  timestamp: ISO8601Timestamp;
  /** 所属 transcript（主 transcript 或 sidechain ID） */
  transcriptId: UUID;
  /** 触发的压缩层级（mod-07 §4.2） */
  triggerLayer: 'L1_micro' | 'L2_session' | 'L3_api_summary';
}

// ============================================================
// 11. 上下文压缩跨模块函数（mod-02 §4.4 + mod-07 §4.2）
// ============================================================

/** adjustIndexToPreserveAPIInvariants 签名（mod-02 §4.4，M7 实现 M2 调用） */
export interface AdjustIndexToPreserveAPIInvariantsParams {
  messages: Message[];
  compactRange: { start: number; end: number };
}

export interface AdjustIndexToPreserveAPIInvariantsResult {
  adjustedRange: { start: number; end: number };
  corrections: {
    type: 'remove_orphan_tool_use' | 'extend_to_include_pair';
    index: number;
    reason: string;
  }[];
  error?: { reason: string; index: number };
}

export type AdjustIndexToPreserveAPIInvariantsFn = (
  params: AdjustIndexToPreserveAPIInvariantsParams
) => AdjustIndexToPreserveAPIInvariantsResult;

/** shouldAutoCompact 签名（mod-02 §4.4，M7 实现 M2 每轮调用） */
export interface ShouldAutoCompactContext {
  messages: Message[];
  tokenCount: number;
  maxContextWindow: number;
  compacting: boolean;
  hasCompacted: boolean;
  inCollapse: boolean;
  budgetContinuation: boolean;
  providerSupportsExactTokenCount: boolean;
  userDisabledAutoCompact: boolean;
}

export interface ShouldAutoCompactResult {
  shouldCompact: boolean;
  reason:
    | 'approaching_limit'
    | 'skip_user_disabled'
    | 'skip_compacting'
    | 'skip_already_compacted'
    | 'skip_in_collapse'
    | 'skip_budget_continuation'
    | 'skip_conservative_estimate';
  triggerLayer?: 'L1_micro' | 'L2_session' | 'L3_api_summary';
}

export type ShouldAutoCompactFn = (ctx: ShouldAutoCompactContext) => ShouldAutoCompactResult;

// ============================================================
// 12. DenialTracker（mod-04 §4.1 + §4.2）
// ============================================================

/** DenialTracker 上下文（mod-04 §4.1 DenialTracking 语义统一） */
export type DenialTrackerContext =
  | 'risk_classifier'
  | 'hooks';

/** DenialTracker 触发动作（mod-04 §4.1，两上下文统一 fail-closed）
 *
 * 关键修正（L2 自审 C7）：
 * - 原设计 hooks 上下文用 'bypass_with_warning'（fail-OPEN），存在 DoS→authz bypass 风险
 * - 修正：两上下文统一 'degrade_to_ask'（fail-closed）
 * - 安全语义：DenialTracker 触发意味着"我无法判断"，正确动作是"让用户来判断"（ask）
 *   而非"放行"（bypass），否则攻击者可构造 3 次误报触发降级后绕过后续拦截
 */
export type DenialTrackerAction = 'degrade_to_ask';

/** DenialTracker 类接口（mod-04 §4.1 + §4.2） */
export interface DenialTracker {
  readonly context: DenialTrackerContext;
  readonly maxConsecutive: 3;
  readonly maxTotal: 20;

  /** 记录一次拒绝/误报 */
  record(denial: { reason: string; rule?: string }): void;
  /** 检查是否触发降级/放行 */
  shouldTrigger(): boolean;
  /** 获取触发后的动作 */
  getAction(): DenialTrackerAction;
  /** 重置计数器（新 turn 开始时） */
  reset(): void;
  /** 当前状态（审计用） */
  snapshot(): {
    consecutive: number;
    total: number;
    triggered: boolean;
    action?: DenialTrackerAction;
  };
}

// ============================================================
// 13. Hook 系统（mod-04 §4.2）
// ============================================================

/** Hook 27 种事件（mod-04 §4.2，按 7 大类别分组） */
export type HookEventName =
  // 工具事件（5）
  | 'PreToolUse' | 'PostToolUse' | 'ToolError' | 'ToolResultFiltered' | 'ToolPoolChanged'
  // Agent 事件（4）
  | 'AgentStart' | 'AgentStop' | 'SubagentSpawn' | 'SubagentExit'
  // 会话事件（4）
  | 'SessionStart' | 'SessionEnd' | 'CompactBoundary' | 'Resume'
  // 消息事件（2，由 M2 发出）
  | 'UserPromptSubmit' | 'AssistantResponse'
  // 权限事件（4）
  | 'PermissionDeny' | 'PermissionAllow' | 'PermissionAsk' | 'PermissionEscalation'
  // 模型事件（4）
  | 'ModelSwitch' | 'ProviderError' | 'FallbackTriggered' | 'StallDetected'
  // 系统事件（4）
  | 'Shutdown' | 'Crash' | 'BudgetExceeded' | 'ScheduleTriggered';

/** Hook 6 种类型（mod-04 §4.2，function 类型 v1.0 仅内置） */
export type HookType =
  | 'command'
  | 'prompt'
  | 'agent'
  | 'http'
  | 'callback'
  | 'function';    // v1.0 仅限内置扩展（决策 A4）

/** Hook 响应契约（mod-04 §4.2 JSON Schema） */
export interface HookResponse {
  permissionDecision?: 'allow' | 'deny' | 'ask';
  updatedInput?: ToolInput;
  additionalContext?: string;
  continue: boolean;
}

/** Hook payload 联合类型（mod-04 §4.2 关键事件 payload 契约） */
export type HookPayload =
  | PreToolUsePayload
  | PostToolUsePayload
  | CompactBoundaryPayload
  | UserPromptSubmitPayload
  | AssistantResponsePayload
  | PermissionDenyPayload
  | ShutdownPayload
  | GenericHookPayload;

export interface PreToolUsePayload {
  event: 'PreToolUse';
  tool_name: string;
  input: ToolInput;
  agent_id: AgentId;
  cwd: string;
}

export interface PostToolUsePayload {
  event: 'PostToolUse';
  tool_name: string;
  input: ToolInput;
  result: ToolResult;
  duration_ms: number;
}

export interface CompactBoundaryPayload {
  event: 'CompactBoundary';
  boundary_id: BoundaryId;
  compact_range: { start: number; end: number };
  tokens_before: number;
  tokens_after: number;
}

export interface UserPromptSubmitPayload {
  event: 'UserPromptSubmit';
  prompt: string;
  session_id: SessionId;
}

export interface AssistantResponsePayload {
  event: 'AssistantResponse';
  response: string;
  stop_reason: StopReason;
  tokens: { input: number; output: number };
}

export interface PermissionDenyPayload {
  event: 'PermissionDeny';
  tool_name: string;
  matched_rule: string;
  layer: 1 | 2 | 3 | 4 | 5;
}

export interface ShutdownPayload {
  event: 'Shutdown';
  reason: 'user' | 'crash' | 'budget';
  session_id: SessionId;
}

/** 通用 Hook payload（未在上面 7 类显式定义的事件用此） */
export interface GenericHookPayload {
  event: HookEventName;
  [key: string]: unknown;
}

/** Hook 定义（mod-04 §4.2） */
export interface Hook {
  event: HookEventName;
  type: HookType;
  /** command 类型：shell 命令；prompt 类型：注入文本；agent 类型：prompt；http 类型：URL；callback/function 类型：函数名 */
  target: string;
  /** 异步 Hook（首行 {"async":true} 检测，asyncRewake 退出码 2） */
  async?: boolean;
  /** 超时（ms） */
  timeoutMs?: number;
}

// ============================================================
// 14. Risk Classifier（mod-04 §4.1）
// ============================================================

/** Risk Classifier 决策阶段（mod-04 §4.1 两阶段） */
export type RiskClassifierStage = 'fast' | 'thinking';

/** Risk Classifier 输出（mod-04 §4.1） */
export interface RiskClassifierResult {
  stage: RiskClassifierStage;
  /** 风险评分（0-1，1 = 最危险） */
  riskScore: number;
  /** 置信度（0-1） */
  confidence: number;
  /** 决策（严格档阈值：≥0.95 自动 / 0.80-0.95 ask / <0.80 needs_review） */
  decision: 'allow' | 'deny' | 'ask' | 'needs_review';
  /** 命中的规则 ID（Fast 阶段）或 LLM 推理摘要（Thinking 阶段） */
  rationale: string;
  /** 失败时填（必降级为 ask，不臆造批准） */
  error?: OmniAgentErrorCode;
}

/** Risk Classifier 评测集验收指标（mod-04 §4.1 严格档） */
export const RISK_CLASSIFIER_THRESHOLDS = {
  /** 漏报率（危险命令被放过）≤ 3% */
  maxFalseNegativeRate: 0.03,
  /** 误报率（安全命令被拦）≤ 15% */
  maxFalsePositiveRate: 0.15,
  /** 高置信度阈值 */
  autoThreshold: 0.95,
  /** 中置信度下限 */
  askThreshold: 0.80,
} as const;

// ============================================================
// 15. 沙箱机制（mod-04 §4.3）
// ============================================================

/** 沙箱技术选型（mod-04 §4.3 平台对应） */
export type SandboxTechnology =
  | 'sandbox-exec'    // macOS
  | 'bubblewrap'      // Linux
  | 'none';           // Windows（纯权限规则 + 推荐 WSL）

/** 沙箱 4 类 deny 路径（mod-04 §4.3，不变量 #10） */
export const SANDBOX_DENY_PATHS = [
  '.omniagent/settings.json',    // 防篡改
  '.omniagent/skills/',          // 防注入
  'bare-git-repo',               // 防供应链攻击
  'system-dirs',                 // /etc, /usr, /bin 防破坏
] as const;

/** 沙箱配置（mod-04 §4.3） */
export interface SandboxConfig {
  technology: SandboxTechnology;
  /** 是否启用沙箱（root 用户/容器内降级为 false） */
  enabled: boolean;
  /** 降级原因（如 "root user" / "container environment"） */
  degradeReason?: string;
  /** 路径白名单（sandbox-exec profile / bubblewrap --ro-bind） */
  allowedPaths?: string[];
  /** 网络策略 */
  networkPolicy?: 'allow' | 'deny' | 'allow-list';
}

// ============================================================
// 16. Skills 插件（mod-06 §3.1 + §3.2）
// ============================================================

/** Skill 16 字段 frontmatter（mod-06 §3.2） */
export interface SkillFrontmatter {
  name: string;
  description: string;
  tools: string[];
  permissions?: Record<string, 'allow' | 'deny' | 'ask'>;
  triggers?: string[];
  scope: 'project' | 'user' | 'builtin';
  mode?: 'inline' | 'fork';
  async?: boolean;
  timeout?: number;
  retry?: { max: number; backoff: 'linear' | 'exponential' };
  fallback?: 'error' | 'skip' | 'inline';
  metadata?: Record<string, unknown>;
  version?: string;
  author?: string;
  tags?: string[];
  examples?: string[];
}

/** Skill 5 种来源（mod-06 §4.1） */
export type SkillSource =
  | 'builtin'    // 编译进二进制（最高优先级，不可覆盖）
  | 'bundled'    // 随发行版附带
  | 'disk'       // .omniagent/skills/*.md
  | 'mcp'        // 通过 MCP server 提供
  | 'legacy';    // 兼容旧格式

/** Skill 定义（mod-06 §3.1） */
export interface Skill {
  frontmatter: SkillFrontmatter;
  /** Skill 正文（Markdown instructions） */
  body: string;
  source: SkillSource;
  /** 文件路径（disk 来源用） */
  filePath?: string;
}

// ============================================================
// 17. 记忆系统（mod-07 §3.1 + §3.2 + §3.3）
// ============================================================

/** 记忆 4 层架构（mod-07 §3.1） */
export type MemoryLayer =
  | 'L1_working'    // 当前对话消息 + 工具调用结果，单会话全量注入
  | 'L2_session'    // 跨 turn 的关键事实摘要，单会话按需召回
  | 'L3_project'    // ~/.omniagent/memory/*.md，跨会话持久召回注入
  | 'L4_system';    // 品牌 + 工具说明 + 不变量，单会话静态前缀

/** 项目记忆 4 类型（mod-07 §3.2） */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** 记忆文件 frontmatter schema（mod-07 §3.2） */
export interface MemoryFrontmatter {
  name: string;                              // snake_case 唯一
  description: string;                       // 一行描述，召回相关性判定
  type: MemoryType;
  scope?: 'project' | 'user';                // 默认 project
  created_at?: ISO8601Timestamp;
  updated_at?: ISO8601Timestamp;
  version?: number;
}

/** 记忆文件（mod-07 §3.2） */
export interface Memory {
  frontmatter: MemoryFrontmatter;
  body: string;
  filePath?: string;
}

/** findRelevantMemories 签名（mod-07 §3.3，轻量级 LLM 召回） */
export type FindRelevantMemoriesFn = (
  query: string,
  maxTokens?: number           // 默认 256
) => Promise<Memory[]>;

/** 召回质量指标（mod-07 §6.3，决策 C2） */
export const MEMORY_RECALL_THRESHOLDS = {
  recallAt5: 0.8,
  precisionAt5: 0.7,
  maxTokensPerQuery: 256,
} as const;

// ============================================================
// 18. 统一错误码（mod-04 §3.1 fail-closed + mod-02 §4.1 终止条件）
// ============================================================

/** OmniAgent 统一错误码（mod-02 §4.1 + mod-04 §3.1 + mod-05 §5.1 + mod-07 §4.5.3） */
export type OmniAgentErrorCode =
  // Provider 错误（mod-01 §6.2 + mod-02 §4.1）
  | 'PROVIDER_5XX'
  | 'PROVIDER_429'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_AUTH_FAILED'
  // 工具执行错误
  | 'TOOL_EXECUTION_ERROR'
  | 'TOOL_TIMEOUT'
  | 'TOOL_PERMISSION_DENIED'
  // PTL / autocompact
  | 'PTL_ERROR'
  | 'AUTOCOMPACT_CIRCUIT_BREAKER'
  // 持久化错误（mod-07 §4.5）
  | 'PERSISTENCE_IO_ERROR'
  | 'PERSISTENCE_CORRUPTION'
  // Mailbox 错误（mod-05 §5.2）
  | 'MAILBOX_FULL'
  | 'MAILBOX_LOCKED'
  // 沙箱 / Risk Classifier
  | 'SANDBOX_FAILED'
  | 'RISK_CLASSIFIER_FAILED'
  // 预算 / 用户中断
  | 'BUDGET_EXCEEDED'
  | 'USER_INTERRUPT'
  // 9 场景恢复（mod-07 §4.5.3）
  | 'SCENARIO_TRANSCRIPT_CORRUPT'
  | 'SCENARIO_SIDECHAIN_CORRUPT'
  | 'SCENARIO_TEAM_MISSING'
  | 'SCENARIO_MAILBOX_CORRUPT'
  | 'SCENARIO_TASK_CORRUPT'
  | 'SCENARIO_SIDECAR_404'
  | 'SCENARIO_WORKTREE_MISSING'
  | 'SCENARIO_FORK_METADATA_MISSING'
  | 'SCENARIO_MODE_MISMATCH';

/** OmniAgent 统一错误（携带 code + 上下文） */
export interface OmniAgentError {
  code: OmniAgentErrorCode;
  message: string;
  /** 错误来源模块 */
  module?: 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7';
  /** 错误来源层（mod-04 §3.1 五层防御链） */
  layer?: 1 | 2 | 3 | 4 | 5;
  /** 是否可重试 */
  retryable: boolean;
  /** 建议的降级动作 */
  fallbackAction?: string;
  /** trace 上下文（跨模块关联） */
  traceId?: TraceId;
  /** 原始错误（如 provider 返回的 HTTP body） */
  cause?: unknown;
}

// ============================================================
// 19. 审计日志（mod-04 §4.5）
// ============================================================

/** 审计日志条目（mod-04 §4.5） */
export interface AuditLogEntry {
  timestamp: ISO8601Timestamp;
  command: string;
  cwd: string;
  user: string;
  permission_decision: 'allow' | 'deny' | 'ask';
  exit_code: number;
  layer?: 1 | 2 | 3 | 4 | 5;
  risk_classifier_context?: 'fast' | 'thinking';
  denial_tracker_context?: 'risk_classifier' | 'hooks';
  /** trace 上下文 */
  trace_id?: TraceId;
  /** 命中的权限规则 */
  matched_rule?: string;
  /** 沙箱是否启用（mod-04 §4.3 降级场景） */
  sandbox_enabled?: boolean;
}

// ============================================================
// 20. 可观测性（mod-04 §4.5 + L2 §7）
// ============================================================

/** 日志级别（mod-04 §4.5 三级告警扩展为五级） */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

/** 结构化日志条目（L2 §7） */
export interface LogEntry {
  ts: ISO8601Timestamp;
  level: LogLevel;
  module: 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'harness' | 'ui';
  msg: string;
  fields?: Record<string, unknown>;
  trace_id?: TraceId;
  span_id?: SpanId;
}

/** Tracing span 模型（L2 §7，OpenTelemetry 兼容） */
export interface Span {
  trace_id: TraceId;
  span_id: SpanId;
  parent_span_id?: SpanId;
  operation: string;
  start: ISO8601Timestamp;
  end?: ISO8601Timestamp;
  tags: Record<string, string | number | boolean>;
  /** span 状态（OTel 兼容） */
  status?: 'unset' | 'ok' | 'error';
  /** 错误信息（status=error 时填） */
  error?: OmniAgentError;
}

// ============================================================
// 21. 配置 schema（mod-02 §4.2 + mod-01 §3.1）
// ============================================================

/** 配置文件 schema（mod-02 §4.2 settings.json） */
export interface OmniAgentConfig {
  llm: {
    provider: string;
    model: string;
    /** [C1 冻结] 同 provider 内 fallback（单值） */
    fallbackModel?: string;
  };
  /** 权限规则（mod-04 §3.2 8 层优先级） */
  permissions?: {
    rules: PermissionRule[];
    defaultMode: PermissionMode;
  };
  /** 沙箱配置（mod-04 §4.3） */
  sandbox?: SandboxConfig;
  /** 预算（mod-04 §3.1 Layer 5） */
  budget?: {
    maxConsecutive: number;
    maxTotal: number;
    /** 单 turn 预算上限（USD） */
    maxPerTurn?: number;
  };
  /** Hooks（mod-04 §4.2） */
  hooks?: Hook[];
  /** 实验 feature 开关（决策 A3，全部默认 off） */
  experiments?: {
    taskScheduler?: boolean;
    proactivePlanner?: boolean;
    covertMode?: boolean;
    workflowOrchestrator?: boolean;
    teamRecommender?: boolean;
    contextAnchor?: boolean;
  };
  /** 并发 agent 上限（L2 §5） */
  maxConcurrentAgents?: number;             // 默认 16
}

// ============================================================
// 22. 跨模块函数签名汇总（M3/M5/M6/M7 实现方与调用方约定）
// ============================================================

/**
 * 跨模块函数实现/调用约定：
 *
 * - mergeAndFilterTools:           M3 实现，M5/M6 调用（工具池硬隔离，不变量 #4）
 * - adjustIndexToPreserveAPIInvariants: M7 实现，M2 调用（不变量 #3 tool_use/tool_result 配对）
 * - shouldAutoCompact:             M7 实现，M2 每轮调用（6 逃逸条件 + 3 层触发）
 * - findRelevantMemories:          M7 实现，M2 BUILD_CONTEXT 调用（recall@5≥0.8）
 * - writeMailboxAtomic:            M7 实现原子写原语，M5 调用（不变量 #7 零丢失）
 * - agent_router:                  M5 实现，M2 经 M3 工具接口调用（5 路径路由）
 *
 * 这些函数签名在 L2 文档 §3 与本文件中冻结，实现方与调用方必须双向遵循。
 *
 * 使用方式：
 *   import type { Message, ChatRequest, LLMProvider } from './omniagent-types';
 *   import { COMPACTABLE_TOOLS, RISK_CLASSIFIER_THRESHOLDS } from './omniagent-types';
 */
