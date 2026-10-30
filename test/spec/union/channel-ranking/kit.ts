// B1-22p rule-test kit: the union material-channel ranking port (createUnionChannelRanking;
// BR-TEXT-17 细则「联盟物料频道」). Whitelist entries are synthetic and handed to the port as the
// `channels` reader; adapters are local call-recording doubles returning domain DTOs only. Platform
// channel, category and ranking capabilities (规划/09 CAP-TB-10, CAP-JD-10, CAP-PDD-10) are not
// recorded yet, so no platform payload, channel id or field name is imitated here.
import type { MaterialChannelsSpec } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createUnionChannelRanking,
  type CallCtx,
  type ChannelCategoriesReq,
  type ChannelRankingCategory,
  type ChannelRankingEntry,
  type ChannelRankingPage,
  type ChannelRankingPageInput,
  type ChannelRankingReq,
  type Platform,
  type UnionAdapter,
  type UnionChannelRanking,
  type UnionChannelRankingOptions,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';

export const NOW = '2026-10-30T02:00:00.000Z';
export const APP = 'synthetic-rank-app';
export const TB_CHANNEL = 'synthetic-tb-sales';
export const JD_CHANNEL = 'synthetic-jd-hot';
export const PDD_CHANNEL = 'synthetic-pdd-sales';
/** Carried in every CallCtx the fixture builds; must never reach a warning. */
export const SECRET = 'SYNTHETIC_SECRET_NOT_A_CREDENTIAL';
/** Task boundary (orchestrator brief for B1-22p): 1 ≤ pageSize ≤ 50, pageNo ≥ 1, integers. */
export const MAX_PAGE_SIZE = 50;
export const EMPTY_PAGE: ChannelRankingPage = { items: [], hasMore: false };

export type ChannelEntry = MaterialChannelsSpec['channels'][number];

/** A synthetic whitelist entry (selectable sales channel by default); never a recorded channel. */
export function channel(
  platform: Platform,
  channelId: string,
  overrides: Partial<ChannelEntry> = {},
): ChannelEntry {
  return {
    platform,
    channel_id: channelId,
    name: `合成频道 ${channelId}`,
    sort_basis: 'sales',
    selectable: true,
    source: 'synthetic fixture, not a CAP record',
    ...overrides,
  };
}

export interface ItemOptions {
  readonly platform?: Platform;
  readonly finalFen?: bigint;
  readonly commissionBp?: bigint;
}

/** A normalized union item titled `synthetic-<name>`. */
export function item(name: string, options: ItemOptions = {}): UnionItem {
  const final = options.finalFen ?? 1000n;
  return {
    platform: options.platform ?? 'taobao',
    item_id: `synthetic-${name}`,
    title: `synthetic-${name}`,
    price_fen: final,
    coupon_fen: 0n,
    final_price_fen: final,
    commission_rate_bp: options.commissionBp ?? 1000n,
    quoted_at: NOW,
  };
}

export function entry(
  name: string,
  salesText: string | null,
  options: ItemOptions = {},
): ChannelRankingEntry {
  return { item: item(name, options), salesText };
}

export interface Call<R> {
  readonly req: R;
  readonly ctx: CallCtx;
  /** `this` of the call: class adapters (demo, pdd) need their own instance. */
  readonly self: unknown;
}

/**
 * A call-recording adapter double. `withChannelMethods: false` leaves out channelCategories and
 * channelRanking (an adapter without the capability). Every other port refuses and is recorded.
 */
export function fakeAdapter(platform: Platform, withChannelMethods = true) {
  const categoryCalls: Call<ChannelCategoriesReq>[] = [];
  const rankingCalls: Call<ChannelRankingReq>[] = [];
  const otherCalls: string[] = [];
  const state: {
    categories: readonly ChannelRankingCategory[];
    page: ChannelRankingPage;
    failure: { readonly error: unknown } | null;
  } = {
    categories: [
      { categoryId: 'synthetic-cat-b', name: '合成类目 B' },
      { categoryId: 'synthetic-cat-a', name: '合成类目 A' },
    ],
    page: {
      items: [entry('first', '1.2万+', { platform }), entry('second', null, { platform })],
      hasMore: false,
    },
    failure: null,
  };
  const unexpected = (name: string) => async (): Promise<never> => {
    otherCalls.push(name);
    throw new Error(`synthetic adapter: unexpected ${name}`);
  };
  const base: UnionAdapter = {
    platform,
    searchItems: unexpected('searchItems'),
    getItem: unexpected('getItem'),
    resolveLink: unexpected('resolveLink'),
    convert: unexpected('convert'),
    listOrders: unexpected('listOrders'),
    materialFeed: unexpected('materialFeed'),
  };
  const adapter: UnionAdapter = withChannelMethods
    ? {
        ...base,
        async channelCategories(req, ctx) {
          categoryCalls.push({ req, ctx, self: this });
          if (state.failure !== null) throw state.failure.error;
          return state.categories;
        },
        async channelRanking(req, ctx) {
          rankingCalls.push({ req, ctx, self: this });
          if (state.failure !== null) throw state.failure.error;
          return state.page;
        },
      }
    : base;
  return {
    adapter,
    categoryCalls,
    rankingCalls,
    otherCalls,
    /** Channel calls of either method. */
    channelCalls: () => categoryCalls.length + rankingCalls.length,
    setCategories(list: readonly ChannelRankingCategory[]) {
      state.categories = list;
    },
    setPage(page: ChannelRankingPage) {
      state.page = page;
    },
    fail(error: unknown) {
      state.failure = { error };
    },
  };
}

export type FakeAdapter = ReturnType<typeof fakeAdapter>;

/** The CallCtx the fixture's callCtx builds; carries a synthetic secret header. */
export function ctxFor(appId: string, platform: Platform): CallCtx {
  return {
    appId,
    requestId: `synthetic-request-${platform}`,
    purpose: 'online',
    headers: { authorization: `Bearer ${SECRET}` },
  };
}

/** Port fixture: whitelist reader, adapter lookup, CallCtx builder and warn logger, all recorded. */
export function fixture(initial: readonly ChannelEntry[] = [channel('taobao', TB_CHANNEL)]) {
  let version = 1;
  let spec: MaterialChannelsSpec = { version: `synthetic-${version}`, channels: [...initial] };
  const fakes = new Map<Platform, FakeAdapter>(
    (['taobao', 'jd', 'pdd'] as const).map((platform) => [platform, fakeAdapter(platform)]),
  );
  const adapters = new Map<Platform, UnionAdapter>(
    [...fakes].map(([platform, fake]) => [platform, fake.adapter]),
  );
  const reads = { channels: 0 };
  const lookups: Platform[] = [];
  const contexts: { appId: string; platform: Platform }[] = [];
  const warnings: unknown[][] = [];
  const options: UnionChannelRankingOptions = {
    adapterFor: (platform) => {
      lookups.push(platform);
      return adapters.get(platform);
    },
    channels: () => {
      reads.channels += 1;
      return spec;
    },
    callCtx: (input) => {
      contexts.push({ appId: input.appId, platform: input.platform });
      return ctxFor(input.appId, input.platform);
    },
    logger: {
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
    },
  };
  return {
    options,
    reads,
    lookups,
    contexts,
    warnings,
    fake(platform: 'taobao' | 'jd' | 'pdd'): FakeAdapter {
      const found = fakes.get(platform);
      if (found === undefined) throw new Error(`no fake adapter for ${platform}`);
      return found;
    },
    /** Replace (or with undefined remove) the adapter the port gets for a platform. */
    setAdapter(platform: Platform, adapter: UnionAdapter | undefined) {
      if (adapter === undefined) adapters.delete(platform);
      else adapters.set(platform, adapter);
    },
    setChannels(list: readonly ChannelEntry[]) {
      version += 1;
      spec = { version: `synthetic-${version}`, channels: [...list] };
    },
    /** All channel calls over every fake adapter. */
    channelCalls(): number {
      return [...fakes.values()].reduce((sum, fake) => sum + fake.channelCalls(), 0);
    },
    port(): UnionChannelRanking {
      return createUnionChannelRanking(options);
    },
  };
}

export type Fixture = ReturnType<typeof fixture>;

export function pageInput(
  overrides: Partial<ChannelRankingPageInput> = {},
): ChannelRankingPageInput {
  return {
    appId: APP,
    platform: 'taobao',
    channelId: TB_CHANNEL,
    categoryId: null,
    pageNo: 1,
    pageSize: 20,
    ...overrides,
  };
}

/** The error an action ended with (a synchronous throw included); undefined when it resolved. */
export async function rejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

/** Everything a warning carried, as text (for "names the channel" / "no secret" checks). */
export function warningText(warnings: readonly unknown[][]): string {
  return JSON.stringify(warnings, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}
