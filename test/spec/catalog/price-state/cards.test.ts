import { expect, it } from 'vitest';
import { fixture, input, item, observed, PLATFORMS, QUOTED_AT } from './kit.ts';

it.each(PLATFORMS)(
  '[AC-B1-05i#5] BR-PRICE-03/17：$0 两类入口的有券/无券卡使用唯一且排首位的口径键',
  async (platform) => {
    for (const scene of ['retrieval', 'active_query'] as const) {
      for (const coupon of [true, false]) {
        const f = fixture();
        const request = input(
          item({
            platform,
            coupon_fen: coupon ? 2000n : 0n,
            final_price_fen: coupon ? 10000n : 12000n,
          }),
          scene,
        );
        const result = await observed(() => f.service.assemble(request));
        expect(result).toEqual({
          outcome: 'returned',
          value: {
            kind: 'card',
            card: expect.objectContaining({
              availability: 'ok',
              price_fen: 12000,
              coupon_fen: coupon ? 2000 : 0,
              final_price_fen: coupon ? 10000 : 12000,
              link_id: `synthetic-link:${request.ref.productKey}`,
              disclaimer_keys: [
                coupon ? 'price_basis' : 'price_basis.general',
                platform === 'taobao' ? 'rebate_compare' : 'rebate_estimate',
              ],
            }),
          },
        });
        expect(f.warn).not.toHaveBeenCalled();
        expect(f.register).toHaveBeenCalledTimes(1);
      }
    }
  },
);

it('[AC-B1-05i#6] BR-PRICE-12：带价卡登记沿用 item.coupon_ids 与取价快照，不新增平行券 ID 字段', async () => {
  const f = fixture();
  const value = item({
    price_status: 'ok',
    coupon_ids: 'synthetic-coupon-a,synthetic-coupon-b',
  });
  const request = input(value, 'active_query', 'parse');
  const result = await observed(() => f.service.assemble(request));
  expect(result).toEqual({
    outcome: 'returned',
    value: {
      kind: 'card',
      card: expect.objectContaining({
        price_fen: 12000,
        coupon_fen: 2000,
        final_price_fen: 10000,
        link_id: `synthetic-link:${request.ref.productKey}`,
        quoted_at: QUOTED_AT,
      }),
    },
  });
  expect(f.register).toHaveBeenCalledExactlyOnceWith({
    viewer: f.viewer,
    ref: request.ref,
    item: value,
    quote: {
      rebateMinFen: 211n,
      rebateMaxFen: 433n,
      estNetPriceFen: null,
      rebateBasis: 'price_compare_risk',
    },
    entrySource: 'parse',
  });
  expect(f.warn).not.toHaveBeenCalled();
});

it('[AC-B1-05i#7] BR-PRICE-01：一分券后价和一分无券售价都有效，不能过度过滤', async () => {
  for (const scene of ['retrieval', 'active_query'] as const) {
    for (const value of [
      item({ price_fen: 2n, coupon_fen: 1n, final_price_fen: 1n }),
      item({ price_status: 'ok', price_fen: 1n, coupon_fen: 0n, final_price_fen: 1n }),
    ]) {
      const f = fixture();
      f.quote.mockResolvedValue({
        rebateMinFen: 0n,
        rebateMaxFen: 0n,
        estNetPriceFen: null,
        rebateBasis: 'no_rebate',
      });
      const request = input(value, scene);
      const result = await observed(() => f.service.assemble(request));
      expect(result).toEqual({
        outcome: 'returned',
        value: {
          kind: 'card',
          card: expect.objectContaining({
            availability: 'ok',
            final_price_fen: 1,
            link_id: `synthetic-link:${request.ref.productKey}`,
            disclaimer_keys: [value.coupon_fen > 0n ? 'price_basis' : 'price_basis.general'],
          }),
        },
      });
      expect(f.warn).not.toHaveBeenCalled();
    }
  }
});

it('[AC-B1-05i#8] BR-PRICE-01/12：同一商品先有效、再异常、后恢复时不复用旧卡掩盖异常', async () => {
  const f = fixture();
  const request = input(item(), 'active_query');
  const first = await observed(() => f.service.assemble(request));
  expect(first).toMatchObject({ outcome: 'returned', value: { kind: 'card' } });
  const unavailable = await observed(() =>
    f.service.assemble({ ...request, item: item({ price_status: 'anomaly' }) }),
  );
  expect(unavailable).toEqual({ outcome: 'returned', value: { kind: 'price_unavailable' } });
  expect(f.register).toHaveBeenCalledTimes(1);

  f.register.mockResolvedValue({ linkId: 'synthetic-new-price-link' });
  const changed = item({ price_fen: 13000n, final_price_fen: 11000n });
  const restored = await observed(() => f.service.assemble({ ...request, item: changed }));
  expect(restored).toMatchObject({
    outcome: 'returned',
    value: {
      kind: 'card',
      card: {
        final_price_fen: 11000,
        link_id: 'synthetic-new-price-link',
      },
    },
  });
  expect(f.register).toHaveBeenCalledTimes(2);
  expect(f.register.mock.calls.map(([r]) => r.item.final_price_fen)).toEqual([10000n, 11000n]);
  expect(f.warn).toHaveBeenCalledTimes(1);
  expect(f.warn.mock.calls[0]?.[0]).toMatchObject({ code: 'PRICE_ANOMALY' });
});

it.each(['retrieval', 'active_query'] as const)(
  '[AC-B1-05i#9] BR-PRICE-12：$0 的 link 登记失败仍失败即关，不伪装价格异常或编造卡',
  async (scene) => {
    const f = fixture();
    const failure = new Error('synthetic link registration failure');
    f.register.mockRejectedValue(failure);
    const result = await observed(() => f.service.assemble(input(item(), scene)));
    expect(result).toEqual({ outcome: 'rejected', error: failure });
    expect(f.warn).not.toHaveBeenCalled();
  },
);
