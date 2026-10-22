// Commission's read port for the withdrawal rules (task B2-05c; 08 BR-WDR-03 ⑬ 细则「入账前取当前预估」):
// one member's self-purchase share of one sub-order at the version the order carries
// (orders.commission_version), as the snapshot fixed it (commission_split_amounts, BR-CALC-02 /
// BR-CALC-10; the amount of the row, already floored by the split). No row → 0 (nothing estimated
// counts as nothing). On the caller's handle, one SELECT, no writes, no logging.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface SelfRebateEstimateReader {
  read(
    handle: Kysely<DB>,
    input: { appId: string; orderId: string; commissionVersion: number; userId: string },
  ): Promise<bigint>;
}

export function createSelfRebateEstimateReader(): SelfRebateEstimateReader {
  return {
    async read(handle, input) {
      const row = await handle
        .withSchema('app')
        .selectFrom('commission_split_amounts')
        .select('amount_fen')
        .where('app_id', '=', input.appId)
        .where('order_id', '=', input.orderId)
        .where('commission_version', '=', input.commissionVersion)
        .where('user_id', '=', input.userId)
        .where('role', '=', 'self')
        .executeTakeFirst();
      return row === undefined ? 0n : row.amount_fen;
    },
  };
}
