import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, fixture, queries } from './kit.ts';
import { validate } from './schema-kit.ts';

// The global setup provides the migrated template; all fixture and query access is couli_app.
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

it('[AC-B1-08l#25] 自购详情完整投影：父单号、商品、金额、原因、价格比较和份额', async () => {
  const f = await fixture(db);
  const row = await f.seed(
    { reason: 'BLACKLIST', is_price_compare: true, quantity: 2 },
    {
      est_rebate_fen: 269n,
      actual_fen: 199n,
      clawback_fen: 70n,
      expected_credit_period: '2028-02',
      credit_overdue: true,
      appeal_pending: true,
    },
  );
  const q = await queries(f.deps);
  const detail = await q.get(f.subject, row.order_id);
  expect(detail).toMatchObject({
    order_id: row.order_id,
    order_no: row.parent_order_id,
    product_key: 'jd:i_12345',
    title: row.title,
    image_url: row.image_url,
    pay_amount_fen: 12345,
    quantity: 2,
    reason: 'BLACKLIST',
    reason_action: ['APPEAL'],
    is_price_compare: true,
    est_rebate_fen: 269,
    actual_fen: 199,
    clawback_fen: 70,
    expected_credit_period: '2028-02',
    credit_overdue: true,
    appeal_pending: true,
    is_other_product: false,
  });
  expect(detail).not.toHaveProperty('masked_order_no');
  await validate({ code: 0, msg: '', trace_id: randomUUID(), data: detail }, 'OrderDetailResponse');
  const childOnly = await f.seed({ parent_order_id: null, product_key: null });
  expect(await q.get(f.subject, childOnly.order_id)).toMatchObject({
    order_no: childOnly.sub_order_id,
    product_key: null,
  });
});

it.each([
  'same',
  'different',
  'missing-link',
  'missing-product',
  'null-link-product',
  'unresolved-link',
] as const)('[AC-B1-08l#26] 分享投影 %s：所有出口服务端裁剪且不带购买者信息', async (kind) => {
  const f = await fixture(db);
  const link = await f.link(kind === 'null-link-product' ? null : 'jd:i_12345');
  if (kind === 'unresolved-link') f.products.delete(link);
  const row = await f.seed({
    buy_type: 'share',
    link_id: kind === 'missing-link' ? null : link,
    product_key:
      kind === 'missing-product' ? null : kind === 'different' ? 'jd:i_99999' : 'jd:i_12345',
    parent_order_id: '3712345678901234567',
    sub_order_id: `private-child-${randomUUID()}`,
    custom_params: 'private-buyer-data',
    raw_item_id: 'private-sku',
  });
  const q = await queries(f.deps);
  const page = await q.list(f.subject, { scope: 'share' });
  const detail = await q.get(f.subject, row.order_id);
  const same = kind === 'same';
  const projection = {
    masked_order_no: '3712****67',
    is_other_product: !same,
    title: same ? row.title : null,
    image_url: same ? row.image_url : null,
    quantity: null,
  };
  expect(page.items).toEqual([expect.objectContaining(projection)]);
  expect(detail).toMatchObject({ ...projection, product_key: same ? 'jd:i_12345' : null });
  for (const value of [page.items[0], detail]) {
    for (const field of [
      'order_no',
      'sub_order_id',
      'parent_order_id',
      'user_id',
      'buyer',
      'sku',
      'raw_item_id',
      'custom_params',
    ]) {
      expect(value).not.toHaveProperty(field);
    }
    const serialized = JSON.stringify(value);
    for (const secret of [
      row.parent_order_id!,
      row.sub_order_id,
      'private-buyer-data',
      'private-sku',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  }
  await validate({ code: 0, msg: '', trace_id: randomUUID(), data: page }, 'OrderListResponse');
  await validate({ code: 0, msg: '', trace_id: randomUUID(), data: detail }, 'OrderDetailResponse');
});

it('[AC-B1-08l#27] 预售仅定金时不把总价与尾款时间当已付，尾款后返回实付总额', async () => {
  const f = await fixture(db);
  const deposit = await f.seed({
    is_presale: true,
    platform_status: 'DEPOSIT_PAID',
    paid_at: null,
    deposit_paid_at: at('2027-12-03T01:00:00.000Z'),
  });
  const final = await f.seed({ is_presale: true, deposit_paid_at: at('2027-12-04T02:00:00.000Z') });
  const q = await queries(f.deps);
  const page = await q.list(f.subject, { scope: 'self' });
  expect(page.items.find((r) => r.order_id === deposit.order_id)).toMatchObject({
    display_status: 'DEPOSIT_PAID',
    pay_amount_fen: null,
    paid_at: null,
    quantity: null,
  });
  expect(await q.get(f.subject, deposit.order_id)).toMatchObject({
    pay_amount_fen: null,
    paid_at: null,
    timeline: [
      { node: 'deposit_paid', at: '2027-12-03T01:00:00.000Z', period: null },
      { node: 'final_paid', at: null, period: null },
      { node: 'received', at: null, period: null },
      { node: 'credit_expected', at: null, period: null },
      { node: 'credited', at: null, period: null },
    ],
  });
  expect(await q.get(f.subject, final.order_id)).toMatchObject({
    pay_amount_fen: 12345,
    paid_at: (final.paid_at as Date).toISOString(),
  });
});

it.each([
  'javascript:alert(1)',
  '//img.example.test/a.png',
  '/a.png',
  'ftp://img.example.test/a',
  'not a URL',
  null,
])('[AC-B1-08l#28] 非绝对 http(s) 图片 %s 裁成 null', async (image_url) => {
  const f = await fixture(db);
  const row = await f.seed({ image_url });
  const q = await queries(f.deps);
  expect(await q.get(f.subject, row.order_id)).toMatchObject({ image_url: null });
  expect((await q.list(f.subject, { scope: 'self' })).items[0]).toMatchObject({ image_url: null });
});

it('[AC-B1-08l#29] invalid 时间取同单 rebate/VOID 的最近历史，而非其他字段或其他单', async () => {
  const f = await fixture(db);
  const row = await f.seed({ rebate_status: 'VOID', reason: 'REFUND' });
  const other = await f.seed({ rebate_status: 'VOID' });
  for (const [orderId, field, status, time] of [
    [row.order_id, 'rebate', 'VOID', '2027-12-20T01:00:00.000Z'],
    [row.order_id, 'rebate', 'VOID', '2027-12-21T02:00:00.000Z'],
    [row.order_id, 'platform', 'INVALID', '2027-12-22T03:00:00.000Z'],
    [row.order_id, 'rebate', 'CLAWED_BACK', '2027-12-23T04:00:00.000Z'],
    [other.order_id, 'rebate', 'VOID', '2027-12-24T05:00:00.000Z'],
  ] as const) {
    await db
      .insertInto('order_status_history')
      .values({
        app_id: f.subject.app_id,
        order_id: orderId,
        field,
        to_status: status,
        from_status: null,
        event: 'synthetic-history',
        source: 'system',
        at: at(time),
        created_at: at(time),
      })
      .execute();
  }
  const q = await queries(f.deps);
  expect((await q.get(f.subject, row.order_id))?.timeline.at(-1)).toEqual({
    node: 'invalid',
    at: '2027-12-21T02:00:00.000Z',
    period: null,
  });
});

it('[AC-B1-08l#30] figures 缺省时全部未知、不伪造零额与月份、尚未入账不是 NO_REBATE', async () => {
  const f = await fixture(db);
  const row = await f.seed();
  const { figures: omitted, ...deps } = f.deps;
  void omitted;
  const q = await queries(deps);
  expect(await q.get(f.subject, row.order_id)).toMatchObject({
    display_status: 'PAID',
    est_rebate_fen: null,
    actual_fen: null,
    clawback_fen: null,
    expected_credit_period: null,
    credit_overdue: false,
    appeal_pending: false,
  });
});
