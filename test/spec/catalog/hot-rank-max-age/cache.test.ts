// B1-28n (D10-508): at the cache itself. Over the limit the page counts as absent, so the union's
// own error comes out unchanged and the use cases answer as they do without an entry. Each entry
// has its own age. Only pages are limited: categories carry no price, so an old list still answers
// a union failure. The physical TTL stays rank.cache_ttl_seconds + 86400, whatever the limit is.
import { expect, it } from 'vitest';
import {
  APP,
  DEFAULT_TTL_SECONDS,
  TB_CHANNEL,
  TTL_KEY,
  candidate,
  rejection,
  series,
} from '../hot-rank/kit.ts';
import { TB } from '../section-items/kit.ts';
import {
  DEFAULT_MAX_AGE_SECONDS as LIMIT,
  MAX_AGE_KEY,
  OUTAGES,
  OUTAGE_KEEP_SECONDS,
  expectRefused,
  expectServed,
  maxAgeFixture,
  pageInput,
  storedPage,
  unavailable,
} from './kit.ts';

interface RetentionCase {
  readonly label: string;
  /** pool.max_age_sec to configure; absent leaves it unset. */
  readonly maxAge?: number;
  /** rank.cache_ttl_seconds to configure; absent leaves it unset. */
  readonly configuredTtl?: number;
  /** The limit and the cache TTL in effect. */
  readonly limit: number;
  readonly ttl: number;
}

const RETENTION: readonly RetentionCase[] = [
  { label: '都用默认', limit: LIMIT, ttl: DEFAULT_TTL_SECONDS },
  { label: '上限 3600', maxAge: 3600, limit: 3600, ttl: DEFAULT_TTL_SECONDS },
  { label: '上限超过物理保留', maxAge: 200_000, limit: 200_000, ttl: DEFAULT_TTL_SECONDS },
  { label: '缓存时长 120', configuredTtl: 120, limit: LIMIT, ttl: 120 },
];

it.each(OUTAGES)(
  '[AC-B1-28n#6] 超过上限按没有旧条目处理：$label 原样抛出，7200 秒时还读旧页',
  async ({ outage }) => {
    const f = await storedPage(outage);

    f.ageTo(LIMIT);
    await expectServed(f);

    f.ageTo(LIMIT + 1);
    await expectRefused(f, outage);
  },
);

it('[AC-B1-28n#7] 每个条目按自己的 fetched_at_ms 算年龄：后写的第 2 页晚 3000 秒才超限', async () => {
  const outage = unavailable();
  const pageTwo = pageInput({ pageNo: 2 });
  const f = maxAgeFixture();
  f.answer(TB, series('one', 1), 1, true);
  f.answer(TB, series('two', 1, 2), 2);
  await f.upstream.page(pageInput());
  f.ageTo(3000);
  await f.upstream.page(pageTwo);
  f.fail(outage);

  f.ageTo(LIMIT + 1);
  await expectRefused(f, outage);
  await expectServed(f, pageTwo);

  f.ageTo(3000 + LIMIT);
  await expectServed(f, pageTwo);

  f.ageTo(3000 + LIMIT + 1);
  await expectRefused(f, outage, pageTwo);
});

it.each(OUTAGES)(
  '[AC-B1-28n#8] 上限只判页不判分类：$label 时同龄的页已不可用，旧分类照常答到物理保留期（不受 pool.max_age_sec 影响）',
  async ({ outage }) => {
    const list = [{ categoryId: 'synthetic-digital', name: '合成数码' }];
    const request = { appId: APP, platform: TB.platform, channelId: TB_CHANNEL };
    const f = maxAgeFixture();
    f.configure(MAX_AGE_KEY, 1);
    f.setCategories(TB.platform, TB_CHANNEL, list);
    f.answer(TB, [candidate('kept')]);
    await f.upstream.categories(request);
    await f.upstream.page(pageInput());
    f.fail(outage);

    for (const age of [DEFAULT_TTL_SECONDS + 1, LIMIT + 1, OUTAGE_KEEP_SECONDS]) {
      f.ageTo(age);
      await expectRefused(f, outage);
      await expect(f.upstream.categories(request)).resolves.toEqual(list);
    }
  },
);

it.each(RETENTION)(
  '[AC-B1-28n#9] 物理保留时长不改（$label）：页与分类都写 TTL + 86400 秒；超限拒答时不删不改存储',
  async ({ maxAge, limit, ttl, configuredTtl }) => {
    const f = maxAgeFixture();
    if (maxAge !== undefined) f.configure(MAX_AGE_KEY, maxAge);
    if (configuredTtl !== undefined) f.configure(TTL_KEY, configuredTtl);
    f.answer(TB, [candidate('kept')]);
    await f.run();

    const writes = f.memory.set.mock.calls.length;
    expect(writes).toBeGreaterThan(0);
    for (const [, , ttlSeconds] of f.memory.set.mock.calls) {
      expect(ttlSeconds).toBe(ttl + OUTAGE_KEEP_SECONDS);
    }

    const rows = new Map(f.memory.rows);
    f.fail(unavailable());
    f.ageTo(limit + 1);

    expect(await rejection(() => f.run())).toMatchObject({ code: 50304 });
    expect(f.memory.rows).toEqual(rows);
    expect(f.memory.set.mock.calls.length).toBe(writes);
  },
);
