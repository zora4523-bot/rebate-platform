// B1-08t：分佣快照补偿重试的纯判定（BR-ATTR-01 ⑥、BR-CALC-10 的实现方案；08 未写重试，编排裁定 D10-81 / D10-84）。
// 不做 I/O。信号只看「该子订单仍有 open 的快照类待处理行」，不看 commission_splits 是否存在；资格沿用
// isSnapshotEligible（本次 ⑦ 迁移与 ② 归属后的值，rebate_status 用库内值）。planCommissionSnapshot 与
// crossesSnapshotEligibility 的行为不变（「首次跨入」仍只由它们判定）。
// - 入参恢复：N = 结算收入 ?? 预估收入（两者都空 → AMOUNT_PARSE_FAILED，不按 0 兜底）；拼多多扣服务费，服务费
//   取不到（扫描路径无报文）→ skip service_fee_unknown；报文明确没给 → SERVICE_FEE_RATE_MISSING。
// - paidAt 按库内 paid_at_source：platform → paid_at；observed → 首条到 PAID+ 的历史时刻；platform_modified
//   （预售迁到 PAID 那条报文的平台更新时间）不可恢复 → skip paid_at_unknown；为空 → chooseSnapshotPaidAt
//   （movedToPaidNow=false），由调用方照 B1-08k 写入 paid_at_source。
// - 淘礼金场景：推广位场景取不到（扫描路径无 pids 端口）的淘宝单 → skip pid_scene_unknown，不替它选返利模式。
// 金额只经 @couli/money（整数分）。
import { subFen } from '@couli/money';
import {
  chooseSnapshotPaidAt,
  type CommissionSnapshotCallInput,
  type PaidAtSource,
  type SnapshotPendingReason,
} from './commission-snapshot.ts';

/** 快照类待处理原因（B1-08k 写入）；TLJ_FACE_VALUE_UNMATCHED 是快照已生成后另写的，不属于重试对象。 */
export const SNAPSHOT_RETRY_REASONS = [
  'RULE_VERSION_PLATFORM_MISSING',
  'AMOUNT_PARSE_FAILED',
  'SERVICE_FEE_RATE_MISSING',
] as const;
export type SnapshotRetryReason = (typeof SNAPSHOT_RETRY_REASONS)[number];

export function isSnapshotRetryReason(reason: string): reason is SnapshotRetryReason {
  return (SNAPSHOT_RETRY_REASONS as readonly string[]).includes(reason);
}

/** 待编排裁定 6（默认）：08 无值。扫描每 15 分钟一轮、每轮至多 100 个子订单，open 满 1 小时到期。 */
export const SNAPSHOT_RETRY_SCAN_INTERVAL_MS = 15 * 60_000;
export const SNAPSHOT_RETRY_BATCH = 100;
export const SNAPSHOT_RETRY_DUE_MS = 3_600_000;
/** 最早一条 open 快照类行的 created_at 满 24 小时后仍失败 → 告警转人工。 */
export const SNAPSHOT_RETRY_EXHAUSTED_MS = 24 * 3_600_000;

/** 转人工后写在仍为 open 的快照类行上的系统标记（不含个人信息）；有此标记的子订单不再自动重试。 */
export const SNAPSHOT_RETRY_HANDOFF_NOTE = 'auto: commission snapshot retry exhausted; manual';

export function snapshotResolutionNote(outcome: 'created' | 'existing'): string {
  return `auto: commission snapshot ${outcome}`;
}

/** 扫描是否到期：该子订单 open 快照类行里最晚一次 detected_at 不晚于 now − 1 小时（恰好 1 小时算到期）。 */
export function isSnapshotRetryDue(latestDetectedAt: Date, now: Date): boolean {
  return latestDetectedAt.getTime() <= now.getTime() - SNAPSHOT_RETRY_DUE_MS;
}

/** 是否已满 24 小时：最早一条 open 快照类行的 created_at 不晚于 now − 24 小时。 */
export function isSnapshotRetryExhausted(earliestCreatedAt: Date, now: Date): boolean {
  return earliestCreatedAt.getTime() <= now.getTime() - SNAPSHOT_RETRY_EXHAUSTED_MS;
}

export type SnapshotRetrySkipReason =
  'service_fee_unknown' | 'paid_at_unknown' | 'pid_scene_unknown';

export type SnapshotRetryPlan =
  | { readonly kind: 'skip'; readonly reason: SnapshotRetrySkipReason }
  | { readonly kind: 'pending'; readonly reason: SnapshotPendingReason }
  | { readonly kind: 'call'; readonly input: CommissionSnapshotCallInput };

export interface SnapshotRetryPaid {
  readonly paidAt: Date;
  readonly paidAtSource: PaidAtSource;
  /** 库内 paid_at_source 为空、按 chooseSnapshotPaidAt 定出来源，调用方须照 B1-08k 写入订单。 */
  readonly writeSource: boolean;
}

/** 按库内 paid_at_source 恢复快照的 paidAt；不可恢复返回 null。 */
export function resolveRetryPaidAt(input: {
  readonly paidAtSource: string | null;
  readonly paidAt: Date | null;
  readonly depositPaidAt: Date | null;
  readonly firstPaidAt: Date | null;
  readonly now: Date;
}): SnapshotRetryPaid | null {
  switch (input.paidAtSource) {
    case 'platform':
      return input.paidAt === null
        ? null
        : { paidAt: input.paidAt, paidAtSource: 'platform', writeSource: false };
    case 'observed':
      return input.firstPaidAt === null
        ? null
        : { paidAt: input.firstPaidAt, paidAtSource: 'observed', writeSource: false };
    case null: {
      const chosen = chooseSnapshotPaidAt({
        order: {
          app_id: '',
          order_id: '',
          platform: 'jd',
          buy_type: 'self',
          activity_type: null,
          is_presale: false,
          paid_at: input.paidAt,
          deposit_paid_at: input.depositPaidAt,
          est_commission_fen: null,
          settle_commission_fen: null,
          subsidy_commission_fen: null,
        },
        incoming: { modified_at: null, service_fee_fen: null },
        movedToPaidNow: false,
        firstPaidAt: input.firstPaidAt,
        now: input.now,
      });
      return { ...chosen, writeSource: true };
    }
    default:
      // platform_modified：迁到 PAID 那条报文的平台更新时间未持久化（待编排裁定 2）；未知值同样不猜。
      return null;
  }
}

export interface PlanSnapshotRetryInput {
  readonly order: {
    readonly app_id: string;
    readonly order_id: string;
    readonly platform: CommissionSnapshotCallInput['platform'];
    readonly buy_type: 'self' | 'share';
    readonly activity_type: string | null;
    readonly est_commission_fen: bigint | null;
    readonly settle_commission_fen: bigint | null;
    readonly subsidy_commission_fen: bigint | null;
  };
  readonly ownerUserId: string;
  /** null = paidAt 不可恢复。 */
  readonly paid: SnapshotRetryPaid | null;
  /** 本次报文的拼多多服务费；'unknown' = 没有报文可读（扫描路径）。 */
  readonly serviceFeeFen: bigint | null | 'unknown';
  /** 订单推广位的 pid_scene；'unknown' = 无从查询（扫描路径无 pids 端口）。 */
  readonly pidScene: string | null | 'unknown';
}

const TAOLIJIN_SCENE = 'taolijin';

/** 重试时的入参组装；判定顺序与 planCommissionSnapshot 一致（金额 → 服务费 → paidAt），其余字段同 B1-08k。 */
export function planSnapshotRetry(input: PlanSnapshotRetryInput): SnapshotRetryPlan {
  const { order } = input;
  const commission = order.settle_commission_fen ?? order.est_commission_fen;
  if (commission === null) return { kind: 'pending', reason: 'AMOUNT_PARSE_FAILED' };
  let nBaseFen = commission;
  if (order.platform === 'pdd') {
    if (input.serviceFeeFen === 'unknown') return { kind: 'skip', reason: 'service_fee_unknown' };
    if (input.serviceFeeFen === null)
      return { kind: 'pending', reason: 'SERVICE_FEE_RATE_MISSING' };
    nBaseFen = subFen(commission, input.serviceFeeFen);
  }
  if (input.paid === null) return { kind: 'skip', reason: 'paid_at_unknown' };
  let pidScene: string | null;
  if (input.pidScene === 'unknown') {
    // 淘礼金只在淘宝；别的平台场景未知时与 B1-08k「查不到 → 非淘礼金」一致。
    if (order.platform === 'taobao') return { kind: 'skip', reason: 'pid_scene_unknown' };
    pidScene = null;
  } else {
    pidScene = input.pidScene;
  }
  const taolijin = pidScene === TAOLIJIN_SCENE;
  return {
    kind: 'call',
    input: {
      appId: order.app_id,
      orderId: order.order_id,
      platform: order.platform,
      paidAt: input.paid.paidAt,
      paidAtSource: input.paid.paidAtSource,
      orderType: order.buy_type,
      activityType: order.activity_type,
      rebateMode: taolijin ? 'none' : null,
      nBaseFen,
      subsidyCommissionFen: order.subsidy_commission_fen ?? 0n,
      tljDeductFen: 0n,
      tljRedpacketFen: taolijin ? null : 0n,
      ownerUserId: input.ownerUserId,
    },
  };
}
