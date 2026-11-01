// B1-09m 的核心（BR-ID-36、BR-ATTR-26；D10-536 (b) §9）：规则状态的缓存恰好在本次判定与写命中之间到期、库里已是停用时，
// 本次判定已命中的，命中照写，处置与命中同时成立；不得出现「作废了返利却没有命中」，否则被作废的用户无命中可申诉。
// 到期落点由 kit 的 changeRightAfterDecision 给出：判定读到缓存里的启用，随后时钟走 1 ms，之后再读就是停用。
// 不等真实时间，流水线、更新步与 risk 端口都是真实的。判定之后的下一次判定才按停用：不追溯，也不延后。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hitView, publishedOf, seedChannel, seedSuffix } from '../blacklist/kit.ts';
import { AFTER_CREDIT, PARENT_HIT } from '../blacklist/plan-kit.ts';
import { INSERTED, UPDATED, freshOrder, storedOrder } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 180_000);

/** 到期之后：读口已答停用，规则行仍是停用（写命中的惰性登记不改写它）。 */
async function expectDisabledInForce(f: Awaited<ReturnType<typeof freshOrder>>) {
  expect(await f.ruleInForce()).toBe(false);
  expect(await f.ruleRows()).toEqual([{ status: 'disabled', version: 2 }]);
}

it('[AC-B1-09m#10][BR-ID-36][BR-ATTR-26] 首次入库：缓存恰在判定之后、写命中之前到期且规则已停用 → 本次作废与命中同时成立，规则行不被改写；下一条子订单才按停用', async () => {
  const f = await freshOrder(db);
  await seedChannel(db, f);
  await f.setRule('enabled');
  await f.changeRightAfterDecision('disabled');
  expect(await f.run()).toMatchObject(INSERTED);
  f.decisionRaced();
  const after = await f.read();
  const row = after.orders[0]!;
  expect({
    rebate_status: row.rebate_status,
    reason: row.reason,
    hits: after.hits.map(hitView),
  }).toEqual({
    rebate_status: 'VOID',
    reason: 'BLACKLIST',
    hits: [f.expectedHit('void_commission', row.order_id)],
  });
  expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
  await expectDisabledInForce(f);

  const subOrderId = randomUUID();
  expect(await f.run({ ...f.incoming, sub_order_id: subOrderId })).toMatchObject(INSERTED);
  const later = await f.read();
  expect(later.orders.find((order) => order.sub_order_id === subOrderId)).toMatchObject({
    rebate_status: 'UNATTRIBUTED',
    reason: null,
  });
  expect(later.hits).toEqual(after.hits);
  expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
  f.expectOneReadPerJudgement(2);
});

it('[AC-B1-09m#11][BR-ID-36][BR-ATTR-26] 没有规则行时也一样：判定时生效，之后才写入停用行 → 命中照写，停用行不被惰性登记覆盖', async () => {
  const f = await freshOrder(db);
  await seedChannel(db, f);
  await f.changeRightAfterDecision('disabled');
  expect(await f.run()).toMatchObject(INSERTED);
  f.decisionRaced();
  const after = await f.read();
  const row = after.orders[0]!;
  expect(row).toMatchObject({ rebate_status: 'VOID', reason: 'BLACKLIST' });
  expect(after.hits.map(hitView)).toEqual([f.expectedHit('void_commission', row.order_id)]);
  expect(await f.ruleRows()).toEqual([{ status: 'disabled', version: 1 }]);
  f.expectOneReadPerJudgement(1);
});

it.each([
  ['UNATTRIBUTED（已归属）', 'UNATTRIBUTED', false],
  ['UNATTRIBUTED（未归因，user_id 为空）', 'UNATTRIBUTED', true],
  ['ESTIMATED', 'ESTIMATED', false],
  ['WAITING', 'WAITING', false],
] as const)(
  '[AC-B1-09m#12][BR-ID-36][BR-ATTR-26] 存量未入账订单：缓存在判定与写命中之间到期 → 作废与命中同时成立，下一次同步按停用，命中不变：%s',
  async (_label, status, unattributed) => {
    const f = await storedOrder(db, status, {}, { unattributed });
    await seedChannel(db, f);
    await f.setRule('enabled');
    await f.changeRightAfterDecision('disabled');
    expect(await f.update()).toMatchObject(UPDATED);
    f.decisionRaced();
    const after = await f.read();
    expect({
      rebate_status: after.orders[0]!.rebate_status,
      reason: after.orders[0]!.reason,
      hits: after.hits.map(hitView),
    }).toEqual({
      rebate_status: 'VOID',
      reason: 'BLACKLIST',
      hits: [
        f.expectedHit(
          'void_commission',
          f.before.order_id,
          'channel',
          unattributed ? null : f.userId,
        ),
      ],
    });
    expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
    expect(f.onUpdated).toHaveBeenCalledTimes(1);
    expect(f.onBlacklistHit.mock.calls[0]?.[0]).toBe(f.onUpdated.mock.calls[0]?.[0]);
    expect(f.recordHit.mock.calls[0]?.[0]).toBe(f.onUpdated.mock.calls[0]?.[0]);

    f.clock.advanceMs(1000);
    expect(await f.update()).toMatchObject(UPDATED);
    expect((await f.read()).hits).toEqual(after.hits);
    f.expectOneReadPerJudgement(2);
  },
);

it('[AC-B1-09m#13][BR-ID-36][BR-ATTR-26] 已入账订单：缓存在判定与写命中之间到期 → 不扣回，manual_review 命中与 order.blacklist_hit_after_credit 同时成立', async () => {
  const f = await storedOrder(db, 'CREDITED');
  await seedChannel(db, f);
  await f.setRule('enabled');
  await f.changeRightAfterDecision('disabled');
  expect(await f.update()).toMatchObject(UPDATED);
  f.decisionRaced();
  const after = await f.read();
  expect({
    events: publishedOf(f, AFTER_CREDIT).length,
    hits: after.hits.map(hitView),
  }).toEqual({
    events: 1,
    hits: [f.expectedHit('manual_review', f.before.order_id)],
  });
  expect(after.orders[0]).toMatchObject({ rebate_status: 'CREDITED', reason: null });
  expect(f.onBlacklistHit).not.toHaveBeenCalled();

  f.clock.advanceMs(1000);
  expect(await f.update()).toMatchObject(UPDATED);
  expect((await f.read()).hits).toEqual(after.hits);
  expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(1);
  f.expectOneReadPerJudgement(2);
});

it('[AC-B1-09m#14][BR-ID-36][BR-ATTR-26] 尾号维度未启用：缓存在判定与写命中之间到期 → 本次判定的 manual_review 命中照写，返利状态不变', async () => {
  const f = await storedOrder(
    db,
    'ESTIMATED',
    { parent_order_id: PARENT_HIT },
    { suffixOn: false },
  );
  await seedSuffix(db, f);
  await f.setRule('enabled');
  await f.changeRightAfterDecision('disabled');
  expect(await f.update()).toMatchObject(UPDATED);
  f.decisionRaced();
  const after = await f.read();
  expect(after.hits.map(hitView)).toEqual([
    f.expectedHit('manual_review', f.before.order_id, 'order_no_suffix'),
  ]);
  expect(after.orders[0]).toMatchObject({ rebate_status: 'ESTIMATED', reason: null });
  expect(f.onBlacklistHit).not.toHaveBeenCalled();
  f.expectOneReadPerJudgement(1);
});

it('[AC-B1-09m#15][BR-ID-36][BR-ATTR-26] 渠道与尾号同时命中：缓存在两条命中之前到期 → 两条都写，作废照常，不会只写一条或一条不写', async () => {
  const f = await freshOrder(db, { parent_order_id: PARENT_HIT }, { suffixOn: true });
  await seedChannel(db, f);
  await seedSuffix(db, f);
  await f.setRule('enabled');
  await f.changeRightAfterDecision('disabled');
  expect(await f.run()).toMatchObject(INSERTED);
  f.decisionRaced();
  const after = await f.read();
  const row = after.orders[0]!;
  expect(row).toMatchObject({ rebate_status: 'VOID', reason: 'BLACKLIST' });
  expect(after.hits).toHaveLength(2);
  expect(after.hits.map(hitView)).toEqual(
    expect.arrayContaining([
      f.expectedHit('void_commission', row.order_id, 'channel'),
      f.expectedHit('void_commission', row.order_id, 'order_no_suffix'),
    ]),
  );
  f.expectOneReadPerJudgement(1);
});

it('[AC-B1-09m#16][BR-ID-36][BR-ATTR-26] 返利端口未接线：缓存在判定与写命中之间到期 → 降级的 manual_review 命中照写，订单不变并告警', async () => {
  const f = await freshOrder(db, {}, { noRebatePort: true });
  await seedChannel(db, f);
  await f.setRule('enabled');
  await f.changeRightAfterDecision('disabled');
  expect(await f.run()).toMatchObject(INSERTED);
  f.decisionRaced();
  const after = await f.read();
  const row = after.orders[0]!;
  expect(after.hits.map(hitView)).toEqual([f.expectedHit('manual_review', row.order_id)]);
  expect(row).toMatchObject({ rebate_status: 'UNATTRIBUTED', reason: null });
  expect(f.logger.warn).toHaveBeenCalled();
  f.expectOneReadPerJudgement(1);
});

it('[AC-B1-09m#17][BR-ID-36][BR-ATTR-26] 作废与命中同一事务：缓存到期且返利端口失败时整条回滚，既无订单也无命中', async () => {
  const f = await freshOrder(db);
  await seedChannel(db, f);
  await f.setRule('enabled');
  await f.changeRightAfterDecision('disabled');
  const boom = new Error('synthetic onBlacklistHit failure');
  f.onBlacklistHit.mockRejectedValue(boom);
  expect(await f.run()).toEqual({ ok: false, error: boom });
  f.decisionRaced();
  const after = await f.read();
  expect(after.orders).toEqual([]);
  expect(after.hits).toEqual([]);
  expect(await f.ruleRows()).toEqual([{ status: 'disabled', version: 2 }]);
  f.expectOneReadPerJudgement(1);
});

it('[AC-B1-09m#18][BR-ID-36][BR-ATTR-26] 反方向：判定读到停用、随后规则启用且缓存到期 → 本次不判定、不补写，下一次同步才判定', async () => {
  const f = await storedOrder(db, 'ESTIMATED');
  await seedChannel(db, f);
  await f.setRule('disabled');
  await f.changeRightAfterDecision('enabled');
  expect(await f.update()).toMatchObject(UPDATED);
  f.decisionRaced();
  await f.expectNothingDecided();
  expect((await f.read()).orders[0]).toMatchObject({ rebate_status: 'ESTIMATED', reason: null });

  f.clock.advanceMs(1000);
  expect(await f.update()).toMatchObject(UPDATED);
  const after = await f.read();
  expect(after.orders[0]).toMatchObject({ rebate_status: 'VOID', reason: 'BLACKLIST' });
  expect(after.hits.map(hitView)).toEqual([f.expectedHit('void_commission', f.before.order_id)]);
  f.expectOneReadPerJudgement(2);
});
