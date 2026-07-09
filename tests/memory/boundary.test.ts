import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  BoundaryStore,
  createBoundary,
  defaultBoundaryPath,
  generateBoundaryId,
  nowTimestamp,
} from '../../src/memory/boundary.js';
import type { CompactBoundary, UUID } from '../../src/types/index.js';

function tmpBoundaryPath(): string {
  const dir = path.join(os.tmpdir(), `omniagent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return path.join(dir, 'transcript.boundaries.jsonl');
}

const SID = 'sess-abc-123' as UUID;
const SID2 = 'sess-xyz-456' as UUID;

// ============================================================
// 工厂函数
// ============================================================

test('generateBoundaryId: 格式正确', () => {
  const id = generateBoundaryId(SID);
  assert.ok(typeof id === 'string');
  assert.ok(id.length > 0);
  // 应含 transcriptId 前 8 字符
  assert.ok(id.includes(SID.slice(0, 8)));
});

test('generateBoundaryId: 每次生成不同', () => {
  const id1 = generateBoundaryId(SID);
  const id2 = generateBoundaryId(SID);
  assert.notEqual(id1, id2);
});

test('nowTimestamp: ISO 8601 格式', () => {
  const ts = nowTimestamp();
  assert.ok(typeof ts === 'string');
  // ISO 8601 基本格式校验
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('createBoundary: 生成完整 CompactBoundary', () => {
  const b = createBoundary({
    transcriptId: SID,
    compactRange: { start: 0, end: 10 },
    tokensBefore: 5000,
    tokensAfter: 1500,
    triggerLayer: 'L2_session',
  });
  assert.ok(b.boundary_id);
  assert.equal(b.transcriptId, SID);
  assert.deepEqual(b.compactRange, { start: 0, end: 10 });
  assert.equal(b.tokensBefore, 5000);
  assert.equal(b.tokensAfter, 1500);
  assert.equal(b.triggerLayer, 'L2_session');
  assert.ok(b.timestamp);
});

test('defaultBoundaryPath: 含 sessionId 与 .boundaries.jsonl 后缀', () => {
  const p = defaultBoundaryPath('sess-123');
  assert.ok(p.includes('sess-123'));
  assert.ok(p.endsWith('.boundaries.jsonl'));
  assert.ok(p.includes('.omniagent'));
});

// ============================================================
// BoundaryStore 基础操作
// ============================================================

test('BoundaryStore: append + get', async () => {
  const filePath = tmpBoundaryPath();
  try {
    const store = new BoundaryStore({ boundaryPath: filePath });
    const b = createBoundary({
      transcriptId: SID,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 300,
      triggerLayer: 'L1_micro',
    });
    await store.append(b);
    const got = await store.get(b.boundary_id);
    assert.ok(got);
    assert.equal(got?.boundary_id, b.boundary_id);
    assert.equal(got?.transcriptId, SID);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('BoundaryStore: getLast 返回最近 boundary', async () => {
  const filePath = tmpBoundaryPath();
  try {
    const store = new BoundaryStore({ boundaryPath: filePath });
    const b1 = createBoundary({
      transcriptId: SID,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 300,
      triggerLayer: 'L1_micro',
    });
    // 确保 timestamp 不同
    await new Promise(r => setTimeout(r, 10));
    const b2 = createBoundary({
      transcriptId: SID,
      compactRange: { start: 6, end: 15 },
      tokensBefore: 2000,
      tokensAfter: 500,
      triggerLayer: 'L2_session',
    });
    await store.append(b1);
    await store.append(b2);
    const last = await store.getLast(SID);
    assert.ok(last);
    assert.equal(last?.boundary_id, b2.boundary_id, '应返回 b2（后追加的）');
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('BoundaryStore: getLast 无 boundary 返回 undefined', async () => {
  const filePath = tmpBoundaryPath();
  try {
    const store = new BoundaryStore({ boundaryPath: filePath });
    const last = await store.getLast(SID);
    assert.equal(last, undefined);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('BoundaryStore: listByTranscript 过滤不同 transcript', async () => {
  const filePath = tmpBoundaryPath();
  try {
    const store = new BoundaryStore({ boundaryPath: filePath });
    const b1 = createBoundary({
      transcriptId: SID,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 300,
      triggerLayer: 'L1_micro',
    });
    const b2 = createBoundary({
      transcriptId: SID2,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 300,
      triggerLayer: 'L1_micro',
    });
    const b3 = createBoundary({
      transcriptId: SID,
      compactRange: { start: 6, end: 10 },
      tokensBefore: 800,
      tokensAfter: 200,
      triggerLayer: 'L2_session',
    });
    await store.append(b1);
    await store.append(b2);
    await store.append(b3);
    const list1 = await store.listByTranscript(SID);
    assert.equal(list1.length, 2);
    const list2 = await store.listByTranscript(SID2);
    assert.equal(list2.length, 1);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('BoundaryStore: listAll 返回全部按时间排序', async () => {
  const filePath = tmpBoundaryPath();
  try {
    const store = new BoundaryStore({ boundaryPath: filePath });
    // 故意乱序 append
    const b1 = createBoundary({
      transcriptId: SID,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 300,
      triggerLayer: 'L1_micro',
    });
    await new Promise(r => setTimeout(r, 10));
    const b2 = createBoundary({
      transcriptId: SID,
      compactRange: { start: 6, end: 10 },
      tokensBefore: 800,
      tokensAfter: 200,
      triggerLayer: 'L2_session',
    });
    await new Promise(r => setTimeout(r, 10));
    const b3 = createBoundary({
      transcriptId: SID,
      compactRange: { start: 11, end: 20 },
      tokensBefore: 1500,
      tokensAfter: 400,
      triggerLayer: 'L3_api_summary',
    });
    // 乱序写入
    await store.append(b3);
    await store.append(b1);
    await store.append(b2);
    const all = await store.listAll();
    assert.equal(all.length, 3);
    // 按 timestamp 升序
    assert.equal(all[0].boundary_id, b1.boundary_id);
    assert.equal(all[1].boundary_id, b2.boundary_id);
    assert.equal(all[2].boundary_id, b3.boundary_id);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// 持久化与重载
// ============================================================

test('BoundaryStore: 重启后从文件加载（缓存失效）', async () => {
  const filePath = tmpBoundaryPath();
  try {
    const store1 = new BoundaryStore({ boundaryPath: filePath });
    const b = createBoundary({
      transcriptId: SID,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 300,
      triggerLayer: 'L1_micro',
    });
    await store1.append(b);
    // 新建 store（模拟重启）
    const store2 = new BoundaryStore({ boundaryPath: filePath });
    const got = await store2.get(b.boundary_id);
    assert.ok(got);
    assert.equal(got?.boundary_id, b.boundary_id);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('BoundaryStore: 文件不存在时不抛错（返回空）', async () => {
  const filePath = tmpBoundaryPath();
  try {
    const store = new BoundaryStore({ boundaryPath: filePath });
    const all = await store.listAll();
    assert.deepEqual(all, []);
    const last = await store.getLast(SID);
    assert.equal(last, undefined);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('BoundaryStore: count 返回总数', async () => {
  const filePath = tmpBoundaryPath();
  try {
    const store = new BoundaryStore({ boundaryPath: filePath });
    assert.equal(await store.count(), 0);
    await store.append(createBoundary({
      transcriptId: SID,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 300,
      triggerLayer: 'L1_micro',
    }));
    await store.append(createBoundary({
      transcriptId: SID,
      compactRange: { start: 6, end: 10 },
      tokensBefore: 800,
      tokensAfter: 200,
      triggerLayer: 'L2_session',
    }));
    assert.equal(await store.count(), 2);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('BoundaryStore: clear 清空文件与缓存', async () => {
  const filePath = tmpBoundaryPath();
  try {
    const store = new BoundaryStore({ boundaryPath: filePath });
    await store.append(createBoundary({
      transcriptId: SID,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 300,
      triggerLayer: 'L1_micro',
    }));
    assert.equal(await store.count(), 1);
    await store.clear();
    assert.equal(await store.count(), 0);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ============================================================
// JSONL 格式
// ============================================================

test('BoundaryStore: 持久化为 JSONL（每行一个 boundary）', async () => {
  const filePath = tmpBoundaryPath();
  try {
    const store = new BoundaryStore({ boundaryPath: filePath });
    for (let i = 0; i < 3; i++) {
      await store.append(createBoundary({
        transcriptId: SID,
        compactRange: { start: i * 5, end: i * 5 + 5 },
        tokensBefore: 1000,
        tokensAfter: 300,
        triggerLayer: 'L1_micro',
      }));
    }
    const text = await fs.readFile(filePath, 'utf8');
    const lines = text.split('\n').filter(l => l.trim());
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as CompactBoundary;
      assert.ok(parsed.boundary_id);
      assert.ok(parsed.transcriptId);
      assert.ok(parsed.compactRange);
      assert.ok(parsed.timestamp);
    }
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});
