import { expect, it } from 'vitest';
import { FixedClock, type MaterialChannelsSpec } from '../../platform/index.ts';
import {
  UnionError,
  type CallCtx,
  type ChannelRankingEntry,
  type ChannelRankingReq,
  type UnionAdapter,
  type UnionItem,
} from '../../union/index.ts';
import { CatalogError } from '../domain/rules.ts';
import type { GovernedUnion } from '../ports.ts';
import { createUnionHotRankUpstream } from './hot-rank-wiring.ts';

const APP = 'synthetic';
const CHANNEL = 'synthetic_ch';

function setup(selectable = true, entries: readonly ChannelRankingEntry[] = []) {
  const contexts: CallCtx[] = [];
  const requests: ChannelRankingReq[] = [];
  const warnings: unknown[][] = [];
  const refuse = async (): Promise<never> => {
    throw new Error('unexpected');
  };
  const adapter: UnionAdapter = {
    platform: 'taobao',
    searchItems: refuse,
    getItem: refuse,
    resolveLink: refuse,
    convert: refuse,
    listOrders: refuse,
    async channelCategories(_req, ctx) {
      contexts.push(ctx);
      return [];
    },
    async channelRanking(req, ctx) {
      requests.push(req);
      contexts.push(ctx);
      return { items: entries, hasMore: false };
    },
  };
  const union: GovernedUnion = { adapter: () => adapter };
  const spec: MaterialChannelsSpec = {
    version: 'synthetic-1',
    channels: [
      {
        platform: 'taobao',
        channel_id: CHANNEL,
        name: '合成',
        sort_basis: 'sales',
        selectable,
        source: 'synthetic',
      },
    ],
  };
  const upstream = createUnionHotRankUpstream({
    union,
    catalog: {
      listPlatforms: async () => [
        {
          code: 'taobao',
          key_prefix: 'tb',
          key_stability: 'stable_24h',
          search_support: 'supported',
          convert_support: 'supported',
          order_sync_support: 'supported',
          stage: 'p0',
        },
      ],
    },
    config: { configValue: async () => null },
    clock: new FixedClock('2026-10-30T10:00:00.000Z'),
    channels: () => spec,
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
  });
  return { upstream, contexts, requests, warnings };
}

const page = { appId: APP, platform: 'taobao', channelId: CHANNEL, categoryId: null } as const;

function entry(itemId: string): ChannelRankingEntry {
  const item: UnionItem = {
    platform: 'taobao',
    item_id: itemId,
    title: 'synthetic',
    price_fen: 1000n,
    coupon_fen: 0n,
    final_price_fen: 1000n,
    commission_rate_bp: 1000n,
    quoted_at: '2026-10-30T09:00:00.000Z',
  };
  return { item, salesText: null };
}

it('[AC-B1-28j] 每次调用的 requestId 都是新的', async () => {
  const { upstream, contexts } = setup();
  await upstream.categories({ appId: APP, platform: 'taobao', channelId: CHANNEL });
  await upstream.page({ ...page, pageNo: 1, pageSize: 20 });
  expect(contexts).toHaveLength(2);
  expect(contexts[0]?.requestId).not.toBe(contexts[1]?.requestId);
});

it('[AC-B1-28j] 不可选频道只由 wiring 告警一次、抛 50304 rank_unavailable，联盟端口不再告警', async () => {
  const { upstream, contexts, warnings } = setup(false);
  const error = await upstream.page({ ...page, pageNo: 1, pageSize: 20 }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CatalogError);
  expect(error).toMatchObject({
    code: 50304,
    data: { platform: 'taobao', reason: 'rank_unavailable' },
  });
  expect(warnings).toHaveLength(1);
  expect(contexts).toHaveLength(0);
});

it('[AC-B1-28j] 越界的 pageSize 由联盟端口按 invalid_dto 拒绝，原样上抛、不调 adapter', async () => {
  const { upstream, requests } = setup();
  const error = await upstream.page({ ...page, pageNo: 1, pageSize: 51 }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UnionError);
  expect(error).toMatchObject({ code: 'invalid_dto' });
  expect(requests).toHaveLength(0);
});

it('[AC-B1-28l] 没有条目被丢的页不带 positions 键', async () => {
  const { upstream } = setup(true, [entry('synthetic-a-1'), entry('synthetic-b-2')]);
  const result = await upstream.page({ ...page, pageNo: 1, pageSize: 20 });
  expect(result.items).toHaveLength(2);
  expect('positions' in result).toBe(false);
});

it('[AC-B1-28l] 一页全被丢时 items 为空，也不带 positions 键', async () => {
  const { upstream } = setup(true, [entry(''), entry('')]);
  const result = await upstream.page({ ...page, pageNo: 1, pageSize: 20 });
  expect(result).toEqual({ items: [], hasMore: false });
  expect('positions' in result).toBe(false);
});

it('[AC-B1-28l] 有条目被丢时 positions 与 items 等长，取频道这一页里的下标', async () => {
  const { upstream } = setup(true, [entry(''), entry('synthetic-a-1'), entry('synthetic-b-2')]);
  const result = await upstream.page({ ...page, pageNo: 1, pageSize: 20 });
  expect(result.items).toHaveLength(2);
  expect(result.positions).toEqual([1, 2]);
});
