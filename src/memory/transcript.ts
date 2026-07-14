/**
 * TranscriptStore（L3-M7 §2.2.6 — 4 视图）
 *
 * Session transcript JSONL 读写 + 4 视图 + walkChainBeforeParse 链路校验。
 *
 * 4 视图：
 * - readRaw(): JSONL 原始记录，按 uuid/parentUuid 链路还原
 * - readUi(): 渲染后用户可见（过滤 system 消息 + 工具调用细节）
 * - readActiveQuery(turnId): 当前 turn 相关子集（M1 stub：全量返回）
 * - readApiWire(): 转换为 LLM API 格式（role/content/tool_use/tool_result 块）
 *
 * walkChainBeforeParse: 启动期校验（resume 时检测断链）
 * - 链路完整性：每条消息的 parentUuid 应指向上一条（除首条）
 * - 断链 → 返回 { ok: false, brokenAt, scenario }
 *
 * M1 迭代 2 范围：
 * - readRaw / readUi / readApiWire 实现
 * - readActiveQuery stub（M3 完整版按 turnId 筛选）
 * - walkChainBeforeParse 链路校验
 * - load() 工厂方法（resume 入口）
 */

import { promises as fs } from 'node:fs';

import type {
  ContentBlock,
  Message,
} from '../types/index.js';
import { DrainWriteQueue, ensureTranscriptDir } from './drain-write-queue.js';

// ============================================================
// 类型定义
// ============================================================

/** walkChainBeforeParse 返回值 */
export interface ChainCheckResult {
  ok: boolean;
  /** 断链位置（brokenAt 条消息的 parentUuid 不指向上一条） */
  brokenAt?: number;
  /** 错误场景（对应 RecoveryHandler 的 9 场景） */
  scenario?: 'SCENARIO_TRANSCRIPT_CORRUPT' | 'SCENARIO_FORK_METADATA_MISSING';
  /** 错误详情 */
  detail?: string;
}

/** readApiWire 返回的 LLM API 格式消息 */
export interface ApiWireMessage {
  role: string;
  content: ContentBlock[];
}

// ============================================================
// TranscriptStore
// ============================================================

export class TranscriptStore {
  private readonly writeQueue: DrainWriteQueue;
  private readonly transcriptPath: string;

  constructor(transcriptPath: string) {
    this.transcriptPath = transcriptPath;
    this.writeQueue = new DrainWriteQueue({
      transcriptPath,
      enableFsync: true,
    });
  }

  /** 工厂方法：加载已有 transcript（resume 入口） */
  static async load(transcriptPath: string): Promise<TranscriptStore> {
    await ensureTranscriptDir(transcriptPath);
    return new TranscriptStore(transcriptPath);
  }

  /** 追加消息（经 DrainWriteQueue 异步持久化） */
  async append(msg: Message): Promise<void> {
    await this.writeQueue.enqueue(msg);
  }

  /** 强制 flush 写队列（resume / shutdown 前调用） */
  async flush(): Promise<void> {
    await this.writeQueue.flush();
  }

  /** 关闭写队列 */
  async close(): Promise<void> {
    await this.writeQueue.close();
  }

  // ========================================================
  // 4 视图
  // ========================================================

  /** Raw 视图：JSONL 原始记录，按 uuid/parentUuid 链路还原 */
  async readRaw(): Promise<Message[]> {
    await this.writeQueue.flush();  // 先 flush 确保读到最新
    let text: string;
    try {
      text = await fs.readFile(this.transcriptPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw err;
    }
    const lines = text.split('\n').filter(l => l.trim());
    const messages: Message[] = [];
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as Message);
      } catch {
        // 单行解析失败 → 跳过（损坏行不影响其他消息）
      }
    }
    return messages;
  }

  /** UI 视图：渲染后用户可见（过滤 system 消息 + 工具调用细节截断） */
  async readUi(): Promise<Message[]> {
    const raw = await this.readRaw();
    return raw
      .filter(m => m.role !== 'system')
      .map(m => ({
        ...m,
        content: m.content.map(b => {
          // 工具结果截断（UI 不显示完整输出）
          if (b.type === 'tool_result') {
            const text = extractTextFromContent(b.content);
            if (text.length > 200) {
              return { ...b, content: [{ type: 'text' as const, text: text.slice(0, 200) + '...' }] };
            }
          }
          return b;
        }),
      }));
  }

  /** Active query 视图：当前 turn 相关子集（M1 stub：全量返回） */
  async readActiveQuery(_turnId: string): Promise<Message[]> {
    // M1 stub：L1 = full injection，全量返回
    // M3 完整版：按 turnId 筛选当前 turn 的消息 + 工具结果
    return this.readRaw();
  }

  /** API wire 视图：转换为 LLM API 格式 */
  async readApiWire(): Promise<ApiWireMessage[]> {
    const raw = await this.readRaw();
    return raw.map(m => ({
      role: m.role,
      content: m.content,
    }));
  }

  // ========================================================
  // 链路校验
  // ========================================================

  /** 启动期校验：检测 uuid/parentUuid 链路完整性 */
  async walkChainBeforeParse(): Promise<ChainCheckResult> {
    const messages = await this.readRaw();
    if (messages.length === 0) {
      return { ok: true };
    }

    // Sidechain transcript：文件名含 `.sidechain-{id}`
    // 首条消息可能：
    //   (a) parentUuid 指向主 transcript fork point（fork 路径显式设置）
    //   (b) parentUuid=undefined（byte-identical 复制父上下文，不变量 #5）
    // 两种都合法，fork point 链路由 SidechainManager 的 sidechainMeta 独立跟踪
    // 链路校验时跳过首条 parentUuid 检查，从第 2 条开始校验内部链路
    const isSidechain = /\.sidechain-[0-9a-f-]+\.jsonl$/.test(this.transcriptPath);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const expectedParent = i === 0 ? undefined : messages[i - 1].id;

      // 首条消息：
      // - sidechain：parentUuid 可有可无（见上文注释），跳过首条检查
      // - 主 transcript：不应有 parentUuid
      if (i === 0) {
        if (isSidechain) {
          continue;  // sidechain 首条 parentUuid 由 ForkAgentSpawner 决定（byte-identical 或显式 fork point）
        }
        // 主 transcript：首条消息不应有 parentUuid
        if (msg.parentUuid) {
          return {
            ok: false,
            brokenAt: i,
            scenario: 'SCENARIO_TRANSCRIPT_CORRUPT',
            detail: `first message has parentUuid=${msg.parentUuid} (should be undefined)`,
          };
        }
      }

      // 非首条消息：parentUuid 应指向上一条 id
      if (i > 0) {
        if (!msg.parentUuid) {
          // 缺 parentUuid → fork metadata missing 场景
          return {
            ok: false,
            brokenAt: i,
            scenario: 'SCENARIO_FORK_METADATA_MISSING',
            detail: `message ${i} missing parentUuid`,
          };
        }
        if (expectedParent && msg.parentUuid !== expectedParent) {
          // parentUuid 不匹配 → transcript corrupt 场景
          return {
            ok: false,
            brokenAt: i,
            scenario: 'SCENARIO_TRANSCRIPT_CORRUPT',
            detail: `message ${i} parentUuid=${msg.parentUuid} expected=${expectedParent}`,
          };
        }
      }
    }

    return { ok: true };
  }

  // ========================================================
  // 元信息
  // ========================================================

  /** transcript 文件路径 */
  get path(): string {
    return this.transcriptPath;
  }

  /** 当前消息数（读取文件） */
  async size(): Promise<number> {
    const msgs = await this.readRaw();
    return msgs.length;
  }

  /** 队列中未写出的消息数 */
  pendingSize(): number {
    return this.writeQueue.size();
  }
}

// ============================================================
// 辅助函数
// ============================================================

/** 从 ContentBlock 数组提取纯文本 */
function extractTextFromContent(content: ContentBlock[] | undefined): string {
  if (!content) return '';
  return content
    .map(b => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[tool_use: ${b.name}]`;
      if (b.type === 'tool_result') return extractTextFromContent(b.content);
      return '';
    })
    .join('');
}
