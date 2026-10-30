// B2-04l: settlement's rights command — orders' RightsCommandPort.record (B1-09c), the only writer
// of order_rights and orders.rights_pending (BR-FUND-01). Rule tests: test/spec/settlement/rights/**.
//
// record(trx, input): on the caller's transaction (never opens, commits or rolls one back); the
// caller already holds orders' lockOrderKey for the sub-order and re-read `before` FOR UPDATE. In
// order (decide before writing, BR-FUND-01):
//   1. platform_status of the order outside {PAID, RECEIVED, SETTLED} (the from-states of P7 / P8)
//      → { kind: 'not_applicable' }, nothing written.
//   2. K-2 key (app_id, order_id, type, platform_rights_no), NULLS NOT DISTINCT:
//      - no stored row → insert one (source, type, status, amount_fen, deduction_commission_fen,
//        occurred_at, platform_rights_no as given; created_at = updated_at = input.now) → applied;
//      - a stored PROCESSING row and an incoming SUCCEEDED / FAILED, or a stored WAIT_COMMISSION
//        row and an incoming SUCCEEDED that carries deduction_commission_fen → the result of that
//        same record (BR-FUND-06「维权结果」): the row is updated in place (same id; status,
//        amounts, row_version + 1, updated_at = input.now) → applied;
//      - anything else on a stored key (a replay, a closed SUCCEEDED / FAILED row) → duplicate,
//        nothing written, never a second clawback.
//      待编排确认: the orchestrator note reads「同键 → duplicate」; the in-place result above is
//      what BR-FUND-06 needs for platforms that report PROCESSING first (taobao).
//   3. by the row's status after step 2:
//      - PROCESSING: nothing more (BR-FUND-06: blocks crediting through rights_pending only);
//      - FAILED: record closed, amounts unchanged;
//      - SUCCEEDED, rebate_status UNATTRIBUTED / ESTIMATED / WAITING (BR-FUND-07, R6 / R7 through
//        the generated transition()): PUNISH → R6 PUNISH (VOID, reason PUNISH);
//        INVALID_AFTER_SETTLE / REFUND_AFTER_SETTLE → R6 PLATFORM_INVALID (VOID, reason REFUND);
//        RIGHTS: N_new = effective union commission (BR-CALC-02: settle_commission_fen, else
//        est_commission_fen) − deduction_commission_fen; positive part 0 → R6 RIGHTS_FULL (VOID,
//        reason RIGHTS); otherwise R7 RIGHTS_PARTIAL (status unchanged; R7 is not from
//        UNATTRIBUTED); no deduction → the row becomes WAIT_COMMISSION, status unchanged
//        (BR-FUND-06 例「部分成功、佣金未更新」). VOID publishes order.invalidated on the same
//        transaction; never a voucher;
//      - SUCCEEDED, rebate_status CREDITED: the clawback's rights success entry (BR-FUND-08, same
//        rules as B2-04s): cause by type (RIGHTS → RIGHTS, PUNISH → PUNISH, INVALID_AFTER_SETTLE,
//        REFUND_AFTER_SETTLE), rights_event_id `R{order_rights.id}`, N_new ② = booked_n_fen −
//        deduction_commission_fen (below 0 → 0); no deduction → ③ WAIT_COMMISSION (row
//        WAIT_COMMISSION, order_sync_pending CLAWBACK_NO_COMMISSION, alert). Lock order as B2-04m /
//        B2-04s: order_key advisory lock → identity users rows → ledger.lockBalances;
//      - SUCCEEDED, rebate_status VOID / CLAWED_BACK: recorded only (terminal; BR-FUND-01 细则
//        「订单锁定」: order_rights are still recorded); status, booked pair and ledger unchanged.
//   4. orders.rights_pending recomputed in the same transaction (some row of the order PROCESSING
//      or WAIT_COMMISSION) and written with a CAS (row_version + 1, updated_at = input.now) only
//      when it changes.
// BR-FUND-06 is 待验证 (which platforms send a「处理中」signal): no platform signal is invented
// here; a platform without one only reaches record with the result.
// Time only from input.now / the injected Clock; amounts only through @couli/money.
import type { RightsCommandPort } from '../../orders/index.ts';
import type { Clock, EventBus, RootLogger } from '../../platform/index.ts';
import type { ClawbackOrder } from '../clawback/index.ts';
import type { RebatePort } from '../rebate/application/rebate.ts';

export interface RightsCommandDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly events: Pick<EventBus, 'publish'>;
  /** B2-04s clawback orchestration; its rights success entry handles CREDITED orders. */
  readonly clawback: ClawbackOrder;
  /** B2-04j rebate port: R6 / R7 commands before credit (apply). */
  readonly rebate: Pick<RebatePort, 'apply'>;
}

export function createRightsCommandPort(deps: RightsCommandDependencies): RightsCommandPort {
  void deps;
  throw new Error('NotImplemented: createRightsCommandPort');
}
