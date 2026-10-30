// B2-04la: settlement's attribution ports R3 / R3b (BR-FUND-01 rebate_status table), implementing
// orders' ClaimReviewDeps['rebate'].onClaimApproved (找回审核通过) and
// AdminAssignRebatePort.onAdminAssigned (后台指派). Skeleton only; the implementation is a later round.
//
// Contract the rule tests (test/spec/settlement/attribution) hold the implementation to:
//   - runs on the caller's transaction only; never opens, commits or rolls back one;
//   - lock order as B2-04m: the order_key advisory lock (orders' lockOrderKey, re-entrant) before any
//     read or write of the order row; no users rows, no balances, no ledger (R3 has no entries);
//   - `before` is orders' SELECT … FOR UPDATE row before it writes the attribution; the decision is
//     made on it first, then one CAS (rebate_status AND row_version, row_version + 1);
//   - R3 (UNATTRIBUTED, CLAIM_APPROVED / ADMIN_REASSIGN, guard locked = false): rebate_status ESTIMATED,
//     or WAITING when platform_status is RECEIVED / SETTLED and R4's guard holds (settle_period from
//     received_at, received_synced_at = input.now); locked = true;
//   - R3b (VOID, ADMIN_REASSIGN only, guard user_id empty and locked = false): rebate_status unchanged,
//     locked = true;
//   - anything else (incl. CLAIM_APPROVED on VOID and the closed R14) throws IllegalTransition, writes
//     nothing and logs a warn line with an alert;
//   - user_id, user_basis and the rebate history row stay with orders (it writes them after the port);
//   - time only from input.now (no injected clock, no SQL clock).
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';
import type { SnapshotOutcome } from '../../orders/index.ts';
import type { RootLogger } from '../../platform/index.ts';

/** Same shape as orders' ClaimApprovedInput and AdminAssignedInput. */
export interface AttributionInput {
  /** orders' SELECT … FOR UPDATE row, read before it writes the attribution. */
  readonly before: Selectable<DB['orders']>;
  /** The user the order is attributed to (orders writes user_id itself). */
  readonly userId: string;
  readonly now: Date;
  /** R3's snapshot outcome; none for R3b. */
  readonly snapshot: SnapshotOutcome;
}

/** Implements both orders ports: ClaimReviewDeps['rebate'] and AdminAssignRebatePort. */
export interface AttributionRebatePort {
  /** R3 with CLAIM_APPROVED (UNATTRIBUTED only; VOID is not accepted, 决-07 A). */
  onClaimApproved(trx: Transaction<DB>, input: AttributionInput): Promise<void>;
  /** R3 (UNATTRIBUTED) or R3b (VOID, status unchanged) with ADMIN_REASSIGN. */
  onAdminAssigned(trx: Transaction<DB>, input: AttributionInput): Promise<void>;
}

export interface AttributionRebateDependencies {
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  /** settle.period_basis.<platform> for R4's guard (same key as the rebate port). */
  readonly config: {
    get(appId: string, key: string): Promise<unknown>;
  };
}

export function createAttributionRebatePort(
  deps: AttributionRebateDependencies,
): AttributionRebatePort {
  void deps;
  throw new Error('NotImplemented: createAttributionRebatePort');
}
