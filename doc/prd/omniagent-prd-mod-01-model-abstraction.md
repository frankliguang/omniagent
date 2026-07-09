# OmniAgent CLI — 模块 1：模型抽象层 (Model Abstraction) PRD

> 模块 ID: M1
> 主负责角色: 架构师
> 阻塞里程碑: M1（Walking Skeleton）
> 源章节: 总体 PRD §3.2
> 状态: M0 已冻结

---

## 1. 模块概述

### 范围（in scope）

- 定义 `LLMProvider` 标准接口，所有模型后端（云/本地/兼容协议）必须实现
- 实现流适配器（Stream Adapter），将各家供应商的 SSE/EventStream/HTTP 协议转为统一内部消息格式
- 认证标准化：API Key 与 OAuth 2.0 两类标准流程
- 能力声明机制：通过 `capabilities` 字段让 harness 据此适配行为（流式、工具调用、缓存、多模态、Risk Classifier 适配等）
- 模型降级策略（同 provider 内 fallback）

### 边界（out of scope）

- **ReAct 状态机**：由 M2 核心循环引擎负责，本模块只提供 `chatStream()`/`chat()` 调用入口
- **工具调用执行**：由 M3 通用工具系统负责，本模块只传递 `tool_calls` 字段
- **Risk Classifier 决策逻辑**：由 M4 权限与拦截系统负责，本模块只提供 `supportsRiskClassification` 能力标记供筛选
- **上下文压缩与 token 计数策略**：由 M7 上下文与记忆引擎负责，本模块只提供 `countTokens()` 原语

### 在整体架构中的位置

模型抽象层是 harness 层与 LLM 后端之间的**唯一桥梁**。harness 代码只调用 `LLMProvider` 接口，不出现任何供应商专有名词。任意层可独立替换：云模型可换、本地模型可换、兼容协议模型可换，harness 行为一致。

---

## 2. 设计目标

1. **供应商零耦合**：harness 代码 grep 不到任何供应商专有名词（`openai`/`bedrock`/`claude` 等只出现在 provider 实现文件与配置示例中）
2. **能力自适应**：通过 `capabilities` 字段声明，harness 自动适配流式/非流式、精确/估算 token 计数、缓存支持等差异
3. **认证统一**：不依赖任何专有认证协议，统一为 API Key 或 OAuth 2.0 标准
4. **降级可控**：provider 5xx/429 时自动同 provider 内 fallback，跨 provider 降级延后到 M2 里程碑
5. **Risk Classifier 适配**：通过 `supportsRiskClassification` 标记让 M4 筛选适合的轻量级模型

---

## 3. 核心概念与接口

### 3.1 `LLMProvider` 接口规范

> [M0 冻结决策 A2 更新] `capabilities` 字段新增 `supportsRiskClassification`，标识该 provider 是否适合做 Risk Classifier（要求低延迟、低成本、高准确率）。Risk Classifier 的 thinking 阶段用此标记筛选 provider。

所有模型后端必须实现以下标准接口（TypeScript 描述，仅作契约说明，非实现）：

```typescript
interface LLMProvider {
  // 唯一标识
  readonly id: string;                    // e.g. "openai", "bedrock", "ollama"
  readonly displayName: string;           // e.g. "OpenAI GPT-4"

  // 能力声明（harness 据此适配行为）
  readonly capabilities: {
    supportsStreaming: boolean;           // 是否支持 SSE 流式
    supportsToolCalling: boolean;         // 是否支持 Function Calling
    supportsPromptCaching: boolean;       // 是否支持 prompt cache
    supportsMultiModal: boolean;          // 是否支持图片/视频输入
    supportsRiskClassification: boolean;  // [A2 新增] 是否适合做 Risk Classifier（低延迟、低成本、高准确率）
    maxContextWindow: number;             // 最大上下文窗口
    maxOutputTokens: number;              // 单次最大输出
    tokenCountAccuracy: 'exact' | 'estimated';  // 是否提供精确 token 计数
  };

  // 认证（统一为 API Key 或 OAuth 2.0）
  authenticate(credentials: Credentials): Promise<AuthResult>;

  // 核心调用（流式）
  chatStream(req: ChatRequest): AsyncIterable<ChatChunk>;

  // 核心调用（非流式降级用）
  chat(req: ChatRequest): Promise<ChatResponse>;

  // Token 计数（用于上下文工程）
  countTokens(messages: Message[]): Promise<TokenCount>;

  // 成本查询
  estimateCost(usage: TokenUsage): CostEstimate;
}
```

### 3.2 统一消息格式（harness 内部）

各家供应商的 SSE 协议、消息格式、工具调用字段命名各异，harness 内部只认统一消息格式：

- `role`: `'system' | 'user' | 'assistant' | 'tool'`
- `content`: `ContentBlock[]`（支持 text / image / tool_use / tool_result）
- `tool_use`: `{ id, name, input }`（JSON Schema 标准化 input）
- `tool_result`: `{ tool_use_id, content, is_error }`
- `stop_reason`: `'end_turn' | 'tool_use' | 'max_tokens' | 'ptl' | 'interrupted'`

### 3.3 Risk Classifier provider 选型要求

基于 `supportsRiskClassification` 标记筛选：

- 延迟：thinking 阶段 ≤ 1s（用户可接受的打断阈值）
- 成本：单次分类 ≤ $0.001（高频调用，成本敏感）
- 准确率：漏报率 ≤ 3%（对齐 A1 严格档）
- 典型候选：GPT-4o-mini / Claude Haiku / DeepSeek-V3-lite 级别的云端轻量级模型

---

## 4. 功能详述

### 4.1 流适配器（Stream Adapter）

各家供应商的协议特点与适配重点：

| 供应商 | 协议特点 | 适配重点 |
|--------|---------|---------|
| OpenAI | SSE 流，`tool_calls` 数组 | 字段名映射 + 流分片合并 |
| AWS Bedrock | EventStream 二进制流 | 反序列化 + 事件类型归一 |
| Azure OpenAI | 与 OpenAI 同协议，差异在 endpoint | 仅换 base URL + 认证头 |
| Google Vertex AI | SSE 流，`functionCall` 字段 | 字段名映射 + 多模态归一 |
| Ollama | 本地 HTTP 流，`tool_calls` 兼容 OpenAI 格式 | 直接透传 + 错误码归一 |
| OpenAI 兼容（DeepSeek/Qwen/GLM/Grok/vLLM） | 协议层一致，能力差异大 | 能力探测 + 降级策略 |

流适配器核心职责：
1. 消费供应商的原始 SSE/EventStream/HTTP 响应
2. 解析供应商特定的 JSON 字段，映射到统一消息格式
3. 处理流分片（同一 `tool_use` 可能分多个 chunk 到达，需合并）
4. 归一化错误码（供应商各自的 rate limit / server error / auth error 映射到统一错误枚举）
5. 输出 `ChatChunk` 流供 harness 消费

### 4.2 认证标准化

OmniAgent CLI 不依赖任何专有认证协议，认证方式统一为两类：

1. **API Key 认证**（默认）：从环境变量、`.omniagent/credentials.json`、系统 keychain 读取，启动期校验，fail-closed。
2. **OAuth 2.0 标准流程**：用于需要用户交互授权的供应商（如 Google Vertex），支持 PKCE 完整流程，token 存储于系统 keychain。

认证失败不进入运行态，明确提示用户补全凭证，不静默降级。

### 4.3 v1.0 支持的 Provider 列表

M1 Walking Skeleton 阶段必须支持 3 个 provider（覆盖云/合规/本地三大场景）：

| Provider | 场景 | 里程碑 |
|----------|------|--------|
| OpenAI | 云端主流 | M1 |
| AWS Bedrock | 合规云（金融/政府） | M1 |
| Ollama | 本地模型（数据不出内网） | M1 |

M2-M4 阶段补全：Azure OpenAI、Google Vertex AI、OpenAI 兼容协议（DeepSeek/Qwen/GLM/Grok/vLLM）。

---

## 5. 与其他模块的交互

| 交互模块 | 交互方式 | 数据/控制流 |
|---------|---------|------------|
| M2 核心循环引擎 | 被调用 | M2 通过 `chatStream(req)` 发起调用，消费 `ChatChunk` 流；`stop_reason` 决定 M2 状态机分支 |
| M2 核心循环引擎（降级） | 被调用 | M2 检测 5xx/连续 stall 时，调用本模块切换 `fallbackModel`（同 provider 内）重发 |
| M4 权限与拦截系统 | 能力查询 | M4 Risk Classifier thinking 阶段查询 `capabilities.supportsRiskClassification` 筛选轻量级 provider |
| M7 上下文与记忆引擎 | 原语调用 | M7 调用 `countTokens(messages)` 做上下文体积估算与压缩触发判断 |
| M7 上下文与记忆引擎（召回） | 能力查询 | M7 findRelevantMemories 用类似的轻量级筛选逻辑选召回用 LLM（与主对话模型可不同） |

---

## 6. 模块级非功能性需求

从总体 PRD §5 抽取与本模块相关的 NFR：

### 6.1 性能指标（摘自 §5.2.1）

| 指标 | 目标值 | 测量方式 |
|------|-------|---------|
| TTFT（首 token） | ≤ 2s | LLMProvider 埋点 |
| Prompt cache 命中率 | ≥ 80% | cache_read / input_tokens |
| 流式 stall 率 | ≤ 1% | stall_count / total_streams |
| Risk Classifier Thinking 阶段延迟 | ≤ 1s | LLM 调用埋点 |
| findRelevantMemories 召回延迟 | ≤ 2s | LLM 调用埋点 |

### 6.2 可靠性指标（摘自 §5.2.2）

| NFR | 目标值 |
|-----|-------|
| API 5xx 重试成功率（含 fallback model 降级） | ≥ 95% |
| Risk Classifier 调用失败降级率 | 100%（失败必降级为 ask，不臆造批准） |

### 6.3 护栏指标（摘自 §5.2.3）

| 护栏 | 目标值 | 为什么是护栏 |
|------|-------|------------|
| 流式 stall 率 | ≤ 1% | stall = 用户感知卡顿 |
| Risk Classifier 成本漂移 | 单次 ≤ $0.001 | 高频调用成本失控 |

---

## 7. 模块级不变量

从附录 A 18 项不变量中抽取与本模块相关的条目：

| # | 不变量 | 守护机制 |
|---|--------|---------|
| 17 | harness 代码不含任何供应商专有名词 | grep 检查（CI 强制门控，供应商名只允许出现在 provider 实现文件与配置示例） |
| 18 | 同一任务在不同 LLMProvider 下行为一致 | 行为一致性测试（M1 验收项，同任务在 OpenAI/Bedrock/Ollama 下工具调用/权限/记忆行为一致） |

---

## 8. 开放问题与依赖

### 8.1 已冻结决策（M0）

| 决策 | 内容 | 影响 |
|------|------|------|
| A2 | Risk Classifier 决策模型：规则表（fast）+ 云端轻量级 LLM（thinking） | 本模块 `capabilities.supportsRiskClassification` 字段为 M4 筛选依据 |
| C1 | Fallback model 链策略：同 provider 内自动降级（v1.0），跨 provider M2 后补 | 本模块 v1.0 实现 `fallbackModel` 单值字段；跨 provider chain 延后 |
| C3 | 多语言 SDK 协议：v1.0 仅 TypeScript SDK | 本模块 v1.0 仅发布 TS SDK，Python/Go SDK 延后到 M4 |

### 8.2 依赖其他模块的交付物

- M2 核心循环引擎：消费 `ChatChunk` 流，本模块的 `stop_reason` 输出必须与 M2 状态机分支匹配
- M4 权限与拦截系统：Risk Classifier 调用本模块的轻量级 provider，要求 `supportsRiskClassification=true` 的 provider 在 M3 启动前选型确认

### 8.3 评测集引用

本模块无直接评测集依赖。Risk Classifier 评测集（`omniagent-eval/risk-classifier/`，119 条标注 bash）与 findRelevantMemories 评测集（`omniagent-eval/memory-recall/`，30 条标注会话）由 M4 与 M7 负责验收，但验收时通过本模块的 provider 接口调用 LLM。

### 8.4 v2.x 演进项

- 跨 provider fallback chain：`fallbackChain: ["openai:gpt-4", "bedrock:claude", "ollama:llama3"]`
- Risk Classifier 本地小模型：`OMNIAGENT_RISK_CLASSIFIER_LOCAL=1` 切换本地模型（如 Llama-3-8B 微调）
- findRelevantMemories 本地 embedding：满足合规场景数据不出内网

---

## 9. 参考链接

- 总体 PRD：`omniagent-prd.md` §3.2
- 冻结决策记录：`omniagent-prd-decisions.md`（决策 A2、C1、C3）
- 相关模块：M2 核心循环引擎、M4 权限与拦截系统、M7 上下文与记忆引擎
- 里程碑：M1 Walking Skeleton（3 个 provider 必须就绪）
