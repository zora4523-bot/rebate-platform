import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { TaobaoPriceSettingsReader } from '../../../../apps/api/src/modules/union/domain/taobao-price.ts';
import { createUnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { TaobaoUnionAdapter } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  APP_KEY,
  ctx,
  DETAIL,
  detailBody,
  detailRow,
  formOf,
  instant,
  priceReader,
  promotion,
  ref,
  registryEndpoints,
  SECRET,
} from './kit.ts';

/** 配置了会员关键词「合成会员」才是正常价；默认配置下「合成会员价」是未知名称。 */
const rows = [
  detailRow({
    price: { final_promotion_price: '44.90' },
    promotions: [
      promotion('商品券', '10.00', 'syn-coupon-0001'),
      promotion('合成会员价', '5.00', 'syn-member-0002'),
    ],
  }),
];

/** The detail method answers `rows`; anything else gets an empty object (no envelope). */
function reply(request: UnionTransportRequest): UnionTransportResponse {
  const body = formOf(request)['method'] === DETAIL ? detailBody(rows) : '{}';
  return { status: 200, headers: {}, body };
}

function liveRegistry(taobaoPriceSettings?: TaobaoPriceSettingsReader) {
  const credentials = vi.fn(async () => ({ appKey: APP_KEY, appSecret: SECRET }));
  const transport = vi.fn<UnionTransport>(async (request) => reply(request));
  const registry = createUnionRegistry({
    endpoints: registryEndpoints('live'),
    environment: 'staging',
    seed: 'synthetic-goods-registry',
    clock: new FixedClock(instant),
    taobaoLive: { credentials, transport },
    ...(taobaoPriceSettings === undefined ? {} : { taobaoPriceSettings }),
  });
  return { registry, credentials, transport };
}

it('[AC-B1-04l#39] taobaoLive 装配把 options.taobaoPriceSettings 原样传给真实适配器：详情到手价按配置算', async () => {
  const { reader, read } = priceReader(() => ({ member_title_keywords: ['合成会员'] }));
  const { registry, transport } = liveRegistry(reader);
  const adapter = registry.get('taobao');
  expect(adapter).toBeInstanceOf(TaobaoUnionAdapter);
  expect(await adapter.getItem(ref, ctx)).toMatchObject({
    platform: 'taobao',
    price_fen: 5990n,
    coupon_fen: 1000n,
    final_price_fen: 4990n,
    price_status: 'ok',
  });
  expect(read.mock.calls).toEqual([[ctx.appId]]);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(adapter.taobaoShareCode).toBeTypeOf('function');
  expect(adapter.shortenTaobaoUrl).toBeTypeOf('function');
});

it('[AC-B1-04l#40] 没传 taobaoPriceSettings 时真实适配器按 BR-PRICE-02 默认配置：同一商品是 unknown_promo 异常', async () => {
  const { registry, transport } = liveRegistry();
  expect(await registry.get('taobao').getItem(ref, ctx)).toMatchObject({
    platform: 'taobao',
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
