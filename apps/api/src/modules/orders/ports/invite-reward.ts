import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';

export type InviteRewardOrderFact = Pick<
  Selectable<DB['orders']>,
  | 'app_id'
  | 'order_id'
  | 'user_id'
  | 'buy_type'
  | 'base_fen'
  | 'pay_amount_fen'
  | 'attr_at'
  | 'credited_at'
  | 'rebate_status'
  | 'refunded_quantity'
  | 'refunded_quantity_at_credit'
  | 'rights_pending'
> & { has_rights: boolean };

export interface InviteRewardOrderFactsReader {
  read(
    trx: Transaction<DB>,
    input: { app_id: string; order_id: string },
  ): Promise<InviteRewardOrderFact | null>;
  listSelfOrdersInWindow(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; from: Date; to: Date },
  ): Promise<readonly InviteRewardOrderFact[]>;
}

/** Read orders and order_rights on the caller's transaction, with app and attr_at boundaries. */
export function createInviteRewardOrderFacts(): InviteRewardOrderFactsReader {
  throw new Error('NotImplemented: createInviteRewardOrderFacts');
}
