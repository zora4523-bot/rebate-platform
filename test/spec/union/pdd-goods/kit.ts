import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  CallCtx,
  UnionItem,
  UnionTransport,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  PddUnionAdapter,
  type PddQueryIdentity,
} from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';

// AC-B1-04u-* 是任务内验收标签。字段来自任务书 probe 清单，值全部合成；
// 不读取私有录制，不把样例标为 doc-derived，不访问网络。
export const search = 'pdd.ddk.goods.search';
export const detail = 'pdd.ddk.goods.detail';
export const recommend = 'pdd.ddk.goods.recommend.get';
export const shortParse = 'pdd.ddk.url.short.parse';
export const instant = '2032-04-05T06:07:08.000Z';
export const epoch = Date.parse(instant) / 1000;
export const ctx: CallCtx = {
  appId: 'synthetic-goods-app',
  requestId: 'synthetic-goods-request',
  purpose: 'online',
};
export const identity: PddQueryIdentity = {
  pid: 'synthetic-query-pid',
  customParameters: '{ "uid": "synthetic-query-user", "app": "query-app" }',
};
export const ref = {
  platform: 'pdd',
  goods_id: '7345678901234',
  goods_sign: 'synthetic-sign',
} as const;
export const shortLink = 'https://p.pinduoduo.com/synthetic-link';
export const longLink = 'https://mobile.yangkeduo.com/goods.html?goods_id=7345678901234';
export const sources = ['search', 'detail', 'feed'] as const;
export type Source = (typeof sources)[number];

/** 仅使用三个商品接口共有的已确认字段；扩展字段在对应接口的测试里另加。 */
export function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goods_id: 7345678901234,
    goods_sign: 'synthetic-sign',
    goods_name: '合成拼单商品',
    goods_desc: '合成商品描述',
    min_group_price: 4287,
    min_normal_price: 7654,
    coupon_discount: 619,
    coupon_min_order_amount: 4200,
    coupon_start_time: epoch - 90,
    coupon_end_time: epoch + 90,
    coupon_remain_quantity: 7,
    has_coupon: true,
    promotion_rate: 137,
    predict_promotion_rate: 231,
    share_rate: 89,
    platform_discount_list: [],
    subsidy_list: [],
    subsidy_goods_type: 0,
    ...overrides,
  };
}

export function envelope(method: unknown, rows: readonly unknown[]): unknown {
  if (method === search) {
    return { goods_search_response: { goods_list: rows, total_count: rows.length } };
  }
  if (method === detail) return { goods_detail_response: { goods_details: rows } };
  if (method === recommend)
    return { goods_basic_detail_response: { list: rows, total: rows.length } };
  expect.fail(`unexpected synthetic method: ${String(method)}`);
}

export function setup(
  reply: (body: Record<string, unknown>) => unknown,
  provider: (() => Promise<PddQueryIdentity>) | null = async () => identity,
) {
  const clock = new FixedClock(instant);
  const requests: Record<string, unknown>[] = [];
  const queryIdentity = vi.fn(provider ?? (async () => identity));
  const credentials = vi.fn(async () => ({
    clientId: 'synthetic-client',
    clientSecret: 'fake-key',
  }));
  const transport = vi.fn<UnionTransport>(async (request) => {
    expect(request.body).toBeTypeOf('string');
    const body = JSON.parse(request.body!) as Record<string, unknown>;
    requests.push(body);
    return { status: 200, headers: {}, body: JSON.stringify(reply(body)) };
  });
  const warn = vi.fn();
  const adapter = new PddUnionAdapter({
    clock,
    credentials,
    transport,
    warn,
    endpoint: {
      platform: 'pdd',
      mode: 'live',
      baseUrl: 'https://goods-gateway.invalid/router',
      quotaKey: 'synthetic-goods-account',
    },
    ...(provider === null ? {} : { queryIdentity }),
  });
  return { adapter, clock, requests, queryIdentity, credentials, transport, warn };
}

export async function read(
  adapter: PddUnionAdapter,
  source: Source,
  context: CallCtx = ctx,
): Promise<readonly UnionItem[]> {
  if (source === 'detail') return [await adapter.getItem(ref, context)];
  if (source === 'feed') return (await adapter.materialFeed({}, context)).items;
  return (await adapter.searchItems({ keyword: '合成关键词' }, context)).items;
}

export async function one(source: Source, input: Record<string, unknown>): Promise<UnionItem> {
  const { adapter } = setup((body) => envelope(body.type, [input]));
  const items = await read(adapter, source);
  expect(items).toHaveLength(1);
  return items[0]!;
}

export function invoke(adapter: PddUnionAdapter, port: Source | 'link'): Promise<unknown> {
  if (port === 'link') return adapter.resolveLink(shortLink, ctx);
  return read(adapter, port);
}
