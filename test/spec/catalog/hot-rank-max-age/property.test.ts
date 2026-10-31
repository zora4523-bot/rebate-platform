// B1-28n properties (run count from propParams()). Fixtures here are the kits' plain recorders,
// never vi.fn (B1-28h).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { DEFAULT_TTL_SECONDS, candidate } from '../hot-rank/kit.ts';
import {
  EMPTY,
  SECTION_PAGE_SIZE,
  expectPages,
  refsOf,
  title,
  titlesOf,
} from '../section-items/kit.ts';
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
  type ConfigValue,
} from './kit.ts';

const HIGHEST_MAX_AGE = 200_000;
const UNUSABLE: readonly (ConfigValue | undefined)[] = [
  undefined,
  ...INVALID_MAX_AGES.map((entry) => entry.value),
];

function limitOf(value: ConfigValue | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : LIMIT;
}

it('[AC-B1-28n#20][BR-PRICE-11] 属性：任意配置值与任意年龄（过了缓存时长），依赖失败时旧页可用当且仅当 age ≤ 生效的上限，否则原错误抛出', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(fc.integer({ min: 1, max: HIGHEST_MAX_AGE }), fc.constantFrom(...UNUSABLE)),
      fc.oneof(
        fc.constantFrom(-1000, -1, 0, 1, 1000),
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
      ),
      async (value, offsetMs) => {
        const outage = unavailable();
        const f = await storedPage(outage);
        if (value !== undefined) f.configure(MAX_AGE_KEY, value);
        const limitMs = limitOf(value) * 1000;
        const ageMs = Math.max(DEFAULT_TTL_SECONDS * 1000 + 1, limitMs + offsetMs);

        f.clock.advanceMs(ageMs);

        if (ageMs <= limitMs) await expectServed(f);
        else await expectRefused(f, outage);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);

it('[AC-B1-28n#21][BR-PRICE-11] 属性：任意频道年龄组合，信息流恰好下发 age ≤ 上限的频道、按频道顺序，超限的各告警一条且页码不前进；全部超限是空结果', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.oneof(
          fc.constantFrom(LIMIT - 1, LIMIT, LIMIT + 1),
          fc.integer({ min: DEFAULT_TTL_SECONDS + 1, max: 3 * LIMIT }),
        ),
        { minLength: 1, maxLength: 4 },
      ),
      async (ages) => {
        const refs = refsOf(ages.length);
        const f = maxAgeFixture({ channels: refs });
        const pageSize = Math.floor(SECTION_PAGE_SIZE / refs.length);
        const oldest = Math.max(...ages);
        const byAge = [...ages.entries()].sort(([, a], [, b]) => b - a);
        for (const [index, age] of byAge) {
          const ref = refs[index]!;
          f.answer(ref, [candidate(`ch-${String(index)}`)]);
          f.ageTo(oldest - age);
          await f.upstream.page(pageInput({ channelId: ref.channel_id, pageSize }));
        }
        f.fail(unavailable());
        f.ageTo(oldest);

        const data = await f.feed();

        const within = ages.flatMap((age, index) => (age <= LIMIT ? [index] : []));
        const over = ages.flatMap((age, index) => (age > LIMIT ? [refs[index]!.channel_id] : []));
        expect(f.droppedChannels().toSorted()).toEqual(over.toSorted());
        if (within.length === 0) {
          expect(data).toEqual(EMPTY);
        } else {
          expect(titlesOf(data)).toEqual(within.map((index) => title(`ch-${String(index)}`)));
          for (const card of data.items) expect(card.stale).toBe(true);
          if (over.length === 0) expect(data.has_more).toBe(false);
          else
            expectPages(
              data,
              ages.map((age) => (age > LIMIT ? 1 : 0)),
            );
        }
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
