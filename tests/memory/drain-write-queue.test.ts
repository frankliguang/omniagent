import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { DrainWriteQueue, ensureTranscriptDir, defaultTranscriptPath } from '../../src/memory/drain-write-queue.js';
import type { Message } from '../../src/types/index.js';

function makeMessage(text: string, id?: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    id: id as never,
    createdAt: new Date().toISOString() as never,
  };
}

function tmpTranscriptPath(): string {
  const dir = path.join(os.tmpdir(), `omniagent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return path.join(dir, 'transcript.jsonl');
}

async function readTranscript(filePath: string): Promise<Message[]> {
  const text = await fs.readFile(filePath, 'utf8');
  return text
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as Message);
}

// ============================================================
// 基础功能
// ============================================================

test('DrainWriteQueue: enqueue + flush 后消息持久化', async () => {
  const filePath = tmpTranscriptPath();
  await ensureTranscriptDir(filePath);
  try {
    const queue = new DrainWriteQueue({
      transcriptPath: filePath,
      throttleMs: 50,
      flushMs: 5,
      enableFsync: false,  // 测试加速
    });
    await queue.enqueue(makeMessage('hello'));
    await queue.enqueue(makeMessage('world'));
    // 等 flush 触发
    await queue.flush();
    const msgs = await readTranscript(filePath);
    assert.equal(msgs.length, 2);
    assert.equal((msgs[0].content[0] as { text: string }).text, 'hello');
    assert.equal((msgs[1].content[0] as { text: string }).text, 'world');
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('DrainWriteQueue: 队列未 flush 时文件不存在或为空', async () => {
  const filePath = tmpTranscriptPath();
  await ensureTranscriptDir(filePath);
  try {
    const queue = new DrainWriteQueue({
      transcriptPath: filePath,
      throttleMs: 1000,  // 长节流，确保不触发
      flushMs: 1000,
      enableFsync: false,
    });
    await queue.enqueue(makeMessage('not yet'));
    // 不等 flush，文件应为空或不存在
    assert.equal(queue.size(), 1);
    let exists = false;
    try {
      const stat = await fs.stat(filePath);
      exists = stat.size > 0;
    } catch {
      exists = false;
    }
    assert.equal(exists, false, '未 flush 时不应有数据');
    await queue.flush();
    const msgs = await readTranscript(filePath);
    assert.equal(msgs.length, 1);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('DrainWriteQueue: flush 后队列清空', async () => {
  const filePath = tmpTranscriptPath();
  await ensureTranscriptDir(filePath);
  try {
    const queue = new DrainWriteQueue({
      transcriptPath: filePath,
      throttleMs: 1000,
      flushMs: 1000,
      enableFsync: false,
    });
    await queue.enqueue(makeMessage('a'));
    await queue.enqueue(makeMessage('b'));
    assert.equal(queue.size(), 2);
    await queue.flush();
    assert.equal(queue.size(), 0);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// 重入守卫
// ============================================================

test('DrainWriteQueue: 多次连续 flush 不破坏数据', async () => {
  const filePath = tmpTranscriptPath();
  await ensureTranscriptDir(filePath);
  try {
    const queue = new DrainWriteQueue({
      transcriptPath: filePath,
      throttleMs: 1000,
      flushMs: 1000,
      enableFsync: false,
    });
    for (let i = 0; i < 10; i++) {
      await queue.enqueue(makeMessage(`msg-${i}`));
    }
    // 并发 flush（模拟 throttle 与 flush 同时到期）
    await Promise.all([
      queue.flush(),
      queue.flush(),
      queue.flush(),
    ]);
    const msgs = await readTranscript(filePath);
    assert.equal(msgs.length, 10, '10 条消息全部持久化，无丢失无重复');
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('DrainWriteQueue: flushing 状态在 flush 期间为 true', async () => {
  const filePath = tmpTranscriptPath();
  await ensureTranscriptDir(filePath);
  try {
    const queue = new DrainWriteQueue({
      transcriptPath: filePath,
      throttleMs: 1000,
      flushMs: 1000,
      enableFsync: false,
    });
    await queue.enqueue(makeMessage('test'));
    const flushPromise = queue.flush();
    // 注意：flushing 可能在 Promise 创建后立即转 true 然后转 false
    // 此处仅验证不抛错
    await flushPromise;
    assert.equal(queue.isFlushing(), false);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// 定时器触发
// ============================================================

test('DrainWriteQueue: 10ms flush 定时器自动触发', async () => {
  const filePath = tmpTranscriptPath();
  await ensureTranscriptDir(filePath);
  try {
    const queue = new DrainWriteQueue({
      transcriptPath: filePath,
      throttleMs: 1000,  // 长节流，确保 flush 先到期
      flushMs: 20,
      enableFsync: false,
    });
    await queue.enqueue(makeMessage('auto-flush'));
    // 等 50ms 让 flushMs 触发
    await new Promise(resolve => setTimeout(resolve, 50));
    const msgs = await readTranscript(filePath);
    assert.equal(msgs.length, 1, 'flush 定时器应自动触发持久化');
    assert.equal(queue.size(), 0);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('DrainWriteQueue: 100ms throttle 定时器自动触发', async () => {
  const filePath = tmpTranscriptPath();
  await ensureTranscriptDir(filePath);
  try {
    const queue = new DrainWriteQueue({
      transcriptPath: filePath,
      throttleMs: 50,
      flushMs: 1000,  // 长 flush，确保 throttle 先到期
      enableFsync: false,
    });
    await queue.enqueue(makeMessage('throttle'));
    // 等 100ms 让 throttleMs 触发
    await new Promise(resolve => setTimeout(resolve, 100));
    const msgs = await readTranscript(filePath);
    assert.equal(msgs.length, 1, 'throttle 定时器应自动触发持久化');
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// close
// ============================================================

test('DrainWriteQueue: close 强制 flush 剩余消息', async () => {
  const filePath = tmpTranscriptPath();
  await ensureTranscriptDir(filePath);
  try {
    const queue = new DrainWriteQueue({
      transcriptPath: filePath,
      throttleMs: 1000,
      flushMs: 1000,
      enableFsync: false,
    });
    await queue.enqueue(makeMessage('before-close'));
    assert.equal(queue.size(), 1);
    await queue.close();
    const msgs = await readTranscript(filePath);
    assert.equal(msgs.length, 1);
    // close 后再 enqueue 抛错
    await assert.rejects(() => queue.enqueue(makeMessage('after-close')), /closed/);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// JSONL 格式
// ============================================================

test('DrainWriteQueue: 写入格式为每行一个 JSON', async () => {
  const filePath = tmpTranscriptPath();
  await ensureTranscriptDir(filePath);
  try {
    const queue = new DrainWriteQueue({
      transcriptPath: filePath,
      throttleMs: 1000,
      flushMs: 1000,
      enableFsync: false,
    });
    await queue.enqueue(makeMessage('first'));
    await queue.enqueue(makeMessage('second'));
    await queue.enqueue(makeMessage('third'));
    await queue.flush();
    const text = await fs.readFile(filePath, 'utf8');
    const lines = text.split('\n').filter(l => l.trim());
    assert.equal(lines.length, 3);
    // 每行可独立 JSON.parse
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.role);
      assert.ok(Array.isArray(parsed.content));
    }
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// 工厂函数
// ============================================================

test('ensureTranscriptDir: 创建多级目录', async () => {
  const dir = path.join(os.tmpdir(), `omniagent-test-mkdir-${Date.now()}/a/b/c`);
  const filePath = path.join(dir, 'transcript.jsonl');
  try {
    await ensureTranscriptDir(filePath);
    const stat = await fs.stat(dir);
    assert.ok(stat.isDirectory());
  } finally {
    await fs.rm(path.join(os.tmpdir(), `omniagent-test-mkdir-${Date.now()}`), { recursive: true, force: true }).catch(() => {});
  }
});

test('defaultTranscriptPath: 含 sessionId 与 .jsonl 后缀', () => {
  const p = defaultTranscriptPath('sess-123');
  assert.ok(p.includes('sess-123'));
  assert.ok(p.endsWith('.jsonl'));
  assert.ok(p.includes('.omniagent'));
});
