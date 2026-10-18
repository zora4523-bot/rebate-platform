/** Domain account reference; persistence resolves this to an account_id within app_id. */
export interface VoucherAccount {
  readonly owner_type: 'user' | 'platform';
  readonly owner_id: string;
  /** Includes the platform suffix where the CSV has UNION_RECEIVABLE:{platform}. */
  readonly subject: string;
}

export interface BuiltVoucherEntry {
  readonly account: VoucherAccount;
  readonly sub_account: 'available' | 'frozen' | null;
  readonly amount_fen: bigint;
  readonly ledger_type: string;
  readonly sub_type: string | null;
}

export interface BuiltVoucher {
  readonly uniq_key: string;
  readonly entries: readonly BuiltVoucherEntry[];
}

/**
 * Flat CSV placeholder names and amount_ref names. User rows additionally require
 * user_id, even when the key (e.g. withdrawal_id) does not contain it. No aliases.
 * Amounts are nonnegative bigint fen within PG int64; key components are strings.
 */
export type BuildVoucherParams = Readonly<Record<string, string | bigint>>;

/**
 * Uses templates.gen.ts, generated ONLY from specs/ledger-templates.csv by the
 * adjacent generate-templates.ts build tool. No CSV reads or I/O at runtime.
 *
 * Reject unknown IDs, any TBD cell in the entire template, missing/extra parameters,
 * malformed key components and invalid amounts with RangeError. Never infer TBDs.
 * Reuse orderKey/uniqKey for their supported key formats. Empty CSV sub_type is null.
 * Omit zero pairs; when no entries remain return []. Every emitted voucher must
 * pass validateVoucher (after mapping symbolic accounts to LedgerEntry references).
 * Do not mutate params; use @couli/money for all amount arithmetic.
 *
 * Currently only WITHDRAW:FREEZE and WITHDRAW:RETURN are executable. In particular,
 * WITHDRAW:SUCCESS:* cannot be emitted until its TBDs and voucher key are resolved.
 */
export function buildVouchers(
  templateId: string,
  params: BuildVoucherParams,
): readonly BuiltVoucher[] {
  void templateId;
  void params;
  throw new Error('NotImplemented: buildVouchers');
}
