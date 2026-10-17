import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { EventBus } from '../../platform/index.ts';
import type { OrderPipelineDeps } from './pipeline-types.ts';

export interface OrderUpdateChange {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly from_status: string;
  readonly to_status: string;
  readonly rule: string | null;
  readonly received_at: Date | null;
  readonly est_before: bigint | null;
  readonly est_after: bigint | null;
  readonly settle_commission_fen: bigint | null;
  readonly attributed_now: boolean;
}

export interface UnmappedOrderInfo {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly rebate_status: string;
}

export interface OrderUpdateDeps extends Pick<
  OrderPipelineDeps,
  'clock' | 'users' | 'bindings' | 'statusMaps' | 'logger'
> {
  readonly rebate: {
    onUpdated(trx: Transaction<DB>, change: OrderUpdateChange): Promise<void>;
    onUnmappedStatus(trx: Transaction<DB>, info: UnmappedOrderInfo): Promise<void>;
  };
  readonly events: Pick<EventBus, 'publish'>;
  readonly regressionHold?: (platform: Parameters<OrderPipelineDeps['statusMaps']>[0]) => boolean;
}

// TODO(规划/11 §4.5): 告警事件入队 — blocked on platform 事件名登记
// TODO(规划/11 §4.5): 来源回填与分佣快照 — blocked on B1-08j、B1-08k
export function createOrderUpdateStep(
  deps: OrderUpdateDeps,
): NonNullable<OrderPipelineDeps['updateStep']> {
  void deps;
  throw new Error('NotImplemented: createOrderUpdateStep');
}
