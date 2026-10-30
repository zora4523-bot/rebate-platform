// B1-28j: failures of union's ranking port keep B1-28h's mapping. An adapter without the channel
// methods or a platform without an adapter is a union outage (UnionError upstream_unavailable), an
// adapter's governance failure (timeout, open breaker) propagates unchanged; getHotRank answers
// both with 50304 and no data.reason (retry later), never rank_unavailable.
import { expect, it } from 'vitest';
import { CatalogError } from '../../../../apps/api/src/modules/catalog/domain/rules.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  TB_CHANNEL,
  channel,
  dataOf,
  fixture,
  hotRank,
  pageRequest,
  position,
  rejection,
  tbItem,
} from './kit.ts';

function expectOutage(error: unknown, platform: string): void {
  expect(error).toBeInstanceOf(CatalogError);
  expect(error).toMatchObject({ code: 50304 });
  expect(dataOf(error)).toMatchObject({ platform });
  expect(dataOf(error)).not.toHaveProperty('reason');
}

it('[AC-B1-28j#13] adapter 没有 channelCategories：categories 抛 UnionError(upstream_unavailable)，接口 50304 且无 reason', async () => {
  const f = fixture({ adapters: { taobao: { categories: false } } });
  const upstream = f.upstream();

  const direct = await rejection(() =>
    upstream.categories({ appId: APP, platform: 'taobao', channelId: TB_CHANNEL }),
  );
  expect(direct).toBeInstanceOf(UnionError);
  expect(direct).toMatchObject({ code: 'upstream_unavailable' });

  const error = await rejection(() => hotRank(f)());
  expectOutage(error, 'taobao');
  expect(f.fake('taobao').rankingCalls).toHaveLength(0);
});

it('[AC-B1-28j#14] adapter 有 channelCategories、没有 channelRanking：page 抛 UnionError(upstream_unavailable)，接口 50304 且无 reason', async () => {
  const f = fixture({ adapters: { taobao: { ranking: false } } });
  const upstream = f.upstream();

  const direct = await rejection(() => upstream.page(pageRequest()));
  expect(direct).toBeInstanceOf(UnionError);
  expect(direct).toMatchObject({ code: 'upstream_unavailable' });

  const error = await rejection(() => hotRank(f)());
  expectOutage(error, 'taobao');
});

it('[AC-B1-28j#15] 白名单里有可选频道但平台未登记联盟适配器：不向 GovernedUnion 要该平台，categories / page 抛 UnionError(upstream_unavailable)，接口 50304 且无 reason', async () => {
  const f = fixture({
    whitelist: [channel('taobao', TB_CHANNEL), channel('meituan', 'synthetic_mt_sales')],
  });
  const upstream = f.upstream();

  const categories = await rejection(() =>
    upstream.categories({ appId: APP, platform: 'meituan', channelId: 'synthetic_mt_sales' }),
  );
  const page = await rejection(() =>
    upstream.page(pageRequest({ platform: 'meituan', channelId: 'synthetic_mt_sales' })),
  );
  for (const error of [categories, page]) {
    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: 'upstream_unavailable' });
  }

  const error = await rejection(() => hotRank(f)({ platform: 'meituan' }));
  expectOutage(error, 'meituan');
  expect(f.lookups).not.toContain('meituan');
  expect(f.channelCalls()).toBe(0);
});

const GOVERNANCE_FAILURES = () => [
  new GovernanceError('timeout', 'union:taobao:online', 'synthetic timeout'),
  new GovernanceError('circuit_open', 'union:taobao:online', 'synthetic circuit open'),
];

it('[AC-B1-28j#16] adapter 抛的 GovernanceError（超时、熔断）由 categories / page 原样上抛，接口 50304 且无 reason', async () => {
  for (const failure of GOVERNANCE_FAILURES()) {
    const f = fixture();
    f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });
    f.fake('taobao').fail(failure);
    const upstream = f.upstream();

    expect(
      await rejection(() =>
        upstream.categories({ appId: APP, platform: 'taobao', channelId: TB_CHANNEL }),
      ),
    ).toBe(failure);
    expect(await rejection(() => upstream.page(pageRequest()))).toBe(failure);

    const error = await rejection(() => hotRank(f)());
    expectOutage(error, 'taobao');
  }
});

it('[AC-B1-28j#17] 类目取到、榜单那一步无能力时仍是 50304 无 reason，不拿通用物料流或搜索冒充频道榜单', async () => {
  const f = fixture({ adapters: { taobao: { ranking: false } } });
  f.fake('taobao').setCategories([{ categoryId: 'synthetic-cat', name: '合成类目' }]);

  const error = await rejection(() => hotRank(f)());

  expectOutage(error, 'taobao');
  expect(f.fake('taobao').categoryCalls).toHaveLength(1);
  expect(f.fake('taobao').otherCalls).toEqual([]);
});
