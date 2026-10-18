import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Global setup supplies the migrated template; this file clones it and queries as couli_app.
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
import { orderContentHash } from '../../../../apps/api/src/modules/orders/index.ts';
import { at, RECEIVED, scenario, SETTLED } from './kit.ts';

it('[AC-B1-08i#28] null 预估佣金保留原值和版本；同步金额与原始来源可更新', async () => {
  const f = await scenario(db);
  const incoming = f.next({
    est_commission_fen: null,
    commission_fen: 9999n,
    paid_fen: 0n,
    parent_order_id: 'next-parent',
    goods_id: null,
    goods_sign: 'next-sign',
  });
  await f.pipeline.process(incoming, f.ctx);
  const after = await f.read();
  expect(after.orders[0]).toMatchObject({
    est_commission_fen: 789n,
    commission_version: f.original.commission_version,
    pay_amount_fen: 0n,
    parent_order_id: 'next-parent',
    raw_item_id: 'next-sign',
    raw_payload_id: 202n,
    content_hash: orderContentHash(incoming),
    platform_modified_at: incoming.modified_at,
  });
  expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ est_before: 789n, est_after: 789n });
  expect(after.history).toEqual(f.before.history);
});

it('[AC-B1-08i#29] 收货时间写入后固定；后到真实时间另存且 null 不清空', async () => {
  const f = await scenario(db, { raw_status: 'received', received_at: at(RECEIVED) });
  await f.pipeline.process(f.next({ received_at: at('2026-10-16T09:10:11Z') }), f.ctx);
  const first = await f.read();
  expect(first.orders[0]).toMatchObject({
    received_at: at(RECEIVED),
    platform_received_at: at('2026-10-16T09:10:11Z'),
  });
  f.clock.advanceMs(80_000);
  await f.pipeline.process(
    f.next({ received_at: null, paid_at: null, modified_at: null, est_commission_fen: 780n }),
    f.ctx,
  );
  const after = await f.read();
  expect(after.orders[0]).toMatchObject({
    received_at: at(RECEIVED),
    platform_received_at: at('2026-10-16T09:10:11Z'),
    paid_at: f.original.paid_at,
    platform_modified_at: first.orders[0]?.platform_modified_at,
  });
  expect(after.history).toEqual(f.before.history);
});

it.each(['paid', 'received', 'settled'] as const)(
  '[AC-B1-08i#30] %s 只有 SETTLED 保存结算佣金',
  async (raw) => {
    const f = await scenario(db, {
      raw_status: raw,
      received_at: at(RECEIVED),
      ...(raw === 'settled' ? { settled_at: at(SETTLED) } : {}),
    });
    await f.pipeline.process(f.next({ settle_commission_fen: 345n }), f.ctx);
    const after = await f.read();
    expect(after.orders[0]?.settle_commission_fen).toBe(raw === 'settled' ? 345n : null);
    expect(f.onUpdated.mock.calls[0]?.[1].settle_commission_fen).toBe(
      raw === 'settled' ? 345n : null,
    );
  },
);

it('[AC-B1-08i#31] 同步 UPDATE 不碰返利列、归因时点、首次场景或身份', async () => {
  const f = await scenario(db);
  await db
    .updateTable('orders')
    .set({
      rebate_status: 'WAITING',
      hold: true,
      hold_reason: 'UNMAPPED_STATUS',
      rights_pending: true,
      locked: true,
      booked_base_fen: 111n,
      booked_n_fen: 222n,
    })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  const before = (await f.read()).orders[0];
  expect(before).toBeDefined();
  await f.pipeline.process(
    f.next({
      raw_status: 'received',
      received_at: at(RECEIVED),
      deposit_paid_at: at('2026-10-13T12:13:14Z'),
      paid_at: at('2026-10-15T20:21:22Z'),
      attr_params: {
        relation_id: null,
        sub_union_id: null,
        custom_parameters: '{"app":"n","uid":"zzzz9999","scene":"self"}',
      },
    }),
    f.ctx,
  );
  const row = (await f.read()).orders[0];
  for (const key of [
    'app_id',
    'order_id',
    'sub_order_id',
    'platform',
    'attr_at',
    'user_id',
    'user_basis',
    'is_presale',
    'buy_type',
    'scene_basis',
    'rebate_status',
    'hold',
    'hold_reason',
    'rights_pending',
    'locked',
    'booked_base_fen',
    'booked_n_fen',
    'settle_period',
    'reason',
    'reason_sub',
  ] as const) {
    expect(row?.[key], key).toEqual(before?.[key]);
  }
  const update =
    f.queries.find((q) => /^update "app"."orders"/i.test(q.sql))?.sql.split(' where ')[0] ?? '';
  for (const key of [
    'rebate_status',
    'hold',
    'hold_reason',
    'rights_pending',
    'locked',
    'booked_base_fen',
    'booked_n_fen',
    'settle_period',
    'reason',
    'reason_sub',
    'is_presale',
    'buy_type',
    'scene_basis',
    'attr_at',
  ]) {
    expect(update).not.toMatch(new RegExp('"' + key + '"\\s*='));
  }
});

it('[AC-B1-08i#32] 重复投递更新后的相同内容短路，不二次加版本、history 或事件', async () => {
  const f = await scenario(db);
  const incoming = f.next({ raw_status: 'received', received_at: at(RECEIVED) });
  await f.pipeline.process(incoming, f.ctx);
  const before = await f.read();
  f.clock.advanceMs(90_000);
  expect(await f.pipeline.process({ ...incoming, raw_payload_id: '303' }, f.ctx)).toEqual({
    kind: 'unchanged',
    order_id: f.original.order_id,
  });
  expect(await f.read()).toEqual(before);
  expect(f.onUpdated).toHaveBeenCalledTimes(1);
  expect(f.publishedOf('order.updated')).toHaveLength(1);
});
