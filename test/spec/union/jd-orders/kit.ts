import { expect } from 'vitest';
import type { QuotaLimiter, Scheduler } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedAdapter,
  type CallCtx,
  type OrderQueryOpt,
  type TimeWindow,
  type UnionAdapter,
  type UnionOrder,
  type UnionOrderNeutralFields,
  type UnionTransportRequest,
  type UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/index.ts';
import type { JdAdapterOptions } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import {
  mapJdOrder,
  type JdOrderPage,
  type JdProductKeyMode,
} from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { unwrapJdResponse } from '../../../../apps/api/src/modules/union/infra/jd/response.ts';
import { endpoint, formFields, instant, setup } from '../jd-core/kit.ts';

// Task-local AC labels ([AC-B1-04zb#n]) identify this task's acceptance points, not business rules.
// 报文全部合成：字段名与形状来自任务书，值都是自拟的，不是任何京东接口的录制。
export const method = 'jd.union.open.order.row.query';
/** Spelled `_responce` on the wire; the misspelling is the gateway's own. */
export const keys = {
  envelope: 'jd_union_open_order_row_query_responce',
  resultKey: 'queryResult',
};
export const ctx: CallCtx = {
  appId: 'app-synthetic',
  requestId: 'req-orders-synthetic',
  purpose: 'order_sync',
};
/** One hour, well inside the 90 days before jd-core's clock (2026-10-30T15:55:42.000Z). */
export const win: TimeWindow = { from: '2026-10-30T02:00:00Z', to: '2026-10-30T03:00:00Z' };
export const nowMs = Date.parse(instant);
export const hourMs = 3_600_000;
export const dayMs = 86_400_000;
/** 2^53 + 1: the first integer a JS number cannot hold. */
export const beyondNumber = '9007199254740993';

/** A number on the wire, kept as written: JSON.stringify would lose 12.30 and 2^53 + 1. */
export class WireNumber {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

export function num(text: string): WireNumber {
  return new WireNumber(text);
}

/** JSON text of a fixture; a WireNumber goes out as its literal, undefined drops the field. */
export function jsonText(value: unknown): string {
  if (value instanceof WireNumber) return value.text;
  if (Array.isArray(value)) return `[${value.map(jsonText).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .map(([name, member]) => `${JSON.stringify(name)}:${jsonText(member)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A paid, unfinished order: the row shape the task brief lists, all values invented. */
export function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '2026103012345678901',
    orderId: num('3123456789012345'),
    parentId: num('0'),
    skuId: num('100012345678'),
    itemId: 'synthAseg-Bseg',
    positionId: num('3100000001'),
    subUnionId: 'n_synthetic',
    validCode: num('16'),
    orderTime: '2026-10-30 10:00:01',
    modifyTime: '2026-10-30 10:30:02',
    finishTime: '',
    payMonth: num('0'),
    estimateFee: num('1.23'),
    actualFee: num('0.0'),
    estimateCosPrice: num('45.60'),
    actualCosPrice: num('0.0'),
    balanceExt: '',
    ext1: '',
    pid: '',
    skuName: '合成京东商品',
    unionId: num('1000000001'),
    goodsInfo: { imageUrl: 'https://img.invalid/synthetic.jpg' },
    ...overrides,
  };
}

/** A 19-digit `id`; rows of different series and positions never share one. */
export function rowId(series: number, position: number): string {
  return `${2026103000000000000n + BigInt(series * 1000 + position)}`;
}

/** `count` rows of one series, told apart by `id`. */
export function rows(series: number, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => row({ id: rowId(series, i) }));
}

/** The inner result text the gateway nests. */
export function inner(data: unknown, hasMore: boolean, code: unknown = num('200')): string {
  return jsonText({ code, message: 'success', hasMore, data });
}

/**
 * A gateway answer. raw_payload_id is what the archiving transport leaves on the response:
 * a non-enumerable property of the same object (archive.ts), so a copy of the response loses it.
 */
export function reply(innerText: string, rawPayloadId?: string): UnionTransportResponse {
  const response: UnionTransportResponse = {
    status: 200,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ [keys.envelope]: { code: '0', [keys.resultKey]: innerText } }),
  };
  if (rawPayloadId !== undefined) {
    Object.defineProperty(response, 'raw_payload_id', { value: rawPayloadId, enumerable: false });
  }
  return response;
}

/** The business object of one request. */
export function orderReq(request: UnionTransportRequest): Record<string, unknown> {
  const payload = formFields(request)['360buy_param_json'];
  expect(payload).toBeTypeOf('string');
  const parameters = JSON.parse(payload!) as { orderReq?: Record<string, unknown> };
  expect(parameters.orderReq).toBeDefined();
  return parameters.orderReq!;
}

export type Answer = (
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => UnionTransportResponse | Promise<UnionTransportResponse>;

/** The jd-core adapter behind `answer`; `requests` are the business objects in arrival order. */
export function wire(answer: Answer, overrides: Partial<JdAdapterOptions> = {}) {
  const requests: Record<string, unknown>[] = [];
  const core = setup(overrides);
  core.transport.mockImplementation(async (request) => {
    const body = orderReq(request);
    requests.push(body);
    return answer(body, request.signal);
  });
  return { ...core, requests };
}

/** Upstream holding `pages`: page n answers `pages[n - 1]`, hasMore while another page follows. */
export function pageAnswer(pages: readonly (readonly unknown[])[]): Answer {
  return (body) => {
    const index = Number(body.pageIndex) - 1;
    return reply(inner(pages[index] ?? [], index + 1 < pages.length));
  };
}

/** Everything a window holds. The cursor stays opaque: one call or one call per page both pass. */
export async function collect(
  adapter: UnionAdapter,
  window: TimeWindow = win,
  options: OrderQueryOpt = {},
  call: CallCtx = ctx,
): Promise<{ readonly orders: UnionOrder[]; readonly calls: number }> {
  const orders: UnionOrder[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let calls = 1; calls <= 20; calls += 1) {
    const page = await adapter.listOrders(
      window,
      { ...options, ...(cursor === undefined ? {} : { cursor }) },
      call,
    );
    orders.push(...page.items);
    if (page.nextCursor === null) return { orders, calls };
    expect(seen.has(page.nextCursor)).toBe(false);
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  expect.fail('synthetic pagination must terminate');
}

/** One row through the whole adapter. */
export async function one(
  input: Record<string, unknown>,
  overrides: Partial<JdAdapterOptions> = {},
): Promise<UnionOrder> {
  const { adapter } = wire(() => reply(inner([input], false)), overrides);
  const { orders } = await collect(adapter);
  expect(orders).toHaveLength(1);
  return orders[0]!;
}

/** The row as the mapper receives it: decoded by the merged gateway decoder. */
export function decoded(input: Record<string, unknown>): unknown {
  const result = unwrapJdResponse(method, keys, reply(inner([input], false)));
  return (result.data as readonly unknown[])[0];
}

export function pageMeta(productKeyMode: JdProductKeyMode = 'item'): JdOrderPage {
  return { rawPayloadId: null, like: new Date(instant), productKeyMode };
}

/** Synchronous mapping of one row, for property bodies. */
export function mapped(
  overrides: Record<string, unknown>,
  productKeyMode: JdProductKeyMode = 'item',
): UnionOrder & UnionOrderNeutralFields {
  return mapJdOrder(decoded(row(overrides)), pageMeta(productKeyMode));
}

/** No wall-clock waits: backoff resolves at once, a timeout waits only for cancellation. */
export const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          if (signal?.aborted === true) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};

export function govern(
  adapter: UnionAdapter,
  take: QuotaLimiter['tryAcquire'],
  timer: Scheduler = scheduler,
) {
  return createGovernedAdapter(adapter, {
    endpoint,
    scheduler: timer,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
  });
}

/** `pages` single-row pages, and the sub_order_id of each. */
export function singleRowPages(count: number) {
  const data = rows(1, count);
  return { pages: data.map((input) => [input]), ids: data.map((input) => input.id) };
}

/** The instant of an upstream `yyyy-MM-dd HH:mm:ss` text, which is GMT+8. */
export function beijingMs(text: unknown): number {
  expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  return Date.parse(`${String(text).replace(' ', 'T')}+08:00`);
}
