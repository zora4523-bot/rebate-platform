// What the port hands back and forwards (BR-TEXT-17 细则「联盟物料频道」: no commission or rebate
// weight in our layer; 热销榜名次按频道接口返回的顺序，本系统不重排): items and categories in the
// adapter's own order, salesText and hasMore as is, the adapter's errors as is; an adapter (or
// platform) without the capability is a union outage (UnionError upstream_unavailable).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type ChannelRankingPage,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  JD_CHANNEL,
  TB_CHANNEL,
  channel,
  ctxFor,
  entry,
  fakeAdapter,
  fixture,
  pageInput,
  rejection,
} from './kit.ts';

it('[AC-B1-22p#10][BR-TEXT-17] 榜单按适配器给的顺序原样返回：不按佣金、价格或销量重排，不去掉无销量项，salesText 与 hasMore 原样', async () => {
  const f = fixture();
  const port = f.port();
  const page: ChannelRankingPage = {
    items: [
      entry('low-commission', '10万+', { commissionBp: 10n, finalFen: 99_900n }),
      entry('no-sales', null, { commissionBp: 9_000n, finalFen: 100n }),
      entry('high-commission', '  月销 300 件 ', { commissionBp: 9_999n, finalFen: 5_000n }),
      entry('empty-sales', '', { commissionBp: 0n, finalFen: 1n }),
      entry('zero-commission', '1.2万+', { commissionBp: 0n, finalFen: 50_000n }),
    ],
    hasMore: true,
  };
  f.fake('taobao').setPage(page);
  const result = await port.page(pageInput());
  expect(result).toEqual(page);
  expect(result.items.map((position) => position.salesText)).toEqual([
    '10万+',
    null,
    '  月销 300 件 ',
    '',
    '1.2万+',
  ]);
  expect(result.hasMore).toBe(true);

  f.fake('taobao').setPage({ items: page.items.slice(0, 2), hasMore: false });
  const last = await port.page(pageInput({ pageNo: 2 }));
  expect(last.hasMore).toBe(false);
  expect(last.items.map((position) => position.item.title)).toEqual([
    'synthetic-low-commission',
    'synthetic-no-sales',
  ]);
});

it('[AC-B1-22p#11][BR-TEXT-17] 属性：任意佣金、价格与销量字段的一页，返回的位置顺序、商品与 salesText 与适配器逐项相同', async () => {
  const f = fixture();
  const port = f.port();
  const fake = f.fake('taobao');
  const position = fc.record({
    finalFen: fc.bigInt({ min: 1n, max: 100_000_000n }),
    commissionBp: fc.bigInt({ min: 0n, max: 10_000n }),
    salesText: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
  });
  await fc.assert(
    fc.asyncProperty(
      fc.array(position, { maxLength: 50 }),
      fc.boolean(),
      async (positions, hasMore) => {
        const page: ChannelRankingPage = {
          items: positions.map((p, index) =>
            entry(`p-${String(index)}`, p.salesText, {
              finalFen: p.finalFen,
              commissionBp: p.commissionBp,
            }),
          ),
          hasMore,
        };
        fake.setPage(page);
        fake.rankingCalls.length = 0;
        const result = await port.page(pageInput({ pageSize: Math.max(1, positions.length) }));
        expect(result).toEqual(page);
        expect(fake.rankingCalls).toHaveLength(1);
      },
    ),
    propParams(),
  );
});

it('[AC-B1-22p#12] 类目按适配器给的顺序与内容原样返回', async () => {
  const f = fixture();
  const port = f.port();
  const categories = [
    { categoryId: 'synthetic-z', name: '合成 Z' },
    { categoryId: 'synthetic-a', name: '合成 A' },
    { categoryId: 'synthetic-m', name: '合成 M' },
  ];
  f.fake('taobao').setCategories(categories);
  expect(await port.categories({ appId: APP, platform: 'taobao', channelId: TB_CHANNEL })).toEqual(
    categories,
  );
  expect(f.fake('taobao').categoryCalls[0]?.req).toEqual({ channelId: TB_CHANNEL });
});

it('[AC-B1-22p#13] 取数时按平台取适配器，用 callCtx({appId, platform}) 的上下文，以适配器自身为 this 调用', async () => {
  const f = fixture([channel('jd', JD_CHANNEL)]);
  const port = f.port();
  const fake = f.fake('jd');
  await port.categories({ appId: 'synthetic-other-app', platform: 'jd', channelId: JD_CHANNEL });
  await port.page(
    pageInput({ appId: 'synthetic-other-app', platform: 'jd', channelId: JD_CHANNEL }),
  );
  expect(f.lookups.every((platform) => platform === 'jd')).toBe(true);
  expect(f.lookups.length).toBeGreaterThanOrEqual(1);
  expect(f.contexts).toContainEqual({ appId: 'synthetic-other-app', platform: 'jd' });
  expect(f.contexts.every((c) => c.appId === 'synthetic-other-app' && c.platform === 'jd')).toBe(
    true,
  );
  const expectedCtx = ctxFor('synthetic-other-app', 'jd');
  expect(fake.categoryCalls).toHaveLength(1);
  expect(fake.categoryCalls[0]?.ctx).toEqual(expectedCtx);
  expect(fake.categoryCalls[0]?.self).toBe(fake.adapter);
  expect(fake.rankingCalls).toHaveLength(1);
  expect(fake.rankingCalls[0]?.ctx).toEqual(expectedCtx);
  expect(fake.rankingCalls[0]?.self).toBe(fake.adapter);
  expect(fake.otherCalls).toEqual([]);
  expect(f.fake('taobao').channelCalls() + f.fake('pdd').channelCalls()).toBe(0);
});

it('[AC-B1-22p#14] 白名单内的频道、适配器没有频道方法 → UnionError upstream_unavailable（带平台），不回空', async () => {
  const f = fixture([channel('jd', JD_CHANNEL)]);
  const bare = fakeAdapter('jd', false);
  f.setAdapter('jd', bare.adapter);
  const port = f.port();
  for (const action of [
    () => port.categories({ appId: APP, platform: 'jd', channelId: JD_CHANNEL }),
    () => port.page(pageInput({ platform: 'jd', channelId: JD_CHANNEL })),
  ]) {
    const error = await rejection(action);
    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: 'upstream_unavailable', platform: 'jd' });
  }
  expect(bare.otherCalls, 'no other port stands in for the channel').toEqual([]);
});

it('[AC-B1-22p#15] 白名单内的频道、平台没有适配器 → UnionError upstream_unavailable（带平台）', async () => {
  const f = fixture([channel('meituan', 'synthetic-meituan-sales')]);
  const port = f.port();
  for (const action of [
    () =>
      port.categories({ appId: APP, platform: 'meituan', channelId: 'synthetic-meituan-sales' }),
    () => port.page(pageInput({ platform: 'meituan', channelId: 'synthetic-meituan-sales' })),
  ]) {
    const error = await rejection(action);
    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: 'upstream_unavailable', platform: 'meituan' });
  }
});

const UNION_CODES: readonly UnionErrorCode[] = [
  'upstream_unavailable',
  'rate_limited',
  'upstream_rejected',
  'invalid_dto',
  'adapter_unimplemented',
];

it.each(UNION_CODES)(
  '[AC-B1-22p#16] 适配器抛 UnionError %s → 原样上抛同一个错误，不吞成空',
  async (code) => {
    const f = fixture();
    const port = f.port();
    const fake = f.fake('taobao');
    const failure = new UnionError(code, 'synthetic adapter failure', 'taobao');
    fake.fail(failure);
    expect(
      await rejection(() =>
        port.categories({ appId: APP, platform: 'taobao', channelId: TB_CHANNEL }),
      ),
    ).toBe(failure);
    expect(await rejection(() => port.page(pageInput()))).toBe(failure);
    expect(fake.categoryCalls).toHaveLength(1);
    expect(fake.rankingCalls).toHaveLength(1);
  },
);

it.each(['timeout', 'circuit_open', 'quota_exceeded'] as const)(
  '[AC-B1-22p#17] 治理层的 GovernanceError %s → 原样上抛，不吞成空',
  async (code) => {
    const f = fixture();
    const port = f.port();
    const failure = new GovernanceError(code, 'union:taobao:online', 'synthetic governance');
    f.fake('taobao').fail(failure);
    expect(await rejection(() => port.page(pageInput()))).toBe(failure);
    expect(
      await rejection(() =>
        port.categories({ appId: APP, platform: 'taobao', channelId: TB_CHANNEL }),
      ),
    ).toBe(failure);
  },
);
