/**
 * AWS EventStream 二进制帧解析（L3-M1 §3.2.2 — Bedrock 流式响应）
 *
 * Bedrock InvokeModelWithResponseStream 返回 application/vnd.amazon.eventstream 二进制流。
 * 每个 frame 格式：
 *   [4 bytes total-length][4 bytes headers-length][headers][payload][4 bytes CRC32]
 *
 * Headers 含 :event-type / :message-type / :content-type 等。
 * Payload 是 JSON（对 Claude 模型，格式同 Anthropic SSE 的 data 部分）。
 *
 * 解析后产生 { eventType, payloadJson } 事件序列，供 BedrockProvider 进一步归一化为 ChatChunk。
 *
 * 参考：https://docs.aws.amazon.com/nimbus/latest/whitepapers/sigv4-and-event-stream.html
 */

// ============================================================
// 类型
// ============================================================

export interface BedrockEvent {
  /** :event-type header 值（如 "chunk" / "metadata"） */
  eventType: string;
  /** :message-type header 值（"event" / "error"） */
  messageType: string;
  /** payload JSON 对象（已解析） */
  payload: unknown;
}

// ============================================================
// EventStreamParser
// ============================================================

export class BedrockEventStreamParser {
  private buffer: Uint8Array = new Uint8Array(0);

  /** 喂入字节流，返回完整 frame 解析出的事件（可能 0 / 多个） */
  feed(bytes: Uint8Array): BedrockEvent[] {
    // 累积 buffer
    const newBuffer = new Uint8Array(this.buffer.length + bytes.length);
    newBuffer.set(this.buffer, 0);
    newBuffer.set(bytes, this.buffer.length);
    this.buffer = newBuffer;

    const events: BedrockEvent[] = [];
    while (this.buffer.length >= 8) {
      // 读 total-length（big-endian uint32）
      const totalLength = readUInt32BE(this.buffer, 0);
      if (totalLength < 16 || totalLength > 1024 * 1024) {
        // 长度不合理 → 损坏，跳过 4 字节重试
        this.buffer = this.buffer.slice(4);
        continue;
      }
      if (this.buffer.length < totalLength) {
        // 帧未完整，等更多数据
        break;
      }

      // 解析一帧
      const frame = this.buffer.slice(0, totalLength);
      this.buffer = this.buffer.slice(totalLength);

      try {
        const event = parseFrame(frame);
        if (event) events.push(event);
      } catch {
        // 单帧解析失败：跳过（容错）
      }
    }
    return events;
  }

  /** flush 剩余 buffer（流结束时调用，返回可能残留的事件） */
  flush(): BedrockEvent[] {
    // 一般 buffer 应已耗尽；若残留则尝试解析
    if (this.buffer.length < 8) {
      this.buffer = new Uint8Array(0);
      return [];
    }
    const remaining = this.buffer;
    this.buffer = new Uint8Array(0);
    const events: BedrockEvent[] = [];
    for (const ev of this.feed(remaining)) events.push(ev);
    return events;
  }
}

// ============================================================
// 帧解析
// ============================================================

function parseFrame(frame: Uint8Array): BedrockEvent | undefined {
  if (frame.length < 16) return undefined;

  const totalLength = readUInt32BE(frame, 0);
  const headersLength = readUInt32BE(frame, 4);
  // 最小帧：8 (prefix) + headersLength + 0 (payload) + 4 (CRC) = 12 + headersLength
  if (headersLength + 12 > totalLength) return undefined;

  // headers 区
  const headersBytes = frame.slice(8, 8 + headersLength);
  const headers = parseHeaders(headersBytes);

  // payload 区（headers 后到 CRC 前 4 字节）
  const payloadStart = 8 + headersLength;
  const payloadEnd = totalLength - 4;  // 最后 4 字节是 CRC32
  const payloadBytes = frame.slice(payloadStart, payloadEnd);

  let payload: unknown = undefined;
  if (payloadBytes.length > 0) {
    const text = new TextDecoder().decode(payloadBytes);
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return {
    eventType: headers[':event-type'] ?? '',
    messageType: headers[':message-type'] ?? 'event',
    payload,
  };
}

/** 解析 headers 区（name-length / type / value 三元组序列） */
function parseHeaders(bytes: Uint8Array): Record<string, string> {
  const headers: Record<string, string> = {};
  let i = 0;
  while (i < bytes.length) {
    if (i + 1 > bytes.length) break;
    // name length（1 byte）
    const nameLen = bytes[i];
    i += 1;
    if (i + nameLen > bytes.length) break;
    const name = new TextDecoder().decode(bytes.slice(i, i + nameLen));
    i += nameLen;
    if (i + 1 > bytes.length) break;
    // value type（1 byte）：1=string / 2=number / 3=timestamp
    const valueType = bytes[i];
    i += 1;
    // value length（2 bytes BE）
    if (i + 2 > bytes.length) break;
    const valueLen = (bytes[i] << 8) | bytes[i + 1];
    i += 2;
    if (i + valueLen > bytes.length) break;
    const valueBytes = bytes.slice(i, i + valueLen);
    i += valueLen;
    const value = parseHeaderValue(valueType, valueBytes);
    headers[name] = value;
  }
  return headers;
}

function parseHeaderValue(type: number, bytes: Uint8Array): string {
  switch (type) {
    case 1: // string
      return new TextDecoder().decode(bytes);
    case 2: // number (BE int64)
      return String(readInt64BE(bytes, 0));
    case 3: // timestamp (BE int64 ms since epoch)
      return new Date(Number(readInt64BE(bytes, 0))).toISOString();
    case 4: // uuid (16 bytes)
      return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    default:
      return '';
  }
}

// ============================================================
// 字节读取辅助
// ============================================================

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] * 0x1000000) +
    ((bytes[offset + 1] << 16) >>> 0) +
    ((bytes[offset + 2] << 8) >>> 0) +
    bytes[offset + 3]
  );
}

function readInt64BE(bytes: Uint8Array, offset: number): bigint {
  const high = BigInt(bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) >>> 0) + ((bytes[offset + 2] << 8) >>> 0) + bytes[offset + 3]);
  const low = BigInt(bytes[offset + 4] * 0x1000000 + ((bytes[offset + 5] << 16) >>> 0) + ((bytes[offset + 6] << 8) >>> 0) + bytes[offset + 7]);
  return (high << 32n) | low;
}
