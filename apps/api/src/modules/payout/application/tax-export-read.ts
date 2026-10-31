// B2-08d (规划/08 BR-WDR-21 涉税导出与报送; 编排裁定 D10-456 ④): the read-only port the admin export
// worker calls for the quarterly tax detail of paid withdrawals.
//
// createTaxExportReader({ decrypt })(handle, { appId, quarter, cursor?, limit? }):
//   rows      withdrawals of the app with status PAID_API / PAID_MANUAL whose paid_at falls in the
//             natural quarter (+08:00, [first month 1st 00:00, next quarter's first month 1st 00:00),
//             built from @couli/domain's chinaMonthRange; never the host time zone);
//   fields    withdrawal_id, user_id, income_type, amount_fen (the application amount, not net),
//             tax_fen, paid_at, masked_account (maskPayeeAccount(method, decrypt(cipher, method))),
//             out_biz_no, payout_channel. Never the payee name, an id number, the account in clear
//             or the HMAC (names and id numbers come from identity's port in the admin worker);
//   order     paid_at ASC, id ASC; cursor = base64url(paid_at ISO + ':' + id), its own decoder;
//             next_cursor null = done (a page shorter than limit is the last one; a full page
//             carries the cursor of its last row even when nothing follows);
//             limit default 500, at most 1000;
//   refusals  quarter not ^\d{4}-Q[1-4]$ with year 2026..2100 → TaxExportBadQuarter; a cursor that
//             is not one of ours → TaxExportBadCursor; a limit that is not an integer 1..1000 →
//             TaxExportBadLimit — all before the database is touched;
//   read only plain SELECTs on the caller's handle: no locking clause, no writes, no logging.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import { chinaMonthRange } from '@couli/domain';
import { sql, type Kysely } from 'kysely';
import { maskPayeeAccount } from '../domain/mask-payee.ts';
import type { DecryptWithdrawalAccount } from './withdrawal-reads.ts';

/** The income type of every withdrawal (BR-WDR-20, BR-FUND-13). */
export type TaxExportIncomeType = 'SERVICE_FEE';

/** The statuses a tax export lists (已到账). */
export type TaxExportPaidStatus = 'PAID_API' | 'PAID_MANUAL';

export interface TaxExportQuery {
  readonly appId: string;
  /** `YYYY-Qn`, year 2026..2100. */
  readonly quarter: string;
  readonly cursor?: string;
  /** Default 500, at most 1000. */
  readonly limit?: number;
}

export interface TaxExportRow {
  readonly withdrawal_id: string;
  readonly user_id: string;
  readonly income_type: string;
  /** 收入额: the withdrawal's amount_fen (not net_fen). */
  readonly amount_fen: bigint;
  /** 已扣税额. */
  readonly tax_fen: bigint;
  /** 到账时间. */
  readonly paid_at: Date;
  /** 收款账户（脱敏）: domain/mask-payee.ts of the row's own snapshot. */
  readonly masked_account: string;
  readonly out_biz_no: string;
  readonly payout_channel: string;
}

export interface TaxExportPage {
  readonly items: readonly TaxExportRow[];
  readonly next_cursor: string | null;
}

export type TaxExportRead = (handle: Kysely<DB>, query: TaxExportQuery) => Promise<TaxExportPage>;

export interface TaxExportReaderOptions {
  readonly decrypt: DecryptWithdrawalAccount;
}

/** The natural quarter as [start, end) strings `YYYY-MM-DDT00:00:00+08:00` (chinaMonthRange's). */
export interface TaxExportQuarterRange {
  readonly start: string;
  readonly end: string;
}

export const TAX_EXPORT_DEFAULT_LIMIT = 500;
export const TAX_EXPORT_MAX_LIMIT = 1000;
const PAID_STATUSES: readonly TaxExportPaidStatus[] = ['PAID_API', 'PAID_MANUAL'];
const QUARTER = /^(\d{4})-Q([1-4])$/;
const MIN_YEAR = 2026;
const MAX_YEAR = 2100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TaxExportBadQuarter extends Error {
  override readonly name = 'TaxExportBadQuarter';
  readonly quarter: string;
  constructor(quarter: string) {
    super(
      `tax export: bad quarter ${JSON.stringify(quarter)} (expected YYYY-Qn, ${MIN_YEAR}..${MAX_YEAR})`,
    );
    this.quarter = quarter;
  }
}

export class TaxExportBadCursor extends Error {
  override readonly name = 'TaxExportBadCursor';
  constructor() {
    super('tax export: bad cursor');
  }
}

export class TaxExportBadLimit extends Error {
  override readonly name = 'TaxExportBadLimit';
  readonly limit: number;
  constructor(limit: number) {
    super(`tax export: bad limit ${limit} (expected an integer 1..${TAX_EXPORT_MAX_LIMIT})`);
    this.limit = limit;
  }
}

/** The [start, end) of the natural quarter `YYYY-Qn` at +08:00; a bad quarter throws. */
export function taxExportQuarterRange(quarter: string): TaxExportQuarterRange {
  const match = typeof quarter === 'string' ? QUARTER.exec(quarter) : null;
  if (match === null) throw new TaxExportBadQuarter(quarter);
  const year = Number(match[1]);
  const index = Number(match[2]);
  if (year < MIN_YEAR || year > MAX_YEAR) throw new TaxExportBadQuarter(quarter);
  const firstMonth = (index - 1) * 3 + 1;
  const lastMonth = firstMonth + 2;
  const pad = (month: number): string => String(month).padStart(2, '0');
  return {
    start: chinaMonthRange(`${year}-${pad(firstMonth)}`).start,
    end: chinaMonthRange(`${year}-${pad(lastMonth)}`).end,
  };
}

interface CursorPosition {
  /** The row's paid_at as an ISO instant; compared in PostgreSQL as timestamptz. */
  readonly paidAt: string;
  readonly id: string;
}

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(`${position.paidAt}:${position.id}`, 'utf8').toString('base64url');
}

/** The position a cursor names, or null when it is not one of ours (malformed). */
function decodeCursor(cursor: string): CursorPosition | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const split = text.lastIndexOf(':');
  if (split <= 0) return null;
  const id = text.slice(split + 1);
  const paidAt = text.slice(0, split);
  if (!UUID.test(id) || !Number.isFinite(Date.parse(paidAt))) return null;
  return { paidAt, id };
}

function limitOf(limit: number | undefined): number {
  if (limit === undefined) return TAX_EXPORT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > TAX_EXPORT_MAX_LIMIT) {
    throw new TaxExportBadLimit(limit);
  }
  return limit;
}

function methodOf(value: string): 'alipay' | 'bank_card' | 'wechat' {
  if (value === 'alipay' || value === 'bank_card' || value === 'wechat') return value;
  throw new Error('payout: unknown payout method');
}

export function createTaxExportReader(options: TaxExportReaderOptions): TaxExportRead {
  const { decrypt } = options;
  return async (handle, query) => {
    // Every refusal is decided before the database is touched.
    const range = taxExportQuarterRange(query.quarter);
    const limit = limitOf(query.limit);
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === null) throw new TaxExportBadCursor();

    let select = handle
      .withSchema('app')
      .selectFrom('withdrawals')
      .select([
        'id',
        'user_id',
        'income_type',
        'amount_fen',
        'tax_fen',
        'paid_at',
        'payout_method',
        'payout_channel',
        'payee_account_cipher',
        'out_biz_no',
      ])
      .where('app_id', '=', query.appId)
      .where('status', 'in', [...PAID_STATUSES])
      .where('paid_at', '>=', sql<Date>`${range.start}::timestamptz`)
      .where('paid_at', '<', sql<Date>`${range.end}::timestamptz`);
    if (after !== null) {
      const { paidAt, id } = after;
      select = select.where((eb) =>
        eb.or([
          eb('paid_at', '>', sql<Date>`${paidAt}::timestamptz`),
          eb.and([eb('paid_at', '=', sql<Date>`${paidAt}::timestamptz`), eb('id', '>', id)]),
        ]),
      );
    }
    const rows = await select.orderBy('paid_at', 'asc').orderBy('id', 'asc').limit(limit).execute();

    const items: TaxExportRow[] = rows.map((row) => {
      if (row.paid_at === null) throw new Error('payout: a paid withdrawal without paid_at');
      const method = methodOf(row.payout_method);
      return {
        withdrawal_id: row.id,
        user_id: row.user_id,
        income_type: row.income_type,
        amount_fen: row.amount_fen,
        tax_fen: row.tax_fen,
        paid_at: row.paid_at,
        masked_account: maskPayeeAccount(
          method,
          decrypt(Buffer.from(row.payee_account_cipher), method),
        ),
        out_biz_no: row.out_biz_no,
        payout_channel: row.payout_channel,
      };
    });
    const last = items.at(-1);
    const nextCursor =
      items.length === limit && last !== undefined
        ? encodeCursor({ paidAt: last.paid_at.toISOString(), id: last.withdrawal_id })
        : null;
    return { items, next_cursor: nextCursor };
  };
}
