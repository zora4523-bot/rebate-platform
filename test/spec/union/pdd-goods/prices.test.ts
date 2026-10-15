import { expect, it } from 'vitest';
import { envelope, epoch, instant, one, read, row, setup, sources } from './kit.ts';

const coupons: readonly [string, Record<string, unknown>, bigint][] = [
  ['门槛等于单件拼单价', { coupon_min_order_amount: 4287 }, 619n],
  ['单件差一分达不到门槛', { coupon_min_order_amount: 4288 }, 0n],
  ['单买价能达门槛也不算', { coupon_min_order_amount: 7000 }, 0n],
  ['开始时刻包含', { coupon_start_time: epoch }, 619n],
  ['尚未开始', { coupon_start_time: epoch + 1 }, 0n],
  ['结束前一秒', { coupon_end_time: epoch + 1 }, 619n],
  ['结束时刻排除', { coupon_end_time: epoch }, 0n],
  ['已经过期', { coupon_end_time: epoch - 1 }, 0n],
  ['余量为零', { coupon_remain_quantity: 0 }, 0n],
  ['余量还有一张', { coupon_remain_quantity: 1 }, 619n],
  ['未返回余量按 BR-PRICE-01 视为有余量', { coupon_remain_quantity: undefined }, 619n],
  ['零面额不是缺失', { coupon_discount: 0 }, 0n],
];

for (const source of sources) {
  it.each(coupons)(`[AC-B1-04u-PRICE#1] ${source}：%s`, async (_label, changes, expectedCoupon) => {
    const item = await one(source, row(changes));
    expect(item).toMatchObject({
      price_fen: 4287n,
      coupon_fen: expectedCoupon,
      final_price_fen: 4287n - expectedCoupon,
    });
    expect(item.price_status).not.toBe('anomaly');
  });
}

it.each(sources)(
  '[AC-B1-04u-PRICE#2] %s 秒级券时间与注入 Clock 比较，毫秒边界不提前失效',
  async (source) => {
    const { adapter, clock } = setup((body) =>
      envelope(body.type, [
        row({
          coupon_start_time: epoch,
          coupon_end_time: epoch + 1,
        }),
      ]),
    );
    clock.set('2032-04-05T06:07:07.999Z');
    expect((await read(adapter, source))[0]).toMatchObject({
      coupon_fen: 0n,
      final_price_fen: 4287n,
    });
    clock.set(instant);
    expect((await read(adapter, source))[0]).toMatchObject({
      coupon_fen: 619n,
      final_price_fen: 3668n,
    });
    clock.advanceMs(999);
    expect((await read(adapter, source))[0]).toMatchObject({
      coupon_fen: 619n,
      final_price_fen: 3668n,
      quoted_at: '2032-04-05T06:07:08.999Z',
    });
    clock.advanceMs(1);
    expect((await read(adapter, source))[0]).toMatchObject({
      coupon_fen: 0n,
      final_price_fen: 4287n,
      quoted_at: '2032-04-05T06:07:09.000Z',
    });
  },
);

it.each(sources)(
  '[AC-B1-04u-PRICE#3] %s 明确无券且没有券时效字段时按零券正常出价',
  async (source) => {
    const item = await one(
      source,
      row({
        has_coupon: false,
        coupon_discount: 0,
        coupon_min_order_amount: undefined,
        coupon_start_time: undefined,
        coupon_end_time: undefined,
        coupon_remain_quantity: undefined,
      }),
    );
    expect(item).toMatchObject({ price_fen: 4287n, coupon_fen: 0n, final_price_fen: 4287n });
    expect(item.price_status).not.toBe('anomaly');
  },
);

const anomalies: readonly [string, Record<string, unknown>][] = [
  ['缺失拼单价，不能用单买价补', { min_group_price: undefined }],
  ['拼单价为空', { min_group_price: null }],
  ['零拼单价', { min_group_price: 0 }],
  ['负拼单价', { min_group_price: -1 }],
  ['分字段不是整数', { min_group_price: 4287.5 }],
  ['超过安全整数', { min_group_price: Number.MAX_SAFE_INTEGER + 1 }],
  ['券等于价格', { coupon_discount: 4287 }],
  ['券大于价格', { coupon_discount: 4288 }],
  ['标记有券却缺面额', { coupon_discount: undefined }],
  ['负券面额', { coupon_discount: -1 }],
  ['券面额不是整数分', { coupon_discount: 619.5 }],
  ['有券却缺门槛', { coupon_min_order_amount: undefined }],
  ['有券却缺开始时间', { coupon_start_time: undefined }],
  ['有券却缺结束时间', { coupon_end_time: undefined }],
];

// Adapter 返回带 price_status 的内部 DTO；搜索不出卡、主动查询不显示金额属于调用方，
// 本任务不测试 catalog / parsing / linking / 前端，也不规定异常 DTO 的占位金额。
for (const source of sources) {
  it.each(anomalies)(
    `[AC-B1-04u-PRICE#4] ${source}：%s 标成异常且记录 PRICE_ANOMALY`,
    async (_label, changes) => {
      const { adapter, warn } = setup((body) => envelope(body.type, [row(changes)]));
      const items = await read(adapter, source);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ goods_sign: 'synthetic-sign', price_status: 'anomaly' });
      expect(JSON.stringify(warn.mock.calls)).toContain('PRICE_ANOMALY');
    },
  );
}

it.each(sources)(
  '[AC-B1-04u-PRICE#5] %s 大面额但未达门槛的券不可用，不制造负券后价异常',
  async (source) => {
    const item = await one(source, row({ coupon_discount: 5000, coupon_min_order_amount: 6000 }));
    expect(item).toMatchObject({ price_fen: 4287n, coupon_fen: 0n, final_price_fen: 4287n });
    expect(item.price_status).not.toBe('anomaly');
  },
);
