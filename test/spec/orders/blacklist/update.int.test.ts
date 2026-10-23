// B1-09b：已有订单的第 ③ 步黑名单（08 BR-ATTR-26「检查时点」与「命中后的处理」）。只在流水线运行时（content_hash
// 变化）检查；名单新增后存量订单在其下一次同步更新时被检查，不做全表回扫。库内 rebate_status 由测试直接置好，
// 代表 settlement 先前的迁移；返利端口与事件总线是假实现。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existing, hitView, ownership, seedChannel, seedSuffix } from './kit.ts';
import { AFTER_CREDIT, CHANNEL, PARENT_HIT, PARENT_MISS, PRECREDIT } from './plan-kit.ts';

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

type Existing = Awaited<ReturnType<typeof existing>>;

function afterCredit(f: Existing) {
  return f.publish.mock.calls.filter(([, event]) => event.name === AFTER_CREDIT);
}

/** BR-ATTR-26：黑名单不改 user_id、buy_type；rebate_status 只由 settlement 经端口改。 */
async function expectOwnershipKept(f: Existing) {
  const row = (await f.read()).orders[0]!;
  expect(ownership(row)).toEqual(ownership(f.before));
  expect(row.user_id).toBe(f.userId);
  expect(row.buy_type).toBe('share');
}

it('[AC-B1-09b#19] 名单新增后 content_hash 未变的同步不查名单（不回扫），下一次内容变化的同步才查', async () => {
  const f = await existing(db, 'ESTIMATED');
  await seedChannel(db, f);
  // 同内容不同页：只有 raw_payload_id 不同，hash 不变。
  expect(await f.update({ ...f.incoming, raw_payload_id: '303' })).toMatchObject({
    ok: true,
    value: { kind: 'unchanged' },
  });
  expect(f.match).not.toHaveBeenCalled();
  expect(f.onBlacklistHit).not.toHaveBeenCalled();
  expect((await f.read()).hits).toHaveLength(0);
  expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });
  expect(f.match).toHaveBeenCalledTimes(1);
  expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
  expect((await f.read()).hits).toHaveLength(1);
});

describe('[AC-B1-09b#20] 存量未入账订单在下一次同步更新时命中：BLACKLIST_HIT 先于本次状态迁移，同一事务', () => {
  it.each(PRECREDIT)('%s', async (status) => {
    const f = await existing(db, status);
    await seedChannel(db, f);
    expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect(f.match).toHaveBeenCalledTimes(1);
    expect(f.match.mock.calls[0]?.[1]).toMatchObject({
      app_id: f.ctx.app_id,
      platform: 'taobao',
      trade_parent_id: PARENT_MISS,
      relation_id: CHANNEL,
      union_account_id: f.ctx.union_account_id,
      attr_at: f.before.attr_at,
    });
    expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
    expect(f.onUpdated).toHaveBeenCalledTimes(1);
    const [hitTrx, hit] = f.onBlacklistHit.mock.calls[0]!;
    expect(hitTrx.isTransaction).toBe(true);
    expect(hitTrx).toBe(f.onUpdated.mock.calls[0]?.[0]);
    expect(hit).toMatchObject({
      app_id: f.ctx.app_id,
      order_id: f.before.order_id,
      attr_at: f.before.attr_at,
    });
    // BR-ATTR-01：③ 黑名单在 ⑦ 状态迁移之前；R6 的来源是本次迁移前的返利状态。
    expect(f.onBlacklistHit.mock.invocationCallOrder[0]).toBeLessThan(
      f.onUpdated.mock.invocationCallOrder[0]!,
    );
    expect((await f.read()).hits.map(hitView)).toEqual([
      {
        user_id: f.userId,
        rule_id: 'BLACKLIST_HIT',
        risk_action: 'void_commission',
        dimension: 'channel',
        value_hmac: f.hmac('channel', CHANNEL),
        ref_type: 'order',
        ref_id: f.before.order_id,
      },
    ]);
    expect(afterCredit(f)).toHaveLength(0);
    await expectOwnershipKept(f);
  });
});

it('[AC-B1-09b#21] 已入账订单命中（例 S6，退款触发更新）：不自动扣回，同事务入队 order.blacklist_hit_after_credit，退款照常交 settlement', async () => {
  const f = await existing(db, 'CREDITED');
  await seedChannel(db, f);
  expect(await f.update(f.next({ raw_status: 'invalid' }))).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  expect(f.onBlacklistHit).not.toHaveBeenCalled();
  const events = afterCredit(f);
  expect(events).toHaveLength(1);
  const [trx, event] = events[0]!;
  expect(trx.isTransaction).toBe(true);
  expect(trx).toBe(f.onUpdated.mock.calls[0]?.[0]);
  expect(event).toMatchObject({
    appId: f.ctx.app_id,
    name: AFTER_CREDIT,
    payload: { order_id: f.before.order_id },
  });
  const text = JSON.stringify(event.payload);
  for (const value of [f.incoming.sub_order_id, PARENT_MISS, CHANNEL]) {
    expect(text).not.toContain(value);
  }
  // 同一次更新中的退款仍按 BR-FUND 正常处理。
  expect(f.onUpdated).toHaveBeenCalledTimes(1);
  expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({
    order_id: f.before.order_id,
    from_status: 'PAID',
    to_status: 'INVALID',
  });
  const after = await f.read();
  expect(after.hits.every((row) => row.risk_action !== 'void_commission')).toBe(true);
  await expectOwnershipKept(f);
});

describe('[AC-B1-09b#22] rebate_status 已为 VOID 或 CLAWED_BACK：不处理，不写任何 risk_hits（含 manual_review）', () => {
  it.each([
    ['VOID', '渠道'],
    ['CLAWED_BACK', '渠道'],
    ['VOID', '渠道 + 尾号（开关关）'],
    ['CLAWED_BACK', '渠道 + 尾号（开关关）'],
  ] as const)('%s：%s命中', async (status, label) => {
    const withSuffix = label !== '渠道';
    const f = await existing(db, status, withSuffix ? { parent_order_id: PARENT_HIT } : {});
    await seedChannel(db, f);
    if (withSuffix) await seedSuffix(db, f);
    expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect(f.match).toHaveBeenCalledTimes(1);
    expect(f.onBlacklistHit).not.toHaveBeenCalled();
    expect(afterCredit(f)).toHaveLength(0);
    expect(f.onUpdated).toHaveBeenCalledTimes(1);
    expect(f.recordHit).not.toHaveBeenCalled();
    expect((await f.read()).hits).toHaveLength(0);
    await expectOwnershipKept(f);
  });
});

it('[AC-B1-09b#23] 尾号维度未启用时已入账订单命中：只写 manual_review，不入队复核事件', async () => {
  const f = await existing(db, 'CREDITED', { parent_order_id: PARENT_HIT }, { suffixOn: false });
  await seedSuffix(db, f);
  expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });
  expect(f.onBlacklistHit).not.toHaveBeenCalled();
  expect(afterCredit(f)).toHaveLength(0);
  expect((await f.read()).hits.map((row) => [row.dimension, row.risk_action])).toEqual([
    ['order_no_suffix', 'manual_review'],
  ]);
  await expectOwnershipKept(f);
});

it('[AC-B1-09b#24] 尾号维度启用后，存量未入账订单在下一次同步时经 BLACKLIST_HIT 作废', async () => {
  const f = await existing(db, 'ESTIMATED', { parent_order_id: PARENT_HIT }, { suffixOn: true });
  await seedSuffix(db, f);
  expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });
  expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
  expect((await f.read()).hits.map((row) => [row.dimension, row.risk_action])).toEqual([
    ['order_no_suffix', 'void_commission'],
  ]);
  await expectOwnershipKept(f);
});

it('[AC-B1-09b#25] 返利端口未接线：存量未入账订单命中只记 manual_review，状态迁移照常交 settlement', async () => {
  const f = await existing(db, 'ESTIMATED', {}, { noRebatePort: true });
  await seedChannel(db, f);
  expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });
  expect(f.onUpdated).toHaveBeenCalledTimes(1);
  expect((await f.read()).hits.map((row) => [row.dimension, row.risk_action])).toEqual([
    ['channel', 'manual_review'],
  ]);
  expect(f.logger.warn.mock.calls.length + f.logger.error.mock.calls.length).toBeGreaterThan(0);
  await expectOwnershipKept(f);
});

describe('[AC-B1-09b#26] 与本次更新同一事务：复核事件入队或返利端口失败，整条回滚', () => {
  it.each([
    ['CREDITED', 'order.blacklist_hit_after_credit 入队'],
    ['ESTIMATED', 'onBlacklistHit'],
  ] as const)('%s：%s 抛错', async (status) => {
    const f = await existing(db, status);
    await seedChannel(db, f);
    const prior = await f.read();
    const boom = new Error('synthetic blacklist failure');
    if (status === 'CREDITED') {
      f.publish.mockImplementation(async (_trx, event) => {
        if (event.name === AFTER_CREDIT) throw boom;
        return { eventId: randomUUID(), duplicate: false };
      });
    } else {
      f.onBlacklistHit.mockRejectedValue(boom);
    }
    expect(await f.update(f.next({ raw_status: 'invalid' }))).toEqual({ ok: false, error: boom });
    const after = await f.read();
    expect(after.orders).toEqual(prior.orders);
    expect(after.history).toEqual(prior.history);
    expect(after.hits).toHaveLength(0);
  });
});

it('[AC-B1-09b#28] 存量未归因订单（user_id 为空）的下一次同步更新照样执行第 ③ 步：渠道命中经 BLACKLIST_HIT，同一事务', async () => {
  const f = await existing(db, 'UNATTRIBUTED', {}, { unattributed: true });
  expect(f.before.user_id).toBeNull();
  await seedChannel(db, f);
  expect(await f.update()).toMatchObject({ ok: true, value: { kind: 'updated' } });
  expect(f.match).toHaveBeenCalledTimes(1);
  expect(f.match.mock.calls[0]?.[1]).toMatchObject({
    app_id: f.ctx.app_id,
    platform: 'taobao',
    relation_id: CHANNEL,
    union_account_id: f.ctx.union_account_id,
    attr_at: f.before.attr_at,
  });
  expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
  expect(f.onUpdated).toHaveBeenCalledTimes(1);
  const [hitTrx, hit] = f.onBlacklistHit.mock.calls[0]!;
  expect(hitTrx.isTransaction).toBe(true);
  expect(hitTrx).toBe(f.onUpdated.mock.calls[0]?.[0]);
  expect(hit).toMatchObject({
    app_id: f.ctx.app_id,
    order_id: f.before.order_id,
    attr_at: f.before.attr_at,
  });
  expect((await f.read()).hits.map(hitView)).toEqual([
    {
      user_id: null,
      rule_id: 'BLACKLIST_HIT',
      risk_action: 'void_commission',
      dimension: 'channel',
      value_hmac: f.hmac('channel', CHANNEL),
      ref_type: 'order',
      ref_id: f.before.order_id,
    },
  ]);
  expect(afterCredit(f)).toHaveLength(0);
  // BR-ATTR-26：黑名单不改 user_id、buy_type。
  const row = (await f.read()).orders[0]!;
  expect(ownership(row)).toEqual(ownership(f.before));
  expect(row.user_id).toBeNull();
});
