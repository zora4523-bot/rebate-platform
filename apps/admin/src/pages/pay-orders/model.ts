// 支付单页的数据辅助：支付单状态、渠道、业务类型、退款状态与原因码、渠道请求类型与结果、异常收款
// 状态、R4 差错类型与状态的后台字典名（BR-TEXT-25，缺键显示编码）、后台金额（BR-TEXT-10，经
// @couli/money，只用整数分、不做客户端运算）、北京时间、筛选条件到查询参数、错误分类。这里不放文案。
import { formatYuanAdmin, parseFen } from '@couli/money';
import { pay_channel, pay_order_status, recon_diff_status, type Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { payOrdersTexts as t } from '../../texts/pay-orders.ts';

export type PayOrder = Schema<'AdminPayOrder'>;
export type PayOrderDetail = Schema<'AdminPayOrderDetail'>;
export type PayRefund = Schema<'AdminPayRefund'>;
export type QueryAttempt = Schema<'AdminPayQueryAttempt'>;
export type PayAnomaly = Schema<'AdminPayAnomaly'>;
export type PayReconDiff = Schema<'AdminPayReconDiff'>;
export type PayOrderStatus = Schema<'AdminPayOrderStatus'>;
export type PayChannel = Schema<'AdminPayChannel'>;
export type PayReconDiffType = Schema<'AdminPayReconDiffType'>;
export type ReconDiffStatus = Schema<'AdminReconDiffStatus'>;

export const ORDERS_URL = '/admin/v1/pay-orders';
export const ANOMALIES_URL = '/admin/v1/pay-anomalies';
export const DIFFS_URL = '/admin/v1/pay-recon-diffs';
export const orderUrl = (payOrderId: string): string =>
  `${ORDERS_URL}/${encodeURIComponent(payOrderId)}`;

/** page_size of the three lists (contract ≤ 200). */
export const PAGE_SIZE = 20;

export const ORDER_STATUSES: readonly PayOrderStatus[] = pay_order_status;
export const CHANNELS: readonly PayChannel[] = pay_channel;
/** The two R4 types (AdminPayReconDiffType). */
export const DIFF_TYPES: readonly PayReconDiffType[] = ['pay_mismatch', 'pay_anomaly'];
export const DIFF_STATUSES: readonly ReconDiffStatus[] = recon_diff_status;

interface AdminDictionary {
  readonly texts: Readonly<Record<string, string>>;
}

// 随包的后台字典（contracts/texts.admin.default.json，BR-TEXT-25）。Vite glob 让 JSON 留在本包
// TS 工程之外，Vite 与 Vitest 会把它内联。
const loaded = import.meta.glob<AdminDictionary>(
  '../../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary: Readonly<Record<string, string>> = Object.values(loaded)[0]?.texts ?? {};

function dictName(key: string, code: string): string {
  const name = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
  return typeof name === 'string' && name !== '' ? name : code;
}

/** admin_dict.pay_order_status.<code>, else the code. */
export const orderStatusLabel = (code: string): string =>
  dictName(`admin_dict.pay_order_status.${code}`, code);
/** admin_dict.pay_channel.<code>, else the code. */
export const channelLabel = (code: string): string =>
  dictName(`admin_dict.pay_channel.${code}`, code);
/** admin_dict.pay_biz_type.<code> (no rows yet), else the code. */
export const bizTypeLabel = (code: string): string =>
  dictName(`admin_dict.pay_biz_type.${code}`, code);
/** admin_dict.pay_refund_status.<code>, else the code. */
export const refundStatusLabel = (code: string): string =>
  dictName(`admin_dict.pay_refund_status.${code}`, code);
/** admin_dict.pay_refund_reason.<code>, else the code. */
export const refundReasonLabel = (code: string): string =>
  dictName(`admin_dict.pay_refund_reason.${code}`, code);
/** admin_dict.pay_query_attempt_kind.<code> (no rows yet), else the code. */
export const attemptKindLabel = (code: string): string =>
  dictName(`admin_dict.pay_query_attempt_kind.${code}`, code);
/** admin_dict.pay_query_attempt_result.<code> (no rows yet), else the code. */
export const attemptResultLabel = (code: string): string =>
  dictName(`admin_dict.pay_query_attempt_result.${code}`, code);
/** admin_dict.pay_anomaly_status.<code> (no rows yet), else the code. */
export const anomalyStatusLabel = (code: string): string =>
  dictName(`admin_dict.pay_anomaly_status.${code}`, code);
/** admin_dict.recon_diff_type.<code>, else the code. */
export const diffTypeLabel = (code: string): string =>
  dictName(`admin_dict.recon_diff_type.${code}`, code);
/** admin_dict.recon_diff_status.<code>, else the code. */
export const diffStatusLabel = (code: string): string =>
  dictName(`admin_dict.recon_diff_status.${code}`, code);

/** Admin amount (BR-TEXT-10: ¥, thousands, two decimals, minus sign kept). */
export function money(fen: number): string {
  return formatYuanAdmin(parseFen(fen));
}

/** A value as given; null or empty shows the dash. */
export function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? t.dash : value;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const two = (value: number): string => String(value).padStart(2, '0');

/** YYYY-MM-DD HH:mm:ss in Beijing; null shows the dash, unreadable input is shown as is. */
export function beijingTime(iso: string | null): string {
  if (iso === null) return t.dash;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/** The refund state derived from refunded_fen (the status itself never changes, BR-PAY-06 ③). */
export function refundState(row: PayOrder): 'none' | 'partly' | 'fully' {
  if (row.refunded_fen <= 0) return 'none';
  return row.refunded_fen >= row.amount_fen ? 'fully' : 'partly';
}

// ---- pay order filters -------------------------------------------------------------------

/** Applied pay order conditions (what the last 【查询】 sent). */
export interface OrderFilters {
  readonly status?: PayOrderStatus;
  readonly payChannel?: PayChannel;
  readonly needsManual?: boolean;
  readonly outTradeNo?: string;
  readonly userId?: string;
}

/** Draft of the pay order filter form. */
export interface OrderDraft {
  readonly status: PayOrderStatus | undefined;
  readonly payChannel: PayChannel | undefined;
  readonly needsManual: boolean | undefined;
  readonly outTradeNo: string;
  readonly userId: string;
}

export const EMPTY_ORDER_DRAFT: OrderDraft = {
  status: undefined,
  payChannel: undefined,
  needsManual: undefined,
  outTradeNo: '',
  userId: '',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks the draft before sending (user_id is a whole id, as the server checks). */
export function checkOrderDraft(
  draft: OrderDraft,
): { filters: OrderFilters } | { userError: string } {
  const outTradeNo = draft.outTradeNo.trim().slice(0, 64);
  const userId = draft.userId.trim();
  if (userId !== '' && !UUID.test(userId)) return { userError: t.orders.filter.userInvalid };
  return {
    filters: {
      ...(draft.status === undefined ? {} : { status: draft.status }),
      ...(draft.payChannel === undefined ? {} : { payChannel: draft.payChannel }),
      ...(draft.needsManual === undefined ? {} : { needsManual: draft.needsManual }),
      ...(outTradeNo === '' ? {} : { outTradeNo }),
      ...(userId === '' ? {} : { userId }),
    },
  };
}

/** Filter parameters of listAdminPayOrders (paging is added by the read). */
export function orderParams(filters: OrderFilters): Record<string, string> {
  return {
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.payChannel === undefined ? {} : { pay_channel: filters.payChannel }),
    ...(filters.needsManual === undefined ? {} : { needs_manual: String(filters.needsManual) }),
    ...(filters.outTradeNo === undefined ? {} : { out_trade_no: filters.outTradeNo }),
    ...(filters.userId === undefined ? {} : { user_id: filters.userId }),
  };
}

// ---- anomaly and difference filters --------------------------------------------------------

export interface AnomalyFilters {
  readonly payChannel?: PayChannel;
}

/** Filter parameters of listAdminPayAnomalies (paging is added by the read). */
export function anomalyParams(filters: AnomalyFilters): Record<string, string> {
  return {
    ...(filters.payChannel === undefined ? {} : { pay_channel: filters.payChannel }),
  };
}

export interface DiffFilters {
  readonly type?: PayReconDiffType;
  readonly status?: ReconDiffStatus;
}

/** Filter parameters of listAdminPayReconDiffs (paging is added by the read). */
export function diffParams(filters: DiffFilters): Record<string, string> {
  return {
    ...(filters.type === undefined ? {} : { type: filters.type }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
  };
}

export const codeOf = (cause: unknown): number | undefined =>
  cause instanceof AdminApiError ? cause.code : undefined;
