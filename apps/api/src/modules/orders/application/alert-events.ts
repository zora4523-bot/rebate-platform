// B1-08i（D10-47、D10-48、D10-57；规划/02 §11；BR-ATTR-01 ⑦、BR-ATTR-07、BR-FUND-01 P10）：订单同步的三个告警
// 事件 order.illegal_transition、order.attr_binding_conflict、order.attr_param_changed。与领域事件（order.created /
// order.updated）走同一个注入的 events 总线、与业务写同一事务入队；入队失败即抛错，整事务回滚（待处理记录与订单写
// 一并不留）。流水线未注入 events 时（B1-08h 的用法）只记告警日志。
// - 载荷只放 id、枚举与平台名，不放子订单号、用户 id、归因参数的值与原始状态码（原始码在待处理记录里，
//   按 pending_id 查）。
// - order.illegal_transition 总与一条 order_sync_pending 记录同事务写入；事件 ID 由（事件名、App、载荷）派生，
//   载荷含该 open 记录的 id：同一条 open 记录上重复判出同样的非法迁移（任务重投、重复拉取）只入队一次，
//   与待处理表「同键 open 只更新 detected_at」一致；内容不同或记录处置后再出现，得到新的事件 ID。
// - 另两个随订单写库发生（首次入库，或 content_hash 变化的更新），重复报文已被 content_hash 短路，
//   事件 ID 由总线生成。
// - B1-08u（D10-81、D10-105；02 §11）：快照补偿重试满 24 小时仍失败、转人工时入队 order.snapshot_retry_exhausted，
//   与转人工标记同一事务（流水线、定时扫描、端口抛错后的另起标记事务三处）。载荷恰为 order_id、pending_id（最早
//   一条 open 快照类行 id 的十进制串）、platform、reason；事件 ID 同样由（事件名、App、载荷）派生，重发只算重复。
//   未注入总线（扫描路径的旧用法）直接返回，只留 B1-08t 的 error 日志。
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { EventBus, JobPayload } from '../../platform/index.ts';
import type { SnapshotRetryAlert } from './snapshot-retry-step.ts';

/** 订单模块注入的事件总线（EventBus 子集）：领域事件与告警事件共用。 */
type OrderEvents = Pick<EventBus, 'publish'>;

/** 已归属订单上可能变化、但不覆盖的归因参数列（BR-ATTR-01）；只作 order.attr_param_changed 载荷里的列名，不带值。 */
export type OrderAttrParamColumn = 'pid' | 'relation_id' | 'sub_union_id' | 'custom_params';

export interface IllegalTransitionAlert {
  readonly appId: string;
  /** 首次入库即非法（没有订单行）时为 null。 */
  readonly orderId: string | null;
  /** 同事务写入的 order_sync_pending open 记录 id。 */
  readonly pendingId: bigint | null;
  readonly platform: string;
  /** 'P10'（倒退）或 'illegal'（迁移表外的事件）。 */
  readonly rule: string;
  /** 库内平台状态；首次入库为 null。 */
  readonly fromStatus: string | null;
  /** 本次报文映射到的内部事件。 */
  readonly event: string | null;
  /** rejected：整条报文不落 orders；status_kept：P10 开关关，状态不迁移、其余列照写。 */
  readonly outcome: 'rejected' | 'status_kept';
}

/** 事件名、App 与载荷的 sha256 前 16 字节，置 RFC 9562 v8 的版本与变体位，小写规范 UUID。 */
export function derivedEventId(name: string, appId: string, payload: JobPayload): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([name, appId, payload]))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 表外事件与 P10 倒退：与待处理记录同事务入队 order.illegal_transition（BR-ATTR-01、BR-FUND-01 P10）。 */
export async function publishIllegalTransition(
  bus: OrderEvents | undefined,
  trx: Transaction<DB>,
  alert: IllegalTransitionAlert,
): Promise<void> {
  if (bus === undefined) return;
  if (alert.pendingId === null) {
    throw new Error(
      'ORDER_PENDING_ID_MISSING: 待处理记录未返回 id，无法入队 order.illegal_transition',
    );
  }
  const name = 'order.illegal_transition';
  const payload: JobPayload = {
    order_id: alert.orderId,
    pending_id: alert.pendingId.toString(10),
    platform: alert.platform,
    reason: 'ILLEGAL_TRANSITION',
    rule: alert.rule,
    from_status: alert.fromStatus,
    event: alert.event,
    outcome: alert.outcome,
  };
  await bus.publish(trx, {
    appId: alert.appId,
    name,
    payload,
    eventId: derivedEventId(name, alert.appId, payload),
  });
}

/** BR-ATTR-07：多条绑定命中且用户不同，订单进未归因池，同事务入队 order.attr_binding_conflict。 */
export async function publishBindingConflict(
  bus: OrderEvents | undefined,
  trx: Transaction<DB>,
  alert: { readonly appId: string; readonly orderId: string; readonly platform: string },
): Promise<void> {
  await bus?.publish(trx, {
    appId: alert.appId,
    name: 'order.attr_binding_conflict',
    payload: { order_id: alert.orderId, platform: alert.platform },
  });
}

/** BR-ATTR-01：已归属订单的归因参数新值与库内不同（库内不覆盖），同事务入队 order.attr_param_changed。 */
export async function publishParamChanged(
  bus: OrderEvents | undefined,
  trx: Transaction<DB>,
  alert: {
    readonly appId: string;
    readonly orderId: string;
    readonly platform: string;
    readonly changed: readonly OrderAttrParamColumn[];
  },
): Promise<void> {
  await bus?.publish(trx, {
    appId: alert.appId,
    name: 'order.attr_param_changed',
    payload: { order_id: alert.orderId, platform: alert.platform, changed: [...alert.changed] },
  });
}

/**
 * B1-08u：快照补偿重试满 24 小时仍失败，与转人工标记同事务入队 order.snapshot_retry_exhausted。载荷只放订单 id、
 * 待处理行 id、平台名与原因枚举（不放子订单号、用户、归因参数、金额与原始状态码）；入队抛错不吞，由调用方回滚。
 */
export async function publishSnapshotRetryExhausted(
  bus: OrderEvents | undefined,
  trx: Transaction<DB>,
  alert: SnapshotRetryAlert,
): Promise<void> {
  if (bus === undefined) return;
  const name = alert.event;
  const payload: JobPayload = {
    order_id: alert.order_id,
    pending_id: alert.pending_id,
    platform: alert.platform,
    reason: alert.reason,
  };
  await bus.publish(trx, {
    appId: alert.app_id,
    name,
    payload,
    eventId: derivedEventId(name, alert.app_id, payload),
  });
}
