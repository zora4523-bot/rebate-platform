import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the write part of the pay console (CT-21e, tag admin-pay):
// createAdminPayRefund POST /admin/v1/pay-orders/{pay_order_id}/refunds and
// createAdminPayAnomalyRefund POST /admin/v1/pay-anomalies/{pay_anomaly_id}/refunds (pay.refund,
// Idempotency-Key, no step-up, BR-PAY-06), resolveAdminPayOrder POST
// /admin/v1/pay-orders/{pay_order_id}/resolve (pay.resolve, totp step-up, fixed body, no
// Idempotency-Key, BR-PAY-05 ③), next to the four reads of F1-13a (pay.view). Written from zero:
// nothing is imported from the frozen read-only tests. Ids are obvious fake UUIDs whose first 8
// characters differ; numbers and amounts are samples, every refundable amount is hand-computed.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const MENU_ID = 'pay-orders';
export const ORDERS = '/admin/v1/pay-orders';
export const ANOMALIES = '/admin/v1/pay-anomalies';
export const DIFFS = '/admin/v1/pay-recon-diffs';
/** The refund list / single refund reads: not implemented, never to be read by this page. */
export const REFUND_READS = '/admin/v1/pay-refunds';
export const VERIFY = '/admin/v1/auth/step-up';
/** The one dynamic code the fake verification accepts. */
export const TOTP_CODE = '123456';

export const orderPath = (payOrderId: string): string => `${ORDERS}/${payOrderId}`;
export const refundPath = (payOrderId: string): string => `${ORDERS}/${payOrderId}/refunds`;
export const resolvePath = (payOrderId: string): string => `${ORDERS}/${payOrderId}/resolve`;
export const anomalyRefundPath = (payAnomalyId: string): string =>
  `${ANOMALIES}/${payAnomalyId}/refunds`;
export const detailRoute = (payOrderId: string): string => `${MENU_ID}/${payOrderId}`;

/** The value the fake verification hands out the n-th time (1-based); low-entropy on purpose. */
export function issuedStepUp(n: number): string {
  return `test-only-step-up-${n}`;
}

export type PayOrder = Schema<'AdminPayOrder'>;
export type PayOrderDetail = Schema<'AdminPayOrderDetail'>;
export type PayRefund = Schema<'AdminPayRefund'>;
export type PayAnomaly = Schema<'AdminPayAnomaly'>;
export type RefundReason = Schema<'AdminPayRefundReason'>;
export type ChannelResult = Schema<'AdminPayChannelResult'>;

/** contracts/enums/pay.yaml pay_refund_reason, in its order. */
export const REASONS: readonly RefundReason[] = [
  'USER_REQUEST',
  'DUPLICATE_PAYMENT',
  'ANOMALY_RECEIPT',
  'RECON_DIFF',
  'OTHER',
];

// ---- console dictionary (BR-TEXT-25 admin_dict) --------------------------------------------

/** Where the dictionary keeps each kind of name (read when the test runs). */
export const DICT_FIELD = {
  payStatus: /^admin_dict\.pay_orders?(?:\.status|_status)\.([^.]+)$/,
  refundStatus: /^admin_dict\.pay_refunds?(?:\.status|_status)\.([^.]+)$/,
  refundReason: /^admin_dict\.pay_refunds?(?:\.reason(?:_code)?|_reason)\.([^.]+)$/,
  channel: /^admin_dict\.pay_channels?\.([^.]+)$/,
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

export const ORDER = {
  /**
   * PAID (alipay, 12800 fen) with three refunds: SUCCESS 3050, PROCESSING 1500, FAILED 2000;
   * refunded_fen 3050. Refundable 12800 − 3050 − 1500 = 8250 fen (82.50); the FAILED one does
   * not count.
   */
  refunded: 'b7100001-0000-4000-8000-000000000001',
  /** PAID (wechat_pay, 2500 fen), nothing refunded: refundable 2500 fen (25.00). */
  paid: 'b7200002-0000-4000-8000-000000000002',
  /** PENDING, closing, needs_manual (wechat_pay, 1900 fen): the 【立即查询】 sample. */
  manual: 'b7300003-0000-4000-8000-000000000003',
  /** PENDING without needs_manual (alipay, 990 fen): automatic handling still runs. */
  pending: 'b7400004-0000-4000-8000-000000000004',
  /** CLOSED (wechat_pay, 990 fen). */
  closed: 'b7500005-0000-4000-8000-000000000005',
} as const;
export const OUT_TRADE_NO = {
  refunded: 'PWSAMPLE20261022001',
  paid: 'PWSAMPLE20261021002',
  manual: 'PWSAMPLE20261024003',
  pending: 'PWSAMPLE20261024004',
  closed: 'PWSAMPLE20261020005',
} as const;
/** The operator recorded on refunds. */
export const OPERATOR = 'ad000001-0000-4000-8000-0000000000a1';

/** Hand-computed refundable amounts (amount − SUCCESS − PROCESSING), in fen and as shown. */
export const REFUNDABLE = {
  /** 12800 − 3050 − 1500 = 8250. */
  refunded: { fen: 8250, yuan: '82.50', over: '82.51' },
  /** 2500 − 0 − 0 = 2500. */
  paid: { fen: 2500, yuan: '25.00', over: '25.01' },
  /** Anomaly 990 − 0 = 990. */
  anomalyOpen: { fen: 990, yuan: '9.90', over: '9.91' },
  /** Anomaly 6600 − 1600 = 5000. */
  anomalyPartial: { fen: 5000, yuan: '50.00', over: '50.01' },
} as const;

function order(fields: Pick<PayOrder, 'pay_order_id' | 'out_trade_no'> & Partial<PayOrder>) {
  const base: PayOrder = {
    pay_order_id: fields.pay_order_id,
    user_id: 'c7000000-0000-4000-8000-000000000000',
    biz_type: 'membership',
    biz_ref: 'd7000000-0000-4000-8000-000000000000',
    pay_channel: 'wechat_pay',
    amount_fen: 1900,
    refunded_fen: 0,
    status: 'PAID',
    out_trade_no: fields.out_trade_no,
    channel_trade_no: null,
    needs_manual: false,
    closing: false,
    expire_at: '2026-10-21T14:35:00+08:00',
    paid_at: null,
    closed_at: null,
    created_at: '2026-10-21T14:20:00+08:00',
  };
  return { ...base, ...fields };
}

/** The five samples, created_at descending. */
export function orders(): PayOrder[] {
  return [
    order({
      pay_order_id: ORDER.manual,
      out_trade_no: OUT_TRADE_NO.manual,
      user_id: 'c7300003-0000-4000-8000-000000000003',
      pay_channel: 'wechat_pay',
      amount_fen: 1900,
      status: 'PENDING',
      needs_manual: true,
      closing: true,
      expire_at: '2026-10-24T10:45:00+08:00',
      created_at: '2026-10-24T10:30:00+08:00',
    }),
    order({
      pay_order_id: ORDER.pending,
      out_trade_no: OUT_TRADE_NO.pending,
      user_id: 'c7400004-0000-4000-8000-000000000004',
      pay_channel: 'alipay',
      amount_fen: 990,
      status: 'PENDING',
      expire_at: '2026-10-24T09:15:00+08:00',
      created_at: '2026-10-24T09:00:00+08:00',
    }),
    order({
      pay_order_id: ORDER.refunded,
      out_trade_no: OUT_TRADE_NO.refunded,
      user_id: 'c7100001-0000-4000-8000-000000000001',
      pay_channel: 'alipay',
      amount_fen: 12800,
      refunded_fen: 3050,
      status: 'PAID',
      channel_trade_no: 'CHWSAMPLE20261022000001',
      expire_at: '2026-10-22T09:15:00+08:00',
      paid_at: '2026-10-22T09:01:12+08:00',
      created_at: '2026-10-22T09:00:00+08:00',
    }),
    order({
      pay_order_id: ORDER.paid,
      out_trade_no: OUT_TRADE_NO.paid,
      user_id: 'c7200002-0000-4000-8000-000000000002',
      pay_channel: 'wechat_pay',
      amount_fen: 2500,
      status: 'PAID',
      channel_trade_no: 'CHWSAMPLE20261021000002',
      expire_at: '2026-10-21T14:35:00+08:00',
      paid_at: '2026-10-21T14:22:30+08:00',
      created_at: '2026-10-21T14:20:00+08:00',
    }),
    order({
      pay_order_id: ORDER.closed,
      out_trade_no: OUT_TRADE_NO.closed,
      user_id: 'c7500005-0000-4000-8000-000000000005',
      pay_channel: 'wechat_pay',
      amount_fen: 990,
      status: 'CLOSED',
      expire_at: '2026-10-20T08:15:00+08:00',
      closed_at: '2026-10-20T08:40:00+08:00',
      created_at: '2026-10-20T08:00:00+08:00',
    }),
  ];
}

/** The three refunds of ORDER.refunded (newest first). */
export const OUT_REFUND_NO = {
  processing: 'RWSAMPLE20261023003',
  failed: 'RWSAMPLE20261022002',
  success: 'RWSAMPLE20261022001',
} as const;

function refundedRefunds(): PayRefund[] {
  return [
    {
      pay_refund_id: 'e7100003-0000-4000-8000-000000000003',
      target_type: 'pay_order',
      target_id: ORDER.refunded,
      out_refund_no: OUT_REFUND_NO.processing,
      amount_fen: 1500,
      reason_code: 'DUPLICATE_PAYMENT',
      note: null,
      status: 'PROCESSING',
      channel_refund_no: null,
      operator: OPERATOR,
      created_at: '2026-10-23T09:00:00+08:00',
      succeeded_at: null,
    },
    {
      pay_refund_id: 'e7100002-0000-4000-8000-000000000002',
      target_type: 'pay_order',
      target_id: ORDER.refunded,
      out_refund_no: OUT_REFUND_NO.failed,
      amount_fen: 2000,
      reason_code: 'OTHER',
      note: null,
      status: 'FAILED',
      channel_refund_no: null,
      operator: OPERATOR,
      created_at: '2026-10-22T15:00:00+08:00',
      succeeded_at: null,
    },
    {
      pay_refund_id: 'e7100001-0000-4000-8000-000000000001',
      target_type: 'pay_order',
      target_id: ORDER.refunded,
      out_refund_no: OUT_REFUND_NO.success,
      amount_fen: 3050,
      reason_code: 'USER_REQUEST',
      note: null,
      status: 'SUCCESS',
      channel_refund_no: 'CRWSAMPLE20261022000001',
      operator: OPERATOR,
      created_at: '2026-10-22T11:00:00+08:00',
      succeeded_at: '2026-10-22T11:00:08+08:00',
    },
  ];
}

/** The refund number the fake server gives its n-th new refund (1-based). */
export function newOutRefundNo(n: number): string {
  return `RWNEW${String(n).padStart(8, '0')}`;
}

export const ANOMALY = {
  /** wechat_pay, money for the CLOSED sample, 990 fen, nothing refunded: refundable 990. */
  open: 'f7100001-0000-4000-8000-000000000001',
  /** alipay, no pay order of ours, 6600 fen, 1600 refunded: refundable 5000. */
  partial: 'f7200002-0000-4000-8000-000000000002',
} as const;
export const ANOMALY_TRADE_NO = {
  open: 'CHWANOMALY20261023000001',
  partial: 'CHWANOMALY20261022000002',
} as const;

export function anomalies(): PayAnomaly[] {
  return [
    {
      pay_anomaly_id: ANOMALY.open,
      pay_channel: 'wechat_pay',
      channel_trade_no: ANOMALY_TRADE_NO.open,
      out_trade_no: OUT_TRADE_NO.closed,
      pay_order_id: ORDER.closed,
      amount_fen: 990,
      refunded_fen: 0,
      status: 'open',
      created_at: '2026-10-23T02:10:00+08:00',
    },
    {
      pay_anomaly_id: ANOMALY.partial,
      pay_channel: 'alipay',
      channel_trade_no: ANOMALY_TRADE_NO.partial,
      out_trade_no: null,
      pay_order_id: null,
      amount_fen: 6600,
      refunded_fen: 1600,
      status: 'open',
      created_at: '2026-10-22T03:25:00+08:00',
    },
  ];
}

// ---- permissions -----------------------------------------------------------------------------

export type Grants = readonly KnownPermission[];
export const VIEW_GRANTS: Grants = ['pay.view'];
export const VIEW_REFUND_GRANTS: Grants = ['pay.view', 'pay.refund'];
export const VIEW_RESOLVE_GRANTS: Grants = ['pay.view', 'pay.resolve'];
export const ALL_GRANTS: Grants = ['pay.view', 'pay.refund', 'pay.resolve'];
/** Write points without pay.view. */
export const REFUND_ONLY_GRANTS: Grants = ['pay.refund'];
export const RESOLVE_ONLY_GRANTS: Grants = ['pay.resolve'];

/** Permission snapshot as /admin/v1/me/permissions gives it (04 §11.2: pay.resolve is totp). */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of permissions)
    stepUp[point] = { tier: point === 'pay.resolve' ? 'totp' : null, operations: {} };
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
  10003: 403,
  10403: 403,
  20001: 400,
  20002: 400,
  20901: 409,
  20902: 409,
  40901: 409,
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
/** 20902 of a pay order that is no longer in the expected status. */
export function conflict(): Response {
  return failure(20902, { resource: 'pay_order' }, '状态已变化，请刷新后重试');
}
/** 20901: the same Idempotency-Key with another body. */
export function changedBody(): Response {
  return failure(20901, undefined, '请求内容有变化，请重新提交');
}
/** 40901: the same request is still being handled. */
export function inProgress(): Response {
  return failure(40901, undefined, '请求正在处理');
}
/** 10003: a totp step-up is needed. */
export function stepUpRequired(): Response {
  return failure(10003, { tier: 'totp' }, '这项操作需要二次验证，请输入动态码');
}
/** A network failure (the request never got an answer). */
export function networkDown(): never {
  throw new TypeError('Failed to fetch');
}

export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;

/** How the next 【立即查询】 is answered by the channel. */
export type ResolveOutcome = 'paid' | 'closed' | 'not_exist_closed' | 'not_exist' | 'unknown';

export interface ServerOptions {
  /** Permission points of the account (the server checks them; 10403 otherwise). */
  readonly permissions?: Grants;
  readonly anomalies?: readonly PayAnomaly[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE = /^[1-9][0-9]*$/;
const DETAIL = /^\/admin\/v1\/pay-orders\/([^/]+)$/;
const ORDER_REFUND = /^\/admin\/v1\/pay-orders\/([^/]+)\/refunds$/;
const ORDER_RESOLVE = /^\/admin\/v1\/pay-orders\/([^/]+)\/resolve$/;
const ANOMALY_REFUND = /^\/admin\/v1\/pay-anomalies\/([^/]+)\/refunds$/;
const REFUND_FIELDS: readonly string[] = ['amount_fen', 'reason_code', 'note'];
const QUERIED_AT = '2026-10-31T12:05:00+08:00';

/** Fields of a refund body that break AdminPayRefundCreateRequest. */
function refundBodyInvalid(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return ['body'];
  const value = body as Record<string, unknown>;
  const amount = value['amount_fen'];
  const reason = value['reason_code'];
  const note = value['note'];
  return [
    ...Object.keys(value).filter((name) => !REFUND_FIELDS.includes(name)),
    ...(typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 1
      ? []
      : ['amount_fen']),
    ...(typeof reason === 'string' && (REASONS as readonly string[]).includes(reason)
      ? []
      : ['reason_code']),
    ...(note === undefined || (typeof note === 'string' && note.length >= 1 && note.length <= 200)
      ? []
      : ['note']),
  ];
}
/** The body with its keys sorted (two bodies are the same request when these are equal). */
function canonical(body: unknown): string {
  const value = body as Record<string, unknown>;
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}
function isResolveBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    value['expected_status'] === 'PENDING' &&
    value['action'] === 'query_and_settle'
  );
}

/** Fake /admin/v1 server with the CT-21e checks of the four reads and the three writes. */
export function createServer(initial: PayOrder[] = orders(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const anomalyState = structuredClone([...(options.anomalies ?? anomalies())]);
  const refundsOf = new Map<string, PayRefund[]>([[ORDER.refunded, refundedRefunds()]]);
  const attemptsOf = new Map<string, Schema<'AdminPayQueryAttempt'>[]>();
  /** Processing refunds of each anomaly (its list row carries the successful ones only). */
  const anomalyProcessing = new Map<string, number>();
  const remembered = new Map<string, { readonly body: string; readonly refund: PayRefund }>();
  const issued: string[] = [];
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply; persistent: boolean }[] = [];
  const permissions = options.permissions ?? VIEW_GRANTS;
  let created = 0;
  let outcome: ResolveOutcome = 'unknown';
  let inFlight = 0;

  const holds = (point: KnownPermission): boolean => permissions.includes(point);

  function page<T>(rows: readonly T[], query: Record<string, string>): Response {
    const { page: pageText, page_size: sizeText } = query;
    const invalid = [
      ...(pageText === undefined || POSITIVE.test(pageText) ? [] : ['page']),
      ...(sizeText === undefined || (POSITIVE.test(sizeText) && Number(sizeText) <= 200)
        ? []
        : ['page_size']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    const pageNo = pageText === undefined ? 1 : Number(pageText);
    const pageSize = sizeText === undefined ? 20 : Number(sizeText);
    const items = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
    return ok({ items, page: pageNo, page_size: pageSize, total: rows.length });
  }

  function listOrders(query: Record<string, string>): Response {
    if (!holds('pay.view')) return denied();
    const { status, needs_manual: manual, out_trade_no: outTradeNo } = query;
    const rows = state.filter(
      (row) =>
        (status === undefined || row.status === status) &&
        (manual === undefined || String(row.needs_manual) === manual) &&
        (outTradeNo === undefined || row.out_trade_no === outTradeNo),
    );
    return page(rows, query);
  }

  function detail(payOrderId: string): Response {
    if (!holds('pay.view')) return denied();
    const row = UUID.test(payOrderId)
      ? state.find((one) => one.pay_order_id === payOrderId)
      : undefined;
    if (row === undefined) return rejected(['pay_order_id']);
    return ok({
      pay_order: row,
      refunds: refundsOf.get(payOrderId) ?? [],
      query_attempts: attemptsOf.get(payOrderId) ?? [],
    });
  }

  function verify(request: RequestLog): Response {
    const body = request.body as Partial<Schema<'AdminStepUpRequest'>> | undefined;
    if (body?.tier !== 'totp' || body.code !== TOTP_CODE)
      return failure(20002, undefined, '验证码错误');
    issued.push(issuedStepUp(issued.length + 1));
    return ok({ step_up_token: issued.at(-1), tier: 'totp', expire_at: '2099-01-01T00:00:00Z' });
  }

  function newRefund(
    targetType: PayRefund['target_type'],
    targetId: string,
    body: Record<string, unknown>,
  ): PayRefund {
    created += 1;
    return {
      pay_refund_id: `e79${String(created).padStart(5, '0')}-0000-4000-8000-${String(created).padStart(12, '0')}`,
      target_type: targetType,
      target_id: targetId,
      out_refund_no: newOutRefundNo(created),
      amount_fen: body['amount_fen'] as number,
      reason_code: body['reason_code'] as RefundReason,
      note: typeof body['note'] === 'string' ? body['note'] : null,
      status: 'PROCESSING',
      channel_refund_no: null,
      operator: OPERATOR,
      created_at: `2026-10-31T10:${String(created).padStart(2, '0')}:00+08:00`,
      succeeded_at: null,
    };
  }

  interface RefundTarget {
    readonly paid: boolean;
    readonly refundable: number;
    readonly create: (made: PayRefund) => void;
  }

  /** The common part of both refund operations; `target` finds the object and its room. */
  function refund(
    request: RequestLog,
    idField: 'pay_order_id' | 'pay_anomaly_id',
    target: () => RefundTarget | undefined,
    targetType: PayRefund['target_type'],
    targetId: string,
  ): Response {
    if (!holds('pay.refund')) return denied();
    const key = request.headers.get('Idempotency-Key');
    if (key === null || key.trim() === '') return rejected(['Idempotency-Key']);
    const invalid = refundBodyInvalid(request.body);
    if (invalid.length > 0) return rejected(invalid);
    const found = UUID.test(targetId) ? target() : undefined;
    if (found === undefined) return rejected([idField]);
    const body = canonical(request.body);
    const seen = remembered.get(`${request.path} ${key}`);
    if (seen !== undefined) return seen.body === body ? ok(seen.refund) : changedBody();
    if (!found.paid) return conflict();
    const value = request.body as Record<string, unknown>;
    if ((value['amount_fen'] as number) > found.refundable) return rejected(['amount_fen']);
    const made = newRefund(targetType, targetId, value);
    found.create(made);
    remembered.set(`${request.path} ${key}`, { body, refund: made });
    return ok(made);
  }

  function refundOrder(request: RequestLog, payOrderId: string): Response {
    return refund(
      request,
      'pay_order_id',
      () => {
        const row = state.find((one) => one.pay_order_id === payOrderId);
        if (row === undefined) return undefined;
        const list = refundsOf.get(payOrderId) ?? [];
        const used = list
          .filter((one) => one.status === 'SUCCESS' || one.status === 'PROCESSING')
          .reduce((sum, one) => sum + one.amount_fen, 0);
        return {
          paid: row.status === 'PAID',
          refundable: row.amount_fen - used,
          create: (made) => refundsOf.set(payOrderId, [made, ...list]),
        };
      },
      'pay_order',
      payOrderId,
    );
  }

  function refundAnomaly(request: RequestLog, payAnomalyId: string): Response {
    return refund(
      request,
      'pay_anomaly_id',
      () => {
        const row = anomalyState.find((one) => one.pay_anomaly_id === payAnomalyId);
        if (row === undefined) return undefined;
        const processing = anomalyProcessing.get(payAnomalyId) ?? 0;
        return {
          paid: true,
          refundable: row.amount_fen - row.refunded_fen - processing,
          create: (made) => anomalyProcessing.set(payAnomalyId, processing + made.amount_fen),
        };
      },
      'pay_anomaly',
      payAnomalyId,
    );
  }

  function resolve(request: RequestLog, payOrderId: string): Response {
    if (!holds('pay.resolve')) return denied();
    const presented = request.headers.get('X-Step-Up-Token');
    if (presented === null || !issued.includes(presented)) return stepUpRequired();
    if (!isResolveBody(request.body)) return rejected(['body']);
    const row = UUID.test(payOrderId)
      ? state.find((one) => one.pay_order_id === payOrderId)
      : undefined;
    if (row === undefined) return rejected(['pay_order_id']);
    if (row.status !== 'PENDING' || !row.needs_manual) return conflict();
    const answer = outcome;
    let result: ChannelResult;
    if (answer === 'paid') {
      Object.assign(row, {
        status: 'PAID',
        needs_manual: false,
        closing: false,
        channel_trade_no: 'CHWRESOLVED20261031000001',
        paid_at: '2026-10-24T10:44:31+08:00',
      });
      result = {
        state: 'paid',
        channel_state: 'SUCCESS',
        channel_trade_no: 'CHWRESOLVED20261031000001',
        queried_at: QUERIED_AT,
      };
    } else if (answer === 'closed' || answer === 'not_exist_closed') {
      Object.assign(row, {
        status: 'CLOSED',
        needs_manual: false,
        closing: false,
        closed_at: QUERIED_AT,
      });
      result = {
        state: answer === 'closed' ? 'closed' : 'not_exist',
        channel_state: answer === 'closed' ? 'CLOSED' : 'ORDERNOTEXIST',
        channel_trade_no: null,
        queried_at: QUERIED_AT,
      };
    } else {
      result = {
        state: answer,
        channel_state: answer === 'not_exist' ? 'ORDERNOTEXIST' : null,
        channel_trade_no: null,
        queried_at: QUERIED_AT,
      };
    }
    attemptsOf.set(payOrderId, [
      { kind: 'query', result: answer === 'unknown' ? 'unknown' : 'ok', at: QUERIED_AT },
      ...(attemptsOf.get(payOrderId) ?? []),
    ]);
    return ok({ pay_order: row, channel_result: result });
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token')
      return failure(10001, undefined, '未登录');
    if (method === 'GET' && path === ORDERS) return listOrders(request.query);
    if (method === 'GET' && path === ANOMALIES)
      return holds('pay.view') ? page(anomalyState, request.query) : denied();
    if (method === 'GET' && path === DIFFS)
      return holds('pay.view') ? page([], request.query) : denied();
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) return detail(decodeURIComponent(one[1]!));
    if (method === 'POST' && path === VERIFY) return verify(request);
    const orderRefund = ORDER_REFUND.exec(path);
    if (method === 'POST' && orderRefund !== null)
      return refundOrder(request, decodeURIComponent(orderRefund[1]!));
    const anomalyRefund = ANOMALY_REFUND.exec(path);
    if (method === 'POST' && anomalyRefund !== null)
      return refundAnomaly(request, decodeURIComponent(anomalyRefund[1]!));
    const settle = ORDER_RESOLVE.exec(path);
    if (method === 'POST' && settle !== null)
      return resolve(request, decodeURIComponent(settle[1]!));
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

  /** The four reads of F1-13a. */
  const isRead = (request: RequestLog): boolean =>
    request.method === 'GET' &&
    (request.path === ORDERS ||
      request.path === ANOMALIES ||
      request.path === DIFFS ||
      DETAIL.test(request.path));

  return {
    state,
    anomalyState,
    log,
    fetch,
    permissions,
    get pending() {
      return inFlight;
    },
    /** How the channel answers the following 【立即查询】 calls. */
    setResolveOutcome(next: ResolveOutcome) {
      outcome = next;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    /** GET /admin/v1/pay-orders/{pay_order_id}. */
    detailReads(payOrderId: string) {
      return log.filter((r) => r.method === 'GET' && r.path === orderPath(payOrderId));
    },
    /** GET /admin/v1/pay-anomalies. */
    anomalyReads() {
      return log.filter((r) => r.method === 'GET' && r.path === ANOMALIES);
    },
    /** POST …/pay-orders/{id}/refunds (all pay orders when `payOrderId` is left out). */
    refunds(payOrderId?: string) {
      return log.filter(
        (r) =>
          r.method === 'POST' &&
          (payOrderId === undefined
            ? ORDER_REFUND.test(r.path)
            : r.path === refundPath(payOrderId)),
      );
    },
    /** POST …/pay-anomalies/{id}/refunds. */
    anomalyRefunds(payAnomalyId?: string) {
      return log.filter(
        (r) =>
          r.method === 'POST' &&
          (payAnomalyId === undefined
            ? ANOMALY_REFUND.test(r.path)
            : r.path === anomalyRefundPath(payAnomalyId)),
      );
    },
    /** POST …/pay-orders/{id}/resolve. */
    resolves(payOrderId?: string) {
      return log.filter(
        (r) =>
          r.method === 'POST' &&
          (payOrderId === undefined
            ? ORDER_RESOLVE.test(r.path)
            : r.path === resolvePath(payOrderId)),
      );
    },
    /** POST /admin/v1/auth/step-up. */
    verifies() {
      return log.filter((r) => r.method === 'POST' && r.path === VERIFY);
    },
    /** Any read of the refund list or of one refund (never allowed here). */
    refundReads() {
      return log.filter((r) => r.path === REFUND_READS || r.path.startsWith(`${REFUND_READS}/`));
    },
    /** Every request to the pay console (/admin/v1/pay-…). */
    payRequests() {
      return log.filter((r) => r.path.startsWith('/admin/v1/pay-'));
    },
    /** Requests other than the four reads and the writes `allowed` (method and path). */
    unexpected(allowed: readonly (readonly [string, string])[] = []) {
      return log.filter(
        (r) =>
          !isRead(r) && !allowed.some(([method, path]) => r.method === method && r.path === path),
      );
    },
    /** Every write sent (any method but GET). */
    writes() {
      return log.filter((r) => r.method !== 'GET');
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
