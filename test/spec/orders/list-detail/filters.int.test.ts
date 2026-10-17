import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, fixture, ids, queries } from './kit.ts';

// Clone the migrated template supplied by global setup; every query uses the application role.
let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08l#11] self/share、本人和 App 隔离，未归因与仅有上下级关系不可见', async () => {
  const f = await fixture(db);
  const self = await f.seed();
  const share = await f.seed({ buy_type: 'share' });
  await f.seed({ rebate_status: 'UNATTRIBUTED' });
  const childId = await f.user();
  const grandchildId = await f.user();
  await db
    .updateTable('users')
    .set({ parent_id: f.subject.user_id })
    .where('id', '=', childId)
    .execute();
  await db
    .updateTable('users')
    .set({ parent_id: childId })
    .where('id', '=', grandchildId)
    .execute();
  await f.seed({ user_id: childId });
  await f.seed({ user_id: grandchildId, buy_type: 'share' });
  const otherUser = await f.user('other-app');
  await f.seed({ app_id: 'other-app', user_id: otherUser });
  const q = await queries(f.deps);
  expect(ids(await q.list(f.subject, { scope: 'self' }))).toEqual([self.order_id]);
  expect(ids(await q.list(f.subject, { scope: 'share' }))).toEqual([share.order_id]);
  expect(ids(await q.list({ ...f.subject, app_id: 'other-app' }, { scope: 'self' }))).toEqual([]);
  expect(f.figures.forOrders).toHaveBeenCalledWith(
    f.subject,
    expect.arrayContaining([self.order_id]),
  );
});

it('[AC-B1-08l#12] 月初 +08:00 含、次月初不含，platform 与分组及状态取交集', async () => {
  const f = await fixture(db);
  const start = await f.seed({ paid_at: at('2027-11-30T16:00:00.000Z'), rebate_status: 'WAITING' });
  const end = await f.seed({ paid_at: at('2027-12-31T15:59:59.999Z'), rebate_status: 'WAITING' });
  await f.seed({ paid_at: at('2027-11-30T15:59:59.999Z'), rebate_status: 'WAITING' });
  await f.seed({ paid_at: at('2027-12-31T16:00:00.000Z'), rebate_status: 'WAITING' });
  await f.seed({ platform: 'pdd', rebate_status: 'WAITING' });
  await f.seed({ rebate_status: 'CREDITED', booked_base_fen: 99n });
  await f.seed();
  const q = await queries(f.deps);
  const filter = {
    scope: 'self',
    platform: 'jd',
    paid_month: '2027-12',
    status_group: 'estimating',
    display_status: 'WAITING',
  } as const;
  expect(ids(await q.list(f.subject, filter))).toEqual([end.order_id, start.order_id]);
  expect(ids(await q.list(f.subject, { ...filter, status_group: 'credited' }))).toEqual([]);
});

it('[AC-B1-08l#13] N=12 的边界、范围外月份、详情同范围；N=0 与缺省配置不限', async () => {
  const f = await fixture(db);
  f.settings.set('order.user_query_months', 12);
  const old = await f.seed({ paid_at: at('2026-12-31T15:59:59.999Z') });
  const edge = await f.seed({ paid_at: at('2026-12-31T16:00:00.000Z') });
  const q = await queries(f.deps);
  const page = await q.list(f.subject, { scope: 'self' });
  expect(page.earliest_visible_date).toBe('2027-01-01');
  expect(f.config.configValue).toHaveBeenCalledWith(f.subject.app_id, 'order.user_query_months');
  expect(ids(page)).toEqual([edge.order_id]);
  expect(await q.get(f.subject, old.order_id)).toBeNull();
  expect(await q.get(f.subject, edge.order_id)).toMatchObject({ order_id: edge.order_id });
  expect(await q.list(f.subject, { scope: 'self', paid_month: '2026-12' })).toMatchObject({
    items: [],
    earliest_visible_date: '2027-01-01',
  });
  for (const months of [0, undefined]) {
    if (months === undefined) f.settings.delete('order.user_query_months');
    else f.settings.set('order.user_query_months', months);
    const unlimited = await queries(f.deps);
    const all = await unlimited.list(f.subject, { scope: 'self' });
    expect(all.earliest_visible_date).toBeNull();
    expect(ids(all)).toEqual([edge.order_id, old.order_id]);
  }
});

it('[AC-B1-08l#14] 定金时间参与排序、月份和范围；已有 paid_at 时优先 paid_at', async () => {
  const f = await fixture(db);
  f.settings.set('order.user_query_months', 12);
  const deposit = await f.seed({
    is_presale: true,
    platform_status: 'DEPOSIT_PAID',
    paid_at: null,
    deposit_paid_at: at('2026-12-31T16:00:00.000Z'),
  });
  await f.seed({
    is_presale: true,
    platform_status: 'DEPOSIT_PAID',
    paid_at: null,
    deposit_paid_at: at('2026-12-31T15:59:59.999Z'),
  });
  const final = await f.seed({
    is_presale: true,
    paid_at: at('2027-01-20T03:00:00.000Z'),
    deposit_paid_at: at('2026-12-01T00:00:00.000Z'),
  });
  const q = await queries(f.deps);
  expect(ids(await q.list(f.subject, { scope: 'self', paid_month: '2027-01' }))).toEqual([
    final.order_id,
    deposit.order_id,
  ]);
});

it('[AC-B1-08l#15] 开关按各平台读取；未知 figures 不当零；本人暂缓和扣回进入筛选', async () => {
  const f = await fixture(db);
  f.settings.set('credit.enabled.jd', false);
  const off = await f.seed({ rebate_status: 'WAITING' });
  const waiting = await f.seed({ rebate_status: 'WAITING', platform: 'pdd' });
  const held = await f.seed(
    { rebate_status: 'CREDITED', booked_base_fen: 10n },
    { viewer_share_held: true },
  );
  const part = await f.seed(
    { rebate_status: 'CREDITED', booked_base_fen: 10n },
    { has_clawback: true },
  );
  const unknown = await f.seed({}, { b_est: null });
  const q = await queries(f.deps);
  for (const [order, status] of [
    [off, 'CREDITING'],
    [waiting, 'WAITING'],
    [held, 'REVIEWING'],
    [part, 'CREDITED_PART_CLAWED'],
    [unknown, 'PAID'],
  ] as const) {
    expect(ids(await q.list(f.subject, { scope: 'self', display_status: status }))).toEqual([
      order.order_id,
    ]);
  }
});
