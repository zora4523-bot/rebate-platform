// The withdrawal records section of a personal information copy (规划/08 BR-ID-40 细则「导出范围（默认）」
// 「提现记录（收款账号脱敏）」, BR-ID-33 收款账号; task B1-27f), for identity's PersonalDataCopySources
// (assembled by app.module).
// createPersonalDataCopyWithdrawalsReader({ decrypt })(handle, subject) — every withdrawal of the
// user in the app, as the rows below. The payee account is the row's own snapshot, decrypted in
// memory with options.decrypt (the same port as the withdrawal reads, DecryptWithdrawalAccount)
// and masked with ../domain/mask-payee.ts before it leaves; the account and the payee name in
// clear, and the console staff on the row (reviewer, executor, manual entry / confirmation), are
// never returned. Plain SELECTs on the caller's handle (a READ ONLY transaction included): no
// locking clause, no writes, no logging. Does not change any existing read.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { DecryptWithdrawalAccount } from './withdrawal-reads.ts';

export interface PersonalDataCopyWithdrawalSubject {
  readonly appId: string;
  readonly userId: string;
}

export interface PersonalDataCopyWithdrawalRow {
  readonly withdrawal_id: string;
  readonly status: string;
  readonly amount_fen: bigint;
  readonly fee_fen: bigint;
  readonly tax_fen: bigint;
  readonly net_fen: bigint;
  readonly payout_channel: string;
  readonly masked_account: string;
  readonly created_at: Date;
  readonly paid_at: Date | null;
}

export type PersonalDataCopyWithdrawalsRead = (
  handle: Kysely<DB>,
  subject: PersonalDataCopyWithdrawalSubject,
) => Promise<readonly PersonalDataCopyWithdrawalRow[]>;

export interface PersonalDataCopyWithdrawalsOptions {
  readonly decrypt: DecryptWithdrawalAccount;
}

export function createPersonalDataCopyWithdrawalsReader(
  options: PersonalDataCopyWithdrawalsOptions,
): PersonalDataCopyWithdrawalsRead {
  void options;
  throw new Error('NotImplemented: createPersonalDataCopyWithdrawalsReader');
}
