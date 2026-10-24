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
import { maskPayeeAccount } from '../domain/mask-payee.ts';
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

function methodOf(value: string): 'alipay' | 'bank_card' | 'wechat' {
  // withdrawals_payout_method_check; anything else is a broken database.
  if (value === 'alipay' || value === 'bank_card' || value === 'wechat') return value;
  throw new Error('payout: unknown payout method');
}

export function createPersonalDataCopyWithdrawalsReader(
  options: PersonalDataCopyWithdrawalsOptions,
): PersonalDataCopyWithdrawalsRead {
  const { decrypt } = options;
  return async (handle, subject) => {
    // Only snapshot fields the copy carries; payee_name, the HMAC and the console staff columns
    // (reviewer, executor, manual entry / confirmation, resolvers) are never selected.
    const rows = await handle
      .withSchema('app')
      .selectFrom('withdrawals')
      .select([
        'id',
        'status',
        'amount_fen',
        'fee_fen',
        'tax_fen',
        'net_fen',
        'payout_method',
        'payout_channel',
        'payee_account_cipher',
        'created_at',
        'paid_at',
      ])
      .where('app_id', '=', subject.appId)
      .where('user_id', '=', subject.userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map((row) => {
      const method = methodOf(row.payout_method);
      return {
        withdrawal_id: row.id,
        status: row.status,
        amount_fen: row.amount_fen,
        fee_fen: row.fee_fen,
        tax_fen: row.tax_fen,
        net_fen: row.net_fen,
        payout_channel: row.payout_channel,
        // The cleartext lives only long enough to be masked (BR-ID-33 收款账号).
        masked_account: maskPayeeAccount(
          method,
          decrypt(Buffer.from(row.payee_account_cipher), method),
        ),
        created_at: row.created_at,
        paid_at: row.paid_at,
      };
    });
  };
}
