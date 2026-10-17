/** Pure domain projections, not database row definitions. No I/O or clock access. */
export type LedgerRole = 'self' | 'share' | 'direct' | 'indirect';

export type UniqKeyInput =
  | { kind: 'CREDIT'; order_key: string; user_id: string; role: LedgerRole }
  | { kind: 'PLATFORM_CREDIT'; order_key: string }
  | {
      kind: 'PLATFORM_FORFEIT';
      order_key: string;
      user_id: string;
      role: LedgerRole;
      reassign_id?: string;
    }
  | {
      kind: 'CLAWBACK';
      order_key: string;
      user_id: string;
      role: LedgerRole;
      rights_event_id: string;
    }
  | { kind: 'PLATFORM_CLAWBACK'; order_key: string; rights_event_id: string }
  | { kind: 'REVERSE'; original_uniq_key: string };

/**
 * BR-FUND-05: preserve the two components exactly, joined by ':'.
 * Each must be a nonempty string without ':'. Invalid input throws RangeError.
 * This is a namespace builder, not a platform registry or an ID-number parser.
 */
export function orderKey(platform: string, subOrderId: string): string {
  void platform;
  void subOrderId;
  throw new Error('NotImplemented: orderKey');
}

/**
 * Only the formats in B2-01h §9. Scalar components are nonempty colon-free strings;
 * order_key must contain exactly two such components; role uses LedgerRole.
 * REVERSE accepts any nonempty original key (including ADJ keys from other callers),
 * but refuses an original ending in ':REVERSE'. Invalid input throws RangeError.
 */
export function uniqKey(input: UniqKeyInput): string {
  void input;
  throw new Error('NotImplemented: uniqKey');
}

export interface LedgerEntry {
  readonly account_id: string;
  /** Nonempty subject code. USER_BALANCE requires available/frozen; others use null. */
  readonly account_code: string;
  readonly sub_account: 'available' | 'frozen' | null;
  /** BR-FUND-16: debit positive, credit negative; nonzero bigint fen. */
  readonly amount_fen: bigint;
}

export type VoucherValidationCode =
  'ENTRY_COUNT' | 'INVALID_AMOUNT' | 'INVALID_ACCOUNT' | 'INVALID_SUB_ACCOUNT' | 'UNBALANCED';

export interface VoucherValidationError {
  readonly code: VoucherValidationCode;
  /** Zero-based entry position; null for voucher-level errors. */
  readonly entry_index: number | null;
}

export type VoucherValidationResult =
  { ok: true } | { ok: false; errors: readonly VoucherValidationError[] };

/**
 * Returns errors rather than throwing for invalid vouchers, including runtime input.
 * Requires >=2 entries, complete account/sub-account fields, nonzero bigint amounts,
 * and sum zero. Report each malformed entry, without coercing amounts or mutating input.
 * Only calculate UNBALANCED when all amounts are valid. Arithmetic uses @couli/money.
 */
export function validateVoucher(entries: readonly LedgerEntry[]): VoucherValidationResult {
  void entries;
  throw new Error('NotImplemented: validateVoucher');
}

export interface LedgerBalance {
  readonly account_id: string;
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
}

/**
 * BR-FUND-16: returns a fresh balance, subtracting this USER_BALANCE account's signed
 * entries separately from available/frozen (via @couli/money addFen/subFen).
 * Other accounts/platform subjects do not affect this cache. Accepts entry slices,
 * including an empty slice, so it does not require a whole balanced voucher.
 * Reject invalid matching entries, malformed balance, or negative final frozen with
 * RangeError. Final frozen is checked after the whole slice, not after each entry.
 * available may be negative here: the writer must separately call mayGoNegative.
 * Caller scopes all inputs to one app_id and handles locks, uniqueness and persistence.
 */
export function applyEntries(
  balance: LedgerBalance,
  entries: readonly LedgerEntry[],
): LedgerBalance {
  void balance;
  void entries;
  throw new Error('NotImplemented: applyEntries');
}

export interface NegativeBalanceInput {
  /** Contract ledger_type/sub_type values; strings allow unknown types to fail closed. */
  readonly ledger_type: string;
  readonly sub_type: string | null;
  readonly uniq_key: string;
  readonly resulting_available_fen: bigint;
  /** New available minus old available: necessary to distinguish negative adjustments. */
  readonly available_delta_fen: bigint;
  /** Trusted R14 context, NOT a ledger_type/sub_type or a new uniq_key format. */
  readonly reversal_kind?: 'REASSIGN_REV';
}

/**
 * True means this write's resulting available is permitted by BR-FUND-10.
 * Nonnegative results are permitted. Negative results only for CLAWBACK,
 * negative SETTLE_ADJUST/ADMIN_ADJUST, or R14 reversals of the three credit types.
 * Ordinary ':REVERSE' takes priority over type-based exceptions and is refused when
 * the result is negative. R14 uses trusted reversal_kind, never a substring match;
 * its actual key format belongs to B2-01i. Malformed amounts fail closed (false).
 */
export function mayGoNegative(input: NegativeBalanceInput): boolean {
  void input;
  throw new Error('NotImplemented: mayGoNegative');
}
