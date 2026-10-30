// B2-04l：扣回编排（settlement）用的 CLAWBACK_NO_COMMISSION 待处理行端口（order_sync_pending，写者 orders）。
// settlement 只经本端口开 / 关这类行，不直接写表（单一写者）。读写都在调用方已取子订单锁的事务里；
// 只改 status / resolved_* / resolution_note，不删行。口径同 snapshot-retry-store 与 pipeline-store 的 upsert。
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

type Trx = Transaction<DB>;

export const CLAWBACK_NO_COMMISSION_REASON = 'CLAWBACK_NO_COMMISSION';

/** 系统关闭（resolved_by 为空）时写入的处置说明。 */
export const CLAWBACK_PENDING_RESOLUTION_NOTE =
  'clawback written after the union commission arrived';

/** 开一条 CLAWBACK_NO_COMMISSION 行（入参同 settlement ClawbackPendingInput）。 */
export interface ClawbackPendingOpenInput {
  readonly appId: string;
  readonly orderId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly reason: 'CLAWBACK_NO_COMMISSION';
  readonly detail: string | null;
}

/** 关闭该子订单 open 的 CLAWBACK_NO_COMMISSION 行；at 取调用方注入的 Clock。 */
export interface ClawbackPendingResolveInput {
  readonly appId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly at: Date;
}

export interface ClawbackPendingPort {
  open(trx: Trx, input: ClawbackPendingOpenInput): Promise<void>;
  resolve(trx: Trx, input: ClawbackPendingResolveInput): Promise<void>;
}

/**
 * 开行：同子订单同原因已有 open 行时只刷新 detected_at（同 pipeline-store 的 upsert）；新行 created_at = detected_at
 * = Clock now。
 */
export async function openClawbackNoCommissionPending(
  trx: Trx,
  input: ClawbackPendingOpenInput,
  now: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('order_sync_pending')
    .values({
      app_id: input.appId,
      platform: input.platform,
      sub_order_id: input.subOrderId,
      order_id: input.orderId,
      reason: CLAWBACK_NO_COMMISSION_REASON,
      raw_status: null,
      raw_payload_id: null,
      detail: input.detail,
      detected_at: now,
      status: 'open',
      created_at: now,
    })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'platform', 'sub_order_id', 'reason'])
        .where('status', '=', sql.lit('open'))
        .doUpdateSet((eb) => ({ detected_at: eb.ref('excluded.detected_at') })),
    )
    .execute();
}

/** 关行：该子订单全部 open 的 CLAWBACK_NO_COMMISSION 行置为系统处置（resolved_by 为空）。 */
export async function resolveClawbackNoCommissionPending(
  trx: Trx,
  input: ClawbackPendingResolveInput,
): Promise<void> {
  await trx
    .withSchema('app')
    .updateTable('order_sync_pending')
    .set({
      status: 'resolved',
      resolved_at: input.at,
      resolved_by: null,
      resolution_note: CLAWBACK_PENDING_RESOLUTION_NOTE,
    })
    .where('app_id', '=', input.appId)
    .where('platform', '=', input.platform)
    .where('sub_order_id', '=', input.subOrderId)
    .where('reason', '=', CLAWBACK_NO_COMMISSION_REASON)
    .where('status', '=', 'open')
    .execute();
}

/** 装配用：注入 settlement ClawbackDependencies.pending。 */
export function createClawbackPendingPort(deps: { readonly clock: Clock }): ClawbackPendingPort {
  return {
    open: (trx, input) => openClawbackNoCommissionPending(trx, input, deps.clock.now()),
    resolve: (trx, input) => resolveClawbackNoCommissionPending(trx, input),
  };
}
