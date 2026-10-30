// B1-28l properties (run count from propParams()). The rank property goes through the real wiring
// and use case; the cursor stays opaque, so a page is reached by following next_cursor over empty
// pages that have more. Fixtures here are the kits' plain recorders, never vi.fn (B1-28h).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { HotRankData } from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { PAGE_SIZE, fixture, hotRank, pageRequest } from '../hot-rank-upstream/kit.ts';
import { series } from '../hot-rank/kit.ts';
import { channelEntries, gapFixture, positionsOf, rows, type SlotKind } from './kit.ts';

const MAX_PAGE_WALKED = 5;

function kindsArb(...kinds: readonly SlotKind[]) {
  return fc.array(fc.constantFrom(...kinds), { minLength: 1, maxLength: PAGE_SIZE });
}

function keptIndexes(kinds: readonly SlotKind[]): number[] {
  return kinds.flatMap((kind, index) => (kind === 'keep' ? [index] : []));
}

it('[AC-B1-28l#21][BR-TEXT-17] 属性：任意丢弃、出卡跳过模式与页号，下发名次恰为保留条目的 first + 原始下标 + 1，严格递增', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      kindsArb('keep', 'foreign', 'underivable', 'anomaly'),
      fc.integer({ min: 1, max: MAX_PAGE_WALKED }),
      async (kinds, pageNo) => {
        const f = fixture();
        const run = hotRank(f);
        f.fake('taobao').setPage({ items: [], hasMore: true });
        let cursor: string | null = null;
        for (let walked = 1; walked < pageNo; walked += 1) {
          const empty: HotRankData = await run(cursor === null ? {} : { cursor });
          cursor = empty.next_cursor;
        }
        f.fake('taobao').setPage({ items: channelEntries(kinds), hasMore: false });

        const data = await run(cursor === null ? {} : { cursor });

        const first = (pageNo - 1) * PAGE_SIZE;
        const delivered = rows(data);
        expect(delivered.map(([rank, title]) => [rank, title])).toEqual(
          keptIndexes(kinds).map((index) => [
            first + index + 1,
            `synthetic-good-${String(index + 1)}`,
          ]),
        );
        const inOrder = delivered.every(([rank], at) => at === 0 || rank > delivered[at - 1]![0]);
        expect(inOrder).toBe(true);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);

it('[AC-B1-28l#22] 属性：wiring 的 positions 恰为保留条目的原始下标；没丢过或一条不剩时不带这个键', async () => {
  const f = fixture();
  const upstream = f.upstream();
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(kindsArb('keep', 'foreign', 'underivable'), async (kinds) => {
      f.fake('taobao').setPage({ items: channelEntries(kinds), hasMore: false });

      const page = await upstream.page(pageRequest());

      const kept = keptIndexes(kinds);
      const carries = kept.length > 0 && kept.length < kinds.length;
      expect(page.items.map((entry) => entry.salesText)).toEqual(
        kept.map((index) => `${String(index + 1)}件`),
      );
      expect(positionsOf(page)).toEqual(carries ? kept : undefined);
      expect('positions' in page).toBe(carries);
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);

it('[AC-B1-28l#23] 属性：任意合法 positions 经缓存存取后不变，命中不再取联盟', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.nat(), { minLength: 1, maxLength: PAGE_SIZE }),
      async (values) => {
        const positions = [...values].sort((a, b) => a - b);
        const f = gapFixture({ cached: true });
        f.setGapPage(1, series('c', positions.length), positions);

        await f.gapUpstream.page(pageRequest());
        const hit = await f.gapUpstream.page(pageRequest());

        expect(positionsOf(hit)).toEqual(positions);
        expect(f.page.mock.calls.length).toBe(1);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
