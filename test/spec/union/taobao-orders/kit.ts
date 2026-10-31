import { inspect } from 'node:util';
import { expect, vi } from 'vitest';
import {
  FixedClock,
  type QuotaLimiter,
  type Scheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import {
  UnionError,
  type CallCtx,
  type OrderQueryOpt,
  type Page,
  type TimeWindow,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionOrder,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  DataokeClient,
  type DataokeCredentials,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoAdapterOptions,
  type TaobaoCredentials,
  type TaobaoOrderSlotReader,
  type TaobaoOrderWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';

// Task-local AC labels ([AC-B1-04f#n]) identify this task's acceptance points, not business rules.
// 报文全部合成：字段名与形状来自任务书（官方 publisher_order_dto 同名字段、大淘客外层 { time, code, msg,
// data }），值都是自拟的掩码形状，不是任何录制原值；凭据是低熵合成串。

/** The 大淘客 order interface and its version (task brief). */
export const ORDER_PATH = '/api/tb-service/get-order-details';
export const ORDER_VERSION = 'v1.0.0';
/** A deployment points this at https://openapi.dataoke.com; the client uses it as given. */
export const DATAOKE_BASE = 'https://dataoke-gateway.invalid';
export const endpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-gateway.invalid/router/rest',
  quotaKey: 'synthetic-taobao-orders',
};
export const ctx: CallCtx = {
  appId: 'synthetic-tb-orders-app',
  requestId: 'synthetic-tb-orders-request',
  purpose: 'order_sync',
};
/** The injected clock; the windows below do not depend on it. */
export const instant = '2026-10-31T08:00:00.000Z';
/** One hour: Beijing 2026-10-30 10:00:00 – 11:00:00. */
export const win: TimeWindow = { from: '2026-10-30T02:00:00Z', to: '2026-10-30T03:00:00Z' };
export const hourMs = 3_600_000;

/** Our promotion slots (one active, one retired) and a slot of someone else (shared account). */
export const OUR_ADZONE = '123456789012';
export const RETIRED_ADZONE = '123456789034';
export const FOREIGN_ADZONE = '123456789056';
export const OTHER_FOREIGN_ADZONE = '123456789078';
export const OUR_SLOT = `mm_1000000001_3000000001_${OUR_ADZONE}`;
export const RETIRED_SLOT = `mm_1000000001_3000000001_${RETIRED_ADZONE}`;
export const SLOTS: readonly string[] = [OUR_SLOT, RETIRED_SLOT];

export const TRADE_ID = '2900000000000000101';
export const TRADE_PARENT_ID = '2900000000000000100';
/** About 41 characters with exactly one "-", like the recorded shape. */
export const ITEM_ID = 'SynthAbCdEfGhIjKlMnOpQrSt-uVwXyZ0123456789';

/** A number on the wire, kept as written: JSON.stringify would lose 0.29999999999999999. */
export class WireNumber {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

export function num(text: string): WireNumber {
  return new WireNumber(text);
}

/** JSON text of a fixture; a WireNumber goes out as its literal, undefined drops the member. */
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

/**
 * A settled order of our active slot, with every field of the recorded shape plus the 大淘客
 * self-computed fields (income …), which must never be mapped. All values invented.
 */
export function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trade_id: TRADE_ID,
    trade_parent_id: TRADE_PARENT_ID,
    item_id: ITEM_ID,
    item_num: num('1'),
    item_title: '合成淘宝订单商品',
    adzone_id: num(OUR_ADZONE),
    site_id: num('3000000001'),
    pub_id: num('1000000001'),
    tk_status: num('3'),
    refund_tag: num('0'),
    tk_order_role: num('0'),
    alipay_total_price: '88.80',
    item_price: '99.00',
    pub_share_pre_fee: '7.99',
    pub_share_fee: '6.66',
    total_commission_fee: '8.88',
    alimama_share_fee: '0.45',
    subsidy_fee: '1.20',
    deposit_price: '0.00',
    income_rate: '9.00',
    pub_share_rate: '100.00',
    tk_total_rate: '9.00',
    total_commission_rate: '9.00',
    alimama_rate: '0.00',
    subsidy_rate: '1.35',
    tk_create_time: '2026-10-30 10:00:01',
    tk_paid_time: '2026-10-30 10:00:05',
    tb_paid_time: '2026-10-30 10:00:05',
    tk_earning_time: '2026-10-30 10:40:00',
    modified_time: '2026-10-30 10:45:30',
    click_time: '2026-10-30 09:58:00',
    tb_deposit_time: '--',
    tk_deposit_time: '--',
    alimm_share_info_dto: {
      alimm_tech_service_fee: num('1'),
      alimm_tech_service_pre_fee: num('0.5'),
      alimm_tech_service_rate: num('10'),
    },
    // 大淘客自算字段（不映射）：值与上面所有官方字段都不同，混进 DTO 就能看出来。
    income: '7.77',
    income_by_one: '7.76',
    price_by_one: '7.75',
    day: '2026-10-29',
    pub_share_pre_fee_for_commission: '7.74',
    pub_share_pre_fee_for_sdy: '7.73',
    ...overrides,
  };
}

/** A row told apart by its trade_id (19 digits) and placed on `adzone`. */
export function rowOf(index: number, adzone: string = OUR_ADZONE): Record<string, unknown> {
  return row({
    trade_id: `${2900000000000001000n + BigInt(index)}`,
    adzone_id: num(adzone),
  });
}

/** The `data` object of one page. */
export function pageData(
  rows: readonly unknown[],
  options: { readonly hasNext?: boolean; readonly position?: string } = {},
): Record<string, unknown> {
  return {
    has_next: options.hasNext ?? false,
    has_pre: false,
    page_no: num('1'),
    page_size: num('100'),
    position_index: options.position ?? '1793300000_SYNa0|1793300001_SYNb0',
    results: { publisher_order_dto: rows },
  };
}

/**
 * The 大淘客 answer around `data`. raw_payload_id is what the archiving transport leaves on the
 * response: a non-enumerable property of the same object (archive.ts).
 */
export function reply(data: unknown, rawPayloadId?: string): UnionTransportResponse {
  const response: UnionTransportResponse = {
    status: 200,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: jsonText({ time: num('1793433600000'), code: num('0'), msg: '成功', data }),
  };
  if (rawPayloadId !== undefined) {
    Object.defineProperty(response, 'raw_payload_id', { value: rawPayloadId, enumerable: false });
  }
  return response;
}

/** The decoded query string of a GET to the order interface; every name appears once. */
export function query(request: UnionTransportRequest): Record<string, string> {
  const url = new URL(request.url);
  const out: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    expect(Object.hasOwn(out, name), `query field ${name} appears once`).toBe(false);
    out[name] = value;
  }
  return out;
}

export type Answer = (
  query: Record<string, string>,
  signal?: AbortSignal,
) => UnionTransportResponse | Promise<UnionTransportResponse>;

/** The position_index the synthetic upstream gives page `index` of window `windowIndex`. */
export function positionOf(windowIndex: number, index: number): string {
  const head = 1793300000 + windowIndex * 100 + index;
  return `${head}_SYNw${windowIndex}p${index}|${head + 1}_SYNz${windowIndex}p${index}`;
}

/**
 * An upstream holding, per window start (Beijing text), a list of pages. A request without
 * positionIndex gets page 0 of its window; one with the position_index of page i gets page i + 1;
 * anything else gets an empty last page (the request list in the test then shows the mistake).
 */
export function windowAnswer(
  windows: Readonly<Record<string, readonly (readonly unknown[])[]>>,
  rawPayloadId?: (windowIndex: number, index: number) => string,
): Answer {
  const starts = Object.keys(windows);
  return (q) => {
    const windowIndex = starts.indexOf(q.startTime ?? '');
    const pages = windowIndex < 0 ? [] : (windows[starts[windowIndex]!] ?? []);
    let index = 0;
    if (q.positionIndex !== undefined) {
      index = pages.findIndex(
        (_page, i) => i > 0 && positionOf(windowIndex, i - 1) === q.positionIndex,
      );
    }
    if (index < 0 || pages.length === 0) return reply(pageData([], { position: 'unexpected' }));
    return reply(
      pageData(pages[index] ?? [], {
        hasNext: index + 1 < pages.length,
        position: positionOf(windowIndex, index),
      }),
      rawPayloadId?.(windowIndex, index),
    );
  };
}

/** One page holding `rows`, whatever was asked. */
export function onePage(rows: readonly unknown[], rawPayloadId?: string): Answer {
  return () => reply(pageData(rows), rawPayloadId);
}

export interface SetupOptions {
  /** The slot reader's answer; null leaves the reader out. */
  readonly slots?: readonly string[] | null;
  /** false leaves the 大淘客 order source out. */
  readonly source?: boolean;
  readonly overrides?: Partial<TaobaoAdapterOptions>;
}

/**
 * A live TaobaoUnionAdapter whose order source is a real DataokeClient over a fake transport.
 * `requests` are the decoded query strings in arrival order. The TOP transport and credentials
 * belong to the Taobao gateway and must stay untouched by listOrders.
 */
export function setup(answer: Answer = onePage([]), options: SetupOptions = {}) {
  const clock = new FixedClock(instant);
  const requests: Record<string, string>[] = [];
  const transport = vi.fn<UnionTransport>(async (request) => {
    const q = query(request);
    requests.push(q);
    return answer(q, request.signal);
  });
  const dataokeCredentials = vi.fn<() => Promise<DataokeCredentials>>(async () => ({
    appKey: 'fake-dataoke-key',
    appSecret: 'dtk-dtk-dtk-dtk-dtk-dtk',
  }));
  const random = vi.fn<(bound: number) => number>(() => 42);
  const orderSource = new DataokeClient({
    baseUrl: DATAOKE_BASE,
    clock,
    credentials: dataokeCredentials,
    random,
    transport,
  });
  const taobaoCredentials = vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
    appKey: 'fake-taobao-key',
    appSecret: 'plain-plain-plain-plain',
  }));
  const taobaoTransport = vi.fn<UnionTransport>(async () => reply({}));
  const slots = options.slots === undefined ? SLOTS : options.slots;
  const orderSlots = vi.fn<TaobaoOrderSlotReader>(async () => slots ?? []);
  const orderWarn = vi.fn<(event: TaobaoOrderWarning) => void>();
  const adapterOptions: TaobaoAdapterOptions = {
    clock,
    credentials: taobaoCredentials,
    transport: taobaoTransport,
    endpoint,
    orderWarn,
    ...(options.source === false ? {} : { orderSource }),
    ...(slots === null ? {} : { orderSlots }),
    ...options.overrides,
  };
  const adapter = new TaobaoUnionAdapter(adapterOptions);
  return {
    adapter,
    clock,
    requests,
    transport,
    dataokeCredentials,
    taobaoCredentials,
    taobaoTransport,
    orderSlots,
    orderWarn,
  };
}

/** True for the NotImplemented a skeleton throws: it must stay a red of its own. */
function isSkeleton(error: unknown): boolean {
  return error instanceof Error && /\bNotImplemented\b/.test(`${error.name} ${error.message}`);
}

/** The page a listOrders call resolves to; a rejection fails the test as an assertion. */
export async function listed(run: Promise<Page<UnionOrder>>): Promise<Page<UnionOrder>> {
  let page: Page<UnionOrder> | undefined;
  let failure: unknown;
  try {
    page = await run;
  } catch (error) {
    if (isSkeleton(error)) throw error;
    failure = error;
  }
  expect(failure, 'listOrders must resolve').toBeUndefined();
  expect(page).toBeDefined();
  return page!;
}

/** Walks the opaque cursor to the end; rejections propagate (for the governed failure cases). */
export async function walk(
  adapter: UnionAdapter,
  window: TimeWindow = win,
  options: OrderQueryOpt = {},
  call: CallCtx = ctx,
): Promise<{ readonly orders: UnionOrder[]; readonly cursors: string[] }> {
  const orders: UnionOrder[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let calls = 1; calls <= 30; calls += 1) {
    const page = await adapter.listOrders(
      window,
      { ...options, ...(cursor === undefined ? {} : { cursor }) },
      call,
    );
    orders.push(...page.items);
    if (page.nextCursor === null) return { orders, cursors };
    expect(page.nextCursor).toBeTypeOf('string');
    expect(page.nextCursor.length).toBeGreaterThan(0);
    expect(cursors).not.toContain(page.nextCursor);
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
  expect.fail('synthetic pagination must terminate');
}

/** Everything a window holds; every listOrders call must resolve. */
export async function collect(
  adapter: UnionAdapter,
  window: TimeWindow = win,
  options: OrderQueryOpt = {},
  call: CallCtx = ctx,
): Promise<{ readonly orders: UnionOrder[]; readonly cursors: string[] }> {
  const orders: UnionOrder[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let calls = 1; calls <= 30; calls += 1) {
    const page = await listed(
      adapter.listOrders(window, { ...options, ...(cursor === undefined ? {} : { cursor }) }, call),
    );
    orders.push(...page.items);
    if (page.nextCursor === null) return { orders, cursors };
    expect(page.nextCursor).toBeTypeOf('string');
    expect(page.nextCursor.length).toBeGreaterThan(0);
    expect(cursors).not.toContain(page.nextCursor);
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
  expect.fail('synthetic pagination must terminate');
}

/** One row through the whole adapter (one page, our slots). */
export async function one(input: Record<string, unknown>): Promise<UnionOrder> {
  const { adapter } = setup(onePage([input]));
  const { orders } = await collect(adapter);
  expect(orders).toHaveLength(1);
  return orders[0]!;
}

/** A listOrders rejection with `code` (platform taobao); resolving fails as an assertion. */
export async function rejection(run: () => Promise<unknown>, code: string): Promise<UnionError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    if (isSkeleton(error)) throw error;
    caught = error;
  }
  expect(caught).toBeInstanceOf(UnionError);
  expect(caught).toMatchObject({ code, platform: 'taobao' });
  return caught as UnionError;
}

/** The instant of an upstream "YYYY-MM-DD HH:MM:SS" text, which is Beijing time (UTC+8). */
export function beijingMs(text: unknown): number {
  expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  return Date.parse(`${String(text).replace(' ', 'T')}+08:00`);
}

/** Everything a value would print, for redaction checks. */
export function visible(value: unknown): string {
  const replacer = (_key: string, member: unknown) =>
    typeof member === 'bigint' ? member.toString() : member;
  return `${JSON.stringify(value, replacer)}\n${inspect(value, { depth: null })}`;
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

export function govern(adapter: UnionAdapter, take: QuotaLimiter['tryAcquire']): UnionAdapter {
  return createGovernedAdapter(adapter, {
    endpoint,
    scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
  });
}
