// B1-08l: pure rules behind the order list and detail (GET /v1/orders, GET /v1/orders/{order_id})
// and the shared B3-08 query surface. Values come only from 08: the display-status table
// BR-FUND-17, the timeline / order-number / status-group 细则 of BR-TEXT-02, the visible range of
// BR-ID-30 细则「订单类记录」 and the reason actions of BR-TEXT-05. Months are shifted as YYYY-MM
// strings; the instant → month and month → range conversions are @couli/domain's.
import type { Schema } from '@couli/contracts-ts';
import { chinaMonth, chinaMonthRange } from '@couli/domain';
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

/**
 * BR-FUND-17 派生表, first matching row wins (row 11 is retired). null = row 0: an unattributed
 * order is never shown. b_est null means unknown and never matches row 7. A CREDITED order whose
 * viewer share is still held reads REVIEWING for that viewer (rows 4 and 5 only).
 */
export function deriveDisplayStatus(input: DisplayStatusInput): DisplayStatus | null {
  const rebate = input.rebate_status;
  if (rebate === 'UNATTRIBUTED') return null;
  if (rebate === 'VOID') return 'INVALID';
  if (rebate === 'CLAWED_BACK') return 'CLAWED_BACK';
  if (rebate === 'CREDITED') {
    if (input.booked_base_fen === 0n) return 'NO_REBATE';
    if (input.viewer_share_held) return 'REVIEWING';
    return input.has_clawback ? 'CREDITED_PART_CLAWED' : 'CREDITED';
  }
  if (rebate === 'ESTIMATED' && input.platform_status === 'DEPOSIT_PAID') return 'DEPOSIT_PAID';
  if (input.b_est === 0n) return 'NO_REBATE';
  if (input.hold) return 'REVIEWING';
  if (input.rights_pending) return 'RIGHTS_PENDING';
  if (rebate === 'WAITING') {
    if (!input.credit_enabled) return 'CREDITING';
    if (input.credit_overdue) return 'CREDITING';
    return 'WAITING';
  }
  return 'PAID';
}

/**
 * BR-TEXT-02 细则「订单号的显示」 for shared orders, counted in Unicode code points (「-」 included):
 * length ≥ 10 keeps the first 4 and the last 2 with 「****」 between; shorter keeps the last 2.
 */
export function maskOrderNo(orderNo: string): string {
  const chars = Array.from(orderNo);
  const last = chars.slice(-2).join('');
  if (chars.length >= 10) return `${chars.slice(0, 4).join('')}****${last}`;
  return `****${last}`;
}

const STATUS_GROUPS: Readonly<
  Record<Exclude<Schema<'OrderStatusGroup'>, 'all'>, readonly DisplayStatus[]>
> = {
  estimating: ['DEPOSIT_PAID', 'PAID', 'WAITING', 'CREDITING', 'RIGHTS_PENDING', 'REVIEWING'],
  credited: ['CREDITED', 'CREDITED_PART_CLAWED'],
  no_rebate: ['NO_REBATE', 'INVALID', 'CLAWED_BACK'],
};

/** BR-TEXT-02 细则「订单列表的状态分组」; all holds every status. */
export function matchesStatusGroup(
  status: DisplayStatus,
  group: Schema<'OrderStatusGroup'>,
): boolean {
  if (group === 'all') return true;
  return STATUS_GROUPS[group].includes(status);
}

/**
 * BR-ID-30 细则「订单类记录」: with N > 0 the first visible day is the 1st of the month N months
 * before the current +08:00 month (YYYY-MM-DD); N = 0 is unlimited (null).
 */
export function visibleOrderStart(clock: Clock, months: number): string | null {
  if (!Number.isSafeInteger(months) || months <= 0) return null;
  const [year, month] = chinaMonth(clock.now()).split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) - months;
  const startYear = Math.floor(index / 12);
  const startMonth = index - startYear * 12 + 1;
  const label = `${String(startYear).padStart(4, '0')}-${String(startMonth).padStart(2, '0')}`;
  return chinaMonthRange(label).start.slice(0, 10);
}

/** Action column of the BR-TEXT-05 order_reason table; values are owned exclusively by BR-TEXT-05. */
const REASON_ACTIONS: Readonly<Partial<Record<Schema<'OrderReasonCode'>, readonly string[]>>> = {
  PUNISH: ['CONTACT_CS'],
  COMMISSION_ZERO: ['CONTACT_CS'],
  OTHER: ['CONTACT_CS'],
  BLACKLIST: ['APPEAL'],
  NOT_TRACKED: ['CLAIM'],
  RELATION_INVALID: ['REAUTH'],
};

/** Action values are owned exclusively by BR-TEXT-05. */
export function orderReasonActions(reason: Schema<'OrderReasonCode'> | null): string[] {
  if (reason === null) return [];
  return [...(REASON_ACTIONS[reason] ?? [])];
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

type TimelineItem = Schema<'OrderTimelineItem'>;
const node = (name: TimelineItem['node'], at: string | null): TimelineItem => ({
  node: name,
  at,
  period: null,
});

/**
 * BR-TEXT-02 细则「时间线」: paid → received → credit_expected (period only) → credited; a
 * pre-sale order starts with deposit_paid and has final_paid (null while still DEPOSIT_PAID).
 * INVALID / CLAWED_BACK / CREDITED_PART_CLAWED append their node; a missing time stays null.
 */
export function buildTimeline(input: TimelineInput): TimelineItem[] {
  const depositStage =
    input.platform_status === 'DEPOSIT_PAID' || input.display_status === 'DEPOSIT_PAID';
  const head = input.is_presale
    ? [
        node('deposit_paid', input.deposit_paid_at),
        node('final_paid', depositStage ? null : input.paid_at),
      ]
    : [node('paid', input.paid_at)];
  const items: TimelineItem[] = [
    ...head,
    node('received', input.received_at),
    { node: 'credit_expected', at: null, period: input.expected_credit_period },
    node('credited', input.credited_at),
  ];
  if (input.display_status === 'INVALID') items.push(node('invalid', input.invalid_at));
  else if (input.display_status === 'CLAWED_BACK') items.push(node('clawed_back', input.clawed_at));
  else if (input.display_status === 'CREDITED_PART_CLAWED') {
    items.push(node('part_clawed_back', input.part_clawed_at));
  }
  return items;
}
