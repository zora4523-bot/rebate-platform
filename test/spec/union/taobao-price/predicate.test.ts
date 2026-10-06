import { expect, it } from 'vitest';
import {
  isPriceAnomaly,
  mapTaobaoPrice,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import { example, now } from './kit.ts';

const valid = { price_fen: 3990n, coupon_fen: 500n, final_price_fen: 3490n };

it.each([
  ['missing-status', valid],
  ['explicit-ok', { ...valid, price_status: 'ok' as const }],
  ['no-coupon', { price_fen: 3990n, coupon_fen: 0n, final_price_fen: 3990n }],
  ['one-cent-final', { price_fen: 501n, coupon_fen: 500n, final_price_fen: 1n }],
])('[AC-B1-04r-STATUS#1] %s 的有效三字段不判异常，缺省状态视同 ok', (_label, item) => {
  expect(isPriceAnomaly(item)).toBe(false);
});

it.each([
  ['zero-price', { price_fen: 0n, coupon_fen: 0n, final_price_fen: 0n }],
  ['negative-price', { price_fen: -1n, coupon_fen: 0n, final_price_fen: -1n }],
  ['negative-coupon', { price_fen: 3990n, coupon_fen: -1n, final_price_fen: 3991n }],
  ['equal-coupon', { price_fen: 3990n, coupon_fen: 3990n, final_price_fen: 0n }],
  ['larger-coupon', { price_fen: 3990n, coupon_fen: 3991n, final_price_fen: -1n }],
  ['zero-final', { ...valid, final_price_fen: 0n }],
  ['negative-final', { ...valid, final_price_fen: -1n }],
  ['one-cent-diff', { ...valid, final_price_fen: 3489n }],
])('[AC-B1-04r-STATUS#2] %s 不满足基本校验，标 ok 也不能绕过', (_label, item) => {
  expect(isPriceAnomaly(item)).toBe(true);
  expect(isPriceAnomaly({ ...item, price_status: 'ok' })).toBe(true);
});

it('[AC-B1-04r-STATUS#3] 显式 anomaly 即使三字段看起来正常，也不可作为价格使用', () => {
  const item: UnionItem = {
    platform: 'taobao',
    item_id: 'demo-status',
    title: '演示商品',
    ...valid,
    commission_rate_bp: 100n,
    quoted_at: '2030-03-17T17:46:40.000Z',
    coupon_ids: 'demo-coupon',
    price_status: 'anomaly',
    price_anomaly_reason: 'calc_diff',
  };
  expect(isPriceAnomaly(item)).toBe(true);
});

it('[AC-B1-04r-STATUS#4] 同一公开判定接受纯函数输出，正常为 false、异常为 true', () => {
  expect(isPriceAnomaly(mapTaobaoPrice(example, now))).toBe(false);
  expect(isPriceAnomaly(mapTaobaoPrice({ ...example, promotion_final_fen: 2364n }, now))).toBe(
    true,
  );
});
