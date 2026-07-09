import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { ResumeService, resumeService, type SessionMetadata } from '../../src/memory/resume.js';
import { TranscriptStore } from '../../src/memory/transcript.js';
import { BoundaryStore, createBoundary } from '../../src/memory/boundary.js';
import type { Message, SessionId, UUID } from '../../src/types/index.js';

function tmpTranscriptDir(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-resume-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
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
// 基础 resume 流程
// ============================================================

test('ResumeService: 正常 resume 返回 ResumedSession', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-123' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    const msgs = makeChain(['hello', 'world']);
    for (const m of msgs) await transcript.append(m);
    await transcript.flush();
    await transcript.close();

    const meta: SessionMetadata = {
      sessionId: sid,
      permissionMode: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const svc = new ResumeService({ transcriptDir: dir });
    await svc.writeSessionMetadata(meta);

    const result = await svc.resume(sid, 'default');
    assert.equal(result.ok, true);
    assert.ok(result.session);
    assert.equal(result.session?.sessionId, sid);
    assert.equal(result.session?.mode, 'default');
    assert.equal(result.session?.messages.length, 2);
    assert.equal(result.session?.transcript.path, transcriptPath);
    await result.session?.transcript.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ResumeService: transcript 不存在返回 SCENARIO_TRANSCRIPT_NOT_FOUND', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-not-found' as SessionId;
    const svc = new ResumeService({ transcriptDir: dir });
    const result = await svc.resume(sid, 'default');
    assert.equal(result.ok, false);
    assert.equal(result.scenario, 'SCENARIO_TRANSCRIPT_NOT_FOUND');
    assert.match(result.detail ?? '', /not found/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ResumeService: 链路完整 → ok=true', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-chain-ok' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    const msgs = makeChain(['a', 'b', 'c', 'd']);
    for (const m of msgs) await transcript.append(m);
    await transcript.flush();
    await transcript.close();

    const svc = new ResumeService({ transcriptDir: dir });
    await svc.writeSessionMetadata({
      sessionId: sid,
      permissionMode: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await svc.resume(sid, 'default');
    assert.equal(result.ok, true);
    assert.equal(result.session?.messages.length, 4);
    await result.session?.transcript.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// walkChainBeforeParse 集成
// ============================================================

test('ResumeService: 首条消息 parentUuid 错误 → SCENARIO_TRANSCRIPT_CORRUPT', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-bad-first' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    const bad = makeMessage({
      role: 'user',
      text: 'first',
      parentUuid: 'should-not-have' as UUID,
    });
    await transcript.append(bad);
    await transcript.flush();
    await transcript.close();

    const svc = new ResumeService({ transcriptDir: dir });
    await svc.writeSessionMetadata({
      sessionId: sid,
      permissionMode: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await svc.resume(sid, 'default');
    assert.equal(result.ok, false);
    assert.equal(result.scenario, 'SCENARIO_TRANSCRIPT_CORRUPT');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ResumeService: 中间断链 → SCENARIO_TRANSCRIPT_CORRUPT', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-broken-mid' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    const msgs = makeChain(['a', 'b', 'c']);
    // 篡改第 2 条消息的 parentUuid
    msgs[1].parentUuid = 'wrong-uuid' as UUID;
    for (const m of msgs) await transcript.append(m);
    await transcript.flush();
    await transcript.close();

    const svc = new ResumeService({ transcriptDir: dir });
    await svc.writeSessionMetadata({
      sessionId: sid,
      permissionMode: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await svc.resume(sid, 'default');
    assert.equal(result.ok, false);
    assert.equal(result.scenario, 'SCENARIO_TRANSCRIPT_CORRUPT');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ResumeService: 缺 parentUuid → SCENARIO_FORK_METADATA_MISSING', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-missing-parent' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    const m1 = makeMessage({ role: 'user', text: 'first' });
    const m2 = makeMessage({ role: 'user', text: 'second', parentUuid: undefined });
    await transcript.append(m1);
    await transcript.append(m2);
    await transcript.flush();
    await transcript.close();

    const svc = new ResumeService({ transcriptDir: dir });
    await svc.writeSessionMetadata({
      sessionId: sid,
      permissionMode: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await svc.resume(sid, 'default');
    assert.equal(result.ok, false);
    assert.equal(result.scenario, 'SCENARIO_FORK_METADATA_MISSING');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// mode 字段校验（场景 9）
// ============================================================

test('ResumeService: mode 一致 → ok', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-mode-ok' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    for (const m of makeChain(['x'])) await transcript.append(m);
    await transcript.flush();
    await transcript.close();

    const svc = new ResumeService({ transcriptDir: dir });
    await svc.writeSessionMetadata({
      sessionId: sid,
      permissionMode: 'acceptEdits',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await svc.resume(sid, 'acceptEdits');
    assert.equal(result.ok, true);
    assert.equal(result.session?.mode, 'acceptEdits');
    await result.session?.transcript.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ResumeService: mode 不一致 → SCENARIO_MODE_MISMATCH + needsUserConfirm', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-mode-mismatch' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    for (const m of makeChain(['x'])) await transcript.append(m);
    await transcript.flush();
    await transcript.close();

    const svc = new ResumeService({ transcriptDir: dir });
    await svc.writeSessionMetadata({
      sessionId: sid,
      permissionMode: 'bypassPermissions',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await svc.resume(sid, 'default');
    assert.equal(result.ok, false);
    assert.equal(result.scenario, 'SCENARIO_MODE_MISMATCH');
    assert.equal(result.needsUserConfirm, true);
    assert.match(result.detail ?? '', /bypassPermissions/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ResumeService: 元数据缺失 → 接受 expectedMode', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-no-meta' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    for (const m of makeChain(['x'])) await transcript.append(m);
    await transcript.flush();
    await transcript.close();

    const svc = new ResumeService({ transcriptDir: dir });
    // 不写元数据
    const result = await svc.resume(sid, 'plan');
    assert.equal(result.ok, true);
    assert.equal(result.session?.mode, 'plan');
    await result.session?.transcript.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// CompactBoundary 还原
// ============================================================

test('ResumeService: 含 boundary → lastBoundary 返回最近', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-with-boundary' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const boundaryPath = path.join(dir, `${sid}.boundaries.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    for (const m of makeChain(['x', 'y'])) await transcript.append(m);
    await transcript.flush();
    await transcript.close();

    const boundaryStore = new BoundaryStore({ boundaryPath });
    const b1 = createBoundary({
      transcriptId: sid as unknown as UUID,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 300,
      triggerLayer: 'L1_micro',
    });
    await new Promise(r => setTimeout(r, 10));
    const b2 = createBoundary({
      transcriptId: sid as unknown as UUID,
      compactRange: { start: 6, end: 10 },
      tokensBefore: 2000,
      tokensAfter: 500,
      triggerLayer: 'L2_session',
    });
    await boundaryStore.append(b1);
    await boundaryStore.append(b2);

    const svc = new ResumeService({ transcriptDir: dir, boundaryStore });
    await svc.writeSessionMetadata({
      sessionId: sid,
      permissionMode: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await svc.resume(sid, 'default');
    assert.equal(result.ok, true);
    assert.ok(result.session?.lastBoundary);
    assert.equal(result.session?.lastBoundary?.boundary_id, b2.boundary_id);
    await result.session?.transcript.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ResumeService: 无 boundary → lastBoundary undefined', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-no-boundary' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    for (const m of makeChain(['x'])) await transcript.append(m);
    await transcript.flush();
    await transcript.close();

    const svc = new ResumeService({ transcriptDir: dir });
    await svc.writeSessionMetadata({
      sessionId: sid,
      permissionMode: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await svc.resume(sid, 'default');
    assert.equal(result.ok, true);
    assert.equal(result.session?.lastBoundary, undefined);
    await result.session?.transcript.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// hasSession + writeSessionMetadata
// ============================================================

test('ResumeService.hasSession: 存在返回 true', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-exists' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    for (const m of makeChain(['x'])) await transcript.append(m);
    await transcript.flush();
    await transcript.close();

    const svc = new ResumeService({ transcriptDir: dir });
    assert.equal(await svc.hasSession(sid), true);
    assert.equal(await svc.hasSession('sess-not-exist' as SessionId), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ResumeService.writeSessionMetadata + readStoredMode', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-meta' as SessionId;
    const svc = new ResumeService({ transcriptDir: dir });
    const meta: SessionMetadata = {
      sessionId: sid,
      permissionMode: 'auto',
      createdAt: '2026-07-09T10:00:00.000Z',
      updatedAt: '2026-07-09T10:00:00.000Z',
      provider: 'openai',
      model: 'gpt-4',
    };
    await svc.writeSessionMetadata(meta);
    const got = await svc.readStoredMode(sid);
    assert.ok(got);
    assert.equal(got?.sessionId, sid);
    assert.equal(got?.permissionMode, 'auto');
    assert.equal(got?.provider, 'openai');
    assert.equal(got?.model, 'gpt-4');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ResumeService.readStoredMode: 不存在返回 undefined', async () => {
  const dir = tmpTranscriptDir();
  try {
    const svc = new ResumeService({ transcriptDir: dir });
    const got = await svc.readStoredMode('sess-no-meta' as SessionId);
    assert.equal(got, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 单例
// ============================================================

test('resumeService 单例可用', () => {
  assert.ok(resumeService);
  assert.equal(typeof resumeService.resume, 'function');
});

// ============================================================
// 优先级：链路校验早于 mode 校验
// ============================================================

test('ResumeService: 链路损坏优先于 mode 不匹配', async () => {
  const dir = tmpTranscriptDir();
  try {
    const sid = 'sess-both-bad' as SessionId;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    const transcript = await TranscriptStore.load(transcriptPath);
    const bad = makeMessage({
      role: 'user',
      text: 'first',
      parentUuid: 'should-not-have' as UUID,
    });
    await transcript.append(bad);
    await transcript.flush();
    await transcript.close();

    const svc = new ResumeService({ transcriptDir: dir });
    await svc.writeSessionMetadata({
      sessionId: sid,
      permissionMode: 'bypassPermissions',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // 链路损坏 + mode 不匹配 → 应先报链路损坏
    const result = await svc.resume(sid, 'default');
    assert.equal(result.ok, false);
    assert.equal(result.scenario, 'SCENARIO_TRANSCRIPT_CORRUPT');
    assert.notEqual(result.scenario, 'SCENARIO_MODE_MISMATCH');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
