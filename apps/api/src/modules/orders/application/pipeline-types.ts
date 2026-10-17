import type { DB } from '@couli/db';
import type { OrderPlatformState } from '@couli/domain';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionOrder } from '../../union/index.ts';
import type { BindingRow } from '../domain/attribution.ts';
import type { StatusMap } from '../domain/status-map.ts';
import type { OrderPipelineContext } from './pipeline-port.ts';
import type { SyncLogger } from './sync-ports.ts';

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
  readonly kind: 'inserted' | 'dropped' | 'pending' | 'unchanged' | 'stale' | 'app_conflict';
  readonly order_id?: string;
  readonly reason?: string;
}

export interface OrderPipelineDeps {
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
