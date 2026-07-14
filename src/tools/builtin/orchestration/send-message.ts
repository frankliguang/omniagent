/**
 * SendMessageTool（L3-M5 §5.1 — send_message, M2 iter 2）
 *
 * LLM 调用：
 *   send_message(to="alice", text="please review PR #42")
 *   send_message(to="alice", type="task_update", payload={...})
 *
 * 职责：
 * - 包装 MailboxService.send（writeMailboxAtomic + per-name Mutex + 容量限制）
 * - 强制按 name 寻址（不变量 #2）
 * - 返回 written=true/false（不变量 #7：零丢失；written=false 时由 LLM 决定降级）
 *
 * 设计选择：
 * - 默认 type='text' + payload={text}（最常用场景，简化 LLM 调用）
 * - 支持 type='shutdown_request' / 'shutdown_response' / 'task_update' 高级消息
 * - 不接受自定义 message id（避免 LLM 操纵 id 空间）
 *
 * M2 iter 2 范围：
 * - 单进程 mailbox 写入（leader ↔ teammate 通信）
 * - 不实现跨进程文件锁（v2.x）
 */

import type {
  AgentId,
  MailboxMessage,
  MailboxName,
  PermissionDecision,
  Tool,
  ToolInput,
  ToolResult,
  ToolUseId,
} from '../../../types/index.js';
import { buildTool, errorResult, okResult } from '../../build-tool.js';
import type { MailboxService } from '../../../orchestration/mailbox-service.js';

/** 构造依赖 */
export interface SendMessageToolDeps {
  mailboxService: MailboxService;
  /** 父 agent 的 agentId（写入 mailbox.from） */
  parentAgentId: () => AgentId | MailboxName;
}

/** 支持的消息类型（限制 LLM 选择，避免任意 type） */
const ALLOWED_TYPES = [
  'text',
  'shutdown_request',
  'shutdown_response',
  'task_update',
] as const;

type AllowedType = (typeof ALLOWED_TYPES)[number];

function isAllowedType(s: unknown): s is AllowedType {
  return typeof s === 'string' && (ALLOWED_TYPES as readonly string[]).includes(s);
}

export function createSendMessageTool(deps: SendMessageToolDeps): Tool {
  return buildTool({
    name: 'send_message',
    description:
      'Send a message to a teammate mailbox by name (invariant #2: name addressing, ' +
      'invariant #7: zero loss). Default type is text. Returns {written, message_id, archive_triggered?}. ' +
      'If written=false, the mailbox is at capacity or io_error — decide fallback (e.g. wait + retry, or send shutdown_request).',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Teammate name (MailboxName). The mailbox at ~/.omniagent/mailbox/<name>.jsonl will receive the message.',
        },
        text: {
          type: 'string',
          description: 'Message text (used when type=text, default). Stored as payload.text.',
        },
        type: {
          type: 'string',
          enum: [...ALLOWED_TYPES],
          description: 'Message type. Default: text. For shutdown_request/shutdown_response/task_update, provide payload field.',
        },
        payload: {
          type: 'object',
          description: 'Raw payload object (used when type != text). Ignored if type=text (use text field).',
        },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: true,
    isBackground: false,

    checkPermissions(_input: ToolInput): PermissionDecision {
      // send_message 写 mailbox（外部状态），但通过 MailboxService.fail-closed 容量限制
      // M2 stub：allow（M3 完整版接入 hooks/permission 完整链）
      return { decision: 'allow', matchedRule: 'm2-stub', layer: 2 };
    },

    async call(input: ToolInput, ctx): Promise<ToolResult> {
      const startMs = Date.now();
      const toolUseId = (ctx?.toolUseId ?? ('' as ToolUseId)) as ToolUseId;
      const to = input.to as string;
      const text = input.text as string;
      const typeRaw = input.type as string | undefined;
      const payloadRaw = input.payload as unknown;

      if (!to) {
        return errorResult(toolUseId, 'send_message: to (teammate name) is required', { duration_ms: Date.now() - startMs });
      }
      if (text === undefined || text === null) {
        return errorResult(toolUseId, 'send_message: text is required', { duration_ms: Date.now() - startMs });
      }
      const type: AllowedType = isAllowedType(typeRaw) ? typeRaw : 'text';

      // 构造 payload
      let payload: unknown;
      if (type === 'text') {
        payload = { text };
      } else {
        // 非文本消息：使用 LLM 提供的 payload，缺省回退到 { text }
        payload = payloadRaw ?? { text };
      }

      const from = deps.parentAgentId();

      const result = await deps.mailboxService.send({
        from,
        to: to as MailboxName,
        type: type as MailboxMessage['type'],
        payload,
      });

      const durationMs = Date.now() - startMs;

      if (!result.written) {
        // 不变量 #7：零丢失 — written=false 时返回错误，不静默吞消息
        return errorResult(
          toolUseId,
          `send_message: mailbox write to "${to}" failed (error=${result.error}). ` +
            `Decide fallback: wait + retry, or send shutdown_request if teammate unreachable.`,
          { duration_ms: durationMs },
        );
      }

      const summary = JSON.stringify({
        to,
        type,
        message_id: result.messageId,
        archive_triggered: result.archive_triggered ?? false,
      });

      return okResult(
        toolUseId,
        `send_message: delivered to "${to}".\n\n${summary}`,
        { compactable: false, duration_ms: durationMs },
      );
    },
  });
}
