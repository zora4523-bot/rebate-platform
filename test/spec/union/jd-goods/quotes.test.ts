import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { num } from '../jd-orders/kit.ts';
import {
  basePrice,
  both,
  coupon,
  ctx,
  itemRef,
  listing,
  mapped,
  method,
  otherItemId,
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

// D10-525：报价字段（priceInfo.price、券 discount、quota、lowestCouponPrice）的 JSON number
// 先转 String(n) 再交 parseYuanToFen，字符串形式的金额原样解析；commissionShare 不在此列，
// 仍按 BR-CALC-26 取原文、floor。
// 超过 2^31 的报价走同一口径；10^13 分以内补第三位小数也不到 16 位有效数字，经 String(n) 能准确往返。
const fen = fc.oneof(
  fc.bigInt({ min: 1n, max: 99_999_999n }),
  fc.bigInt({ min: 2_147_483_648n, max: 10_000_000_000_000n }),
);

/** One good without coupons, priced by `price`. */
function bare(price: unknown): Row {
  return row({ priceInfo: basePrice({ price }), couponInfo: undefined });
}

it.each<[string, bigint]>([
  ['39.900', 3990n],
  ['39.9000', 3990n],
  ['39.100', 3910n],
  ['0.100', 10n],
  ['100.000', 10000n],
])('[AC-B1-04zc#66] 报文数字 %s 按 String(n) 得 %s 分，末位 0 不算超两位', async (text, value) => {
  for (const item of await both(bare(num(text)))) {
    expect(item).toMatchObject({
      price_fen: value,
      coupon_fen: 0n,
      final_price_fen: value,
      price_status: 'ok',
    });
  }
});

it.each(['99.999', '39.9051', '0.001', '1e-7', '1e21', '1.5e300', '1e400'])(
  '[AC-B1-04zc#67] price %s 转 String(n) 后不是两位小数串：算缺失，不舍入，搜索不出卡',
  async (text) => {
    const input = withPrice(num(text));
    const searching = wire(() => listing([input, row({ itemId: otherItemId })]));
    const page = await searching.adapter.searchItems({ keyword: '合成关键词' }, ctx);
    expect(page.items.map((item) => item.item_id)).toEqual([otherItemId]);
    expect(warnings(searching.warn, 'PRICE_ANOMALY')).toHaveLength(1);
    const { adapter } = wire(() => listing([input]));
    expect(await adapter.getItem(itemRef, ctx)).toMatchObject({
      item_id: wholeItemId,
      price_status: 'anomaly',
      price_anomaly_reason: 'missing_field',
    });
  },
);

it.each<[string, bigint]>([
  ['39.90', 3990n],
  ['39.9', 3990n],
  ['39', 3900n],
])('[AC-B1-04zc#68] 字符串金额 %s 原样解析为 %s 分', async (text, value) => {
  for (const item of await both(bare(text))) {
    expect(item).toMatchObject({ price_fen: value, final_price_fen: value, price_status: 'ok' });
  }
});

it.each(['39.900', '39.905', '3.99e1', ' 39.90', '+39.90'])(
  '[AC-B1-04zc#69] 字符串金额 %j 不转 String(n)：parseYuanToFen 不收就算缺失',
  async (text) => {
    const { adapter } = wire(() => listing([withPrice(text)]));
    expect(await adapter.getItem(itemRef, ctx)).toMatchObject({
      item_id: wholeItemId,
      price_status: 'anomaly',
      price_anomaly_reason: 'missing_field',
    });
  },
);

const couponForms: readonly [string, Row, bigint][] = [
  ['discount 10.000 是 10 元', coupon({ discount: num('10.000') }), 1000n],
  ['quota 39.900 等于价格', coupon({ quota: num('39.900') }), 1000n],
  ['discount 字符串 10.00', coupon({ discount: '10.00' }), 1000n],
  ['quota 字符串 39.90', coupon({ quota: '39.90' }), 1000n],
  ['discount 10.999 的券跳过', coupon({ discount: num('10.999') }), 0n],
  ['quota 39.905 的券跳过', coupon({ quota: num('39.905') }), 0n],
  ['discount 1e21 的券跳过', coupon({ discount: num('1e21') }), 0n],
  ['quota 1e21 的券跳过', coupon({ quota: num('1e21') }), 0n],
  ['discount 字符串 10.000 的券跳过', coupon({ discount: '10.000' }), 0n],
];

it.each(couponForms)('[AC-B1-04zc#70] 券面额与门槛同口径：%s', async (_label, item, couponFen) => {
  for (const goods of await both(withCoupons([item]))) {
    expect(goods).toMatchObject({
      price_fen: 3990n,
      coupon_fen: couponFen,
      final_price_fen: 3990n - couponFen,
      price_status: 'ok',
    });
  }
});

it.each(['29.900', '29.9001', '1e21'])(
  '[AC-B1-04zc#71] lowestCouponPrice %s 按 String(n) 相等或视为缺失：不记 PRICE_CALC_DIFF',
  async (text) => {
    const input = row({ priceInfo: basePrice({ lowestCouponPrice: num(text) }) });
    const { adapter, warn } = wire(() => listing([input]));
    const page = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
    expect(page.items[0]).toMatchObject({ final_price_fen: 2990n, price_status: 'ok' });
    expect(warnings(warn, 'PRICE_CALC_DIFF')).toEqual([]);
  },
);

it('[AC-B1-04zc#72] lowestCouponPrice 29.910 按 String(n) 是 2991 分：差 1 分记 PRICE_CALC_DIFF', async () => {
  const input = row({ priceInfo: basePrice({ lowestCouponPrice: num('29.910') }) });
  const { adapter, warn } = wire(() => listing([input]));
  await adapter.searchItems({ keyword: '合成关键词' }, ctx);
  expect(warnings(warn, 'PRICE_CALC_DIFF')).toEqual([
    {
      method,
      code: 'PRICE_CALC_DIFF',
      item_id: wholeItemId,
      final_price_fen: 2990n,
      lowest_coupon_price_fen: 2991n,
    },
  ]);
});

it('[AC-B1-04zc#73] commissionShare 不走 String(n)：同一行 price 39.900 是 3990 分，比例 12.345 仍 floor', async () => {
  const input = row({
    priceInfo: basePrice({ price: num('39.900') }),
    commissionInfo: { commissionShare: num('12.345') },
  });
  expect(await searched(input)).toMatchObject({
    price_fen: 3990n,
    commission_rate_bp: 1234n,
    price_status: 'ok',
  });
});

it('[AC-B1-04zc#74] 任意两位小数报价补任意个末位 0：分值不变', () => {
  expect(() =>
    fc.assert(
      fc.property(fen, fc.integer({ min: 0, max: 4 }), (value, zeros) => {
        const item = mapped(bare(num(`${yuan(value)}${'0'.repeat(zeros)}`)));
        return item.price_status === 'ok' && item.price_fen === value;
      }),
      propParams(),
    ),
  ).not.toThrow();
});

it('[AC-B1-04zc#75] 任意两位小数报价后接非零数字：算缺失，不舍入', () => {
  expect(() =>
    fc.assert(
      fc.property(fen, fc.integer({ min: 1, max: 9 }), (value, digit) => {
        const item = mapped(bare(num(`${yuan(value)}${digit}`)));
        return item.price_status === 'anomaly' && item.price_anomaly_reason === 'missing_field';
      }),
      propParams(),
    ),
  ).not.toThrow();
});
