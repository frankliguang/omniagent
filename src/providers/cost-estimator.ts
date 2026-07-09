/**
 * CostEstimator（L3-M1 §2.2.5 + §3.6）
 *
 * 成本估算：根据 provider + model + token usage 计算 USD 成本。
 *
 * 价格表设计：
 *  - key 格式：`{providerId}/{model}` 或 `{providerId}`（fallback）
 *  - value：`{ inputPerMillion, outputPerMillion, cacheReadPerMillion?, cacheCreationPerMillion? }`
 *  - Anthropic 有 prompt cache：cache read 90% off, cache creation 25% extra
 *  - Ollama 本地推理：0 成本
 *
 * M1 迭代 2 范围：
 *  - 完整价格表（OpenAI / Anthropic / Ollama）
 *  - cache token 折扣计算
 *  - breakdown（input/output/cache 分项）
 *  - Bedrock stub（M1 迭代 3 接入 BedrockProvider 时补全）
 */

import type { CostEstimate, TokenUsage } from '../types/index.js';

// ============================================================
// 类型
// ============================================================

export interface PriceEntry {
  /** 输入 token 每百万 USD */
  inputPerMillion: number;
  /** 输出 token 每百万 USD */
  outputPerMillion: number;
  /** 缓存读取 token 每百万 USD（默认 0.1 × inputPerMillion） */
  cacheReadPerMillion?: number;
  /** 缓存创建 token 每百万 USD（默认 1.25 × inputPerMillion） */
  cacheCreationPerMillion?: number;
}

export interface CostBreakdown {
  /** 输入 token 成本 */
  inputCost: number;
  /** 输出 token 成本 */
  outputCost: number;
  /** 缓存读取 token 成本（折扣后） */
  cacheReadCost: number;
  /** 缓存创建 token 成本（额外） */
  cacheCreationCost: number;
  /** 总成本 */
  total: number;
}

export interface CostEstimateDetailed extends CostEstimate {
  /** 分项成本（仅当 basis 存在时） */
  breakdown?: CostBreakdown;
}

// ============================================================
// 价格表
// ============================================================

const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;   // 缓存读取 = 10% 原价（90% off）
const DEFAULT_CACHE_CREATION_MULTIPLIER = 1.25;  // 缓存创建 = 125% 原价（25% extra）

/**
 * 内置价格表（每百万 token，USD）
 *
 * 数据源：provider 官网 2026-07 公开价目表
 * 更新策略：每月 1 号由 scripts/update-price-table.ts 自动同步
 */
const BUILTIN_PRICES: Record<string, PriceEntry> = {
  // OpenAI
  'openai/gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'openai/gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'openai/gpt-4-turbo': { inputPerMillion: 10, outputPerMillion: 30 },
  'openai/gpt-4': { inputPerMillion: 30, outputPerMillion: 60 },
  'openai/gpt-3.5-turbo': { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  'openai/o1': { inputPerMillion: 15, outputPerMillion: 60 },
  'openai/o1-mini': { inputPerMillion: 3, outputPerMillion: 12 },
  'openai/o3-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  // OpenAI fallback（未指定 model 时）
  'openai': { inputPerMillion: 2.5, outputPerMillion: 10 },

  // Anthropic（含 prompt cache 价格）
  'anthropic/claude-sonnet-4-5': {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,        // 10% of 3
    cacheCreationPerMillion: 3.75,   // 125% of 3
  },
  'anthropic/claude-haiku-4-5': {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cacheReadPerMillion: 0.08,
    cacheCreationPerMillion: 1,
  },
  'anthropic/claude-opus-4-7': {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheCreationPerMillion: 18.75,
  },
  'anthropic/claude-3-5-sonnet': {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
  },
  'anthropic/claude-3-opus': {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheCreationPerMillion: 18.75,
  },
  'anthropic/claude-3-haiku': {
    inputPerMillion: 0.25,
    outputPerMillion: 1.25,
    cacheReadPerMillion: 0.025,
    cacheCreationPerMillion: 0.3125,
  },
  'anthropic': {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
  },

  // Ollama（本地推理 0 成本）
  'ollama/llama3': { inputPerMillion: 0, outputPerMillion: 0 },
  'ollama/llama3.1': { inputPerMillion: 0, outputPerMillion: 0 },
  'ollama/llama3.2': { inputPerMillion: 0, outputPerMillion: 0 },
  'ollama/mistral': { inputPerMillion: 0, outputPerMillion: 0 },
  'ollama/qwen2.5': { inputPerMillion: 0, outputPerMillion: 0 },
  'ollama': { inputPerMillion: 0, outputPerMillion: 0 },

  // Bedrock（M1 迭代 3 接入，与 Anthropic Claude 同价，含 prompt cache）
  'bedrock/anthropic.claude-3-5-sonnet': {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
  },
  'bedrock/anthropic.claude-3-haiku': {
    inputPerMillion: 0.25,
    outputPerMillion: 1.25,
    cacheReadPerMillion: 0.025,
    cacheCreationPerMillion: 0.3125,
  },
  'bedrock/anthropic.claude-3-opus': {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheCreationPerMillion: 18.75,
  },
  'bedrock': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
};

// ============================================================
// CostEstimator 类
// ============================================================

export class CostEstimator {
  private static readonly customPrices: Record<string, PriceEntry> = {};
  private static readonly aliases: Record<string, string> = {
    // OpenAI 别名
    'gpt-4-0613': 'openai/gpt-4',
    'gpt-4-turbo-preview': 'openai/gpt-4-turbo',
    'gpt-4-turbo-2024-04-09': 'openai/gpt-4-turbo',
    // Anthropic 别名
    'claude-3-5-sonnet-20241022': 'anthropic/claude-3-5-sonnet',
    'claude-3-sonnet': 'anthropic/claude-3-5-sonnet',
    // Ollama 别名
    'llama3.1:8b': 'ollama/llama3.1',
    'llama3.1:70b': 'ollama/llama3.1',
    // Bedrock 别名（model id → 价格 key）
    'anthropic.claude-3-5-sonnet-20241022-v1:0': 'bedrock/anthropic.claude-3-5-sonnet',
    'anthropic.claude-3-haiku-20240307-v1:0': 'bedrock/anthropic.claude-3-haiku',
    'anthropic.claude-3-opus-20240229-v1:0': 'bedrock/anthropic.claude-3-opus',
  };

  /** 注册自定义价格（覆盖内置） */
  static registerPrice(key: string, price: PriceEntry): void {
    this.customPrices[key] = price;
  }

  /** 注册模型别名 */
  static registerAlias(alias: string, canonical: string): void {
    this.aliases[alias] = canonical;
  }

  /** 查询价格（自定义 → 内置 → fallback） */
  static lookupPrice(providerId: string, model?: string): PriceEntry | undefined {
    const keys = this.buildLookupKeys(providerId, model);
    for (const key of keys) {
      const entry = this.customPrices[key] ?? BUILTIN_PRICES[key];
      if (entry) return entry;
    }
    return undefined;
  }

  /** 估算成本（详细） */
  static estimateDetailed(
    providerId: string,
    usage: TokenUsage,
    model?: string,
  ): CostEstimateDetailed {
    const price = this.lookupPrice(providerId, model);
    if (!price) {
      return { usd: 0 };
    }

    const inputCost = (usage.inputTokens / 1_000_000) * price.inputPerMillion;
    const outputCost = (usage.outputTokens / 1_000_000) * price.outputPerMillion;

    const cacheReadPrice = price.cacheReadPerMillion ?? price.inputPerMillion * DEFAULT_CACHE_READ_MULTIPLIER;
    const cacheCreationPrice = price.cacheCreationPerMillion ?? price.inputPerMillion * DEFAULT_CACHE_CREATION_MULTIPLIER;

    const cacheReadCost = ((usage.cacheReadTokens ?? 0) / 1_000_000) * cacheReadPrice;
    const cacheCreationCost = ((usage.cacheCreationTokens ?? 0) / 1_000_000) * cacheCreationPrice;

    const total = inputCost + outputCost + cacheReadCost + cacheCreationCost;

    return {
      usd: total,
      basis: {
        inputPerMillion: price.inputPerMillion,
        outputPerMillion: price.outputPerMillion,
      },
      breakdown: {
        inputCost,
        outputCost,
        cacheReadCost,
        cacheCreationCost,
        total,
      },
    };
  }

  /** 估算成本（简化，与 LLMProvider.estimateCost 签名兼容） */
  static estimate(providerId: string, usage: TokenUsage, model?: string): CostEstimate {
    const detailed = this.estimateDetailed(providerId, usage, model);
    return {
      usd: detailed.usd,
      basis: detailed.basis,
    };
  }

  /** 列出所有已知价格 key（用于调试 / 自检） */
  static listKnownKeys(): string[] {
    return [...new Set([...Object.keys(BUILTIN_PRICES), ...Object.keys(this.customPrices)])].sort();
  }

  /** 构建查询 key 优先级列表：`{provider}/{model}` → 别名展开 → `{provider}` */
  private static buildLookupKeys(providerId: string, model?: string): string[] {
    const keys: string[] = [];
    if (model) {
      // 1. 直接 key：provider/model
      keys.push(`${providerId}/${model}`);
      // 2. 别名展开
      const alias = this.aliases[model];
      if (alias) {
        keys.push(alias);
      }
      // 3. 去 provider 前缀的 model 名（如 "gpt-4o" → "openai/gpt-4o"）
      keys.push(`${providerId}/${model.split('-')[0]}`);
    }
    // 4. provider fallback
    keys.push(providerId);
    return keys;
  }
}

// ============================================================
// 单例 / 工厂
// ============================================================

export const costEstimator = CostEstimator;
