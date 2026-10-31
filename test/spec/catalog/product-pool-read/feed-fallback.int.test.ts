// B1-05r: the feed's union fall-back (contract「Union fall-back」, 02 §14, BR-PROD-07, D10-508).
// A union_material first page all of whose channels failed at the union reads the pool named by
// feed.fallback_pool_id under the product_pool rules, its cursor pages on through that pool, and
// every card is stale=true with ad_label「推广」. Unset or unusable config, a later page, no data and
// a refused data source all stay as they were. The stale-cache path of B1-28n is not in this tree
// and is not tested here.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionError, UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { dataOf, rejection, series } from '../hot-rank/kit.ts';
import {
  EMPTY,
  JD,
  SECTION_ID,
  TB,
  entryOf,
  expectPages,
  names,
  pagesCursor,
  title,
  titlesOf,
} from '../section-items/kit.ts';
import {
  AD_LABEL,
  FALLBACK_KEY,
  MAX_AGE_SEC,
  TIMEOUT,
  newPoolId,
  ordered,
  sectionCase,
  secondsAgo,
  seedItem,
  seedPool,
  tenant,
  usePoolDatabase,
} from './kit.ts';

const h = usePoolDatabase(createTestDatabase);

const unavailable = (): UnionError =>
  new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao');

/** Both default channels fail and the fall-back pool is set; rows go in by the caller. */
async function outage() {
  const f = await sectionCase(h);
  f.failChannel(TB, unavailable());
  f.failChannel(JD, unavailable());
  const pool = await f.pool();
  f.settings.set(FALLBACK_KEY, pool);
  return { f, pool };
}

it.each([
  { label: 'UnionError upstream_unavailable', error: unavailable() },
  {
    label: 'UnionError rate_limited',
    error: new UnionError('rate_limited', 'synthetic rate limited', 'taobao'),
  },
  {
    label: 'GovernanceError timeout',
    error: new GovernanceError('timeout', 'union:taobao:online', 'synthetic slow'),
  },
  {
    label: 'GovernanceError circuit_open',
    error: new GovernanceError('circuit_open', 'union:taobao:online', 'synthetic open'),
  },
  {
    label: 'DemoUnionError',
    error: new DemoUnionError('demo_delisted', 'synthetic demo', 'taobao'),
  },
])(
  '[BR-PROD-07][BR-TEXT-17] 第一页每个频道都失败（$label）→ 读回退池：stale=true、ad_label「推广」，价格和 quoted_at 取池里的行',
  async ({ error }) => {
    const f = await sectionCase(h);
    f.failChannel(TB, error);
    f.failChannel(JD, error);
    const pool = await f.pool();
    f.settings.set(FALLBACK_KEY, pool);
    const quotedAt = secondsAgo(f.clock, 600);
    await f.item(pool, 'b-second', { sort: 2 });
    await f.item(pool, 'a-first', { sort: 1, quoted_at: quotedAt });

    const data = await f.run();

    expect(titlesOf(data)).toEqual(['a-first', 'b-second'].map(title));
    for (const card of data.items) {
      expect(card).toMatchObject({
        ad_label: AD_LABEL,
        stale: true,
        rebate_basis: 'normal',
        price_fen: 8800,
        coupon_fen: 800,
        final_price_fen: 8000,
      });
    }
    expect(Date.parse(data.items[0]!.quoted_at!)).toBe(quotedAt.getTime());
    expect(f.registered()).toEqual(['a-first', 'b-second'].map(title));
    expect(data).toMatchObject({ has_more: false, next_cursor: null });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] 一个频道的板块同样回退；每个频道只问一次',
  async () => {
    const f = await sectionCase(h, { channels: [TB] });
    f.failChannel(TB, unavailable());
    const pool = await f.pool();
    f.settings.set(FALLBACK_KEY, pool);
    await f.item(pool, 'only');

    const data = await f.run();

    expect(titlesOf(data)).toEqual([title('only')]);
    expect(f.pageNos(TB)).toEqual([1]);
  },
  TIMEOUT,
);

it(
  '[BR-TEXT-17] 回退一页读 20 行，next_cursor 接着走这个池：联盟恢复了也不回到频道，后续页同样 stale=true、「推广」，不重不漏',
  async () => {
    const { f, pool } = await outage();
    const rows = ordered('p', 23);
    for (const name of rows) await f.item(pool, name);

    const first = await f.run();
    expect(first.items).toHaveLength(20);
    expect(first.has_more).toBe(true);
    const asked = f.calls.length;

    f.recover(TB);
    f.recover(JD);
    f.answer(TB, 1, series('tb', 2));
    const second = await f.run({ cursor: first.next_cursor! });

    expect(f.calls).toHaveLength(asked);
    expect(titlesOf(second)).toEqual(rows.slice(20).map(title));
    expect(second).toMatchObject({ has_more: false, next_cursor: null });
    for (const card of second.items) {
      expect(card).toMatchObject({ ad_label: AD_LABEL, stale: true });
    }
  },
  TIMEOUT,
);

it(
  '[BR-TEXT-17] 回退后的游标仍属于这张卡：拿到别的卡片上 → 20001，形状不对 → 20001',
  async () => {
    const { f, pool } = await outage();
    for (const name of ordered('p', 21)) await f.item(pool, name);
    const { next_cursor: cursor } = await f.run();

    const foreign = await rejection(() =>
      f.run({ sectionId: `${SECTION_ID}_other`, cursor: cursor! }),
    );
    const broken = await rejection(() => f.run({ cursor: '***' }));

    for (const error of [foreign, broken]) {
      expect(error).toMatchObject({ code: 20001 });
      expect(dataOf(error)).toEqual({ fields: ['cursor'] });
    }
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 回退页也按商品池规则：池停用后后续页是空列表',
  async () => {
    const { f, pool } = await outage();
    for (const name of ordered('p', 21)) await f.item(pool, name);
    const { next_cursor: cursor } = await f.run();

    await h.db
      .updateTable('product_pools')
      .set({ status: 'disabled' })
      .where('app_id', '=', f.owner.appId)
      .where('pool_id', '=', pool)
      .execute();

    expect(await f.run({ cursor: cursor! })).toEqual(EMPTY);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11][BR-PRICE-08] 回退页的过滤同商品池：下线、窗口外、超龄、佣金率空、no_rebate、价格异常都不下发',
  async () => {
    const { f, pool } = await outage();
    const earlier = secondsAgo(f.clock, 3600);
    await f.item(pool, 'a-good');
    await f.item(pool, 'b-offline', { status: 'offline' });
    await f.item(pool, 'c-past', { end_at: earlier });
    await f.item(pool, 'd-aged', { quoted_at: secondsAgo(f.clock, MAX_AGE_SEC + 1) });
    await f.item(pool, 'e-null', { commission_rate_bp: null });
    await f.item(pool, 'f-norebate');
    await f.item(pool, 'g-bad', { price_fen: 1000n, coupon_fen: 100n, final_price_fen: 800n });
    f.noRebate('f-norebate');

    const pages = await f.walk();

    expect(pages.flatMap(titlesOf)).toEqual([title('a-good')]);
    expect(f.registered()).toEqual([title('a-good')]);
  },
  TIMEOUT,
);

it.each([
  { label: '未配置', configure: () => undefined },
  { label: '池不存在', configure: () => newPoolId() },
  { label: '不是 UUID', configure: () => 'not-a-pool-id' },
  { label: '空串', configure: () => '' },
  { label: '不是字符串', configure: () => 42 },
])(
  '[BR-PROD-07] feed.fallback_pool_id $label → 原来的空列表',
  async ({ configure }) => {
    const f = await sectionCase(h);
    f.failChannel(TB, unavailable());
    f.failChannel(JD, unavailable());
    await f.item(await f.pool(), 'unrelated');
    const value = configure();
    if (value !== undefined) f.settings.set(FALLBACK_KEY, value);

    expect(await f.run()).toEqual(EMPTY);
    expect(f.registered()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] 回退池已停用 → 原来的空列表，行不下发、不登记',
  async () => {
    const f = await sectionCase(h);
    f.failChannel(TB, unavailable());
    f.failChannel(JD, unavailable());
    const disabled = await f.pool({ status: 'disabled' });
    await f.item(disabled, 'held');
    f.settings.set(FALLBACK_KEY, disabled);

    expect(await f.run()).toEqual(EMPTY);
    expect(f.registered()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] 回退池属于别的 App → 原来的空列表，那个池里合格的行不下发、不登记',
  async () => {
    const f = await sectionCase(h);
    f.failChannel(TB, unavailable());
    f.failChannel(JD, unavailable());
    const other = await tenant(h.db);
    const foreign = await seedPool(h.db, other, f.clock);
    await seedItem(h.db, other, f.clock, foreign, 'tb:foreign');
    f.settings.set(FALLBACK_KEY, foreign);

    expect(await f.run()).toEqual(EMPTY);
    expect(f.registered()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] 回退池的 pool_id 两个 App 都有：只读本 App 的行，别的 App 的行排在前面也不下发',
  async () => {
    const { f, pool } = await outage();
    const other = await tenant(h.db);
    await seedPool(h.db, other, f.clock, { pool_id: pool });
    await seedItem(h.db, other, f.clock, pool, 'tb:a-foreign', { sort: 1 });
    await f.item(pool, 'b-own', { sort: 2 });

    const pages = await f.walk();

    expect(pages.flatMap(titlesOf)).toEqual([title('b-own')]);
    expect(f.registered()).toEqual([title('b-own')]);
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] 后续页每个频道都失败不回退：没有频道答过，空列表收尾',
  async () => {
    const { f, pool } = await outage();
    await f.item(pool, 'unused');

    const data = await f.run({ cursor: pagesCursor([2, 2]) });

    expect(data).toEqual(EMPTY);
    expect(f.registered()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] 频道都没数据不回退：空列表，不读回退池',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'unused');
    f.settings.set(FALLBACK_KEY, pool);

    expect(await f.run()).toEqual(EMPTY);
    expect(f.registered()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-TEXT-17] 数据源被白名单拒绝不回退：不取数，空列表',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'unused');
    f.settings.set(FALLBACK_KEY, pool);
    f.setChannels([entryOf(TB)]);

    expect(await f.run()).toEqual(EMPTY);
    expect(f.calls).toEqual([]);
    expect(f.registered()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] 一个频道失败、另一个答了不回退：只出答上来的卡，ad_label=null，stale=false，游标留在频道上',
  async () => {
    const { f, pool } = await outage();
    await f.item(pool, 'unused');
    f.recover(JD);
    f.answer(JD, 1, series('jd', 2, 1, 'jd'));

    const data = await f.run();

    expect(titlesOf(data)).toEqual(names('jd', 2));
    for (const card of data.items) {
      expect(card).toMatchObject({ ad_label: null, stale: false });
    }
    expectPages(data, [1, 0]);
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] 一个频道失败、另一个答了空页不回退：items 为空但游标还在，失败的频道下一页重取',
  async () => {
    const { f, pool } = await outage();
    await f.item(pool, 'unused');
    f.recover(JD);

    const data = await f.run();

    expect(data.items).toEqual([]);
    expectPages(data, [1, 0]);
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] 程序错误不算联盟失败：照常抛出，不回退',
  async () => {
    const { f, pool } = await outage();
    await f.item(pool, 'unused');
    const bug = new TypeError('synthetic bug');
    f.failChannel(TB, bug);
    f.failChannel(JD, bug);

    expect(await rejection(() => f.run())).toBe(bug);
    expect(f.registered()).toEqual([]);
  },
  TIMEOUT,
);
