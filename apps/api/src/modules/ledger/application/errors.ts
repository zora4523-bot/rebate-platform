/** Why the ledger refused a call. Every refusal leaves the caller's transaction usable. */
export type LedgerErrorCode =
  /** Malformed input (ids, keys, enum-like strings) before any SQL runs. */
  | 'INVALID_INPUT'
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
  | 'BALANCE_CONFLICT';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(`ledger: ${message}`, options);
    this.name = 'LedgerError';
    this.code = code;
  }
}
