import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  SidechainManager,
  LocalMemoryEngine,
  defaultSidechainPath,
  generateSidechainId,
} from '../../src/memory/sidechain.js';
import { TranscriptStore } from '../../src/memory/transcript.js';
import { BoundaryStore, createBoundary } from '../../src/memory/boundary.js';
import type {
  AgentId,
  BoundaryId,
  CompactBoundary,
  Message,
  TaskId,
  UUID,
} from '../../src/types/index.js';

// ============================================================
// 测试 helpers
// ============================================================

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `omniagent-sidechain-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

/** 用 HOME 指向临时目录，让 defaultTranscriptPath/defaultSidechainPath 都落在其中 */
function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const tmp = tmpDir();
  const oldHome = process.env.HOME;
  process.env.HOME = tmp;
  return fn().finally(async () => {
    process.env.HOME = oldHome;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
}

// ============================================================
// 路径 helper
// ============================================================

test('defaultSidechainPath: 格式正确', () => {
  const oldHome = process.env.HOME;
  process.env.HOME = '/tmp/test-home';
  try {
    const p = defaultSidechainPath('session-123', 'side-456' as UUID);
    assert.match(
      p,
      /\/tmp\/test-home\/\.omniagent\/transcript\/session-123\.sidechain-side-456\.jsonl$/,
    );
  } finally {
    process.env.HOME = oldHome;
  }
});

test('generateSidechainId: 返回 UUID 字符串', () => {
  const id1 = generateSidechainId();
  const id2 = generateSidechainId();
  assert.notEqual(id1, id2, '每次生成的 id 应唯一');
  assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// ============================================================
// LocalMemoryEngine
// ============================================================

test('LocalMemoryEngine: createSidechain 写入 initialMessages', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    // 主 transcript 写入 fork point
    const forkMsgs = makeChain(['parent-msg-1', 'parent-msg-2']);
    for (const m of forkMsgs) await mainStore.append(m);
    await mainStore.flush();

    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainId = await engine.createSidechain({
      parentUuid: forkMsgs[1].id!,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [
        makeMessage({ role: 'user', text: 'fork-prompt', parentUuid: forkMsgs[1].id }),
        makeMessage({ role: 'assistant', text: 'fork-response' }),
      ],
    });

    assert.ok(sidechainId, '应返回非空 sidechainId');
    assert.equal(engine.activeCount(), 1, '应有一个活跃 sidechain');

    const sideMsgs = await engine.readSidechain(sidechainId);
    assert.equal(sideMsgs.length, 2, 'initialMessages 应已持久化');
    assert.equal((sideMsgs[0].content[0] as { text: string }).text, 'fork-prompt');
    assert.equal((sideMsgs[1].content[0] as { text: string }).text, 'fork-response');

    await engine.closeAll();
    await mainStore.close();
  });
});

test('LocalMemoryEngine: appendSidechain 追加消息到 sidechain', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);

    const sidechainId = await engine.createSidechain({
      parentUuid: 'fork-1' as UUID,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'init' })],
    });

    // 追加新消息
    await engine.appendSidechain(sidechainId, makeMessage({ role: 'assistant', text: 'more' }));
    await engine.flushSidechain(sidechainId);

    const sideMsgs = await engine.readSidechain(sidechainId);
    assert.equal(sideMsgs.length, 2, 'init + 追加 = 2 条');
    assert.equal((sideMsgs[1].content[0] as { text: string }).text, 'more');

    await engine.closeAll();
    await mainStore.close();
  });
});

test('LocalMemoryEngine: appendSidechain 不存在的 sidechain 抛错', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);

    await assert.rejects(
      () => engine.appendSidechain('nonexistent' as UUID, makeMessage({ role: 'user', text: 'x' })),
      /sidechain not found/,
    );

    await engine.closeAll();
    await mainStore.close();
  });
});

test('LocalMemoryEngine: readSidechain 不存在抛错', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);

    await assert.rejects(
      () => engine.readSidechain('nonexistent' as UUID),
      /sidechain not found/,
    );

    await engine.closeAll();
    await mainStore.close();
  });
});

test('LocalMemoryEngine: flushSidechain 不存在抛错', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);

    await assert.rejects(
      () => engine.flushSidechain('nonexistent' as UUID),
      /sidechain not found/,
    );

    await engine.closeAll();
    await mainStore.close();
  });
});

test('LocalMemoryEngine: 多个 sidechain 并存', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);

    const id1 = await engine.createSidechain({
      parentUuid: 'fork-1' as UUID,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'side-1-init' })],
    });
    const id2 = await engine.createSidechain({
      parentUuid: 'fork-2' as UUID,
      runtimeTaskId: 'task-2' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'side-2-init' })],
    });

    assert.notEqual(id1, id2, '两个 sidechain id 应不同');
    assert.equal(engine.activeCount(), 2, '应有 2 个活跃 sidechain');

    const m1 = await engine.readSidechain(id1);
    const m2 = await engine.readSidechain(id2);
    assert.equal((m1[0].content[0] as { text: string }).text, 'side-1-init');
    assert.equal((m2[0].content[0] as { text: string }).text, 'side-2-init');

    await engine.closeAll();
    await mainStore.close();
  });
});

test('LocalMemoryEngine: closeSidechain 移除并释放资源', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);

    const sidechainId = await engine.createSidechain({
      parentUuid: 'fork-1' as UUID,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'init' })],
    });

    assert.equal(engine.activeCount(), 1);
    await engine.closeSidechain(sidechainId);
    assert.equal(engine.activeCount(), 0);

    // 关闭后再读应抛错
    await assert.rejects(
      () => engine.readSidechain(sidechainId),
      /sidechain not found/,
    );

    await engine.closeAll();
    await mainStore.close();
  });
});

test('LocalMemoryEngine: getCurrentMessages 返回主 transcript 内容', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const chain = makeChain(['m1', 'm2', 'm3']);
    for (const m of chain) await mainStore.append(m);
    await mainStore.flush();

    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const agentId = 'main-agent' as AgentId;
    const msgs = await engine.getCurrentMessages(agentId);

    assert.equal(msgs.length, 3);
    assert.equal((msgs[0].content[0] as { text: string }).text, 'm1');
    assert.equal((msgs[2].content[0] as { text: string }).text, 'm3');

    await engine.closeAll();
    await mainStore.close();
  });
});

test('LocalMemoryEngine: sidechain 与主 transcript 文件独立', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainPath = path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`);
    const mainStore = await TranscriptStore.load(mainPath);

    // 主 transcript 写消息
    for (const m of makeChain(['main-1', 'main-2'])) await mainStore.append(m);
    await mainStore.flush();

    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainId = await engine.createSidechain({
      parentUuid: 'fork-1' as UUID,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'side-1' })],
    });
    await engine.flushSidechain(sidechainId);

    // 主 transcript 应只有 2 条
    const mainMsgs = await mainStore.readRaw();
    assert.equal(mainMsgs.length, 2, '主 transcript 不应被 sidechain 污染');

    // sidechain 应只有 1 条
    const sideMsgs = await engine.readSidechain(sidechainId);
    assert.equal(sideMsgs.length, 1, 'sidechain 不应包含主 transcript 消息');

    // 文件路径不同
    const sidePath = defaultSidechainPath(sessionId, sidechainId);
    assert.notEqual(sidePath, mainPath);

    await engine.closeAll();
    await mainStore.close();
  });
});

test('LocalMemoryEngine: sidechainMeta 记录 parentUuid + runtimeTaskId', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);

    const parentUuid = randomUUID() as UUID;
    const runtimeTaskId = 'rt-task-42' as TaskId;
    const sidechainId = await engine.createSidechain({
      parentUuid,
      runtimeTaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'init' })],
    });

    const meta = engine.getSidechainMeta(sidechainId);
    assert.ok(meta);
    assert.equal(meta!.parentUuid, parentUuid);
    assert.equal(meta!.runtimeTaskId, runtimeTaskId);

    await engine.closeAll();
    await mainStore.close();
  });
});

test('LocalMemoryEngine: createSidechain 无 initialMessages 不报错', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);

    const sidechainId = await engine.createSidechain({
      parentUuid: 'fork-1' as UUID,
      runtimeTaskId: 'task-1' as TaskId,
      // 不传 initialMessages
    });

    const sideMsgs = await engine.readSidechain(sidechainId);
    assert.equal(sideMsgs.length, 0, '无 initialMessages 时 sidechain 为空');

    await engine.closeAll();
    await mainStore.close();
  });
});

// ============================================================
// SidechainManager facade
// ============================================================

test('SidechainManager: create 读取 fork point 作为 parentUuid', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    // 主 transcript 写消息（最后一条 id 作为 fork point）
    const chain = makeChain(['m1', 'm2']);
    for (const m of chain) await mainStore.append(m);
    await mainStore.flush();

    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const manager = new SidechainManager(engine);

    const sidechainId = await manager.create({
      parentTranscriptId: 'main-agent' as AgentId,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'fork-prompt' })],
    });

    const meta = engine.getSidechainMeta(sidechainId);
    assert.ok(meta);
    assert.equal(meta!.parentUuid, chain[1].id, 'parentUuid 应指向主 transcript 最后一条消息 id');

    await engine.closeAll();
    await mainStore.close();
  });
});

test('SidechainManager: create 主 transcript 为空时 parentUuid 回退到 agentId', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    // 主 transcript 空文件

    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const manager = new SidechainManager(engine);
    const agentId = 'main-agent' as AgentId;

    const sidechainId = await manager.create({
      parentTranscriptId: agentId,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'init' })],
    });

    const meta = engine.getSidechainMeta(sidechainId);
    assert.ok(meta);
    // 主 transcript 空时，parentUuid 回退到 agentId（字符串）
    assert.equal(meta!.parentUuid, agentId as unknown as UUID);

    await engine.closeAll();
    await mainStore.close();
  });
});

test('SidechainManager: append / read / flush / close 委托正确', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const manager = new SidechainManager(engine);

    const sidechainId = await manager.create({
      parentTranscriptId: 'main-agent' as AgentId,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'init' })],
    });

    // append
    await manager.append(sidechainId, makeMessage({ role: 'assistant', text: 'response-1' }));
    await manager.append(sidechainId, makeMessage({ role: 'assistant', text: 'response-2' }));
    await manager.flush(sidechainId);

    // read
    const msgs = await manager.read(sidechainId);
    assert.equal(msgs.length, 3, 'init + 2 append = 3 条');

    // close
    await manager.close(sidechainId);
    assert.equal(engine.activeCount(), 0);

    await engine.closeAll();
    await mainStore.close();
  });
});

// ============================================================
// Boundary 独立性（CompactBoundary.transcriptId 区分主 vs sidechain）
// ============================================================

test('BoundaryStore: 按 transcriptId 区分主 transcript 与 sidechain 的 boundary', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainPath = path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`);
    const mainStore = await TranscriptStore.load(mainPath);

    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const sidechainId = await engine.createSidechain({
      parentUuid: 'fork-1' as UUID,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'side-init' })],
    });

    // 主 transcript 与 sidechain 的 transcriptId 不同
    const mainTranscriptId = sessionId as UUID;
    const sideTranscriptId = sidechainId;

    const boundaryPath = path.join(
      process.env.HOME!,
      '.omniagent',
      'transcript',
      `${sessionId}.boundaries.jsonl`,
    );
    const store = new BoundaryStore({ boundaryPath });

    // 写入主 transcript 的 boundary
    const mainBoundary = createBoundary({
      transcriptId: mainTranscriptId,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 200,
      triggerLayer: 'L2_session',
    });
    await store.append(mainBoundary);

    // 写入 sidechain 的 boundary
    const sideBoundary = createBoundary({
      transcriptId: sideTranscriptId,
      compactRange: { start: 0, end: 3 },
      tokensBefore: 500,
      tokensAfter: 100,
      triggerLayer: 'L1_micro',
    });
    await store.append(sideBoundary);

    // 查询主 transcript 的 boundary
    const mainBoundaries = await store.listByTranscript(mainTranscriptId);
    assert.equal(mainBoundaries.length, 1, '主 transcript 只应返回它自己的 boundary');
    assert.equal(mainBoundaries[0].transcriptId, mainTranscriptId);

    // 查询 sidechain 的 boundary
    const sideBoundaries = await store.listByTranscript(sideTranscriptId);
    assert.equal(sideBoundaries.length, 1, 'sidechain 只应返回它自己的 boundary');
    assert.equal(sideBoundaries[0].transcriptId, sideTranscriptId);

    // 两个 boundary 的 transcriptId 不相同
    assert.notEqual(mainBoundaries[0].transcriptId, sideBoundaries[0].transcriptId);

    await engine.closeAll();
    await mainStore.close();
  });
});

test('CompactBoundary.transcriptId: 主与 sidechain 不互相污染', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const boundaryPath = path.join(
      process.env.HOME!,
      '.omniagent',
      'transcript',
      `${sessionId}.boundaries.jsonl`,
    );
    const store = new BoundaryStore({ boundaryPath });

    // 模拟 sidechain 的 transcriptId 是它自己的 UUID（与主 transcript 的 sessionId 不同）
    const mainId = sessionId as UUID;
    const side1Id = randomUUID() as UUID;
    const side2Id = randomUUID() as UUID;

    // 主 1 个，side1 2 个，side2 1 个
    await store.append(createBoundary({
      transcriptId: mainId,
      compactRange: { start: 0, end: 10 },
      tokensBefore: 1000,
      tokensAfter: 200,
      triggerLayer: 'L2_session',
    }));
    await store.append(createBoundary({
      transcriptId: side1Id,
      compactRange: { start: 0, end: 2 },
      tokensBefore: 100,
      tokensAfter: 50,
      triggerLayer: 'L1_micro',
    }));
    await store.append(createBoundary({
      transcriptId: side1Id,
      compactRange: { start: 3, end: 5 },
      tokensBefore: 80,
      tokensAfter: 30,
      triggerLayer: 'L1_micro',
    }));
    await store.append(createBoundary({
      transcriptId: side2Id,
      compactRange: { start: 0, end: 1 },
      tokensBefore: 50,
      tokensAfter: 20,
      triggerLayer: 'L1_micro',
    }));

    const mainB = await store.listByTranscript(mainId);
    const side1B = await store.listByTranscript(side1Id);
    const side2B = await store.listByTranscript(side2Id);

    assert.equal(mainB.length, 1);
    assert.equal(side1B.length, 2, 'side1 应有 2 个 boundary');
    assert.equal(side2B.length, 1);

    // 主与 side 之间互不重叠
    assert.equal(mainB[0].transcriptId, mainId);
    assert.notEqual(side1B[0].transcriptId, mainId);
    assert.notEqual(side1B[1].transcriptId, mainId);
    assert.notEqual(side2B[0].transcriptId, mainId);
  });
});

test('CompactBoundary.transcriptId: sidechain boundary 不影响主 transcript getLast', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const boundaryPath = path.join(
      process.env.HOME!,
      '.omniagent',
      'transcript',
      `${sessionId}.boundaries.jsonl`,
    );
    const store = new BoundaryStore({ boundaryPath });

    const mainId = sessionId as UUID;
    const sideId = randomUUID() as UUID;

    // 主 boundary 在前
    await store.append(createBoundary({
      transcriptId: mainId,
      compactRange: { start: 0, end: 5 },
      tokensBefore: 1000,
      tokensAfter: 200,
      triggerLayer: 'L2_session',
    }));
    // side boundary 在后（时间戳更晚）
    await new Promise(r => setTimeout(r, 10));
    await store.append(createBoundary({
      transcriptId: sideId,
      compactRange: { start: 0, end: 3 },
      tokensBefore: 500,
      tokensAfter: 100,
      triggerLayer: 'L1_micro',
    }));

    // getLast(主) 不应返回 side 的 boundary
    const lastMain = await store.getLast(mainId);
    assert.ok(lastMain);
    assert.equal(lastMain!.transcriptId, mainId, 'getLast(主) 应只看主 transcript 的 boundary');
    assert.equal(lastMain!.triggerLayer, 'L2_session');

    // getLast(side) 应返回 side 的 boundary
    const lastSide = await store.getLast(sideId);
    assert.ok(lastSide);
    assert.equal(lastSide!.transcriptId, sideId);
    assert.equal(lastSide!.triggerLayer, 'L1_micro');
  });
});

// ============================================================
// sidechain 链路完整性（walkChainBeforeParse）
// ============================================================

test('SidechainManager: initialMessages 首条 parentUuid 指向 fork point 通过链路校验', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainPath = path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`);
    const mainStore = await TranscriptStore.load(mainPath);

    // 主 transcript 写消息
    const chain = makeChain(['m1', 'm2']);
    for (const m of chain) await mainStore.append(m);
    await mainStore.flush();

    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const manager = new SidechainManager(engine);

    // fork point 是主 transcript 最后一条消息
    const forkPointId = chain[1].id!;
    const sidechainId = await manager.create({
      parentTranscriptId: 'main-agent' as AgentId,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [
        makeMessage({ role: 'user', text: 'fork-prompt', parentUuid: forkPointId }),
      ],
    });

    // 读取 sidechain 文件直接用 TranscriptStore.load 校验链路
    const sideStore = await TranscriptStore.load(defaultSidechainPath(sessionId, sidechainId));
    await manager.flush(sidechainId);
    const check = await sideStore.walkChainBeforeParse();
    assert.ok(check.ok, `sidechain 链路应完整：${check.detail ?? ''}`);

    await sideStore.close();
    await engine.closeAll();
    await mainStore.close();
  });
});

test('SidechainManager: 多 sidechain 并行 ReActLoop 写入不互相污染', async () => {
  await withTempHome(async () => {
    const sessionId = randomUUID();
    const mainStore = await TranscriptStore.load(
      path.join(process.env.HOME!, '.omniagent', 'transcript', `${sessionId}.jsonl`),
    );
    const engine = new LocalMemoryEngine(sessionId, mainStore);
    const manager = new SidechainManager(engine);

    const id1 = await manager.create({
      parentTranscriptId: 'main-agent' as AgentId,
      runtimeTaskId: 'task-1' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'side-1-init' })],
    });
    const id2 = await manager.create({
      parentTranscriptId: 'main-agent' as AgentId,
      runtimeTaskId: 'task-2' as TaskId,
      initialMessages: [makeMessage({ role: 'user', text: 'side-2-init' })],
    });

    // 交替写入（模拟并行 ReActLoop）
    await manager.append(id1, makeMessage({ role: 'assistant', text: 'side-1-r1' }));
    await manager.append(id2, makeMessage({ role: 'assistant', text: 'side-2-r1' }));
    await manager.append(id1, makeMessage({ role: 'assistant', text: 'side-1-r2' }));
    await manager.append(id2, makeMessage({ role: 'assistant', text: 'side-2-r2' }));
    await manager.flush(id1);
    await manager.flush(id2);

    const m1 = await manager.read(id1);
    const m2 = await manager.read(id2);

    assert.equal(m1.length, 3, 'side-1 应有 init + 2 条追加');
    assert.equal(m2.length, 3, 'side-2 应有 init + 2 条追加');
    // 验证内容没串
    assert.equal((m1[0].content[0] as { text: string }).text, 'side-1-init');
    assert.equal((m1[1].content[0] as { text: string }).text, 'side-1-r1');
    assert.equal((m1[2].content[0] as { text: string }).text, 'side-1-r2');
    assert.equal((m2[0].content[0] as { text: string }).text, 'side-2-init');
    assert.equal((m2[1].content[0] as { text: string }).text, 'side-2-r1');
    assert.equal((m2[2].content[0] as { text: string }).text, 'side-2-r2');

    await engine.closeAll();
    await mainStore.close();
  });
});
