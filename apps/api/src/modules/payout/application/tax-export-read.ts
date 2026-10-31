// B2-08d (规划/08 BR-WDR-21 涉税导出与报送; 编排裁定 D10-456 ④): the read-only port the admin export
// worker calls for the quarterly tax detail of paid withdrawals. Skeleton only (test stage): every
// function throws NotImplemented; the implementation stage fills it in.
//
// createTaxExportReader({ decrypt })(handle, { appId, quarter, cursor?, limit? }):
//   rows      withdrawals of the app with status PAID_API / PAID_MANUAL whose paid_at falls in the
//             natural quarter (+08:00, [first month 1st 00:00, next quarter's first month 1st 00:00),
//             built from @couli/domain's chinaMonthRange; never the host time zone);
//   fields    withdrawal_id, user_id, income_type, amount_fen (the application amount, not net),
//             tax_fen, paid_at, masked_account (maskPayeeAccount(method, decrypt(cipher, method))),
//             out_biz_no, payout_channel. Never the payee name, an id number, the account in clear
//             or the HMAC (names and id numbers come from identity's port in the admin worker);
//   order     paid_at ASC, id ASC; cursor = base64url(paid_at ISO + id), its own decoder;
//             next_cursor null = done; limit default 500, at most 1000;
//   refusals  quarter not ^\d{4}-Q[1-4]$ with year 2026..2100 → TaxExportBadQuarter; a cursor that
//             is not one of ours → TaxExportBadCursor; a limit that is not an integer 1..1000 →
//             TaxExportBadLimit;
//   read only plain SELECTs on the caller's handle: no locking clause, no writes, no logging.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
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

/** A quarter that is not `YYYY-Qn` with year 2026..2100. */
export class TaxExportBadQuarter extends Error {
  constructor(quarter: string) {
    super('tax export: bad quarter');
    void quarter;
    throw new Error('NotImplemented: TaxExportBadQuarter');
  }
}

/** A cursor that is not one this port issued (malformed). */
export class TaxExportBadCursor extends Error {
  constructor(cursor: string) {
    super('tax export: bad cursor');
    void cursor;
    throw new Error('NotImplemented: TaxExportBadCursor');
  }
}

/** A limit that is not an integer 1..1000. */
export class TaxExportBadLimit extends Error {
  constructor(limit: number) {
    super('tax export: bad limit');
    void limit;
    throw new Error('NotImplemented: TaxExportBadLimit');
  }
}

/** The quarter's [start, end) at +08:00; a bad quarter → TaxExportBadQuarter. */
export function taxExportQuarterRange(quarter: string): TaxExportQuarterRange {
  void quarter;
  throw new Error('NotImplemented: taxExportQuarterRange');
}

export function createTaxExportReader(options: TaxExportReaderOptions): TaxExportRead {
  void options;
  throw new Error('NotImplemented: createTaxExportReader');
}
