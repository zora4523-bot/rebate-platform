import type { DB } from '@couli/db';
import type { OrderPlatformState } from '@couli/domain';
import type { Kysely } from 'kysely';
import type { Clock, EventBus, JobQueue, ReceivedJob } from '../../platform/index.ts';
import { publishSnapshotRetryExhausted } from '../application/alert-events.ts';
import type { CommissionSnapshotPort } from '../application/commission-snapshot-step.ts';
import {
  logSnapshotRetryExhausted,
  runSnapshotRetry,
  snapshotRetryAlert,
  type SnapshotRetryAlert,
} from '../application/snapshot-retry-step.ts';
import { ORDER_SYNC_QUEUE, type OrderSyncScheduler } from '../application/sync-scheduler.ts';
import type { SyncLogger } from '../application/sync-ports.ts';
import { isSnapshotEligible } from '../domain/commission-snapshot.ts';
import {
  SNAPSHOT_RETRY_BATCH,
  isSnapshotRetryDue,
  isSnapshotRetryExhausted,
} from '../domain/snapshot-retry.ts';
import { lockOrderKey } from '../infra/order-lock.ts';
import { readSnapshotRetryInput } from '../infra/snapshot-retry-input.ts';
import {
  isHandedOff,
  markSnapshotHandoff,
  readOpenSnapshotRows,
  readOrderByKey,
  selectDueSubOrders,
  writePaidAtSource,
  type SubOrderRef,
} from '../infra/snapshot-retry-store.ts';

/** order-sync 队列里补偿扫描任务的名字（窗口任务是 'window'）。 */
export const SNAPSHOT_RETRY_JOB = 'snapshot-retry';

/** B1-08t：定时补偿的一轮；只扫描 payload.app_id，按订单串行并在锁内重读待处理行。
 * created_at 是未处置时长的起点，detected_at 刷新不延后升级。
 * 超过 24 小时仍失败：转人工（记标记），后续自动补偿跳过；B1-08u 起注入 events 时与标记同一事务入队
 * order.snapshot_retry_exhausted，提交后另打一条同名 error 日志作冗余（未注入 events 时只打日志）。
 * 每个子订单单独一个事务、第一句取与流水线同一把订单锁；单张失败（端口抛错、入队抛错）只回滚该单，记 error 后继续。
 */
export interface SnapshotRetryDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly snapshots: CommissionSnapshotPort;
  readonly logger: SyncLogger;
  /** B1-08u：耗尽告警事件的总线（worker 传 runtime 的 EVENT_BUS）；未注入 → 不入队，只打告警日志。 */
  readonly events?: Pick<EventBus, 'publish'>;
}

type OneOutcome = 'created' | 'existing' | 'pending' | 'skipped' | 'failed';

function payloadAppId(job: ReceivedJob): string {
  const appId = (job.payload as { app_id?: unknown }).app_id;
  if (typeof appId !== 'string' || appId === '') {
    throw new Error('SNAPSHOT_RETRY_PAYLOAD_INVALID: payload.app_id 缺失');
  }
  return appId;
}

export async function handleSnapshotRetry(
  job: ReceivedJob,
  deps: SnapshotRetryDeps,
): Promise<void> {
  const appId = payloadAppId(job);
  const refs = await selectDueSubOrders(deps.db, appId, deps.clock.now(), SNAPSHOT_RETRY_BATCH);
  const counts: Record<OneOutcome, number> = {
    created: 0,
    existing: 0,
    pending: 0,
    skipped: 0,
    failed: 0,
  };
  for (const ref of refs) counts[await retryOne(deps, ref)]++;
  deps.logger.info(
    { event: 'snapshot_retry_scan', app_id: appId, candidates: refs.length, ...counts },
    'commission snapshot retry scan finished',
  );
}

interface Attempted {
  readonly outcome: OneOutcome;
  readonly alert: SnapshotRetryAlert | null;
}

async function retryOne(deps: SnapshotRetryDeps, ref: SubOrderRef): Promise<OneOutcome> {
  const { db, clock, snapshots, logger } = deps;
  let exhaustedAt: { readonly orderId: string; readonly createdAt: Date } | null = null;
  // 已走到转人工并入队：此后的失败（入队抛错、提交失败）不是快照端口失败，不另起标记事务，整单回滚留待下轮。
  let handedOff = false;
  try {
    const result = await db.transaction().execute(async (trx): Promise<Attempted> => {
      await lockOrderKey(trx, ref.platform, ref.sub_order_id);
      const now = clock.now();
      const rows = await readOpenSnapshotRows(trx, ref);
      if (rows.length === 0 || isHandedOff(rows)) return { outcome: 'skipped', alert: null };
      const latest = rows.reduce((a, b) => (b.detected_at > a.detected_at ? b : a)).detected_at;
      if (!isSnapshotRetryDue(latest, now)) return { outcome: 'skipped', alert: null };
      const order = await readOrderByKey(trx, ref);
      if (
        order === undefined ||
        !isSnapshotEligible({
          user_id: order.user_id,
          platform_status: order.platform_status as OrderPlatformState,
          rebate_status: order.rebate_status,
        })
      ) {
        // 待编排裁定 4：不满足资格的 open 行不重试、不处置、不计入告警，留后台人工处置。
        return { outcome: 'skipped', alert: null };
      }
      exhaustedAt = { orderId: order.order_id, createdAt: rows[0]!.created_at };
      const plan = await readSnapshotRetryInput(trx, order, clock);
      if (plan.kind === 'call' && order.paid_at_source === null) {
        await writePaidAtSource(trx, order, plan.input.paidAtSource, now);
      }
      const retried = await runSnapshotRetry(
        trx,
        snapshots,
        plan,
        {
          app_id: ref.app_id,
          platform: ref.platform,
          sub_order_id: ref.sub_order_id,
          order_id: order.order_id,
          raw_status: null,
          raw_payload_id: order.raw_payload_id,
          now,
        },
        rows,
        logger,
      );
      if (retried.alert !== null) {
        handedOff = true;
        await publishSnapshotRetryExhausted(deps.events, trx, retried.alert);
      }
      return retried;
    });
    if (result.alert !== null) logSnapshotRetryExhausted(logger, result.alert);
    return result.outcome;
  } catch (error) {
    logger.error(
      {
        event: 'snapshot_retry_failed',
        platform: ref.platform,
        app_id: ref.app_id,
        error_name: error instanceof Error ? error.name : 'unknown',
        outcome: 'rolled_back',
      },
      'commission snapshot retry failed; order rolled back and kept pending',
    );
    const seen = exhaustedAt as { readonly orderId: string; readonly createdAt: Date } | null;
    const published = handedOff as boolean;
    if (!published && seen !== null && isSnapshotRetryExhausted(seen.createdAt, clock.now())) {
      await handoffAfterError(deps, ref, seen.orderId);
    }
    return 'failed';
  }
}

/**
 * 满 24 小时后端口抛错：快照事务已回滚，另起事务（同一把锁、锁内重读）只记转人工标记，并在同一事务入队
 * order.snapshot_retry_exhausted（B1-08u）；入队抛错则标记一并回滚、记 error，下轮再试。提交后打一次告警日志。
 */
async function handoffAfterError(
  deps: SnapshotRetryDeps,
  ref: SubOrderRef,
  orderId: string,
): Promise<void> {
  try {
    const alert = await deps.db.transaction().execute(async (trx) => {
      await lockOrderKey(trx, ref.platform, ref.sub_order_id);
      const rows = await readOpenSnapshotRows(trx, ref);
      const earliest = rows[0];
      if (earliest === undefined || isHandedOff(rows)) return null;
      if (!isSnapshotRetryExhausted(earliest.created_at, deps.clock.now())) return null;
      await markSnapshotHandoff(trx, ref);
      const handoff = snapshotRetryAlert(ref, orderId, earliest);
      await publishSnapshotRetryExhausted(deps.events, trx, handoff);
      return handoff;
    });
    if (alert !== null) logSnapshotRetryExhausted(deps.logger, alert);
  } catch (error) {
    deps.logger.error(
      {
        event: 'snapshot_retry_handoff_failed',
        platform: ref.platform,
        app_id: ref.app_id,
        error_name: error instanceof Error ? error.name : 'unknown',
        outcome: 'error',
      },
      'commission snapshot retry hand-off failed',
    );
  }
}

/** 定时器仅投递扫描任务，读写订单留给队列处理器；扫描间隔由装配方传入。 */
export interface SnapshotRetrySchedulerDeps {
  readonly queue: JobQueue;
  readonly listAppIds: () => Promise<readonly string[]>;
  readonly intervalMs: number;
  readonly logger: SyncLogger;
}

/**
 * 每 intervalMs 一轮：列出 App、逐个经 JobQueue 投递 order-sync / snapshot-retry（不随业务事务）。某轮失败只记
 * error，下一轮照常；start() 只起定时器，stop() 清定时器并等在途一轮结束。
 */
export function createSnapshotRetryScheduler(deps: SnapshotRetrySchedulerDeps): OrderSyncScheduler {
  return {
    start() {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let inflight: Promise<void> | undefined;
      const round = async (): Promise<void> => {
        try {
          const appIds = await deps.listAppIds();
          for (const appId of appIds) {
            if (stopped) return;
            await deps.queue.send(
              ORDER_SYNC_QUEUE,
              SNAPSHOT_RETRY_JOB,
              { app_id: appId },
              { trx: null, singletonKey: `snapshot-retry:${appId}` },
            );
          }
        } catch (error) {
          deps.logger.error(
            {
              event: 'snapshot_retry_dispatch_failed',
              error_name: error instanceof Error ? error.name : 'unknown',
              outcome: 'error',
            },
            'commission snapshot retry dispatch failed; next round continues',
          );
        }
      };
      const arm = (): void => {
        timer = setTimeout(() => {
          timer = undefined;
          inflight = round().finally(() => {
            inflight = undefined;
            if (!stopped) arm();
          });
        }, deps.intervalMs);
      };
      arm();
      return {
        async stop() {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          await inflight;
        },
      };
    },
  };
}
