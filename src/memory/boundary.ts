/**
 * CompactBoundary + BoundaryStore（L3-M7 §3.8）
 *
 * CompactBoundary：压缩点元数据，记录 L1/L2/L3 压缩发生时的 message range 与 token 数。
 * BoundaryStore：boundary 元数据读写，支持 /rewind 查询最近的 boundary。
 *
 * 存储格式：~/.omniagent/transcript/{sessionId}.boundaries.jsonl（每行一个 boundary）
 *
 * M1 迭代 2 范围：
 * - boundary 元数据生成 + 持久化
 * - getLast / get / list 查询
 * - 不实现 /rewind 的消息还原（M3 完整版接入）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { BoundaryId, CompactBoundary, ISO8601Timestamp, UUID } from '../types/index.js';

// ============================================================
// 工厂函数
// ============================================================

/** 生成 BoundaryId（`{transcriptId-prefix}-{timestamp}-{uuid8}`） */
export function generateBoundaryId(transcriptId: UUID): BoundaryId {
  const ts = Date.now().toString(36);
  const rand = randomUUID().slice(0, 8);
  const prefix = transcriptId.slice(0, 8);
  return `${prefix}-${ts}-${rand}` as BoundaryId;
}

/** 当前 ISO 8601 时间戳 */
export function nowTimestamp(): ISO8601Timestamp {
  return new Date().toISOString() as ISO8601Timestamp;
}

// ============================================================
// BoundaryStore
// ============================================================

export interface BoundaryStoreOptions {
  /** boundary 元数据文件路径 */
  boundaryPath: string;
  /** 是否在内存中缓存（默认 true，提升读取性能） */
  cacheInMemory?: boolean;
}

export class BoundaryStore {
  private readonly boundaryPath: string;
  private cache: CompactBoundary[] | undefined;
  private readonly cacheInMemory: boolean;

  constructor(opts: BoundaryStoreOptions) {
    this.boundaryPath = opts.boundaryPath;
    this.cacheInMemory = opts.cacheInMemory ?? true;
  }

  /** 持久化一个 boundary（追加到 JSONL） */
  async append(boundary: CompactBoundary): Promise<void> {
    await fs.mkdir(path.dirname(this.boundaryPath), { recursive: true });
    const line = JSON.stringify(boundary) + '\n';
    await fs.appendFile(this.boundaryPath, line, { encoding: 'utf8' });
    if (this.cache) {
      this.cache.push(boundary);
    }
  }

  /** 获取最近的 boundary（/rewind 默认调用） */
  async getLast(transcriptId: UUID): Promise<CompactBoundary | undefined> {
    const all = await this.listByTranscript(transcriptId);
    if (all.length === 0) return undefined;
    return all[all.length - 1];
  }

  /** 根据 boundaryId 获取 boundary */
  async get(boundaryId: BoundaryId): Promise<CompactBoundary | undefined> {
    const all = await this.listAll();
    return all.find(b => b.boundary_id === boundaryId);
  }

  /** 列出某 transcript 的所有 boundary（按时间顺序） */
  async listByTranscript(transcriptId: UUID): Promise<CompactBoundary[]> {
    const all = await this.listAll();
    return all.filter(b => b.transcriptId === transcriptId);
  }

  /** 列出所有 boundary（按时间顺序） */
  async listAll(): Promise<CompactBoundary[]> {
    if (this.cache && this.cacheInMemory) {
      return [...this.cache];
    }
    let text: string;
    try {
      text = await fs.readFile(this.boundaryPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.cache = [];
        return [];
      }
      throw err;
    }
    const parsed = text
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as CompactBoundary);
    // 按 timestamp 升序
    parsed.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    this.cache = parsed;
    return [...parsed];
  }

  /** 清空 boundary 文件（测试用） */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.boundaryPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    this.cache = undefined;
  }

  /** 当前 boundary 总数 */
  async count(): Promise<number> {
    const all = await this.listAll();
    return all.length;
  }
}

// ============================================================
// 工厂函数 + 默认路径
// ============================================================

/** 默认 boundary 文件路径（~/.omniagent/transcript/{sessionId}.boundaries.jsonl） */
export function defaultBoundaryPath(sessionId: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return path.join(home, '.omniagent', 'transcript', `${sessionId}.boundaries.jsonl`);
}

/**
 * 工厂方法：创建并持久化一个 CompactBoundary
 *
 * @param transcriptId 所属 transcript ID
 * @param compactRange 压缩前的 message index 范围
 * @param tokensBefore 压缩前 token 数
 * @param tokensAfter 压缩后 token 数
 * @param triggerLayer 触发层级（L1_micro / L2_session / L3_api_summary）
 */
export function createBoundary(params: {
  transcriptId: UUID;
  compactRange: { start: number; end: number };
  tokensBefore: number;
  tokensAfter: number;
  triggerLayer: CompactBoundary['triggerLayer'];
}): CompactBoundary {
  return {
    boundary_id: generateBoundaryId(params.transcriptId),
    compactRange: params.compactRange,
    tokensBefore: params.tokensBefore,
    tokensAfter: params.tokensAfter,
    timestamp: nowTimestamp(),
    transcriptId: params.transcriptId,
    triggerLayer: params.triggerLayer,
  };
}
