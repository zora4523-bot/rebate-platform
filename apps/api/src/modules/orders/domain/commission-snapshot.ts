import type { OrderPlatformState } from '@couli/domain';
import type { components } from '@couli/contracts-ts';

// Pure planning DTO; the application port uses commission's public input type.
export interface CommissionSnapshotCallInput {
  readonly appId: string;
  readonly orderId: string;
  readonly platform: components['schemas']['PlatformCode'];
  readonly paidAt: Date;
  readonly paidAtSource: 'platform' | 'platform_modified' | 'observed';
  readonly orderType: 'self' | 'share';
  readonly activityType: string | null;
  readonly rebateMode: 'none' | 'normal' | null;
  readonly nBaseFen: bigint;
  readonly subsidyCommissionFen: bigint;
  readonly tljDeductFen: bigint;
  readonly tljRedpacketFen: bigint | null;
  readonly ownerUserId: string;
}

export interface SnapshotEligibility {
  readonly user_id: string | null;
  readonly platform_status: OrderPlatformState;
  readonly rebate_status: string;
}

export interface PlanCommissionSnapshotInput {
  readonly before: SnapshotEligibility | null;
  readonly after: {
    readonly user_id: string | null;
    readonly platform_status: OrderPlatformState;
    readonly rebate_status_before: string;
  };
  readonly order: {
    readonly app_id: string;
    readonly order_id: string;
    readonly platform: CommissionSnapshotCallInput['platform'];
    readonly buy_type: 'self' | 'share';
    readonly activity_type: string | null;
    readonly is_presale: boolean;
    readonly paid_at: Date | null;
    readonly deposit_paid_at: Date | null;
    readonly est_commission_fen: bigint | null;
    readonly settle_commission_fen: bigint | null;
    readonly subsidy_commission_fen: bigint | null;
  };
  readonly incoming: {
    readonly modified_at: Date | null;
    readonly service_fee_fen: bigint | null;
  };
  readonly pidScene: string | null;
  readonly movedToPaidNow: boolean;
  readonly firstPaidAt: Date | null;
  readonly now: Date;
}

export type CommissionSnapshotPlan =
  | { readonly kind: 'skip' }
  | {
      readonly kind: 'pending';
      readonly reason:
        'AMOUNT_PARSE_FAILED' | 'SERVICE_FEE_RATE_MISSING' | 'TLJ_FACE_VALUE_UNMATCHED';
    }
  | { readonly kind: 'call'; readonly input: CommissionSnapshotCallInput };

export function planCommissionSnapshot(input: PlanCommissionSnapshotInput): CommissionSnapshotPlan {
  void input;
  throw new Error('NotImplemented: planCommissionSnapshot');
}
