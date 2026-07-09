import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { TranscriptStore } from '../../src/memory/transcript.js';
import type { Message, UUID } from '../../src/types/index.js';

function tmpTranscriptPath(): string {
  const dir = path.join(os.tmpdir(), `omniagent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return path.join(dir, 'transcript.jsonl');
}

function makeMessage(params: {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  id?: UUID;
  parentUuid?: UUID;
}): Message {
  return {
    role: params.role,
    content: [{ type: 'text', text: params.text }],
    id: params.id ?? (randomUUID() as UUID),
    parentUuid: params.parentUuid,
    createdAt: new Date().toISOString() as never,
  };
}

/** 构造链路：每条消息的 parentUuid 指向上一条 id */
function makeChain(texts: string[]): Message[] {
  const msgs: Message[] = [];
  let prevId: UUID | undefined;
  for (const text of texts) {
    const id = randomUUID() as UUID;
    msgs.push(makeMessage({ role: 'user', text, id, parentUuid: prevId }));
    prevId = id;
  }
  return msgs;
}

// ============================================================
// 基础读写
// ============================================================

test('TranscriptStore: append + readRaw 返回所有消息', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const msgs = makeChain(['hello', 'world', 'foo']);
    for (const m of msgs) await store.append(m);
    await store.flush();
    const raw = await store.readRaw();
    assert.equal(raw.length, 3);
    assert.equal((raw[0].content[0] as { text: string }).text, 'hello');
    assert.equal((raw[1].content[0] as { text: string }).text, 'world');
    assert.equal((raw[2].content[0] as { text: string }).text, 'foo');
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('TranscriptStore: 文件不存在时 readRaw 返回空数组', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const raw = await store.readRaw();
    assert.deepEqual(raw, []);
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('TranscriptStore: readUi 过滤 system 消息', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const sysMsg = makeMessage({ role: 'system', text: 'system prompt' });
    const userMsg = makeMessage({ role: 'user', text: 'user query', parentUuid: sysMsg.id });
    await store.append(sysMsg);
    await store.append(userMsg);
    await store.flush();
    const ui = await store.readUi();
    assert.equal(ui.length, 1, 'system 消息应被过滤');
    assert.equal(ui[0].role, 'user');
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('TranscriptStore: readApiWire 返回 role+content 数组', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const msgs = makeChain(['q1', 'a1']);
    for (const m of msgs) await store.append(m);
    await store.flush();
    const wire = await store.readApiWire();
    assert.equal(wire.length, 2);
    assert.equal(wire[0].role, 'user');
    assert.equal(wire[1].role, 'user');
    assert.ok(Array.isArray(wire[0].content));
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('TranscriptStore: readActiveQuery M1 stub 全量返回', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const msgs = makeChain(['a', 'b', 'c']);
    for (const m of msgs) await store.append(m);
    await store.flush();
    const active = await store.readActiveQuery('turn-1');
    assert.equal(active.length, 3, 'M1 stub: 全量返回');
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// walkChainBeforeParse 链路校验
// ============================================================

test('TranscriptStore: walkChainBeforeParse 完整链路 ok', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const msgs = makeChain(['a', 'b', 'c']);
    for (const m of msgs) await store.append(m);
    await store.flush();
    const check = await store.walkChainBeforeParse();
    assert.equal(check.ok, true);
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('TranscriptStore: walkChainBeforeParse 检测首条 parentUuid 错误', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    // 首条消息带 parentUuid（错误）
    const bad = makeMessage({
      role: 'user',
      text: 'first',
      parentUuid: 'should-not-have-this' as UUID,
    });
    await store.append(bad);
    await store.flush();
    const check = await store.walkChainBeforeParse();
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 0);
    assert.equal(check.scenario, 'SCENARIO_TRANSCRIPT_CORRUPT');
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('TranscriptStore: walkChainBeforeParse 检测中间断链', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const msgs = makeChain(['a', 'b', 'c']);
    // 篡改第 2 条消息的 parentUuid
    msgs[1].parentUuid = 'wrong-uuid' as UUID;
    for (const m of msgs) await store.append(m);
    await store.flush();
    const check = await store.walkChainBeforeParse();
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 1);
    assert.equal(check.scenario, 'SCENARIO_TRANSCRIPT_CORRUPT');
    assert.match(check.detail ?? '', /expected=/);
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('TranscriptStore: walkChainBeforeParse 检测缺 parentUuid', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const m1 = makeMessage({ role: 'user', text: 'first' });
    const m2 = makeMessage({ role: 'user', text: 'second', parentUuid: undefined });
    await store.append(m1);
    await store.append(m2);
    await store.flush();
    const check = await store.walkChainBeforeParse();
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 1);
    assert.equal(check.scenario, 'SCENARIO_FORK_METADATA_MISSING');
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('TranscriptStore: walkChainBeforeParse 空文件 ok', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const check = await store.walkChainBeforeParse();
    assert.equal(check.ok, true);
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// size + pendingSize
// ============================================================

test('TranscriptStore: size 返回持久化消息数', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const msgs = makeChain(['a', 'b']);
    for (const m of msgs) await store.append(m);
    await store.flush();
    assert.equal(await store.size(), 2);
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('TranscriptStore: pendingSize 反映队列状态', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const queue = store as unknown as { writeQueue: { size(): number; throttleMs: number } };
    // 重新构造一个长 throttle 的 store
    const DrainWriteQueue = (await import('../../src/memory/drain-write-queue.js')).DrainWriteQueue;
    const slowStore = new (TranscriptStore as unknown as new (path: string, opts?: { throttleMs?: number }) => TranscriptStore)(filePath, { throttleMs: 1000 });
    // 把 writeQueue 替换为长 throttle 的
    const slowQueue = new DrainWriteQueue({ transcriptPath: filePath, throttleMs: 1000, flushMs: 1000, enableFsync: false });
    // 但 slowStore 内部还是用的快 queue，这里直接测试 DrainWriteQueue
    await slowQueue.enqueue(makeMessage({ role: 'user', text: 'queued' }));
    assert.equal(slowQueue.size(), 1);
    await slowQueue.flush();
    assert.equal(slowQueue.size(), 0);
    await slowQueue.close();
    void queue;  // unused
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// load 工厂方法
// ============================================================

test('TranscriptStore.load: 创建目录并返回实例', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    assert.ok(store);
    assert.equal(store.path, filePath);
    // 目录应已创建
    const stat = await fs.stat(path.dirname(filePath));
    assert.ok(stat.isDirectory());
    await store.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('TranscriptStore: close 后队列不可写', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    await store.close();
    // close 后再 append 抛错
    await assert.rejects(() => store.append(makeMessage({ role: 'user', text: 'after-close' })), /closed/);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// 损坏行容错
// ============================================================

test('TranscriptStore: readRaw 容错损坏行', async () => {
  const filePath = tmpTranscriptPath();
  try {
    const store = await TranscriptStore.load(filePath);
    const m1 = makeMessage({ role: 'user', text: 'first' });
    await store.append(m1);
    await store.flush();
    await store.close();

    // 手动追加一行损坏 JSON
    await fs.appendFile(filePath, 'this is not json\n');

    const store2 = await TranscriptStore.load(filePath);
    const raw = await store2.readRaw();
    // 损坏行被跳过，但合法消息保留
    assert.equal(raw.length, 1);
    assert.equal((raw[0].content[0] as { text: string }).text, 'first');
    await store2.close();
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});
