// Orders' read port for the withdrawal rules (task B2-05c; 08 BR-WDR-03 ⑬ 细则「近 90 天自购门槛」):
// the member's self-purchase sub-orders (buy_type=self, user_id = the member) whose confirmation
// of receipt (received_at) lies in [now − 90 × 24 h, now] and whose current states are
// platform_status ∈ {RECEIVED, SETTLED} and rebate_status ∈ {WAITING, CREDITED} (BR-FUND-01; VOID
// and CLAWED_BACK never count, a partial refund that left WAITING / CREDITED still counts). On the
// caller's handle (a transaction included), one SELECT, no row locks, no writes, no logging. The
// caller sums the member's rebate share (ledger nets once credited, the commission snapshot before).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** 90 × 24 hours (BR-WDR-03 ⑬ 细则), not calendar days. */
export const SELF_PURCHASE_WINDOW_MS = 90 * 86_400_000;
const PLATFORM_STATUSES: readonly string[] = ['RECEIVED', 'SETTLED'];
const REBATE_STATUSES: readonly string[] = ['WAITING', 'CREDITED'];

export interface SelfPurchaseOrder {
  readonly order_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly rebate_status: string;
  readonly commission_version: number;
}

export interface SelfPurchaseOrderReader {
  read(
    handle: Kysely<DB>,
    input: { appId: string; userId: string; now: Date },
  ): Promise<readonly SelfPurchaseOrder[]>;
}

export function createSelfPurchaseOrderReader(): SelfPurchaseOrderReader {
  return {
    async read(handle, input) {
      const to = input.now;
      const from = structuredClone(to);
      from.setTime(to.getTime() - SELF_PURCHASE_WINDOW_MS);
      return handle
        .withSchema('app')
        .selectFrom('orders')
        .select(['order_id', 'platform', 'sub_order_id', 'rebate_status', 'commission_version'])
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('buy_type', '=', 'self')
        .where('received_at', '>=', from)
        .where('received_at', '<=', to)
        .where('platform_status', 'in', [...PLATFORM_STATUSES])
        .where('rebate_status', 'in', [...REBATE_STATUSES])
        .orderBy('received_at')
        .orderBy('order_id')
        .execute();
    },
  };
}
