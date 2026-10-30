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
import type { DB } from '@couli/db';
import { transitionOrderRebate } from '@couli/domain';
import type { Transaction } from 'kysely';
import type {
  AdminHoldInput,
  AdminHoldResult,
  RebateAdminCommandPort,
} from '../../orders/index.ts';
import type { Clock, RootLogger } from '../../platform/index.ts';
import { isHoldable } from '../rebate/domain/rules.ts';
import { casHold, insertAdminRebateHistory } from './rights-store.ts';

export interface RebateAdminDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
}

type Mode = 'HOLD' | 'UNHOLD';

export function createRebateAdminCommandPort(
  deps: RebateAdminDependencies,
): RebateAdminCommandPort {
  const { logger } = deps;

  async function run(
    trx: Transaction<DB>,
    input: AdminHoldInput,
    mode: Mode,
  ): Promise<AdminHoldResult> {
    const order = input.before;
    const base = {
      app_id: order.app_id,
      platform: order.platform,
      rebate_status: order.rebate_status,
      event: mode,
    };
    if (!isHoldable(order.rebate_status)) {
      logger.info({ ...base, outcome: 'not_applicable' }, 'admin hold outside R11 start states');
      return { kind: 'not_applicable' };
    }
    if (order.row_version !== input.expected_row_version) {
      logger.info({ ...base, outcome: 'cas_conflict' }, 'admin hold row_version mismatch');
      return { kind: 'cas_conflict' };
    }
    const toHold = mode === 'HOLD';
    if (order.hold === toHold) {
      logger.info({ ...base, outcome: 'same_state' }, 'admin hold already in that state');
      return { kind: 'same_state' };
    }
    // R11 through the generated transition(): rebate_status unchanged.
    const step = transitionOrderRebate(order.rebate_status, mode);
    if (!step.ok || step.to !== order.rebate_status) {
      logger.warn(
        { ...base, alert: 'rebate_illegal_transition', outcome: 'rejected' },
        'admin hold outside the transition table',
      );
      return { kind: 'not_applicable' };
    }
    const written = await casHold(
      trx,
      order,
      { hold: toHold, hold_reason: toHold ? input.reason_code : null },
      input.now,
    );
    if (!written) {
      // The caller holds the order lock and re-read the row FOR UPDATE: a miss is a stale row.
      logger.warn({ ...base, outcome: 'cas_conflict' }, 'admin hold CAS matched no row');
      return { kind: 'cas_conflict' };
    }
    await insertAdminRebateHistory(trx, order, mode, input.now);
    logger.info({ ...base, outcome: 'applied' }, 'admin hold applied');
    return { kind: 'applied' };
  }

  return Object.freeze({
    adminHold: (trx: Transaction<DB>, input: AdminHoldInput) => run(trx, input, 'HOLD'),
    adminUnhold: (trx: Transaction<DB>, input: AdminHoldInput) => run(trx, input, 'UNHOLD'),
  });
}
