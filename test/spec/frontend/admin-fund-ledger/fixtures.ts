import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the merged CT-24zb (contracts/openapi.yaml, tag
// admin-asset-snapshots, implemented by B2-09e): listAdminAssetSnapshots GET
// /admin/v1/asset-snapshots, permission point fund.view, read only. The fake server checks in the
// order the description gives (session, permission point, parameter formats, date range) and
// answers snapshot_date descending, page by page. A day without a snapshot simply has no row.
// Amounts are samples in integer fen; within a row every amount differs, so a value shown under
// another column (or another platform) fails. Platform names are read from the console dictionary
// when the test runs, else the names the existing console pages use (texts/orders.ts and others),
// else the code itself.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const MENU_ID = 'fund-ledger';
export const LIST = '/admin/v1/asset-snapshots';
export const VERIFY = '/admin/v1/auth/step-up';
/** Reads the shell itself may send (the account's permission points); nothing else is allowed. */
export const SHELL_READS: readonly string[] = ['/admin/v1/me/permissions'];

export type Snapshot = Schema<'AdminAssetSnapshot'>;
export type Receivable = Schema<'AdminAssetSnapshotReceivable'>;
export type Platform = Schema<'PlatformCode'>;

// ---- platform names ------------------------------------------------------------------------

/** Where the console dictionary would keep platform names (no row today). */
const DICT_PLATFORM = /^admin_dict\.(?:[a-z_]+\.)*platforms?\.([^.]+)$/;
/** The names the existing console pages show for these platforms (texts/orders.ts, claims.ts). */
const PAGE_NAMES: Readonly<Record<string, readonly string[]>> = {
  taobao: ['淘宝'],
  jd: ['京东'],
  pdd: ['拼多多'],
};

function dictionaryTexts(): Readonly<Record<string, string>> {
  return (dictionary as { texts?: Record<string, string> }).texts ?? {};
}
/** The dictionary's names for the platform `code` (read when the test runs; empty when none). */
export function dictNames(code: string): string[] {
  return Object.entries(dictionaryTexts()).flatMap(([name, value]) =>
    DICT_PLATFORM.exec(name)?.[1] === code ? [value] : [],
  );
}
function escapeText(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * What the page shows for the platform `code`: a dictionary name, the name the console pages use,
 * or the code as a whole word.
 */
export function platformPattern(code: string): RegExp {
  const names = [...dictNames(code), ...(PAGE_NAMES[code] ?? [])].map(escapeText);
  const word = `(?<![A-Za-z0-9_])${escapeText(code)}(?![A-Za-z0-9_])`;
  return new RegExp([...names, word].join('|'));
}

// ---- samples -------------------------------------------------------------------------------

/** The snapshot days of the samples (2026-10-27 has no snapshot: no row, no zeros). */
export const DAY = {
  /** Three platforms, one with a negative receivable (pdd −2300 fen). */
  latest: '2026-10-29',
  /** waiting_comparable=false (the snapshot was confirmed late); taobao only. */
  late: '2026-10-28',
  /** Not written: the list has no row for it. */
  missing: '2026-10-27',
  /** total_negative_fen 0; jd and taobao. */
  older: '2026-10-26',
  /** No receivable at all (receivables []), total_waiting_fen 0. */
  bare: '2026-10-25',
} as const;

/** A platform code the console has no name for (a platform added later): its code shows. */
export const UNNAMED_PLATFORM = 'xianyu';

/**
 * A receivable row for any platform code, including one the contract enum does not list yet (the
 * console shows a code it has no name for as the code).
 */
export function receivableOf(platform: string, fen: number): Receivable {
  return { platform: platform as Platform, union_receivable_fen: fen };
}

/** The four samples, snapshot_date descending (the list's order). */
export function snapshots(): Snapshot[] {
  return [
    {
      snapshot_date: DAY.latest,
      total_available_positive_fen: 1250034,
      total_negative_fen: 3217,
      total_frozen_fen: 48006,
      total_waiting_fen: 860071,
      total_estimated_fen: 2310089,
      waiting_comparable: true,
      receivables: [
        { platform: 'jd', union_receivable_fen: 151005 },
        { platform: 'pdd', union_receivable_fen: -2300 },
        { platform: 'taobao', union_receivable_fen: 864012 },
      ],
      created_at: '2026-10-30T00:01:02+08:00',
      updated_at: '2026-10-30T00:01:03+08:00',
    },
    {
      snapshot_date: DAY.late,
      total_available_positive_fen: 1198012,
      total_negative_fen: 4105,
      total_frozen_fen: 52040,
      total_waiting_fen: 845003,
      total_estimated_fen: 2287019,
      waiting_comparable: false,
      receivables: [{ platform: 'taobao', union_receivable_fen: 850550 }],
      created_at: '2026-10-29T00:31:10+08:00',
      updated_at: '2026-10-29T00:31:10+08:00',
    },
    {
      snapshot_date: DAY.older,
      total_available_positive_fen: 1100450,
      total_negative_fen: 0,
      total_frozen_fen: 61,
      total_waiting_fen: 830120,
      total_estimated_fen: 2200300,
      waiting_comparable: true,
      receivables: [
        { platform: 'jd', union_receivable_fen: 98765 },
        { platform: 'taobao', union_receivable_fen: 701234 },
      ],
      created_at: '2026-10-27T00:01:05+08:00',
      updated_at: '2026-10-27T00:01:06+08:00',
    },
    {
      snapshot_date: DAY.bare,
      total_available_positive_fen: 900000,
      total_negative_fen: 1500,
      total_frozen_fen: 2500,
      total_waiting_fen: 0,
      total_estimated_fen: 300000,
      waiting_comparable: true,
      receivables: [],
      created_at: '2026-10-26T00:01:04+08:00',
      updated_at: '2026-10-26T00:01:04+08:00',
    },
  ];
}

/** The day `count` days before `day` (YYYY-MM-DD). */
export function dayBefore(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date - count)).toISOString().slice(0, 10);
}

/** `count` consecutive daily snapshots from `first` backwards (for paging). */
export function dailySnapshots(count: number, first: string = DAY.latest): Snapshot[] {
  return Array.from({ length: count }, (_, index): Snapshot => {
    const day = dayBefore(first, index);
    return {
      snapshot_date: day,
      total_available_positive_fen: 100000 + index,
      total_negative_fen: 300,
      total_frozen_fen: 200,
      total_waiting_fen: 400,
      total_estimated_fen: 500,
      waiting_comparable: true,
      receivables: [{ platform: 'taobao', union_receivable_fen: 600 }],
      created_at: `${dayBefore(day, -1)}T00:01:00+08:00`,
      updated_at: `${dayBefore(day, -1)}T00:01:00+08:00`,
    };
  });
}

// ---- permissions ---------------------------------------------------------------------------

/** Permission points an account holds. */
export type Grants = readonly KnownPermission[];
/** fund.view: reads; the menu stays hidden (the menu only knows fund.cash_entry). */
export const VIEW_GRANTS: Grants = ['fund.view'];
/** A finance account with the menu (fund.cash_entry) and the read (fund.view). */
export const LEDGER_GRANTS: Grants = ['fund.view', 'fund.cash_entry'];
/** The menu point alone: no read. */
export const ENTRY_GRANTS: Grants = ['fund.cash_entry'];

/** Permission snapshot; nothing this page does needs a step-up. */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of permissions) stepUp[point] = { tier: null, operations: {} };
  return { isSuper: false, permissions, stepUp };
}
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

// ---- envelopes -----------------------------------------------------------------------------

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
// HTTP statuses as in contracts/error-codes.yaml.
const STATUS: Record<number, number> = {
  10001: 401,
  10403: 403,
  20001: 400,
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
export function unavailable(): Response {
  return failure(50001, undefined, '服务暂时不可用');
}

// ---- fake server ---------------------------------------------------------------------------

export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;
/** Which requests an override answers (all of its method and path when left out). */
export type When = (request: RequestLog) => boolean;
interface Override {
  readonly method: string;
  readonly path: string;
  readonly when: When | undefined;
  readonly reply: Reply;
  readonly persistent: boolean;
}

export interface ServerOptions {
  /** Permission points of the account (the server checks fund.view; 10403 otherwise). */
  readonly permissions?: Grants;
}

/** Every query parameter listAdminAssetSnapshots takes. */
export const LIST_PARAMS: readonly string[] = ['page', 'page_size', 'date_from', 'date_to'];
/** Its filter parameters (everything but paging). */
export const FILTER_PARAMS: readonly string[] = ['date_from', 'date_to'];

const POSITIVE = /^[1-9][0-9]*$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** A real calendar day written YYYY-MM-DD. */
function isDay(value: string): boolean {
  const found = DATE.exec(value);
  if (found === null) return false;
  const [year, month, date] = [Number(found[1]), Number(found[2]), Number(found[3])];
  const real = new Date(Date.UTC(year, month - 1, date));
  return real.toISOString().slice(0, 10) === value;
}

/**
 * A list query of the snapshot table under exactly the filters `filters` (a parameter not named
 * there is absent). A count read (one row asked for, page_size=1) is not a table read.
 */
export function isTableQuery(
  query: Readonly<Record<string, string>>,
  filters: Readonly<Record<string, string>> = {},
): boolean {
  if (query['page_size'] === '1') return false;
  return FILTER_PARAMS.every((name) => query[name] === filters[name]);
}
/** Matches the table read of the list under `filters` (see isTableQuery). */
export function tableRead(filters: Readonly<Record<string, string>> = {}): When {
  return (request) =>
    request.method === 'GET' && request.path === LIST && isTableQuery(request.query, filters);
}

function pageInvalid(page: string | undefined, size: string | undefined): string[] {
  return [
    ...(page === undefined || POSITIVE.test(page) ? [] : ['page']),
    ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
  ];
}
function pageOf<T>(rows: readonly T[], page: string | undefined, size: string | undefined) {
  const pageNo = page === undefined ? 1 : Number(page);
  const pageSize = size === undefined ? 20 : Number(size);
  const items = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return { items, page: pageNo, page_size: pageSize, total: rows.length };
}

/** Fake /admin/v1 server with the CT-24zb checks. */
export function createServer(initial: Snapshot[] = snapshots(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const log: RequestLog[] = [];
  const overrides: Override[] = [];
  const permissions = options.permissions ?? LEDGER_GRANTS;
  let inFlight = 0;

  function remove(entry: Override): void {
    const index = overrides.indexOf(entry);
    if (index >= 0) overrides.splice(index, 1);
  }

  function list(query: Record<string, string>): Response {
    if (!permissions.includes('fund.view')) return denied();
    const { date_from: from, date_to: to, page, page_size: size } = query;
    const invalid = [
      ...pageInvalid(page, size),
      ...(from === undefined || isDay(from) ? [] : ['date_from']),
      ...(to === undefined || isDay(to) ? [] : ['date_to']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    if (from !== undefined && to !== undefined && from > to) {
      return rejected(['date_from', 'date_to']);
    }
    const matching = state
      .filter(
        (row) =>
          (from === undefined || row.snapshot_date >= from) &&
          (to === undefined || row.snapshot_date <= to),
      )
      .sort((a, b) =>
        a.snapshot_date < b.snapshot_date ? 1 : a.snapshot_date > b.snapshot_date ? -1 : 0,
      );
    return ok(pageOf(matching, page, size));
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token') {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === LIST) return list(request.query);
    return rejected(['path']);
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
      const entry = overrides.find(
        (one) =>
          one.method === request.method &&
          one.path === request.path &&
          (one.when === undefined || one.when(request)),
      );
      if (entry === undefined) return normal(request);
      if (!entry.persistent) remove(entry);
      return await entry.reply(request);
    } finally {
      inFlight -= 1;
    }
  };

  return {
    state,
    log,
    fetch,
    permissions,
    get pending() {
      return inFlight;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    /** GET /admin/v1/asset-snapshots (every read of the list). */
    reads() {
      return log.filter((r) => r.method === 'GET' && r.path === LIST);
    },
    /** The list reads of the snapshot table under exactly `filters` (count reads aside). */
    tableReads(filters: Readonly<Record<string, string>> = {}) {
      return log.filter(tableRead(filters));
    },
    /** Every request to /admin/v1/asset-snapshots…, whatever its method. */
    snapshotRequests() {
      return log.filter((r) => r.path === LIST || r.path.startsWith(`${LIST}/`));
    },
    /** Requests that are neither GET /admin/v1/asset-snapshots nor a read of the shell. */
    others() {
      return log.filter(
        (r) => r.method !== 'GET' || !(r.path === LIST || SHELL_READS.includes(r.path)),
      );
    },
    /** Answers the next request of `method` `path` (matching `when`) with `reply`. */
    once(method: string, path: string, reply: Reply, when?: When) {
      overrides.push({ method, path, when, reply, persistent: false });
    },
    /**
     * Answers every request of `method` `path` (matching `when`) with `reply` until the returned
     * call, however often the page reads.
     */
    always(method: string, path: string, reply: Reply, when?: When) {
      const entry: Override = { method, path, when, reply, persistent: true };
      overrides.push(entry);
      return () => remove(entry);
    },
    /**
     * Holds every request of `method` `path` (matching `when`) until the returned call; then the
     * held ones and later ones are answered as usual.
     */
    hold(method: string, path: string, reply: Reply = normal, when?: When) {
      const gate = Promise.withResolvers<void>();
      const entry: Override = {
        method,
        path,
        when,
        persistent: true,
        reply: async (request) => {
          await gate.promise;
          return reply(request);
        },
      };
      overrides.push(entry);
      return () => {
        remove(entry);
        gate.resolve();
      };
    },
  };
}
export type Server = ReturnType<typeof createServer>;
