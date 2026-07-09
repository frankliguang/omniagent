/**
 * ResumeService（L3-M7 §2.2.7 — `--resume <sessionId>` 恢复）
 *
 * 进程启动时恢复已有会话：
 * 1. 加载 transcript 文件（TranscriptStore）
 * 2. walkChainBeforeParse 校验 uuid/parentUuid 链路完整性
 *    - 断链 → SCENARIO_TRANSCRIPT_CORRUPT / SCENARIO_FORK_METADATA_MISSING
 * 3. mode 字段校验（SCENARIO_MODE_MISMATCH）
 *    - 存的 mode 与当前启动 mode 不一致 → 需用户确认
 * 4. CompactBoundary 还原（回到最近压缩点）
 * 5. 重建权限规则 / 工具池 / memory（M1 stub：返回 transcript + boundary）
 *
 * M1 迭代 2 范围：
 * - resume() 主入口
 * - walkChainBeforeParse 集成
 * - mode 字段校验（session metadata 文件 ~/.omniagent/transcript/{sessionId}.meta.json）
 * - CompactBoundary 还原
 * - 不实现 9 场景完整恢复（M3 接入 RecoveryHandler）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  CompactBoundary,
  PermissionMode,
  SessionId,
  UUID,
} from '../types/index.js';
import { BoundaryStore, defaultBoundaryPath } from './boundary.js';
import { defaultTranscriptPath } from './drain-write-queue.js';
import { TranscriptStore } from './transcript.js';

// ============================================================
// 类型
// ============================================================

/** resume 失败场景（对应 mod-07 §4.5.3 9 场景中的 3 个） */
export type ResumeFailureScenario =
  | 'SCENARIO_TRANSCRIPT_CORRUPT'
  | 'SCENARIO_FORK_METADATA_MISSING'
  | 'SCENARIO_MODE_MISMATCH'
  | 'SCENARIO_TRANSCRIPT_NOT_FOUND';

/** resume 结果 */
export interface ResumeResult {
  /** 是否成功 */
  ok: boolean;
  /** 失败场景（ok=false 时） */
  scenario?: ResumeFailureScenario;
  /** 错误详情（ok=false 时） */
  detail?: string;
  /** 是否需用户确认（mode mismatch 等） */
  needsUserConfirm?: boolean;
  /** 恢复后的会话句柄（ok=true 时） */
  session?: ResumedSession;
}

/** 恢复后的会话句柄 */
export interface ResumedSession {
  /** transcript 读写句柄 */
  transcript: TranscriptStore;
  /** 最近的 CompactBoundary（可能为 undefined，无压缩历史） */
  lastBoundary?: CompactBoundary;
  /** transcript 中恢复的消息（按 uuid/parentUuid 顺序） */
  messages: import('../types/index.js').Message[];
  /** 存的 PermissionMode（与 expectedMode 一致） */
  mode: PermissionMode;
  /** sessionId */
  sessionId: SessionId;
}

/** 会话元数据（持久化到 {sessionId}.meta.json） */
export interface SessionMetadata {
  sessionId: SessionId;
  /** 创建时的 PermissionMode */
  permissionMode: PermissionMode;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** provider 名称（mod-01） */
  provider?: string;
  /** 模型名称 */
  model?: string;
}

// ============================================================
// ResumeService
// ============================================================

export interface ResumeServiceOptions {
  /** transcript 根目录（默认 ~/.omniagent/transcript） */
  transcriptDir?: string;
  /** BoundaryStore（可选，外部注入便于测试） */
  boundaryStore?: BoundaryStore;
}

export class ResumeService {
  private readonly transcriptDir: string;
  private readonly boundaryStore?: BoundaryStore;

  constructor(opts: ResumeServiceOptions = {}) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
    this.transcriptDir = opts.transcriptDir ?? path.join(home, '.omniagent', 'transcript');
    this.boundaryStore = opts.boundaryStore;
  }

  /**
   * 启动入口：恢复已有会话
   *
   * 流程（L3-M7 §2.2.7）：
   * 1. 加载 transcript 文件
   * 2. walkChainBeforeParse 校验链路
   * 3. mode 字段校验
   * 4. CompactBoundary 还原
   * 5. 返回 ResumedSession
   */
  async resume(sessionId: SessionId, expectedMode: PermissionMode): Promise<ResumeResult> {
    // 1. 检查 transcript 文件存在
    const transcriptPath = this.transcriptPath(sessionId);
    try {
      await fs.access(transcriptPath);
    } catch {
      return {
        ok: false,
        scenario: 'SCENARIO_TRANSCRIPT_NOT_FOUND',
        detail: `transcript file not found: ${transcriptPath}`,
      };
    }

    // 2. 加载 transcript
    const transcript = await TranscriptStore.load(transcriptPath);

    // 3. walkChainBeforeParse 校验链路完整性
    const chainCheck = await transcript.walkChainBeforeParse();
    if (!chainCheck.ok) {
      await transcript.close();
      return {
        ok: false,
        scenario: chainCheck.scenario as ResumeFailureScenario | undefined,
        detail: chainCheck.detail,
      };
    }

    // 4. mode 字段校验（场景 9：SCENARIO_MODE_MISMATCH）
    const storedMeta = await this.readStoredMode(sessionId);
    if (!storedMeta) {
      // 元数据缺失 → 视为新会话，接受 expectedMode
      // 不阻塞 resume，但记日志
    } else if (storedMeta.permissionMode !== expectedMode) {
      await transcript.close();
      return {
        ok: false,
        scenario: 'SCENARIO_MODE_MISMATCH',
        detail: `stored mode=${storedMeta.permissionMode} expected=${expectedMode}`,
        needsUserConfirm: true,
      };
    }

    // 5. CompactBoundary 还原（最近压缩点）
    const lastBoundary = await this.fetchLastBoundary(sessionId);

    // 6. 读取恢复的消息
    const messages = await transcript.readRaw();

    // 7. 返回 ResumedSession
    const mode = storedMeta?.permissionMode ?? expectedMode;
    return {
      ok: true,
      session: {
        transcript,
        lastBoundary,
        messages,
        mode,
        sessionId,
      },
    };
  }

  /**
   * 写入会话元数据（创建会话时调用）
   * 路径：{transcriptDir}/{sessionId}.meta.json
   */
  async writeSessionMetadata(meta: SessionMetadata): Promise<void> {
    await fs.mkdir(this.transcriptDir, { recursive: true });
    const metaPath = this.metaPath(meta.sessionId);
    const data = JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }, null, 2);
    // temp + rename 原子写（元数据文件小，不会丢历史）
    const tmp = `${metaPath}.tmp`;
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, metaPath);
  }

  /** 读取会话元数据 */
  async readStoredMode(sessionId: SessionId): Promise<SessionMetadata | undefined> {
    const metaPath = this.metaPath(sessionId);
    try {
      const text = await fs.readFile(metaPath, 'utf8');
      return JSON.parse(text) as SessionMetadata;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /** 判断 transcript 是否存在 */
  async hasSession(sessionId: SessionId): Promise<boolean> {
    try {
      await fs.access(this.transcriptPath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================
  // 路径辅助
  // ============================================================

  private transcriptPath(sessionId: SessionId): string {
    return path.join(this.transcriptDir, `${sessionId}.jsonl`);
  }

  private metaPath(sessionId: SessionId): string {
    return path.join(this.transcriptDir, `${sessionId}.meta.json`);
  }

  private boundaryPath(sessionId: SessionId): string {
    return path.join(this.transcriptDir, `${sessionId}.boundaries.jsonl`);
  }

  /** 获取最近 boundary（注入 BoundaryStore 或临时创建） */
  private async fetchLastBoundary(sessionId: SessionId): Promise<CompactBoundary | undefined> {
    const store = this.boundaryStore ?? new BoundaryStore({ boundaryPath: this.boundaryPath(sessionId) });
    return store.getLast(sessionId as unknown as UUID);
  }
}

// ============================================================
// 工厂函数
// ============================================================

/** 默认 transcript 目录（~/.omniagent/transcript） */
export function defaultTranscriptDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return path.join(home, '.omniagent', 'transcript');
}

/** 单例 */
export const resumeService = new ResumeService();

// ============================================================
// 兼容 re-export（便于外部按需导入）
// ============================================================

export { defaultTranscriptPath, defaultBoundaryPath };
