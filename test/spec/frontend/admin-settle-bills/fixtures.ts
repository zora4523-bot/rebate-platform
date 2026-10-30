import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the merged CT-24z (contracts/openapi.yaml, tag admin-settle-bills,
// still x-implementation: planned): listAdminSettleBills GET /admin/v1/settle-bills,
// getAdminSettleBill GET /admin/v1/settle-bills/{bill_id} and listAdminSettleBatchItems GET
// /admin/v1/settle-batches/{batch_id}/items. The fake server checks in the order the descriptions
// give. Ids are obvious fake UUIDs whose first 8 characters differ; bill months, amounts and
// admins are samples. The Chinese names a status, kind, item type or result must show are read
// from the console dictionary (contracts/texts.admin.default.json, BR-TEXT-25) when the test runs:
// a code with a row shows its name, a code without one shows the code itself.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const MENU_ID = 'settle-bills';
export const LIST = '/admin/v1/settle-bills';
export const VERIFY = '/admin/v1/auth/step-up';

export const billPath = (billId: string): string => `${LIST}/${billId}`;
export const itemsPath = (batchId: string): string => `/admin/v1/settle-batches/${batchId}/items`;

export type BillRow = Schema<'AdminSettleBill'>;
export type Bill = Schema<'AdminSettleBillDetail'>;
export type Batch = Schema<'AdminSettleBatch'>;
export type BatchItem = Schema<'AdminSettleBatchItem'>;
export type BillStatus = Schema<'AdminSettleBillStatus'>;
export type BatchStatus = Schema<'AdminSettleBatchStatus'>;
export type SettleMode = Schema<'AdminSettleMode'>;

// ---- console dictionary (BR-TEXT-25 admin_dict) --------------------------------------------

/**
 * Where the dictionary keeps each kind of name. admin_dict.settle_batch.status.* and
 * admin_dict.settle_mode.* exist; the bill status, batch kind, item type and item result have no
 * row yet (design §3: the contract line adds them), so their likely key paths are all accepted.
 */
export const DICT_FIELD = {
  billStatus: /^admin_dict\.(?:admin_)?settle_bills?(?:\.status|_status)\.([^.]+)$/,
  batchStatus: /^admin_dict\.settle_batch(?:es)?(?:\.status|_status)\.([^.]+)$/,
  settleMode: /^admin_dict\.(?:settle_batch(?:es)?\.)?settle_mode\.([^.]+)$/,
  batchKind: /^admin_dict\.settle_batch(?:es)?(?:\.kind|_kind)\.([^.]+)$/,
  itemType: /^admin_dict\.settle_(?:batch_)?items?(?:\.item_type|\.type|_type)\.([^.]+)$/,
  itemResult: /^admin_dict\.settle_(?:batch_)?items?(?:\.result|_result)\.([^.]+)$/,
} as const;
export type DictField = keyof typeof DICT_FIELD;

function dictionaryTexts(): Readonly<Record<string, string>> {
  return (dictionary as { texts?: Record<string, string> }).texts ?? {};
}
/** The dictionary's names for `code` of `field`; empty when it has no row (the code shows). */
export function dictNames(field: DictField, code: string): string[] {
  return Object.entries(dictionaryTexts()).flatMap(([name, value]) =>
    DICT_FIELD[field].exec(name)?.[1] === code ? [value] : [],
  );
}
function escapeText(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * What the page shows for `code` of `field`: one of its dictionary names, or the code as a whole
 * word when the dictionary has no row. `exact`: the whole (trimmed) text, as in a select option.
 */
export function namePattern(field: DictField, code: string, exact = false): RegExp {
  const names = dictNames(field, code);
  const body =
    names.length > 0
      ? `(?:${names.map(escapeText).join('|')})`
      : `(?<![A-Za-z0-9_])${escapeText(code)}(?![A-Za-z0-9_])`;
  return new RegExp(exact ? `^\\s*${body}\\s*$` : body);
}

/** The four sample bills (bill_id descending, the list's order). */
export const BILL = {
  /** generating: generated_at and every total null, no batch. */
  generating: '2026-09',
  /** issued: two DRAFT main batches (taobao, jd). */
  issued: '2026-08',
  /** settling: taobao PARTIAL (stopped by the switch), jd CONFIRMED SCHEDULED. */
  settling: '2026-07',
  /** settled: a DONE main batch and a DONE supplement batch (taobao). */
  settled: '2026-06',
} as const;

export const BATCH = {
  issuedTaobao: 'b8000001-0000-4000-8000-000000000001',
  issuedJd: 'b8000002-0000-4000-8000-000000000002',
  partial: 'b7000001-0000-4000-8000-000000000001',
  scheduled: 'b7000002-0000-4000-8000-000000000002',
  doneMain: 'b6000001-0000-4000-8000-000000000001',
  doneSupplement: 'b6000002-0000-4000-8000-000000000002',
} as const;

/** The admins who confirmed batches (confirmed_by). */
export const CONFIRMER = {
  first: 'ad000001-0000-4000-8000-0000000000a1',
  second: 'ad000002-0000-4000-8000-0000000000a2',
} as const;

/** Sub-orders of the items of the PARTIAL batch (settle_seq 1–5). */
export const ORDER = {
  credited: 'a7000001-0000-4000-8000-000000000001',
  beneficiary: 'a7000002-0000-4000-8000-000000000002',
  skipped: 'a7000003-0000-4000-8000-000000000003',
  deferred: 'a7000004-0000-4000-8000-000000000004',
  pending: 'a7000005-0000-4000-8000-000000000005',
} as const;
/** Sub-orders of the items of the scheduled jd batch (the bill's second batch; settle_seq 1–3). */
export const JD_ORDER = {
  /** An order row clawed back after an earlier settlement: B_settle −1234 fen. */
  adjusted: 'a7100001-0000-4000-8000-000000000001',
  plain: 'a7100002-0000-4000-8000-000000000002',
  shared: 'a7100003-0000-4000-8000-000000000003',
} as const;
/** Beneficiaries of the make-up items (user_id only, never a phone number). */
export const USER = {
  direct: 'c7000001-0000-4000-8000-000000000001',
  indirect: 'c7000002-0000-4000-8000-000000000002',
  share: 'c7100003-0000-4000-8000-000000000003',
} as const;
export const SKIP_REASON = 'settle_seq_changed';

type BatchFields = Pick<
  Batch,
  'batch_id' | 'platform' | 'kind' | 'status' | 'order_count' | 'created_at'
> &
  Partial<Batch>;

function batch(fields: BatchFields): Batch {
  return {
    settle_mode: 'IMMEDIATE',
    scheduled_at: null,
    confirmed_by: null,
    confirmed_at: null,
    cancelled_reason: null,
    started_at: null,
    finished_at: null,
    paused_by_switch_at: null,
    in_current_round: true,
    item_counts: {
      order: { credited: 0, skipped: 0, pending: fields.order_count },
      beneficiary: { credited: 0, skipped: 0, deferred: 0, pending: 0 },
    },
    ...fields,
  };
}

/** The four samples, bill_id descending. */
export function bills(): Bill[] {
  return [
    {
      bill_id: BILL.generating,
      status: 'generating',
      generation_started_at: '2026-10-24T02:00:00+08:00',
      generated_at: null,
      platform_order_counts: null,
      platform_settle_commission_totals: null,
      beneficiary_total_fen: null,
      platform_retained_fen: null,
      error_count: null,
      held_count: null,
      batch_count: 0,
      draft_batch_count: 0,
      created_at: '2026-10-24T02:00:00+08:00',
      batches: [],
    },
    {
      bill_id: BILL.issued,
      status: 'issued',
      generation_started_at: '2026-09-24T02:00:00+08:00',
      generated_at: '2026-09-24T02:10:05+08:00',
      platform_order_counts: { taobao: 1200, jd: 300 },
      platform_settle_commission_totals: { taobao: 864012, jd: 151005 },
      beneficiary_total_fen: 712034,
      platform_retained_fen: 302983,
      error_count: 4,
      held_count: 2,
      batch_count: 2,
      draft_batch_count: 2,
      created_at: '2026-09-24T02:00:00+08:00',
      batches: [
        batch({
          batch_id: BATCH.issuedTaobao,
          platform: 'taobao',
          kind: 'main',
          status: 'DRAFT',
          order_count: 1196,
          created_at: '2026-09-24T02:10:00+08:00',
        }),
        batch({
          batch_id: BATCH.issuedJd,
          platform: 'jd',
          kind: 'main',
          status: 'DRAFT',
          order_count: 298,
          created_at: '2026-09-24T02:10:01+08:00',
        }),
      ],
    },
    {
      bill_id: BILL.settling,
      status: 'settling',
      generation_started_at: '2026-08-24T02:00:00+08:00',
      generated_at: '2026-08-24T02:11:00+08:00',
      platform_order_counts: { taobao: 980, jd: 120 },
      platform_settle_commission_totals: { taobao: 702550, jd: 88001 },
      beneficiary_total_fen: 553386,
      platform_retained_fen: 237165,
      error_count: 0,
      held_count: 1,
      batch_count: 2,
      draft_batch_count: 0,
      created_at: '2026-08-24T02:00:00+08:00',
      batches: [
        batch({
          batch_id: BATCH.partial,
          platform: 'taobao',
          kind: 'main',
          status: 'PARTIAL',
          settle_mode: 'IMMEDIATE',
          confirmed_by: CONFIRMER.first,
          confirmed_at: '2026-08-26T15:20:00+08:00',
          started_at: '2026-08-26T15:21:00+08:00',
          paused_by_switch_at: '2026-08-26T15:40:00+08:00',
          order_count: 975,
          created_at: '2026-08-24T02:10:30+08:00',
          item_counts: {
            order: { credited: 600, skipped: 2, pending: 373 },
            beneficiary: { credited: 5, skipped: 0, deferred: 1, pending: 2 },
          },
        }),
        batch({
          batch_id: BATCH.scheduled,
          platform: 'jd',
          kind: 'main',
          status: 'CONFIRMED',
          settle_mode: 'SCHEDULED',
          scheduled_at: '2026-08-31T10:00:00+08:00',
          confirmed_by: CONFIRMER.second,
          confirmed_at: '2026-08-27T09:30:00+08:00',
          order_count: 118,
          created_at: '2026-08-24T02:10:40+08:00',
          item_counts: {
            order: { credited: 0, skipped: 0, pending: 118 },
            beneficiary: { credited: 0, skipped: 0, deferred: 0, pending: 1 },
          },
        }),
      ],
    },
    {
      bill_id: BILL.settled,
      status: 'settled',
      generation_started_at: '2026-07-24T02:00:00+08:00',
      generated_at: '2026-07-24T02:09:00+08:00',
      platform_order_counts: { taobao: 640 },
      platform_settle_commission_totals: { taobao: 450000 },
      beneficiary_total_fen: 315000,
      platform_retained_fen: 135000,
      error_count: 1,
      held_count: 0,
      batch_count: 2,
      draft_batch_count: 0,
      created_at: '2026-07-24T02:00:00+08:00',
      batches: [
        batch({
          batch_id: BATCH.doneMain,
          platform: 'taobao',
          kind: 'main',
          status: 'DONE',
          confirmed_by: CONFIRMER.first,
          confirmed_at: '2026-07-25T10:00:00+08:00',
          started_at: '2026-07-25T10:00:05+08:00',
          finished_at: '2026-07-25T10:20:00+08:00',
          order_count: 636,
          created_at: '2026-07-24T02:08:00+08:00',
          in_current_round: false,
          item_counts: {
            order: { credited: 636, skipped: 0, pending: 0 },
            beneficiary: { credited: 0, skipped: 0, deferred: 0, pending: 0 },
          },
        }),
        batch({
          batch_id: BATCH.doneSupplement,
          platform: 'taobao',
          kind: 'supplement',
          status: 'DONE',
          confirmed_by: CONFIRMER.second,
          confirmed_at: '2026-08-02T11:00:00+08:00',
          started_at: '2026-08-02T11:00:03+08:00',
          finished_at: '2026-08-02T11:01:00+08:00',
          order_count: 4,
          created_at: '2026-08-01T09:00:00+08:00',
          item_counts: {
            order: { credited: 4, skipped: 0, pending: 0 },
            beneficiary: { credited: 0, skipped: 0, deferred: 0, pending: 0 },
          },
        }),
      ],
    },
  ];
}

/** The month `count` months before `month` (YYYY-MM). */
export function monthBefore(month: string, count: number): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (number - 1) - count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** `count` older settled bills after the four samples (2026-05, 2026-04, …; for paging). */
export function withFillerBills(count: number): Bill[] {
  const filler = Array.from({ length: count }, (_, index): Bill => {
    const month = monthBefore(BILL.settled, index + 1);
    return {
      bill_id: month,
      status: 'settled',
      generation_started_at: '2026-01-24T02:00:00+08:00',
      generated_at: '2026-01-24T02:05:00+08:00',
      platform_order_counts: { taobao: 10 },
      platform_settle_commission_totals: { taobao: 1000 },
      beneficiary_total_fen: 700,
      platform_retained_fen: 300,
      error_count: 0,
      held_count: 0,
      batch_count: 0,
      draft_batch_count: 0,
      created_at: '2026-01-24T02:00:00+08:00',
      batches: [],
    };
  });
  return [...bills(), ...filler];
}

/** The five items of the PARTIAL batch, in check order (settle_seq ascending). */
export function partialItems(): BatchItem[] {
  const base = {
    user_id: null,
    role: null,
    beneficiary_credit_id: null,
    amount_fen: null,
    skip_reason: null,
    created_at: '2026-08-24T02:10:30+08:00',
  } as const;
  return [
    {
      ...base,
      id: 'e7000001-0000-4000-8000-000000000001',
      item_type: 'order',
      order_id: ORDER.credited,
      settle_seq: 1,
      b_settle_fen: 72012,
      result: 'credited',
    },
    {
      ...base,
      id: 'e7000002-0000-4000-8000-000000000002',
      item_type: 'beneficiary',
      order_id: ORDER.beneficiary,
      user_id: USER.direct,
      role: 'direct',
      beneficiary_credit_id: 'd7000001-0000-4000-8000-000000000001',
      settle_seq: 2,
      b_settle_fen: null,
      amount_fen: 36,
      result: 'credited',
    },
    {
      ...base,
      id: 'e7000003-0000-4000-8000-000000000003',
      item_type: 'order',
      order_id: ORDER.skipped,
      settle_seq: 3,
      b_settle_fen: 15050,
      result: 'skipped',
      skip_reason: SKIP_REASON,
    },
    {
      ...base,
      id: 'e7000004-0000-4000-8000-000000000004',
      item_type: 'beneficiary',
      order_id: ORDER.deferred,
      user_id: USER.indirect,
      role: 'indirect',
      beneficiary_credit_id: 'd7000002-0000-4000-8000-000000000002',
      settle_seq: 4,
      b_settle_fen: null,
      result: 'deferred',
    },
    {
      ...base,
      id: 'e7000005-0000-4000-8000-000000000005',
      item_type: 'order',
      order_id: ORDER.pending,
      settle_seq: 5,
      b_settle_fen: 9999,
      result: null,
    },
  ];
}

/**
 * The three items of the scheduled jd batch (not executed yet: every result null): an order row
 * with a negative B_settle (−1234 fen = −12.34), a plain order row (5678 fen) and a beneficiary
 * make-up item.
 */
export function scheduledItems(): BatchItem[] {
  const base = {
    user_id: null,
    role: null,
    beneficiary_credit_id: null,
    amount_fen: null,
    result: null,
    skip_reason: null,
    created_at: '2026-08-24T02:10:40+08:00',
  } as const;
  return [
    {
      ...base,
      id: 'e7100001-0000-4000-8000-000000000001',
      item_type: 'order',
      order_id: JD_ORDER.adjusted,
      settle_seq: 1,
      b_settle_fen: -1234,
    },
    {
      ...base,
      id: 'e7100002-0000-4000-8000-000000000002',
      item_type: 'order',
      order_id: JD_ORDER.plain,
      settle_seq: 2,
      b_settle_fen: 5678,
    },
    {
      ...base,
      id: 'e7100003-0000-4000-8000-000000000003',
      item_type: 'beneficiary',
      order_id: JD_ORDER.shared,
      user_id: USER.share,
      role: 'share',
      beneficiary_credit_id: 'd7100001-0000-4000-8000-000000000001',
      settle_seq: 3,
      b_settle_fen: null,
    },
  ];
}

/** The order_id of filler item `n` (1-based): f0000001-…, f0000002-… */
export function fillerOrder(n: number): string {
  return `f${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;
}
/** `count` credited order items (settle_seq 1…count) for paging. */
export function fillerItems(count: number): BatchItem[] {
  return Array.from({ length: count }, (_, index): BatchItem => {
    const n = index + 1;
    return {
      id: `e${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`,
      item_type: 'order',
      order_id: fillerOrder(n),
      user_id: null,
      role: null,
      beneficiary_credit_id: null,
      settle_seq: n,
      b_settle_fen: 100,
      amount_fen: null,
      result: 'credited',
      skip_reason: null,
      created_at: '2026-07-24T02:08:00+08:00',
    };
  });
}

/** Permission points an account holds. */
export type Grants = readonly KnownPermission[];
/** settle.bill: reads (and, later, the writes this page does not offer yet). */
export const SETTLE_GRANTS: Grants = ['settle.bill'];
/** fund.view: reads only; the menu stays hidden (it is not one of the menu's points). */
export const VIEW_GRANTS: Grants = ['fund.view'];
/** Menu points that do not read bills. */
export const UPLOAD_GRANTS: Grants = ['settle.statement_upload'];
export const ADJUST_GRANTS: Grants = ['fund.settle_adjust'];

/** Permission snapshot; nothing this page does needs a step-up. */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of permissions) stepUp[point] = { tier: null, operations: {} };
  return { isSuper: false, permissions, stepUp };
}
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

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

export interface ServerOptions {
  /** Permission points of the account (the server checks them; 10403 otherwise). */
  readonly permissions?: Grants;
  /** Items per batch_id (on top of the PARTIAL batch's five samples). */
  readonly items?: Readonly<Record<string, readonly BatchItem[]>>;
}

const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const POSITIVE = /^[1-9][0-9]*$/;
const BILL_STATUSES: readonly string[] = [
  'generating',
  'issued',
  'scheduled',
  'settling',
  'settled',
];
const ITEM_TYPES: readonly string[] = ['order', 'beneficiary'];
const ITEM_RESULTS: readonly string[] = ['credited', 'skipped', 'deferred', 'pending'];
/** Every query parameter listAdminSettleBills takes. */
export const LIST_PARAMS: readonly string[] = [
  'page',
  'page_size',
  'bill_from',
  'bill_to',
  'status',
];
/** Its filter parameters (everything but paging). */
export const FILTER_PARAMS: readonly string[] = ['bill_from', 'bill_to', 'status'];
/** Every query parameter listAdminSettleBatchItems takes. */
export const ITEM_PARAMS: readonly string[] = ['page', 'page_size', 'item_type', 'result'];

/**
 * A list query of the bill table under exactly the filters `filters` (a parameter not named there
 * is absent). A count read (one row asked for, page_size=1) is not a table read.
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
const DETAIL = /^\/admin\/v1\/settle-bills\/([^/]+)$/;
const ITEMS = /^\/admin\/v1\/settle-batches\/([^/]+)\/items$/;

/** A list row: the detail without its batches. */
function rowOf(bill: Bill): BillRow {
  return {
    bill_id: bill.bill_id,
    status: bill.status,
    generation_started_at: bill.generation_started_at,
    generated_at: bill.generated_at,
    platform_order_counts: bill.platform_order_counts,
    platform_settle_commission_totals: bill.platform_settle_commission_totals,
    beneficiary_total_fen: bill.beneficiary_total_fen,
    platform_retained_fen: bill.platform_retained_fen,
    error_count: bill.error_count,
    held_count: bill.held_count,
    batch_count: bill.batch_count,
    draft_batch_count: bill.draft_batch_count,
    created_at: bill.created_at,
  };
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

/** Fake /admin/v1 server with the CT-24z checks. */
export function createServer(initial: Bill[] = bills(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const items = new Map<string, BatchItem[]>([
    [BATCH.partial, partialItems()],
    [BATCH.scheduled, scheduledItems()],
  ]);
  for (const [batchId, rows] of Object.entries(options.items ?? {}))
    items.set(batchId, structuredClone([...rows]));
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; when: When | undefined; reply: Reply }[] = [];
  const permissions = options.permissions ?? SETTLE_GRANTS;
  let inFlight = 0;

  const canRead = (): boolean =>
    permissions.includes('settle.bill') || permissions.includes('fund.view');

  function list(query: Record<string, string>): Response {
    if (!canRead()) return denied();
    const { bill_from: from, bill_to: to, status, page, page_size: size } = query;
    const invalid = [
      ...pageInvalid(page, size),
      ...(from === undefined || MONTH.test(from) ? [] : ['bill_from']),
      ...(to === undefined || MONTH.test(to) ? [] : ['bill_to']),
      ...(status === undefined || BILL_STATUSES.includes(status) ? [] : ['status']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    if (from !== undefined && to !== undefined && from > to) {
      return rejected(['bill_from', 'bill_to']);
    }
    const matching = state
      .filter(
        (bill) =>
          (from === undefined || bill.bill_id >= from) &&
          (to === undefined || bill.bill_id <= to) &&
          (status === undefined || bill.status === status),
      )
      .sort((a, b) => (a.bill_id < b.bill_id ? 1 : a.bill_id > b.bill_id ? -1 : 0))
      .map(rowOf);
    return ok(pageOf(matching, page, size));
  }

  function detail(billId: string): Response {
    if (!canRead()) return denied();
    const found = MONTH.test(billId) ? state.find((bill) => bill.bill_id === billId) : undefined;
    if (found === undefined) return rejected(['bill_id']);
    return ok(found);
  }

  function batchItems(batchId: string, query: Record<string, string>): Response {
    if (!canRead()) return denied();
    const { item_type: type, result, page, page_size: size } = query;
    const invalid = [
      ...pageInvalid(page, size),
      ...(type === undefined || ITEM_TYPES.includes(type) ? [] : ['item_type']),
      ...(result === undefined || ITEM_RESULTS.includes(result) ? [] : ['result']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    const known = state.some((bill) => bill.batches.some((one) => one.batch_id === batchId));
    if (!known) return rejected(['batch_id']);
    const matching = (items.get(batchId) ?? [])
      .filter(
        (item) =>
          (type === undefined || item.item_type === type) &&
          (result === undefined ||
            (result === 'pending' ? item.result === null : item.result === result)),
      )
      .sort((a, b) =>
        a.settle_seq !== b.settle_seq ? a.settle_seq - b.settle_seq : a.id < b.id ? -1 : 1,
      );
    return ok(pageOf(matching, page, size));
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token') {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === LIST) return list(request.query);
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) return detail(decodeURIComponent(one[1]!));
    const owned = ITEMS.exec(path);
    if (method === 'GET' && owned !== null) {
      return batchItems(decodeURIComponent(owned[1]!), request.query);
    }
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
      const index = overrides.findIndex(
        (entry) =>
          entry.method === request.method &&
          entry.path === request.path &&
          (entry.when === undefined || entry.when(request)),
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
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
    /** GET /admin/v1/settle-bills (the list). */
    reads() {
      return log.filter((r) => r.method === 'GET' && r.path === LIST);
    },
    /** The list reads of the bill table under exactly `filters` (count reads aside). */
    tableReads(filters: Readonly<Record<string, string>> = {}) {
      return log.filter(tableRead(filters));
    },
    /** GET /admin/v1/settle-bills/{bill_id}. */
    billReads(billId: string) {
      return log.filter((r) => r.method === 'GET' && r.path === billPath(billId));
    },
    /** GET /admin/v1/settle-batches/{batch_id}/items. */
    itemReads(batchId: string) {
      return log.filter((r) => r.method === 'GET' && r.path === itemsPath(batchId));
    },
    /** Every request to /admin/v1/settle-bills… or /admin/v1/settle-batches…. */
    settleRequests() {
      return log.filter(
        (r) =>
          r.path === LIST ||
          r.path.startsWith(`${LIST}/`) ||
          r.path.startsWith('/admin/v1/settle-batches'),
      );
    },
    /** Requests that are not one of the three GETs of CT-24z. */
    others() {
      return log.filter(
        (r) =>
          r.method !== 'GET' || !(r.path === LIST || DETAIL.test(r.path) || ITEMS.test(r.path)),
      );
    },
    /** Answers the next request of `method` `path` (matching `when`) with `reply`. */
    once(method: string, path: string, reply: Reply, when?: When) {
      overrides.push({ method, path, when, reply });
    },
    /** Holds the next request of `method` `path` (matching `when`) until the returned call. */
    hold(method: string, path: string, reply: Reply = normal, when?: When) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        when,
        reply: async (request) => {
          await gate.promise;
          return reply(request);
        },
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;
