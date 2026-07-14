import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TeammateRegistry } from '../../src/orchestration/teammate-registry.js';
import type { AgentId, MailboxName } from '../../src/types/index.js';

// ============================================================
// 测试 helpers
// ============================================================

function makeAgentId(s: string): AgentId {
  return s as AgentId;
}
function makeMailboxName(s: string): MailboxName {
  return s as MailboxName;
}

// ============================================================
// register
// ============================================================

test('TeammateRegistry.register: 注册 teammate', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  assert.equal(reg.size(), 1);
});

test('TeammateRegistry.register: 重复 name 抛错（不变量 #2）', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  await assert.rejects(
    () => reg.register({
      name: makeMailboxName('alice'),
      agentId: makeAgentId('agent-alice-002'),
      parentAgentId: makeAgentId('leader'),
    }),
    /already registered/,
  );
  assert.equal(reg.size(), 1, '冲突时不应增加');
});

test('TeammateRegistry.register: 重复 agentId 抛错', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  await assert.rejects(
    () => reg.register({
      name: makeMailboxName('bob'),
      agentId: makeAgentId('agent-alice-001'),  // 同 agentId
      parentAgentId: makeAgentId('leader'),
    }),
    /already registered as teammate/,
  );
  assert.equal(reg.size(), 1);
});

test('TeammateRegistry.register: 多个 teammate 并存', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  await reg.register({
    name: makeMailboxName('bob'),
    agentId: makeAgentId('agent-bob-001'),
    parentAgentId: makeAgentId('leader'),
  });
  await reg.register({
    name: makeMailboxName('carol'),
    agentId: makeAgentId('agent-carol-001'),
    parentAgentId: makeAgentId('leader'),
  });
  assert.equal(reg.size(), 3);
});

test('TeammateRegistry.register: 自定义 registeredAt', async () => {
  const reg = new TeammateRegistry();
  const ts = '2026-07-13T10:00:00.000Z' as never;
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
    registeredAt: ts,
  });
  const record = await reg.get(makeMailboxName('alice'));
  assert.equal(record?.registeredAt, ts);
});

test('TeammateRegistry.register: 自动生成 registeredAt', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  const record = await reg.get(makeMailboxName('alice'));
  assert.ok(record?.registeredAt);
  assert.match(record!.registeredAt as string, /^\d{4}-\d{2}-\d{2}T/);
});

// ============================================================
// get / resolve / getByAgentId
// ============================================================

test('TeammateRegistry.get: 返回完整 record', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  const record = await reg.get(makeMailboxName('alice'));
  assert.ok(record);
  assert.equal(record!.agentId, makeAgentId('agent-alice-001'));
  assert.equal(record!.parentAgentId, makeAgentId('leader'));
  assert.ok(record!.registeredAt);
  assert.equal(record!.lastKnownName, makeMailboxName('alice'));
});

test('TeammateRegistry.get: 不存在返回 undefined', async () => {
  const reg = new TeammateRegistry();
  const record = await reg.get(makeMailboxName('nonexistent'));
  assert.equal(record, undefined);
});

test('TeammateRegistry.resolve: 返回 agentId', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  const agentId = await reg.resolve(makeMailboxName('alice'));
  assert.equal(agentId, makeAgentId('agent-alice-001'));
});

test('TeammateRegistry.resolve: 不存在返回 undefined', async () => {
  const reg = new TeammateRegistry();
  const agentId = await reg.resolve(makeMailboxName('nonexistent'));
  assert.equal(agentId, undefined);
});

test('TeammateRegistry.getByAgentId: 反向查询', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  const record = await reg.getByAgentId(makeAgentId('agent-alice-001'));
  assert.ok(record);
  assert.equal(record!.agentId, makeAgentId('agent-alice-001'));
});

test('TeammateRegistry.getByAgentId: 不存在返回 undefined', async () => {
  const reg = new TeammateRegistry();
  const record = await reg.getByAgentId(makeAgentId('nonexistent'));
  assert.equal(record, undefined);
});

// ============================================================
// unregister
// ============================================================

test('TeammateRegistry.unregister: 注销 teammate', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  assert.equal(reg.size(), 1);
  await reg.unregister(makeMailboxName('alice'));
  assert.equal(reg.size(), 0);
  assert.equal(await reg.get(makeMailboxName('alice')), undefined);
  // 反向索引也清除
  assert.equal(await reg.getByAgentId(makeAgentId('agent-alice-001')), undefined);
});

test('TeammateRegistry.unregister: 注销不存在的 name 不抛错', async () => {
  const reg = new TeammateRegistry();
  await reg.unregister(makeMailboxName('nonexistent'));
  assert.equal(reg.size(), 0);
});

test('TeammateRegistry.unregister: 注销后 name 可重新注册', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  await reg.unregister(makeMailboxName('alice'));
  // 重新注册同名（不同 agentId）
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-002'),
    parentAgentId: makeAgentId('leader'),
  });
  assert.equal(reg.size(), 1);
  const record = await reg.get(makeMailboxName('alice'));
  assert.equal(record?.agentId, makeAgentId('agent-alice-002'));
});

// ============================================================
// list / exists / size
// ============================================================

test('TeammateRegistry.list: 列出全部 teammate', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  await reg.register({
    name: makeMailboxName('bob'),
    agentId: makeAgentId('agent-bob-001'),
    parentAgentId: makeAgentId('leader'),
  });
  const list = await reg.list();
  assert.equal(list.length, 2);
  const names = list.map(x => x.name).sort();
  assert.deepEqual(names, ['alice', 'bob']);
});

test('TeammateRegistry.list: 空表返回 []', async () => {
  const reg = new TeammateRegistry();
  const list = await reg.list();
  assert.deepEqual(list, []);
});

test('TeammateRegistry.exists: 已注册返回 true', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  assert.equal(await reg.exists(makeMailboxName('alice')), true);
});

test('TeammateRegistry.exists: 未注册返回 false', async () => {
  const reg = new TeammateRegistry();
  assert.equal(await reg.exists(makeMailboxName('alice')), false);
});

test('TeammateRegistry.size: 返回当前数量', async () => {
  const reg = new TeammateRegistry();
  assert.equal(reg.size(), 0);
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  assert.equal(reg.size(), 1);
  await reg.register({
    name: makeMailboxName('bob'),
    agentId: makeAgentId('agent-bob-001'),
    parentAgentId: makeAgentId('leader'),
  });
  assert.equal(reg.size(), 2);
  await reg.unregister(makeMailboxName('alice'));
  assert.equal(reg.size(), 1);
});

// ============================================================
// assertNameStable
// ============================================================

test('TeammateRegistry.assertNameStable: name 已注册且 agentId 匹配 → 通过', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  // 不抛错
  await reg.assertNameStable({
    name: makeMailboxName('alice'),
    expectedAgentId: makeAgentId('agent-alice-001'),
  });
});

test('TeammateRegistry.assertNameStable: name 未注册抛错', async () => {
  const reg = new TeammateRegistry();
  await assert.rejects(
    () => reg.assertNameStable({
      name: makeMailboxName('alice'),
      expectedAgentId: makeAgentId('agent-alice-001'),
    }),
    /not registered/,
  );
});

test('TeammateRegistry.assertNameStable: agentId 不匹配抛错', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  await assert.rejects(
    () => reg.assertNameStable({
      name: makeMailboxName('alice'),
      expectedAgentId: makeAgentId('some-other-id'),
    }),
    /maps to agentId/,
  );
});

// ============================================================
// clear
// ============================================================

test('TeammateRegistry.clear: 重置全部', async () => {
  const reg = new TeammateRegistry();
  await reg.register({
    name: makeMailboxName('alice'),
    agentId: makeAgentId('agent-alice-001'),
    parentAgentId: makeAgentId('leader'),
  });
  await reg.register({
    name: makeMailboxName('bob'),
    agentId: makeAgentId('agent-bob-001'),
    parentAgentId: makeAgentId('leader'),
  });
  assert.equal(reg.size(), 2);
  reg.clear();
  assert.equal(reg.size(), 0);
  assert.equal(await reg.exists(makeMailboxName('alice')), false);
  assert.equal(await reg.getByAgentId(makeAgentId('agent-alice-001')), undefined);
});

// ============================================================
// 集成：完整生命周期
// ============================================================

test('TeammateRegistry: 完整生命周期（register → use → unregister）', async () => {
  const reg = new TeammateRegistry();
  const leader = makeAgentId('leader');
  const aliceName = makeMailboxName('alice');
  const aliceAgentId = makeAgentId('agent-alice-001');

  // 1. 注册
  await reg.register({
    name: aliceName,
    agentId: aliceAgentId,
    parentAgentId: leader,
  });

  // 2. 解析
  assert.equal(await reg.resolve(aliceName), aliceAgentId);

  // 3. name 稳定性校验
  await reg.assertNameStable({
    name: aliceName,
    expectedAgentId: aliceAgentId,
  });

  // 4. 反向查询
  const byAgentId = await reg.getByAgentId(aliceAgentId);
  assert.ok(byAgentId);
  assert.equal(byAgentId!.parentAgentId, leader);

  // 5. 列表
  const list = await reg.list();
  assert.equal(list.length, 1);

  // 6. 注销
  await reg.unregister(aliceName);
  assert.equal(reg.size(), 0);
  assert.equal(await reg.resolve(aliceName), undefined);
});
