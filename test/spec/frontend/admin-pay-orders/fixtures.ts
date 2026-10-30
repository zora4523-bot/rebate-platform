import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the merged CT-21e (contracts/openapi.yaml, tag admin-pay):
// listAdminPayOrders GET /admin/v1/pay-orders, getAdminPayOrder GET
// /admin/v1/pay-orders/{pay_order_id}, listAdminPayAnomalies GET /admin/v1/pay-anomalies and
// listAdminPayReconDiffs GET /admin/v1/pay-recon-diffs (all permission point pay.view). The fake
// server checks in the order the descriptions give. Ids are obvious fake UUIDs whose first 8
// characters differ; order numbers, trade numbers, amounts and users are samples. The Chinese
// names a status, channel or type must show are read from the console dictionary
// (contracts/texts.admin.default.json, BR-TEXT-25) when the test runs: a code with a row shows
// its name, a code without one shows the code itself.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const MENU_ID = 'pay-orders';
export const ORDERS = '/admin/v1/pay-orders';
export const ANOMALIES = '/admin/v1/pay-anomalies';
export const DIFFS = '/admin/v1/pay-recon-diffs';
export const VERIFY = '/admin/v1/auth/step-up';

export const orderPath = (payOrderId: string): string => `${ORDERS}/${payOrderId}`;
export const detailRoute = (payOrderId: string): string => `${MENU_ID}/${payOrderId}`;

export type PayOrder = Schema<'AdminPayOrder'>;
export type PayOrderDetail = Schema<'AdminPayOrderDetail'>;
export type PayRefund = Schema<'AdminPayRefund'>;
export type QueryAttempt = Schema<'AdminPayQueryAttempt'>;
export type PayAnomaly = Schema<'AdminPayAnomaly'>;
export type ReconDiff = Schema<'AdminPayReconDiff'>;

// ---- console dictionary (BR-TEXT-25 admin_dict) --------------------------------------------

/**
 * Where the dictionary keeps each kind of name. pay_order_status, pay_channel, pay_refund_status,
 * pay_refund_reason, recon_diff_type and recon_diff_status have rows; the business type, the
 * anomaly status and the channel request kind / result have none yet, so their likely key paths
 * are all accepted (and the code shows while there is no row).
 */
export const DICT_FIELD = {
  payStatus: /^admin_dict\.pay_orders?(?:\.status|_status)\.([^.]+)$/,
  channel: /^admin_dict\.pay_channels?\.([^.]+)$/,
  bizType: /^admin_dict\.(?:pay_(?:orders?\.)?)?biz_types?\.([^.]+)$/,
  refundStatus: /^admin_dict\.pay_refunds?(?:\.status|_status)\.([^.]+)$/,
  refundReason: /^admin_dict\.pay_refunds?(?:\.reason(?:_code)?|_reason)\.([^.]+)$/,
  attemptKind: /^admin_dict\.pay_query_attempts?(?:\.kind|_kind)\.([^.]+)$/,
  attemptResult: /^admin_dict\.pay_query_attempts?(?:\.result|_result)\.([^.]+)$/,
  anomalyStatus: /^admin_dict\.pay_anomal(?:y|ies)(?:\.status|_status)\.([^.]+)$/,
  diffType: /^admin_dict\.recon_diffs?(?:\.type|_type)\.([^.]+)$/,
  diffStatus: /^admin_dict\.recon_diffs?(?:\.status|_status)\.([^.]+)$/,
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

// ---- samples ---------------------------------------------------------------------------------

/** The four sample pay orders (created_at descending, the list's order). */
export const ORDER = {
  /** PENDING, closing and needs_manual (wechat_pay, 1900 fen, nothing refunded). */
  manual: 'a1000001-0000-4000-8000-000000000001',
  /** PAID, partly refunded (alipay, 12800 fen, 3050 fen refunded): the detail sample. */
  refunded: 'a2000002-0000-4000-8000-000000000002',
  /** CLOSED (wechat_pay, 990 fen); the money that came later is an anomaly. */
  closed: 'a3000003-0000-4000-8000-000000000003',
  /** PAID, nothing refunded (wechat_pay, 2500 fen). */
  paid: 'a4000004-0000-4000-8000-000000000004',
} as const;
/** Merchant order numbers (out_trade_no) of the four samples. */
export const OUT_TRADE_NO = {
  manual: 'PSAMPLE20261020001',
  refunded: 'PSAMPLE20261019002',
  closed: 'PSAMPLE20261018003',
  paid: 'PSAMPLE20261017004',
} as const;
/** Our users (user_id) of the four samples. */
export const USER = {
  manual: 'c1000001-0000-4000-8000-000000000001',
  refunded: 'c2000002-0000-4000-8000-000000000002',
  closed: 'c3000003-0000-4000-8000-000000000003',
  paid: 'c4000004-0000-4000-8000-000000000004',
} as const;
/** The channel transaction numbers (channel_trade_no) the channel reported. */
export const CHANNEL_TRADE_NO = {
  refunded: 'CHSAMPLE20261019000002',
  paid: 'CHSAMPLE20261017000004',
} as const;
/** Business types of the samples (no dictionary row yet: the code shows). */
export const BIZ = {
  membership: 'membership',
  trial: 'sample_trial',
} as const;
/** The operator who started the refunds. */
export const OPERATOR = 'ad000001-0000-4000-8000-0000000000a1';

/**
 * Channel-side user identifiers the contract never returns (BR-PAY-08 ④). The fake server still
 * puts them into the pay order rows, outside the contract, only so a test can assert the page
 * never shows them.
 */
export const CHANNEL_USER = {
  payer_openid: 'oSAMPLEpayerOPENID0002',
  buyer_user_id: '2088SAMPLEBUYER0002',
} as const;

function order(fields: Pick<PayOrder, 'pay_order_id' | 'out_trade_no'> & Partial<PayOrder>) {
  const base: PayOrder = {
    pay_order_id: fields.pay_order_id,
    user_id: USER.paid,
    biz_type: BIZ.membership,
    biz_ref: 'b0000000-0000-4000-8000-000000000000',
    pay_channel: 'wechat_pay',
    amount_fen: 1900,
    refunded_fen: 0,
    status: 'PAID',
    out_trade_no: fields.out_trade_no,
    channel_trade_no: null,
    needs_manual: false,
    closing: false,
    expire_at: '2026-10-17T14:35:00+08:00',
    paid_at: null,
    closed_at: null,
    created_at: '2026-10-17T14:20:00+08:00',
  };
  return { ...base, ...fields };
}

/** The four samples, created_at descending. */
export function orders(): PayOrder[] {
  return [
    order({
      pay_order_id: ORDER.manual,
      out_trade_no: OUT_TRADE_NO.manual,
      user_id: USER.manual,
      biz_type: BIZ.membership,
      biz_ref: 'b1000001-0000-4000-8000-000000000001',
      pay_channel: 'wechat_pay',
      amount_fen: 1900,
      refunded_fen: 0,
      status: 'PENDING',
      needs_manual: true,
      closing: true,
      expire_at: '2026-10-20T10:45:00+08:00',
      created_at: '2026-10-20T10:30:00+08:00',
    }),
    order({
      pay_order_id: ORDER.refunded,
      out_trade_no: OUT_TRADE_NO.refunded,
      user_id: USER.refunded,
      biz_type: BIZ.membership,
      biz_ref: 'b2000002-0000-4000-8000-000000000002',
      pay_channel: 'alipay',
      amount_fen: 12800,
      refunded_fen: 3050,
      status: 'PAID',
      channel_trade_no: CHANNEL_TRADE_NO.refunded,
      expire_at: '2026-10-19T09:15:00+08:00',
      paid_at: '2026-10-19T09:01:12+08:00',
      created_at: '2026-10-19T09:00:00+08:00',
    }),
    order({
      pay_order_id: ORDER.closed,
      out_trade_no: OUT_TRADE_NO.closed,
      user_id: USER.closed,
      biz_type: BIZ.trial,
      biz_ref: 'b3000003-0000-4000-8000-000000000003',
      pay_channel: 'wechat_pay',
      amount_fen: 990,
      refunded_fen: 0,
      status: 'CLOSED',
      expire_at: '2026-10-18T08:15:00+08:00',
      closed_at: '2026-10-18T08:40:00+08:00',
      created_at: '2026-10-18T08:00:00+08:00',
    }),
    order({
      pay_order_id: ORDER.paid,
      out_trade_no: OUT_TRADE_NO.paid,
      user_id: USER.paid,
      biz_type: BIZ.membership,
      biz_ref: 'b4000004-0000-4000-8000-000000000004',
      pay_channel: 'wechat_pay',
      amount_fen: 2500,
      refunded_fen: 0,
      status: 'PAID',
      channel_trade_no: CHANNEL_TRADE_NO.paid,
      expire_at: '2026-10-17T14:35:00+08:00',
      paid_at: '2026-10-17T14:22:30+08:00',
      created_at: '2026-10-17T14:20:00+08:00',
    }),
  ];
}

/** The merchant order number of filler pay order `n` (1-based). */
export function fillerOutTradeNo(n: number): string {
  return `PFILL${String(n).padStart(6, '0')}`;
}
/** Filler rows are created 10 minutes apart, all before the four samples. */
const FILLER_START = Date.parse('2026-10-01T00:00:00+08:00');
function fillerTime(n: number): string {
  return new Date(FILLER_START - n * 600_000).toISOString();
}
/** `count` older PAID pay orders after the four samples (for paging). */
export function withFillerOrders(count: number): PayOrder[] {
  const filler = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return order({
      pay_order_id: `e${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`,
      out_trade_no: fillerOutTradeNo(n),
      user_id: USER.paid,
      amount_fen: 100,
      created_at: fillerTime(n),
      expire_at: fillerTime(n),
    });
  });
  return [...orders(), ...filler];
}

/** Refunds of the partly refunded sample (newest first). */
export const REFUND = {
  failed: 'e2000002-0000-4000-8000-000000000002',
  success: 'e1000001-0000-4000-8000-000000000001',
} as const;
export const OUT_REFUND_NO = {
  failed: 'RSAMPLE20261021002',
  success: 'RSAMPLE20261020001',
} as const;

/** Detail of the partly refunded sample: two refunds and three channel request summaries. */
export function refundedDetail(): PayOrderDetail {
  const payOrder = orders().find((row) => row.pay_order_id === ORDER.refunded)!;
  return {
    pay_order: payOrder,
    refunds: [
      {
        pay_refund_id: REFUND.failed,
        target_type: 'pay_order',
        target_id: ORDER.refunded,
        out_refund_no: OUT_REFUND_NO.failed,
        amount_fen: 2000,
        reason_code: 'DUPLICATE_PAYMENT',
        note: null,
        status: 'FAILED',
        channel_refund_no: null,
        operator: OPERATOR,
        created_at: '2026-10-21T09:12:00+08:00',
        succeeded_at: null,
      },
      {
        pay_refund_id: REFUND.success,
        target_type: 'pay_order',
        target_id: ORDER.refunded,
        out_refund_no: OUT_REFUND_NO.success,
        amount_fen: 3050,
        reason_code: 'USER_REQUEST',
        note: null,
        status: 'SUCCESS',
        channel_refund_no: 'CRSAMPLE20261020000001',
        operator: OPERATOR,
        created_at: '2026-10-20T11:00:00+08:00',
        succeeded_at: '2026-10-20T11:00:08+08:00',
      },
    ],
    query_attempts: [
      { kind: 'refund_query', result: 'ok', at: '2026-10-21T09:18:30+08:00' },
      { kind: 'refund', result: 'unknown', at: '2026-10-21T09:14:02+08:00' },
      { kind: 'query', result: 'ok', at: '2026-10-19T09:03:05+08:00' },
    ],
  };
}
/** The channel request summaries of refundedDetail() as shown (Beijing time, to the minute). */
export const ATTEMPT_TIME = {
  refundQuery: '2026-10-2109:18',
  refund: '2026-10-2109:14',
  query: '2026-10-1909:03',
} as const;

function emptyDetail(payOrder: PayOrder): PayOrderDetail {
  return { pay_order: payOrder, refunds: [], query_attempts: [] };
}

/** The pay anomalies (created_at descending). */
export const ANOMALY = {
  /** wechat_pay, for the CLOSED sample, 990 fen, nothing refunded, open. */
  closedOrder: 'f1000001-0000-4000-8000-000000000001',
  /** alipay, no pay order of ours and no merchant number, 6600 fen, 1600 fen refunded. */
  unknownOrder: 'f2000002-0000-4000-8000-000000000002',
  /** alipay, no pay order of ours, 3300 fen, all refunded. */
  refunded: 'f3000003-0000-4000-8000-000000000003',
} as const;
export const ANOMALY_TRADE_NO = {
  closedOrder: 'CHANOMALY20261021000001',
  unknownOrder: 'CHANOMALY20261020000002',
  refunded: 'CHANOMALY20261019000003',
} as const;

export function anomalies(): PayAnomaly[] {
  return [
    {
      pay_anomaly_id: ANOMALY.closedOrder,
      pay_channel: 'wechat_pay',
      channel_trade_no: ANOMALY_TRADE_NO.closedOrder,
      out_trade_no: OUT_TRADE_NO.closed,
      pay_order_id: ORDER.closed,
      amount_fen: 990,
      refunded_fen: 0,
      status: 'open',
      created_at: '2026-10-21T02:10:00+08:00',
    },
    {
      pay_anomaly_id: ANOMALY.unknownOrder,
      pay_channel: 'alipay',
      channel_trade_no: ANOMALY_TRADE_NO.unknownOrder,
      out_trade_no: null,
      pay_order_id: null,
      amount_fen: 6600,
      refunded_fen: 1600,
      status: 'open',
      created_at: '2026-10-20T03:25:00+08:00',
    },
    {
      pay_anomaly_id: ANOMALY.refunded,
      pay_channel: 'alipay',
      channel_trade_no: ANOMALY_TRADE_NO.refunded,
      out_trade_no: null,
      pay_order_id: null,
      amount_fen: 3300,
      refunded_fen: 3300,
      status: 'refunded',
      created_at: '2026-10-19T04:40:00+08:00',
    },
  ];
}
/** The channel trade number of filler anomaly `n` (1-based). */
export function fillerAnomalyTradeNo(n: number): string {
  return `CHFILL${String(n).padStart(6, '0')}`;
}
/** `count` older wechat_pay anomalies after the three samples (for paging). */
export function withFillerAnomalies(count: number): PayAnomaly[] {
  const filler = Array.from({ length: count }, (_, index): PayAnomaly => ({
    pay_anomaly_id: `9${String(index + 1).padStart(7, '0')}-0000-4000-8000-000000000000`,
    pay_channel: 'wechat_pay',
    channel_trade_no: fillerAnomalyTradeNo(index + 1),
    out_trade_no: null,
    pay_order_id: null,
    amount_fen: 100,
    refunded_fen: 0,
    status: 'open',
    created_at: fillerTime(index + 1),
  }));
  return [...anomalies(), ...filler];
}

/** The R4 differences (created_at descending), each on a bill date of its own. */
export const PERIOD = {
  /** pay_mismatch, open: ours 12800, channel 9900, difference +2900 fen. */
  mismatch: '2026-10-20',
  /** pay_anomaly, processing: ours 0, channel 4560, difference −4560 fen. */
  anomaly: '2026-10-18',
  /** pay_mismatch on a refund, closed: ours 3050, channel 2050, difference +1000 fen. */
  closed: '2026-10-16',
} as const;
export const DIFF = {
  mismatch: 'd4000001-0000-4000-8000-000000000001',
  anomaly: 'd4000002-0000-4000-8000-000000000002',
  closed: 'd4000003-0000-4000-8000-000000000003',
} as const;

export function reconDiffs(): ReconDiff[] {
  return [
    {
      recon_diff_id: DIFF.mismatch,
      source: 'R4',
      type: 'pay_mismatch',
      period: PERIOD.mismatch,
      ref_type: 'pay_order',
      ref_id: ORDER.paid,
      expected_fen: 12800,
      actual_fen: 9900,
      diff_fen: 2900,
      status: 'open',
      created_at: '2026-10-21T02:10:00+08:00',
      closed_at: null,
    },
    {
      recon_diff_id: DIFF.anomaly,
      source: 'R4',
      type: 'pay_anomaly',
      period: PERIOD.anomaly,
      ref_type: 'pay_anomaly',
      ref_id: ANOMALY.closedOrder,
      expected_fen: 0,
      actual_fen: 4560,
      diff_fen: -4560,
      status: 'processing',
      created_at: '2026-10-19T02:10:00+08:00',
      closed_at: null,
    },
    {
      recon_diff_id: DIFF.closed,
      source: 'R4',
      type: 'pay_mismatch',
      period: PERIOD.closed,
      ref_type: 'pay_refund',
      ref_id: REFUND.success,
      expected_fen: 3050,
      actual_fen: 2050,
      diff_fen: 1000,
      status: 'closed',
      created_at: '2026-10-17T02:10:00+08:00',
      closed_at: '2026-10-17T15:00:00+08:00',
    },
  ];
}
/** The bill date of filler difference `n` (1-based): 2025-12-28, 2025-12-27, … (one a day). */
export function fillerPeriod(n: number): string {
  const day = Date.parse('2025-12-29T00:00:00Z') - n * 86_400_000;
  return new Date(day).toISOString().split('T')[0]!;
}
/** `count` older pay_mismatch differences after the three samples (for paging). */
export function withFillerDiffs(count: number): ReconDiff[] {
  const filler = Array.from({ length: count }, (_, index): ReconDiff => ({
    recon_diff_id: `8${String(index + 1).padStart(7, '0')}-0000-4000-8000-000000000000`,
    source: 'R4',
    type: 'pay_mismatch',
    period: fillerPeriod(index + 1),
    ref_type: 'pay_order',
    ref_id: ORDER.paid,
    expected_fen: 100,
    actual_fen: 0,
    diff_fen: 100,
    status: 'open',
    created_at: fillerTime(index + 1),
    closed_at: null,
  }));
  return [...reconDiffs(), ...filler];
}

// ---- permissions -----------------------------------------------------------------------------

/** Permission points an account holds. */
export type Grants = readonly KnownPermission[];
/** pay.view: the four reads. */
export const VIEW_GRANTS: Grants = ['pay.view'];
/** Menu points without pay.view (the menu shows, the reads are refused). */
export const REFUND_GRANTS: Grants = ['pay.refund'];
export const RESOLVE_GRANTS: Grants = ['pay.resolve'];

/** Permission snapshot; nothing this page does needs a step-up. */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of permissions) stepUp[point] = { tier: null, operations: {} };
  return { isSuper: false, permissions, stepUp };
}
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

// ---- envelopes -------------------------------------------------------------------------------

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
  readonly anomalies?: readonly PayAnomaly[];
  readonly diffs?: readonly ReconDiff[];
  /** Details by pay_order_id (others: the list row with no refunds and no requests). */
  readonly details?: Readonly<Record<string, PayOrderDetail>>;
}

const POSITIVE = /^[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const ORDER_STATUSES: readonly string[] = ['PENDING', 'PAID', 'CLOSED'];
const CHANNELS: readonly string[] = ['wechat_pay', 'alipay'];
const DIFF_TYPES: readonly string[] = ['pay_mismatch', 'pay_anomaly'];
const DIFF_STATUSES: readonly string[] = [
  'open',
  'processing',
  'adjusted',
  'written_off',
  'closed',
];

/** Every query parameter listAdminPayOrders takes. */
export const ORDER_PARAMS: readonly string[] = [
  'page',
  'page_size',
  'status',
  'pay_channel',
  'biz_type',
  'user_id',
  'out_trade_no',
  'needs_manual',
  'created_from',
  'created_to',
];
/** Its filter parameters (everything but paging). */
export const ORDER_FILTERS: readonly string[] = ORDER_PARAMS.filter(
  (name) => name !== 'page' && name !== 'page_size',
);
/** Every query parameter listAdminPayAnomalies takes. */
export const ANOMALY_PARAMS: readonly string[] = ['page', 'page_size', 'pay_channel'];
export const ANOMALY_FILTERS: readonly string[] = ['pay_channel'];
/** Every query parameter listAdminPayReconDiffs takes. */
export const DIFF_PARAMS: readonly string[] = ['page', 'page_size', 'type', 'status'];
export const DIFF_FILTERS: readonly string[] = ['type', 'status'];

const FILTERS_OF: Readonly<Record<string, readonly string[]>> = {
  [ORDERS]: ORDER_FILTERS,
  [ANOMALIES]: ANOMALY_FILTERS,
  [DIFFS]: DIFF_FILTERS,
};

/**
 * A list query of the table at `path` under exactly the filters `filters` (a parameter not named
 * there is absent). A count read (one row asked for, page_size=1) is not a table read.
 */
export function isTableQuery(
  path: string,
  query: Readonly<Record<string, string>>,
  filters: Readonly<Record<string, string>> = {},
): boolean {
  if (query['page_size'] === '1') return false;
  return (FILTERS_OF[path] ?? []).every((name) => query[name] === filters[name]);
}
/** Matches the table read of the list at `path` under `filters` (see isTableQuery). */
export function tableRead(path: string, filters: Readonly<Record<string, string>> = {}): When {
  return (request) =>
    request.method === 'GET' && request.path === path && isTableQuery(path, request.query, filters);
}
const DETAIL = /^\/admin\/v1\/pay-orders\/([^/]+)$/;

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
function newestFirst<T extends { created_at: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}
/** A pay order as the fake server sends it: with the out-of-contract channel-side user values. */
function leaked(row: PayOrder): PayOrder & typeof CHANNEL_USER {
  return { ...row, ...CHANNEL_USER };
}

/** Fake /admin/v1 server with the CT-21e checks. */
export function createServer(initial: PayOrder[] = orders(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const anomalyState = structuredClone([...(options.anomalies ?? anomalies())]);
  const diffState = structuredClone([...(options.diffs ?? reconDiffs())]);
  const details = new Map<string, PayOrderDetail>([[ORDER.refunded, refundedDetail()]]);
  for (const [id, detail] of Object.entries(options.details ?? {}))
    details.set(id, structuredClone(detail));
  const log: RequestLog[] = [];
  interface Override {
    readonly method: string;
    readonly path: string;
    readonly when: When | undefined;
    readonly reply: Reply;
    /** Stays in place (answers every matching request) until removed. */
    readonly persistent: boolean;
  }
  const overrides: Override[] = [];
  const remove = (entry: Override): void => {
    const index = overrides.indexOf(entry);
    if (index >= 0) overrides.splice(index, 1);
  };
  const permissions = options.permissions ?? VIEW_GRANTS;
  let inFlight = 0;

  const canRead = (): boolean => permissions.includes('pay.view');

  function listOrders(query: Record<string, string>): Response {
    if (!canRead()) return denied();
    const {
      page,
      page_size: size,
      status,
      pay_channel: channel,
      biz_type: biz,
      user_id: user,
      out_trade_no: outTradeNo,
      needs_manual: manual,
      created_from: from,
      created_to: to,
    } = query;
    const invalid = [
      ...pageInvalid(page, size),
      ...(status === undefined || ORDER_STATUSES.includes(status) ? [] : ['status']),
      ...(channel === undefined || CHANNELS.includes(channel) ? [] : ['pay_channel']),
      ...(biz === undefined || (biz.length >= 1 && biz.length <= 64) ? [] : ['biz_type']),
      ...(user === undefined || UUID.test(user) ? [] : ['user_id']),
      ...(outTradeNo === undefined || (outTradeNo.length >= 1 && outTradeNo.length <= 64)
        ? []
        : ['out_trade_no']),
      ...(manual === undefined || manual === 'true' || manual === 'false' ? [] : ['needs_manual']),
      ...(from === undefined || DATE_TIME.test(from) ? [] : ['created_from']),
      ...(to === undefined || DATE_TIME.test(to) ? [] : ['created_to']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
      return rejected(['created_from', 'created_to']);
    }
    const matching = newestFirst(
      state.filter(
        (row) =>
          (status === undefined || row.status === status) &&
          (channel === undefined || row.pay_channel === channel) &&
          (biz === undefined || row.biz_type === biz) &&
          (user === undefined || row.user_id.toLowerCase() === user.toLowerCase()) &&
          (outTradeNo === undefined || row.out_trade_no === outTradeNo) &&
          (manual === undefined || String(row.needs_manual) === manual) &&
          (from === undefined || Date.parse(row.created_at) >= Date.parse(from)) &&
          (to === undefined || Date.parse(row.created_at) < Date.parse(to)),
      ),
    ).map(leaked);
    return ok(pageOf(matching, page, size));
  }

  function detail(payOrderId: string): Response {
    if (!canRead()) return denied();
    const row = UUID.test(payOrderId)
      ? state.find((one) => one.pay_order_id === payOrderId)
      : undefined;
    if (row === undefined) return rejected(['pay_order_id']);
    const found = details.get(payOrderId) ?? emptyDetail(row);
    return ok({ ...found, pay_order: leaked({ ...found.pay_order, ...row }) });
  }

  function listAnomalies(query: Record<string, string>): Response {
    if (!canRead()) return denied();
    const { page, page_size: size, pay_channel: channel } = query;
    const invalid = [
      ...pageInvalid(page, size),
      ...(channel === undefined || CHANNELS.includes(channel) ? [] : ['pay_channel']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    const matching = newestFirst(
      anomalyState.filter((row) => channel === undefined || row.pay_channel === channel),
    );
    return ok(pageOf(matching, page, size));
  }

  function listDiffs(query: Record<string, string>): Response {
    if (!canRead()) return denied();
    const { page, page_size: size, type, status } = query;
    const invalid = [
      ...pageInvalid(page, size),
      ...(type === undefined || DIFF_TYPES.includes(type) ? [] : ['type']),
      ...(status === undefined || DIFF_STATUSES.includes(status) ? [] : ['status']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    const matching = newestFirst(
      diffState.filter(
        (row) =>
          (type === undefined || row.type === type) &&
          (status === undefined || row.status === status),
      ),
    );
    return ok(pageOf(matching, page, size));
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token') {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === ORDERS) return listOrders(request.query);
    if (method === 'GET' && path === ANOMALIES) return listAnomalies(request.query);
    if (method === 'GET' && path === DIFFS) return listDiffs(request.query);
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) return detail(decodeURIComponent(one[1]!));
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

  const gets = (path: string) => log.filter((r) => r.method === 'GET' && r.path === path);

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
    /** GET /admin/v1/pay-orders (the list). */
    orderReads() {
      return gets(ORDERS);
    },
    /** GET /admin/v1/pay-anomalies. */
    anomalyReads() {
      return gets(ANOMALIES);
    },
    /** GET /admin/v1/pay-recon-diffs. */
    diffReads() {
      return gets(DIFFS);
    },
    /** The table reads of the list at `path` under exactly `filters` (count reads aside). */
    tableReads(path: string, filters: Readonly<Record<string, string>> = {}) {
      return log.filter(tableRead(path, filters));
    },
    /** GET /admin/v1/pay-orders/{pay_order_id}. */
    detailReads(payOrderId: string) {
      return gets(orderPath(payOrderId));
    },
    /** Every request to the pay console (/admin/v1/pay-…). */
    payRequests() {
      return log.filter((r) => r.path.startsWith('/admin/v1/pay-'));
    },
    /** Requests that are not one of the four GETs of CT-21e. */
    others() {
      return log.filter(
        (r) =>
          r.method !== 'GET' ||
          !(r.path === ORDERS || r.path === ANOMALIES || r.path === DIFFS || DETAIL.test(r.path)),
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
