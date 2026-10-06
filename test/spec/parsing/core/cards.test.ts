import { expect, it } from 'vitest';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { cards, fixture, item, NOW, QUOTED_AT, URL_A, URL_B } from './kit.ts';

it('[AC-B1-07a-CARD-ENTRY] 详情经主动查询入口出卡，金额及标题使用联盟数据', async () => {
  const f = fixture();
  const result = await f.run(URL_A);
  expect(cards(result)).toHaveLength(1);
  expect(f.getItem).toHaveBeenCalledTimes(1);
  expect(f.assemble).toHaveBeenCalledWith(
    expect.objectContaining({
      scene: 'active_query',
      entrySource: 'parse',
      stale: false,
      ref: expect.objectContaining({
        productKey: 'tb:a',
        rawItemId: 'synthetic-prefix-a',
        source: 'parse',
        rawFetchedAt: QUOTED_AT,
        receivedAt: NOW,
      }),
    }),
  );
  expect(cards(result)[0]).toMatchObject({
    price_fen: 12000,
    coupon_fen: 2000,
    final_price_fen: 10000,
    link_id: 'synthetic-link:tb:a',
  });
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B1-07a-NO-REBATE] 主动粘贴无返利仍出卡且使用无返利按钮', async () => {
  const f = fixture();
  f.quote.mockResolvedValue({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
  const result = await f.run(URL_A);
  expect(cards(result)).toHaveLength(1);
  expect(cards(result)[0]).toMatchObject({
    rebate_basis: 'no_rebate',
    rebate_min_fen: 0,
    rebate_max_fen: 0,
    cta: { text_key: 'btn.buy.no_rebate' },
  });
  expect(f.assemble).toHaveBeenCalledWith(expect.objectContaining({ scene: 'active_query' }));
  expect(f.convert).not.toHaveBeenCalled();
});

it.each([
  ['显式价格异常', { price_status: 'anomaly' }],
  ['缺少售价', { price_fen: undefined }],
  ['券等于售价', { coupon_fen: 12000n, final_price_fen: 0n }],
  ['券高于售价', { coupon_fen: 12001n, final_price_fen: -1n }],
  ['券后价为零', { final_price_fen: 0n }],
] as const)(
  '[AC-B1-07a-PRICE-UNAVAILABLE] %s保留带类型结果，不丢弃不下发金额或link_id',
  async (_name, patch) => {
    const f = fixture();
    f.getItem.mockImplementation(async (ref) => item(ref, patch as Partial<UnionItemDetail>));
    expect(await f.run(URL_A)).toEqual([
      {
        kind: 'price_unavailable',
        hit: { platform: 'taobao', kind: 'url', raw: URL_A },
        productKey: 'tb:a',
      },
    ]);
    expect(f.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ scene: 'active_query', entrySource: 'parse' }),
    );
    expect(f.register).not.toHaveBeenCalled();
    expect(f.quote).not.toHaveBeenCalled();
  },
);

it('[AC-B1-07a-MIXED-PRICE] 一个价格异常不吞掉同消息的正常卡', async () => {
  const f = fixture();
  f.getItem.mockImplementation(async (ref) =>
    item(ref, ref.platform === 'taobao' ? { price_status: 'anomaly' } : {}),
  );
  const results = await f.run(`${URL_A} ${URL_B}`);
  expect(results[0]).toMatchObject({ kind: 'price_unavailable', productKey: 'tb:a' });
  expect(cards(results).map((card) => card.product_key)).toEqual(['jd:i_b']);
  expect(f.register).toHaveBeenCalledTimes(1);
});

it('[AC-B1-07a-ORIGINAL-NOT-TARGET] 原推广URL仅是输入命中，不作为卡片打开目标或canonicalUrl', async () => {
  const f = fixture();
  const results = await f.run(URL_A);
  expect(results[0]?.hit?.raw).toBe(URL_A);
  expect(JSON.stringify(cards(results))).not.toContain(URL_A);
  expect(JSON.stringify(cards(results))).not.toContain('synthetic-promoter');
  const canonicalUrl = f.register.mock.calls[0]?.[0].ref.canonicalUrl;
  expect(canonicalUrl).not.toBe(URL_A);
  expect(canonicalUrl ?? '').not.toContain('synthetic-promoter');
  expect(f.convert).not.toHaveBeenCalled();
});
