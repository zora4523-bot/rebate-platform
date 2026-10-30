import { expect, it } from 'vitest';
import { FixedClock, type MaterialChannelsSpec } from '../../platform/index.ts';
import {
  UnionError,
  type CallCtx,
  type ChannelRankingReq,
  type UnionAdapter,
} from '../../union/index.ts';
import { CatalogError } from '../domain/rules.ts';
import type { GovernedUnion } from '../ports.ts';
import { createUnionHotRankUpstream } from './hot-rank-wiring.ts';

const APP = 'synthetic';
const CHANNEL = 'synthetic_ch';

function setup(selectable = true) {
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
      return { items: [], hasMore: false };
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
    catalog: { listPlatforms: async () => [] },
    config: { configValue: async () => null },
    clock: new FixedClock('2026-10-30T10:00:00.000Z'),
    channels: () => spec,
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
  });
  return { upstream, contexts, requests, warnings };
}

const page = { appId: APP, platform: 'taobao', channelId: CHANNEL, categoryId: null } as const;

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
