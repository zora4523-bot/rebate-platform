// B1-05n rule-test kit: search's no-result fallback over union's material-channel ranking port
// (createUnionChannelRanking, B1-22p). The real createUnionSearchUpstream, behind the real
// cacheSearchUpstream and under the real searchProducts, runs over a call-recording governed union
// whose adapters return domain DTOs only: platform channel capabilities (规划/09 CAP-TB-10,
// CAP-JD-10, CAP-PDD-10) are not recorded, so no platform payload, channel id or field name is
// imitated. Every adapter also offers a general material feed with other content, so a fallback
// served from it shows as a wrong card and not as a crash. The `channels` and `logger` options do
// not exist on UnionSearchUpstreamOptions before B1-05n's implementation: WiringOptions declares
// them here, so this compiles before and after it. Recorders are plain arrays, never vi.fn: one
// fixture serves a whole property run.
import { vi } from 'vitest';
import type { ProductRef } from '../../../../apps/api/src/modules/catalog/domain/types.ts';
import { cacheSearchUpstream } from '../../../../apps/api/src/modules/catalog/infra/product-cache.ts';
import {
  createUnionSearchUpstream,
  type UnionSearchUpstreamOptions,
} from '../../../../apps/api/src/modules/catalog/infra/search-wiring.ts';
import type {
  CatalogConfigReader,
  GovernedUnion,
} from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  searchProducts,
  type SearchProductsQuery,
  type SearchUpstream,
} from '../../../../apps/api/src/modules/catalog/search.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  MaterialChannelsSpec,
  RedisNamespace,
  RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  CallCtx,
  ChannelRankingPage,
  ChannelRankingReq,
  RegisteredPlatform,
  UnionAdapter,
  UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  JD_CHANNEL,
  JD_MODE_KEY,
  NOW,
  PDD_CHANNEL,
  QUOTED_AT,
  TB_CHANNEL,
  channel,
  jdItem,
  memoryRedis,
  pddItem,
  platformRow,
  position,
  rejection,
  tbItem,
  type Call,
  type ChannelEntry,
} from '../hot-rank-upstream/kit.ts';
import { QUERY, fixture as searchFixture, observed } from '../search/kit.ts';

export {
  JD_CHANNEL,
  JD_MODE_KEY,
  PDD_CHANNEL,
  QUOTED_AT,
  TB_CHANNEL,
  channel,
  jdItem,
  memoryRedis,
  observed,
  pddItem,
  position,
  rejection,
  tbItem,
};
export type { ChannelEntry };

/** The viewer's app of the search kit, so a wired ref passes the card entry's scope check. */
export const APP = 'synthetic-app';
/** The use case's fallback size (TRADE-20), not exported by search.ts. */
export const FALLBACK_LIMIT = 10;
export const DECOY_TITLE = 'synthetic-feed-decoy';

/** A synthetic whitelist; never a recorded channel. */
export const WHITELIST: readonly ChannelEntry[] = [
  channel('taobao', TB_CHANNEL),
  channel('jd', JD_CHANNEL),
  channel('pdd', PDD_CHANNEL),
];

/** B1-05n's options, on the wiring's type as it is before and after the implementation. */
type WiringOptions = UnionSearchUpstreamOptions & {
  readonly channels?: () => MaterialChannelsSpec;
  readonly logger?: Pick<RootLogger, 'warn'>;
};

const wire = createUnionSearchUpstream as (options: WiringOptions) => SearchUpstream;

export type FeedRequest = Parameters<SearchUpstream['materialFeed']>[0];

export function feedRequest(overrides: Partial<FeedRequest> = {}): FeedRequest {
  return {
    appId: APP,
    platform: 'taobao',
    channelId: TB_CHANNEL,
    limit: FALLBACK_LIMIT,
    promotionSlot: 'synthetic-query-pid',
    ...overrides,
  };
}

export function refOf(
  item: UnionItem,
  receivedAt: string,
  productKey: string,
  rawItemId: string,
): ProductRef {
  return {
    appId: APP,
    platform: item.platform,
    productKey,
    rawItemId,
    rawFetchedAt: item.quoted_at,
    receivedAt,
    canonicalUrl: null,
    title: item.title,
    shopId: null,
    shopType: null,
    source: 'search',
  };
}

const DECOYS: Readonly<Record<RegisteredPlatform, UnionItem>> = {
  taobao: tbItem('feed-decoy', 9001),
  jd: jdItem('feed-decoy', 9001),
  pdd: pddItem('feed-decoy', 9001),
};

export interface AdapterSetup {
  /** false leaves out channelRanking (an adapter without the capability). */
  readonly ranking?: boolean;
  /** false leaves out materialFeed. */
  readonly feed?: boolean;
}

/**
 * A call-recording adapter double of one platform. Search always answers an empty page, so a
 * first page reaches the fallback. materialFeed answers the decoy; channelRanking the set page.
 */
export function fakeAdapter(platform: RegisteredPlatform, setup: AdapterSetup = {}) {
  const rankingCalls: Call<ChannelRankingReq>[] = [];
  const state: {
    page: ChannelRankingPage;
    feedCalls: number;
    feedCursor: string | null;
    failure: { readonly error: unknown } | null;
  } = {
    page: { items: [], hasMore: false },
    feedCalls: 0,
    feedCursor: null,
    failure: null,
  };
  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`synthetic adapter: unexpected ${name}`);
  };
  const adapter: UnionAdapter = {
    platform,
    searchItems: async () => ({ items: [], nextCursor: null }),
    getItem: unexpected('getItem'),
    resolveLink: unexpected('resolveLink'),
    convert: unexpected('convert'),
    listOrders: unexpected('listOrders'),
    ...(setup.feed === false
      ? {}
      : {
          async materialFeed() {
            state.feedCalls += 1;
            return { items: [DECOYS[platform]], nextCursor: state.feedCursor };
          },
        }),
    ...(setup.ranking === false
      ? {}
      : {
          async channelRanking(req: ChannelRankingReq, ctx: CallCtx) {
            rankingCalls.push({ req, ctx });
            if (state.failure !== null) throw state.failure.error;
            return state.page;
          },
        }),
  };
  return {
    adapter,
    rankingCalls,
    feedCalls: () => state.feedCalls,
    setPage(page: ChannelRankingPage) {
      state.page = page;
    },
    setFeedCursor(cursor: string | null) {
      state.feedCursor = cursor;
    },
    fail(error: unknown) {
      state.failure = { error };
    },
  };
}

export type FakeAdapter = ReturnType<typeof fakeAdapter>;

export interface FixtureSetup {
  readonly whitelist?: readonly ChannelEntry[];
  readonly adapters?: Partial<Record<RegisteredPlatform, AdapterSetup>>;
}

/** The governed union, platform rows, config, clock, whitelist reader and warn logger, recorded. */
export function fixture(setup: FixtureSetup = {}) {
  const clock = new platform.FixedClock(NOW);
  let spec: MaterialChannelsSpec = {
    version: 'synthetic',
    channels: [...(setup.whitelist ?? WHITELIST)],
  };
  const fakes = new Map<RegisteredPlatform, FakeAdapter>(
    (['taobao', 'jd', 'pdd'] as const).map((code) => [
      code,
      fakeAdapter(code, setup.adapters?.[code]),
    ]),
  );
  const lookups: string[] = [];
  const union: GovernedUnion = {
    adapter(code: RegisteredPlatform): UnionAdapter {
      lookups.push(code);
      const found = fakes.get(code);
      if (found === undefined) throw new Error(`synthetic union: no adapter for ${code}`);
      return found.adapter;
    },
  };
  const rows = [platformRow('taobao', 'tb'), platformRow('jd', 'jd'), platformRow('pdd', 'pdd')];
  const settings = new Map<string, string | number>();
  const config: CatalogConfigReader = {
    configValue: async (_appId: string, key: string) =>
      settings.has(key) ? { value: settings.get(key)!, version: 1 } : null,
  };
  const warnings: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  };
  /** The shape of the frozen callers (test/spec/catalog/cache/kit.ts): no new option. */
  const frozen: UnionSearchUpstreamOptions = {
    union,
    catalog: { listPlatforms: async () => rows },
    config,
    clock,
    ledger: null,
  };
  const options: WiringOptions = { ...frozen, channels: () => spec, logger };
  return {
    clock,
    config,
    lookups,
    settings,
    warnings,
    fake(code: RegisteredPlatform): FakeAdapter {
      const found = fakes.get(code);
      if (found === undefined) throw new Error(`no fake adapter for ${code}`);
      return found;
    },
    setChannels(list: readonly ChannelEntry[]) {
      spec = { version: 'synthetic', channels: [...list] };
    },
    /** The object under test, as production builds it. */
    upstream(): SearchUpstream {
      return wire(options);
    },
    /** The object under test without the new options: platform's reader, no logger. */
    bareUpstream(): SearchUpstream {
      return wire(frozen);
    },
  };
}

export type Fixture = ReturnType<typeof fixture>;

/** The whitelist platform's getMaterialChannels answers: what the use case selects from. */
export function useCaseWhitelist(list: readonly ChannelEntry[]): void {
  vi.spyOn(platform, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic',
    channels: [...list],
  });
}

export interface FallbackSearchSetup {
  /** Redis of the page cache; without it cacheSearchUpstream reads the union directly. */
  readonly redis?: RedisNamespace;
}

/**
 * searchProducts over the wiring behind cacheSearchUpstream, with the search kit's viewer, sessions
 * and card entry. Only the use case's own warnings land in `warn`; the wiring's in f.warnings.
 */
export function fallbackSearch(f: Fixture, setup: FallbackSearchSetup = {}) {
  const search = searchFixture();
  const upstream = cacheSearchUpstream(f.upstream(), {
    redis: setup.redis ?? null,
    clock: f.clock,
    config: f.config,
  });
  const options = { ...search.options, upstream };
  return {
    warn: search.warn,
    quotes: search.quotes,
    register: search.register,
    run(query: Partial<SearchProductsQuery> = {}) {
      return searchProducts({ ...QUERY, ...query }, options);
    },
  };
}
