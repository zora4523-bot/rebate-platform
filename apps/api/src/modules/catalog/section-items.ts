// B1-05o public section items use case, GET /v1/pages/{page_key}/sections/{section_id}/items
// (contract listPageSectionItems, CT-07c; BR-TEXT-17 细则「联盟物料频道」): the union_material data
// source of a published section. Rule tests: test/spec/catalog/section-items/**.
// TODO(规划/11 §4.5): 类目黑名单 — blocked on UnionItem 类目字段（CAP-*-03）
import type { components } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import type { MaterialChannelsSpec } from '../platform/index.ts';
import { isPlatform, type Platform } from '../union/index.ts';
import type { PreparedCard } from './application/card-assembler.ts';
import type { CatalogCardEntry } from './application/card-entry.ts';
import { CatalogError } from './domain/rules.ts';
import {
  HOT_RANK_MAX_PAGE_NO,
  type HotRankCandidate,
  type HotRankUpstream,
  type HotRankUpstreamPage,
} from './hot-rank.ts';
import type { ViewerContext } from './ports.ts';
import { isFeedFailure } from './search.ts';

export type PageSectionItemsData = components['schemas']['PageSectionItemsData'];

export interface SectionItemsQuery {
  readonly pageKey: string;
  readonly sectionId: string;
  readonly cursor?: string;
}

export interface SectionItemsSection {
  readonly dataSource: unknown;
}

/** 读已发布页面里的一张卡片：版本与 min_app_version 同 getPage，condition 不判定；没有返回 null。 */
export interface SectionItemsPages {
  section(input: {
    readonly appId: string;
    readonly pageKey: string;
    readonly sectionId: string;
    readonly deviceId: string | null;
  }): Promise<SectionItemsSection | null>;
}

export interface SectionItemsOptions {
  readonly viewerContext: ViewerContext;
  readonly cards: CatalogCardEntry;
  /** Read before every fetch (production: platform's getMaterialChannels). */
  readonly channels: () => MaterialChannelsSpec;
  /** Production: cacheHotRankUpstream(createUnionHotRankUpstream(...)), the hot list's fetch. */
  readonly upstream: HotRankUpstream;
  readonly pages: SectionItemsPages;
  readonly logger: Pick<Logger, 'warn'>;
}

/** Server constant of the contract: no limit parameter. */
const SECTION_PAGE_SIZE = 20;
/** links.entry_source of feed cards (opaque text, like 'search' and 'rank'). */
const FEED_ENTRY_SOURCE = 'feed';
/** Contract Cursor maxLength. */
const CURSOR_WIRE = /^[A-Za-z0-9_-]{1,512}$/;
const CURSOR_KEYS = ['page_key', 'pages', 'section_id'];

/** One entry of the data source's `channels`. */
interface ChannelRef {
  readonly platform: Platform;
  readonly channel_id: string;
}

/** A channel during one request. */
interface ChannelState {
  readonly ref: ChannelRef;
  /** The next upstream page, from 1; 0 when the channel is finished. */
  next: number;
  /** The upstream reported more and the page cap allows it. */
  more: boolean;
  failed: boolean;
}

function invalidCursor(): never {
  throw new CatalogError(20001, 'section: malformed cursor', { fields: ['cursor'] });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The data source's channels; anything but a union_material source is 30701. */
function channelsOf(dataSource: unknown): readonly ChannelRef[] {
  const channels = isRecord(dataSource) ? dataSource['channels'] : undefined;
  const refs: ChannelRef[] = [];
  if (isRecord(dataSource) && dataSource['kind'] === 'union_material' && Array.isArray(channels)) {
    for (const entry of channels as unknown[]) {
      if (!isRecord(entry)) break;
      const { platform, channel_id: channelId } = entry;
      if (typeof platform !== 'string' || !isPlatform(platform)) break;
      if (typeof channelId !== 'string') break;
      refs.push({ platform, channel_id: channelId });
    }
    if (refs.length > 0 && refs.length === channels.length) return refs;
  }
  throw new CatalogError(30701, 'section: no union_material data source');
}

function encodeCursor(query: SectionItemsQuery, pages: readonly number[]): string {
  return Buffer.from(
    JSON.stringify({ page_key: query.pageKey, section_id: query.sectionId, pages }),
    'utf8',
  ).toString('base64url');
}

/**
 * Each channel's next page. A cursor is exactly { page_key, section_id, pages } of this section,
 * with one page per current channel; anything else is 20001. A page beyond the cap is finished.
 */
function decodeCursor(query: SectionItemsQuery, value: string, channels: number): number[] {
  if (!CURSOR_WIRE.test(value)) invalidCursor();
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    invalidCursor();
  }
  if (!isRecord(payload)) invalidCursor();
  const keys = Object.keys(payload).sort();
  if (keys.length !== CURSOR_KEYS.length || keys.some((key, index) => key !== CURSOR_KEYS[index])) {
    invalidCursor();
  }
  const { page_key: pageKey, section_id: sectionId, pages } = payload;
  if (pageKey !== query.pageKey || sectionId !== query.sectionId) invalidCursor();
  if (!Array.isArray(pages) || pages.length !== channels) invalidCursor();
  return (pages as unknown[]).map((page) => {
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 0) invalidCursor();
    return page > HOT_RANK_MAX_PAGE_NO ? 0 : page;
  });
}

/** The first channel the whitelist as it is now does not offer as selectable. */
function refusedChannel(
  refs: readonly ChannelRef[],
  spec: MaterialChannelsSpec,
): ChannelRef | undefined {
  return refs.find(
    (ref) =>
      !spec.channels.some(
        (entry) =>
          entry.platform === ref.platform &&
          entry.channel_id === ref.channel_id &&
          entry.selectable === true,
      ),
  );
}

/** One item per list per round; no field of an item has a say (BR-TEXT-17 细则). */
function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const merged: T[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      if (index < list.length) merged.push(list[index]!);
    }
  }
  return merged;
}

/** Flat diagnostic fields of a swallowed error (no stack, no object dump). */
function errorFields(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      error_name: error.name,
      error_message: error.message,
      ...(typeof code === 'string' || typeof code === 'number' ? { error_code: String(code) } : {}),
    };
  }
  return { error_name: typeof error, error_message: String(error) };
}

/**
 * One page of a union_material section (contract listPageSectionItems): section (30701) → cursor
 * (20001) → a round of upstream pages → at most one refill round when fewer than 20 cards survive
 * → link registration of the delivered cards only. Each round first checks every channel against
 * the whitelist as it is now: one refused channel means no fetch at all, an alert and the empty
 * answer. A union-side failure drops only that channel's page and keeps its page number; a
 * programming error propagates. The cursor records upstream pages, so cards cut at 20 are never
 * shown (BR-PRICE-08). Merging reads no price, rebate or commission and ad_label stays null.
 */
export async function getSectionItems(
  query: SectionItemsQuery,
  options: SectionItemsOptions,
): Promise<PageSectionItemsData> {
  const { cards, logger, upstream } = options;
  const { appId, deviceId } = await options.viewerContext.current();
  const section = await options.pages.section({
    appId,
    pageKey: query.pageKey,
    sectionId: query.sectionId,
    deviceId,
  });
  const refs = channelsOf(section?.dataSource);
  const start =
    query.cursor === undefined ? refs.map(() => 1) : decodeCursor(query, query.cursor, refs.length);
  const pageSize = Math.max(1, Math.floor(SECTION_PAGE_SIZE / refs.length));
  const channels = refs.map((ref, index): ChannelState => ({
    ref,
    next: start[index]!,
    more: false,
    failed: false,
  }));

  const fetchPage = async (channel: ChannelState): Promise<HotRankUpstreamPage | null> => {
    const { platform, channel_id: channelId } = channel.ref;
    try {
      return await upstream.page({
        appId,
        platform,
        channelId,
        categoryId: null,
        pageNo: channel.next,
        pageSize,
      });
    } catch (error: unknown) {
      if (!isFeedFailure(error)) throw error;
      logger.warn(
        {
          event: 'section_channel_failed',
          platform,
          channel_id: channelId,
          page_no: channel.next,
          ...errorFields(error),
        },
        'section: channel page failed, dropped from this page',
      );
      return null;
    }
  };

  const delivered: PreparedCard[] = [];
  const keys = new Set<string>();
  let answered = false;

  /** Through the single card entry until the page is full; false when the whitelist refused. */
  const round = async (active: readonly ChannelState[]): Promise<boolean> => {
    const spec = options.channels();
    const refused = refusedChannel(refs, spec);
    if (refused !== undefined) {
      logger.warn(
        {
          event: 'section_channel_refused',
          platform: refused.platform,
          channel_id: refused.channel_id,
          whitelist_version: spec.version,
        },
        'section: channel not selectable in the whitelist at fetch time, data source not fetched',
      );
      return false;
    }
    const pages = await Promise.all(active.map(fetchPage));
    const lists: (readonly HotRankCandidate[])[] = [];
    for (const [index, page] of pages.entries()) {
      const channel = active[index]!;
      if (page === null) {
        channel.failed = true;
        continue;
      }
      answered = true;
      channel.more = page.hasMore && channel.next < HOT_RANK_MAX_PAGE_NO;
      channel.next = channel.more ? channel.next + 1 : 0;
      lists.push(page.items);
    }
    for (const { item, ref } of interleave(lists)) {
      if (delivered.length >= SECTION_PAGE_SIZE) break;
      const result = await cards.assemble({
        item,
        ref,
        entrySource: FEED_ENTRY_SOURCE,
        stale: false,
        scene: 'retrieval',
        deferLink: true,
      });
      if (result.kind !== 'prepared' || result.card.rebate_basis === 'no_rebate') continue;
      const key = result.card.product_key;
      if (key !== null) {
        if (keys.has(key)) continue;
        keys.add(key);
      }
      delivered.push(result);
    }
    return true;
  };

  const empty: PageSectionItemsData = { items: [], next_cursor: null, has_more: false };
  if (!(await round(channels.filter((channel) => channel.next > 0)))) return empty;
  const refill = channels.filter((channel) => channel.more);
  if (delivered.length < SECTION_PAGE_SIZE && refill.length > 0 && !(await round(refill))) {
    return empty;
  }

  const items: PageSectionItemsData['items'] = [];
  for (const card of delivered) items.push(await card.commit());
  const hasMore =
    channels.some((channel) => channel.more) ||
    (answered && channels.some((channel) => channel.failed));
  return {
    items,
    next_cursor: hasMore
      ? encodeCursor(
          query,
          channels.map((channel) => channel.next),
        )
      : null,
    has_more: hasMore,
  };
}
