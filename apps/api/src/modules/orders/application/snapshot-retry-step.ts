// B1-08t：一次快照补偿重试的执行，流水线（update-step.ts）与定时扫描（jobs/snapshot-retry.ts）共用。
// 调用方已在同一事务里取子订单锁、读到该单 open 的快照类待处理行（非空、未转人工）并确认订单满足 ⑥ 资格。
// - skip（入参不可恢复：拼多多服务费、platform_modified 时刻、淘宝推广位场景）→ warn snapshot_retry_skipped，不调端口。
// - 计划 pending / 端口 pending → 照 B1-08k 写待处理（同键只刷新 detected_at，原因变了插新行）。
// - 端口 created / existing → 同一事务把该单全部 open 快照类行置为系统处置；快照与处置一起提交或回滚。
// - 失败（skip / pending）且最早一条 open 快照类行 created_at 满 24 小时 → 同事务记转人工标记，返回告警字段；
//   调用方在同一事务里经 alert-events.publishSnapshotRetryExhausted 入队 order.snapshot_retry_exhausted（B1-08u），
//   提交后再经 logSnapshotRetryExhausted 打一次 error。端口抛错不在这里处理（不吞，整事务回滚）。
// 日志只打平铺字段（platform、app_id、reason、outcome），不打子订单号、用户与买家参数。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { isSnapshotRetryExhausted, type SnapshotRetryPlan } from '../domain/snapshot-retry.ts';
import {
  markSnapshotHandoff,
  resolveSnapshotRows,
  type SnapshotPendingRow,
  type SubOrderRef,
} from '../infra/snapshot-retry-store.ts';
import {
  runCommissionSnapshot,
  type CommissionSnapshotPort,
  type SnapshotStepContext,
} from './commission-snapshot-step.ts';
import type { SyncLogger } from './sync-ports.ts';

/** 24 小时仍失败的告警事件名（规划/02 §11 点号形式）。 */
export const SNAPSHOT_RETRY_EXHAUSTED = 'order.snapshot_retry_exhausted';

/** 告警字段（不含子订单号与用户）：日志原样平铺；事件载荷取其中 order_id、pending_id、platform、reason。 */
export interface SnapshotRetryAlert {
  readonly alert: 'P1';
  readonly event: typeof SNAPSHOT_RETRY_EXHAUSTED;
  readonly app_id: string;
  readonly order_id: string;
  readonly platform: string;
  readonly pending_id: string;
  readonly reason: string;
  readonly outcome: 'manual';
}

export interface SnapshotRetryResult {
  /** created / existing = 已生成并处置；pending = 仍未生成（含 skip）。 */
  readonly outcome: 'created' | 'existing' | 'pending';
  readonly alert: SnapshotRetryAlert | null;
}

export function snapshotRetryAlert(
  ref: SubOrderRef,
  orderId: string,
  earliest: SnapshotPendingRow,
): SnapshotRetryAlert {
  return {
    alert: 'P1',
    event: SNAPSHOT_RETRY_EXHAUSTED,
    app_id: ref.app_id,
    order_id: orderId,
    platform: ref.platform,
    pending_id: earliest.id.toString(),
    reason: earliest.reason,
    outcome: 'manual',
  };
}

/**
 * 与 order.snapshot_retry_exhausted 事件（alert-events.publishSnapshotRetryExhausted，与转人工标记同事务入队）
 * 并存作运维冗余（B1-08u，D10-105）：字段不变，事务提交后打一条 error；未注入事件总线时它是唯一的告警。
 */
export function logSnapshotRetryExhausted(
  log: SyncLogger | undefined,
  alert: SnapshotRetryAlert,
): void {
  log?.error(
    { ...alert },
    'commission snapshot still missing after 24 hours; handed to manual handling',
  );
}

export async function runSnapshotRetry(
  trx: Transaction<DB>,
  port: CommissionSnapshotPort,
  plan: SnapshotRetryPlan,
  ctx: SnapshotStepContext,
  rows: readonly SnapshotPendingRow[],
  log: SyncLogger | undefined,
): Promise<SnapshotRetryResult> {
  const ref: SubOrderRef = {
    app_id: ctx.app_id,
    platform: ctx.platform,
    sub_order_id: ctx.sub_order_id,
  };
  let outcome: 'created' | 'existing' | 'pending';
  if (plan.kind === 'skip') {
    log?.warn(
      {
        event: 'snapshot_retry_skipped',
        platform: ctx.platform,
        app_id: ctx.app_id,
        reason: plan.reason,
        outcome: 'skipped',
      },
      'commission snapshot retry skipped; inputs cannot be recovered',
    );
    outcome = 'pending';
  } else {
    const result = await runCommissionSnapshot(trx, port, plan, ctx, log);
    outcome = result === 'none' ? 'pending' : result;
  }
  if (outcome !== 'pending') {
    await resolveSnapshotRows(trx, ref, outcome, ctx.now);
    log?.info(
      { platform: ctx.platform, app_id: ctx.app_id, outcome: `snapshot_retry_${outcome}` },
      'commission snapshot retried; sync pending resolved',
    );
    return { outcome, alert: null };
  }
  const earliest = rows[0];
  if (earliest === undefined || !isSnapshotRetryExhausted(earliest.created_at, ctx.now)) {
    return { outcome, alert: null };
  }
  await markSnapshotHandoff(trx, ref);
  return { outcome, alert: snapshotRetryAlert(ref, ctx.order_id, earliest) };
}
