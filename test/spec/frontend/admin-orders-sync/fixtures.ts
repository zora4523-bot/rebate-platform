import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import { BASE_URL, NUMBER, OID, detail, rows } from '../admin-orders/orders-fixtures.ts';

// Contract-shaped fixtures of the manual order sync (CT-24n, tag admin-orders):
// adminCreateOrderSync POST /admin/v1/order-syncs (order.view, no step-up, no Idempotency-Key;
// exactly one of the time window form and the order number form), adminListOrderSyncs GET
// /admin/v1/order-syncs (page / page_size only) and adminGetOrderSyncLimits GET
// /admin/v1/order-syncs/limits, next to the two order reads of F1-07e. The order list rows and the
// detail come read-only from the frozen F1-07e fixtures; everything else is written here. Ids are
// obvious fake UUIDs, order numbers obvious samples.
export { BASE_URL, NUMBER, OID };
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const ORDERS = '/admin/v1/orders';
export const SYNCS = '/admin/v1/order-syncs';
export const LIMITS = '/admin/v1/order-syncs/limits';
export const DETAIL_PATH = `${ORDERS}/${OID}`;
export const DETAIL_ROUTE = `/orders/${OID}`;
/** The detail sample is a jd order with its own number, so 【同步此单】 must read both from it. */
export const DETAIL_PLATFORM = 'jd';
export const DETAIL_NUMBER = '231009-5550000001';
/** The earliest window start of every platform in the default limits. */
export const EARLIEST = '2026-07-24T00:00:00+08:00';
/** The admin recorded on sync requests. */
export const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
export const ADMIN_NAME = '客服小林';

export type Platform = Schema<'PlatformCode'>;
export type Detail = Schema<'AdminOrderDetail'>;
export type SyncItem = Schema<'AdminOrderSyncListItem'>;
export type SyncLimit = Schema<'AdminOrderSyncPlatformLimit'>;
export type SyncCreated = Schema<'AdminOrderSyncCreated'>;
export type SyncStatus = Schema<'AdminOrderSyncStatus'>;

/** How the page may name a platform (its Chinese name or the code). */
export const PLATFORM_NAME: Readonly<Record<'pdd' | 'taobao' | 'jd', RegExp>> = {
  pdd: /拼多多|pdd/,
  taobao: /淘宝|taobao/,
  jd: /京东|jd/,
};
/** Any platform other than pdd and taobao. */
export const OTHER_PLATFORMS =
  /京东|美团|唯品会|抖音|饿了么|快手|苏宁|\bjd\b|meituan|\bvip\b|douyin|eleme|kuaishou|suning/;

export function jdDetail(): Detail {
  return detail({
    platform: DETAIL_PLATFORM,
    sub_order_id: DETAIL_NUMBER,
    parent_order_id: null,
  });
}

/** One limit per platform (pdd, taobao, jd), `max` order numbers each. */
export function limits(max = 50): SyncLimit[] {
  const platforms: Platform[] = ['pdd', 'taobao', 'jd'];
  return platforms.map((platform) => ({ platform, earliest_from: EARLIEST, max_order_nos: max }));
}

// ---- sync records ----------------------------------------------------------------------------

/** What identifies each sample record on screen, and its Beijing creation time (MM-DD HH:mm). */
export const RECORD = {
  /** taobao, two order numbers, queued; created 09:00Z = 17:00 Beijing. */
  queued: {
    status: 'queued',
    platform: 'taobao',
    marker: '231008-7770000001',
    created: '10-22 17:00',
  },
  /** pdd, one order number, done. */
  done: { status: 'done', platform: 'pdd', marker: '231012-4440000001', created: '10-22 10:05' },
  /** pdd, window 10-21 00:00 – 10-22 00:00 Beijing, running. */
  running: { status: 'running', platform: 'pdd', marker: '10-21 00:00', created: '10-22 10:00' },
  /** jd, window 10-20 00:00 – 10-20 12:00 Beijing (given in Z), failed. */
  failed: { status: 'failed', platform: 'jd', marker: '10-20 12:00', created: '10-21 09:30' },
} as const;

function record(fields: Pick<SyncItem, 'sync_id' | 'created_at'> & Partial<SyncItem>): SyncItem {
  const base: SyncItem = {
    sync_id: fields.sync_id,
    platform: 'pdd',
    mode: 'order_nos',
    from: null,
    to: null,
    status_filter: null,
    order_nos: null,
    status: 'queued',
    requested_by: ADMIN,
    requested_by_name: ADMIN_NAME,
    fetched_count: 0,
    stored_count: 0,
    created_at: fields.created_at,
    finished_at: null,
  };
  return { ...base, ...fields };
}

/** The four samples, created_at descending (as the server pages them). */
export function syncRecords(): SyncItem[] {
  return [
    record({
      sync_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6b04',
      platform: 'taobao',
      mode: 'order_nos',
      order_nos: ['231008-7770000001', '231008-7770000002'],
      status: 'queued',
      created_at: '2026-10-22T09:00:00Z',
    }),
    record({
      sync_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6b03',
      platform: 'pdd',
      mode: 'order_nos',
      order_nos: ['231012-4440000001'],
      status: 'done',
      fetched_count: 1,
      stored_count: 1,
      created_at: '2026-10-22T10:05:00+08:00',
      finished_at: '2026-10-22T10:05:09+08:00',
    }),
    record({
      sync_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6b02',
      platform: 'pdd',
      mode: 'window',
      from: '2026-10-21T00:00:00+08:00',
      to: '2026-10-22T00:00:00+08:00',
      status: 'running',
      fetched_count: 120,
      stored_count: 118,
      created_at: '2026-10-22T10:00:00+08:00',
    }),
    record({
      sync_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6b01',
      platform: 'jd',
      mode: 'window',
      from: '2026-10-19T16:00:00Z',
      to: '2026-10-20T04:00:00Z',
      status: 'failed',
      created_at: '2026-10-21T01:30:00Z',
      finished_at: '2026-10-21T01:31:00Z',
    }),
  ];
}

// ---- console dictionary (BR-TEXT-25 admin_dict) --------------------------------------------

function dictionaryTexts(): Readonly<Record<string, string>> {
  return (dictionary as { texts?: Record<string, string> }).texts ?? {};
}
/** The dictionary name of a sync status (read when the test runs), else the code itself. */
export function statusName(code: SyncStatus): string {
  return dictionaryTexts()[`admin_dict.order_sync_requests.status.${code}`] ?? code;
}

// ---- envelopes -------------------------------------------------------------------------------

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
// HTTP statuses as in contracts/error-codes.yaml.
const STATUS: Record<number, number> = {
  10001: 401,
  10403: 403,
  20001: 400,
  30156: 422,
  42901: 429,
  50001: 500,
};
/** An error envelope; `data` is left out when undefined. */
export function failure(code: number, data?: unknown, msg = '参数错误'): Response {
  const envelope: Record<string, unknown> = { code, msg, trace_id: TRACE_ID };
  if (data !== undefined) envelope['data'] = data;
  return Response.json(envelope, { status: STATUS[code] ?? 400 });
}
export function rejected(fields: readonly string[]): Response {
  return failure(20001, { fields });
}
export function denied(): Response {
  return failure(10403, { reason: 'admin_permission_denied' }, '无权限');
}
/** 30156: the platform's sync stream is paused with the site owner's authorization. */
export function streamPaused(platform: Platform): Response {
  return failure(30156, { platform }, '该平台的站长授权已暂停，暂不能手动同步');
}
/** 429 TooManyRequests (42901) with its required Retry-After. */
export function rateLimited(): Response {
  return Response.json(
    { code: 42901, msg: '请求过于频繁', trace_id: TRACE_ID },
    { status: 429, headers: { 'Retry-After': '30' } },
  );
}
/** A network failure (the request never got an answer). */
export function networkDown(): Promise<Response> {
  return Promise.reject(new TypeError('Failed to fetch'));
}

// ---- the fake server -------------------------------------------------------------------------

export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;

export interface ServerOptions {
  readonly limits?: readonly SyncLimit[];
  readonly records?: readonly SyncItem[];
  /** Platforms whose sync stream is paused (POST answers 30156). */
  readonly paused?: readonly Platform[];
  readonly detail?: Detail;
}

const ORDER_DETAIL =
  /^\/admin\/v1\/orders\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const BODY_FIELDS: readonly string[] = ['platform', 'from', 'to', 'status_filter', 'order_nos'];
const PAGE_FIELDS: readonly string[] = ['page', 'page_size'];
const POSITIVE = /^[1-9][0-9]*$/;
/** The contract's ceiling of order numbers per request. */
const CONTRACT_MAX_ORDER_NOS = 50;

function isTime(value: unknown): value is string {
  return typeof value === 'string' && OFFSET_TIME.test(value) && !Number.isNaN(Date.parse(value));
}
/** The body with its keys sorted (two bodies are the same filter when these are equal). */
function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

/** Fake /admin/v1 server: the F1-07e order reads plus the three CT-24n operations. */
export function createServer(options: ServerOptions = {}) {
  const limitState = structuredClone([...(options.limits ?? limits())]);
  const recordState = structuredClone([...(options.records ?? syncRecords())]);
  const paused = options.paused ?? [];
  const orderDetail = structuredClone(options.detail ?? jdDetail());
  const created: SyncItem[] = [];
  const byFilter = new Map<string, SyncItem>();
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply; persistent: boolean }[] = [];
  let inFlight = 0;

  function pageQuery(query: Record<string, string>, extra: readonly string[]) {
    const invalid = [
      ...Object.keys(query).filter((name) => !PAGE_FIELDS.includes(name) && !extra.includes(name)),
      ...(query['page'] === undefined || POSITIVE.test(query['page']) ? [] : ['page']),
      ...(query['page_size'] === undefined ||
      (POSITIVE.test(query['page_size']) && Number(query['page_size']) <= 200)
        ? []
        : ['page_size']),
    ];
    const page = query['page'] === undefined ? 1 : Number(query['page']);
    const size = query['page_size'] === undefined ? 20 : Number(query['page_size']);
    return { invalid, page, size };
  }

  function listOrders(query: Record<string, string>): Response {
    const { invalid, page, size } = pageQuery(query, [
      'platform',
      'platform_status',
      'rebate_status',
      'flag',
      'q',
      'user_id',
      'paid_from',
      'paid_to',
    ]);
    if (invalid.length > 0) return rejected(invalid);
    const items = rows();
    return ok({
      items: items.slice((page - 1) * size, page * size),
      page,
      page_size: size,
      total: items.length,
    });
  }

  function listSyncs(query: Record<string, string>): Response {
    const { invalid, page, size } = pageQuery(query, []);
    if (invalid.length > 0) return rejected(invalid);
    return ok({
      items: recordState.slice((page - 1) * size, page * size),
      page,
      page_size: size,
      total: recordState.length,
    });
  }

  function createSync(body: unknown): Response {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return rejected(['body']);
    const value = body as Record<string, unknown>;
    const extra = Object.keys(value).filter((name) => !BODY_FIELDS.includes(name));
    if (extra.length > 0) return rejected(extra);
    const limit = limitState.find((one) => one.platform === value['platform']);
    if (limit === undefined) return rejected(['platform']);
    const windowForm = 'from' in value || 'to' in value || 'status_filter' in value;
    const numberForm = 'order_nos' in value;
    if (windowForm && numberForm) return rejected(['order_nos']);
    if (!windowForm && !numberForm) return rejected(['from', 'to']);
    if (windowForm) {
      const { from, to, status_filter: statusFilter } = value;
      const bad = [...(isTime(from) ? [] : ['from']), ...(isTime(to) ? [] : ['to'])];
      if (bad.length > 0) return rejected(bad);
      if (Date.parse(from as string) >= Date.parse(to as string)) return rejected(['from', 'to']);
      if (Date.parse(from as string) < Date.parse(limit.earliest_from)) return rejected(['from']);
      if (
        statusFilter !== undefined &&
        (typeof statusFilter !== 'string' || statusFilter.length < 1 || statusFilter.length > 64)
      )
        return rejected(['status_filter']);
    } else {
      const nos = value['order_nos'];
      if (
        !Array.isArray(nos) ||
        nos.length < 1 ||
        nos.length > Math.min(CONTRACT_MAX_ORDER_NOS, limit.max_order_nos) ||
        nos.some((no) => typeof no !== 'string' || no.length < 1 || no.length > 64)
      )
        return rejected(['order_nos']);
    }
    if (paused.includes(limit.platform)) return streamPaused(limit.platform);
    const filter = canonical(value);
    const same = byFilter.get(filter);
    if (same !== undefined && (same.status === 'queued' || same.status === 'running'))
      return ok({
        sync_id: same.sync_id,
        status: same.status,
        reused: true,
        created_at: same.created_at,
      } satisfies SyncCreated);
    const n = created.length + 1;
    const made: SyncItem = {
      sync_id: `0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f7${String(n).padStart(3, '0')}`,
      platform: limit.platform,
      mode: numberForm ? 'order_nos' : 'window',
      from: numberForm ? null : (value['from'] as string),
      to: numberForm ? null : (value['to'] as string),
      status_filter:
        !numberForm && typeof value['status_filter'] === 'string' ? value['status_filter'] : null,
      order_nos: numberForm ? [...(value['order_nos'] as string[])] : null,
      status: 'queued',
      requested_by: ADMIN,
      requested_by_name: ADMIN_NAME,
      fetched_count: 0,
      stored_count: 0,
      created_at: `2026-10-31T10:${String(n).padStart(2, '0')}:00+08:00`,
      finished_at: null,
    };
    created.push(made);
    byFilter.set(filter, made);
    recordState.unshift(made);
    return ok({
      sync_id: made.sync_id,
      status: made.status,
      reused: false,
      created_at: made.created_at,
    } satisfies SyncCreated);
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token')
      return failure(10001, undefined, '未登录');
    if (method === 'GET' && path === ORDERS) return listOrders(request.query);
    if (method === 'GET' && path === DETAIL_PATH) return ok(orderDetail);
    if (method === 'GET' && path === LIMITS) return ok({ items: limitState });
    if (method === 'GET' && path === SYNCS) return listSyncs(request.query);
    if (method === 'POST' && path === SYNCS) return createSync(request.body);
    return rejected([method === 'GET' ? 'order_id' : 'unexpected_write']);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const request: RequestLog = {
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : undefined,
    };
    log.push(request);
    inFlight += 1;
    try {
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      if (index < 0) return normal(request);
      const entry = overrides[index]!;
      if (!entry.persistent) overrides.splice(index, 1);
      return await entry.reply(request);
    } finally {
      inFlight -= 1;
    }
  };

  /** The requests this part may send: the F1-07e order reads and the three CT-24n operations. */
  const isAllowed = (request: RequestLog): boolean =>
    (request.method === 'GET' &&
      (request.path === ORDERS ||
        ORDER_DETAIL.test(request.path) ||
        request.path === LIMITS ||
        request.path === SYNCS)) ||
    (request.method === 'POST' && request.path === SYNCS);

  return {
    log,
    fetch,
    get pending() {
      return inFlight;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    /** POST /admin/v1/order-syncs. */
    posts() {
      return log.filter((r) => r.method === 'POST' && r.path === SYNCS);
    },
    /** GET /admin/v1/order-syncs/limits. */
    limitReads() {
      return log.filter((r) => r.method === 'GET' && r.path === LIMITS);
    },
    /** GET /admin/v1/order-syncs (the sync records). */
    recordReads() {
      return log.filter((r) => r.method === 'GET' && r.path === SYNCS);
    },
    /** Every request to /admin/v1/order-syncs or below it. */
    syncRequests() {
      return log.filter((r) => r.path === SYNCS || r.path.startsWith(`${SYNCS}/`));
    },
    /** The sync requests the server created (reused and refused ones not counted). */
    created() {
      return [...created];
    },
    /** Requests outside the allowed reads and the sync write. */
    unexpected() {
      return log.filter((r) => !isAllowed(r)).map((r) => `${r.method} ${r.path}`);
    },
    /** Answers the next request of `method` `path` with `reply`. */
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply, persistent: false });
    },
    /**
     * Holds every request of `method` `path` until the returned call; then the held ones and later
     * ones are answered as usual.
     */
    hold(method: string, path: string) {
      const gate = Promise.withResolvers<void>();
      const entry = {
        method,
        path,
        persistent: true,
        reply: async (request: RequestLog) => {
          await gate.promise;
          return normal(request);
        },
      };
      overrides.push(entry);
      return () => {
        const index = overrides.indexOf(entry);
        if (index >= 0) overrides.splice(index, 1);
        gate.resolve();
      };
    },
  };
}
export type Server = ReturnType<typeof createServer>;
