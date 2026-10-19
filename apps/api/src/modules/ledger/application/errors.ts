/** Why the ledger refused a call. Every refusal leaves the caller's transaction usable. */
export type LedgerErrorCode =
  /** Malformed input (ids, keys, enum-like strings) before any SQL runs. */
  | 'INVALID_INPUT'
  /** No original voucher exists in the requested app. */
  | 'ORIGINAL_NOT_FOUND'
  /** A key ending in :REVERSE cannot itself be reversed. */
  | 'CANNOT_REVERSE_REVERSAL'
  /** validateVoucher refused the entries (BR-FUND-16: >=2 entries, nonzero, sum zero). */
  | 'INVALID_VOUCHER'
  /** A user account id that is not a USER_BALANCE account of this app_id. */
  | 'UNKNOWN_ACCOUNT'
  /** A user account whose balance row this transaction did not lock through lockBalances. */
  | 'NOT_LOCKED'
  /** applyEntries refused the result (negative frozen, int64 overflow). */
  | 'INVALID_BALANCE'
  /** mayGoNegative refused the resulting available balance (BR-FUND-10). */
  | 'NEGATIVE_BALANCE'
  /** The balance cache changed under a held lock: a caller or concurrency bug. */
  | 'BALANCE_CONFLICT'
  /**
   * The daily check (BR-FUND-19) did not complete: a snapshot or invariant statement failed
   * (the PostgreSQL error is the `cause`, SQLSTATE in cause.code) or an invariant file broke
   * the output contract. Never a zero-difference result.
   */
  | 'DAILY_CHECK_FAILED';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(`ledger: ${message}`, options);
    this.name = 'LedgerError';
    this.code = code;
  }
}
