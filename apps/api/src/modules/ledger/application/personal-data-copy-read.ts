// The balance ledger section of a personal information copy (规划/08 BR-ID-40 细则「导出范围（默认）」
// 「余额流水」; task B1-27f), for identity's PersonalDataCopySources (assembled by app.module).
// readPersonalDataCopyLedgerEntries(handle, subject) — the entries of the user's own balance
// account (ledger_accounts owner_type user, owner_id = the user, USER_BALANCE) in the app, both
// sub-accounts, as the rows below; never the platform's counter-entries of the same voucher nor
// another user's entries. Plain SELECTs on the caller's handle (a READ ONLY transaction
// included): no locking clause (no lockBalances), no writes, no logging. Does not change any
// existing read or posting.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface PersonalDataCopyLedgerSubject {
  readonly appId: string;
  readonly userId: string;
}

export interface PersonalDataCopyLedgerRow {
  readonly ledger_type: string;
  readonly sub_type: string | null;
  readonly sub_account: 'available' | 'frozen';
  readonly amount_fen: bigint;
  readonly balance_after_fen: bigint | null;
  readonly booked_at: Date;
}

export function readPersonalDataCopyLedgerEntries(
  handle: Kysely<DB>,
  subject: PersonalDataCopyLedgerSubject,
): Promise<readonly PersonalDataCopyLedgerRow[]> {
  void handle;
  void subject;
  throw new Error('NotImplemented: readPersonalDataCopyLedgerEntries');
}
