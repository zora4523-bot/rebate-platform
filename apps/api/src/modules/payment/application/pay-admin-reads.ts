// B2-15f: the console's pay reads (contract listAdminPayOrders, getAdminPayOrder,
// listAdminPayAnomalies; 08 BR-PAY-05 ③④, BR-PAY-06 ③, BR-PAY-08 ④; 规划/04 §6.6, §11.2); B2-15j
// adds listAdminPayReconDiffs (BR-PAY-07: the R4 recon diffs, read through ledger's index.ts
// getReconDiffs, never from recon_diffs directly: ledger is that table's only owner); B2-15o adds
// listAdminPayRefunds and getAdminPayRefund (BR-PAY-06 ①, payment's own pay_refunds). The
// permission check (pay.view, read only, no step-up) is the controller's, through platform's
// AdminOperationGuard; appId is always the guard's actor, never a header or query field. Nothing
// is written or audited. Every answer is built field by field from the contract's schema: no
// channel-side user identifier exists in any of them (pay_query_attempts' bodies and
// pay_anomalies' evidence are never read, infra/pay-admin-store.ts). Amounts stay bigint fen until
// the JSON integer of @couli/money.
import type { DB } from '@couli/db';
import type { ReconDiffStatus, Schema } from '@couli/contracts-ts';
import { fenToJsonNumber } from '@couli/money';
import type { Kysely } from 'kysely';
import { getReconDiffs, type ReconDiff } from '../../ledger/index.ts';
import type { PayChannelCode, PayOrderStatus } from '../domain/types.ts';
import {
  attemptsOfOrder,
  countPayAnomalies,
  countPayOrders,
  pagePayAnomalies,
  pagePayOrders,
  refundsOfOrder,
  type PayAnomalyListRow,
  type PayOrderFilter,
} from '../infra/pay-admin-store.ts';
import { findOrderById, type PayOrderRow } from '../infra/pay-order-store.ts';
import { findRefundById, type PayRefundsTable } from '../infra/pay-refund-store.ts';
import { payRefundView } from './pay-refunds.ts';

/** A 20001 with data.fields (the created range; pay_order_id for an unknown or foreign order). */
export class PayAdminFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('payment: admin pay read refused');
    this.name = 'PayAdminFieldsError';
    this.fields = fields;
  }
}

/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
/** Contract AdminPayOrderDetail.query_attempts maxItems. */
const ATTEMPT_LIMIT = 20;

/** The ids are uuid columns; any other text names no row (contract Id is any short string). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** The query of GET /admin/v1/pay-orders after the route schema (coerced types). */
export interface PayOrderListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly status?: string;
  readonly pay_channel?: string;
  readonly biz_type?: string;
  readonly user_id?: string;
  readonly out_trade_no?: string;
  readonly needs_manual?: boolean;
  readonly created_from?: string;
  readonly created_to?: string;
}

/** The query of GET /admin/v1/pay-anomalies after the route schema. */
export interface PayAnomalyListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly pay_channel?: string;
}

/** B2-15j: the query of GET /admin/v1/pay-recon-diffs after the route schema (enums checked). */
export interface PayReconDiffListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly type?: string;
  readonly status?: string;
}

/** B2-15o: the query of GET /admin/v1/pay-refunds after the route schema (enums checked). */
export interface PayRefundListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly status?: string;
  readonly target_type?: string;
  readonly reason_code?: string;
}

/** The collection recon diffs (contract AdminPayReconDiffType; BR-PAY-07 source R4). */
const PAY_DIFF_TYPES: readonly string[] = Object.freeze(['pay_mismatch', 'pay_anomaly']);

/** The contract AdminPayReconDiff of an R4 recon diff row. */
export function adminPayReconDiffView(row: ReconDiff): Schema<'AdminPayReconDiff'> {
  return {
    recon_diff_id: row.id,
    source: 'R4',
    type: row.type as Schema<'AdminPayReconDiffType'>,
    period: row.period,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    expected_fen: fenToJsonNumber(row.expected_fen),
    actual_fen: fenToJsonNumber(row.actual_fen),
    diff_fen: fenToJsonNumber(row.diff_fen),
    status: row.status as Schema<'AdminReconDiffStatus'>,
    created_at: row.created_at.toISOString(),
    closed_at: iso(row.closed_at),
  };
}

/** created_at descending, id descending on a tie (the order of the other console lists). */
function newestFirst(a: ReconDiff, b: ReconDiff): number {
  const byTime = b.created_at.getTime() - a.created_at.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The contract AdminPayOrder of a row (no channel-side user identifier). */
export function adminPayOrderView(row: PayOrderRow): Schema<'AdminPayOrder'> {
  return {
    pay_order_id: row.id,
    user_id: row.user_id,
    biz_type: row.biz_type,
    biz_ref: row.biz_ref,
    pay_channel: row.pay_channel as PayChannelCode,
    amount_fen: fenToJsonNumber(row.amount_fen),
    refunded_fen: fenToJsonNumber(row.refunded_fen),
    status: row.status as PayOrderStatus,
    out_trade_no: row.out_trade_no,
    channel_trade_no: row.channel_trade_no,
    needs_manual: row.needs_manual,
    closing: row.closing,
    expire_at: row.expire_at.toISOString(),
    paid_at: iso(row.paid_at),
    closed_at: iso(row.closed_at),
    created_at: row.created_at.toISOString(),
  };
}

/** The contract AdminPayAnomaly of a row (the evidence is never part of it). */
export function adminPayAnomalyView(row: PayAnomalyListRow): Schema<'AdminPayAnomaly'> {
  return {
    pay_anomaly_id: row.id,
    pay_channel: row.pay_channel as PayChannelCode,
    channel_trade_no: row.channel_trade_no,
    out_trade_no: row.out_trade_no,
    pay_order_id: row.pay_order_id,
    amount_fen: fenToJsonNumber(row.amount_fen),
    refunded_fen: fenToJsonNumber(row.refunded_fen),
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * The created range as given (ISO 8601 with offset, checked by the route schema): both must parse,
 * and created_from later than created_to is refused. The texts go to the database as timestamptz.
 */
function createdRange(query: PayOrderListQuery): { from?: string; to?: string } {
  const from = query.created_from;
  const to = query.created_to;
  const fromMs = from === undefined ? undefined : Date.parse(from);
  const toMs = to === undefined ? undefined : Date.parse(to);
  if (fromMs !== undefined && Number.isNaN(fromMs)) throw new PayAdminFieldsError(['created_from']);
  if (toMs !== undefined && Number.isNaN(toMs)) throw new PayAdminFieldsError(['created_to']);
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new PayAdminFieldsError(['created_from', 'created_to']);
  }
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

/** The app's refunds matching the list's filters, combined with AND (enums checked by the route). */
function filteredRefunds(db: Kysely<DB>, appId: string, query: PayRefundListQuery) {
  let refunds = db
    .$extendTables<{ pay_refunds: PayRefundsTable }>()
    .selectFrom('pay_refunds')
    .where('app_id', '=', appId);
  if (query.status !== undefined) refunds = refunds.where('status', '=', query.status);
  if (query.target_type !== undefined) {
    refunds = refunds.where('target_type', '=', query.target_type);
  }
  if (query.reason_code !== undefined) {
    refunds = refunds.where('reason_code', '=', query.reason_code);
  }
  return refunds;
}

export class PayAdminReads {
  readonly #db: Kysely<DB> | null;

  constructor(db: Kysely<DB> | null) {
    this.#db = db;
  }

  #handle(): Kysely<DB> {
    // Without a database (isolated HTTP unit tests) every read fails closed (50001).
    if (this.#db === null) throw new Error('payment: admin pay reads need the database');
    return this.#db;
  }

  /** GET /admin/v1/pay-orders. */
  async listOrders(appId: string, query: PayOrderListQuery): Promise<Schema<'AdminPayOrderPage'>> {
    const range = createdRange(query);
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    // A user_id that is not a UUID names no user of ours (pay_orders.user_id is uuid).
    if (query.user_id !== undefined && !isUuid(query.user_id)) {
      return { items: [], page, page_size: pageSize, total: 0 };
    }
    const db = this.#handle();
    const filter: PayOrderFilter = {
      appId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.pay_channel === undefined ? {} : { payChannel: query.pay_channel }),
      ...(query.biz_type === undefined ? {} : { bizType: query.biz_type }),
      ...(query.user_id === undefined ? {} : { userId: query.user_id.toLowerCase() }),
      ...(query.out_trade_no === undefined ? {} : { outTradeNo: query.out_trade_no }),
      ...(query.needs_manual === undefined ? {} : { needsManual: query.needs_manual }),
      ...(range.from === undefined ? {} : { createdFrom: range.from }),
      ...(range.to === undefined ? {} : { createdTo: range.to }),
    };
    const total = await countPayOrders(db, filter);
    const offset = (page - 1) * pageSize;
    const rows = offset >= total ? [] : await pagePayOrders(db, filter, offset, pageSize);
    return { items: rows.map(adminPayOrderView), page, page_size: pageSize, total };
  }

  /** GET /admin/v1/pay-orders/{pay_order_id}. */
  async detail(appId: string, payOrderId: string): Promise<Schema<'AdminPayOrderDetail'>> {
    if (!isUuid(payOrderId)) throw new PayAdminFieldsError(['pay_order_id']);
    const db = this.#handle();
    const id = payOrderId.toLowerCase();
    const order = await findOrderById(db, appId, id);
    if (order === undefined) throw new PayAdminFieldsError(['pay_order_id']);
    const refunds = await refundsOfOrder(db, appId, id);
    const attempts = await attemptsOfOrder(db, appId, id, ATTEMPT_LIMIT);
    return {
      pay_order: adminPayOrderView(order),
      refunds: refunds.map(payRefundView),
      query_attempts: attempts.map((attempt) => ({
        kind: attempt.kind as Schema<'AdminPayQueryAttemptKind'>,
        // Every writer records a result; a row without one reads unknown (contract minLength 1).
        result: attempt.result ?? 'unknown',
        at: attempt.at.toISOString(),
      })),
    };
  }

  /** GET /admin/v1/pay-anomalies. */
  async listAnomalies(
    appId: string,
    query: PayAnomalyListQuery,
  ): Promise<Schema<'AdminPayAnomalyPage'>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const db = this.#handle();
    const filter = {
      appId,
      ...(query.pay_channel === undefined ? {} : { payChannel: query.pay_channel }),
    };
    const total = await countPayAnomalies(db, filter);
    const offset = (page - 1) * pageSize;
    const rows = offset >= total ? [] : await pagePayAnomalies(db, filter, offset, pageSize);
    return { items: rows.map(adminPayAnomalyView), page, page_size: pageSize, total };
  }

  /**
   * B2-15j: GET /admin/v1/pay-recon-diffs. Only source R4 of type pay_mismatch / pay_anomaly; type
   * and status combine with AND. ledger's getReconDiffs filters by app and status; the source, the
   * type, the order and the page are applied here.
   */
  async listReconDiffs(
    appId: string,
    query: PayReconDiffListQuery,
  ): Promise<Schema<'AdminPayReconDiffPage'>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const db = this.#handle();
    const rows = await getReconDiffs(db, {
      appId,
      ...(query.status === undefined ? {} : { status: query.status as ReconDiffStatus }),
    });
    const matching = rows
      .filter(
        (row) =>
          row.source === 'R4' &&
          PAY_DIFF_TYPES.includes(row.type) &&
          (query.type === undefined || row.type === query.type),
      )
      .sort(newestFirst);
    const offset = (page - 1) * pageSize;
    const items = matching.slice(offset, offset + pageSize).map(adminPayReconDiffView);
    return { items, page, page_size: pageSize, total: matching.length };
  }

  /** B2-15o: GET /admin/v1/pay-refunds. */
  async listRefunds(
    appId: string,
    query: PayRefundListQuery,
  ): Promise<Schema<'AdminPayRefundPage'>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const filtered = filteredRefunds(this.#handle(), appId, query);
    const count = await filtered
      .select((eb) => eb.fn.countAll<bigint | string>().as('total'))
      .executeTakeFirst();
    const total = Number(count?.total ?? 0);
    const offset = (page - 1) * pageSize;
    const rows =
      offset >= total
        ? []
        : await filtered
            .selectAll()
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .offset(offset)
            .limit(pageSize)
            .execute();
    return { items: rows.map(payRefundView), page, page_size: pageSize, total };
  }

  /** B2-15o: GET /admin/v1/pay-refunds/{pay_refund_id}. An unknown or foreign id is 20001. */
  async refundDetail(appId: string, payRefundId: string): Promise<Schema<'AdminPayRefund'>> {
    if (!isUuid(payRefundId)) throw new PayAdminFieldsError(['pay_refund_id']);
    const refund = await findRefundById(this.#handle(), appId, payRefundId.toLowerCase());
    if (refund === undefined) throw new PayAdminFieldsError(['pay_refund_id']);
    return payRefundView(refund);
  }
}
