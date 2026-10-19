import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, acquireTestRedis, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection, type TestRedis } from '../../identity/sms-codes/kit.ts';
import { fixture, failure, at } from './kit.ts';

// Global setup supplies the migrated template; fixture and application use couli_app.
let database: TestDatabase | undefined;
let server: TestRedis | undefined;
let db: Kysely<DB>;
let redis: RedisHandle;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  server = await acquireTestRedis();
  redis = (await createRedisHandle(redisConnection(server.url), {
    logger: memoryLogger().logger,
  }))!;
}, 180_000);
afterAll(async () => {
  try {
    await redis?.close();
  } finally {
    try {
      if (db) await destroyDb(db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await server?.stop();
      }
    }
  }
}, 30_000);

it('[AC-B1-10b#16] AC-S1-26-TB③ ④a按attr_at的+08日期；00:10填前一天优先所有后续失败', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed({ rebate_status: 'VOID', user_id: await f.user(), locked: true });
  await f.history(row);
  f.clock.set('2028-03-01T00:00:00Z');
  failure(await f.submit(row.sub_order_id, { paid_date: '2028-01-14' }), 30202, {
    reason: 'FACTOR_MISMATCH',
  });
  expect(await f.count(f.subject, '20280301')).toBe('1');
});

it.each([0, 1000])('[AC-B1-10b#17] AC-S1-26-TB③ 720绝对小时边界偏移%s毫秒', async (offset) => {
  const f = await fixture(db, redis);
  const row = await f.seed();
  f.clock.set('2028-02-13T16:10:00.000Z');
  f.clock.advanceMs(offset);
  if (offset === 0) await f.accepted(row.sub_order_id, [row]);
  else failure(await f.submit(row.sub_order_id), 30202, { reason: 'CLAIM_EXPIRED' });
});

it.each([undefined, 0.5, '720', -1, 0])(
  '[AC-B1-10b#18] window_hours=%s不合法按720，超过默认一秒拒绝',
  async (window) => {
    const f = await fixture(db, redis);
    if (window !== undefined) f.settings.set('claim.window_hours', window);
    const row = await f.seed();
    f.clock.set('2028-02-13T16:10:01.000Z');
    failure(await f.submit(row.sub_order_id), 30202, { reason: 'CLAIM_EXPIRED' });
    const boundary = await f.seed();
    f.clock.set('2028-02-13T16:10:00.000Z');
    await f.accepted(boundary.sub_order_id, [boundary]);
  },
);

it('[AC-B1-10b#19] 正整数window_hours生效；预售第二因子来自定金归因而非尾款', async () => {
  const f = await fixture(db, redis);
  f.settings.set('claim.window_hours', 2);
  const row = await f.seed({
    is_presale: true,
    deposit_paid_at: at('2028-01-14T16:10:00Z'),
    paid_at: at('2028-01-15T16:00:00Z'),
  });
  f.clock.set('2028-01-14T18:10:00Z');
  await f.accepted(row.sub_order_id, [row]);
  const late = await f.seed();
  f.clock.advanceMs(1000);
  failure(await f.submit(late.sub_order_id), 30202, { reason: 'CLAIM_EXPIRED' });
});

it('[AC-B1-10b#20] ④b过期优先VOID、重复、归属与锁定；④c VOID优先d/e/f', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed({ rebate_status: 'VOID', user_id: await f.user(), locked: true });
  await f.history(row);
  f.clock.set('2028-02-13T16:10:01Z');
  failure(await f.submit(row.sub_order_id), 30202, { reason: 'CLAIM_EXPIRED' });
  f.clock.set('2028-01-15T04:00:00Z');
  failure(await f.submit(row.sub_order_id), 30202, { reason: 'ORDER_INVALID' });
});

it.each([null, 'approved', 'rejected', 'cancelled'] as const)(
  '[AC-B1-10b#21] ④d任何decision=%s的跨claim记录都30205，先于本人归属和locked',
  async (decision) => {
    const f = await fixture(db, redis);
    const row = await f.seed({ user_id: f.subject.user_id, locked: true });
    await f.history(
      row,
      {},
      {
        decision,
        reject_reason: decision === 'rejected' ? 'NO_EVIDENCE' : null,
        decided_at: decision === null ? null : f.clock.now(),
      },
    );
    failure(await f.submit(row.sub_order_id), 30205);
    expect(await f.count()).toBe('1');
    expect(await f.claims()).toHaveLength(1);
  },
);

it('[AC-B1-10b#22] 他人同单记录不算本人重复，自己第二次才30205', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed();
  await f.history(row, { user_id: await f.user() });
  await f.accepted(row.sub_order_id, [row]);
  failure(await f.submit(row.sub_order_id), 30205);
  expect(await f.count()).toBe('1');
});

it.each(['mine', 'other', 'locked'] as const)(
  '[AC-B1-10b#23] ④e/f %s 的错误码、reason与无泄漏',
  async (mode) => {
    const f = await fixture(db, redis);
    const row = await f.seed({
      user_id: mode === 'mine' ? f.subject.user_id : mode === 'other' ? await f.user() : null,
      locked: true,
    });
    failure(
      await f.submit(row.sub_order_id),
      mode === 'mine' ? 30202 : 30204,
      mode === 'mine' ? { reason: 'ALREADY_YOURS' } : undefined,
    );
    expect(await f.count()).toBe('1');
    expect(await f.items()).toEqual([]);
  },
);

it('[AC-B1-10b#24] 全失败按JS字符串升序第一项返回，不按插入顺序或错误码排序', async () => {
  const f = await fixture(db, redis);
  const suffix = f.subject.user_id;
  const parent = 'P' + suffix;
  await f.seed({ sub_order_id: 'a' + suffix, parent_order_id: parent, rebate_status: 'VOID' });
  await f.seed({ sub_order_id: 'Z' + suffix, parent_order_id: parent, locked: true });
  failure(await f.submit(parent), 30204);
  expect(await f.count()).toBe('1'); // one failed request, not two failed children
  expect(await f.claims()).toEqual([]);
});

it('[AC-B1-10b#25] 部分通过只写通过者且升序；部分失败不计数，orders整行不变', async () => {
  const f = await fixture(db, redis);
  const suffix = f.subject.user_id;
  const parent = 'P' + suffix;
  const z = await f.seed({ sub_order_id: 'z' + suffix, parent_order_id: parent });
  await f.seed({ sub_order_id: 'a' + suffix, parent_order_id: parent, user_id: f.subject.user_id });
  const upper = await f.seed({ sub_order_id: 'Z' + suffix, parent_order_id: parent });
  await f.seed({ parent_order_id: parent, buy_type: 'share', user_id: await f.user() });
  const before = await db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('order_id')
    .execute();
  await f.accepted(parent, [z, upper], {}, 'parent');
  expect(await f.count()).toBeNull();
  expect(
    await db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', f.subject.app_id)
      .orderBy('order_id')
      .execute(),
  ).toEqual(before);
  failure(await f.submit(upper.sub_order_id), 30205);
});
