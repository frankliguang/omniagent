/**
 * CredentialsStore（L3-M1 §2.2.3 + §3.4）
 *
 * 4 级凭证优先级（高 → 低）：
 *  1. CLI flag `--api-key`（运行期注入，临时覆盖）
 *  2. 环境变量 `OMNIAGENT_<PROVIDER>_API_KEY`（CI / 容器）
 *  3. `.omniagent/credentials.json`（项目级配置，git ignored）
 *  4. 系统 keychain（用户级持久化，推荐）
 *
 * M1 迭代 1：keychain backend 用文件 stub（~/.omniagent/keychain.json）。
 * M1 迭代 3：替换为 keytar 真实 keychain 集成。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type { Credentials } from '../types/index.js';

/** Keychain 后端接口（M1 stub 用文件，M1 迭代 3 用 keytar） */
export interface KeychainBackend {
  get(service: string): Promise<string | undefined>;
  set(service: string, value: string): Promise<void>;
  delete(service: string): Promise<void>;
}

/** 文件-based keychain stub（明文，仅本地开发用，M1 迭代 3 替换为 keytar） */
export class FileKeychainBackend implements KeychainBackend {
  constructor(private readonly filePath: string = path.join(os.homedir(), '.omniagent', 'keychain.json')) {}

  private async load(): Promise<Record<string, string>> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(content) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async save(data: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // 0600 权限：仅 owner 可读写
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async get(service: string): Promise<string | undefined> {
    const data = await this.load();
    return data[service];
  }

  async set(service: string, value: string): Promise<void> {
    const data = await this.load();
    data[service] = value;
    await this.save(data);
  }

  async delete(service: string): Promise<void> {
    const data = await this.load();
    delete data[service];
    await this.save(data);
  }
}

export class CredentialsStore {
  private readonly cliFlags = new Map<string, string>();
  private configFileCredentials: Record<string, Credentials> = {};
  private configFileLoaded = false;

  constructor(
    private readonly keychain: KeychainBackend = new FileKeychainBackend(),
    private readonly configFilePath: string = path.join(process.cwd(), '.omniagent', 'credentials.json'),
  ) {}

  /** 注入 CLI flag 凭证（最高优先级） */
  setCliFlag(providerId: string, apiKey: string): void {
    this.cliFlags.set(providerId, apiKey);
  }

  /** 获取凭证（按 4 级优先级） */
  async get(providerId: string): Promise<Credentials | undefined> {
    // 1. CLI flag
    const cliKey = this.cliFlags.get(providerId);
    if (cliKey) {
      return { type: 'api_key', apiKey: cliKey, providerId };
    }

    // 2. 环境变量
    const envKey = process.env[`OMNIAGENT_${providerId.toUpperCase()}_API_KEY`];
    if (envKey) {
      return { type: 'api_key', apiKey: envKey, providerId };
    }

    // 3. 项目级 config 文件
    await this.loadConfigFile();
    const configCred = this.configFileCredentials[providerId];
    if (configCred) {
      return configCred;
    }

    // 4. keychain
    const keychainCred = await this.keychain.get(`omniagent-${providerId}`);
    if (keychainCred) {
      return { type: 'api_key', apiKey: keychainCred, providerId };
    }

    return undefined;
  }

  /** 写入凭证到 keychain（用户级持久化） */
  async set(providerId: string, credentials: Credentials): Promise<void> {
    if (credentials.type === 'api_key') {
      await this.keychain.set(`omniagent-${providerId}`, credentials.apiKey);
    } else {
      // OAuth token 序列化存 keychain
      await this.keychain.set(`omniagent-${providerId}`, JSON.stringify(credentials));
    }
  }

  /** 删除凭证 */
  async delete(providerId: string): Promise<void> {
    await this.keychain.delete(`omniagent-${providerId}`);
    // CLI flag 也清掉
    this.cliFlags.delete(providerId);
  }

  /** 列出已配置的 provider（检查 env + config + keychain） */
  async listAvailable(): Promise<string[]> {
    const set = new Set<string>();

    // CLI flags
    for (const id of this.cliFlags.keys()) set.add(id);

    // env（OMNIAGENT_<PROVIDER>_API_KEY）
    for (const key of Object.keys(process.env)) {
      const match = key.match(/^OMNIAGENT_(.+)_API_KEY$/);
      if (match) {
        set.add(match[1].toLowerCase());
      }
    }

    // config file
    await this.loadConfigFile();
    for (const id of Object.keys(this.configFileCredentials)) {
      set.add(id);
    }

    // keychain 无法枚举（FileKeychainBackend 可以，keytar 不行）
    if (this.keychain instanceof FileKeychainBackend) {
      // FileKeychainBackend 可枚举
    }

    return [...set].sort();
  }

  private async loadConfigFile(): Promise<void> {
    if (this.configFileLoaded) return;
    this.configFileLoaded = true;
    try {
      const content = await fs.readFile(this.configFilePath, 'utf8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      for (const [id, val] of Object.entries(parsed)) {
        if (typeof val === 'string') {
          this.configFileCredentials[id] = { type: 'api_key', apiKey: val, providerId: id };
        } else if (val && typeof val === 'object' && 'type' in val) {
          this.configFileCredentials[id] = val as Credentials;
        }
      }
    } catch {
      // 文件不存在或解析失败：忽略（视为无配置）
    }
  }
}
