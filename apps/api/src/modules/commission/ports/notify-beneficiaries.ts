import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';

export interface ReadNotifyBeneficiariesInput {
  app_id: string;
  order_id: string;
}

export type NotifyBeneficiary = Pick<
  Selectable<DB['commission_split_amounts']>,
  'user_id' | 'role' | 'amount_fen'
>;

/** B1-12j：只读订单当前版本的金额快照，保留零份额，按 role、user_id 排序。 */
export async function readNotifyBeneficiaries(
  db: Kysely<DB>,
  input: ReadNotifyBeneficiariesInput,
): Promise<NotifyBeneficiary[]> {
  void db;
  void input;
  throw new Error('NotImplemented: readNotifyBeneficiaries');
}
