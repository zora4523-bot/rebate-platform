import { expect, it } from 'vitest';
import { ctx, envelope, epoch, instant, one, ref, row, setup, sources } from './kit.ts';

it.each(sources)(
  '[AC-B1-04u-MAP#1] %s 用拼单价和商品券自算三字段，千分比整数换成 bp',
  async (source) => {
    const item = await one(source, row());
    expect(item).toMatchObject({
      platform: 'pdd',
      goods_id: '7345678901234',
      goods_sign: 'synthetic-sign',
      title: '合成拼单商品',
      price_fen: 4287n,
      coupon_fen: 619n,
      final_price_fen: 3668n,
      commission_rate_bp: 1370n,
      quoted_at: instant,
    });
    expect(item.price_status).not.toBe('anomaly');
    expect(item.price_fen - item.coupon_fen).toBe(item.final_price_fen);
    for (const value of [
      item.price_fen,
      item.coupon_fen,
      item.final_price_fen,
      item.commission_rate_bp,
    ]) {
      expect(typeof value).toBe('bigint');
    }
  },
);

it('[AC-B1-04u-MAP#2] 详情取 goods_desc，商品 ID 与 goods_sign 同时保留', async () => {
  const { adapter } = setup((body) => envelope(body.type, [row()]));
  expect(await adapter.getItem(ref, ctx)).toMatchObject({ ...ref, description: '合成商品描述' });
});

it.each(sources)(
  '[AC-B1-04u-MAP#3] %s 不使用单买价、预测比例、分享比例、平台券和补贴',
  async (source) => {
    const plain = await one(source, row());
    const changed = await one(
      source,
      row({
        min_normal_price: 99999,
        predict_promotion_rate: 999,
        share_rate: 777,
        // probe 只确认数组，成员放不透明合成值，用于证明确实没有解释其金额。
        platform_discount_list: ['synthetic-platform-benefit'],
        subsidy_list: ['synthetic-subsidy'],
        subsidy_goods_type: 8,
        ...(source === 'feed'
          ? { coupon_price: 1, extra_coupon_amount: 888, market_fee: 444 }
          : {
              has_mall_coupon: true,
              mall_coupon_min_order_amount: 1,
              mall_coupon_discount_pct: 90,
              mall_coupon_max_discount_amount: 888,
              mall_coupon_remain_quantity: 9,
              mall_coupon_start_time: epoch - 90,
              mall_coupon_end_time: epoch + 90,
            }),
      }),
    );
    expect(changed).toEqual(plain);
  },
);

it.each(sources)('[AC-B1-04u-MAP#4] %s 零佣金、零券和安全整数分上界保持精确', async (source) => {
  const item = await one(
    source,
    row({
      min_group_price: Number.MAX_SAFE_INTEGER,
      coupon_discount: 0,
      promotion_rate: 0,
    }),
  );
  expect(item).toMatchObject({
    price_fen: 9007199254740991n,
    coupon_fen: 0n,
    final_price_fen: 9007199254740991n,
    commission_rate_bp: 0n,
  });
});

it.each(sources)(
  '[AC-B1-04u-MAP#5] %s 不把未知响应字段或上游请求信息扩散到统一 DTO',
  async (source) => {
    const plain = await one(source, row());
    // 故意污染：这些键不在允许映射的 probe 清单中，不能拿来覆盖 DTO。
    const polluted = await one(
      source,
      row({
        price_fen: 1,
        final_price_fen: 1,
        commission_rate_bp: 9999,
        item_id: 'invented-id',
        unknown_field: 'synthetic-unknown',
      }),
    );
    expect(polluted).toEqual(plain);
    expect(polluted).not.toHaveProperty('unknown_field');
    expect(polluted).not.toHaveProperty('item_id');
  },
);

it.each(sources)(
  '[AC-B1-04u-MAP#6] %s 缺少、空白或非字符串 goods_sign 均拒绝，不能从 goods_id 补造',
  async (source) => {
    for (const goodsSign of [undefined, null, '', '   ', 123]) {
      await expect(one(source, row({ goods_sign: goodsSign }))).rejects.toMatchObject({
        code: 'invalid_dto',
        platform: 'pdd',
      });
    }
  },
);

it.each(sources)(
  '[AC-B1-04u-MAP#7] %s goods_id 必须是安全整数，含恰好 2^53 也拒绝',
  async (source) => {
    for (const goodsId of [
      undefined,
      null,
      '7345678901234',
      12.5,
      9007199254740992,
      9007199254740994,
    ]) {
      await expect(one(source, row({ goods_id: goodsId }))).rejects.toMatchObject({
        code: 'invalid_dto',
        platform: 'pdd',
      });
    }
  },
);

it.each(sources)(
  '[AC-B1-04u-MAP#8] %s 不把缺失、负数、分数或不安全佣金比例当成合法整数',
  async (source) => {
    for (const rate of [undefined, null, -1, 13.7, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(one(source, row({ promotion_rate: rate }))).rejects.toMatchObject({
        code: 'invalid_dto',
        platform: 'pdd',
      });
    }
  },
);
