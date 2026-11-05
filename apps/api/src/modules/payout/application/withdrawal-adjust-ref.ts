// B2-12c skeleton (rule-test phase, implementation pending): payout's read port for the linked
// withdrawals of a manual adjustment (08 BR-FUND-24 ②③⑥, BR-WDR-33 ⑨): each withdrawal of the app
// named by the form, with its member and the cash subject of its payout channel (alipay →
// CASH_ALIPAY, wechat → CASH_WECHAT, bank_card → CASH_BANK). Read on the caller's executor; IDs not
// of the app are omitted. No writes, no logging of payee data.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

export type WithdrawalCashSubject = 'CASH_ALIPAY' | 'CASH_WECHAT' | 'CASH_BANK';

export interface WithdrawalAdjustRef {
  readonly withdrawalId: string;
  readonly userId: string;
  readonly cashSubject: WithdrawalCashSubject;
}

export function readWithdrawalAdjustRefs(
  executor: Kysely<DB> | Transaction<DB>,
  input: { readonly appId: string; readonly withdrawalIds: readonly string[] },
): Promise<ReadonlyMap<string, WithdrawalAdjustRef>> {
  void executor;
  void input;
  throw new Error('NotImplemented: readWithdrawalAdjustRefs');
}
