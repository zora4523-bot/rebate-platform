// B2-09c: the console's read of withdrawals (contracts/openapi.yaml listAdminWithdrawals and
// getAdminWithdrawal, CT-24y). Skeleton of the test stage: the display status the console shows
// (enum admin_withdrawal_display_status), derived from status + review_mode + hold_reason as the
// BR-WDR-08 细则 table; not stored and not a withdrawal status.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { Schema } from '@couli/contracts-ts';

/** The admin_withdrawal_display_status of the contract. */
export type AdminWithdrawalDisplayStatus = Schema<'AdminWithdrawalDisplayStatus'>;

/** The withdrawal columns the display status is derived from (as stored). */
export interface AdminWithdrawalDisplayInput {
  readonly status: string;
  readonly review_mode: string | null;
  readonly hold_reason: string | null;
  readonly needs_manual: boolean;
}

/** The display status of one withdrawal row (BR-WDR-08 细则). */
export function adminWithdrawalDisplayStatus(
  row: AdminWithdrawalDisplayInput,
): AdminWithdrawalDisplayStatus {
  void row;
  throw new Error('NotImplemented: adminWithdrawalDisplayStatus');
}
