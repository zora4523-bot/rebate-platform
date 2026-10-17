import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fc from 'fast-check';
import { propParams } from '@couli/testing';
import { createSearchProductsHandler } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import { candidate, card, context, fixture, keys } from './kit.ts';

it('[AC-B3-04b#1][BR-PROD-10][BR-AI-09] 平台开关与参数取交集，所有启用平台在任一结果返回前启动', async () => {
  const tb = candidate('tb:synthetic-a');
  const jd = candidate('jd:synthetic-a', 900, 'jd');
  const h = fixture([tb, jd]);
  h.settings.set('search.enabled.pdd', false);
  const bothStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const started: string[] = [];
  h.searchProducts.mockImplementation(async (query) => {
    started.push(query.platform);
    if (started.length === 2) bothStarted.resolve();
    await release.promise;
    return query.platform === 'taobao' ? [tb] : [jd];
  });
  // Construct outside any catch: the skeleton fails with NotImplemented, never a timeout.
  const handler = createSearchProductsHandler(h.deps);
  const running = handler.run({ q: '合成商品', platforms: ['taobao', 'jd', 'pdd'] }, context());
  try {
    await bothStarted.promise;
    expect(started.toSorted()).toEqual(['jd', 'taobao']);
  } finally {
    release.resolve();
  }
  expect(keys(await running)).toEqual(['jd:synthetic-a', 'tb:synthetic-a']);
  expect(h.searchProducts.mock.calls.map(([q]) => q.sort)).toEqual(['relevance', 'relevance']);
});

it('[AC-B3-04b#29][BR-AI-09] 复筛剔除商品后保留其余商品的原始上游名次', async () => {
  const h = fixture([
    candidate('tb:synthetic-filtered', 9000),
    candidate('tb:synthetic-rank2', 100),
    candidate('jd:synthetic-rank1', 500, 'jd'),
    candidate('jd:synthetic-rank2', 200, 'jd'),
  ]);
  expect(keys(await h.run({ q: '合成商品', price_max_fen: 1000 }))).toEqual([
    'jd:synthetic-rank1',
    'tb:synthetic-rank2',
    'jd:synthetic-rank2',
  ]);
});

it('[AC-B3-04b#30][BR-AI-09] 固定上游名次，随机佣金比例变化不影响 relevance', async () => {
  // Reach the skeleton outside fast-check too: first-red is its original NotImplemented.
  createSearchProductsHandler(fixture().deps);
  await fc.assert(
    fc.asyncProperty(
      fc.tuple(
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
      ),
      async (rates) => {
        const rows = [
          candidate('tb:synthetic-a', 700),
          candidate('tb:synthetic-b', 100),
          candidate('jd:synthetic-c', 700, 'jd'),
        ];
        const h = fixture(
          rows.map((row, index) => ({
            ...row,
            item: { ...row.item, commission_rate_bp: BigInt(rates[index]!) },
          })),
        );
        expect(keys(await h.run())).toEqual(['jd:synthetic-c', 'tb:synthetic-a', 'tb:synthetic-b']);
      },
    ),
    propParams(),
  );
});

it('[AC-B3-04b#2][BR-PROD-10] 未传 platforms 查开启集合；指定平台不扩展，缺配置默认关闭且每轮重读', async () => {
  const h = fixture([candidate('tb:synthetic-a')]);
  h.settings.delete('search.enabled.pdd');
  await h.run();
  expect(h.searchProducts.mock.calls.map(([q]) => q.platform).toSorted()).toEqual(['jd', 'taobao']);
  h.searchProducts.mockClear();
  h.settings.set('search.enabled.jd', false);
  await h.run({ q: '合成商品', platforms: ['jd', 'pdd'] });
  expect(h.searchProducts).not.toHaveBeenCalled();
  h.searchProducts.mockClear();
  await h.run({ q: '合成商品', platforms: ['taobao'] });
  expect(h.searchProducts.mock.calls.map(([q]) => q.platform)).toEqual(['taobao']);
  expect(h.configValue).toHaveBeenCalledWith('synthetic-app', 'search.enabled.taobao');
});

it('[AC-B3-04b#3][BR-AI-04] 一个平台失败不吞掉其他平台商品，不泄露上游错误', async () => {
  const tb = candidate('tb:synthetic-a');
  const pdd = candidate('pdd:synthetic-a', 800, 'pdd');
  const h = fixture([tb, pdd]);
  h.searchProducts.mockImplementation(async (query) => {
    if (query.platform === 'jd') throw new Error('synthetic-private-upstream-error');
    return query.platform === 'taobao' ? [tb] : [pdd];
  });
  const result = await h.run();
  expect(keys(result)).toEqual(['pdd:synthetic-a', 'tb:synthetic-a']);
  expect(h.registered.toSorted()).toEqual(['pdd:synthetic-a', 'tb:synthetic-a']);
  expect(JSON.stringify(result.modelView)).not.toContain('synthetic-private-upstream-error');
});

it('[AC-B3-04b#4][BR-AI-08] 价格复筛比较组卡到手价，闭区间保留两端、剔除上下界之外', async () => {
  const rows = [
    // BR-AI-08：券前价在区间内但到手价低于下界，必须剔除。
    candidate('tb:synthetic-low', 999, 'taobao', { price_fen: 1500n, coupon_fen: 501n }),
    // 到手价恰在两端，券前价却超过上界，必须保留；候选与卡片使用同一报价。
    candidate('tb:synthetic-min', 1000, 'taobao', { price_fen: 9000n, coupon_fen: 8000n }),
    candidate('jd:synthetic-max', 2000, 'jd', { price_fen: 3000n, coupon_fen: 1000n }),
    candidate('pdd:synthetic-high', 2001, 'pdd'),
  ];
  const h = fixture(rows);
  // 券前价不在区间，仍应保留；不能按券前价或预计净价筛选。
  h.quotes.set(rows[1]!.ref.productKey, card(rows[1]!, { est_net_price_fen: 900 }));
  const result = await h.run({ q: '合成商品', price_min_fen: 1000, price_max_fen: 2000 });
  expect(keys(result).toSorted()).toEqual(['jd:synthetic-max', 'tb:synthetic-min']);
  expect(h.registered.toSorted()).toEqual(['jd:synthetic-max', 'tb:synthetic-min']);
});

it('[AC-B3-04b#5][BR-AI-08] 相等上下界与单侧界限均按闭区间执行', async () => {
  const rows = [candidate('tb:synthetic-a', 1000), candidate('tb:synthetic-b', 2000)];
  const h = fixture(rows);
  expect(keys(await h.run({ q: '合成商品', price_min_fen: 1000, price_max_fen: 1000 }))).toEqual([
    'tb:synthetic-a',
  ]);
  expect(keys(await h.run({ q: '合成商品', price_min_fen: 2000 }))).toEqual(['tb:synthetic-b']);
  expect(keys(await h.run({ q: '合成商品', price_max_fen: 1000 }))).toEqual(['tb:synthetic-a']);
});

it('[AC-B3-04b#6][BR-AI-09] 相同 product_key 仅一张，同名同价但跨平台不同 key 均保留', async () => {
  const a = candidate('tb:synthetic-a');
  const b = candidate('jd:synthetic-a', 1000, 'jd');
  const h = fixture([a, a, { ...b, item: { ...b.item, title: a.item.title } }]);
  expect(keys(await h.run())).toEqual(['jd:synthetic-a', 'tb:synthetic-a']);
  expect(h.registered.toSorted()).toEqual(['jd:synthetic-a', 'tb:synthetic-a']);
});

it('[AC-B3-04b#7][BR-AI-09] relevance 按上游名次交错，同名次按到手价再按 key，默认 K=8', async () => {
  const h = fixture([
    // BR-AI-09：同名次的券前价次序与到手价 / key 次序相反。
    candidate('tb:synthetic-a1', 9000, 'taobao', { price_fen: 9500n, coupon_fen: 500n }),
    candidate('tb:synthetic-a2', 100),
    candidate('tb:synthetic-a3', 500, 'taobao', { price_fen: 700n, coupon_fen: 200n }),
    candidate('jd:synthetic-b1', 9000, 'jd', { price_fen: 10000n, coupon_fen: 1000n }),
    candidate('jd:synthetic-b2', 200, 'jd'),
    candidate('jd:synthetic-b3', 500, 'jd', { price_fen: 800n, coupon_fen: 300n }),
    candidate('pdd:synthetic-c1', 8000, 'pdd', { price_fen: 11000n, coupon_fen: 3000n }),
    candidate('pdd:synthetic-c2', 300, 'pdd'),
    candidate('pdd:synthetic-c3', 600, 'pdd'),
  ]);
  expect(keys(await h.run())).toEqual([
    'pdd:synthetic-c1',
    'jd:synthetic-b1',
    'tb:synthetic-a1',
    'tb:synthetic-a2',
    'jd:synthetic-b2',
    'pdd:synthetic-c2',
    'jd:synthetic-b3',
    'tb:synthetic-a3',
  ]);
  expect(h.registered).toHaveLength(8);
  expect(h.registered).not.toContain('pdd:synthetic-c3');
  for (const [query] of h.searchProducts.mock.calls) {
    expect(query).toMatchObject({ sort: 'relevance', limit: 8 });
  }
});

it('[AC-B3-04b#8][BR-AI-09] 每平台只取前 K 条，即使替身多返也不从 K 之后补货', async () => {
  const a = candidate('tb:synthetic-a', 900);
  const b = candidate('tb:synthetic-b', 800);
  const c = candidate('tb:synthetic-outside', 100);
  const h = fixture([a, b, c]);
  h.quotes.set(
    b.ref.productKey,
    card(b, { rebate_basis: 'no_rebate', rebate_min_fen: 0, rebate_max_fen: 0 }),
  );
  expect(keys(await h.run({ q: '合成商品', platforms: ['taobao'], limit: 2 }))).toEqual([
    'tb:synthetic-a',
  ]);
  expect(h.registered).not.toContain('tb:synthetic-outside');
  expect(h.searchProducts.mock.calls[0]?.[0]).toMatchObject({ sort: 'relevance', limit: 2 });
});

it('[AC-B3-04b#9][BR-AI-09] rebate_desc 依次比较返利下界、上界、到手价和 key', async () => {
  const rows = [
    candidate('tb:synthetic-a', 2000),
    candidate('tb:synthetic-b', 600),
    // BR-AI-09：返利上下界同值时，到手价升序与券前价升序相反。
    candidate('jd:synthetic-c', 800, 'jd', { price_fen: 1000n, coupon_fen: 200n }),
    candidate('jd:synthetic-d', 700, 'jd', { price_fen: 1100n, coupon_fen: 400n }),
    candidate('pdd:synthetic-e', 600, 'pdd', { price_fen: 1200n, coupon_fen: 600n }),
  ];
  const h = fixture(rows);
  const ranges = [
    [100, 900],
    [200, 300],
    [200, 400],
    [200, 400],
    [200, 400],
  ];
  rows.forEach((row, i) =>
    h.quotes.set(
      row.ref.productKey,
      card(row, {
        rebate_basis: 'price_compare_risk',
        rebate_min_fen: ranges[i]![0]!,
        rebate_max_fen: ranges[i]![1]!,
      }),
    ),
  );
  expect(keys(await h.run({ q: '合成商品', sort: 'rebate_desc' }))).toEqual([
    'pdd:synthetic-e',
    'jd:synthetic-d',
    'jd:synthetic-c',
    'tb:synthetic-b',
    'tb:synthetic-a',
  ]);
  // 到手价也相同时按 key，不能再比较券前价。
  const tied = fixture([
    candidate('tb:synthetic-z', 1000, 'taobao', { price_fen: 1500n, coupon_fen: 500n }),
    candidate('jd:synthetic-a', 1000, 'jd', { price_fen: 2000n, coupon_fen: 1000n }),
  ]);
  expect(keys(await tied.run({ q: '合成商品', sort: 'rebate_desc' }))).toEqual([
    'jd:synthetic-a',
    'tb:synthetic-z',
  ]);
});

it('[AC-B3-04b#10][BR-AI-09] final_price_asc 跨平台排序，同价按 key，与上游名次及返利无关', async () => {
  const h = fixture([
    candidate('tb:synthetic-z', 900),
    // BR-AI-09：到手价更低的商品券前价更高，同到手价时 key 仍优先。
    candidate('tb:synthetic-b', 100, 'taobao', { price_fen: 1000n, coupon_fen: 900n }),
    candidate('jd:synthetic-a', 100, 'jd', { price_fen: 1100n, coupon_fen: 1000n }),
  ]);
  expect(keys(await h.run({ q: '合成商品', sort: 'final_price_asc' }))).toEqual([
    'jd:synthetic-a',
    'tb:synthetic-b',
    'tb:synthetic-z',
  ]);
});

it('[AC-B3-04b#11][BR-AI-09] sales_desc 以销量降序，同销量按价格与 key', async () => {
  const h = fixture([
    { ...candidate('tb:synthetic-z', 100), sales: 1 },
    // BR-AI-09：同销量下，按到手价和 key 得到的次序与券前价次序相反。
    {
      ...candidate('tb:synthetic-b', 500, 'taobao', { price_fen: 1000n, coupon_fen: 500n }),
      sales: 30,
    },
    {
      ...candidate('jd:synthetic-a', 500, 'jd', { price_fen: 1100n, coupon_fen: 600n }),
      sales: 30,
    },
    { ...candidate('pdd:synthetic-c', 600, 'pdd'), sales: 30 },
  ]);
  expect(keys(await h.run({ q: '合成商品', sort: 'sales_desc' }))).toEqual([
    'jd:synthetic-a',
    'tb:synthetic-b',
    'pdd:synthetic-c',
    'tb:synthetic-z',
  ]);
});

it('[AC-B3-04b#12][BR-AI-09] relevance 不随佣金、返利或登录用户变化，也不自行从关键词猜排序', async () => {
  const rows = [
    candidate('tb:synthetic-a', 2000),
    candidate('tb:synthetic-b', 100),
    candidate('jd:synthetic-c', 2000, 'jd'),
  ];
  const expected = ['jd:synthetic-c', 'tb:synthetic-a', 'tb:synthetic-b'];
  const first = fixture(rows);
  expect(keys(await first.run({ q: '合成商品最划算' }))).toEqual(expected);
  const second = fixture(
    rows.map((row, i) => ({
      ...row,
      item: { ...row.item, commission_rate_bp: [9999n, 1n, 5000n][i]! },
    })),
  );
  rows.forEach((row, i) =>
    second.quotes.set(
      row.ref.productKey,
      card(row, {
        rebate_min_fen: [10, 90, 50][i]!,
        rebate_max_fen: [10, 90, 50][i]!,
      }),
    ),
  );
  expect(keys(await second.run({ q: '合成商品最划算' }, context('synthetic-other-user')))).toEqual(
    expected,
  );
  expect(keys(await second.run({ q: '合成商品返利最高', sort: 'relevance' }))).toEqual(expected);
});

it('[AC-B3-04b#13][BR-AI-08][BR-AI-09] 模型参数 schema 只接受四种排序及合法整数分，拒绝多余字段', () => {
  const handler = createSearchProductsHandler(fixture().deps);
  expect(handler.name).toBe('search_products');
  expect(handler.audience).toBe('all');
  // Reuse API's installed schema validator; the test workspace does not depend on ajv.
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
    Ajv2020: new (options: { strict: true }) => {
      compile(schema: unknown): (value: unknown) => boolean;
    };
  };
  const validate = new Ajv2020({ strict: true }).compile(handler.definition.parameters);
  for (const sort of ['relevance', 'rebate_desc', 'final_price_asc', 'sales_desc']) {
    expect(validate({ q: '合成商品', sort, price_min_fen: 1, price_max_fen: 10000000 })).toBe(true);
  }
  for (const price of [0, -1, 0.5, 10000001, '100']) {
    expect(validate({ q: '合成商品', price_min_fen: price })).toBe(false);
    expect(validate({ q: '合成商品', price_max_fen: price })).toBe(false);
  }
  expect(validate({ q: '合成商品', sort: 'commission_desc' })).toBe(false);
  expect(validate({ q: '合成商品', sort: '最划算' })).toBe(false);
  expect(validate({ q: '合成商品', unknown: true })).toBe(false);
  expect(validate({ q: '合成商品' })).toBe(true);
});
