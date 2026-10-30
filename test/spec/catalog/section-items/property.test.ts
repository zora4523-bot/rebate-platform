// B1-05o: properties over any number of channels and any page sequence. The delivered order is the
// channels' interleave, round by round, with the filtered and repeated cards left out; price, rebate
// and commission have no say (BR-TEXT-17 细则「联盟物料频道」). `expectedStep` is the rule of
// 编排补充说明 D10-452 written out on plain data. Fixtures per iteration use no vi.fn (see kit.ts).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { HotRankCandidate } from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { candidate } from '../hot-rank/kit.ts';
import {
  PAGE_KEY,
  SECTION_ID,
  SECTION_PAGE_SIZE,
  anomalous,
  decodeCursor,
  interleave,
  refsOf,
  sectionFixture,
  title,
  titlesOf,
  withCommission,
} from './kit.ts';

interface Row {
  readonly product: number;
  readonly anomaly: boolean;
  readonly finalFen: bigint;
  readonly commissionBp: bigint;
}

/** One channel: its upstream pages in order; the last one reports no more. */
type ChannelPages = readonly (readonly Row[])[];

interface Step {
  readonly titles: readonly string[];
  readonly hasMore: boolean;
  readonly next: readonly number[];
}

const nameOf = (product: number): string => `p${product}`;
const isNoRebate = (product: number): boolean => product % 7 === 0;
const rebateOf = (product: number): bigint => BigInt(product % 50) + 1n;

function candidateOf(row: Row): HotRankCandidate {
  const entry = withCommission(
    candidate(nameOf(row.product), { finalFen: row.finalFen }),
    row.commissionBp,
  );
  return row.anomaly ? anomalous(entry) : entry;
}

/** One request from the given pages of each channel (0 = finished), every channel answering. */
function expectedStep(layout: readonly ChannelPages[], pages: readonly number[]): Step {
  const next = [...pages];
  const more = pages.map(() => false);
  const titles: string[] = [];
  const delivered = new Set<number>();

  const round = (active: readonly number[]): void => {
    const lists: (readonly Row[])[] = layout.map(() => []);
    for (const index of active) {
      const pageNo = next[index]!;
      lists[index] = layout[index]![pageNo - 1] ?? [];
      const hasMore = pageNo < layout[index]!.length;
      more[index] = hasMore;
      next[index] = hasMore ? pageNo + 1 : 0;
    }
    for (const row of interleave(lists)) {
      if (row.anomaly || isNoRebate(row.product) || delivered.has(row.product)) continue;
      delivered.add(row.product);
      titles.push(title(nameOf(row.product)));
    }
  };

  round(pages.flatMap((pageNo, index) => (pageNo > 0 ? [index] : [])));
  const again = more.flatMap((hasMore, index) => (hasMore ? [index] : []));
  if (titles.length < SECTION_PAGE_SIZE && again.length > 0) round(again);

  return { titles: titles.slice(0, SECTION_PAGE_SIZE), hasMore: more.some(Boolean), next };
}

const rowArb: fc.Arbitrary<Row> = fc.record({
  product: fc.oneof(fc.nat({ max: 12 }), fc.nat({ max: 400 })),
  anomaly: fc.boolean(),
  finalFen: fc.bigInt({ min: 100n, max: 10_000_000n }),
  commissionBp: fc.bigInt({ min: 0n, max: 9_000n }),
});

const pageArb = fc.oneof(
  { arbitrary: fc.array(rowArb, { maxLength: 3 }), weight: 3 },
  {
    arbitrary: fc.array(rowArb, { minLength: SECTION_PAGE_SIZE, maxLength: SECTION_PAGE_SIZE }),
    weight: 1,
  },
);

const layoutArb = fc.array(fc.array(pageArb, { minLength: 1, maxLength: 3 }), {
  minLength: 1,
  maxLength: 5,
});

it('[AC-B1-05o#60] 属性：任意频道数与页序列，顺着游标翻到底，每页下发顺序都等于交错结果过滤后的子序列，游标与 has_more 同口径', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(layoutArb, async (generated) => {
      const refs = refsOf(generated.length);
      const pageSize = Math.floor(SECTION_PAGE_SIZE / generated.length);
      const layout = generated.map((pages) => pages.map((rows) => rows.slice(0, pageSize)));
      const f = sectionFixture({ channels: refs });
      layout.forEach((pages, channelIndex) => {
        pages.forEach((rows, pageIndex) => {
          f.answer(
            refs[channelIndex]!,
            pageIndex + 1,
            rows.map(candidateOf),
            pageIndex + 1 < pages.length,
          );
          for (const { product } of rows) {
            const rebate = isNoRebate(product) ? 0n : rebateOf(product);
            f.quotes.set(title(nameOf(product)), { min: rebate, max: rebate });
          }
        });
      });

      let cursor: string | undefined;
      let pages: readonly number[] = refs.map(() => 1);
      for (;;) {
        const want = expectedStep(layout, pages);
        const registered = f.registered().length;
        const data = await f.run(cursor === undefined ? {} : { cursor });

        expect(titlesOf(data)).toEqual(want.titles);
        expect(f.registered().slice(registered)).toEqual(want.titles);
        expect(data.has_more).toBe(want.hasMore);
        if (!want.hasMore) {
          expect(data.next_cursor).toBeNull();
          break;
        }
        expect(decodeCursor(data.next_cursor!)).toEqual({
          page_key: PAGE_KEY,
          section_id: SECTION_ID,
          pages: want.next,
        });
        cursor = data.next_cursor!;
        pages = want.next;
      }
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 240_000);

const economicsArb = fc.record({
  finalFen: fc.bigInt({ min: 100n, max: 10_000_000n }),
  commissionBp: fc.bigInt({ min: 0n, max: 9_000n }),
  rebateFen: fc.bigInt({ min: 1n, max: 99n }),
});
const ECONOMICS_LENGTH = SECTION_PAGE_SIZE;

async function deliveredTitles(
  lengths: readonly number[],
  economics: readonly { finalFen: bigint; commissionBp: bigint; rebateFen: bigint }[],
): Promise<(string | null)[]> {
  const refs = refsOf(lengths.length);
  const f = sectionFixture({ channels: refs });
  let product = 0;
  for (const [index, length] of lengths.entries()) {
    const rows: HotRankCandidate[] = [];
    for (let position = 0; position < length; position += 1) {
      const money = economics[product]!;
      const name = `c${index}-${position}`;
      rows.push(withCommission(candidate(name, { finalFen: money.finalFen }), money.commissionBp));
      f.quotes.set(title(name), { min: money.rebateFen, max: money.rebateFen });
      product += 1;
    }
    f.answer(refs[index]!, 1, rows);
  }
  return titlesOf(await f.run());
}

it('[AC-B1-05o#61] 属性：同样的频道与商品，换任意价格、佣金、返利，下发顺序一字不变，都等于纯交错', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }).chain((channels) =>
        fc.array(fc.nat({ max: Math.floor(SECTION_PAGE_SIZE / channels) }), {
          minLength: channels,
          maxLength: channels,
        }),
      ),
      fc.array(economicsArb, { minLength: ECONOMICS_LENGTH, maxLength: ECONOMICS_LENGTH }),
      fc.array(economicsArb, { minLength: ECONOMICS_LENGTH, maxLength: ECONOMICS_LENGTH }),
      async (lengths, left, right) => {
        const expected = interleave(
          lengths.map((length, index) =>
            Array.from({ length }, (_unused, position) => title(`c${index}-${position}`)),
          ),
        );

        expect(await deliveredTitles(lengths, left)).toEqual(expected);
        expect(await deliveredTitles(lengths, right)).toEqual(expected);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
