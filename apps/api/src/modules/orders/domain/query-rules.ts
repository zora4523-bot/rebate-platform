import type { Schema } from '@couli/contracts-ts';
import type { Clock } from '../../platform/index.ts';

export type DisplayStatus = Schema<'OrderDisplayStatus'>;
export interface DisplayStatusInput {
  rebate_status: 'UNATTRIBUTED' | 'VOID' | 'CLAWED_BACK' | 'CREDITED' | 'ESTIMATED' | 'WAITING';
  platform_status: 'DEPOSIT_PAID' | 'PAID' | 'RECEIVED' | 'SETTLED' | 'INVALID';
  hold: boolean;
  rights_pending: boolean;
  booked_base_fen: bigint | null;
  b_est: bigint | null;
  has_clawback: boolean;
  viewer_share_held: boolean;
  credit_enabled: boolean;
  credit_overdue: boolean;
}

export function deriveDisplayStatus(input: DisplayStatusInput): DisplayStatus | null {
  void input;
  throw new Error('NotImplemented: deriveDisplayStatus');
}

export function maskOrderNo(orderNo: string): string {
  void orderNo;
  throw new Error('NotImplemented: maskOrderNo');
}

export function matchesStatusGroup(
  status: DisplayStatus,
  group: Schema<'OrderStatusGroup'>,
): boolean {
  void status;
  void group;
  throw new Error('NotImplemented: matchesStatusGroup');
}

export function visibleOrderStart(clock: Clock, months: number): string | null {
  void clock;
  void months;
  throw new Error('NotImplemented: visibleOrderStart');
}

/** Action values are owned exclusively by BR-TEXT-05. */
export function orderReasonActions(reason: Schema<'OrderReasonCode'> | null): string[] {
  void reason;
  throw new Error('NotImplemented: orderReasonActions');
}

export interface TimelineInput {
  is_presale: boolean;
  platform_status: DisplayStatusInput['platform_status'];
  display_status: DisplayStatus;
  deposit_paid_at: string | null;
  paid_at: string | null;
  received_at: string | null;
  credited_at: string | null;
  expected_credit_period: string | null;
  invalid_at: string | null;
  clawed_at: string | null;
  part_clawed_at: string | null;
}

export function buildTimeline(input: TimelineInput): Schema<'OrderTimelineItem'>[] {
  void input;
  throw new Error('NotImplemented: buildTimeline');
}
