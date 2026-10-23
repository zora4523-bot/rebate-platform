// B1-09b：首次入库的第 ③ 步黑名单（08 BR-ATTR-26；BR-ATTR-01 ③：每条入库或更新的子订单、同一事务内）。
// 名单查询与命中写入用 risk 的真实端口（B1-09a）；返利端口 rebate.onBlacklistHit 是假实现，本模块不写
// rebate_status（settlement 是唯一写者），所以命中后库内 rebate_status 仍是首次入库的默认值。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createOrderPipeline } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  ATTR_AT,
  capture,
  expectSafeLogs,
  hitView,
  ownership,
  publishedOf,
  seedChannel,
  seedSuffix,
  setup,
  type Fixture,
} from './kit.ts';
import { AFTER_CREDIT, CHANNEL, PARENT_HIT, PARENT_MISS, SUFFIX } from './plan-kit.ts';

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
}, 30_000);

function plusMs(date: Date, ms: number): Date {
  const clock = new FixedClock(date.toISOString());
  clock.advanceMs(ms);
  return clock.now();
}

/** BR-ATTR-26：不改 user_id、buy_type；rebate_status 只由 settlement 经端口改。 */
function expectOwnershipKept(row: Parameters<typeof ownership>[0], f: Fixture) {
  expect(ownership(row)).toEqual({
    user_id: f.userId,
    user_basis: 'param',
    buy_type: 'share',
    scene_basis: 'pid',
    rebate_status: 'UNATTRIBUTED',
    reason: null,
  });
}

it('[AC-B1-09b#9] 渠道命中的新订单：同一事务内入库后经返利端口 BLACKLIST_HIT，记 void_commission，不改归属', async () => {
  const f = await setup(db);
  await seedChannel(db, f);
  expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const after = await f.read();
  expect(after.orders).toHaveLength(1);
  const row = after.orders[0]!;

  expect(f.match).toHaveBeenCalledTimes(1);
  const [matchTrx, query] = f.match.mock.calls[0]!;
  expect(matchTrx.isTransaction).toBe(true);
  expect(query).toMatchObject({
    app_id: f.ctx.app_id,
    platform: 'taobao',
    trade_parent_id: PARENT_MISS,
    relation_id: CHANNEL,
    union_account_id: f.ctx.union_account_id,
    attr_at: ATTR_AT,
  });

  expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
  const [hitTrx, hit] = f.onBlacklistHit.mock.calls[0]!;
  const importTrx = f.onImported.mock.calls[0]?.[0];
  expect(importTrx).toBeDefined();
  expect(hitTrx).toBe(importTrx);
  expect(matchTrx).toBe(importTrx);
  expect(hit).toMatchObject({ app_id: f.ctx.app_id, order_id: row.order_id, attr_at: ATTR_AT });
  // R6 迁移的来源状态由首次入库（R1 / R2）给出：先 onImported，再 BLACKLIST_HIT。
  expect(f.onImported.mock.invocationCallOrder[0]).toBeLessThan(
    f.onBlacklistHit.mock.invocationCallOrder[0]!,
  );

  expect(after.hits.map(hitView)).toEqual([
    {
      user_id: f.userId,
      rule_id: 'BLACKLIST_HIT',
      risk_action: 'void_commission',
      dimension: 'channel',
      value_hmac: f.hmac('channel', CHANNEL),
      ref_type: 'order',
      ref_id: row.order_id,
    },
  ]);
  expectOwnershipKept(row, f);
  expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(0);
});

describe('[AC-B1-09b#10] 渠道名单：同 union_account_id、active、start_at ≤ attr_at < end_at（半开区间）', () => {
  it.each([
    ['start_at 晚于 attr_at 1 秒 → 不命中', { start_at: plusMs(ATTR_AT, 1000) }, false],
    ['start_at = attr_at → 命中（含等号）', { start_at: ATTR_AT }, true],
    ['end_at = attr_at → 不命中', { end_at: ATTR_AT }, false],
    ['end_at 晚于 attr_at 1 毫秒 → 命中', { end_at: plusMs(ATTR_AT, 1) }, true],
    ['end_at 为空 → 持续生效', { end_at: null }, true],
    ['已停用 → 不命中', { status: 'inactive' }, false],
    ['别的联盟账号 → 不命中', { union_account_id: '00000000-0000-4000-8000-0000000000aa' }, false],
    ['relation_id 不同 → 不命中', { value: 'R9' }, false],
  ] as const)('%s', async (_label, overrides, hits) => {
    const f = await setup(db);
    await seedChannel(db, f, overrides);
    expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
    const after = await f.read();
    // 每条入库的子订单都检查名单；是否命中由名单条件决定。
    expect(f.match).toHaveBeenCalledTimes(1);
    expect(f.onBlacklistHit).toHaveBeenCalledTimes(hits ? 1 : 0);
    expect(after.hits).toHaveLength(hits ? 1 : 0);
    expectOwnershipKept(after.orders[0]!, f);
  });
});

it('[AC-B1-09b#11] 渠道比对用归因时点 attr_at（定金优先），不用付款时间或同步时刻', async () => {
  const deposit = plusMs(ATTR_AT, -1000);
  const f = await setup(db, { deposit_paid_at: deposit });
  // 名单自付款时刻起生效：付款时刻命中，归因时点（定金）在生效之前。
  await seedChannel(db, f, { start_at: ATTR_AT });
  expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const after = await f.read();
  expect(after.orders[0]).toMatchObject({ attr_at: deposit });
  expect(f.match).toHaveBeenCalledTimes(1);
  expect(f.match.mock.calls[0]?.[1]).toMatchObject({ attr_at: deposit });
  expect(f.onBlacklistHit).not.toHaveBeenCalled();
  expect(after.hits).toHaveLength(0);
});

describe('[AC-B1-09b#12] 尾号维度未启用（attr.blacklist.order_suffix_void_enabled=false）：只写 manual_review，返利状态与用户侧不变', () => {
  it('父单号末 6 位 123456 命中', async () => {
    const f = await setup(db, { parent_order_id: PARENT_HIT }, { suffixOn: false });
    await seedSuffix(db, f);
    expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
    const after = await f.read();
    const row = after.orders[0]!;
    expect(after.hits.map(hitView)).toEqual([
      {
        user_id: f.userId,
        rule_id: 'BLACKLIST_HIT',
        risk_action: 'manual_review',
        dimension: 'order_no_suffix',
        value_hmac: f.hmac('order_no_suffix', SUFFIX),
        ref_type: 'order',
        ref_id: row.order_id,
      },
    ]);
    expect(f.onBlacklistHit).not.toHaveBeenCalled();
    expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(0);
    expectOwnershipKept(row, f);
  });

  it('父单号 3301987654012345 不命中', async () => {
    const f = await setup(db, { parent_order_id: PARENT_MISS }, { suffixOn: false });
    await seedSuffix(db, f);
    expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
    expect(f.match).toHaveBeenCalledTimes(1);
    expect(f.match.mock.calls[0]?.[1]).toMatchObject({ trade_parent_id: PARENT_MISS });
    expect((await f.read()).hits).toHaveLength(0);
    expect(f.onBlacklistHit).not.toHaveBeenCalled();
  });
});

it('[AC-B1-09b#13] 尾号维度启用后按命中处理：经返利端口 BLACKLIST_HIT，记 void_commission', async () => {
  const f = await setup(db, { parent_order_id: PARENT_HIT }, { suffixOn: true });
  await seedSuffix(db, f);
  expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const after = await f.read();
  const row = after.orders[0]!;
  expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
  expect(f.onBlacklistHit.mock.calls[0]?.[1]).toMatchObject({
    app_id: f.ctx.app_id,
    order_id: row.order_id,
    attr_at: ATTR_AT,
  });
  expect(after.hits.map(hitView)).toEqual([
    {
      user_id: f.userId,
      rule_id: 'BLACKLIST_HIT',
      risk_action: 'void_commission',
      dimension: 'order_no_suffix',
      value_hmac: f.hmac('order_no_suffix', SUFFIX),
      ref_type: 'order',
      ref_id: row.order_id,
    },
  ]);
  expectOwnershipKept(row, f);
});

it('[AC-B1-09b#14] 尾号名单只适用淘宝：拼多多父单号末 6 位相同也不命中', async () => {
  const f = await setup(db, { platform: 'pdd', parent_order_id: PARENT_HIT }, { suffixOn: true });
  await seedSuffix(db, f);
  expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  // 渠道维度不限平台，所以拼多多订单同样查名单；尾号维度由名单端口只对淘宝比对。
  expect(f.match).toHaveBeenCalledTimes(1);
  expect(f.match.mock.calls[0]?.[1]).toMatchObject({ platform: 'pdd' });
  expect((await f.read()).hits).toHaveLength(0);
  expect(f.onBlacklistHit).not.toHaveBeenCalled();
});

it('[AC-B1-09b#15] 返利端口未接线：命中只记 manual_review 并告警，不改订单列；日志不带订单号与渠道值', async () => {
  const relation = 'rel-private-0042';
  const f = await setup(
    db,
    { attr_params: { relation_id: relation, sub_union_id: null, custom_parameters: null } },
    { noRebatePort: true },
  );
  await seedChannel(db, f, { value: relation });
  expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const after = await f.read();
  const row = after.orders[0]!;
  expect(after.hits.map(hitView)).toEqual([
    {
      user_id: f.userId,
      rule_id: 'BLACKLIST_HIT',
      risk_action: 'manual_review',
      dimension: 'channel',
      value_hmac: f.hmac('channel', relation),
      ref_type: 'order',
      ref_id: row.order_id,
    },
  ]);
  expectOwnershipKept(row, f);
  expect(f.logger.warn.mock.calls.length + f.logger.error.mock.calls.length).toBeGreaterThan(0);
  expectSafeLogs(f, [relation, PARENT_MISS]);
});

it('[AC-B1-09b#16] ① 失败不入库的订单不查名单；随后入库的同一子订单才查', async () => {
  const f = await setup(db);
  await seedChannel(db, f);
  f.findPid.mockResolvedValueOnce([]);
  expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'dropped' } });
  expect(f.match).not.toHaveBeenCalled();
  expect(f.onBlacklistHit).not.toHaveBeenCalled();
  expect((await f.read()).hits).toHaveLength(0);
  expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect(f.match).toHaveBeenCalledTimes(1);
  expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
});

it('[AC-B1-09b#17] 首次入库即已 VOID（入库同事务按 R6 作废，P13）：不再处理', async () => {
  const f = await setup(db, { raw_status: 'invalid' });
  await seedChannel(db, f);
  // 假 settlement：首次入库的同一事务里把订单置 VOID。
  f.onImported.mockImplementation(async (trx, order) => {
    await trx
      .withSchema('app')
      .updateTable('orders')
      .set({ rebate_status: 'VOID', reason: 'REFUND' })
      .where('app_id', '=', order.app_id)
      .where('order_id', '=', order.order_id)
      .execute();
  });
  expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const after = await f.read();
  const row = after.orders[0]!;
  expect(f.match).toHaveBeenCalledTimes(1);
  expect(f.onBlacklistHit).not.toHaveBeenCalled();
  expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(0);
  expect(after.hits).toHaveLength(0);
  expect(ownership(row)).toMatchObject({
    user_id: f.userId,
    buy_type: 'share',
    rebate_status: 'VOID',
    reason: 'REFUND',
  });
});

/** 同样未归因、不经第 ③ 步（B1-08h 的 deps）入库的订单的归属列：黑名单命中后应与它相同。 */
async function unattributedOwnership() {
  const base = await setup(db, {}, { unattributed: true });
  const made = await capture(() =>
    createOrderPipeline(base.plainDeps).process(base.incoming, base.ctx),
  );
  expect(made).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const row = (await base.read()).orders[0]!;
  expect(row).toMatchObject({ user_id: null, rebate_status: 'UNATTRIBUTED', reason: null });
  return ownership(row);
}

describe('[AC-B1-09b#27] 未归因订单（② 失败、user_id 为空）照样执行第 ③ 步（BR-ATTR-01：② 失败继续 ③④⑦）', () => {
  it('渠道命中 → 同一事务经返利端口 BLACKLIST_HIT（R6），记 void_commission，user_id 仍为空', async () => {
    const expected = await unattributedOwnership();
    const f = await setup(db, {}, { unattributed: true });
    await seedChannel(db, f);
    expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
    const after = await f.read();
    expect(after.orders).toHaveLength(1);
    const row = after.orders[0]!;

    expect(f.match).toHaveBeenCalledTimes(1);
    expect(f.match.mock.calls[0]?.[1]).toMatchObject({
      app_id: f.ctx.app_id,
      platform: 'taobao',
      relation_id: CHANNEL,
      union_account_id: f.ctx.union_account_id,
      attr_at: ATTR_AT,
    });
    expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
    const [hitTrx, hit] = f.onBlacklistHit.mock.calls[0]!;
    expect(hitTrx).toBe(f.onImported.mock.calls[0]?.[0]);
    expect(hit).toMatchObject({ app_id: f.ctx.app_id, order_id: row.order_id, attr_at: ATTR_AT });
    expect(after.hits.map(hitView)).toEqual([
      {
        user_id: null,
        rule_id: 'BLACKLIST_HIT',
        risk_action: 'void_commission',
        dimension: 'channel',
        value_hmac: f.hmac('channel', CHANNEL),
        ref_type: 'order',
        ref_id: row.order_id,
      },
    ]);
    expect(ownership(row)).toEqual(expected);
    expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(0);
  });

  it('尾号命中（开关关）→ 只记 manual_review，不经返利端口，user_id 仍为空', async () => {
    const expected = await unattributedOwnership();
    const f = await setup(
      db,
      { parent_order_id: PARENT_HIT },
      { unattributed: true, suffixOn: false },
    );
    await seedSuffix(db, f);
    expect(await f.run()).toMatchObject({ ok: true, value: { kind: 'inserted' } });
    const after = await f.read();
    const row = after.orders[0]!;
    expect(f.match).toHaveBeenCalledTimes(1);
    expect(f.match.mock.calls[0]?.[1]).toMatchObject({ trade_parent_id: PARENT_HIT });
    expect(after.hits.map(hitView)).toEqual([
      {
        user_id: null,
        rule_id: 'BLACKLIST_HIT',
        risk_action: 'manual_review',
        dimension: 'order_no_suffix',
        value_hmac: f.hmac('order_no_suffix', SUFFIX),
        ref_type: 'order',
        ref_id: row.order_id,
      },
    ]);
    expect(f.onBlacklistHit).not.toHaveBeenCalled();
    expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(0);
    expect(ownership(row)).toEqual(expected);
  });
});

describe('[AC-B1-09b#18] 与入库同一事务：命中写入或返利端口失败，整条回滚', () => {
  it.each(['recordHit', 'onBlacklistHit'] as const)('%s 抛错', async (which) => {
    const f = await setup(db);
    await seedChannel(db, f);
    const boom = new Error(`synthetic ${which} failure`);
    if (which === 'recordHit') f.recordHit.mockRejectedValue(boom);
    else f.onBlacklistHit.mockRejectedValue(boom);
    expect(await f.run()).toEqual({ ok: false, error: boom });
    const after = await f.read();
    expect(after.keys).toHaveLength(0);
    expect(after.orders).toHaveLength(0);
    expect(after.history).toHaveLength(0);
    expect(after.hits).toHaveLength(0);
  });
});
