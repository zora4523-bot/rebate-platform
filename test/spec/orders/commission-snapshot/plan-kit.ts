import type { PlanCommissionSnapshotInput } from '../../../../apps/api/src/modules/orders/index.ts';
export { at, capture } from '../attribution/kit.ts';
import { at } from '../attribution/kit.ts';

export const DEPOSIT = at('2026-10-04T01:02:03Z');
export const PAID = at('2026-10-12T02:03:04Z');
export const MODIFIED = at('2026-10-13T03:04:05Z');
export const FIRST_PAID = at('2026-10-14T04:05:06Z');
export const NOW = at('2026-10-19T05:06:07Z');

export function input(
  patch: Partial<PlanCommissionSnapshotInput> = {},
): PlanCommissionSnapshotInput {
  return {
    before: null,
    after: { user_id: 'owner-A', platform_status: 'PAID', rebate_status_before: 'UNATTRIBUTED' },
    order: {
      app_id: 'app-A',
      order_id: 'order-A',
      platform: 'pdd',
      buy_type: 'share',
      activity_type: 'synthetic-activity',
      is_presale: false,
      paid_at: PAID,
      deposit_paid_at: null,
      est_commission_fen: 1001n,
      settle_commission_fen: null,
      subsidy_commission_fen: null,
    },
    incoming: { modified_at: MODIFIED, service_fee_fen: 31n },
    pidScene: 'share',
    movedToPaidNow: true,
    firstPaidAt: FIRST_PAID,
    now: NOW,
    ...patch,
  };
}
