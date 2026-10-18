import type { DB } from '@couli/db';
import type { OrderPlatformState } from '@couli/domain';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Clock, EventBus } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionOrder } from '../../union/index.ts';
import type { BindingRow } from '../domain/attribution.ts';
import type { StatusMap } from '../domain/status-map.ts';
import type { OrderSyncWindow, SyncLogger } from './sync-ports.ts';

export interface OrderPipelineContext extends OrderSyncWindow {
  readonly requestId: string;
}

export interface PidRow {
  readonly pid_scene: string;
  readonly status: string;
  readonly site_id: string | null;
}

export interface ImportedOrder {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly attributed: boolean;
  readonly platform_status: OrderPlatformState;
  readonly received_at: Date | null;
}

export interface OrderPipelineResult {
  readonly kind:
    'inserted' | 'updated' | 'dropped' | 'pending' | 'unchanged' | 'stale' | 'app_conflict';
  readonly order_id?: string;
  readonly reason?: string;
}

export interface OrderPipelineDeps {
  readonly events?: Pick<EventBus, 'publish'>;
  /**
   * 告警事件总线（B1-08i，02 §11：order.illegal_transition、order.attr_binding_conflict、
   * order.attr_param_changed）。注入时与业务写同一事务入队；装配在 B1-08n（与 events 同一个 EventBus）。
   * 未注入时只记告警日志。与 events 分开注入：events 的调用次数由冻结规则测试逐次断言。
   */
  readonly alertEvents?: Pick<EventBus, 'publish'>;
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly statusMaps: (platform: RegisteredPlatform) => StatusMap;
  readonly pids: {
    find(input: {
      appId: string;
      platform: RegisteredPlatform;
      unionAccountId: string;
      pid: string;
    }): Promise<readonly PidRow[]>;
  };
  readonly accounts: {
    syncStartAt(input: { appId: string; unionAccountId: string }): Promise<Date | null>;
  };
  readonly users: {
    findByAttrCode(input: { appId: string; attrCode: string }): Promise<string | null>;
  };
  readonly bindings: {
    findByRelation(input: {
      appId: string;
      unionAccountId: string;
      relationId: string;
    }): Promise<readonly BindingRow[]>;
  };
  readonly rebate: {
    onImported(trx: Transaction<DB>, order: ImportedOrder): Promise<void>;
  };
  readonly updateStep?: {
    apply(
      trx: Transaction<DB>,
      current: Selectable<DB['orders']>,
      incoming: UnionOrder,
      ctx: OrderPipelineContext,
    ): Promise<OrderPipelineResult>;
  };
  readonly mtimeOrdering?: (platform: RegisteredPlatform) => boolean;
  readonly logger?: SyncLogger;
}

/** Normal resolution includes accepted, dropped, rejected and pending orders. */
export interface OrderPipelinePort {
  process(order: UnionOrder, ctx: OrderPipelineContext): Promise<void | OrderPipelineResult>;
}

export interface OrderPipeline extends OrderPipelinePort {
  process(order: UnionOrder, ctx: OrderPipelineContext): Promise<OrderPipelineResult>;
}
