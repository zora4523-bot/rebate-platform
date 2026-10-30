// B1-28l rule-test kit: rank = the channel's original position (D10-422 ②). Built on the frozen
// kits of B1-28h (use case over a fake union side) and B1-28j (wiring over a fake adapter), both
// with synthetic data only. HotRankUpstreamPage has no `positions` before B1-28l's implementation,
// so the field is read and passed through the local GapPage type here: this compiles before and
// after it. Nothing here builds a vi.fn (a fixture per property run, B1-28h ran out of heap).
import { expect } from 'vitest';
import {
  getHotRank,
  type HotRankCandidate,
  type HotRankData,
  type HotRankOptions,
  type HotRankQuery,
  type HotRankUpstream,
  type HotRankUpstreamPage,
} from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { cacheHotRankUpstream } from '../../../../apps/api/src/modules/catalog/infra/hot-rank-cache.ts';
import type { ChannelRankingEntry } from '../../../../apps/api/src/modules/union/index.ts';
import { jdItem, position, tbItem } from '../hot-rank-upstream/kit.ts';
import { TB_CHANNEL, fixture } from '../hot-rank/kit.ts';

/** An upstream page with B1-28l's page-level field: each item's place in the channel page. */
export type GapPage = HotRankUpstreamPage & { readonly positions?: readonly number[] };

export function positionsOf(page: HotRankUpstreamPage): readonly number[] | undefined {
  return (page as GapPage).positions;
}

export function ranks(data: HotRankData): number[] {
  return data.items.map((item) => item.rank);
}

export function rows(data: HotRankData): [number, string | null, string | null][] {
  return data.items.map((item) => [item.rank, item.product_card.title, item.sales_text]);
}

/** The same channel position with a final price BR-PRICE-01 refuses: the card entry skips it. */
export function anomalous(entry: HotRankCandidate): HotRankCandidate {
  return { ...entry, item: { ...entry.item, final_price_fen: 1n } };
}

export type SlotKind = 'keep' | 'foreign' | 'underivable' | 'anomaly';

/**
 * One raw channel page for the wiring, a slot per kind numbered n = start + index: `keep` is listed
 * as `synthetic-good-<n>` with sales `<n>件`, `foreign` (another platform) and `underivable` (no
 * product key) are dropped by the wiring, `anomaly` passes it and is skipped by the card entry.
 */
export function channelEntries(
  kinds: readonly SlotKind[],
  start = 1,
): readonly ChannelRankingEntry[] {
  return kinds.map((kind, index) => {
    const n = start + index;
    switch (kind) {
      case 'keep':
        return position(tbItem(`good-${String(n)}`, n), `${String(n)}件`);
      case 'foreign':
        return position(jdItem('foreign', n), 'X');
      case 'underivable':
        return position({ ...tbItem('underivable', n), item_id: '' }, 'X');
      case 'anomaly':
        return position({ ...tbItem('anomaly', n), final_price_fen: 1n }, 'X');
    }
  });
}

export interface GapSetup {
  /** Wrap the union side in cacheHotRankUpstream (memory Redis, the fixture's clock and config). */
  readonly cached?: boolean;
}

/** B1-28h's fixture over a union side that also answers `positions`; only taobao's channel. */
export function gapFixture(setup: GapSetup = {}) {
  const f = fixture();
  const stored = new Map<string, readonly number[]>();
  const slot = (categoryId: string | null, pageNo: number) => JSON.stringify([categoryId, pageNo]);
  const side: HotRankUpstream = {
    categories: (input) => f.upstream.categories(input),
    async page(input) {
      const page = await f.upstream.page(input);
      const positions = stored.get(slot(input.categoryId, input.pageNo));
      if (positions === undefined) return page;
      const gap: GapPage = { ...page, positions };
      return gap;
    },
  };
  const upstream =
    setup.cached === true
      ? cacheHotRankUpstream(side, {
          redis: f.memory.redis,
          clock: f.clock,
          config: { configValue: f.configValue },
        })
      : side;
  const options: HotRankOptions = { ...f.options, upstream };
  return {
    ...f,
    gapUpstream: upstream,
    /** `positions: null` answers the plain `{ items, hasMore }` page. */
    setGapPage(
      pageNo: number,
      items: readonly HotRankCandidate[],
      positions: readonly number[] | null,
      hasMore = false,
      categoryId: string | null = null,
    ) {
      f.setPage('taobao', TB_CHANNEL, categoryId, pageNo, items, hasMore);
      if (positions === null) stored.delete(slot(categoryId, pageNo));
      else stored.set(slot(categoryId, pageNo), positions);
    },
    run(query: Partial<HotRankQuery> = {}) {
      return getHotRank({ platform: 'taobao', ...query }, options);
    },
  };
}

export interface PageRow {
  readonly key: string;
  readonly entry: { readonly v: unknown; readonly data: Record<string, unknown> };
}

/** The stored page rows, in insertion order; a categories row has a list as its data. */
export function pageRows(rows: ReadonlyMap<string, string>): PageRow[] {
  return [...rows].flatMap(([key, text]) => {
    const entry = JSON.parse(text) as { v: unknown; data: unknown };
    return Array.isArray(entry.data) ? [] : [{ key, entry: entry as PageRow['entry'] }];
  });
}

/** Overwrites `positions` of every stored page; undefined leaves the page without the key. */
export function storePositions(rows: Map<string, string>, value: unknown): void {
  const pages = pageRows(rows);
  expect(pages.length).toBeGreaterThan(0);
  for (const { key, entry } of pages) {
    rows.set(key, JSON.stringify({ ...entry, data: { ...entry.data, positions: value } }));
  }
}
