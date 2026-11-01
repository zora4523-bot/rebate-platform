import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { num } from '../jd-orders/kit.ts';
import {
  basePrice,
  both,
  coupon,
  ctx,
  hourMs,
  itemRef,
  listing,
  mapped,
  method,
  ms,
  nowMs,
  otherItemId,
  picked,
  row,
  searched,
  warnings,
  wholeItemId,
  wire,
  withCoupons,
  withPrice,
  yuan,
  type Row,
} from './kit.ts';

// BR-PRICE-01 / 02，全部整数分：price_fen 只取 priceInfo.price，券自选，final_price_fen 一律自算。
const examples: readonly [string, readonly Row[], bigint, bigint][] = [
  ['10 元门槛 39', [coupon()], 1000n, 2990n],
  ['10 元门槛 50', [coupon({ quota: num('50') })], 0n, 3990n],
  ['已过期', [coupon({ useEndTime: ms(nowMs - 1) })], 0n, 3990n],
  ['未开始', [coupon({ useStartTime: ms(nowMs + 1) })], 0n, 3990n],
  ['门槛等于价格', [coupon({ quota: num('39.90') })], 1000n, 2990n],
  ['门槛高一分', [coupon({ quota: num('39.91') })], 0n, 3990n],
  ['门槛为 0 不是缺失', [coupon({ quota: num('0') })], 1000n, 2990n],
  [
    'A 10 元门槛 39、B 15 元门槛 50',
    [coupon(), coupon({ discount: num('15'), quota: num('50') })],
    1000n,
    2990n,
  ],
  [
    '两张都合格取面额大的',
    [coupon(), coupon({ discount: num('15'), quota: num('20') })],
    1500n,
    2490n,
  ],
  ['两张同面额', [coupon({ quota: num('30') }), coupon({ quota: num('20') })], 1000n, 2990n],
  [
    'isBest 指向小券时仍取大券',
    [coupon({ discount: num('5'), isBest: num('1') }), coupon({ isBest: num('0') })],
    1000n,
    2990n,
  ],
  ['isBest 指向不合格的券', [coupon({ quota: num('50'), isBest: num('1') })], 0n, 3990n],
  ['couponStatus -1 不可领取', [coupon({ couponStatus: num('-1') })], 0n, 3990n],
  [
    '不可领取的大券不挡合格的小券',
    [coupon({ discount: num('15'), couponStatus: num('-1') }), coupon()],
    1000n,
    2990n,
  ],
  ['couponStatus 缺失仍算候选', [coupon({ couponStatus: undefined })], 1000n, 2990n],
  ['couponStatus 其他值仍算候选', [coupon({ couponStatus: num('1') })], 1000n, 2990n],
  ['discount 缺失的券跳过', [coupon({ discount: undefined })], 0n, 3990n],
  ['quota 缺失的券跳过', [coupon({ quota: undefined })], 0n, 3990n],
  ['discount 为 null 的券跳过', [coupon({ discount: null })], 0n, 3990n],
  ['discount 超两位小数的券跳过', [coupon({ discount: num('10.005') })], 0n, 3990n],
  ['quota 为空串的券跳过', [coupon({ quota: '' })], 0n, 3990n],
  ['跳过的券不挡合格的券', [coupon({ discount: undefined }), coupon()], 1000n, 2990n],
  ['缺开始时间的券不算候选', [coupon({ useStartTime: undefined })], 0n, 3990n],
  ['缺结束时间的券不算候选', [coupon({ useEndTime: undefined })], 0n, 3990n],
  ['券列表为空', [], 0n, 3990n],
];

it.each(examples)(
  '[AC-B1-04zc#21] 价格 3990 分，%s：搜索与详情都按 BR-PRICE-01 选券',
  async (_label, coupons, couponFen, finalFen) => {
    for (const item of await both(withCoupons(coupons))) {
      expect(item).toMatchObject({
        price_fen: 3990n,
        coupon_fen: couponFen,
        final_price_fen: finalFen,
        price_status: 'ok',
      });
    }
  },
);

it('[AC-B1-04zc#22] 没有 couponInfo：券 0，券后等于券前，不是异常', async () => {
  for (const item of await both(row({ couponInfo: undefined }))) {
    expect(item).toMatchObject({
      price_fen: 3990n,
      coupon_fen: 0n,
      final_price_fen: 3990n,
      price_status: 'ok',
    });
  }
});

it.each<[string, bigint]>([
  ['39.9', 3990n],
  ['39.90', 3990n],
  ['39', 3900n],
  ['0.29', 29n],
  ['1.15', 115n],
  ['4.35', 435n],
  ['8.2', 820n],
  ['19.99', 1999n],
  ['123456789.12', 12345678912n],
  ['3.99e1', 3990n],
])('[AC-B1-04zc#23] 报文数字 %s 元按 String(n) 换算成 %s 分', async (text, fen) => {
  const input = row({ priceInfo: basePrice({ price: num(text) }), couponInfo: undefined });
  const item = await searched(input);
  expect(item).toMatchObject({ price_fen: fen, coupon_fen: 0n, final_price_fen: fen });
});

it('[AC-B1-04zc#24] 券后价在大额价格上也精确到分', async () => {
  const item = await searched(
    withCoupons([coupon({ discount: num('0.01'), quota: num('0') })], {
      priceInfo: basePrice({ price: num('123456789.12') }),
    }),
  );
  expect(item).toMatchObject({
    price_fen: 12345678912n,
    coupon_fen: 1n,
    final_price_fen: 12345678911n,
  });
});

it('[AC-B1-04zc#25] lowestPrice、lowestCouponPrice 不参与计算，取 priceInfo.price', async () => {
  const priceInfo = basePrice({ lowestPrice: num('1.00'), lowestCouponPrice: num('0.50') });
  const item = await searched(row({ priceInfo }));
  expect(item).toMatchObject({ price_fen: 3990n, coupon_fen: 1000n, final_price_fen: 2990n });
  expect(item.price_status).toBe('ok');
});

it('[AC-B1-04zc#26] 券时间与注入 Clock 比较：开始时刻包含、结束时刻排除，毫秒不提前失效', async () => {
  const input = withCoupons([
    coupon({ useStartTime: ms(nowMs + 1000), useEndTime: ms(nowMs + 2000) }),
  ]);
  const { adapter, clock } = wire(() => listing([input]));
  const couponNow = async (): Promise<bigint | undefined> =>
    (await adapter.searchItems({ keyword: '合成关键词' }, ctx)).items[0]?.coupon_fen;
  clock.advanceMs(999);
  expect(await couponNow()).toBe(0n);
  clock.advanceMs(1);
  expect(await couponNow()).toBe(1000n);
  clock.advanceMs(999);
  expect(await couponNow()).toBe(1000n);
  clock.advanceMs(1);
  expect(await couponNow()).toBe(0n);
});

it.each<[string, readonly Row[]]>([
  ['门槛低的在前', [coupon({ quota: num('20') }), coupon({ quota: num('30') })]],
  ['门槛低的在后', [coupon({ quota: num('30') }), coupon({ quota: num('20') })]],
  ['门槛低的在中间', [coupon({ quota: num('30') }), coupon({ quota: num('20') }), coupon()]],
])('[AC-B1-04zc#27] 两张同面额取门槛低的（%s）', (_label, coupons) => {
  expect(picked(coupons, 3990n)).toEqual({ discount_fen: 1000n, quota_fen: 2000n });
});

it('[AC-B1-04zc#28] 一张都不合格时选不出券', () => {
  expect(picked([coupon({ quota: num('50') })], 3990n)).toBeNull();
  expect(picked([], 3990n)).toBeNull();
});

it('[AC-B1-04zc#29] 选券的时刻与价格都取入参，不读别的来源', () => {
  const later = nowMs + hourMs;
  const coupons = [coupon({ useStartTime: ms(later), useEndTime: ms(later + hourMs) })];
  expect(picked(coupons, 3990n)).toBeNull();
  expect(picked(coupons, 3990n, later)).toEqual({ discount_fen: 1000n, quota_fen: 3900n });
  expect(picked(coupons, 3899n, later)).toBeNull();
});

const anomalies: readonly [string, Row, string][] = [
  ['priceInfo 缺失', row({ priceInfo: undefined }), 'missing_field'],
  ['price 缺失，lowestPrice 不顶替', withPrice(undefined), 'missing_field'],
  ['price 为 null', withPrice(null), 'missing_field'],
  ['price 空串', withPrice(''), 'missing_field'],
  ['price 非数字', withPrice('abc'), 'missing_field'],
  ['price 负数', withPrice(num('-39.90')), 'missing_field'],
  ['price 超两位小数，不舍入', withPrice(num('39.905')), 'missing_field'],
  ['price 转出指数写法', withPrice(num('1e21')), 'missing_field'],
  ['price 超出 int64', withPrice(num('92233720368547758.08')), 'missing_field'],
  ['price 为 0', withPrice(num('0')), 'invalid_price'],
  ['券等于价格', withCoupons([coupon({ discount: num('39.90') })]), 'invalid_price'],
  ['券大于价格', withCoupons([coupon({ discount: num('50'), quota: num('10') })]), 'invalid_price'],
];

it.each(anomalies)(
  '[AC-B1-04zc#30] 搜索遇%s：该商品不出卡，同页其他商品照常，记 PRICE_ANOMALY',
  async (_label, input) => {
    const { adapter, warn } = wire(() => listing([input, row({ itemId: otherItemId })]));
    const page = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
    expect(page.items.map((item) => item.item_id)).toEqual([otherItemId]);
    expect(warnings(warn, 'PRICE_ANOMALY')).toHaveLength(1);
  },
);

it.each(anomalies)(
  '[AC-B1-04zc#31] 详情遇%s：price_status=anomaly 且给出原因，不当 0 元，记 PRICE_ANOMALY',
  async (_label, input, reason) => {
    const { adapter, warn } = wire(() => listing([input]));
    const item = await adapter.getItem(itemRef, ctx);
    expect(item).toMatchObject({
      platform: 'jd',
      item_id: wholeItemId,
      price_status: 'anomaly',
      price_anomaly_reason: reason,
    });
    expect(warnings(warn, 'PRICE_ANOMALY')).toEqual([
      {
        method,
        code: 'PRICE_ANOMALY',
        item_id: wholeItemId,
        reason,
      },
    ]);
  },
);

it.each<[string, string, bigint]>([
  ['高一分', '29.91', 2991n],
  ['低一分', '29.89', 2989n],
  ['差很多', '10', 1000n],
])(
  '[AC-B1-04zc#32] lowestCouponPrice %s：记 PRICE_CALC_DIFF，只带商品标识与两个分值，不改结果',
  async (_label, text, lowestFen) => {
    const input = row({ priceInfo: basePrice({ lowestCouponPrice: num(text) }) });
    const { adapter, warn } = wire(() => listing([input]));
    const page = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
    expect(page.items[0]).toMatchObject({
      price_fen: 3990n,
      coupon_fen: 1000n,
      final_price_fen: 2990n,
      price_status: 'ok',
    });
    expect(warnings(warn, 'PRICE_CALC_DIFF')).toEqual([
      {
        method,
        code: 'PRICE_CALC_DIFF',
        item_id: wholeItemId,
        final_price_fen: 2990n,
        lowest_coupon_price_fen: lowestFen,
      },
    ]);
  },
);

it.each<[string, unknown]>([
  ['相等', num('29.90')],
  ['末位写法不同但相等', num('29.9')],
  ['缺失', undefined],
  ['为 null', null],
  ['超两位小数视为缺失', num('29.905')],
  ['空串视为缺失', ''],
])('[AC-B1-04zc#33] lowestCouponPrice %s：不记 PRICE_CALC_DIFF', async (_label, value) => {
  const input = row({ priceInfo: basePrice({ lowestCouponPrice: value }) });
  const { adapter, warn } = wire(() => listing([input]));
  const page = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
  expect(page.items[0]).toMatchObject({ final_price_fen: 2990n, price_status: 'ok' });
  expect(warnings(warn, 'PRICE_CALC_DIFF')).toEqual([]);
});

/** One coupon before it goes on the wire; absent means the field is missing from the report. */
interface Draft {
  readonly discount: bigint | undefined;
  readonly quota: bigint | undefined;
  readonly start: number;
  readonly end: number;
  readonly status: number | undefined;
  readonly best: boolean;
}

/** 超过 2^31 的金额：10^13 分以内的两位小数经 String(n) 能准确往返。 */
const wideFen = fc.bigInt({ min: 2_147_483_648n, max: 10_000_000_000_000n });

function amount(min: bigint): fc.Arbitrary<bigint> {
  return fc.oneof(fc.bigInt({ min, max: 6000n }), wideFen);
}

const offset = fc.constantFrom(-hourMs, -1, 0, 1, hourMs);
const draft: fc.Arbitrary<Draft> = fc.record({
  discount: fc.option(amount(1n), { nil: undefined }),
  quota: fc.option(amount(0n), { nil: undefined }),
  start: offset,
  end: offset,
  status: fc.constantFrom(-1, 0, 1, undefined),
  best: fc.boolean(),
});
const drafts = fc.array(draft, { maxLength: 6 });
const priceFen = amount(1n);

function onWire(item: Draft): Row {
  return coupon({
    discount: item.discount === undefined ? undefined : num(yuan(item.discount)),
    quota: item.quota === undefined ? undefined : num(yuan(item.quota)),
    useStartTime: ms(nowMs + item.start),
    useEndTime: ms(nowMs + item.end),
    couponStatus: item.status === undefined ? undefined : num(String(item.status)),
    isBest: num(item.best ? '1' : '0'),
  });
}

function eligible(item: Draft, price: bigint): boolean {
  return (
    item.discount !== undefined &&
    item.quota !== undefined &&
    item.status !== -1 &&
    item.start <= 0 &&
    0 < item.end &&
    price >= item.quota
  );
}

/** 手算的选券：合格券里面额最大，面额相同取门槛低的；isBest 不看。 */
function largest(list: readonly Draft[], price: bigint): Draft | undefined {
  let top: Draft | undefined;
  for (const item of list.filter((candidate) => eligible(candidate, price))) {
    const better =
      top === undefined ||
      item.discount! > top.discount! ||
      (item.discount === top.discount && item.quota! < top.quota!);
    if (better) top = item;
  }
  return top;
}

it('[AC-B1-04zc#34] 任意券列表：恒等式成立，所选券是合格券里面额最大的，券不小于价时出异常', () => {
  expect(() =>
    fc.assert(
      fc.property(priceFen, drafts, (price, list) => {
        const item = mapped(
          withCoupons(list.map(onWire), {
            priceInfo: basePrice({ price: num(yuan(price)) }),
          }),
        );
        const expected = largest(list, price)?.discount ?? 0n;
        if (expected >= price) return item.price_status === 'anomaly';
        return (
          item.price_status === 'ok' &&
          item.price_fen === price &&
          item.coupon_fen === expected &&
          item.final_price_fen === price - expected &&
          item.final_price_fen === item.price_fen - item.coupon_fen
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 60_000);

it('[AC-B1-04zc#35] 任意券列表：选中的就是手算的那张，面额相同时门槛低，isBest 不影响', () => {
  expect(() =>
    fc.assert(
      fc.property(priceFen, drafts, (price, list) => {
        const choice = picked(list.map(onWire), price);
        const top = largest(list, price);
        if (top === undefined) return choice === null;
        return choice?.discount_fen === top.discount && choice?.quota_fen === top.quota;
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 60_000);

it('[AC-B1-04zc#93] 价格 0 配任意券列表：一律 invalid_price，不当 0 元', () => {
  expect(() =>
    fc.assert(
      fc.property(drafts, (list) => {
        const item = mapped(
          withCoupons(list.map(onWire), { priceInfo: basePrice({ price: num(yuan(0n)) }) }),
        );
        return item.price_status === 'anomaly' && item.price_anomaly_reason === 'invalid_price';
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 60_000);
