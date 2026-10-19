import { expect, it } from 'vitest';
import {
  mapPddOrder,
  parsePddOrderEnvelope,
} from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';
import { at, capture } from '../source-backfill/kit.ts';

// 字段出处（只记字段与含义）：docs-mirror/pdd/api/pdd.ddk.order.list.increment.get.md、
// pdd.ddk.order.list.range.get.md、pdd.ddk.order.detail.get.md：mall_id 为店铺 ID。
// 下列为最小合成输入，不是平台录制；不推断淘宝 / 京东字段，也不借用店名。
const sources = ['increment', 'range', 'detail'] as const;
const page = { rawPayloadId: null, like: at('2026-10-19T01:02:03Z') };
const row = {
  order_sn: 'synthetic-shop-order',
  goods_id: 42,
  order_amount: 12345,
  promotion_amount: 789,
};

it.each(sources)('[AC-B1-08p#4] %s 正安全整数 mall_id 无损映射为字符串', async (source) => {
  for (const mall_id of [1, 73129, Number.MAX_SAFE_INTEGER]) {
    const result = await capture(() => mapPddOrder({ ...row, mall_id }, source, page));
    expect(result).toMatchObject({
      ok: true,
      value: {
        shop_id: String(mall_id),
        goods_id: '42',
        paid_fen: 12345n,
        commission_fen: 789n,
      },
    });
  }
});

it.each(sources)('[AC-B1-08p#5] %s 缺失或非法 mall_id 显式 null，不丢订单', async (source) => {
  for (const patch of [{}, { mall_id: null }, { mall_id: 0 }, { mall_id: -1 }, { mall_id: 1.25 }]) {
    const result = await capture(() =>
      mapPddOrder(
        {
          ...row,
          ...patch,
          mall_name: '不是 ID',
          seller_nick: '不是 ID',
          goodsInfo: { shopId: '不属于拼多多' },
        },
        source,
        page,
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        shop_id: null,
        order_id: row.order_sn,
        paid_fen: 12345n,
        commission_fen: 789n,
      },
    });
  }
});

it.each(sources)('[AC-B1-08p#6] %s 超界 mall_id 不得成为被舍入的错误店铺', async (source) => {
  for (const integer of ['9007199254740993', '9223372036854775807']) {
    // 原始文本保留超界值；实现可返回 null，也可选择无损解析后返回精确文本。
    const body = `{"fixture":{"order_sn":"synthetic-shop-order","goods_id":42,"order_amount":12345,"promotion_amount":789,"mall_id":${integer}}}`;
    const result = await capture(() =>
      mapPddOrder(parsePddOrderEnvelope(body, 'fixture'), source, page),
    );
    expect(result).toMatchObject({ ok: true, value: { order_id: row.order_sn } });
    if (!result.ok) return;
    expect(Object.hasOwn(result.value, 'shop_id')).toBe(true);
    expect([null, integer]).toContain(result.value.shop_id);
    expect(result.value.shop_id).not.toBe(String(Number(integer)));
  }
});
