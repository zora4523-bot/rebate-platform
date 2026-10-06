import { expect, it } from 'vitest';
import {
  mapTaobaoPrice,
  type TaobaoPriceInput,
} from '../../../../apps/api/src/modules/union/index.ts';
import { example, expectCalcDiff, expectPrice, now } from './kit.ts';

const invalidAmounts: readonly [string, unknown][] = [
  ['missing', undefined],
  ['null', null],
  ['empty', ''],
  ['nonnumeric', 'demo-invalid'],
  ['fractional-fen', '3990.5'],
  ['negative', -1n],
  ['nan', Number.NaN],
  ['infinity', Number.POSITIVE_INFINITY],
  ['unsafe-number', 9_007_199_254_740_992],
  ['outside-int64', 9_223_372_036_854_775_808n],
];

it.each(invalidAmounts)(
  '[AC-B1-04r-CHECK#1] 核对①：任一基准金额 %s 都按字段缺失失败，不能回退另一价格',
  (_label, value) => {
    for (const field of ['discount_fen', 'promotion_final_fen'] as const) {
      for (const basis of ['promotion_path', 'coupon_only'] as const) {
        const result = mapTaobaoPrice({ ...example, [field]: value }, now, { basis });
        expectCalcDiff(result, 'missing_field');
      }
    }
  },
);

it.each(invalidAmounts)(
  '[AC-B1-04r-CHECK#2] 核对②：任一分类金额 %s 均不能当零或略过',
  (_label, value) => {
    for (const title of ['商品券', '百亿补贴', '88VIP', '演示未知']) {
      for (const basis of ['promotion_path', 'coupon_only'] as const) {
        const result = mapTaobaoPrice(
          {
            discount_fen: 3990n,
            promotion_final_fen: 3990n,
            promotions: [{ title, amount_fen: value, id: 'demo-coupon' }],
          },
          now,
          { unknown_promo: 'count', basis },
        );
        expectCalcDiff(result, 'missing_field');
      }
    }
  },
);

it('[AC-B1-04r-CHECK#3] 核对①②：真正缺键也算字段缺失', () => {
  const cases: TaobaoPriceInput[] = [
    { promotion_final_fen: 3990n },
    { discount_fen: 3990n },
    {
      discount_fen: 3990n,
      promotion_final_fen: 3990n,
      promotions: [{ title: '商品券', id: 'demo-coupon' }],
    },
  ];
  for (const input of cases) expectCalcDiff(mapTaobaoPrice(input, now), 'missing_field');
});

it.each(['商品券', '店铺券'])('[AC-B1-04r-CHECK#4] 核对②：%s 缺 ID 时不按面额凑券串', (title) => {
  for (const promotion of [
    { title, amount_fen: 500n },
    { title, amount_fen: 500n, id: '' },
  ]) {
    for (const basis of ['promotion_path', 'coupon_only'] as const) {
      const result = mapTaobaoPrice(
        { discount_fen: 3990n, promotion_final_fen: 3490n, promotions: [promotion] },
        now,
        { basis },
      );
      expectCalcDiff(result, 'missing_field');
    }
  }
});

it.each(['promotion_path', 'coupon_only'] as const)(
  '[AC-B1-04r-CHECK#5] 核对③：basis=%s 非空明细必须全部对账，差一分也失败',
  (basis) => {
    for (const promotion_final_fen of [2364n, 2366n, 2490n, 3490n]) {
      expectCalcDiff(
        mapTaobaoPrice({ ...example, promotion_final_fen }, now, { basis }),
        'calc_diff',
      );
    }
    expectCalcDiff(
      mapTaobaoPrice(
        {
          discount_fen: 3990n,
          promotion_final_fen: 3390n,
          promotions: [{ title: '商品券', amount_fen: 500n, id: 'demo-coupon' }],
        },
        now,
        { basis },
      ),
      'calc_diff',
    );
  },
);

it.each(['unavailable', 'add_back', 'count'] as const)(
  '[AC-B1-04r-CHECK#6] 核对③：unknown_promo=%s 也不能跳过整份明细一致性检查',
  (unknown_promo) => {
    // Missing fields / inconsistent details are checked before accepting a calculated price.
    const result = mapTaobaoPrice(
      {
        discount_fen: 3990n,
        promotion_final_fen: 3489n,
        promotions: [
          { title: '店铺券', amount_fen: 300n, id: 'demo-store' },
          { title: '演示清单外', amount_fen: 200n },
        ],
      },
      now,
      { unknown_promo },
    );
    // Unknown-vs-mismatch precedence is unspecified; both must remain closed.
    expect(result).toMatchObject({
      price_status: 'anomaly',
      price_fen: 0n,
      coupon_fen: 0n,
      final_price_fen: 0n,
    });
    if (unknown_promo !== 'unavailable') expectCalcDiff(result, 'calc_diff');
  },
);

it.each(['promotion_path', 'coupon_only'] as const)(
  '[AC-B1-04r-CHECK#7] 核对④：basis=%s 空明细与未提供明细等价，两价相等才出价',
  (basis) => {
    for (const details of [{}, { promotions: [] }] as const) {
      const input = { discount_fen: 3990n, promotion_final_fen: 3990n, ...details };
      const valid = mapTaobaoPrice(input, now, { basis });
      expectPrice(valid, 3990n, 0n, 3990n);
      expect(valid.warnings).toEqual([]);
      for (const promotion_final_fen of [3490n, 3989n, 3991n]) {
        expectCalcDiff(
          mapTaobaoPrice({ ...input, promotion_final_fen }, now, { basis }),
          'calc_diff',
        );
      }
    }
  },
);

it.each(['promotion_path', 'coupon_only'] as const)(
  '[AC-B1-04r-CHECK#8] 核对⑤：basis=%s 算出的零售价或券等于券前价都不可出价',
  (basis) => {
    const cases: TaobaoPriceInput[] = [
      { discount_fen: 0n, promotion_final_fen: 0n },
      {
        discount_fen: 500n,
        promotion_final_fen: 0n,
        promotions: [{ title: '商品券', amount_fen: 500n, id: 'demo-free' }],
      },
    ];
    if (basis === 'promotion_path') {
      cases.push({
        discount_fen: 500n,
        promotion_final_fen: 0n,
        promotions: [{ title: '百亿补贴', amount_fen: 500n }],
      });
    }
    for (const input of cases) {
      expectCalcDiff(mapTaobaoPrice(input, now, { basis }), 'invalid_price');
    }
  },
);

it('[AC-B1-04r-CHECK#9] 核对顺序①→②→③→⑤，命中即停且不返回部分价格', () => {
  expectCalcDiff(
    mapTaobaoPrice({ discount_fen: 3990n, promotions: [{ title: '商品券' }] }, now),
    'missing_field',
  );
  expectCalcDiff(
    mapTaobaoPrice(
      { discount_fen: 3990n, promotion_final_fen: 0n, promotions: [{ title: '商品券' }] },
      now,
    ),
    'missing_field',
  );
  expectCalcDiff(mapTaobaoPrice({ ...example, promotion_final_fen: 0n }, now), 'calc_diff');
});

it('[AC-B1-04r-CHECK#10] 零到手价加回会员后可有效，一分券后价也可有效', () => {
  expectPrice(
    mapTaobaoPrice(
      {
        discount_fen: 500n,
        promotion_final_fen: 0n,
        promotions: [{ title: '88VIP', amount_fen: 500n }],
      },
      now,
    ),
    500n,
    0n,
    500n,
  );
  expectPrice(
    mapTaobaoPrice(
      {
        discount_fen: 501n,
        promotion_final_fen: 1n,
        promotions: [{ title: '商品券', amount_fen: 500n, id: 'demo-cent' }],
      },
      now,
    ),
    501n,
    500n,
    1n,
    'demo-cent',
  );
});
