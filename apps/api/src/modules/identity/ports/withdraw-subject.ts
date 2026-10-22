// Identity's read port for the withdrawal rules (task B2-05c; BR-WDR-03 ⑤ ⑥, BR-WDR-04 payee
// counts, BR-WDR-07 ③ advisory lock key): the member's CURRENT payout account only (is_current),
// as payout_method, the stored (normalised) payee_name and the account HMAC that the withdrawal
// snapshot and the payee counts use (alipay_hmac for alipay, bank_card_hmac for a bank card). On the
// caller's handle (a transaction included, READ ONLY as well): one SELECT, no cipher is read, no
// writes, no logging. Nothing bound (or another app) → null.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** Identity-owned, current binding only; no writes and no second connection. */
export interface WithdrawSubject {
  payout_method: 'alipay' | 'bank_card' | 'wechat';
  payee_name: string;
  payee_hmac: string;
}

export interface WithdrawSubjectReader {
  read(
    handle: Kysely<DB>,
    subject: { appId: string; userId: string },
  ): Promise<WithdrawSubject | null>;
}

export function createWithdrawSubjectReader(): WithdrawSubjectReader {
  return {
    async read(handle, subject) {
      const row = await handle
        .withSchema('app')
        .selectFrom('payout_accounts')
        .select(['payout_method', 'payee_name', 'alipay_hmac', 'bank_card_hmac'])
        .where('app_id', '=', subject.appId)
        .where('user_id', '=', subject.userId)
        .where('is_current', '=', true)
        .executeTakeFirst();
      if (row === undefined) return null;
      const method = row.payout_method;
      if (method !== 'alipay' && method !== 'bank_card' && method !== 'wechat') {
        throw new Error('identity: unknown payout_method on the current payout account');
      }
      const hmac = method === 'alipay' ? row.alipay_hmac : row.bank_card_hmac;
      // payout_accounts_details_check guarantees the HMAC of the row's own method.
      if (hmac === null) throw new Error('identity: payout account row without its account HMAC');
      return { payout_method: method, payee_name: row.payee_name, payee_hmac: hmac };
    },
  };
}
