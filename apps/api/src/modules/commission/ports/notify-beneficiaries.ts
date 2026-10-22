// B1-12j: read-only port for trade notifications (BR-FUND-03, BR-TEXT-09). It returns the
// persisted amount rows of the order's current commission version exactly as stored: no
// recomputation, no filtering of zero shares (the notifier picks share > 0), no fallback to
// another version. The current version is the one recorded on the order row (orchestrator
// decision B1-12j §B.1), read in the same SELECT; nothing is written and no lock is taken, so it
// also runs inside READ ONLY transactions.
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
  const rows = await db
    .withSchema('app')
    .selectFrom('commission_split_amounts as a')
    .innerJoin('orders as o', (join) =>
      join
        .onRef('o.app_id', '=', 'a.app_id')
        .onRef('o.order_id', '=', 'a.order_id')
        .onRef('o.commission_version', '=', 'a.commission_version'),
    )
    .select(['a.user_id', 'a.role', 'a.amount_fen'])
    .where('a.app_id', '=', input.app_id)
    .where('a.order_id', '=', input.order_id)
    .where('o.app_id', '=', input.app_id)
    .where('o.order_id', '=', input.order_id)
    .orderBy('a.role')
    .orderBy('a.user_id')
    .execute();
  return rows.map((row) => ({ user_id: row.user_id, role: row.role, amount_fen: row.amount_fen }));
}
