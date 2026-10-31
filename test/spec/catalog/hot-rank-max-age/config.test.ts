// B1-28n (D10-508): pool.max_age_sec is read per app through CatalogConfigReader; a missing value,
// or one that is not a safe integer ≥ 1, means 7200. The limit decides only what answers a
// dependency failure: inside rank.cache_ttl_seconds an entry is a plain hit, whatever the limit.
import { expect, it } from 'vitest';
import { APP, DEFAULT_TTL_SECONDS, TTL_KEY, series } from '../hot-rank/kit.ts';
import { TB } from '../section-items/kit.ts';
import {
  DEFAULT_MAX_AGE_SECONDS as LIMIT,
  INVALID_MAX_AGES,
  MAX_AGE_KEY,
  expectRefused,
  expectServed,
  maxAgeFixture,
  pageInput,
  storedPage,
  unavailable,
} from './kit.ts';

interface HitCase {
  readonly label: string;
  /** pool.max_age_sec to configure; absent leaves it unset. */
  readonly maxAge?: number;
  /** rank.cache_ttl_seconds to configure; absent leaves it unset. */
  readonly configuredTtl?: number;
  /** The cache TTL in effect. */
  readonly ttl: number;
}

const HITS: readonly HitCase[] = [
  { label: '上限 60 小于缓存时长 600', maxAge: 60, ttl: DEFAULT_TTL_SECONDS },
  { label: '默认上限 7200 小于缓存时长 10000', configuredTtl: 10_000, ttl: 10_000 },
];

it.each([601, 3600, 7199, 7201, 9000, 86_400])(
  '[AC-B1-28n#10] pool.max_age_sec=%i：恰好等于它可用，多 1 秒不可用',
  async (maxAge) => {
    const outage = unavailable();
    const f = await storedPage(outage);
    f.configure(MAX_AGE_KEY, maxAge);

    f.ageTo(maxAge);
    await expectServed(f);

    f.ageTo(maxAge + 1);
    await expectRefused(f, outage);
  },
);

it.each([1, 60, 599, 600])(
  '[AC-B1-28n#11] pool.max_age_sec=%i 不大于缓存时长：过了缓存时长就没有可用的旧页（1 是合法下限，不回落到 7200）',
  async (maxAge) => {
    const outage = unavailable();
    const f = await storedPage(outage);
    f.configure(MAX_AGE_KEY, maxAge);

    f.ageTo(DEFAULT_TTL_SECONDS);
    f.clock.advanceMs(1);

    await expectRefused(f, outage);
  },
);

it.each(INVALID_MAX_AGES)(
  '[AC-B1-28n#12] pool.max_age_sec 不是 ≥1 的安全整数（$label）→ 用 7200：7200 秒可用，7201 秒不可用',
  async ({ value }) => {
    const outage = unavailable();
    const f = await storedPage(outage);
    f.configure(MAX_AGE_KEY, value);

    f.ageTo(LIMIT);
    await expectServed(f);

    f.ageTo(LIMIT + 1);
    await expectRefused(f, outage);
  },
);

it('[AC-B1-28n#13] 上限按 app 读：各 app 用自己的值，没配的 app 用 7200', async () => {
  const short = pageInput({ appId: APP });
  const long = pageInput({ appId: 'synthetic_rank_long' });
  const unset = pageInput({ appId: 'synthetic_rank_unset' });
  const outage = unavailable();
  const f = maxAgeFixture();
  f.answer(TB, series('kept', 1));
  f.configure(MAX_AGE_KEY, 1000);
  f.configure(MAX_AGE_KEY, 5000, long.appId);
  for (const input of [short, long, unset]) await f.upstream.page(input);
  f.fail(outage);

  f.ageTo(1000);
  await expectServed(f, short);
  await expectServed(f, long);
  await expectServed(f, unset);

  f.ageTo(1001);
  await expectRefused(f, outage, short);
  await expectServed(f, long);
  await expectServed(f, unset);

  f.ageTo(5001);
  await expectRefused(f, outage, long);
  await expectServed(f, unset);

  f.ageTo(LIMIT + 1);
  await expectRefused(f, outage, unset);
});

it.each(HITS)(
  '[AC-B1-28n#14] 上限只管依赖失败时的旧页（$label）：缓存时长内是普通命中，不取联盟、不标 stale；过了缓存时长才按上限拒答',
  async ({ maxAge, ttl, configuredTtl }) => {
    const outage = unavailable();
    const f = await storedPage(outage);
    if (maxAge !== undefined) f.configure(MAX_AGE_KEY, maxAge);
    if (configuredTtl !== undefined) f.configure(TTL_KEY, configuredTtl);
    const calls = f.page.mock.calls.length;

    f.ageTo(ttl - 1);
    const hit = await f.upstream.page(pageInput());

    expect(hit.items).toHaveLength(2);
    expect('stale' in hit).toBe(false);
    expect(f.page.mock.calls.length).toBe(calls);

    f.ageTo(ttl + 1);
    await expectRefused(f, outage);
  },
);
