import { inspect } from 'node:util';
import { expect, type Mock } from 'vitest';
import type {
  CallCtx,
  ItemRef,
  UnionItem,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  mapJdGoods,
  pickJdCoupon,
  type JdCouponChoice,
  type JdGoodsPage,
} from '../../../../apps/api/src/modules/union/infra/jd/goods.ts';
import type {
  JdAdapterOptions,
  JdUnionAdapter,
  JdWarning,
} from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import type { JdProductKeyMode } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { unwrapJdResponse } from '../../../../apps/api/src/modules/union/infra/jd/response.ts';
import { formFields, instant, response, setup } from '../jd-core/kit.ts';
import { jsonText, num, type WireNumber } from '../jd-orders/kit.ts';

// Task-local AC labels ([AC-B1-04zc#n]) identify this task's acceptance points, not business rules.
// 权限批下前只按文档：字段名与形状来自任务书，值全部合成，不是任何京东接口的录制。
// 标题字段 skuName 是京东文档的字段名，任务书没写；权限批下后实测再校。
export const method = 'jd.union.open.goods.query';
/** Spelled `_responce` on the wire; the misspelling is the gateway's own. */
export const keys = {
  envelope: 'jd_union_open_goods_query_responce',
  resultKey: 'queryResult',
};
export const ctx: CallCtx = {
  appId: 'app-synthetic',
  requestId: 'req-goods-synthetic',
  purpose: 'online',
};
export const nowMs = Date.parse(instant);
export const hourMs = 3_600_000;
/** 联盟 itemId 形如 A段_B段。 */
export const wholeItemId = 'synthAseg_Bseg';
export const otherItemId = 'otherAseg_Oseg';
export const skuId = '100012345678';
export const otherSkuId = '100087654321';
export const title = '合成京东商品';
export const couponLink = 'https://coupon.invalid/c1';
export const unionLink = 'https://u.jd.com/synth01';
export const itemRef: ItemRef = { platform: 'jd', item_id: wholeItemId };
export const ports = ['search', 'detail', 'link'] as const;
export type Port = (typeof ports)[number];

export type Row = Record<string, unknown>;

/** A millisecond timestamp on the wire. */
export function ms(value: number): WireNumber {
  return num(String(value));
}

/** Integer fen as a yuan literal, always with two decimals. */
export function yuan(fen: bigint): string {
  return `${fen / 100n}.${String(fen % 100n).padStart(2, '0')}`;
}

/** 10 元门槛 39，取数时刻在有效期内，可领取。 */
export function coupon(overrides: Row = {}): Row {
  return {
    discount: num('10'),
    quota: num('39'),
    useStartTime: ms(nowMs - hourMs),
    useEndTime: ms(nowMs + hourMs),
    isBest: num('0'),
    couponStatus: num('0'),
    couponStyle: num('0'),
    link: couponLink,
    ...overrides,
  };
}

export function basePrice(overrides: Row = {}): Row {
  return {
    price: num('39.90'),
    lowestPrice: num('35.00'),
    lowestPriceType: num('1'),
    lowestCouponPrice: num('29.90'),
    ...overrides,
  };
}

/** 39.90 元、一张 10 元券、佣金 50：券后 29.90，与 lowestCouponPrice 一致。 */
export function row(overrides: Row = {}): Row {
  return {
    itemId: wholeItemId,
    skuId: num(skuId),
    skuName: title,
    spuid: num('100012345000'),
    materialUrl: `jingfen.jd.com/detail/${wholeItemId}.html`,
    priceInfo: basePrice(),
    commissionInfo: {
      commission: num('14.95'),
      commissionShare: num('50'),
      couponCommission: num('14.95'),
      plusCommissionShare: num('50'),
    },
    couponInfo: { couponList: [coupon()] },
    imageInfo: { imageList: [{ url: 'https://img.invalid/goods.jpg' }] },
    ...overrides,
  };
}

export function withPrice(price: unknown): Row {
  return row({ priceInfo: basePrice({ price }) });
}

export function withCoupons(coupons: readonly Row[], overrides: Row = {}): Row {
  return row({ couponInfo: { couponList: coupons }, ...overrides });
}

/** `count` goods told apart by itemId and skuId. */
export function listOf(count: number): Row[] {
  return Array.from({ length: count }, (_, i) =>
    row({ itemId: `synthAseg${i}_Bseg${i}`, skuId: num(`${100012345678n + BigInt(i)}`) }),
  );
}

/** A successful inner result, its members written out; a member may be missing or of any type. */
export function success(members: Row = {}): string {
  return jsonText({ code: num('200'), message: 'success', requestId: 'req-upstream', ...members });
}

export function inner(data: unknown, totalCount?: number): string {
  const total = totalCount ?? (Array.isArray(data) ? data.length : 0);
  return success({ totalCount: num(String(total)), data });
}

export function failure(code: string, message = 'synthetic failure'): string {
  return jsonText({ code: num(code), message, requestId: 'req-upstream' });
}

export function reply(innerText: string): UnionTransportResponse {
  return response({ [keys.envelope]: { code: '0', [keys.resultKey]: innerText } });
}

export function listing(rows: readonly unknown[], totalCount?: number): UnionTransportResponse {
  return reply(inner(rows, totalCount));
}

/** The business object of one request. */
export function goodsReq(request: UnionTransportRequest): Record<string, unknown> {
  const payload = formFields(request)['360buy_param_json'];
  expect(payload).toBeTypeOf('string');
  const parameters = JSON.parse(payload!) as { goodsReqDTO?: Record<string, unknown> };
  expect(parameters.goodsReqDTO).toBeDefined();
  return parameters.goodsReqDTO!;
}

export type Answer = (body: Record<string, unknown>) => UnionTransportResponse;

/** The jd-core adapter behind `answer`; `requests` are the goodsReqDTO objects in arrival order. */
export function wire(answer: Answer, overrides: Partial<JdAdapterOptions> = {}) {
  const requests: Record<string, unknown>[] = [];
  const core = setup(overrides);
  core.transport.mockImplementation(async (request) => {
    const body = goodsReq(request);
    requests.push(body);
    return answer(body);
  });
  return { ...core, requests };
}

export function mode(productKeyMode: JdProductKeyMode): Partial<JdAdapterOptions> {
  return { productKeyMode: { read: async () => productKeyMode } };
}

export function invoke(adapter: JdUnionAdapter, port: Port, call: CallCtx = ctx): Promise<unknown> {
  if (port === 'search') return adapter.searchItems({ keyword: '合成关键词' }, call);
  if (port === 'detail') return adapter.getItem(itemRef, call);
  return adapter.resolveLink(unionLink, call);
}

/** One row through search. */
export async function searched(
  input: Row,
  overrides: Partial<JdAdapterOptions> = {},
): Promise<UnionItem> {
  const { adapter } = wire(() => listing([input]), overrides);
  const page = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
  expect(page.items).toHaveLength(1);
  return page.items[0]!;
}

/** One row through search and through getItem; item mode, where getItem applies. */
export async function both(input: Row): Promise<readonly UnionItem[]> {
  const { adapter } = wire(() => listing([input]));
  const page = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
  expect(page.items).toHaveLength(1);
  return [page.items[0]!, await adapter.getItem(itemRef, ctx)];
}

/** The row as the mapper receives it: decoded by the merged gateway decoder. */
export function decoded(input: Row): unknown {
  const result = unwrapJdResponse(method, keys, listing([input]));
  return (result.data as readonly unknown[])[0];
}

/** Synchronous mapping of one row, for property bodies: no expect inside. */
export function mapped(input: Row, overrides: Partial<JdGoodsPage> = {}) {
  return mapJdGoods(decoded(input), {
    now: new Date(instant),
    productKeyMode: 'item',
    warn: undefined,
    ...overrides,
  });
}

/** Synchronous coupon choice on the list as decoded, for property bodies: no expect inside. */
export function picked(
  coupons: readonly Row[],
  priceFen: bigint,
  atMs: number = nowMs,
): JdCouponChoice | null {
  const goods = decoded(withCoupons(coupons)) as { readonly couponInfo: { couponList: unknown } };
  return pickJdCoupon(goods.couponInfo.couponList, priceFen, atMs);
}

/** The warnings of one code, as plain objects. */
export function warnings(warn: Mock<(event: JdWarning) => void>, code: string): Row[] {
  return warn.mock.calls
    .map(([event]) => event as unknown as Row)
    .filter((event) => event.code === code);
}

/** expectRedacted for values holding bigint fen, which JSON.stringify refuses. */
export function expectNoMarkers(value: unknown, markers: readonly string[]): void {
  const visible = inspect(value, { depth: null });
  for (const marker of markers) expect(visible).not.toContain(marker);
}
