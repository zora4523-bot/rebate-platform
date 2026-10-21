// B1-10k：后台找回审核（子项通过 / 驳回）的纯判定（BR-ATTR-30、BR-ATTR-20、BR-ATTR-32）。不做 I/O：
// 调用方在取子订单锁、FOR UPDATE 重读订单之后，把重读到的 user_id / rebate_status 喂进来。
// - 通过：重读 user_id 非空 → 不写订单、子项按 BR-ATTR-16 结案（等于申请人 cancelled，否则 rejected
//   NOT_IN_POOL，系统处理）；否则 rebate_status=VOID → rejected ORDER_INVALID（系统处理）；否则 approved。
// - 驳回：rebate_status=VOID → rejected ORDER_INVALID（系统处理，客服所选原因只进审计）；否则按客服原因驳回。
// - 分佣快照的计划输入：找回通过把 user_id 由空写为申请人，rebate_status 本次前为 UNATTRIBUTED；
//   本次没有报文（无平台更新时间、无服务费），拼多多因此按 B1-08k 落待处理。
import type { Schema } from '@couli/contracts-ts';
import type { ClaimItemEvent, OrderPlatformState } from '@couli/domain';
import type {
  CommissionSnapshotCallInput,
  PlanCommissionSnapshotInput,
} from './commission-snapshot.ts';

/** 客服可选的六个驳回原因码（契约 AdminClaimStaffRejectReason）；NOT_IN_POOL、ORDER_INVALID 只由系统写。 */
export const STAFF_REJECT_REASONS = [
  'NO_EVIDENCE',
  'EXPIRED_CLICK',
  'NOT_TRACKED',
  'OTHER_TLJ',
  'FRAUD',
  'OTHER',
] as const satisfies readonly Schema<'AdminClaimStaffRejectReason'>[];
export type StaffRejectReason = (typeof STAFF_REJECT_REASONS)[number];

const STAFF_CODES: ReadonlySet<string> = new Set(STAFF_REJECT_REASONS);

export function isStaffRejectReason(value: unknown): value is StaffRejectReason {
  return typeof value === 'string' && STAFF_CODES.has(value);
}

/** 审核说明去首尾空白后的字数界限（契约：5–200 个字符，按去空白后计、按去空白后存）。 */
export const REVIEW_REASON_MIN = 5;
export const REVIEW_REASON_MAX = 200;

/** 去首尾空白后的说明；字数（按码点）不在 5～200 之间为 null。 */
export function normalizeReviewReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const length = [...trimmed].length;
  return length >= REVIEW_REASON_MIN && length <= REVIEW_REASON_MAX ? trimmed : null;
}

export type ClaimReviewMode = 'approve' | 'reject';
export type SystemRejectReason = 'NOT_IN_POOL' | 'ORDER_INVALID';

/** 一次审核对被审子项的结论。 */
export interface ClaimReviewOutcome {
  /** 交给生成的 transitionClaimItem(null, event)。 */
  readonly event: ClaimItemEvent;
  readonly rejectReason: StaffRejectReason | SystemRejectReason | null;
  /** 客服决定（decided_by=客服）还是系统结案（decided_by 为空）。 */
  readonly byReviewer: boolean;
  /** 只有 approved 才写订单归属、调 settlement 与快照、把同子订单他人待审项驳回 NOT_IN_POOL。 */
  readonly attribute: boolean;
}

export interface ReviewedOrder {
  readonly user_id: string | null;
  readonly rebate_status: string;
}

/** 锁内重读之后的判定：通过先看已归属（BR-ATTR-32），再看 VOID（BR-ATTR-30）；驳回只看 VOID。 */
export function decideClaimReview(
  mode: ClaimReviewMode,
  order: ReviewedOrder,
  applicantUserId: string,
  requested: StaffRejectReason | null,
): ClaimReviewOutcome {
  if (mode === 'approve') {
    if (order.user_id !== null) {
      return order.user_id === applicantUserId
        ? { event: 'CANCEL', rejectReason: null, byReviewer: false, attribute: false }
        : { event: 'REJECT', rejectReason: 'NOT_IN_POOL', byReviewer: false, attribute: false };
    }
    if (order.rebate_status === 'VOID') {
      return {
        event: 'REJECT',
        rejectReason: 'ORDER_INVALID',
        byReviewer: false,
        attribute: false,
      };
    }
    return { event: 'APPROVE', rejectReason: null, byReviewer: true, attribute: true };
  }
  if (order.rebate_status === 'VOID') {
    return { event: 'REJECT', rejectReason: 'ORDER_INVALID', byReviewer: false, attribute: false };
  }
  if (requested === null) throw new RangeError('decideClaimReview: 驳回必须给客服原因码');
  return { event: 'REJECT', rejectReason: requested, byReviewer: true, attribute: false };
}

/** 计划快照要的订单列（orders 行的子集）。 */
export interface ClaimSnapshotOrder {
  readonly app_id: string;
  readonly order_id: string;
  readonly platform: string;
  readonly platform_status: string;
  readonly rebate_status: string;
  readonly buy_type: string | null;
  readonly activity_type: string | null;
  readonly is_presale: boolean;
  readonly paid_at: Date | null;
  readonly deposit_paid_at: Date | null;
  readonly est_commission_fen: bigint | null;
  readonly settle_commission_fen: bigint | null;
  readonly subsidy_commission_fen: bigint | null;
}

/** orders.buy_type 由首次入库写定（self / share）；别的值是数据损坏，不猜。 */
function orderBuyType(value: string | null): 'self' | 'share' {
  if (value === 'self' || value === 'share') return value;
  throw new Error('ORDER_BUY_TYPE_INVALID: orders.buy_type 不是 self / share');
}

/**
 * 找回通过的快照计划输入（BR-ATTR-20 ③ 按 BR-ATTR-01 ⑥）：before = 重读的未归因行，after = 写入申请人，
 * 平台状态不变；本次没有报文，平台更新时间与服务费为空；首次到 PAID+ 的时刻取状态历史。
 */
export function claimSnapshotInput(
  order: ClaimSnapshotOrder,
  userId: string,
  pidScene: string | null,
  firstPaidAt: Date | null,
  now: Date,
): PlanCommissionSnapshotInput {
  const platformStatus = order.platform_status as OrderPlatformState;
  return {
    before: { user_id: null, platform_status: platformStatus, rebate_status: order.rebate_status },
    after: {
      user_id: userId,
      platform_status: platformStatus,
      rebate_status_before: order.rebate_status,
    },
    order: {
      app_id: order.app_id,
      order_id: order.order_id,
      platform: order.platform as CommissionSnapshotCallInput['platform'],
      buy_type: orderBuyType(order.buy_type),
      activity_type: order.activity_type,
      is_presale: order.is_presale,
      paid_at: order.paid_at,
      deposit_paid_at: order.deposit_paid_at,
      est_commission_fen: order.est_commission_fen,
      settle_commission_fen: order.settle_commission_fen,
      subsidy_commission_fen: order.subsidy_commission_fen,
    },
    incoming: { modified_at: null, service_fee_fen: null },
    pidScene,
    movedToPaidNow: false,
    firstPaidAt,
    now,
  };
}
