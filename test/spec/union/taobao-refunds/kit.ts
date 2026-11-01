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
  type Page,
  type PunishmentQueryOpt,
  type RefundQueryOpt,
  type TimeWindow,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionPunish,
  type UnionRefund,
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
  type TaobaoPunishWarning,
  type TaobaoRefundWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';

// Task-local AC labels ([AC-B1-04z#n]) identify this task's acceptance points, not business rules.
// 报文全部合成：字段名与外层形状来自任务书（大淘客 get-order-refund / get-foul-order-list 的已录外层
// data 与文档明细字段，外层 { time, code, msg, data }），值都是自拟的掩码形状，不是任何录制原值；
// 凭据是低熵合成串。

/** The 大淘客 interfaces and their version (task brief; refunds are GET, not the documented POST). */
export const REFUND_PATH = '/api/tb-service/get-order-refund';
export const PUNISH_PATH = '/api/tb-service/get-foul-order-list';
export const ORDER_PATH = '/api/tb-service/get-order-details';
export const VERSION = 'v1.0.0';
export const DATAOKE_BASE = 'https://dataoke-gateway.invalid';
export const endpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-gateway.invalid/router/rest',
  quotaKey: 'synthetic-taobao-after-sales',
};
export const ctx: CallCtx = {
  appId: 'synthetic-tb-refunds-app',
  requestId: 'synthetic-tb-refunds-request',
  purpose: 'order_sync',
};
/** The injected clock; the windows below do not depend on it. */
export const instant = '2026-10-31T08:00:00.000Z';
export const hourMs = 3_600_000;
export const dayMs = 86_400_000;
/** One hour: Beijing 2026-10-30 10:00:00 – 11:00:00. */
export const win: TimeWindow = { from: '2026-10-30T02:00:00Z', to: '2026-10-30T03:00:00Z' };
export const iso = (ms: number): string => new Date(ms).toISOString();

/** Our promotion slots (one active, one retired) and slots of someone else (shared account). */
export const OUR_ADZONE = '123456789012';
export const RETIRED_ADZONE = '123456789034';
export const FOREIGN_ADZONE = '123456789056';
export const OTHER_FOREIGN_ADZONE = '123456789078';
export const OUR_SLOT = `mm_1000000001_3000000001_${OUR_ADZONE}`;
export const RETIRED_SLOT = `mm_1000000001_3000000001_${RETIRED_ADZONE}`;
export const SLOTS: readonly string[] = [OUR_SLOT, RETIRED_SLOT];

export const TRADE_ID = '2900000000000000101';
export const TRADE_PARENT_ID = '2900000000000000100';
export const REFUND_ID = '3300000000000000101';
export const SETTLE_MONTH = '202610';

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
 * One refund record with every documented field. Amounts are chosen so each field is told apart:
 * base_refund = 7.99 − 0.80 − 0.39 = 6.80, subsidy_refund = 1.20 − 0.12 − 0.08 = 1.00,
 * show_return_fee 6.66; refund_fee / tb_trade_finish_price are not mapped.
 */
export function refundRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tb_trade_id: TRADE_ID,
    tb_trade_parent_id: TRADE_PARENT_ID,
    refund_suit_id: REFUND_ID,
    refund_status: num('4'),
    refund_fee: '88.80',
    tb_trade_finish_price: '88.80',
    show_return_fee: '6.66',
    tk_commission_fee_refund: '7.99',
    tk_commission_alimm_refund_fee: '0.80',
    tk_commission_agent_refund_fee: '0.39',
    tk_subsidy_fee_refund: '1.20',
    tk_subsidy_alimm_refund_fee: '0.12',
    tk_subsidy_agent_refund_fee: '0.08',
    tk_refund_time: '2026-10-30 10:20:00',
    tk_refund_suit_time: '2026-10-30 10:50:00',
    earning_time: '2026-10-30 10:40:00',
    modified_time: '2026-10-30 10:55:30',
    day: '2026-10-30',
    refund_day: '2026-10-30',
    ...overrides,
  };
}

/** A refund told apart by its tb_trade_id / refund_suit_id. */
export function refundOf(index: number): Record<string, unknown> {
  return refundRow({
    tb_trade_id: `${2900000000000001000n + BigInt(index)}`,
    refund_suit_id: `${3300000000000001000n + BigInt(index)}`,
  });
}

/** One punishment record with every documented field. */
export function punishRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tb_trade_id: TRADE_ID,
    relation_id: num('2700000001'),
    settle_month: SETTLE_MONTH,
    punish_status: num('0'),
    violation_type: num('1'),
    tk_trade_create_time: '2026-10-30 10:00:01',
    tk_adzone_id: num(OUR_ADZONE),
    tk_site_id: num('3000000001'),
    tk_pub_id: num('1000000001'),
    day: '2026-10-30',
    ...overrides,
  };
}

/** A punishment told apart by its tb_trade_id and placed on `adzone`. */
export function punishOf(index: number, adzone: string = OUR_ADZONE): Record<string, unknown> {
  return punishRow({
    tb_trade_id: `${2900000000000002000n + BigInt(index)}`,
    tk_adzone_id: num(adzone),
  });
}

/** The position_index the synthetic upstream gives page `index` of window `windowIndex`. */
export function positionOf(windowIndex: number, index: number): string {
  const head = 1793300000 + windowIndex * 100 + index;
  return `${head}_|${head + 1}_`;
}

/** The `data` object of one refund page (recorded outer shape). */
export function refundData(
  rows: unknown,
  options: { readonly hasNext?: boolean; readonly position?: string | null } = {},
): Record<string, unknown> {
  return {
    has_next: options.hasNext ?? false,
    has_pre: false,
    next_page: num('2'),
    pre_page: num('0'),
    page_no: num('1'),
    page_size: num('100'),
    position_index: options.position === null ? undefined : (options.position ?? positionOf(9, 9)),
    result: rows,
  };
}

/** The `data` object of one punishment page (recorded outer shape). */
export function punishData(
  rows: unknown,
  total: number | null,
  pageNo = 1,
): Record<string, unknown> {
  return {
    page_no: num(String(pageNo)),
    page_size: num('10'),
    total_count: total === null ? undefined : num(String(total)),
    results: rows,
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

export function failureReply(status: number): UnionTransportResponse {
  return { status, headers: { 'content-type': 'text/plain' }, body: 'synthetic outage' };
}

/** One request as the fake transport saw it: the path and the decoded query string. */
export interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly request: UnionTransportRequest;
}

function decode(request: UnionTransportRequest): Call {
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    expect(Object.hasOwn(query, name), `query field ${name} appears once`).toBe(false);
    query[name] = value;
  }
  return { method: request.method, path: url.pathname, query, request };
}

export type Answer = (
  call: Call,
  signal?: AbortSignal,
) => UnionTransportResponse | Promise<UnionTransportResponse>;

/** Pages of a synthetic upstream, keyed by the Beijing startTime of the window / segment. */
export type Pages = Readonly<Record<string, readonly (readonly unknown[])[]>>;

/**
 * A refund upstream holding, per window start (Beijing text), a list of pages. A request without
 * positionIndex gets page 0 of its window; one with the position_index of page i gets page i + 1;
 * anything else gets an empty last page (the request list in the test then shows the mistake).
 */
export function refundAnswer(windows: Pages): Answer {
  const starts = Object.keys(windows);
  return ({ query: q }) => {
    const windowIndex = starts.indexOf(q.startTime ?? '');
    const pages: readonly (readonly unknown[])[] =
      windowIndex < 0 ? [] : (windows[starts[windowIndex]!] ?? []);
    let index = 0;
    if (q.positionIndex !== undefined) {
      index = pages.findIndex(
        (_page, i) => i > 0 && positionOf(windowIndex, i - 1) === q.positionIndex,
      );
    }
    if (index < 0 || pages.length === 0) return reply(refundData([], { position: '0_|0_' }));
    return reply(
      refundData(pages[index] ?? [], {
        hasNext: index + 1 < pages.length,
        position: positionOf(windowIndex, index),
      }),
    );
  };
}

/** One refund page holding `rows`, whatever was asked. */
export function refundPage(rows: readonly unknown[]): Answer {
  return () => reply(refundData(rows));
}

/**
 * A punishment upstream holding, per segment start (Beijing text), a list of pages; pageNo n gets
 * page n − 1 and total_count is every row of the segment (other slots included). A pageNo past the
 * last page gets an empty page with the same total_count.
 */
export function punishAnswer(segments: Pages): Answer {
  return ({ query: q }) => {
    const pages: readonly (readonly unknown[])[] = segments[q.startTime ?? ''] ?? [];
    const total = pages.reduce((sum, page) => sum + page.length, 0);
    const pageNo = Number(q.pageNo ?? '1');
    return reply(punishData(pages[pageNo - 1] ?? [], total, pageNo));
  };
}

/** One punishment page holding `rows` (total_count = rows.length), whatever was asked. */
export function punishPage(rows: readonly unknown[]): Answer {
  return ({ query: q }) => reply(punishData(rows, rows.length, Number(q.pageNo ?? '1')));
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
 * `calls` are the decoded requests in arrival order. The TOP transport and credentials belong to
 * the Taobao gateway and must stay untouched by listRefunds / listPunishments.
 */
export function setup(answer: Answer = refundPage([]), options: SetupOptions = {}) {
  const clock = new FixedClock(instant);
  const calls: Call[] = [];
  const transport = vi.fn<UnionTransport>(async (request) => {
    const call = decode(request);
    calls.push(call);
    return answer(call, request.signal);
  });
  const dataokeCredentials = vi.fn<() => Promise<DataokeCredentials>>(async () => ({
    appKey: 'fake-dataoke-key',
    appSecret: 'dtk-dtk-dtk-dtk-dtk-dtk',
  }));
  const orderSource = new DataokeClient({
    baseUrl: DATAOKE_BASE,
    clock,
    credentials: dataokeCredentials,
    random: () => 42,
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
  const refundWarn = vi.fn<(event: TaobaoRefundWarning) => void>();
  const punishWarn = vi.fn<(event: TaobaoPunishWarning) => void>();
  const adapterOptions: TaobaoAdapterOptions = {
    clock,
    credentials: taobaoCredentials,
    transport: taobaoTransport,
    endpoint,
    orderWarn,
    refundWarn,
    punishWarn,
    ...(options.source === false ? {} : { orderSource }),
    ...(slots === null ? {} : { orderSlots }),
    ...options.overrides,
  };
  const adapter = new TaobaoUnionAdapter(adapterOptions);
  return {
    adapter,
    clock,
    calls,
    /** Query strings of the calls, in order. */
    get requests(): Record<string, string>[] {
      return calls.map((call) => call.query);
    },
    transport,
    dataokeCredentials,
    taobaoCredentials,
    taobaoTransport,
    orderSlots,
    orderWarn,
    refundWarn,
    punishWarn,
  };
}

/** True for the NotImplemented a skeleton throws: it must stay a red of its own. */
function isSkeleton(error: unknown): boolean {
  return error instanceof Error && /\bNotImplemented\b/.test(`${error.name} ${error.message}`);
}

/** The page a call resolves to; a rejection fails the test as an assertion. */
export async function listed<T>(run: Promise<Page<T>> | undefined): Promise<Page<T>> {
  let page: Page<T> | undefined;
  let failure: unknown;
  try {
    page = await run;
  } catch (error) {
    if (isSkeleton(error)) throw error;
    failure = error;
  }
  expect(failure, 'the call must resolve').toBeUndefined();
  expect(page).toBeDefined();
  return page!;
}

/** A rejection with `code` (platform taobao when a UnionError); resolving fails as an assertion. */
export async function rejection(
  run: () => Promise<unknown> | undefined,
  code: string,
): Promise<unknown> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    if (isSkeleton(error)) throw error;
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code });
  if (caught instanceof UnionError) expect(caught.platform).toBe('taobao');
  return caught;
}

type Lister<T, O> = (window: TimeWindow, call: CallCtx, opt: O) => Promise<Page<T>> | undefined;

async function drain<T, O extends { readonly cursor?: string }>(
  list: Lister<T, O>,
  window: TimeWindow,
  options: O,
  call: CallCtx,
  strict: boolean,
): Promise<{ readonly items: T[]; readonly cursors: string[] }> {
  const items: T[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let calls = 1; calls <= 40; calls += 1) {
    const opt = { ...options, ...(cursor === undefined ? {} : { cursor }) };
    const run = list(window, call, opt);
    const page: Page<T> | undefined = strict ? await listed(run) : await run;
    expect(page, 'the operation must exist').toBeDefined();
    items.push(...(page?.items ?? []));
    const next = page?.nextCursor ?? null;
    if (next === null) return { items, cursors };
    expect(next).toBeTypeOf('string');
    expect(next.length).toBeGreaterThan(0);
    expect(cursors).not.toContain(next);
    cursors.push(next);
    cursor = next;
  }
  expect.fail('synthetic pagination must terminate');
}

/** Every refund of a window, following nextCursor; every call must resolve. */
export function refunds(
  adapter: UnionAdapter,
  window: TimeWindow = win,
  options: RefundQueryOpt = {},
  call: CallCtx = ctx,
): Promise<{ readonly items: UnionRefund[]; readonly cursors: string[] }> {
  return drain<UnionRefund, RefundQueryOpt>(
    (w, c, o) => adapter.listRefunds?.(w, c, o),
    window,
    options,
    call,
    true,
  );
}

/** Same as refunds, but a rejection propagates (for the governed failure cases). */
export function walkRefunds(
  adapter: UnionAdapter,
  window: TimeWindow = win,
  options: RefundQueryOpt = {},
  call: CallCtx = ctx,
): Promise<{ readonly items: UnionRefund[]; readonly cursors: string[] }> {
  return drain<UnionRefund, RefundQueryOpt>(
    (w, c, o) => adapter.listRefunds?.(w, c, o),
    window,
    options,
    call,
    false,
  );
}

/** Every punishment of a window, following nextCursor; every call must resolve. */
export function punishments(
  adapter: UnionAdapter,
  window: TimeWindow = win,
  options: PunishmentQueryOpt = {},
  call: CallCtx = ctx,
): Promise<{ readonly items: UnionPunish[]; readonly cursors: string[] }> {
  return drain<UnionPunish, PunishmentQueryOpt>(
    (w, c, o) => adapter.listPunishments?.(w, c, o),
    window,
    options,
    call,
    true,
  );
}

/** One refund record through the whole adapter (one page). */
export async function oneRefund(input: unknown): Promise<UnionRefund> {
  const { adapter } = setup(refundPage([input]));
  const { items } = await refunds(adapter);
  expect(items).toHaveLength(1);
  return items[0]!;
}

/** The instant of a Beijing "YYYY-MM-DD HH:MM:SS" text (UTC+8). */
export function beijingMs(text: unknown): number {
  expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  return Date.parse(`${String(text).replace(' ', 'T')}+08:00`);
}

/** A Date at the instant of a Beijing wall-clock text. */
export function beijingDate(text: string): Date {
  return new Date(beijingMs(text));
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
