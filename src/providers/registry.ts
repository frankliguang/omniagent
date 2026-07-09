/**
 * ProviderRegistry（L3-M1 §2.2.2）
 *
 * provider 注册与查找中心。
 * 启动期注册所有已配置的 provider，运行期通过 id 或 capability 查找。
 */

import type { Capabilities, LLMProvider } from '../types/index.js';

import { CredentialsStore } from './credentials.js';
import { AnthropicProvider } from './anthropic.js';
import { BedrockProvider } from './bedrock.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  constructor(private readonly credentialsStore: CredentialsStore) {}

  /** 创建默认 registry 并注册 M1 全部 provider */
  static create(credentialsStore?: CredentialsStore): ProviderRegistry {
    const store = credentialsStore ?? new CredentialsStore();
    const registry = new ProviderRegistry(store);
    // M1：OpenAI + Anthropic + Bedrock + Ollama
    registry.register(new OpenAIProvider());
    registry.register(new AnthropicProvider());
    registry.register(new BedrockProvider());
    registry.register(new OllamaProvider());
    return registry;
  }

  /** 启动期注册 provider */
  register(provider: LLMProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`ProviderRegistry: provider ${provider.id} already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /** 查找 provider，未注册抛错 */
  get(id: string): LLMProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`ProviderRegistry: provider ${id} not found`);
    }
    return provider;
  }

  /** 查找 provider，未注册返回 undefined（不抛错） */
  find(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /** 全量列表 */
  list(): LLMProvider[] {
    return [...this.providers.values()];
  }

  /** 按 capability 筛选 */
  listByCapability<K extends keyof Capabilities>(cap: K, value: Capabilities[K] = true as Capabilities[K]): LLMProvider[] {
    return this.list().filter(p => p.capabilities[cap] === value);
  }

  /** Risk Classifier 选型（M4 调用，L3-M1 §2.2.2） */
  getRiskClassifierProvider(): LLMProvider | undefined {
    return this.listByCapability('supportsRiskClassification')[0];
  }

  /** 获取 CredentialsStore（provider 认证用） */
  getCredentialsStore(): CredentialsStore {
    return this.credentialsStore;
  }
}
