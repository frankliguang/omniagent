import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderRegistry } from '../../src/providers/registry.js';
import { CredentialsStore, FileKeychainBackend } from '../../src/providers/credentials.js';
import { OpenAIProvider } from '../../src/providers/openai.js';
import type { Capabilities, LLMProvider } from '../../src/types/index.js';
import os from 'node:os';
import path from 'node:path';

function tmpPath(name: string): string {
  return path.join(os.tmpdir(), `omniagent-registry-${name}-${Date.now()}.json`);
}

function makeMockProvider(id: string, caps: Partial<Capabilities>): LLMProvider {
  const fullCaps: Capabilities = {
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsPromptCaching: false,
    supportsMultiModal: false,
    supportsRiskClassification: false,
    maxContextWindow: 128_000,
    maxOutputTokens: 4_096,
    tokenCountAccuracy: 'estimated',
    ...caps,
  };
  return {
    id,
    displayName: id,
    capabilities: fullCaps,
    async authenticate() { return { success: true, providerId: id }; },
    async *chatStream() { yield { type: 'text_delta', text: 'stub' }; },
    async chat() { throw new Error('not implemented'); },
    async countTokens() { return { inputTokens: 0, outputTokens: 0, accuracy: 'estimated' }; },
    estimateCost() { return { usd: 0 }; },
  };
}

test('ProviderRegistry.create: 默认注册 OpenAIProvider', () => {
  const registry = ProviderRegistry.create(
    new CredentialsStore(new FileKeychainBackend(tmpPath('create'))),
  );
  const providers = registry.list();
  assert.ok(providers.some(p => p.id === 'openai'));
});

test('ProviderRegistry.register + get: 正常查找', () => {
  const registry = new ProviderRegistry(new CredentialsStore(new FileKeychainBackend(tmpPath('reg'))));
  const p = makeMockProvider('test', {});
  registry.register(p);
  assert.equal(registry.get('test'), p);
});

test('ProviderRegistry.get: 未注册抛错', () => {
  const registry = new ProviderRegistry(new CredentialsStore(new FileKeychainBackend(tmpPath('miss'))));
  assert.throws(() => registry.get('nonexistent'), /not found/);
});

test('ProviderRegistry.find: 未注册返回 undefined', () => {
  const registry = new ProviderRegistry(new CredentialsStore(new FileKeychainBackend(tmpPath('find'))));
  assert.equal(registry.find('nonexistent'), undefined);
});

test('ProviderRegistry.register: 重复注册抛错', () => {
  const registry = new ProviderRegistry(new CredentialsStore(new FileKeychainBackend(tmpPath('dup'))));
  registry.register(makeMockProvider('test', {}));
  assert.throws(
    () => registry.register(makeMockProvider('test', {})),
    /already registered/,
  );
});

test('ProviderRegistry.listByCapability: 按 supportsStreaming 筛选', () => {
  const registry = new ProviderRegistry(new CredentialsStore(new FileKeychainBackend(tmpPath('cap'))));
  registry.register(makeMockProvider('a', { supportsStreaming: true }));
  registry.register(makeMockProvider('b', { supportsStreaming: false }));
  const streaming = registry.listByCapability('supportsStreaming');
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0].id, 'a');
});

test('ProviderRegistry.listByCapability: 按 supportsRiskClassification 筛选', () => {
  const registry = new ProviderRegistry(new CredentialsStore(new FileKeychainBackend(tmpPath('risk'))));
  registry.register(makeMockProvider('openai', { supportsRiskClassification: false }));
  registry.register(makeMockProvider('haiku', { supportsRiskClassification: true }));
  const classifiers = registry.listByCapability('supportsRiskClassification');
  assert.equal(classifiers.length, 1);
  assert.equal(classifiers[0].id, 'haiku');
});

test('ProviderRegistry.getRiskClassifierProvider: 返回首个 risk classifier', () => {
  const registry = new ProviderRegistry(new CredentialsStore(new FileKeychainBackend(tmpPath('rc'))));
  registry.register(makeMockProvider('openai', { supportsRiskClassification: false }));
  registry.register(makeMockProvider('haiku', { supportsRiskClassification: true }));
  const p = registry.getRiskClassifierProvider();
  assert.ok(p);
  assert.equal(p.id, 'haiku');
});

test('ProviderRegistry.getRiskClassifierProvider: 无返回 undefined', () => {
  const registry = new ProviderRegistry(new CredentialsStore(new FileKeychainBackend(tmpPath('rc-none'))));
  registry.register(makeMockProvider('openai', { supportsRiskClassification: false }));
  assert.equal(registry.getRiskClassifierProvider(), undefined);
});

test('ProviderRegistry.getCredentialsStore: 返回注入的 store', () => {
  const store = new CredentialsStore(new FileKeychainBackend(tmpPath('store')));
  const registry = new ProviderRegistry(store);
  assert.equal(registry.getCredentialsStore(), store);
});

test('ProviderRegistry: 注册真实 OpenAIProvider 可工作', () => {
  const registry = new ProviderRegistry(new CredentialsStore(new FileKeychainBackend(tmpPath('real'))));
  registry.register(new OpenAIProvider());
  const p = registry.get('openai');
  assert.equal(p.id, 'openai');
  assert.equal(p.displayName, 'OpenAI');
  assert.equal(p.capabilities.supportsStreaming, true);
});
