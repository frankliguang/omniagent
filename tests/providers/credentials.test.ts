import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { CredentialsStore, FileKeychainBackend } from '../../src/providers/credentials.js';

/** 临时 keychain 文件，每个测试独立 */
function tmpKeychainPath(testName: string): string {
  return path.join(os.tmpdir(), `omniagent-test-${testName}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('CredentialsStore: CLI flag 最高优先级', async () => {
  // 同时设 env + CLI flag，CLI flag 应胜出
  process.env.OMNIAGENT_OPENAI_API_KEY = 'env-key';
  const keychain = new FileKeychainBackend(tmpKeychainPath('cli-flag'));
  await keychain.set('omniagent-openai', 'keychain-key');
  const store = new CredentialsStore(keychain);
  store.setCliFlag('openai', 'cli-key');

  const cred = await store.get('openai');
  assert.equal(cred?.type, 'api_key');
  assert.equal(cred?.apiKey, 'cli-key');

  delete process.env.OMNIAGENT_OPENAI_API_KEY;
});

test('CredentialsStore: 环境变量次优先', async () => {
  process.env.OMNIAGENT_OPENAI_API_KEY = 'env-key';
  const keychain = new FileKeychainBackend(tmpKeychainPath('env'));
  await keychain.set('omniagent-openai', 'keychain-key');
  const store = new CredentialsStore(keychain);

  const cred = await store.get('openai');
  assert.equal(cred?.apiKey, 'env-key');

  delete process.env.OMNIAGENT_OPENAI_API_KEY;
});

test('CredentialsStore: config 文件第三优先', async () => {
  delete process.env.OMNIAGENT_OPENAI_API_KEY;
  const tmpPath = tmpKeychainPath('config');
  const keychain = new FileKeychainBackend(tmpPath);
  await keychain.set('omniagent-openai', 'keychain-key');

  // 写 config 文件
  const configPath = path.join(os.tmpdir(), `omniagent-config-${Date.now()}.json`);
  const { promises: fs } = await import('node:fs');
  await fs.writeFile(configPath, JSON.stringify({ openai: 'config-key' }));

  const store = new CredentialsStore(keychain, configPath);
  const cred = await store.get('openai');
  assert.equal(cred?.apiKey, 'config-key');

  await fs.unlink(configPath);
});

test('CredentialsStore: keychain 最后兜底', async () => {
  delete process.env.OMNIAGENT_OPENAI_API_KEY;
  const tmpPath = tmpKeychainPath('keychain-only');
  const keychain = new FileKeychainBackend(tmpPath);
  await keychain.set('omniagent-openai', 'keychain-key');

  const store = new CredentialsStore(keychain, '/nonexistent/config.json');
  const cred = await store.get('openai');
  assert.equal(cred?.apiKey, 'keychain-key');
});

test('CredentialsStore: 未配置返回 undefined', async () => {
  delete process.env.OMNIAGENT_UNKNOWN_PROVIDER_API_KEY;
  const store = new CredentialsStore(
    new FileKeychainBackend(tmpKeychainPath('none')),
    '/nonexistent/config.json',
  );
  const cred = await store.get('unknown-provider');
  assert.equal(cred, undefined);
});

test('CredentialsStore: set/get/delete keychain 流转', async () => {
  const keychain = new FileKeychainBackend(tmpKeychainPath('set-get-del'));
  const store = new CredentialsStore(keychain, '/nonexistent/config.json');

  await store.set('openai', { type: 'api_key', apiKey: 'stored-key', providerId: 'openai' });
  const got = await store.get('openai');
  assert.equal(got?.apiKey, 'stored-key');

  await store.delete('openai');
  const after = await store.get('openai');
  assert.equal(after, undefined);
});

test('CredentialsStore: listAvailable 列出已配置 provider', async () => {
  process.env.OMNIAGENT_OPENAI_API_KEY = 'env-key';
  process.env.OMNIAGENT_ANTHROPIC_API_KEY = 'env-key-2';
  const store = new CredentialsStore(
    new FileKeychainBackend(tmpKeychainPath('list')),
    '/nonexistent/config.json',
  );
  store.setCliFlag('ollama', 'cli-key');

  const list = await store.listAvailable();
  assert.ok(list.includes('openai'));
  assert.ok(list.includes('anthropic'));
  assert.ok(list.includes('ollama'));

  delete process.env.OMNIAGENT_OPENAI_API_KEY;
  delete process.env.OMNIAGENT_ANTHROPIC_API_KEY;
});

test('FileKeychainBackend: 文件权限 0600', async () => {
  const tmpPath = tmpKeychainPath('perm');
  const keychain = new FileKeychainBackend(tmpPath);
  await keychain.set('omniagent-test', 'value');

  const { promises: fs } = await import('node:fs');
  const stat = await fs.stat(tmpPath);
  // 0o100600 = regular file + 0600
  const mode = stat.mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('FileKeychainBackend: 持久化（新实例读取）', async () => {
  const tmpPath = tmpKeychainPath('persist');
  const k1 = new FileKeychainBackend(tmpPath);
  await k1.set('omniagent-x', 'value1');

  // 新实例读同一文件
  const k2 = new FileKeychainBackend(tmpPath);
  const got = await k2.get('omniagent-x');
  assert.equal(got, 'value1');
});
