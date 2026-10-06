import { expect, it } from 'vitest';
import {
  mapTaobaoPrice,
  type TaobaoPriceOptions,
} from '../../../../apps/api/src/modules/union/index.ts';
import { example, expectAnomaly, expectPrice, now } from './kit.ts';

it('[AC-B1-04r-MAP#1] 08 例表：3990 / 2365 加回会员项，券前价扣平台立减', () => {
  const result = mapTaobaoPrice(example, now);
  expectPrice(result, 2990n, 500n, 2490n, 'demo-coupon');
  expect(result.warnings).toEqual([]);
});

it.each([undefined, 'unavailable', 'add_back', 'count'] as const)(
  '[AC-B1-04r-MAP#2] 08 例表：清单外名称的 unknown_promo=%s',
  (unknown_promo) => {
    const result = mapTaobaoPrice(
      {
        discount_fen: 3990n,
        promotion_final_fen: 3490n,
        promotions: [
          { title: '店铺券', amount_fen: 300n, id: 'demo-store' },
          { title: '某个清单外的名称', amount_fen: 200n },
        ],
      },
      now,
      unknown_promo === undefined ? undefined : { unknown_promo },
    );
    if (unknown_promo === undefined || unknown_promo === 'unavailable') {
      expectAnomaly(result, 'unknown_promo');
    } else if (unknown_promo === 'add_back') {
      expectPrice(result, 3990n, 300n, 3690n, 'demo-store');
    } else {
      expectPrice(result, 3790n, 300n, 3490n, 'demo-store');
    }
    expect(result.warnings.filter((warning) => warning.code === 'PRICE_PROMO_UNKNOWN')).toEqual([
      { code: 'PRICE_PROMO_UNKNOWN', title: '某个清单外的名称' },
    ]);
  },
);

it.each(['百亿补贴', '秒杀直降', '限时补贴', '限时优惠', '满元减', '满件折'])(
  '[AC-B1-04r-MAP#3] 默认平台立减清单 %s，无券时售价等于到手价',
  (title) => {
    const result = mapTaobaoPrice(
      {
        discount_fen: 3990n,
        promotion_final_fen: 3190n,
        promotions: [{ title, amount_fen: 800n }],
      },
      now,
    );
    expectPrice(result, 3190n, 0n, 3190n);
    expect(result.warnings).toEqual([]);
  },
);

it.each(['promotion_path', 'coupon_only'] as const)(
  '[AC-B1-04r-MAP#4] %s 所有券累加，不选最大一张；券 ID 字典序且保留前导零',
  (basis) => {
    const result = mapTaobaoPrice(
      {
        discount_fen: 3990n,
        promotion_final_fen: 3090n,
        promotions: [
          { title: '商品券', amount_fen: 500n, id: 'demo-2' },
          { title: '店铺券', amount_fen: 300n, id: 'demo-10' },
          { title: '商品券', amount_fen: 100n, id: 'demo-01' },
        ],
      },
      now,
      { basis },
    );
    expectPrice(result, 3990n, 900n, 3090n, 'demo-01,demo-10,demo-2');
    expect(result.warnings).toEqual([]);
  },
);

it('[AC-B1-04r-MAP#5] 名称先 NFKC 再去首尾空白，会员关键词按包含匹配', () => {
  const result = mapTaobaoPrice(
    {
      ...example,
      promotions: [
        { title: '\u3000商品券\t', amount_fen: 500n, id: 'demo-coupon' },
        { title: ' 百亿补贴\n', amount_fen: 1000n },
        { title: '\u3000演示８８ＶＩＰ９．５折\t', amount_fen: 125n },
      ],
    },
    now,
  );
  expectPrice(result, 2990n, 500n, 2490n, 'demo-coupon');
  expect(result.warnings).toEqual([]);
});

it.each(['超级商品券', '店铺券附加', '百亿补贴附加', '普通会员折扣', '88vip折扣'])(
  '[AC-B1-04r-MAP#6] %s 不擅自扩大默认清单或做大小写折叠',
  (title) => {
    const result = mapTaobaoPrice(
      {
        discount_fen: 3990n,
        promotion_final_fen: 3890n,
        promotions: [{ title, amount_fen: 100n, id: 'demo-unknown' }],
      },
      now,
    );
    expectAnomaly(result, 'unknown_promo');
    expect(result.warnings).toContainEqual({ code: 'PRICE_PROMO_UNKNOWN', title });
  },
);

it('[AC-B1-04r-MAP#7] 参数替换三类清单，会员先于券，券先于平台立减', () => {
  const options: TaobaoPriceOptions = {
    member_title_keywords: ['演示会员'],
    coupon_titles: ['演示会员券', '演示券'],
    discount_titles: ['演示会员券', '演示券', '演示立减'],
  };
  const result = mapTaobaoPrice(
    {
      discount_fen: 3990n,
      promotion_final_fen: 2365n,
      promotions: [
        { title: '演示会员券', amount_fen: 125n },
        { title: '演示券', amount_fen: 500n, id: 'demo-custom' },
        { title: '演示立减', amount_fen: 1000n },
      ],
    },
    now,
    options,
  );
  expectPrice(result, 2990n, 500n, 2490n, 'demo-custom');
  expect(result.warnings).toEqual([]);
  const oldDefault = mapTaobaoPrice(example, now, options);
  expectAnomaly(oldDefault, 'unknown_promo');
});

it.each(['member_title_keywords', 'coupon_titles', 'discount_titles'] as const)(
  '[AC-B1-04r-MAP#8] 显式空清单 %s 不偷偷恢复默认值',
  (field) => {
    const result = mapTaobaoPrice(example, now, { [field]: [] });
    expectAnomaly(result, 'unknown_promo');
    expect(result.warnings.some((warning) => warning.code === 'PRICE_PROMO_UNKNOWN')).toBe(true);
  },
);

it.each([undefined, 'promotion_path', 'coupon_only'] as const)(
  '[AC-B1-04r-MAP#9] basis=%s：默认计平台立减，降级仅扣券',
  (basis) => {
    const result = mapTaobaoPrice(example, now, basis === undefined ? undefined : { basis });
    if (basis === 'coupon_only') {
      expectPrice(result, 3990n, 500n, 3490n, 'demo-coupon');
    } else {
      expectPrice(result, 2990n, 500n, 2490n, 'demo-coupon');
    }
    expect(result.warnings).toEqual([]);
  },
);

it.each(['unavailable', 'add_back', 'count'] as const)(
  '[AC-B1-04r-MAP#10] coupon_only 与 unknown_promo=%s 组合仍守分类门禁',
  (unknown_promo) => {
    const result = mapTaobaoPrice(
      {
        discount_fen: 3990n,
        promotion_final_fen: 3490n,
        promotions: [
          { title: '店铺券', amount_fen: 300n, id: 'demo-store' },
          { title: '演示清单外', amount_fen: 200n },
        ],
      },
      now,
      { basis: 'coupon_only', unknown_promo },
    );
    if (unknown_promo === 'unavailable') expectAnomaly(result, 'unknown_promo');
    else expectPrice(result, 3990n, 300n, 3690n, 'demo-store');
    expect(result.warnings).toContainEqual({ code: 'PRICE_PROMO_UNKNOWN', title: '演示清单外' });
  },
);

it('[AC-B1-04r-MAP#11] 每次出现未知项都返回只含名称的告警，重复名称不吞告警', () => {
  const input = {
    discount_fen: 3990n,
    promotion_final_fen: 3690n,
    promotions: [
      { title: '演示清单外', amount_fen: 100n, id: 'demo-private-a' },
      { title: '演示清单外', amount_fen: 200n, id: 'demo-private-b' },
    ],
  };
  for (const unknown_promo of ['unavailable', 'add_back', 'count'] as const) {
    for (let call = 0; call < 2; call++) {
      const result = mapTaobaoPrice(input, now, { unknown_promo });
      expect(result.warnings.filter((warning) => warning.code === 'PRICE_PROMO_UNKNOWN')).toEqual([
        { code: 'PRICE_PROMO_UNKNOWN', title: '演示清单外' },
        { code: 'PRICE_PROMO_UNKNOWN', title: '演示清单外' },
      ]);
      if (unknown_promo === 'unavailable') expectAnomaly(result, 'unknown_promo');
      else if (unknown_promo === 'add_back') expectPrice(result, 3990n, 0n, 3990n);
      else expectPrice(result, 3690n, 0n, 3690n);
    }
  }
});

it('[AC-B1-04r-MAP#12] bigint 大额超过安全整数仍精确到分，不走浮点或 JSON 数值', () => {
  const result = mapTaobaoPrice(
    {
      discount_fen: 9007199254740993n,
      promotion_final_fen: 9007199254740990n,
      promotions: [
        { title: '商品券', amount_fen: 1n, id: 'demo-cent' },
        { title: '百亿补贴', amount_fen: 1n },
        { title: '88VIP', amount_fen: 1n },
      ],
    },
    now,
  );
  expectPrice(result, 9007199254740992n, 1n, 9007199254740991n, 'demo-cent');
});

it('[AC-B1-04r-MAP#13] 不修改入参；明细顺序变化不影响价格、券串或下一次调用', () => {
  const promotions = Object.freeze([
    Object.freeze({ title: '店铺券', amount_fen: 300n, id: 'demo-z' }),
    Object.freeze({ title: '商品券', amount_fen: 500n, id: 'demo-a' }),
  ]);
  const input = Object.freeze({ discount_fen: 3990n, promotion_final_fen: 3190n, promotions });
  const options = Object.freeze({ coupon_titles: Object.freeze(['商品券', '店铺券']) });
  const result = mapTaobaoPrice(input, now, options);
  expectPrice(result, 3990n, 800n, 3190n, 'demo-a,demo-z');
  expect(mapTaobaoPrice({ ...input, promotions: [...promotions].reverse() }, now, options)).toEqual(
    result,
  );
  expect(mapTaobaoPrice(input, now, options)).toEqual(result);
  expect(promotions.map((item) => item.id)).toEqual(['demo-z', 'demo-a']);
});

it('[AC-B1-04r-MAP#14] 非券项即便带 ID，也不混入券串；默认会员优先于自定义券名', () => {
  const result = mapTaobaoPrice(
    {
      ...example,
      promotions: [
        { title: '商品券', amount_fen: 500n, id: 'demo-coupon' },
        { title: '百亿补贴', amount_fen: 1000n, id: 'demo-discount' },
        { title: '88VIP9.5折', amount_fen: 125n, id: 'demo-member' },
      ],
    },
    now,
    { coupon_titles: ['商品券', '88VIP9.5折'] },
  );
  expectPrice(result, 2990n, 500n, 2490n, 'demo-coupon');
  expect(result.warnings).toEqual([]);
});
