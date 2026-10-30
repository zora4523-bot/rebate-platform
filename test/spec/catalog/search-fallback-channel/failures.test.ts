// B1-05n: failures keep the fallback's degradation (search.ts, AC-B1-05g#21). An adapter without
// channelRanking or a platform without an adapter is the port's UnionError upstream_unavailable and
// no longer CatalogError 30131; the use case swallows union and governance failures, so the search
// succeeds with an empty fallback and one alert, and a programming defect still fails it. The
// general material feed is no substitute for a channel the adapter cannot serve.
import { afterEach, expect, it, vi } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  TB_CHANNEL,
  WHITELIST,
  channel,
  fallbackSearch,
  feedRequest,
  fixture,
  observed,
  position,
  rejection,
  tbItem,
  useCaseWhitelist,
  type AdapterSetup,
} from './kit.ts';

afterEach(() => vi.restoreAllMocks());

it('[AC-B1-05n#17] adapter 没有 channelRanking：搜索仍成功，fallback_items 为空，不退回 materialFeed，告警 search_fallback_unavailable', async () => {
  useCaseWhitelist(WHITELIST);
  const f = fixture({ adapters: { taobao: { ranking: false } } });
  const search = fallbackSearch(f);

  const result = await search.run();

  expect(result).toEqual({ items: [], next_cursor: null, has_more: false, fallback_items: [] });
  expect(f.fake('taobao').feedCalls()).toBe(0);
  expect(search.warn).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      event: 'search_fallback_unavailable',
      platform: 'taobao',
      channel_id: TB_CHANNEL,
      error_code: 'upstream_unavailable',
    }),
    expect.any(String),
  );
});

it('[AC-B1-05n#18] adapter 没有 channelRanking（不论有无 materialFeed）：materialFeed 抛端口的 UnionError(upstream_unavailable)，不再是 CatalogError 30131', async () => {
  const setups: readonly AdapterSetup[] = [{ ranking: false }, { ranking: false, feed: false }];
  for (const taobao of setups) {
    const f = fixture({ adapters: { taobao } });

    const error = await rejection(() => f.upstream().materialFeed(feedRequest()));

    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: 'upstream_unavailable' });
    expect(f.fake('taobao').feedCalls()).toBe(0);
  }
});

it('[AC-B1-05n#19] 白名单里有可选频道但平台未登记联盟适配器：不向 GovernedUnion 要该平台，抛 UnionError(upstream_unavailable)', async () => {
  const f = fixture({ whitelist: [channel('meituan', 'synthetic_mt_sales')] });
  const upstream = f.upstream();

  const error = await rejection(() =>
    upstream.materialFeed(feedRequest({ platform: 'meituan', channelId: 'synthetic_mt_sales' })),
  );

  expect(error).toBeInstanceOf(UnionError);
  expect(error).toMatchObject({ code: 'upstream_unavailable' });
  expect(f.lookups).not.toContain('meituan');
});

const SWALLOWED = () => [
  {
    failure: new GovernanceError('timeout', 'union:taobao:online', 'synthetic timeout'),
    event: 'search_fallback_unavailable',
  },
  {
    failure: new GovernanceError('circuit_open', 'union:taobao:online', 'synthetic circuit open'),
    event: 'search_fallback_unavailable',
  },
  {
    failure: new GovernanceError('quota_exceeded', 'union:taobao:online', 'synthetic quota'),
    event: 'search_fallback_unavailable',
  },
  {
    failure: new UnionError('rate_limited', 'synthetic throttled', 'taobao'),
    event: 'search_fallback_unavailable',
  },
  {
    failure: new GovernanceError('invalid_policy', 'union:taobao:online', 'synthetic policy'),
    event: 'search_fallback_rejected',
  },
  {
    failure: new UnionError('upstream_rejected', 'synthetic refusal', 'taobao'),
    event: 'search_fallback_rejected',
  },
];

it('[AC-B1-05n#20] channelRanking 的治理与联盟失败原样上抛，用例按失败降级吞掉：搜索成功、fallback_items 为空、告警带频道', async () => {
  useCaseWhitelist(WHITELIST);
  for (const { failure, event } of SWALLOWED()) {
    const f = fixture();
    f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });
    f.fake('taobao').fail(failure);

    expect(await rejection(() => f.upstream().materialFeed(feedRequest()))).toBe(failure);

    const search = fallbackSearch(f);
    const result = await search.run();

    expect(result.fallback_items, event).toEqual([]);
    expect(f.fake('taobao').feedCalls(), event).toBe(0);
    expect(search.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event, platform: 'taobao', channel_id: TB_CHANNEL }),
      expect.any(String),
    );
  }
});

it('[AC-B1-05n#21] channelRanking 抛出的程序缺陷不被吞掉：搜索失败，原样传播', async () => {
  useCaseWhitelist(WHITELIST);
  const f = fixture();
  const defect = new TypeError('synthetic programming defect');
  f.fake('taobao').fail(defect);

  const result = await observed(() => fallbackSearch(f).run());

  // Compare only the discriminant first: red-check must see an assertion, not an uncaught defect.
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') expect(result.error).toBe(defect);
});
