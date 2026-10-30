// B1-05o rule-test kit: getSectionItems over the hot list kit's storage-only fakes (real card entry,
// fake quoter and link registrar). Everything is synthetic: channels are fixture whitelist entries
// and no platform payload is imitated (CAP-TB-10, CAP-JD-10, CAP-PDD-10 are not recorded yet).
// No vi.fn here: a fixture is built per property iteration (see the hot list kit's spy).
import { expect } from 'vitest';
import type {
  HotRankCandidate,
  HotRankPageRequest,
  HotRankUpstream,
} from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { createGuestViewerContext } from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  getSectionItems,
  type PageSectionItemsData,
  type SectionItemsOptions,
  type SectionItemsPages,
  type SectionItemsQuery,
} from '../../../../apps/api/src/modules/catalog/section-items.ts';
import type { Platform } from '../../../../apps/api/src/modules/union/index.ts';
import { APP, channel, fixture, type ChannelEntry } from '../hot-rank/kit.ts';

export const PAGE_KEY = 'home';
export const SECTION_ID = 'synthetic_feed';
/** The server constant of the contract: page size 20, no limit parameter. */
export const SECTION_PAGE_SIZE = 20;
/** Every empty answer of the contract: refused, no data, every channel failed. */
export const EMPTY: PageSectionItemsData = { items: [], next_cursor: null, has_more: false };

/** One entry of a data source's `channels`. */
export interface ChannelRef {
  readonly platform: Platform;
  readonly channel_id: string;
}

export const TB: ChannelRef = { platform: 'taobao', channel_id: 'synthetic_tb_sales' };
export const JD: ChannelRef = { platform: 'jd', channel_id: 'synthetic_jd_sales' };
export const PDD: ChannelRef = { platform: 'pdd', channel_id: 'synthetic_pdd_sales' };

/** A selectable whitelist entry for the channel. */
export function entryOf(ref: ChannelRef): ChannelEntry {
  return channel(ref.platform, ref.channel_id);
}

/** `count` taobao channels, so that they can answer the same product. */
export function refsOf(count: number): ChannelRef[] {
  return Array.from({ length: count }, (_unused, index): ChannelRef => ({
    platform: 'taobao',
    channel_id: `synthetic_ch_${index}`,
  }));
}

export function materialSource(refs: readonly ChannelRef[], mix?: 'interleave'): unknown {
  return { kind: 'union_material', channels: refs, ...(mix === undefined ? {} : { mix }) };
}

/** The title of the card of `candidate(name)`. */
export function title(name: string): string {
  return `synthetic-${name}`;
}

/** The titles of `series(prefix, count, start)`. */
export function names(prefix: string, count: number, start = 1): string[] {
  return Array.from({ length: count }, (_unused, index) => title(`${prefix}-${start + index}`));
}

export function titlesOf(data: PageSectionItemsData): (string | null)[] {
  return data.items.map((card) => card.title);
}

/** One round: each list gives its first element, then each its second, and so on. */
export function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const merged: T[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      if (index < list.length) merged.push(list[index]!);
    }
  }
  return merged;
}

/** The candidate with a price the card entry refuses. */
export function anomalous(entry: HotRankCandidate): HotRankCandidate {
  return { ...entry, item: { ...entry.item, price_status: 'anomaly' } };
}

export function withCommission(entry: HotRankCandidate, rateBp: bigint): HotRankCandidate {
  return { ...entry, item: { ...entry.item, commission_rate_bp: rateBp } };
}

export function encodeCursor(claims: unknown): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

export function pagesCursor(pages: readonly number[]): string {
  return encodeCursor({ page_key: PAGE_KEY, section_id: SECTION_ID, pages });
}

export function decodeCursor(cursor: string): unknown {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

/** The response goes on, with exactly these upstream pages in its cursor. */
export function expectPages(data: PageSectionItemsData, pages: readonly number[]): void {
  expect(data.has_more).toBe(true);
  expect(typeof data.next_cursor).toBe('string');
  expect(decodeCursor(data.next_cursor!)).toEqual({
    page_key: PAGE_KEY,
    section_id: SECTION_ID,
    pages,
  });
}

export interface SectionSetup {
  /** The data source's channels, whitelisted as selectable; default TB then JD. */
  readonly channels?: readonly ChannelRef[];
  readonly mix?: 'interleave';
  /** The request's device; absent keeps the hot list fixture's guest with a device. */
  readonly deviceId?: string | null;
}

export function sectionFixture(setup: SectionSetup = {}) {
  const refs = setup.channels ?? [TB, JD];
  const base = fixture();
  base.setChannels(refs.map(entryOf));

  let section: { readonly dataSource: unknown } | null = {
    dataSource: materialSource(refs, setup.mix),
  };
  const sections: Parameters<SectionItemsPages['section']>[0][] = [];
  const pages: SectionItemsPages = {
    async section(input) {
      sections.push(input);
      return section;
    },
  };

  const failures = new Map<string, { readonly error: Error; readonly pageNo: number | null }>();
  const calls: HotRankPageRequest[] = [];
  /** How many whitelist reads had happened when each upstream page was asked for. */
  const readsAtFetch: number[] = [];
  const upstream: HotRankUpstream = {
    categories: (input) => base.options.upstream.categories(input),
    page: async (input) => {
      calls.push(input);
      readsAtFetch.push(base.channels.mock.calls.length);
      const failure = failures.get(input.channelId);
      if (failure !== undefined && (failure.pageNo === null || failure.pageNo === input.pageNo)) {
        throw failure.error;
      }
      return base.options.upstream.page(input);
    },
  };

  const options: SectionItemsOptions = {
    viewerContext:
      setup.deviceId === undefined
        ? base.options.viewerContext
        : createGuestViewerContext({ appId: APP, deviceId: setup.deviceId }),
    cards: base.options.cards,
    channels: base.options.channels,
    upstream,
    pages,
    logger: base.options.logger,
  };

  const warned = (): Record<string, unknown>[] =>
    base.warn.mock.calls.map(([fields]) => fields as Record<string, unknown>);

  return {
    options,
    sections,
    calls,
    readsAtFetch,
    channels: base.channels,
    assemble: base.assemble,
    register: base.register,
    quotes: base.quotes,
    setChannels: base.setChannels,
    setSection(value: { readonly dataSource: unknown } | null) {
      section = value;
    },
    /** One upstream page of the channel. */
    answer(
      ref: ChannelRef,
      pageNo: number,
      items: readonly HotRankCandidate[],
      hasMore = false,
    ): void {
      base.setPage(ref.platform, ref.channel_id, null, pageNo, items, hasMore);
    },
    /** The channel's pages (only `pageNo` when given) throw until recover. */
    failChannel(ref: ChannelRef, error: Error, pageNo: number | null = null): void {
      failures.set(ref.channel_id, { error, pageNo });
    },
    recover(ref: ChannelRef): void {
      failures.delete(ref.channel_id);
    },
    /** The cards of these names price at zero rebate: no_rebate. */
    noRebate(...cardNames: readonly string[]): void {
      for (const name of cardNames) base.quotes.set(title(name), { min: 0n, max: 0n });
    },
    /** Upstream page numbers asked of the channel, in order. */
    pageNos(ref: ChannelRef): number[] {
      return calls
        .filter((call) => call.platform === ref.platform && call.channelId === ref.channel_id)
        .map((call) => call.pageNo);
    },
    /** Titles of the cards whose link was registered, in order. */
    registered(): string[] {
      return base.register.mock.calls.map(([input]) => input.item.title);
    },
    /** The use case's warnings (the card entry's PRICE_ANOMALY lines are apart). */
    warnings(): Record<string, unknown>[] {
      return warned().filter((fields) => fields['code'] !== 'PRICE_ANOMALY');
    },
    anomalies(): Record<string, unknown>[] {
      return warned().filter((fields) => fields['code'] === 'PRICE_ANOMALY');
    },
    run(query: Partial<SectionItemsQuery> = {}): Promise<PageSectionItemsData> {
      return getSectionItems({ pageKey: PAGE_KEY, sectionId: SECTION_ID, ...query }, options);
    },
  };
}
