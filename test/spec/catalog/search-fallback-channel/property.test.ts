// B1-05n: for any channel page and any limit, materialFeed is exactly the page's usable items, in
// the channel's order, cut to the first `limit`, with the port's hasMore (BR-TEXT-17 细则「联盟物料
// 频道」: the order is the channel's, whatever an item's commission or price). One fixture serves
// the whole run and nothing here builds a vi.fn (B1-28h ran out of heap that way).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type {
  ChannelRankingEntry,
  UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import { feedRequest, fixture, jdItem, position, tbItem } from './kit.ts';

type Slot = 'keep' | 'foreign' | 'underivable';

interface SlotSpec {
  readonly kind: Slot;
  readonly commissionBp: bigint;
  readonly finalFen: bigint;
  readonly salesText: string | null;
}

const slotArb = fc.record({
  kind: fc.constantFrom<Slot>('keep', 'foreign', 'underivable'),
  commissionBp: fc.bigInt({ min: 0n, max: 10_000n }),
  finalFen: fc.bigInt({ min: 1n, max: 100_000n }),
  salesText: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
});

function itemOf(spec: SlotSpec, n: number): UnionItem {
  const priced = { commissionBp: spec.commissionBp, finalFen: spec.finalFen };
  const name = `p-${String(n)}`;
  if (spec.kind === 'foreign') return jdItem(name, n, priced);
  if (spec.kind === 'underivable') return { ...tbItem(name, n, priced), item_id: '' };
  return tbItem(name, n, priced);
}

it('[AC-B1-05n#22][BR-TEXT-17] 属性：任意条目序列与 limit，结果恰为可用条目按频道顺序的前 limit 条，不超过 limit，hasMore 取端口的，请求的 pageSize 为 limit', async () => {
  const f = fixture();
  const upstream = f.upstream();
  const fake = f.fake('taobao');
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(slotArb, { maxLength: 60 }),
      fc.integer({ min: 1, max: 50 }),
      fc.boolean(),
      async (slots, limit, hasMore) => {
        const entries: ChannelRankingEntry[] = slots.map((spec, index) =>
          position(itemOf(spec, index + 1), spec.salesText),
        );
        fake.setPage({ items: entries, hasMore });

        const page = await upstream.materialFeed(feedRequest({ limit }));

        const usable = entries.filter((_, index) => slots[index]?.kind === 'keep');
        expect(page.items.map((candidate) => candidate.item)).toEqual(
          usable.slice(0, limit).map((entry) => entry.item),
        );
        expect(page.items.length).toBeLessThanOrEqual(limit);
        expect(page.hasMore).toBe(hasMore);
        expect(fake.rankingCalls.at(-1)?.req.pageSize).toBe(limit);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
