// Commission's read port for the withdrawal risk-flag snapshot (task B2-11a; 08 BR-WDR-29 ⑥ 分母):
// the member's rebate shares as beneficiary in the roles self, share and direct (indirect is not
// one of ⑥'s three), from the split snapshot (commission_split_amounts, BR-CALC-02 / BR-CALC-10;
// amounts already floored by the split). On the caller's handle, plain SELECTs, no writes, no
// logging.
// - orderIds: every sub-order with a split row of the member in those roles (any version).
// - estimate: the member's share of one sub-order at the given version (the order's current
//   commission_version), summed over those roles; no row → 0.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { parseFen } from '@couli/money';
import type { Kysely } from 'kysely';

/** ⑥'s beneficiary roles (自购、分享、直推). */
export const WITHDRAW_RISK_SHARE_ROLES = ['self', 'share', 'direct'] as const;

export interface BeneficiaryShareReader {
  orderIds(
    handle: Kysely<DB>,
    input: { appId: string; userId: string },
  ): Promise<readonly string[]>;
  estimate(
    handle: Kysely<DB>,
    input: { appId: string; orderId: string; commissionVersion: number; userId: string },
  ): Promise<bigint>;
}

export function createBeneficiaryShareReader(): BeneficiaryShareReader {
  return {
    async orderIds(handle, input) {
      const rows = await handle
        .withSchema('app')
        .selectFrom('commission_split_amounts')
        .select('order_id')
        .distinct()
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('role', 'in', [...WITHDRAW_RISK_SHARE_ROLES])
        .orderBy('order_id')
        .execute();
      return rows.map((row) => row.order_id);
    },
    async estimate(handle, input) {
      const row = await handle
        .withSchema('app')
        .selectFrom('commission_split_amounts')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount_fen'), eb.val('0')).as('total'))
        .where('app_id', '=', input.appId)
        .where('order_id', '=', input.orderId)
        .where('commission_version', '=', input.commissionVersion)
        .where('user_id', '=', input.userId)
        .where('role', 'in', [...WITHDRAW_RISK_SHARE_ROLES])
        .executeTakeFirstOrThrow();
      return parseFen(row.total);
    },
  };
}
