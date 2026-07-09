/**
 * MemoryRecaller（L3-M7 §3.3 + §4.1 — findRelevantMemories 轻量级 LLM 召回）
 *
 * 决策 C2：用轻量级 LLM 召回相关记忆（非本地 embedding，合规场景 embedding 延后 v2.x）。
 *
 * 接口：findRelevantMemories(query, maxTokens=256) → Memory[]
 *
 * 流程：
 *  1. 加载 L3 项目记忆（loadMemoryDir）
 *  2. 若无记忆或 query 为空，返回 []
 *  3. 构造 LLM prompt：列出所有记忆 name+description，让 LLM 选相关的
 *  4. 解析 LLM 响应：name + confidence 列表
 *  5. 按 confidence ≥ threshold 过滤，取前 maxResults 条
 *  6. LLM 失败时返回 []（mod-07 §4.1 "模型失败时跳过召回，对话继续不崩"）
 *
 * 召回指标（决策 C2）：
 *  - recall@5 ≥ 0.8
 *  - precision@5 ≥ 0.7
 *
 * M1 实现：用主对话 provider 调用（M1 无独立轻量级 provider 选型），
 * 后续 M3/M4 可通过 supportsRiskClassification 筛选轻量级 provider 替代。
 */

import type {
  ChatRequest,
  Credentials,
  LLMProvider,
  Memory,
  Message,
} from '../types/index.js';
import { loadMemoryDir } from './memory-loader.js';

export interface MemoryRecallerOptions {
  /** L3 项目记忆目录（默认 ~/.omniagent/memory） */
  memoryDir?: string;
  /** 召回置信度阈值（默认 0.5） */
  confidenceThreshold?: number;
  /** 最多返回的记忆数（默认 5） */
  maxResults?: number;
  /** 召回用模型（默认用 provider 的默认 model） */
  model?: string;
}

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_TOKENS = 256;

/** 默认记忆目录：~/.omniagent/memory */
function defaultMemoryDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return `${home}/.omniagent/memory`;
}

/** LLM 响应中单条记忆的相关性评分 */
interface MemoryRelevanceScore {
  name: string;
  confidence: number;  // 0.0 - 1.0
}

export class MemoryRecaller {
  private readonly provider: LLMProvider;
  private readonly memoryDir: string;
  private readonly threshold: number;
  private readonly maxResults: number;
  private readonly model?: string;
  /** 凭证状态（首次召回时 authenticate） */
  private authenticated = false;

  constructor(provider: LLMProvider, opts?: MemoryRecallerOptions) {
    this.provider = provider;
    this.memoryDir = opts?.memoryDir ?? defaultMemoryDir();
    this.threshold = opts?.confidenceThreshold ?? DEFAULT_THRESHOLD;
    this.maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;
    this.model = opts?.model;
  }

  /**
   * findRelevantMemories — mod-07 §3.3 接口
   *
   * @param query 用户当前 query（用于相关性判定）
   * @param maxTokens LLM 调用 max_tokens（默认 256，决策 C2）
   * @returns 相关记忆列表（按 confidence 降序，最多 maxResults 条）
   */
  async findRelevantMemories(query: string, maxTokens: number = DEFAULT_MAX_TOKENS): Promise<Memory[]> {
    if (!query.trim()) return [];

    // 加载全部 L3 记忆
    const allMemories = await loadMemoryDir(this.memoryDir);
    if (allMemories.length === 0) return [];

    // 构造 LLM 评分请求
    const prompt = this.buildScoringPrompt(query, allMemories);
    const request: ChatRequest = {
      model: this.model ?? '',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      ],
      maxOutputTokens: maxTokens,
      temperature: 0,  // 召回应确定性
    };

    let responseText: string;
    try {
      if (!this.authenticated) {
        // M1 stub：用空 api_key 认证（provider 内部应支持 env 变量回退）
        const creds: Credentials = {
          type: 'api_key',
          apiKey: process.env.OMNIAGENT_LLM_API_KEY ?? '',
          providerId: this.provider.id,
        };
        const authResult = await this.provider.authenticate(creds);
        if (!authResult.success) {
          return [];  // 认证失败 → 跳过召回
        }
        this.authenticated = true;
      }

      const response = await this.provider.chat(request);
      responseText = this.extractText(response.message);
    } catch {
      // mod-07 §4.1：模型失败时跳过召回，对话继续不崩
      return [];
    }

    // 解析 LLM 响应 → 评分列表
    const scores = this.parseScoringResponse(responseText, allMemories);
    if (scores.length === 0) return [];

    // 过滤 + 排序 + 取 top K
    const filtered = scores
      .filter(s => s.confidence >= this.threshold)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.maxResults);

    // name → Memory 映射
    const byName = new Map(allMemories.map(m => [m.frontmatter.name, m] as const));
    const result: Memory[] = [];
    for (const s of filtered) {
      const mem = byName.get(s.name);
      if (mem) result.push(mem);
    }
    return result;
  }

  /** 构造 LLM 评分 prompt（让 LLM 对每个记忆打相关性分） */
  private buildScoringPrompt(query: string, memories: Memory[]): string {
    const lines = memories.map((m, i) => {
      return `${i + 1}. name: ${m.frontmatter.name}\n   description: ${m.frontmatter.description}`;
    });
    return [
      'You are a memory recall assistant. Given a user query and a list of memories,',
      'score each memory\'s relevance to the query on a scale of 0.0 to 1.0.',
      '',
      `User query: ${query}`,
      '',
      'Memories:',
      ...lines,
      '',
      'Respond with ONLY a JSON array, one entry per memory, in this exact format:',
      '[{"name":"<memory name>","confidence":<0.0-1.0>}]',
      '',
      'Rules:',
      '- Output ONLY the JSON array, no prose, no code fences.',
      '- Include every memory in the same order as listed.',
      '- confidence 0.0 = not relevant, 1.0 = highly relevant.',
    ].join('\n');
  }

  /** 解析 LLM 响应（JSON array） */
  private parseScoringResponse(text: string, memories: Memory[]): MemoryRelevanceScore[] {
    // 提取第一个 [ ... ] 块（容错：LLM 可能加前后 prose / code fence）
    const jsonMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!jsonMatch) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) return [];

    const validNames = new Set(memories.map(m => m.frontmatter.name));
    const scores: MemoryRelevanceScore[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const obj = item as { name?: unknown; confidence?: unknown };
      if (typeof obj.name !== 'string') continue;
      if (typeof obj.confidence !== 'number') continue;
      if (!validNames.has(obj.name)) continue;  // 过滤 LLM 臆造的 name
      const confidence = Math.max(0, Math.min(1, obj.confidence));
      scores.push({ name: obj.name, confidence });
    }
    return scores;
  }

  /** 从 Message 提取纯文本 */
  private extractText(message: Message): string {
    return message.content
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('');
  }
}

/** 默认导出：单例 recaller 延迟创建（首次调用时注入 provider） */
let _recaller: MemoryRecaller | undefined;

/** 设置全局 recaller（CLI 启动期注入 provider） */
export function setMemoryRecaller(recaller: MemoryRecaller): void {
  _recaller = recaller;
}

/** 获取全局 recaller（未设置抛错） */
export function getMemoryRecaller(): MemoryRecaller {
  if (!_recaller) {
    throw new Error('MemoryRecaller not initialized — call setMemoryRecaller first');
  }
  return _recaller;
}
