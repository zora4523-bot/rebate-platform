// B1-15f: one round of the cooling-period expiry over PostgreSQL (08 BR-ID-27; brief §9.2 #2, #3,
// #6; rule-test list items 1-5, 8, 9). Every case builds the runner in its body: the baseline red
// is NotImplemented. Amounts are bigint fen; it.each tables carry strings, converted in the body.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  COOLING_MS,
  DEFERRED,
  NOW,
  close,
  failAfterSecondWrite,
  fields,
  instant,
  open,
  owner,
  request,
  reset,
  seedRequest,
  userRow,
  warnings,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
beforeEach(async () => {
  await reset(kit);
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});

it('[AC-B1-15f#1] cooling_until 晚于 now 1 毫秒的单不动；恰等于 now 的单被处理', async () => {
  const later = await owner(kit.db);
  const due = await owner(kit.db);
  const notYet = await seedRequest(kit.db, later, {
    coolingUntil: new Date(Date.parse(NOW) + 1),
  });
  const now = await seedRequest(kit.db, due, { coolingUntil: new Date(NOW) });
  const laterUser = await userRow(kit.db, later);
  await kit.runner().runOnce();
  expect(await request(kit.db, notYet.id)).toEqual(notYet);
  expect(await userRow(kit.db, later)).toEqual(laterUser);
  expect(kit.balanceCallsOf(later)).toEqual([]);
  expect(kit.withdrawalCallsOf(later)).toEqual([]);
  expect((await request(kit.db, now.id)).status).toBe('processing');
  expect((await userRow(kit.db, due)).status).toBe('deleting');
});

it.each([
  ['-1', false],
  ['-1', true],
  ['-9007199254740993', false],
])(
  '[AC-B1-15f#2] 冷静期满余额 %s 分（提现未终态=%s）→ cancelled、negative_balance、cancelled_at=now；users 与快照不变',
  async (fen, nonTerminal) => {
    const o = await owner(kit.db);
    const original = await seedRequest(kit.db, o, { snapshotFen: 2500n });
    const user = await userRow(kit.db, o);
    kit.setBalance(o, BigInt(fen));
    kit.setNonTerminal(o, nonTerminal);
    await kit.runner().runOnce();
    const now = kit.clock.now();
    expect(await request(kit.db, original.id)).toEqual({
      ...original,
      status: 'cancelled',
      cancel_reason: 'negative_balance',
      cancelled_at: now,
      row_version: original.row_version + 1,
      updated_at: now,
    });
    const after = await request(kit.db, original.id);
    expect(after.processed_at).toBeNull();
    expect(after.balance_snapshot_fen).toBe(2500n);
    expect(await userRow(kit.db, o)).toEqual(user);
    expect(kit.balanceCallsOf(o)).toEqual([
      { appId: o.appId, userId: o.uid, inTransaction: true, userRowLocked: true },
    ]);
    expect(warnings(kit, DEFERRED, o.appId)).toEqual([]);
  },
);

it.each(['0', '1', '9007199254740993'])(
  '[AC-B1-15f#3] 冷静期满余额 %s 分且提现全终态 → 单 processing、users.status=deleting（同事务、各 row_version+1）；processed_at 仍为空',
  async (fen) => {
    const o = await owner(kit.db);
    const original = await seedRequest(kit.db, o, { snapshotFen: 77n });
    const user = await userRow(kit.db, o);
    kit.setBalance(o, BigInt(fen));
    kit.setNonTerminal(o, false);
    await kit.runner().runOnce();
    const now = kit.clock.now();
    expect(await request(kit.db, original.id)).toEqual({
      ...original,
      status: 'processing',
      row_version: original.row_version + 1,
      updated_at: now,
    });
    expect(await userRow(kit.db, o)).toEqual({
      ...user,
      status: 'deleting',
      row_version: user.row_version + 1,
      updated_at: now,
    });
    const after = await request(kit.db, original.id);
    expect(after.processed_at).toBeNull();
    expect(after.cancelled_at).toBeNull();
    expect(after.cancel_reason).toBeNull();
    expect(after.balance_snapshot_fen).toBe(77n);
    // Both ports are asked on the request's transaction, inside the user's row lock.
    expect(kit.balanceCallsOf(o)).toEqual([
      { appId: o.appId, userId: o.uid, inTransaction: true, userRowLocked: true },
    ]);
    expect(kit.withdrawalCallsOf(o)).toEqual([
      { appId: o.appId, userId: o.uid, inTransaction: true, userRowLocked: true },
    ]);
  },
);

it('[AC-B1-15f#4] 第二个写入执行后注入失败 → users 与单都回滚，只记一行 warn（error_name），下一轮再推进', async () => {
  const o = await owner(kit.db);
  const original = await seedRequest(kit.db, o);
  const user = await userRow(kit.db, o);
  const failing = failAfterSecondWrite(kit.db);
  await kit.runner({ db: failing.db }).runOnce();
  expect(failing.fired(), 'fewer than two writes on users / deletion_requests').toBe(true);
  expect(await request(kit.db, original.id)).toEqual(original);
  expect(await userRow(kit.db, o)).toEqual(user);
  const failed = kit.logs().filter((line) => line['level'] === 40 && line['msg'] !== DEFERRED);
  expect(failed).toHaveLength(1);
  expect(fields(failed[0]!)).toEqual({ error_name: 'Error' });
  await kit.runner().runOnce();
  expect((await request(kit.db, original.id)).status).toBe('processing');
  expect((await userRow(kit.db, o)).status).toBe('deleting');
});

it('[AC-B1-15f#5] 提现端口报未终态 → 都不动、warn 一行；同日再跑不 warn，+08:00 次日再一次；改报终态后推进', async () => {
  const o = await owner(kit.db);
  const original = await seedRequest(kit.db, o);
  const user = await userRow(kit.db, o);
  kit.setBalance(o, 500n);
  kit.setNonTerminal(o, true);
  const runner = kit.runner();
  await runner.runOnce();
  expect(await request(kit.db, original.id)).toEqual(original);
  expect(await userRow(kit.db, o)).toEqual(user);
  expect(kit.withdrawalCallsOf(o)).toEqual([
    { appId: o.appId, userId: o.uid, inTransaction: true, userRowLocked: true },
  ]);
  const first = warnings(kit, DEFERRED, o.appId);
  expect(first).toHaveLength(1);
  expect(Object.keys(fields(first[0]!)).sort()).toEqual([
    'app_id',
    'cooling_until',
    'deletion_request_id',
  ]);
  expect(first[0]).toMatchObject({ app_id: o.appId, deletion_request_id: original.id });
  expect(instant(first[0]!['cooling_until'])).toBe(original.cooling_until.getTime());
  // 2026-10-21 23:59:59.999 +08:00: same civil day, no second line.
  kit.clock.set('2026-10-21T15:59:59.999Z');
  await runner.runOnce();
  expect(warnings(kit, DEFERRED, o.appId)).toHaveLength(1);
  expect(await request(kit.db, original.id)).toEqual(original);
  // 2026-10-22 00:00 +08:00: a new day, one more line.
  kit.clock.set('2026-10-21T16:00:00.000Z');
  await runner.runOnce();
  expect(warnings(kit, DEFERRED, o.appId)).toHaveLength(2);
  expect(await request(kit.db, original.id)).toEqual(original);
  expect(await userRow(kit.db, o)).toEqual(user);
  kit.setNonTerminal(o, false);
  await runner.runOnce();
  const now = kit.clock.now();
  expect(await request(kit.db, original.id)).toEqual({
    ...original,
    status: 'processing',
    row_version: original.row_version + 1,
    updated_at: now,
  });
  expect((await userRow(kit.db, o)).status).toBe('deleting');
  expect(warnings(kit, DEFERRED, o.appId)).toHaveLength(2);
});

it.each(['cancelled', 'processing', 'done'] as const)(
  '[AC-B1-15f#6] 冷静期已过但单已是 %s → 不动、不问端口',
  async (status) => {
    const o = await owner(kit.db, { status: status === 'processing' ? 'deleting' : 'normal' });
    const original = await seedRequest(kit.db, o, {
      status,
      coolingUntil: new Date(Date.parse(NOW) - 60_000),
    });
    const user = await userRow(kit.db, o);
    kit.setBalance(o, -100n);
    await kit.runner().runOnce();
    expect(await request(kit.db, original.id)).toEqual(original);
    expect(await userRow(kit.db, o)).toEqual(user);
    expect(kit.balanceCallsOf(o)).toEqual([]);
    expect(kit.withdrawalCallsOf(o)).toEqual([]);
  },
);

it('[AC-B1-15f#7] users.status 已不是 normal（不一致数据）→ 不写任何行、warn 后跳过，其他单照常处理', async () => {
  const odd = await owner(kit.db, { status: 'deleting' });
  const fine = await owner(kit.db);
  const oddRequest = await seedRequest(kit.db, odd, {
    coolingUntil: new Date(Date.parse(NOW) - 1000),
  });
  const fineRequest = await seedRequest(kit.db, fine);
  const oddUser = await userRow(kit.db, odd);
  await kit.runner().runOnce();
  expect(await request(kit.db, oddRequest.id)).toEqual(oddRequest);
  expect(await userRow(kit.db, odd)).toEqual(oddUser);
  expect(kit.logs().filter((line) => line['level'] === 40).length).toBeGreaterThanOrEqual(1);
  expect((await request(kit.db, fineRequest.id)).status).toBe('processing');
});

it('[AC-B1-15f#8] 跨 app 互不影响：一轮处理多个 app 的到期单，端口按各自 app_id 询问', async () => {
  const a = await owner(kit.db);
  const b = await owner(kit.db);
  const c = await owner(kit.db, { appId: b.appId });
  const ra = await seedRequest(kit.db, a);
  const rb = await seedRequest(kit.db, b);
  const rc = await seedRequest(kit.db, c);
  kit.setNonTerminal(a, true);
  kit.setBalance(c, -1n);
  // A request of a third app that is not due yet stays as it is.
  const twin = await owner(kit.db);
  const rt = await seedRequest(kit.db, twin, { coolingUntil: new Date(Date.parse(NOW) + 1) });
  await kit.runner().runOnce();
  expect(await request(kit.db, ra.id)).toEqual(ra);
  expect((await request(kit.db, rb.id)).status).toBe('processing');
  expect((await request(kit.db, rc.id)).status).toBe('cancelled');
  expect((await request(kit.db, rc.id)).cancel_reason).toBe('negative_balance');
  expect(await request(kit.db, rt.id)).toEqual(rt);
  expect((await userRow(kit.db, a)).status).toBe('normal');
  expect((await userRow(kit.db, b)).status).toBe('deleting');
  expect((await userRow(kit.db, c)).status).toBe('normal');
  for (const o of [a, b, c]) {
    expect(kit.balanceCallsOf(o)).toHaveLength(1);
  }
  expect(warnings(kit, DEFERRED).map((line) => line['app_id'])).toEqual([a.appId]);
});

it('[AC-B1-15f#9] 超过一批的推迟单排在前面时，后面到期的单同一轮仍被处理', async () => {
  const deferred = [];
  for (let n = 0; n < 5; n += 1) {
    const o = await owner(kit.db);
    kit.setNonTerminal(o, true);
    deferred.push({
      o,
      row: await seedRequest(kit.db, o, {
        coolingUntil: new Date(Date.parse(NOW) - (10 - n) * 3_600_000),
      }),
    });
  }
  const last = await owner(kit.db);
  const lastRequest = await seedRequest(kit.db, last, { coolingUntil: new Date(NOW) });
  await kit.runner({ batchSize: 2 }).runOnce();
  for (const { row } of deferred) expect(await request(kit.db, row.id)).toEqual(row);
  expect((await request(kit.db, lastRequest.id)).status).toBe('processing');
  expect((await userRow(kit.db, last)).status).toBe('deleting');
  expect(warnings(kit, DEFERRED)).toHaveLength(5);
});

it('[AC-B1-15f#10] runOnce 两次只推进一次：第二轮不再写、不再问端口', async () => {
  const o = await owner(kit.db);
  const original = await seedRequest(kit.db, o);
  const runner = kit.runner();
  await runner.runOnce();
  const once = await request(kit.db, original.id);
  const user = await userRow(kit.db, o);
  expect(once.status).toBe('processing');
  kit.clock.set(new Date(Date.parse(NOW) + 60_000));
  await runner.runOnce();
  await kit.runner().runOnce();
  expect(await request(kit.db, original.id)).toEqual(once);
  expect(await userRow(kit.db, o)).toEqual(user);
  expect(kit.balanceCallsOf(o)).toHaveLength(1);
  expect(kit.withdrawalCallsOf(o)).toHaveLength(1);
});

it('[AC-B1-15f#11] stop 判定在两张单之间生效：当前单做完，后面的单留到下一轮', async () => {
  const first = await owner(kit.db);
  const second = await owner(kit.db);
  const r1 = await seedRequest(kit.db, first, {
    coolingUntil: new Date(Date.parse(NOW) - COOLING_MS / 7),
  });
  const r2 = await seedRequest(kit.db, second);
  const runner = kit.runner();
  await runner.runOnce(() => kit.balanceCalls.length >= 1);
  expect((await request(kit.db, r1.id)).status).toBe('processing');
  expect(await request(kit.db, r2.id)).toEqual(r2);
  await runner.runOnce();
  expect((await request(kit.db, r2.id)).status).toBe('processing');
});
