import type { DB } from '@couli/db';
import type { OrderPlatformState } from '@couli/domain';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Clock, EventBus } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionOrder } from '../../union/index.ts';
import type { BindingRow } from '../domain/attribution.ts';
import type { StatusMap } from '../domain/status-map.ts';
import type { CommissionSnapshotPort, SnapshotOutcome } from './commission-snapshot-step.ts';
import type { OrderSyncWindow, SyncLogger } from './sync-ports.ts';
import type { OrderSourcePorts } from './source-backfill.ts';

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
  /**
   * B1-08k 第 ⑥ 步本次的快照结果（R2 的预估由 settlement 据此与快照表决定）：created / existing = 已有快照；
   * pending = 跨入资格但进了待处理；none = 本次不生成。只在注入 snapshots 时出现；未注入时不带此字段
   * （与 B1-08h 的入参逐字段一致，D10-69；同 OrderUpdateChange.snapshot）。
   */
  readonly snapshot?: SnapshotOutcome;
}

export interface OrderPipelineResult {
  readonly kind:
    'inserted' | 'updated' | 'dropped' | 'pending' | 'unchanged' | 'stale' | 'app_conflict';
  readonly order_id?: string;
  readonly reason?: string;
}

export interface OrderPipelineDeps {
  readonly sources?: OrderSourcePorts;
  /**
   * 事件总线（B1-08i，02 §11）：领域事件 order.created 与告警事件 order.illegal_transition、
   * order.attr_binding_conflict 都经它、与本次写库同一事务入队，入队失败整事务回滚。
   * 未注入（B1-08h 的用法）时不发事件，告警只记日志；装配在 B1-08n。
   */
  readonly events?: Pick<EventBus, 'publish'>;
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
  /**
   * 分佣快照端口（B1-08k，BR-ATTR-01 ⑥ / BR-CALC-10）：首次入库即已归因且 PAID+ 时，在 history、待处理之后、
   * rebate.onImported 之前同事务调用；抛错整事务回滚。未注入时整步跳过（不调用、不写来源与待处理，
   * ImportedOrder 不带 snapshot 字段）。
   */
  readonly snapshots?: CommissionSnapshotPort;
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
