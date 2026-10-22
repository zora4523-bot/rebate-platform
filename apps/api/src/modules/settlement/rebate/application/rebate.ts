import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { OrderPipelineDeps, OrderUpdateDeps } from '../../../orders/index.ts';
import type { Clock, EventBus, RootLogger } from '../../../platform/index.ts';

export interface RebateOrderRef {
  readonly appId: string;
  readonly orderId: string;
  readonly attrAt: Date;
}

/** R6 / R7 commands shared with the later rights writer; no rights persistence here. */
export type PrecreditEvent =
  | 'PLATFORM_INVALID'
  | 'RIGHTS_FULL'
  | 'PUNISH'
  | 'BLACKLIST_HIT'
  | 'PARTIAL_REFUND'
  | 'RIGHTS_PARTIAL';

export interface RebateChangeInput extends RebateOrderRef {
  readonly estBefore: bigint | null;
  readonly estAfter: bigint | null;
  readonly settleCommissionFen: bigint | null;
}

export interface RebateHoldAudit extends RebateOrderRef {
  readonly actor: 'system:risk';
  readonly reason: 'UNMAPPED_STATUS';
  readonly before: { readonly hold: false; readonly holdReason: string | null };
  readonly after: { readonly hold: true; readonly holdReason: 'UNMAPPED_STATUS' };
  readonly at: Date;
}

/**
 * Caller owns the transaction and already holds orders.lockOrderKey(platform, sub_order_id).
 * Re-read by app_id/order_id/attr_at; decide before writing; transitionOrderRebate + CAS
 * (old rebate_status AND row_version), re-read after a zero-row CAS. Never open a transaction.
 * CREDITED updates only log. No ledger calls. Imports arrive with DB default UNATTRIBUTED.
 * R1/R2 history starts at null, not that storage default. R2/R3a may chain R4 or R6.
 */
export type RebatePort = OrderPipelineDeps['rebate'] &
  OrderUpdateDeps['rebate'] & {
    apply(trx: Transaction<DB>, order: RebateChangeInput, event: PrecreditEvent): Promise<void>;
  };

export interface RebateDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly events: Pick<EventBus, 'publish'>;
  readonly config: {
    get(appId: string, key: string): Promise<unknown>;
  };
  /**
   * Commission-owned valuation boundary. bases is read-only, uses frozen snapshot terms
   * and effective commission (settlement wins); null means unknown, never zero.
   * refresh recomputes estimates in the supplied transaction, without touching balances.
   * orders has already updated commission_version: refresh must not increment it again.
   * TODO(规划/11 §7.1): wire the commission estimate writer — blocked on missing public writer port.
   */
  readonly estimates: {
    bases(
      trx: Transaction<DB>,
      input: RebateChangeInput,
    ): Promise<{ readonly before: bigint | null; readonly after: bigint | null }>;
    refresh(trx: Transaction<DB>, input: RebateOrderRef): Promise<void>;
  };
  /**
   * System-actor audit must commit/roll back with hold. Existing AuditPort accepts admin UUIDs
   * and owns its own transaction, so it cannot silently stand in for this capability.
   * TODO(规划/11 §7.1): provide system audit adapter — blocked on transactional system:risk audit port.
   */
  readonly audit: {
    append(trx: Transaction<DB>, input: RebateHoldAudit): Promise<void>;
  };
}

export function createRebatePort(deps: RebateDependencies): RebatePort {
  void deps;
  throw new Error('NotImplemented: createRebatePort');
}
