import { expect, it } from 'vitest';
import { mapTaobaoPrice } from '../../../../apps/api/src/modules/union/index.ts';
import { expectCalcDiff, expectPrice, now } from './kit.ts';

it.each(['商品券', '店铺券', '百亿补贴', '秒杀直降', '限时补贴', '限时优惠', '满元减', '满件折'])(
  '[AC-B1-04r-TIME#1] %s 的有效期为开始闭、结束开，过期和未开始整条作废',
  (title) => {
    const isCoupon = title === '商品券' || title === '店铺券';
    const input = {
      discount_fen: 3990n,
      promotion_final_fen: 3490n,
      promotions: [
        { title, amount_fen: 500n, id: 'demo-timed', start_ms: now, end_ms: now + 1000 },
      ],
    };
    for (const basis of ['promotion_path', 'coupon_only'] as const) {
      for (const time of [now - 1, now + 1000, now + 1001]) {
        expectCalcDiff(mapTaobaoPrice(input, time, { basis }), 'expired_item');
      }
      for (const time of [now, now + 999]) {
        const result = mapTaobaoPrice(input, time, { basis });
        if (isCoupon) expectPrice(result, 3990n, 500n, 3490n, 'demo-timed');
        else if (basis === 'coupon_only') expectPrice(result, 3990n, 0n, 3990n);
        else expectPrice(result, 3490n, 0n, 3490n);
        expect(result.warnings).toEqual([]);
      }
    }
  },
);

it('[AC-B1-04r-TIME#2] 不给起止时间按接口给出有效，单边时间约束仍生效', () => {
  for (const bounds of [{}, { start_ms: now }, { end_ms: now + 1 }]) {
    const result = mapTaobaoPrice(
      {
        discount_fen: 3990n,
        promotion_final_fen: 3490n,
        promotions: [{ title: '商品券', amount_fen: 500n, id: 'demo-time', ...bounds }],
      },
      now,
    );
    expectPrice(result, 3990n, 500n, 3490n, 'demo-time');
  }
  for (const bounds of [{ start_ms: now + 1 }, { end_ms: now }]) {
    const result = mapTaobaoPrice(
      {
        discount_fen: 3990n,
        promotion_final_fen: 3490n,
        promotions: [{ title: '商品券', amount_fen: 500n, id: 'demo-time', ...bounds }],
      },
      now,
    );
    expectCalcDiff(result, 'expired_item');
  }
});

it.each(['商品券', '百亿补贴', '88VIP', '演示未知'])(
  '[AC-B1-04r-TIME#3] 核对②：%s 的任一起止格式非法，不能忽略',
  (title) => {
    for (const field of ['start_ms', 'end_ms'] as const) {
      for (const value of ['', 'demo-time', Number.NaN, Number.POSITIVE_INFINITY, now + 0.5, {}]) {
        for (const basis of ['promotion_path', 'coupon_only'] as const) {
          const result = mapTaobaoPrice(
            {
              discount_fen: 3990n,
              promotion_final_fen: 3490n,
              promotions: [{ title, amount_fen: 500n, id: 'demo-time', [field]: value }],
            },
            now,
            { unknown_promo: 'count', basis },
          );
          expectCalcDiff(result, 'missing_field');
        }
      }
    }
  },
);

it('[AC-B1-04r-TIME#4] 已过期券混在仍有效明细中，不单独剔除后凑出价格', () => {
  const result = mapTaobaoPrice(
    {
      discount_fen: 3990n,
      promotion_final_fen: 2190n,
      promotions: [
        { title: '商品券', amount_fen: 500n, id: 'demo-expired', end_ms: now - 1 },
        { title: '店铺券', amount_fen: 300n, id: 'demo-valid', end_ms: now + 1 },
        { title: '百亿补贴', amount_fen: 1000n },
      ],
    },
    now,
  );
  expectCalcDiff(result, 'expired_item');
});

it('[AC-B1-04r-TIME#5] count 把未知项归平台立减后，同样核验有效期', () => {
  for (const bounds of [{ start_ms: now + 1 }, { end_ms: now }]) {
    const result = mapTaobaoPrice(
      {
        discount_fen: 3990n,
        promotion_final_fen: 3490n,
        promotions: [{ title: '演示未知', amount_fen: 500n, ...bounds }],
      },
      now,
      { unknown_promo: 'count' },
    );
    expectCalcDiff(result, 'expired_item');
    expect(result.warnings).toContainEqual({ code: 'PRICE_PROMO_UNKNOWN', title: '演示未知' });
  }
});
