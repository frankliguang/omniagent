/**
 * Sidechain transcript persistence（L3-M5 §5.1 + L3-M7 §4.5.1 — M2 iter 1）
 *
 * Sidechain：fork/teammate/async 路径的子 agent 独立 transcript，与主 transcript 隔离。
 *
 * 设计要点：
 * - 文件路径：`{home}/.omniagent/transcript/{sessionId}.sidechain-{sidechainId}.jsonl`
 * - 独立 TranscriptStore 实例（独立 DrainWriteQueue / 独立 fsync）
 * - 独立 CompactBoundary（transcriptId 字段区分主 transcript vs sidechain）
 * - 链路完整性：sidechain 首条消息 parentUuid 指向主 transcript 的 fork point
 * - sidechain 独立压缩：压缩只影响 sidechain 自己的消息范围，不污染主 transcript
 *
 * M2 iter 1 范围：
 * - MemoryEngine 接口 + LocalMemoryEngine 实现
 * - SidechainManager（委托 MemoryEngine）
 * - sidechain path helper
 * - createSidechain / flushSidechain / readSidechain / appendSidechain
 * - 主 transcript getCurrentMessages（供 ForkAgentSpawner 读取 fork point）
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AgentId,
  Message,
  TaskId,
  UUID,
} from '../types/index.js';
import {
  TranscriptStore,
} from './transcript.js';
import {
  ensureTranscriptDir,
} from './drain-write-queue.js';

// ============================================================
// 路径 helper
// ============================================================

/**
 * 默认 sidechain transcript 路径
 *
 * 格式：`{home}/.omniagent/transcript/{sessionId}.sidechain-{sidechainId}.jsonl`
 *
 * 与主 transcript 同目录，文件名后缀 `.sidechain-{sidechainId}` 区分。
 */
export function defaultSidechainPath(sessionId: string, sidechainId: UUID): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return path.join(home, '.omniagent', 'transcript', `${sessionId}.sidechain-${sidechainId}.jsonl`);
}

/**
 * 生成新的 sidechain ID（基于 UUID v4）
 *
 * SidechainId 是 UUID 字符串，用作文件名后缀与 transcriptId 字段值。
 */
export function generateSidechainId(): UUID {
  return randomUUID() as UUID;
}

// ============================================================
// MemoryEngine 接口
// ============================================================

/**
 * 创建 sidechain 的参数
 *
 * @property parentUuid — fork point（主 transcript 中触发 fork 的消息 ID）
 * @property runtimeTaskId — 关联的 RuntimeTask ID（持久化关联，便于追溯）
 * @property initialMessages — sidechain 初始消息（已包含 placeholder tool_result，见 ForkAgentSpawner）
 */
export interface CreateSidechainParams {
  parentUuid: UUID;
  runtimeTaskId: TaskId;
  initialMessages?: Message[];
}

/** MemoryEngine：sidechain 生命周期管理接口（供 SidechainManager 委托） */
export interface MemoryEngine {
  /** 读取主 transcript 当前消息（ForkAgentSpawner 读取 fork point 用） */
  getCurrentMessages(agentId: AgentId): Promise<Message[]>;

  /** 创建 sidechain（写 initialMessages，返回 sidechainId） */
  createSidechain(params: CreateSidechainParams): Promise<UUID>;

  /** 追加消息到 sidechain */
  appendSidechain(sidechainId: UUID, msg: Message): Promise<void>;

  /** flush sidechain 写队列（resume / shutdown 前调用） */
  flushSidechain(sidechainId: UUID): Promise<void>;

  /** 读取 sidechain 全量消息（raw 视图） */
  readSidechain(sidechainId: UUID): Promise<Message[]>;

  /** 关闭 sidechain（释放写队列资源） */
  closeSidechain(sidechainId: UUID): Promise<void>;

  /** 关闭所有 sidechain（进程退出时） */
  closeAll(): Promise<void>;
}

// ============================================================
// LocalMemoryEngine：基于 TranscriptStore 的本地实现
// ============================================================

/**
 * LocalMemoryEngine：维护一个主 TranscriptStore 与多个 sidechain TranscriptStore
 *
 * 主 transcript 通过 sessionId 标识，sidechain 通过 sidechainId 标识。
 * 每个 sidechain 有独立的 TranscriptStore 实例（独立 DrainWriteQueue）。
 *
 * 并发安全：sidechains Map 的读写发生在 orchestrator 单线程中，
 * 多 agent 并发场景由 mod-05 CoordinatorMode 串行化（同一 sidechain 同时只被一个 ReActLoop 写）。
 */
export class LocalMemoryEngine implements MemoryEngine {
  private readonly sessionId: string;
  private readonly mainTranscript: TranscriptStore;
  private readonly sidechains: Map<UUID, TranscriptStore> = new Map();
  /** sidechainId → 关联信息（parentUuid / runtimeTaskId） */
  private readonly sidechainMeta: Map<UUID, { parentUuid: UUID; runtimeTaskId: TaskId }> = new Map();

  constructor(sessionId: string, mainTranscript: TranscriptStore) {
    this.sessionId = sessionId;
    this.mainTranscript = mainTranscript;
  }

  /** 读取主 transcript 当前消息（raw 视图） */
  async getCurrentMessages(_agentId: AgentId): Promise<Message[]> {
    return this.mainTranscript.readRaw();
  }

  /** 创建 sidechain */
  async createSidechain(params: CreateSidechainParams): Promise<UUID> {
    const sidechainId = generateSidechainId();
    const sidechainPath = defaultSidechainPath(this.sessionId, sidechainId);
    await ensureTranscriptDir(sidechainPath);
    const store = await TranscriptStore.load(sidechainPath);
    this.sidechains.set(sidechainId, store);
    this.sidechainMeta.set(sidechainId, {
      parentUuid: params.parentUuid,
      runtimeTaskId: params.runtimeTaskId,
    });

    // 写入 initialMessages（ForkAgentSpawner 已注入 placeholder tool_result）
    if (params.initialMessages && params.initialMessages.length > 0) {
      // 链路完整性：首条消息的 parentUuid 应指向主 transcript 的 fork point
      // ForkAgentSpawner 负责构造 initialMessages 时设置 parentUuid
      for (const msg of params.initialMessages) {
        await store.append(msg);
      }
    }
    return sidechainId;
  }

  /** 追加消息到 sidechain */
  async appendSidechain(sidechainId: UUID, msg: Message): Promise<void> {
    const store = this.sidechains.get(sidechainId);
    if (!store) {
      throw new Error(`sidechain not found: ${sidechainId}`);
    }
    await store.append(msg);
  }

  /** flush sidechain 写队列 */
  async flushSidechain(sidechainId: UUID): Promise<void> {
    const store = this.sidechains.get(sidechainId);
    if (!store) {
      throw new Error(`sidechain not found: ${sidechainId}`);
    }
    await store.flush();
  }

  /** 读取 sidechain 全量消息 */
  async readSidechain(sidechainId: UUID): Promise<Message[]> {
    const store = this.sidechains.get(sidechainId);
    if (!store) {
      throw new Error(`sidechain not found: ${sidechainId}`);
    }
    return store.readRaw();
  }

  /** 关闭 sidechain */
  async closeSidechain(sidechainId: UUID): Promise<void> {
    const store = this.sidechains.get(sidechainId);
    if (!store) return;
    await store.close();
    this.sidechains.delete(sidechainId);
    this.sidechainMeta.delete(sidechainId);
  }

  /** 关闭所有 sidechain */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.sidechains.keys());
    await Promise.all(ids.map(id => this.closeSidechain(id)));
  }

  /** 获取 sidechain 元信息（测试用） */
  getSidechainMeta(sidechainId: UUID): { parentUuid: UUID; runtimeTaskId: TaskId } | undefined {
    return this.sidechainMeta.get(sidechainId);
  }

  /** 当前活跃 sidechain 数量（测试用） */
  activeCount(): number {
    return this.sidechains.size;
  }

  /** 主 transcript（测试用，ForkAgentSpawner 也通过 getCurrentMessages 访问） */
  getMainTranscript(): TranscriptStore {
    return this.mainTranscript;
  }

  /** 主 sessionId */
  getSessionId(): string {
    return this.sessionId;
  }
}

// ============================================================
// SidechainManager：委托 MemoryEngine 的 facade
// ============================================================

/**
 * SidechainManager（L3-M5 §5.1）
 *
 * 委托 MemoryEngine 实现 sidechain 生命周期管理。
 * ForkAgentSpawner / CoordinatorMode 通过此 facade 操作 sidechain，
 * 不直接依赖具体 MemoryEngine 实现。
 */
export class SidechainManager {
  constructor(private readonly memoryEngine: MemoryEngine) {}

  /**
   * 创建 sidechain
   *
   * @param params.parentTranscriptId — 主 transcript 的 agent ID（用作 getCurrentMessages 的 key）
   * @param params.runtimeTaskId — 关联的 RuntimeTask ID
   * @param params.initialMessages — sidechain 初始消息（含 placeholder tool_result）
   * @returns sidechainId
   */
  async create(params: {
    parentTranscriptId: AgentId;
    runtimeTaskId: TaskId;
    initialMessages?: Message[];
  }): Promise<UUID> {
    // 读取 fork point（parentTranscriptId 当前最后一条消息的 id）
    const parentMessages = await this.memoryEngine.getCurrentMessages(params.parentTranscriptId);
    const lastMessage = parentMessages[parentMessages.length - 1];
    const parentUuid: UUID = lastMessage?.id ?? (params.parentTranscriptId as unknown as UUID);

    return this.memoryEngine.createSidechain({
      parentUuid,
      runtimeTaskId: params.runtimeTaskId,
      initialMessages: params.initialMessages,
    });
  }

  /** flush sidechain（sidechain 结束 ReAct Loop 后调用） */
  async flush(sidechainId: UUID): Promise<void> {
    await this.memoryEngine.flushSidechain(sidechainId);
  }

  /** 读取 sidechain 全量消息（持久化 / 旁路观测用） */
  async read(sidechainId: UUID): Promise<Message[]> {
    return this.memoryEngine.readSidechain(sidechainId);
  }

  /** 追加消息到 sidechain（ReActLoop 写入用） */
  async append(sidechainId: UUID, msg: Message): Promise<void> {
    await this.memoryEngine.appendSidechain(sidechainId, msg);
  }

  /** 关闭 sidechain（释放资源） */
  async close(sidechainId: UUID): Promise<void> {
    await this.memoryEngine.closeSidechain(sidechainId);
  }
}
