/**
 * SSEParser（L3-M1 §2.2.4 + §3.2）
 *
 * 解析 raw SSE 字节流为事件对象。按 \n\n 分块，每块解析 event:/data: 字段。
 * 支持跨 chunk 缓冲（一个 SSE 事件可能跨多个 TCP chunk）。
 */

export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

const FIELD_SEPARATOR = ':';
const EVENT_TERMINATOR = '\n\n';

const textDecoder = new TextDecoder();

export class SSEParser {
  private buffer = '';

  /**
   * 喂入一段 chunk，返回完整事件列表。
   * 不完整的事件留在 buffer 中等下次 feed。
   * chunk 支持 string / Uint8Array（Web Streams API）/ Buffer（Node）。
   */
  feed(chunk: string | Uint8Array | Buffer): SSEEvent[] {
    if (typeof chunk === 'string') {
      this.buffer += chunk;
    } else {
      this.buffer += textDecoder.decode(chunk as Uint8Array);
    }

    // SSE 规范允许 CRLF 或 LF 行尾，统一规范化为 LF 简化后续处理
    if (this.buffer.includes('\r')) {
      this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    const events: SSEEvent[] = [];
    let terminatorIndex: number;
    while ((terminatorIndex = this.buffer.indexOf(EVENT_TERMINATOR)) !== -1) {
      const rawEvent = this.buffer.slice(0, terminatorIndex);
      this.buffer = this.buffer.slice(terminatorIndex + EVENT_TERMINATOR.length);
      const parsed = this.parseEvent(rawEvent);
      if (parsed) {
        events.push(parsed);
      }
    }
    return events;
  }

  /** 喂入结束信号，返回 buffer 中剩余的最后一个事件（如果有） */
  flush(): SSEEvent[] {
    if (!this.buffer.trim()) {
      return [];
    }
    const parsed = this.parseEvent(this.buffer);
    this.buffer = '';
    return parsed ? [parsed] : [];
  }

  reset(): void {
    this.buffer = '';
  }

  private parseEvent(raw: string): SSEEvent | null {
    if (!raw.trim()) {
      return null;
    }

    const event: SSEEvent = { data: '' };
    const dataLines: string[] = [];

    for (const line of raw.split('\n')) {
      // SSE 规范：行首为 : 的行是注释（heartbeat），忽略
      if (!line || line.startsWith(':')) {
        continue;
      }
      const sepIndex = line.indexOf(FIELD_SEPARATOR);
      const field = sepIndex === -1 ? line : line.slice(0, sepIndex);
      // 跳过 field 后的冒号 + 一个空格（SSE 规范：`field: value`）
      const value =
        sepIndex === -1
          ? ''
          : line.slice(sepIndex + 1).replace(/^ /, '');

      switch (field) {
        case 'event':
          event.event = value;
          break;
        case 'data':
          dataLines.push(value);
          break;
        case 'id':
          event.id = value;
          break;
        case 'retry':
          const parsed = Number.parseInt(value, 10);
          if (!Number.isNaN(parsed)) {
            event.retry = parsed;
          }
          break;
      }
    }

    // 纯注释块（如 `: heartbeat`）无任何有效字段，丢弃
    if (!event.event && dataLines.length === 0 && !event.id && event.retry === undefined) {
      return null;
    }

    event.data = dataLines.join('\n');
    return event;
  }
}
