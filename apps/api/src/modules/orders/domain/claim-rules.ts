// B1-10b: the pure parts of claim acceptance (08 BR-ATTR-17 ⓪～④, BR-ATTR-19, BR-ATTR-13 ④;
// orchestrator 口径 5～8). No database, Redis or clock here: the application reads the rows and
// the time and hands them in.
import { accountingDate, chinaDayRange } from '@couli/domain';

/** BR-ATTR-19: claims created (entered submitted) per user per +08:00 day. */
export const CLAIM_DAILY_LIMIT = 5;
/** BR-ATTR-19: same-day ③④ failures at which claim_fail_burst blocks the rest of the day. */
export const CLAIM_FAIL_LIMIT = 10;
/** BR-ATTR-13 ④: default claim window W_claim in hours (used when claim.window_hours is unusable). */
export const DEFAULT_CLAIM_WINDOW_HOURS = 720;

const HOUR_MS = 3_600_000;

/** 30202 data.reason values of BR-ATTR-17 ④. */
export type ClaimRejectReason =
  'FACTOR_MISMATCH' | 'CLAIM_EXPIRED' | 'ORDER_INVALID' | 'ALREADY_YOURS';

/** One child order's failure in ④ (30202 carries a reason, the others carry no data). */
export type ClaimChildFailure =
  | { readonly code: 30202; readonly reason: ClaimRejectReason }
  | { readonly code: 30204 }
  | { readonly code: 30205 };

/** What ④ reads of a matched child order. */
export interface ClaimChild {
  readonly sub_order_id: string;
  readonly attr_at: Date;
  readonly rebate_status: string;
  readonly user_id: string | null;
  readonly locked: boolean;
}

export interface ClaimChildContext {
  /** The applicant (token user). */
  readonly applicant: string;
  /** Request paid_date, YYYY-MM-DD (+08:00). */
  readonly paid_date: string;
  readonly now: Date;
  readonly windowHours: number;
  /** sub_order_ids the applicant already has in claim_items for this platform (any decision). */
  readonly alreadyClaimed: ReadonlySet<string>;
}

/** 口径 1 / 待裁定 6: only U+0020 is removed; other whitespace takes part in the comparison. */
export function stripClaimSpaces(orderNo: string): string {
  return orderNo.replaceAll(' ', '');
}

/** The value compared with stored numbers: pdd drops every hyphen (both sides), others as is. */
export function claimCompareValue(platform: string, orderNo: string): string {
  return platform === 'pdd' ? orderNo.replaceAll('-', '') : orderNo;
}

/** claim.window_hours when it is a positive integer, else the BR-ATTR-13 ④ default. */
export function claimWindowHours(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_CLAIM_WINDOW_HOURS;
}

/** UTF-16 code unit order (JS default sort; the same as PostgreSQL "C"). */
export function compareSubOrderId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** BR-ATTR-17 ④ a→f for one child; the first failing check, or null when it passes all. */
export function judgeClaimChild(
  child: ClaimChild,
  context: ClaimChildContext,
): ClaimChildFailure | null {
  if (accountingDate(child.attr_at) !== context.paid_date) {
    return { code: 30202, reason: 'FACTOR_MISMATCH' };
  }
  // Absolute hours (BR-ATTR-13): the boundary instant itself still passes.
  if (context.now.getTime() > child.attr_at.getTime() + context.windowHours * HOUR_MS) {
    return { code: 30202, reason: 'CLAIM_EXPIRED' };
  }
  if (child.rebate_status === 'VOID') return { code: 30202, reason: 'ORDER_INVALID' };
  if (context.alreadyClaimed.has(child.sub_order_id)) return { code: 30205 };
  if (child.user_id !== null) {
    return child.user_id === context.applicant
      ? { code: 30202, reason: 'ALREADY_YOURS' }
      : { code: 30204 };
  }
  if (child.locked) return { code: 30204 };
  return null;
}

export interface ClaimJudgement<T extends ClaimChild> {
  /** Children that passed, by sub_order_id ascending. */
  readonly passed: readonly T[];
  /** The failure of the first child by sub_order_id ascending, when none passed. */
  readonly failure: ClaimChildFailure | null;
}

/** ④ over every matched child: who passes, or the first child's failure when nobody does. */
export function judgeClaimChildren<T extends ClaimChild>(
  children: readonly T[],
  context: ClaimChildContext,
): ClaimJudgement<T> {
  const sorted = [...children].sort((a, b) => compareSubOrderId(a.sub_order_id, b.sub_order_id));
  const passed: T[] = [];
  let first: ClaimChildFailure | null = null;
  for (const child of sorted) {
    const failure = judgeClaimChild(child, context);
    if (failure === null) passed.push(child);
    else first ??= failure;
  }
  return { passed, failure: passed.length > 0 ? null : first };
}

/** The +08:00 day of `now` as the counter key segment, yyyymmdd. */
export function claimCounterDay(now: Date): string {
  return accountingDate(now).replaceAll('-', '');
}

/** Whole seconds from `now` to the next 00:00 +08:00, rounded up, at least 1. */
export function secondsUntilNextChinaDay(now: Date): number {
  const end = Date.parse(chinaDayRange(accountingDate(now)).end);
  return Math.max(1, Math.ceil((end - now.getTime()) / 1000));
}
