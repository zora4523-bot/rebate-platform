import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, ids, queries } from './kit.ts';

// Global setup supplies the template; the cloned database is accessed as couli_app.
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

it('[AC-B1-08l#16] 自购父单号和子单号精确命中优先于标题，片段不命中单号', async () => {
  const f = await fixture(db);
  const first = await f.seed({
    parent_order_id: '3712345678901234567',
    sub_order_id: 'child-exact-a',
  });
  const sibling = await f.seed({ parent_order_id: first.parent_order_id });
  await f.seed({ title: `title ${first.parent_order_id} ${first.sub_order_id}` });
  const q = await queries(f.deps);
  expect(ids(await q.list(f.subject, { scope: 'self', q: first.parent_order_id! }))).toEqual([
    sibling.order_id,
    first.order_id,
  ]);
  expect(ids(await q.list(f.subject, { scope: 'self', q: first.sub_order_id }))).toEqual([
    first.order_id,
  ]);
  expect(ids(await q.list(f.subject, { scope: 'self', q: 'child-exact' }))).toHaveLength(1);
  // That one result is the title row, never the order whose number merely contains q.
  expect(ids(await q.list(f.subject, { scope: 'self', q: 'child-exact' }))).not.toContain(
    first.order_id,
  );
  expect(ids(await q.list(f.subject, { scope: 'self', q: '1234567890', platform: 'pdd' }))).toEqual(
    [],
  );
});

it('[AC-B1-08l#17] 单号命中判定带其他筛选，过滤掉的精确号不阻止标题回退', async () => {
  const f = await fixture(db);
  await f.seed({ platform: 'pdd', parent_order_id: 'exact-query', rebate_status: 'WAITING' });
  await f.seed({ parent_order_id: 'exact-query', rebate_status: 'CREDITED', booked_base_fen: 99n });
  const title = await f.seed({ title: 'Title Exact-Query suffix' });
  const q = await queries(f.deps);
  expect(
    ids(
      await q.list(f.subject, {
        scope: 'self',
        q: 'exact-query',
        platform: 'jd',
        status_group: 'estimating',
        display_status: 'PAID',
        paid_month: '2027-12',
      }),
    ),
  ).toEqual([title.order_id]);
});

it.each(['%', '_', '\\'])(
  '[AC-B1-08l#18] 标题包含匹配转义 %s，大小写不敏感，null 不命中',
  async (literal) => {
    const f = await fixture(db);
    const wanted = await f.seed({ title: `AbC${literal}DeF` });
    await f.seed({ title: 'AbCXDeF' });
    await f.seed({ title: 'AbCDeF' });
    await f.seed({ title: null });
    const q = await queries(f.deps);
    expect(ids(await q.list(f.subject, { scope: 'self', q: `bc${literal}de` }))).toEqual([
      wanted.order_id,
    ]);
  },
);

it('[AC-B1-08l#19] 分享仅搜索可见标题，完整号、子单号、脱敏号和片段都不能命中', async () => {
  const f = await fixture(db);
  const link = await f.link('jd:i_12345');
  const visible = await f.seed({
    buy_type: 'share',
    link_id: link,
    parent_order_id: '251003-123456789012345',
    title: 'Share HeadPHONE',
  });
  await f.seed({
    buy_type: 'share',
    link_id: link,
    product_key: 'jd:i_99999',
    title: 'Share HeadPHONE',
  });
  await f.seed({ buy_type: 'share', title: 'Share HeadPHONE' });
  await f.seed({ buy_type: 'share', link_id: link, title: null });
  const q = await queries(f.deps);
  expect(ids(await q.list(f.subject, { scope: 'share', q: 'headphone' }))).toEqual([
    visible.order_id,
  ]);
  for (const term of [
    visible.parent_order_id!,
    visible.sub_order_id,
    '2510****45',
    '123456789012345',
  ]) {
    expect(ids(await q.list(f.subject, { scope: 'share', q: term }))).toEqual([]);
  }
  expect(f.links.productKeys).toHaveBeenCalledWith(
    f.subject.app_id,
    expect.arrayContaining([link]),
  );
});

it('[AC-B1-08l#20] 分享标题查询中 % 与 _ 也是字面字符', async () => {
  const f = await fixture(db);
  const link = await f.link('jd:i_12345');
  const literal = await f.seed({ buy_type: 'share', link_id: link, title: 'Sale 50%_OFF' });
  await f.seed({ buy_type: 'share', link_id: link, title: 'Sale 50AAOFF' });
  const q = await queries(f.deps);
  expect(ids(await q.list(f.subject, { scope: 'share', q: '50%_off' }))).toEqual([
    literal.order_id,
  ]);
});
