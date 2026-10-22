import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import { createOrderLinkReader } from '../../../../apps/api/src/modules/linking/index.ts';
import { at, fixture, ids, queries } from './kit.ts';
import { withHttp } from './http-kit.ts';
import { validate } from './schema-kit.ts';

// createTestDatabase gets its admin connection from the integration global setup. Application
// reads and fixture writes use couli_app; no live platform adapter or listener is involved.
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

it('[AC-B1-08l#40] linking 真实读端口按 app_id 读取链接商品，驱动分享投影和检索', async () => {
  const f = await fixture(db);
  const foreign = await fixture(db);
  const link = await f.link('jd:i_12345');
  const nullProduct = await f.link(null);
  const foreignLink = await foreign.link('jd:i_99999');
  const missing = randomUUID();
  const same = await f.seed({ buy_type: 'share', link_id: link, title: 'Visible Headphones' });
  const different = await f.seed({
    buy_type: 'share',
    link_id: link,
    product_key: 'jd:i_99999',
    title: 'Private Camera',
  });
  // Poison the old fake's map: this test must read links.product_key from PostgreSQL.
  f.products.clear();
  const links = createOrderLinkReader(db);
  const products = await links.productKeys(f.subject.app_id, [
    link,
    nullProduct,
    foreignLink,
    missing,
  ]);
  expect(products.get(link)).toBe('jd:i_12345');
  expect(products.get(nullProduct) ?? null).toBeNull();
  expect(products.get(foreignLink) ?? null).toBeNull();
  expect(products.get(missing) ?? null).toBeNull();
  expect(
    (await links.productKeys(foreign.subject.app_id, [link, foreignLink])).get(foreignLink),
  ).toBe('jd:i_99999');
  expect((await links.productKeys(foreign.subject.app_id, [link])).get(link) ?? null).toBeNull();
  expect((await links.productKeys(f.subject.app_id, [])).size).toBe(0);

  const q = await queries({ ...f.deps, links });
  const page = await q.list(f.subject, { scope: 'share' });
  expect(ids(page).sort()).toEqual([same.order_id, different.order_id].sort());
  for (const row of [same, different]) {
    const matches = row.order_id === same.order_id;
    const projection = {
      order_id: row.order_id,
      is_other_product: !matches,
      title: matches ? row.title : null,
      image_url: matches ? row.image_url : null,
    };
    expect(page.items.find((item) => item.order_id === row.order_id)).toMatchObject(projection);
    const detail = await q.get(f.subject, row.order_id);
    expect(detail).toMatchObject({ ...projection, product_key: matches ? row.product_key : null });
    for (const output of [page.items.find((item) => item.order_id === row.order_id), detail]) {
      expect(output).not.toHaveProperty('order_no');
      expect(JSON.stringify(output)).not.toContain(row.sub_order_id);
      expect(JSON.stringify(output)).not.toContain(row.parent_order_id);
    }
  }
  expect(ids(await q.list(f.subject, { scope: 'share', q: 'Headphones' }))).toEqual([
    same.order_id,
  ]);
  expect(ids(await q.list(f.subject, { scope: 'share', q: 'Camera' }))).toEqual([]);
  await validate({ code: 0, msg: '', trace_id: randomUUID(), data: page }, 'OrderListResponse');
});

it('[AC-B1-08l#41] 生产装配保留 OrderQueries 与 linking 端口，HTTP 返回真实查询和分享投影', async () => {
  const f = await fixture(db);
  const link = await f.link('jd:i_12345');
  const self = await f.seed();
  const same = await f.seed({ buy_type: 'share', link_id: link, title: 'Visible Headphones' });
  const other = await f.seed({
    buy_type: 'share',
    link_id: link,
    product_key: 'jd:i_99999',
    title: 'Private Camera',
  });
  await withHttp(
    undefined,
    f.subject,
    async (send) => {
      // Independent direct caller of the B3-08 surface, with the same real readers as production.
      // Production also wires the claim-entry reader (B1-10h); the direct caller gets the same real
      // reader (mechanical fixture fix, ruling D10-127; assertions unchanged).
      const { createClaimEntryReader } =
        await import('../../../../apps/api/src/modules/linking/index.ts');
      const q = await queries({
        db,
        clock: f.clock,
        config: createContentReader({ db, clock: f.clock }),
        links: createOrderLinkReader(db),
        claimEntry: createClaimEntryReader(db),
      });
      for (const scope of ['self', 'share'] as const) {
        const response = await send(`/v1/orders?scope=${scope}`);
        expect(response.statusCode).toBe(200);
        const data = (response.json() as { data: Awaited<ReturnType<typeof q.list>> }).data;
        expect(ids(data).sort()).toEqual(
          (scope === 'self' ? [self.order_id] : [same.order_id, other.order_id]).sort(),
        );
        expect(data).toEqual(await q.list(f.subject, { scope }));
        if (scope === 'share') {
          expect(data.items.find((item) => item.order_id === same.order_id)).toMatchObject({
            is_other_product: false,
            title: same.title,
            image_url: same.image_url,
          });
          expect(data.items.find((item) => item.order_id === other.order_id)).toMatchObject({
            is_other_product: true,
            title: null,
            image_url: null,
          });
          for (const row of [same, other]) {
            expect(response.body).not.toContain(row.sub_order_id);
            expect(response.body).not.toContain(row.parent_order_id);
          }
        }
      }
      const found = await send('/v1/orders?scope=share&q=Headphones');
      expect(found.statusCode).toBe(200);
      expect(found.json()).toMatchObject({ data: { items: [{ order_id: same.order_id }] } });
      expect((found.json() as { data: { items: unknown[] } }).data.items).toHaveLength(1);
      const hidden = await send('/v1/orders?scope=share&q=Camera');
      expect(hidden.statusCode).toBe(200);
      expect(hidden.json()).toMatchObject({ data: { items: [] } });
      for (const row of [self, same, other]) {
        const response = await send(`/v1/orders/${row.order_id}`);
        expect(response.statusCode).toBe(200);
        expect((response.json() as { data: unknown }).data).toEqual(
          await q.get(f.subject, row.order_id),
        );
        if (row.buy_type === 'share') {
          expect(response.json()).toMatchObject({
            data: { product_key: row.order_id === same.order_id ? 'jd:i_12345' : null },
          });
          expect(response.body).not.toContain(row.sub_order_id);
          expect(response.body).not.toContain(row.parent_order_id);
        }
      }
    },
    {
      db,
      dbRead: null,
      // The suite owns the pool; closing the HTTP app must not close other fixtures' handles.
      close: async () => undefined,
    },
  );
}, 30_000);

it.each([
  ['3712345678901234567', '3712****67'],
  ['12345678', '****78'],
])('[AC-B1-08l#42] 分享单无父单号时列表和详情只给子单号 %s 的脱敏值 %s', async (sub, masked) => {
  const f = await fixture(db);
  const link = await f.link('jd:i_12345');
  const row = await f.seed({
    buy_type: 'share',
    link_id: link,
    parent_order_id: null,
    sub_order_id: sub,
  });
  const q = await queries(f.deps);
  const page = await q.list(f.subject, { scope: 'share' });
  expect(page.items).toHaveLength(1);
  const detail = await q.get(f.subject, row.order_id);
  for (const output of [page.items[0], detail]) {
    expect(output).toMatchObject({ order_id: row.order_id, masked_order_no: masked });
    for (const field of ['order_no', 'parent_order_id', 'sub_order_id']) {
      expect(output).not.toHaveProperty(field);
    }
    expect(JSON.stringify(output)).not.toContain(sub);
  }
  await validate({ code: 0, msg: '', trace_id: randomUUID(), data: page }, 'OrderListResponse');
  await validate({ code: 0, msg: '', trace_id: randomUUID(), data: detail }, 'OrderDetailResponse');
});

it('[AC-B1-08l#43] 扣回节点取同单 rebate/CLAWED_BACK 最近历史，排除其他状态、字段和订单', async () => {
  const f = await fixture(db);
  const row = await f.seed({ rebate_status: 'CLAWED_BACK', reason: 'REFUND' });
  const other = await f.seed({ rebate_status: 'CLAWED_BACK', reason: 'REFUND' });
  for (const [orderId, field, status, time] of [
    [row.order_id, 'rebate', 'CLAWED_BACK', '2027-12-20T01:00:00.000Z'],
    [row.order_id, 'rebate', 'CLAWED_BACK', '2027-12-21T02:00:00.000Z'],
    [row.order_id, 'platform', 'CLAWED_BACK', '2027-12-22T03:00:00.000Z'],
    [row.order_id, 'rebate', 'VOID', '2027-12-23T04:00:00.000Z'],
    [other.order_id, 'rebate', 'CLAWED_BACK', '2027-12-24T05:00:00.000Z'],
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
  const detail = await q.get(f.subject, row.order_id);
  expect(detail).toMatchObject({ display_status: 'CLAWED_BACK' });
  expect(detail?.timeline.filter((item) => item.node === 'clawed_back')).toEqual([
    { node: 'clawed_back', at: '2027-12-21T02:00:00.000Z', period: null },
  ]);
});
