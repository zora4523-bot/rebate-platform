import { expect, it } from 'vitest';
import { isPriceAnomaly } from '../../../../apps/api/src/modules/union/domain/taobao-price.ts';
import type { UnionItem } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  couliItemId,
  dtkRow,
  expectTrueIdentities,
  expectWarned,
  noCouponRow,
  rowWithout,
  SEARCH_PATH,
  searchRows,
  type Row,
} from './kit.ts';

// BR-PRICE-01（D10-515 / D10-525），券前价口径按编排 D10-530：price_fen = actualPrice + couponPrice，
// coupon_fen = couponPrice（无券 0），final_price_fen = actualPrice（= price_fen − coupon_fen，恒等式必须
// 成立）；originalPrice 只存不进三价。元转分只经 parseYuanToFen：字符串原样、JSON number 先 String()。
// 进三价的金额（actualPrice / couponPrice）缺失 / 非法 → 价格异常（照样返回，三价 0，不出截断值，
// 告警 PRICE_ANOMALY）。#34–#36 的金额都让 originalPrice − couponPrice = actualPrice（自洽）；
// 不自洽的情形见 #38，originalPrice 本身不合格见 #43。

async function priced(row: Row) {
  const { h, page } = await searchRows([row]);
  expect(page.items).toHaveLength(1);
  return { h, item: page.items[0]! };
}

function expectOkPrice(item: UnionItem, price: bigint, coupon: bigint): void {
  expect(item.price_status).toBe('ok');
  expect(item.price_fen).toBe(price);
  expect(item.coupon_fen).toBe(coupon);
  expect(item.final_price_fen).toBe(price - coupon);
  expect(isPriceAnomaly(item)).toBe(false);
}

function expectAnomaly(item: UnionItem): void {
  expect(item.price_status).toBe('anomaly');
  expect(isPriceAnomaly(item)).toBe(true);
  // 不出截断值、不出部分价格。
  expect(item.price_fen).toBe(0n);
  expect(item.coupon_fen).toBe(0n);
  expect(item.final_price_fen).toBe(0n);
}

it.each([
  ['float + int 券', 59.9, 39.9, 20, 5990n, 2000n],
  ['两位小数 float', 19.99, 9.99, 10, 1999n, 1000n],
  ['int 价格', 60, 50, 10, 6000n, 1000n],
  ['大额', 1234567.89, 1234557.89, 10, 123456789n, 1000n],
  ['字符串金额', '59.90', '39.90', '20', 5990n, 2000n],
  ['字符串一位小数', '39.9', '29.9', '10', 3990n, 1000n],
  ['券面额 float', 30, 27.5, 2.5, 3000n, 250n],
] as [string, unknown, unknown, unknown, bigint, bigint][])(
  '[AC-B1-04zh#34] %s：originalPrice %s / actualPrice %s / couponPrice %s → price %s、coupon %s、final = price − coupon',
  async (_label, originalPrice, actualPrice, couponPrice, price, coupon) => {
    const { item } = await priced(dtkRow(1, { originalPrice, actualPrice, couponPrice }));
    expectOkPrice(item, price, coupon);
    expect(item.item_id).toBe(couliItemId(1));
  },
);

it('[AC-B1-04zh#35] 无券条目（couponPrice 0，无券链接 / 门槛）→ coupon_fen 0，final = price', async () => {
  const { item } = await priced(noCouponRow(2, { originalPrice: 25.8, actualPrice: 25.8 }));
  expectOkPrice(item, 2580n, 0n);
});

it('[AC-B1-04zh#36] JSON number 与同值字符串结果一致（number 先 String() 再解析，不经浮点运算）', async () => {
  const cents = [
    1, 7, 10, 99, 100, 101, 110, 1999, 3990, 4999, 10_001, 12_345, 99_999, 2_000_000, 99_999_999,
  ];
  const rows = cents.map((p, i) =>
    noCouponRow(i + 1, { originalPrice: p / 100, actualPrice: p / 100 }),
  );
  const { page } = await searchRows(rows);
  expect(expectTrueIdentities(page)).toEqual(cents.map((_p, i) => i + 1));
  page.items.forEach((item, i) => expectOkPrice(item, BigInt(cents[i]!), 0n));
});

it.each([
  ['actualPrice 三位小数', { actualPrice: 19.905 }],
  ['actualPrice 三位小数串', { actualPrice: '19.905' }],
  ['actualPrice 浮点误差', { actualPrice: 0.1 + 0.2 }],
  ['actualPrice 负数', { actualPrice: -1 }],
  ['actualPrice 负数串', { actualPrice: '-1' }],
  ['actualPrice 空串', { actualPrice: '' }],
  ['actualPrice 非数字串', { actualPrice: 'abc' }],
  ['actualPrice 带空白', { actualPrice: ' 39.9' }],
  ['actualPrice 指数', { actualPrice: 1e21 }],
  ['actualPrice 指数串', { actualPrice: '6e1' }],
  ['actualPrice null', { actualPrice: null }],
  ['actualPrice 布尔', { actualPrice: true }],
  ['couponPrice null', { couponPrice: null }],
  ['couponPrice 负数', { couponPrice: -5 }],
  ['couponPrice 非数字串', { couponPrice: 'x' }],
  ['couponPrice 三位小数', { couponPrice: 2.555 }],
] as [string, Row][])(
  '[AC-B1-04zh#37] %s → 价格异常：照样返回、三价 0（不截断）、price_anomaly_reason missing_field、告警 PRICE_ANOMALY',
  async (_label, overrides) => {
    const { h, item } = await priced(dtkRow(3, overrides));
    expectAnomaly(item);
    expect(item.price_anomaly_reason).toBe('missing_field');
    expect(item.item_id).toBe(couliItemId(3));
    expectWarned(h, 'PRICE_ANOMALY');
  },
);

it.each(['actualPrice', 'couponPrice'])(
  '[AC-B1-04zh#40] %s 缺失 → 价格异常（照样返回、三价 0、missing_field、告警 PRICE_ANOMALY）',
  async (key) => {
    const { h, item } = await priced(rowWithout(4, key));
    expectAnomaly(item);
    expect(item.price_anomaly_reason).toBe('missing_field');
    expectWarned(h, 'PRICE_ANOMALY');
  },
);

it.each([
  ['券等于售价', { originalPrice: 20, couponPrice: 20, actualPrice: 0 }],
  ['券高于售价', { originalPrice: 10, couponPrice: 15, actualPrice: 0 }],
  ['售价为 0', { originalPrice: 0, couponPrice: 0, actualPrice: 0 }],
] as [string, Row][])(
  '[AC-B1-04zh#39] %s → 触发 isPriceAnomaly 的基本条件：价格异常（照样返回、三价 0）',
  async (_label, overrides) => {
    const { item } = await priced(dtkRow(5, overrides));
    expectAnomaly(item);
    expect(item.item_id).toBe(couliItemId(5));
  },
);

it.each([
  ['平台券后价更低', 29.9, 4990n, 2990n],
  ['平台券后价更高', 49.9, 6990n, 4990n],
] as [string, number, bigint, bigint][])(
  '[AC-B1-04zh#38] originalPrice − couponPrice ≠ actualPrice（%s）→ 三价按 D10-530：price = actualPrice + couponPrice、final = actualPrice，originalPrice 不进三价',
  async (_label, actualPrice, price, final) => {
    const row = dtkRow(6, { originalPrice: 59.9, couponPrice: 20, actualPrice });
    const { h, item } = await priced(row);
    expectOkPrice(item, price, 2000n);
    expect(item.final_price_fen).toBe(final);
    expect(item.price_fen).not.toBe(5990n);
    expect(h.warn).not.toHaveBeenCalledWith({ method: SEARCH_PATH, code: 'PRICE_ANOMALY' });
  },
);

it.each([
  ['缺失', undefined],
  ['null', null],
  ['非数字串', 'abc'],
  ['三位小数', 59.905],
  ['负数', -1],
])(
  '[AC-B1-04zh#43] originalPrice %s → 不影响三价（只存不进三价，D10-530）：price = actualPrice + couponPrice，照常 ok',
  async (_label, originalPrice) => {
    const row =
      originalPrice === undefined ? rowWithout(7, 'originalPrice') : dtkRow(7, { originalPrice });
    const { h, item } = await priced(row);
    expectOkPrice(item, 5990n, 2000n);
    expect(item.final_price_fen).toBe(3990n);
    expect(item.item_id).toBe(couliItemId(7));
    expect(h.warn).not.toHaveBeenCalledWith({ method: SEARCH_PATH, code: 'PRICE_ANOMALY' });
  },
);
