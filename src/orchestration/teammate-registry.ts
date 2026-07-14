/**
 * TeammateRegistry（L3-M5 §2.2.13 — M2 iter 2）
 *
 * 不变量 #2（teammate 按 name 寻址）：
 * - 集中维护 name → agentId 映射
 * - name 重复注册抛错（不覆盖）
 * - name 变更 assertNameStable() 报错，提示更新引用
 *
 * 内存表（不持久化）：
 * - mailbox 持久化保证 leader 重启后未读消息仍可达
 * - TeammateRegistry 在进程重启后由 ThreeStateRecovery 重建
 *   （根据未读 mailbox + sidechain 文件推断哪些 teammate 曾存在）
 *
 * M2 iter 2 范围：
 * - register / get / unregister / list / exists
 * - assertNameStable（name 变更检测）
 * - 不实现持久化（v2.x Daemon 模式跨进程共享时再加）
 */

import type {
  AgentId,
  ISO8601Timestamp,
  MailboxName,
} from '../types/index.js';

// ============================================================
// 类型
// ============================================================

export interface TeammateRecord {
  /** teammate 的 agentId（用于 sidechain / task tracking） */
  agentId: AgentId;
  /** 父 agent 的 agentId（leader） */
  parentAgentId: AgentId;
  /** 注册时间（ISO 8601） */
  registeredAt: ISO8601Timestamp;
  /** 上次 name 校验时的快照（assertNameStable 用） */
  lastKnownName?: MailboxName;
}

export interface RegisterTeammateParams {
  name: MailboxName;
  agentId: AgentId;
  parentAgentId: AgentId;
  /** 自定义注册时间（测试用，默认 now） */
  registeredAt?: ISO8601Timestamp;
}

export interface AssertNameStableParams {
  /** 当前的 name（registry 中查） */
  name: MailboxName;
  /** 期望的 agentId（调用方持有，用于交叉校验） */
  expectedAgentId: AgentId;
}

// ============================================================
// TeammateRegistry
// ============================================================

export class TeammateRegistry {
  /** name → record 映射（按 name 寻址） */
  private readonly registry = new Map<MailboxName, TeammateRecord>();
  /** agentId → name 反向索引（便于按 agentId 查找） */
  private readonly reverseIndex = new Map<AgentId, MailboxName>();

  /**
   * 注册 teammate
   *
   * 不变量 #2：name 重复注册抛错（不覆盖）
   * 不变量 #1（worktree 唯一归属）由 WorktreeRoster 守护
   */
  async register(params: RegisterTeammateParams): Promise<void> {
    if (this.registry.has(params.name)) {
      throw new Error(
        `teammate name "${params.name}" already registered (invariant #2: name uniquely identifies teammate)`,
      );
    }
    if (this.reverseIndex.has(params.agentId)) {
      throw new Error(
        `agentId "${params.agentId}" already registered as teammate "${this.reverseIndex.get(params.agentId)}"`,
      );
    }
    const record: TeammateRecord = {
      agentId: params.agentId,
      parentAgentId: params.parentAgentId,
      registeredAt: params.registeredAt ?? (new Date().toISOString() as ISO8601Timestamp),
      lastKnownName: params.name,
    };
    this.registry.set(params.name, record);
    this.reverseIndex.set(params.agentId, params.name);
  }

  /** 查询 teammate by name（不存在返回 undefined） */
  async get(name: MailboxName): Promise<TeammateRecord | undefined> {
    return this.registry.get(name);
  }

  /** 反向查询：by agentId */
  async getByAgentId(agentId: AgentId): Promise<TeammateRecord | undefined> {
    const name = this.reverseIndex.get(agentId);
    if (!name) return undefined;
    return this.registry.get(name);
  }

  /** 按 name 解析 agentId（便捷方法） */
  async resolve(name: MailboxName): Promise<AgentId | undefined> {
    return (await this.get(name))?.agentId;
  }

  /** 注销 teammate（shutdown 完成或 evicted 时调用） */
  async unregister(name: MailboxName): Promise<void> {
    const record = this.registry.get(name);
    if (record) {
      this.reverseIndex.delete(record.agentId);
    }
    this.registry.delete(name);
  }

  /** 列出全部 teammate（监控/调试用） */
  async list(): Promise<Array<{ name: MailboxName; record: TeammateRecord }>> {
    return Array.from(this.registry.entries()).map(([name, record]) => ({ name, record }));
  }

  /** name 是否已注册 */
  async exists(name: MailboxName): Promise<boolean> {
    return this.registry.has(name);
  }

  /** 当前注册数 */
  size(): number {
    return this.registry.size;
  }

  /**
   * 断言 name 稳定（不变量 #2：name 变更报错）
   *
   * 调用方持有 (name, expectedAgentId) 对，本方法校验：
   * 1. name 已注册
   * 2. name 对应的 agentId 与 expectedAgentId 一致
   * 3. record.lastKnownName 与当前 name 一致
   *
   * 任一不满足抛错，提示更新引用。
   */
  async assertNameStable(params: AssertNameStableParams): Promise<void> {
    const record = this.registry.get(params.name);
    if (!record) {
      throw new Error(
        `teammate name "${params.name}" not registered (invariant #2: name must be stable; check spelling or register first)`,
      );
    }
    if (record.agentId !== params.expectedAgentId) {
      throw new Error(
        `teammate name "${params.name}" maps to agentId ${record.agentId}, expected ${params.expectedAgentId} (invariant #2: name→agentId mapping must be stable)`,
      );
    }
    if (record.lastKnownName && record.lastKnownName !== params.name) {
      throw new Error(
        `teammate name changed from "${record.lastKnownName}" to "${params.name}" (invariant #2: name must be stable; update references)`,
      );
    }
  }

  /**
   * 重置 registry（测试 / shutdown 全部清理用）
   */
  clear(): void {
    this.registry.clear();
    this.reverseIndex.clear();
  }
}
