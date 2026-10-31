// B1-28n rule-test kit (D10-508, BR-PRICE-11 细则): the hot list and the section feed over one real
// cacheHotRankUpstream, as in production (the cache serves both), on the storage-only fakes of the
// B1-28h kit with synthetic data only. The union can fail as a whole (`fail`) or per channel
// (`failChannel`). Configuration goes through a CatalogConfigReader of its own, per app and with any
// JSON value, since the frozen fixture's settings hold one app's numbers only. Nothing here builds a
// vi.fn (a fixture per property run, B1-28h ran out of heap).
//
// Every rule test of this task is new, so each must be red on the code as it stands, which already
// answers an old page of any age: a test that says what stays usable also crosses the limit.
import { expect } from 'vitest';
import {
  getHotRank,
  type HotRankCandidate,
  type HotRankData,
  type HotRankOptions,
  type HotRankPageRequest,
  type HotRankQuery,
  type HotRankUpstream,
} from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { cacheHotRankUpstream } from '../../../../apps/api/src/modules/catalog/infra/hot-rank-cache.ts';
import type { CatalogConfigReader } from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  getSectionItems,
  type PageSectionItemsData,
  type SectionItemsOptions,
  type SectionItemsQuery,
} from '../../../../apps/api/src/modules/catalog/section-items.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { APP, PAGE_SIZE, fixture, rejection, series } from '../hot-rank/kit.ts';
import {
  PAGE_KEY,
  SECTION_ID,
  TB,
  entryOf,
  materialSource,
  type ChannelRef,
} from '../section-items/kit.ts';

export const MAX_AGE_KEY = 'pool.max_age_sec';
/** BR-PRICE-11 and D10-508: pool.max_age_sec defaults to 7200 seconds. */
export const DEFAULT_MAX_AGE_SECONDS = 7200;
/** What the physical Redis TTL keeps beyond rank.cache_ttl_seconds; D10-508 leaves it as it is. */
export const OUTAGE_KEEP_SECONDS = 86_400;

export type ConfigValue = NonNullable<
  Awaited<ReturnType<CatalogConfigReader['configValue']>>
>['value'];

export const unavailable = (): UnionError =>
  new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao');

/** The dependency failures of the rule: union timeout and rate limit, and what the breaker adds. */
export const OUTAGES = [
  {
    label: 'GovernanceError timeout',
    outage: new GovernanceError('timeout', 'union:taobao:online', 'synthetic slow'),
  },
  {
    label: 'UnionError rate_limited',
    outage: new UnionError('rate_limited', 'synthetic rate limited', 'taobao'),
  },
  {
    label: 'UnionError upstream_unavailable',
    outage: unavailable(),
  },
  {
    label: 'GovernanceError circuit_open',
    outage: new GovernanceError('circuit_open', 'union:taobao:online', 'synthetic circuit open'),
  },
  {
    label: 'GovernanceError quota_exceeded',
    outage: new GovernanceError('quota_exceeded', 'union:taobao:online', 'synthetic quota'),
  },
];

interface InvalidMaxAge {
  readonly label: string;
  readonly value: ConfigValue;
}

/** Values of pool.max_age_sec that are not a safe integer ≥ 1: the default applies. */
export const INVALID_MAX_AGES: readonly InvalidMaxAge[] = [
  { label: '0', value: 0 },
  { label: '负数', value: -1 },
  { label: '小数', value: 3600.5 },
  { label: '超出安全整数', value: 2 ** 53 },
  { label: '数字字符串', value: '3600' },
  { label: '布尔', value: true },
  { label: 'null', value: null },
  { label: '数组', value: [3600] },
  { label: '对象', value: { seconds: 3600 } },
];

/** The upstream page request of the hot list's first page on the taobao channel. */
export function pageInput(overrides: Partial<HotRankPageRequest> = {}): HotRankPageRequest {
  return {
    appId: APP,
    platform: TB.platform,
    channelId: TB.channel_id,
    categoryId: null,
    pageNo: 1,
    pageSize: PAGE_SIZE,
    ...overrides,
  };
}

/** What the hot list must keep of its first answer. */
export function rankRows(data: HotRankData): [number, string | null, string | null][] {
  return data.items.map((item) => [item.rank, item.product_card.title, item.sales_text]);
}

export interface MaxAgeSetup {
  /** The section's channels, whitelisted as selectable; default the taobao channel alone. */
  readonly channels?: readonly ChannelRef[];
}

export function maxAgeFixture(setup: MaxAgeSetup = {}) {
  const refs = setup.channels ?? [TB];
  const f = fixture();
  f.setChannels(refs.map(entryOf));
  const start = f.clock.now().getTime();

  const outages = new Map<string, Error>();
  const side: HotRankUpstream = {
    categories: (input) => f.upstream.categories(input),
    page: async (input) => {
      const outage = outages.get(input.channelId);
      if (outage !== undefined) throw outage;
      return f.upstream.page(input);
    },
  };

  const settings = new Map<string, ConfigValue>();
  const slot = (appId: string, key: string): string => JSON.stringify([appId, key]);
  const config: CatalogConfigReader = {
    configValue: async (appId, key) => {
      const id = slot(appId, key);
      return settings.has(id) ? { value: settings.get(id)!, version: 1 } : null;
    },
  };

  const upstream = cacheHotRankUpstream(side, {
    redis: f.memory.redis,
    clock: f.clock,
    config,
  });
  const rankOptions: HotRankOptions = { ...f.options, upstream };
  const feedOptions: SectionItemsOptions = {
    viewerContext: f.options.viewerContext,
    cards: f.options.cards,
    channels: f.options.channels,
    upstream,
    pages: { section: async () => ({ dataSource: materialSource(refs) }) },
    logger: f.options.logger,
  };

  return {
    ...f,
    /** The cached union side; `options` and `run` go through it too. */
    upstream,
    options: rankOptions,
    configure(key: string, value: ConfigValue, appId: string = APP): void {
      settings.set(slot(appId, key), value);
    },
    /** Puts the clock `seconds` after the fixture's start, the instant of the first store. */
    ageTo(seconds: number): void {
      f.clock.advanceMs(start + seconds * 1000 - f.clock.now().getTime());
    },
    answer(ref: ChannelRef, items: readonly HotRankCandidate[], pageNo = 1, hasMore = false): void {
      f.setPage(ref.platform, ref.channel_id, null, pageNo, items, hasMore);
    },
    failChannel(ref: ChannelRef, error: Error): void {
      outages.set(ref.channel_id, error);
    },
    recover(ref: ChannelRef): void {
      outages.delete(ref.channel_id);
    },
    /** channel_id of each channel the feed dropped, in the order of the warnings. */
    droppedChannels(): string[] {
      return f.warn.mock.calls
        .map(([fields]) => fields as Record<string, unknown>)
        .filter((fields) => fields['event'] === 'section_channel_failed')
        .map((fields) => fields['channel_id'] as string);
    },
    /** Titles of the cards whose link was registered, in order. */
    registered(): string[] {
      return f.register.mock.calls.map(([input]) => input.item.title);
    },
    run(query: Partial<HotRankQuery> = {}): Promise<HotRankData> {
      return getHotRank({ platform: 'taobao', ...query }, rankOptions);
    },
    feed(query: Partial<SectionItemsQuery> = {}): Promise<PageSectionItemsData> {
      return getSectionItems({ pageKey: PAGE_KEY, sectionId: SECTION_ID, ...query }, feedOptions);
    },
  };
}

export type MaxAgeFixture = ReturnType<typeof maxAgeFixture>;

/** A fixture with one page stored at its start and the union down from then on. */
export async function storedPage(outage: Error = unavailable()): Promise<MaxAgeFixture> {
  const f = maxAgeFixture();
  f.answer(TB, series('kept', 2));
  await f.upstream.page(pageInput());
  f.fail(outage);
  return f;
}

export async function expectServed(
  f: MaxAgeFixture,
  input: HotRankPageRequest = pageInput(),
): Promise<void> {
  await expect(f.upstream.page(input)).resolves.toMatchObject({ stale: true });
}

/** The old page is treated as absent: the union's own error comes out of the cache. */
export async function expectRefused(
  f: MaxAgeFixture,
  outage: Error,
  input: HotRankPageRequest = pageInput(),
): Promise<void> {
  const error = await rejection(() => f.upstream.page(input));
  expect(error === outage).toBe(true);
}
