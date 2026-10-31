// B1-05r: the product_pool data source of listPageSectionItems (contract「Fetching product_pool」;
// BR-TEXT-17, BR-PRICE-08, BR-PRICE-11). getSectionItems over the real pool tables. Rows that are
// read and then not sent may or may not count against a page, except no_rebate, which only the
// quote can tell, so those cases walk the whole list instead of pinning one page.
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { assertSchema, dataOf, rejection } from '../hot-rank/kit.ts';
import { EMPTY, SECTION_ID, pagesCursor, title, titlesOf } from '../section-items/kit.ts';
import {
  AD_LABEL,
  MAX_AGE_KEY,
  MAX_AGE_SEC,
  TIMEOUT,
  newPoolId,
  ordered,
  sectionCase,
  secondsAgo,
  seedPool,
  tenant,
  usePoolDatabase,
} from './kit.ts';

const h = usePoolDatabase();

/** Every title the list sends, in order, over all its pages. */
function allTitles(pages: readonly { items: readonly { title: string | null }[] }[]) {
  return pages.flatMap((page) => page.items.map((card) => card.title));
}

it(
  '[BR-TEXT-17][BR-PRICE-11] 卡片：sort 升序再 product_key，ad_label「推广」，stale=false，价格和 quoted_at 取池里的行，不向联盟取数',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    const quotedAt = secondsAgo(f.clock, 125);
    await f.item(pool, 'second', { sort: 2 });
    await f.item(pool, 'first', { sort: 2 });
    await f.item(pool, 'head', {
      sort: 1,
      quoted_at: quotedAt,
      price_fen: 3990n,
      coupon_fen: 1000n,
      final_price_fen: 2990n,
    });
    f.show(pool);

    const data = await f.run();

    await assertSchema(data, 'PageSectionItemsData');
    expect(titlesOf(data)).toEqual(['head', 'first', 'second'].map(title));
    expect(data.has_more).toBe(false);
    expect(data.next_cursor).toBeNull();
    for (const card of data.items) {
      expect(card).toMatchObject({ ad_label: AD_LABEL, stale: false, rebate_basis: 'normal' });
    }
    expect(data.items[0]).toMatchObject({
      product_key: 'tb:head',
      platform: 'taobao',
      price_fen: 3990,
      coupon_fen: 1000,
      final_price_fen: 2990,
      age_sec: 125,
    });
    expect(Date.parse(data.items[0]!.quoted_at!)).toBe(quotedAt.getTime());
    expect(f.calls).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 每张下发的卡都登记链接，报价用池里的佣金率；过滤掉的行不登记',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'sent', { commission_rate_bp: 350 });
    await f.item(pool, 'dropped');
    f.noRebate('dropped');
    f.show(pool);

    const data = await f.run();

    expect(titlesOf(data)).toEqual([title('sent')]);
    expect(f.registered()).toEqual([title('sent')]);
    const [link] = f.register.mock.calls.map(([input]) => input);
    expect(link?.item.commission_rate_bp).toBe(350n);
    expect(link?.ref).toMatchObject({ platform: 'taobao', productKey: 'tb:sent' });
    expect(data.items[0]?.link_id).toEqual(expect.any(String));
  },
  TIMEOUT,
);

it.each([
  { label: '不存在', poolId: () => newPoolId() },
  { label: '不是 UUID', poolId: () => 'not-a-pool-id' },
])(
  '[BR-PRICE-11] pool_id $label → 200 空列表，不是 30701',
  async ({ poolId }) => {
    const f = await sectionCase(h);
    f.show(poolId());

    expect(await f.run()).toEqual(EMPTY);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 停用的池 → 200 空列表，行不下发、不登记',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool({ status: 'disabled' });
    await f.item(pool, 'held');
    f.show(pool);

    expect(await f.run()).toEqual(EMPTY);
    expect(f.registered()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 别的 App 的池不算：同一个 pool_id 在本 App 不存在 → 200 空列表',
  async () => {
    const f = await sectionCase(h);
    const other = await tenant(h.db);
    const foreign = await seedPool(h.db, other, f.clock);
    await f.item(await f.pool(), 'own');
    f.show(foreign);

    expect(await f.run()).toEqual(EMPTY);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 只取 online 且 now 在 start_at..end_at 内的行：下线、未开始、已结束都不下发，空的一端不限',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    const later = new Date(f.clock.now().getTime() + 3_600_000);
    const earlier = secondsAgo(f.clock, 3600);
    await f.item(pool, 'a-open');
    await f.item(pool, 'b-window', { start_at: earlier, end_at: later });
    await f.item(pool, 'c-started', { start_at: earlier });
    await f.item(pool, 'd-until', { end_at: later });
    await f.item(pool, 'e-offline', { status: 'offline', invalid_reason: '联盟返回下架' });
    await f.item(pool, 'f-future', { start_at: later });
    await f.item(pool, 'g-past', { end_at: earlier });
    f.show(pool);

    expect(allTitles(await f.walk())).toEqual(
      ['a-open', 'b-window', 'c-started', 'd-until'].map(title),
    );
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] quoted_at 距今正好 pool.max_age_sec 还下发，多一秒不下发；未配置按 7200',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'a-limit', { quoted_at: secondsAgo(f.clock, MAX_AGE_SEC) });
    await f.item(pool, 'b-over', { quoted_at: secondsAgo(f.clock, MAX_AGE_SEC + 1) });
    f.show(pool);

    expect(allTitles(await f.walk())).toEqual([title('a-limit')]);
    expect(f.registered()).toEqual([title('a-limit')]);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] pool.max_age_sec 取配置：调成 100 后 101 秒的行不下发，100 秒的行下发',
  async () => {
    const f = await sectionCase(h);
    f.settings.set(MAX_AGE_KEY, 100);
    const pool = await f.pool();
    await f.item(pool, 'a-limit', { quoted_at: secondsAgo(f.clock, 100) });
    await f.item(pool, 'b-over', { quoted_at: secondsAgo(f.clock, 101) });
    f.show(pool);

    expect(allTitles(await f.walk())).toEqual([title('a-limit')]);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11][B1-05u] commission_rate_bp 为 NULL 的行不下发、不登记、不报价，佣金率为 0 的行不算空',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'a-null', { commission_rate_bp: null });
    await f.item(pool, 'b-zero', { commission_rate_bp: 0 });
    f.show(pool);

    expect(allTitles(await f.walk())).toEqual([title('b-zero')]);
    expect(f.register.mock.calls.map(([input]) => input.item.commission_rate_bp)).toEqual([0n]);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-08] rebate_basis=no_rebate 不下发：这一页可以变短甚至为空，has_more 只看列表还有没有行，下一页接着读',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    const names = ordered('r', 5);
    for (const name of names) await f.item(pool, name);
    f.noRebate('r01', 'r02', 'r04');
    f.show(pool, 2);

    const first = await f.run();
    expect(first.items).toEqual([]);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await f.run({ cursor: first.next_cursor! });
    expect(titlesOf(second)).toEqual([title('r03')]);
    expect(second.has_more).toBe(true);

    const third = await f.run({ cursor: second.next_cursor! });
    expect(titlesOf(third)).toEqual([title('r05')]);
    expect(third.has_more).toBe(false);
    expect(third.next_cursor).toBeNull();
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-08] 价格异常的行走出卡入口：不下发、不登记、记一条 PRICE_ANOMALY',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'a-bad', { price_fen: 1000n, coupon_fen: 100n, final_price_fen: 800n });
    await f.item(pool, 'b-good');
    f.show(pool);

    expect(allTitles(await f.walk())).toEqual([title('b-good')]);
    expect(f.registered()).toEqual([title('b-good')]);
    expect(f.anomalies()).toEqual([expect.objectContaining({ product_key: 'tb:a-bad' })]);
  },
  TIMEOUT,
);

it(
  '[BR-TEXT-17] 一页最多读 min(limit, 20) 行：limit=2 时 5 行分三页，cursor 接着行偏移读，不重不漏，读完 has_more=false',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    const names = ordered('p', 5);
    for (const name of names) await f.item(pool, name);
    f.show(pool, 2);

    const pages = await f.walk();

    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages.map((page) => page.has_more)).toEqual([true, true, false]);
    expect(allTitles(pages)).toEqual(names.map(title));
  },
  TIMEOUT,
);

it(
  '[BR-TEXT-17] 行数正好读完的一页 has_more=false、next_cursor=null，不留一个空的下一页',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    for (const name of ordered('q', 4)) await f.item(pool, name);
    f.show(pool, 2);

    const pages = await f.walk();

    expect(pages.map((page) => page.items.length)).toEqual([2, 2]);
    expect(pages[1]).toMatchObject({ has_more: false, next_cursor: null });
  },
  TIMEOUT,
);

it(
  '[BR-TEXT-17] limit 大于页长时一页仍是 20 行',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    const names = ordered('n', 23);
    for (const name of names) await f.item(pool, name);
    f.show(pool, 50);

    const pages = await f.walk();

    expect(pages.map((page) => page.items.length)).toEqual([20, 3]);
    expect(allTitles(pages)).toEqual(names.map(title));
  },
  TIMEOUT,
);

it.each([
  { label: '形状不对', cursor: '***' },
  { label: '不是 JSON', cursor: Buffer.from('not json', 'utf8').toString('base64url') },
  { label: 'union_material 的游标', cursor: pagesCursor([1]) },
])(
  '[BR-TEXT-17] cursor $label → 20001 data.fields=[cursor]',
  async ({ cursor }) => {
    const f = await sectionCase(h);
    f.show(await f.pool());

    const error = await rejection(() => f.run({ cursor }));

    expect(error).toMatchObject({ code: 20001 });
    expect(dataOf(error)).toEqual({ fields: ['cursor'] });
  },
  TIMEOUT,
);

it(
  '[BR-TEXT-17] 别的卡片的 cursor → 20001 data.fields=[cursor]',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    for (const name of ordered('c', 3)) await f.item(pool, name);
    f.show(pool, 2);
    const { next_cursor: cursor } = await f.run();

    const error = await rejection(() =>
      f.run({ sectionId: `${SECTION_ID}_other`, cursor: cursor! }),
    );

    expect(error).toMatchObject({ code: 20001 });
    expect(dataOf(error)).toEqual({ fields: ['cursor'] });
  },
  TIMEOUT,
);

const ROW = fc.record({
  sort: fc.integer({ min: 0, max: 3 }),
  status: fc.constantFrom('online', 'online', 'online', 'offline'),
  window: fc.constantFrom('open', 'open', 'future', 'past'),
  aged: fc.boolean(),
  commission: fc.boolean(),
  noRebate: fc.boolean(),
  anomaly: fc.boolean(),
});
/** Each sample writes its rows and walks its list over the real tables. */
const LIST_RUNS = Math.max(8, Math.floor(propRuns() / 1000));

it(
  '[BR-PRICE-11][BR-PRICE-08] 任意一池：翻完所有页，下发的正好是合格的行，顺序对，每页不超过 min(limit, 20)，且只给下发的卡登记',
  async () => {
    const f = await sectionCase(h);
    let sample = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(ROW, { maxLength: 8 }),
        fc.integer({ min: 1, max: 5 }),
        async (rows, limit) => {
          sample += 1;
          const pool = await f.pool();
          const later = new Date(f.clock.now().getTime() + 3_600_000);
          const earlier = secondsAgo(f.clock, 3600);
          const expected: { sort: number; name: string }[] = [];
          for (const [index, row] of rows.entries()) {
            const name = `s${String(sample)}-${String(index).padStart(2, '0')}`;
            await f.item(pool, name, {
              sort: row.sort,
              status: row.status,
              ...(row.window === 'future' ? { start_at: later } : {}),
              ...(row.window === 'past' ? { end_at: earlier } : {}),
              ...(row.aged ? { quoted_at: secondsAgo(f.clock, MAX_AGE_SEC + 1) } : {}),
              ...(row.commission ? {} : { commission_rate_bp: null }),
              ...(row.anomaly ? { final_price_fen: 1n } : {}),
            });
            if (row.noRebate) f.noRebate(name);
            const eligible =
              row.status === 'online' &&
              row.window === 'open' &&
              !row.aged &&
              row.commission &&
              !row.noRebate &&
              !row.anomaly;
            if (eligible) expected.push({ sort: row.sort, name });
          }
          f.show(pool, limit);
          const linked = f.registered().length;

          const pages = await f.walk();

          const want = expected
            .sort((a, b) => a.sort - b.sort || (a.name < b.name ? -1 : 1))
            .map(({ name }) => title(name));
          expect(allTitles(pages)).toEqual(want);
          for (const page of pages) expect(page.items.length).toBeLessThanOrEqual(limit);
          expect(f.registered().slice(linked)).toEqual(want);
        },
      ),
      { numRuns: LIST_RUNS, seed: propSeed() },
    );
  },
  60_000 + LIST_RUNS * 1000,
);
