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
  throw new Error('NotImplemented: createWithdrawSubjectReader');
}
