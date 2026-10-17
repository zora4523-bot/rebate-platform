import type { DB } from '@couli/db';
import type { OrderPlatformState } from '@couli/domain';
import type { Selectable } from 'kysely';
import type { UnionOrder } from '../../union/index.ts';
import type { ImportHistory } from './import-state.ts';
import type { StatusMap } from './status-map.ts';

export interface UpdateStateInput {
  readonly platform_status: OrderPlatformState;
  readonly rebate_status: string;
  readonly received_at: Date | null;
}

export interface OrderUpdatePlan {
  readonly kind: 'pending' | 'update';
  readonly platform_status: OrderPlatformState;
  readonly received_at: Date | null;
  readonly history: readonly ImportHistory[];
  readonly pending: 'ILLEGAL_TRANSITION' | 'UNMAPPED_STATUS' | 'NO_RECEIVED_AT' | null;
  readonly rule: string | null;
}

export function planOrderUpdate(
  current: UpdateStateInput,
  incoming: UnionOrder,
  map: StatusMap,
  regressionHold: boolean,
): OrderUpdatePlan {
  void current;
  void incoming;
  void map;
  void regressionHold;
  throw new Error('NotImplemented: planOrderUpdate');
}

export type OrderSyncColumns = Pick<
  Selectable<DB['orders']>,
  | 'pay_amount_fen'
  | 'est_commission_fen'
  | 'commission_version'
  | 'settle_commission_fen'
  | 'received_at'
  | 'platform_received_at'
  | 'deposit_paid_at'
  | 'paid_at'
  | 'settled_at'
  | 'platform_modified_at'
  | 'parent_order_id'
  | 'raw_item_id'
  | 'content_hash'
  | 'raw_payload_id'
>;

/** Returns resolved values of sync-owned data columns; CAS/status/attribution are applied separately. */
export function planOrderSyncColumns(
  current: OrderSyncColumns,
  incoming: UnionOrder,
  plan: OrderUpdatePlan,
): OrderSyncColumns {
  void current;
  void incoming;
  void plan;
  throw new Error('NotImplemented: planOrderSyncColumns');
}
