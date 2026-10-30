// B2-04l: settlement's R11 admin hold / unhold — orders' RebateAdminCommandPort (B1-09c; called by
// B1-09l's POST /admin/v1/orders/{order_id}/hold and /unhold). Rule tests:
// test/spec/settlement/rights/admin-hold.int.test.ts.
//
// adminHold / adminUnhold(trx, input): on the caller's transaction; the caller already holds
// lockOrderKey and re-read `before` FOR UPDATE. Judged on the order as stored, in this order:
//   - rebate_status outside {ESTIMATED, WAITING} (R11 start states; BR-FUND-06: never after
//     CREDITED; a hold kept on a VOID order cannot be lifted, D10-157) → not_applicable;
//   - row_version ≠ input.expected_row_version → cas_conflict;
//   - hold already true (adminHold) / already false (adminUnhold) → same_state;
//   - otherwise R11 through the generated transition() (HOLD / UNHOLD): hold = true and
//     hold_reason = input.reason_code, or hold = false and hold_reason = null; rebate_status
//     unchanged; CAS on (rebate_status, row_version), row_version + 1, updated_at = input.now
//     → applied. No voucher (R11 books nothing).
// Refusals write nothing. The order_hold / order_unhold audit is written by orders after an applied
// answer; settlement writes none. Whether an UNMAPPED_STATUS hold may be lifted (its BR-FUND-02
// pending record closed, D10-155) is judged by orders before the call.
import type { RebateAdminCommandPort } from '../../orders/index.ts';
import type { Clock, RootLogger } from '../../platform/index.ts';

export interface RebateAdminDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
}

export function createRebateAdminCommandPort(
  deps: RebateAdminDependencies,
): RebateAdminCommandPort {
  void deps;
  throw new Error('NotImplemented: createRebateAdminCommandPort');
}
