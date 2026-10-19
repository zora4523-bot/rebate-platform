import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Clock, JobQueue, ReceivedJob } from '../../platform/index.ts';
import type { PlanCommissionSnapshotInput } from '../domain/commission-snapshot.ts';
import type { CommissionSnapshotPort } from '../application/commission-snapshot-step.ts';
import type { OrderSyncScheduler } from '../application/sync-scheduler.ts';
import type { SyncLogger } from '../application/sync-ports.ts';

/** B1-08t：定时补偿的一轮；只扫描 payload.app_id，按订单串行并在锁内重读待处理行。
 * created_at 是未处置时长的起点，detected_at 刷新不延后升级。
 * 超过 24 小时仍失败：保留 open，resolution_note 写 snapshot_retry_manual，
 * 经现有日志端口告警 event=order.snapshot_retry_exhausted；后续自动补偿跳过该行。
 */
export interface SnapshotRetryDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly snapshots: CommissionSnapshotPort;
  readonly logger: SyncLogger;
  /** 从持久化订单及归档资料恢复快照输入；不得用当前时间替换付款时刻。 */
  readonly readInput: (
    trx: Transaction<DB>,
    order: Selectable<DB['orders']>,
  ) => Promise<PlanCommissionSnapshotInput>;
}

export async function handleSnapshotRetry(
  job: ReceivedJob,
  deps: SnapshotRetryDeps,
): Promise<void> {
  void job;
  void deps;
  throw new Error('NotImplemented: handleSnapshotRetry');
}

/** 定时器仅投递扫描任务，读写订单留给队列处理器；扫描间隔由装配方传入。 */
export interface SnapshotRetrySchedulerDeps {
  readonly queue: JobQueue;
  readonly listAppIds: () => Promise<readonly string[]>;
  readonly intervalMs: number;
  readonly logger: SyncLogger;
}

export function createSnapshotRetryScheduler(deps: SnapshotRetrySchedulerDeps): OrderSyncScheduler {
  void deps;
  throw new Error('NotImplemented: createSnapshotRetryScheduler');
}
