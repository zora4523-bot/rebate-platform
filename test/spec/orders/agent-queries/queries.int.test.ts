import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AgentOrderItem } from '../../../../apps/api/src/modules/orders/index.ts';
import { at, fixture, queries } from '../list-detail/kit.ts';

// TEST_PG_ADMIN_URL is consumed by the existing global setup/createTestDatabase kit.
// Never run this file on the host: the orchestrator runs the red check in its container.
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

const day = { date_from: '2027-12-12', date_to: '2027-12-12' };
const month = { date_from: '2027-12-01', date_to: '2027-12-31' };
const itemIds = (items: readonly AgentOrderItem[]) => items.map((item) => item.order_id);

async function setup() {
  const f = await fixture(db);
  // Keep the legacy kit unchanged; this task uses explicit instants and synthetic media.
  const seed: typeof f.seed = (patch, figures) =>
    f.seed(
      {
        title: 'Synthetic Headphones',
        image_url: 'https://img.example.invalid/synthetic.png',
        paid_at: at('2027-12-12T04:00:00.000Z'),
        ...patch,
      },
      figures,
    );
  return { ...f, seed };
}

it('[AC-B3-08f#1][BR-TEXT-02] 合并本人 self/share，隔离 App、他人、未归因和直推/间推订单', async () => {
  const f = await setup();
  const self = await f.seed({ paid_at: at('2027-12-12T01:00:00.000Z') });
  const share = await f.seed({ buy_type: 'share' });
  await f.seed({ user_id: null, rebate_status: 'UNATTRIBUTED', buy_type: null });
  await f.seed({ rebate_status: 'UNATTRIBUTED' });
  await f.seed({ buy_type: null });
  const stranger = await f.user();
  const child = await f.user();
  const grandchild = await f.user();
  await db
    .updateTable('users')
    .set({ parent_id: f.subject.user_id })
    .where('id', '=', child)
    .execute();
  await db.updateTable('users').set({ parent_id: child }).where('id', '=', grandchild).execute();
  await f.seed({ user_id: stranger });
  await f.seed({ user_id: child });
  await f.seed({ user_id: grandchild, buy_type: 'share' });
  const otherAppUser = await f.user('synthetic-other-app');
  await f.seed({ app_id: 'synthetic-other-app', user_id: otherAppUser });
  const q = await queries(f.deps);
  const found = await q.searchForAgent(f.subject, day);
  expect(itemIds(found.orders)).toEqual([share.order_id, self.order_id]);
  expect(found.total).toBe(2);
  // The subject pair must be honored even when only its app_id differs.
  expect(await q.searchForAgent({ ...f.subject, app_id: 'synthetic-other-app' }, day)).toEqual({
    orders: [],
    total: 0,
  });
  expect(
    await q.findOwnByNumber(
      { ...f.subject, app_id: 'synthetic-other-app' },
      { order_no: self.sub_order_id },
    ),
  ).toEqual([]);
});

it('[AC-B3-08f#1][BR-TEXT-02] 配置的可查范围与日期区间取交集，单号查询也不越界', async () => {
  const f = await setup();
  // Existing list/get fixture: at 2028-01-15, 12 months starts at 2027-01-01 +08.
  f.settings.set('order.user_query_months', 12);
  const old = await f.seed({ paid_at: at('2026-12-31T15:59:59.999Z') });
  const edge = await f.seed({ paid_at: at('2026-12-31T16:00:00.000Z') });
  await f.seed({ buy_type: 'share', paid_at: at('2026-12-31T15:59:59.999Z') });
  const q = await queries(f.deps);
  const found = await q.searchForAgent(f.subject, {
    date_from: '2026-12-31',
    date_to: '2027-01-01',
  });
  expect(itemIds(found.orders)).toEqual([edge.order_id]);
  expect(found.total).toBe(1);
  expect(await q.findOwnByNumber(f.subject, { order_no: old.sub_order_id })).toEqual([]);
  expect(itemIds(await q.findOwnByNumber(f.subject, { order_no: edge.sub_order_id }))).toEqual([
    edge.order_id,
  ]);
});

it('[AC-B3-08f#2][BR-AI-07] +08:00 两端闭区间，前后 1ms 排除，多日区间含中间日', async () => {
  const f = await setup();
  const start = await f.seed({ paid_at: at('2027-12-11T16:00:00.000Z') });
  const middle = await f.seed({ paid_at: at('2027-12-13T04:00:00.000Z'), buy_type: 'share' });
  const end = await f.seed({ paid_at: at('2027-12-14T15:59:59.999Z') });
  await f.seed({ paid_at: at('2027-12-11T15:59:59.999Z') });
  await f.seed({ paid_at: at('2027-12-14T16:00:00.000Z'), buy_type: 'share' });
  const q = await queries(f.deps);
  const found = await q.searchForAgent(f.subject, { ...day, date_to: '2027-12-14' });
  expect(itemIds(found.orders)).toEqual([end.order_id, middle.order_id, start.order_id]);
  expect(found.total).toBe(3);
});

it('[AC-B3-08f#2][BR-AI-07] 同一天也含首尾，self/share 交错按付款时间、同刻按 order_id 倒序后截断', async () => {
  const f = await setup();
  // Deliberately disagree with insertion/created_at order, including the equal-time pair.
  const end = await f.seed({ buy_type: 'share', paid_at: at('2027-12-12T15:59:59.999Z') });
  const high = await f.seed({
    buy_type: 'share',
    order_id: '00000000-0000-4000-8000-000000000002',
  });
  const start = await f.seed({ paid_at: at('2027-12-11T16:00:00.000Z') });
  const low = await f.seed({ order_id: '00000000-0000-4000-8000-000000000001' });
  await f.seed({ paid_at: at('2027-12-11T15:59:59.999Z') });
  await f.seed({ paid_at: at('2027-12-12T16:00:00.000Z') });
  const q = await queries(f.deps);
  const all = await q.searchForAgent(f.subject, day);
  expect(itemIds(all.orders)).toEqual([end.order_id, high.order_id, low.order_id, start.order_id]);
  expect(all.total).toBe(4);
  const limited = await q.searchForAgent(f.subject, { ...day, limit: 2 });
  expect(itemIds(limited.orders)).toEqual([end.order_id, high.order_id]);
  expect(limited.total).toBe(4);
});

it('[AC-B3-08f#2][BR-AI-07] 默认最多 8 条，total 越过列表分页批次，最小 limit 为 1', async () => {
  const f = await setup();
  const expected: string[] = [];
  // More than the legacy list's 50-row batch: total must not count only one page/batch.
  for (let i = 0; i < 61; i += 1) {
    const row = await f.seed({
      order_id: `00000000-0000-4000-8001-${String(i).padStart(12, '0')}`,
      buy_type: i % 2 === 0 ? 'self' : 'share',
    });
    expected.unshift(row.order_id);
  }
  const q = await queries(f.deps);
  const found = await q.searchForAgent(f.subject, day);
  expect(itemIds(found.orders)).toEqual(expected.slice(0, 8));
  expect(found.total).toBe(61);
  const single = await q.searchForAgent(f.subject, { ...day, limit: 1 });
  expect(itemIds(single.orders)).toEqual(expected.slice(0, 1));
  expect(single.total).toBe(61);
});

it('[AC-B3-08f#2][BR-AI-07] 定金单用 deposit_paid_at，已有 paid_at 时优先付款时间', async () => {
  const f = await setup();
  const deposit = await f.seed({
    is_presale: true,
    platform_status: 'DEPOSIT_PAID',
    paid_at: null,
    deposit_paid_at: at('2027-12-11T16:00:00.000Z'),
  });
  const final = await f.seed({
    is_presale: true,
    deposit_paid_at: at('2027-11-01T00:00:00.000Z'),
  });
  await f.seed({
    is_presale: true,
    platform_status: 'DEPOSIT_PAID',
    paid_at: null,
    deposit_paid_at: at('2027-12-11T15:59:59.999Z'),
  });
  await f.seed({
    is_presale: true,
    paid_at: at('2027-12-12T16:00:00.000Z'),
    deposit_paid_at: at('2027-12-12T04:00:00.000Z'),
  });
  await f.seed({ paid_at: null, deposit_paid_at: null });
  const q = await queries(f.deps);
  const found = await q.searchForAgent(f.subject, day);
  expect(itemIds(found.orders)).toEqual([final.order_id, deposit.order_id]);
  expect(found.total).toBe(2);
  expect(found.orders[1]).toMatchObject({ display_status: 'DEPOSIT_PAID' });
});

it('[AC-B3-08f#3][BR-TEXT-02][AC-S1-106③] 标题不区分大小写包含匹配，分享其他商品即使同标题也不命中', async () => {
  const f = await setup();
  const link = await f.link('jd:i_12345');
  const self = await f.seed({
    title: 'Synthetic aBcDeF suffix',
    paid_at: at('2027-12-12T01:00:00.000Z'),
  });
  const share = await f.seed({
    title: 'Synthetic aBCdeF suffix',
    buy_type: 'share',
    link_id: link,
  });
  await f.seed({
    title: 'Synthetic AbCdEf suffix',
    buy_type: 'share',
    link_id: link,
    product_key: 'jd:synthetic-other',
  });
  await f.seed({ title: 'Synthetic AbCdEf suffix', buy_type: 'share' });
  await f.seed({ title: null });
  const q = await queries(f.deps);
  const found = await q.searchForAgent(f.subject, { ...day, keyword: 'bCdE', limit: 1 });
  expect(itemIds(found.orders)).toEqual([share.order_id]);
  expect(found.total).toBe(2);
  expect(itemIds((await q.searchForAgent(f.subject, { ...day, keyword: 'bCdE' })).orders)).toEqual([
    share.order_id,
    self.order_id,
  ]);
});

it.each(['%', '_', '\\'])(
  '[AC-B3-08f#3][BR-TEXT-02] self 与 share 的标题 %s 按字面匹配',
  async (literal) => {
    const f = await setup();
    const link = await f.link('jd:i_12345');
    const self = await f.seed({
      title: `Synthetic AbC${literal}DeF`,
      paid_at: at('2027-12-12T01:00:00.000Z'),
    });
    const share = await f.seed({
      title: `Synthetic AbC${literal}DeF`,
      buy_type: 'share',
      link_id: link,
    });
    for (const title of ['Synthetic AbCXDeF', 'Synthetic AbCDeF']) {
      await f.seed({ title });
      await f.seed({ title, buy_type: 'share', link_id: link });
    }
    const q = await queries(f.deps);
    const found = await q.searchForAgent(f.subject, { ...day, keyword: `bc${literal}de` });
    expect(itemIds(found.orders)).toEqual([share.order_id, self.order_id]);
    expect(found.total).toBe(2);
  },
);

it('[AC-B3-08f#3][BR-TEXT-02] keyword 精确命中自购父/子单号时优先单号，不混入自购标题命中', async () => {
  const f = await setup();
  const first = await f.seed({
    parent_order_id: 'synthetic-parent-01',
    sub_order_id: 'synthetic-child-01',
    paid_at: at('2027-12-12T01:00:00.000Z'),
  });
  const sibling = await f.seed({ parent_order_id: first.parent_order_id });
  await f.seed({ title: `Synthetic ${first.parent_order_id} ${first.sub_order_id}` });
  const q = await queries(f.deps);
  const parent = await q.searchForAgent(f.subject, { ...day, keyword: 'synthetic-parent-01' });
  expect(itemIds(parent.orders)).toEqual([sibling.order_id, first.order_id]);
  expect(parent.total).toBe(2);
  const child = await q.searchForAgent(f.subject, { ...day, keyword: first.sub_order_id });
  expect(itemIds(child.orders)).toEqual([first.order_id]);
  expect(child.total).toBe(1);
});

it.each(['parent', 'child', 'fragment'] as const)(
  '[AC-B3-08f#3][BR-TEXT-02][AC-S1-106②] keyword 为分享单的 %s 单号或片段时不命中',
  async (kind) => {
    const f = await setup();
    const link = await f.link('jd:i_12345');
    // Use a visible same-product share so title privacy cannot hide an incorrect number match.
    const share = await f.seed({
      buy_type: 'share',
      link_id: link,
      parent_order_id: `synthetic-p-${kind}`,
      sub_order_id: `synthetic-c-${kind}`,
    });
    await f.seed();
    const terms = {
      parent: `synthetic-p-${kind}`,
      child: share.sub_order_id,
      fragment: 'p-frag',
    };
    const q = await queries(f.deps);
    expect(await q.searchForAgent(f.subject, { ...day, keyword: terms[kind] })).toEqual({
      orders: [],
      total: 0,
    });
  },
);

it('[AC-B3-08f#2][BR-AI-07] platform 与日期及 keyword 取交集，total 只统计匹配项，空结果为零', async () => {
  const f = await setup();
  const pdd = await f.seed({ platform: 'pdd', title: 'Synthetic Match' });
  await f.seed({ title: 'Synthetic Match' });
  await f.seed({ platform: 'pdd', title: 'Synthetic Unrelated' });
  await f.seed({
    platform: 'pdd',
    title: 'Synthetic Match',
    paid_at: at('2027-12-13T04:00:00.000Z'),
  });
  const q = await queries(f.deps);
  const found = await q.searchForAgent(f.subject, { ...day, keyword: 'match', platform: 'pdd' });
  expect(itemIds(found.orders)).toEqual([pdd.order_id]);
  expect(found.total).toBe(1);
  expect(await q.searchForAgent(f.subject, { ...day, platform: 'taobao' })).toEqual({
    orders: [],
    total: 0,
  });
});

it.each(['self', 'share-same', 'share-other', 'share-unknown'] as const)(
  '[AC-B3-08f#4][BR-TEXT-02][BR-AI-07][AC-S1-106④] %s 仅返回八字段，结算期与 get 一致',
  async (kind) => {
    const f = await setup();
    const link = await f.link('jd:i_12345');
    const hidden = kind === 'share-other' || kind === 'share-unknown';
    const row = await f.seed(
      {
        buy_type: kind === 'self' ? 'self' : 'share',
        link_id: kind === 'share-unknown' ? null : link,
        product_key: kind === 'share-other' ? 'jd:synthetic-other' : 'jd:i_12345',
        platform_status: 'RECEIVED',
        rebate_status: 'WAITING',
        reason: 'PART_REFUND',
      },
      { expected_credit_period: '2028-02', est_rebate_fen: 321n },
    );
    const q = await queries(f.deps);
    const found = await q.searchForAgent(f.subject, month);
    const expected = {
      order_id: row.order_id,
      platform: 'jd',
      title: hidden ? null : 'Synthetic Headphones',
      is_other_product: hidden,
      display_status: 'WAITING',
      reason: 'PART_REFUND',
      est_rebate_fen: 321,
      expected_credit_period: '2028-02',
    };
    // Exact equality rejects full/masked numbers, image, raw statuses and any other fields.
    expect(found).toEqual({ orders: [expected], total: 1 });
    const detail = await q.get(f.subject, row.order_id);
    expect(detail).toMatchObject({ expected_credit_period: '2028-02', is_other_product: hidden });
    expect(found.orders[0]?.expected_credit_period).toBe(detail?.expected_credit_period);
    if (kind === 'self') {
      expect(await q.findOwnByNumber(f.subject, { order_no: row.sub_order_id })).toEqual([
        expected,
      ]);
    }
  },
);

it('[AC-B3-08f#4][BR-AI-07] 未知金额和结算期保留 null，不猜测日期或金额', async () => {
  const f = await setup();
  const row = await f.seed();
  const q = await queries(f.deps);
  const expected = {
    order_id: row.order_id,
    platform: 'jd',
    title: 'Synthetic Headphones',
    is_other_product: false,
    display_status: 'PAID',
    reason: null,
    est_rebate_fen: null,
    expected_credit_period: null,
  };
  expect(await q.searchForAgent(f.subject, day)).toEqual({ orders: [expected], total: 1 });
  expect(await q.findOwnByNumber(f.subject, { order_no: row.sub_order_id })).toEqual([expected]);
});

it('[AC-B3-08f#5][BR-TEXT-02] 按父单号返回全部本人自购子单，子单号精确匹配，platform 限定', async () => {
  const f = await setup();
  const number = 'synthetic-parent-02';
  const first = await f.seed({
    parent_order_id: number,
    sub_order_id: 'synthetic-child-02',
    paid_at: at('2027-12-12T01:00:00.000Z'),
  });
  const sibling = await f.seed({ parent_order_id: number });
  const pdd = await f.seed({
    parent_order_id: number,
    platform: 'pdd',
    paid_at: at('2027-12-12T08:00:00.000Z'),
  });
  await f.seed({ parent_order_id: number, buy_type: 'share' });
  await f.seed({ title: `Synthetic ${number} synthetic-child-02` });
  const q = await queries(f.deps);
  const all = await q.findOwnByNumber(f.subject, { order_no: number });
  expect(itemIds(all).sort()).toEqual([first.order_id, sibling.order_id, pdd.order_id].sort());
  expect(
    itemIds(await q.findOwnByNumber(f.subject, { order_no: number, platform: 'jd' })).sort(),
  ).toEqual([first.order_id, sibling.order_id].sort());
  expect(itemIds(await q.findOwnByNumber(f.subject, { order_no: first.sub_order_id }))).toEqual([
    first.order_id,
  ]);
  expect(
    await q.findOwnByNumber(f.subject, { order_no: first.sub_order_id, platform: 'pdd' }),
  ).toEqual([]);
  const noParent = await f.seed({ parent_order_id: null });
  expect(itemIds(await q.findOwnByNumber(f.subject, { order_no: noParent.sub_order_id }))).toEqual([
    noParent.order_id,
  ]);
});

it.each([
  'share-parent',
  'share-child',
  'masked',
  'fragment',
  'missing',
  'other-user',
  'other-app',
  'unattributed',
  'title-only',
  'self-fragment',
] as const)(
  '[AC-B3-08f#5][BR-TEXT-02][BR-AI-07][AC-S1-106②] %s 单号一律查不到，不能回退标题',
  async (kind) => {
    const f = await setup();
    const share = await f.seed({
      buy_type: 'share',
      parent_order_id: `synthetic-share-${kind}-12345`,
      sub_order_id: `synthetic-share-child-${kind}`,
    });
    await f.seed({ parent_order_id: `synthetic-self-${kind}-67890` });
    const stranger = await f.user();
    const other = await f.seed({ user_id: stranger });
    const otherAppUser = await f.user('synthetic-other-app');
    const otherApp = await f.seed({ app_id: 'synthetic-other-app', user_id: otherAppUser });
    const pool = await f.seed({ user_id: null, buy_type: null, rebate_status: 'UNATTRIBUTED' });
    const terms = {
      'share-parent': `synthetic-share-${kind}-12345`,
      'share-child': share.sub_order_id,
      masked: 'synt****45',
      fragment: `share-${kind}-123`,
      missing: 'synthetic-no-such-order',
      'other-user': other.sub_order_id,
      'other-app': otherApp.sub_order_id,
      unattributed: pool.sub_order_id,
      'title-only': '9081726354',
      'self-fragment': `self-${kind}-678`,
    };
    // A title fallback would turn every non-match into a privacy-leaking false positive.
    await f.seed({ title: `Synthetic title contains ${terms[kind]}` });
    const q = await queries(f.deps);
    expect(await q.findOwnByNumber(f.subject, { order_no: terms[kind] })).toEqual([]);
  },
);

// AC-B3-08f#6 is the existing frozen list-detail suite. It is intentionally not copied here:
// new cases must all be red; the orchestrator also runs list-detail as a green regression suite.
