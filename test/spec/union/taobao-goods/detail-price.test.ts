import { expect, it } from 'vitest';
import {
  ctx,
  DAY_MS,
  detailRow,
  detailSetup,
  ITEM_ID,
  nowMs,
  priceReader,
  promotion,
  ref,
} from './kit.ts';

it('[AC-B1-04l#13] 价格经 mapTaobaoPrice：折扣价、券、会员项加回（BR-PRICE-02 默认配置）', async () => {
  const { adapter } = detailSetup();
  const detail = await adapter.getItem(ref, ctx);
  // 59.90 − 10.00（商品券）− 5.00（88VIP）= 44.90；会员项加回 → 到手 49.90，券前 59.90。
  expect(detail).toMatchObject({
    platform: 'taobao',
    item_id: ITEM_ID,
    price_fen: 5990n,
    coupon_fen: 1000n,
    final_price_fen: 4990n,
    coupon_ids: 'syn-coupon-0001',
    price_status: 'ok',
  });
  expect(detail).not.toHaveProperty('price_anomaly_reason');
});

it.each([
  { zk: '19.99', fee: '3.33', final: '16.66', price: 1999n, coupon: 333n },
  { zk: '0.10', fee: '0.01', final: '0.09', price: 10n, coupon: 1n },
  { zk: '123456789.01', fee: '0.02', final: '123456788.99', price: 12345678901n, coupon: 2n },
  { zk: '7', fee: '2.5', final: '4.5', price: 700n, coupon: 250n },
])(
  '[AC-B1-04l#14] 元串精确转分（$zk − $fee = $final），不经浮点',
  async ({ zk, fee, final, price, coupon }) => {
    const row = detailRow({
      price: { zk_final_price: zk, final_promotion_price: final },
      promotions: [promotion('店铺券', fee, 'syn-coupon-0002')],
    });
    const { adapter } = detailSetup([row]);
    const detail = await adapter.getItem(ref, ctx);
    expect(detail).toMatchObject({
      price_fen: price,
      coupon_fen: coupon,
      final_price_fen: price - coupon,
      coupon_ids: 'syn-coupon-0002',
      price_status: 'ok',
    });
  },
);

it('[AC-B1-04l#15] reserve_price 不是价格依据；没有优惠明细且折扣价等于最终价时券为 0', async () => {
  const row = detailRow({
    price: {
      zk_final_price: '30.00',
      final_promotion_price: '30.00',
      reserve_price: '88.00',
      final_promotion_path_list: undefined,
    },
  });
  const { adapter } = detailSetup([row]);
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({
    price_fen: 3000n,
    coupon_fen: 0n,
    final_price_fen: 3000n,
    price_status: 'ok',
  });
  expect(detail).not.toHaveProperty('coupon_ids');
});

it('[AC-B1-04l#16] 优惠时间是 13 位毫秒串、按注入时钟判断：已过期的券 → expired_item 异常，三价为 0', async () => {
  const expired = promotion('商品券', '10.00', 'syn-coupon-0001', {
    promotion_start_time: String(nowMs - 2 * DAY_MS),
    promotion_end_time: String(nowMs - 1000),
  });
  const member = promotion('88VIP', '5.00', 'syn-member-0001');
  const { adapter } = detailSetup([detailRow({ promotions: [expired, member] })]);
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({
    platform: 'taobao',
    item_id: ITEM_ID,
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: 'expired_item',
  });
});

it('[AC-B1-04l#17] 明细与最终价对不上 → calc_diff；未登记的优惠名称（默认 unavailable）→ unknown_promo', async () => {
  const diff = detailSetup([detailRow({ price: { final_promotion_price: '44.89' } })]);
  expect(await diff.adapter.getItem(ref, ctx)).toMatchObject({
    price_status: 'anomaly',
    price_anomaly_reason: 'calc_diff',
  });
  const unknownRow = detailRow({
    price: { final_promotion_price: '54.90' },
    promotions: [promotion('合成未知优惠', '5.00', 'syn-unknown-0001')],
  });
  const unknown = detailSetup([unknownRow]);
  expect(await unknown.adapter.getItem(ref, ctx)).toMatchObject({
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  });
});

it('[AC-B1-04l#18] 价格配置每次 getItem 按 ctx.appId 读一次：配置的会员关键词参与分类，换 app 按该 app 的配置', async () => {
  const configuredApp = ctx.appId;
  const { reader, read } = priceReader((appId) => {
    return appId === configuredApp ? { member_title_keywords: ['合成会员'] } : {};
  });
  const row = detailRow({
    price: { final_promotion_price: '44.90' },
    promotions: [
      promotion('商品券', '10.00', 'syn-coupon-0001'),
      promotion('合成会员价', '5.00', 'syn-member-0002'),
    ],
  });
  const { adapter } = detailSetup([row], { priceSettings: reader });
  expect(await adapter.getItem(ref, ctx)).toMatchObject({
    price_fen: 5990n,
    coupon_fen: 1000n,
    final_price_fen: 4990n,
    price_status: 'ok',
  });
  expect(read.mock.calls).toEqual([[configuredApp]]);
  const other = { ...ctx, appId: 'synthetic-other-app' };
  expect(await adapter.getItem(ref, other)).toMatchObject({
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  });
  expect(read.mock.calls).toEqual([[configuredApp], ['synthetic-other-app']]);
});

it('[AC-B1-04l#19] 配置变化下一次调用即生效（不缓存）；配置的数组替换默认值', async () => {
  let keywords: readonly string[] = ['合成会员'];
  const { reader, read } = priceReader(() => ({ member_title_keywords: keywords }));
  const { adapter } = detailSetup([detailRow()], { priceSettings: reader });
  // 配置把会员关键词换成「合成会员」后，默认的 88VIP 不再是会员项 → 未知名称。
  expect(await adapter.getItem(ref, ctx)).toMatchObject({
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  });
  keywords = ['88VIP'];
  expect(await adapter.getItem(ref, ctx)).toMatchObject({
    price_fen: 5990n,
    coupon_fen: 1000n,
    final_price_fen: 4990n,
    price_status: 'ok',
  });
  expect(read).toHaveBeenCalledTimes(2);
});
