// B2-15c: the pure part of the pay result judgement (08 BR-PAY-04 and 细则, BR-PAY-05 ④; task
// §9.3 / §9.5 / §9.6). No clock, no database: instants and configuration values come in as
// arguments. The checks run in the fixed order ① identity → ② order → ③ amount → ④ state; the
// first failing check decides, so a later check never masks an earlier one.
// Also compiled by the `test` project: erasable syntax only.
import type { PayChannelCode, PayOrderStatus } from './types.ts';

/** Our pay order of the reported out_trade_no (same app, same channel), as the judgement needs it. */
export interface PayResultOrder {
  readonly status: PayOrderStatus;
  readonly amountFen: bigint;
}

/**
 * What a verified notification or a query answer says, next to our facts. The checks run in the
 * fixed order of task §9.3: ① identity ours → ② order found → ③ amount equal → ④ state listed.
 */
export interface PayResultFacts {
  /** ① the merchant / application identity resolves to this app (PayChannel.ownerAppOf). */
  readonly ours: boolean;
  /** ② our order of that out_trade_no on that channel in that app; null when there is none. */
  readonly order: PayResultOrder | null;
  /** The channel's order total in fen. */
  readonly amountFen: bigint;
  /** The channel's own trade state (exact, case-sensitive). */
  readonly channelState: string;
  /** `pay.<pay_channel>.success_states` in effect (successStatesOf). */
  readonly successStates: readonly string[];
}

export type PayMismatchReason = 'order_not_found' | 'amount_mismatch' | 'state_not_success';

/**
 * rejected: ① failed (no trace at all). mismatch: kept, alerted, nothing moves. settle: PENDING →
 * PO2 with the receipt posting and the fulfilment job. already_paid: nothing more. anomaly: money
 * received for a CLOSED order (orderFound true) or for an out_trade_no we have no order of
 * (orderFound false, the state being a listed success state): an anomaly receipt (BR-PAY-05 ④).
 */
export type PayResultVerdict =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'mismatch'; readonly reason: PayMismatchReason }
  | { readonly kind: 'settle' }
  | { readonly kind: 'already_paid' }
  | { readonly kind: 'anomaly'; readonly orderFound: boolean };

/**
 * BR-PAY-04 核对表 in the fixed order. Without an order of ours (②) the state (④) still decides
 * between money received for a number we do not know (anomaly, BR-PAY-05 ④) and a notification of
 * something else (mismatch order_not_found); the amount (③) has nothing to be compared with.
 */
export function judgePayResult(facts: PayResultFacts): PayResultVerdict {
  if (!facts.ours) return { kind: 'rejected' };
  const listed = facts.successStates.includes(facts.channelState);
  if (facts.order === null) {
    return listed
      ? { kind: 'anomaly', orderFound: false }
      : { kind: 'mismatch', reason: 'order_not_found' };
  }
  if (facts.amountFen !== facts.order.amountFen) {
    return { kind: 'mismatch', reason: 'amount_mismatch' };
  }
  if (!listed) return { kind: 'mismatch', reason: 'state_not_success' };
  switch (facts.order.status) {
    case 'PENDING':
      return { kind: 'settle' };
    case 'PAID':
      return { kind: 'already_paid' };
    case 'CLOSED':
      // CLOSED 的单不得再变为 PAID (BR-PAY-05 ④): the money is an anomaly receipt.
      return { kind: 'anomaly', orderFound: true };
  }
}

/**
 * The documented success state of each channel (BR-PAY-04 细则 默认值, 待实测: WeChat Pay
 * trade_state SUCCESS, Alipay trade_status TRADE_SUCCESS; TRADE_FINISHED is not listed until
 * tested). Source: docs-mirror/wechat-pay, docs-mirror/alipay/app-pay (not verified yet).
 */
const DEFAULT_SUCCESS_STATES: Readonly<Record<PayChannelCode, readonly string[]>> = Object.freeze({
  wechat_pay: Object.freeze(['SUCCESS']),
  alipay: Object.freeze(['TRADE_SUCCESS']),
});

/** The default `pay.query_schedule`: seconds after creation (BR-PAY-04). */
const DEFAULT_QUERY_SCHEDULE: readonly number[] = Object.freeze([10, 30, 60, 180, 600]);

function isNonEmptyStringArray(raw: unknown): raw is readonly string[] {
  return (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((item: unknown) => typeof item === 'string' && item !== '')
  );
}

/**
 * `pay.<pay_channel>.success_states` (BR-PAY-04 细则): absent (null / undefined) → the documented
 * success state only (wechat_pay SUCCESS, alipay TRADE_SUCCESS), fallback false; a non-empty array
 * of non-empty strings → as configured; anything else → the default with fallback true (alerted).
 */
export function successStatesOf(
  channel: PayChannelCode,
  raw: unknown,
): { readonly states: readonly string[]; readonly fallback: boolean } {
  const defaults = [...DEFAULT_SUCCESS_STATES[channel]];
  if (raw === null || raw === undefined) return { states: defaults, fallback: false };
  if (isNonEmptyStringArray(raw)) return { states: [...raw], fallback: false };
  return { states: defaults, fallback: true };
}

function isStrictlyIncreasingPositiveIntegers(raw: unknown): raw is readonly number[] {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  let previous = 0;
  for (const item of raw as readonly unknown[]) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= previous) return false;
    previous = item;
  }
  return true;
}

/**
 * `pay.query_schedule` in seconds after the order's creation (BR-PAY-04): absent → 10, 30, 60,
 * 180, 600 with fallback false; a non-empty, strictly increasing array of positive integers → as
 * configured; anything else → the default with fallback true (alerted).
 */
export function queryScheduleOf(raw: unknown): {
  readonly seconds: readonly number[];
  readonly fallback: boolean;
} {
  if (raw === null || raw === undefined)
    return { seconds: [...DEFAULT_QUERY_SCHEDULE], fallback: false };
  if (isStrictlyIncreasingPositiveIntegers(raw)) return { seconds: [...raw], fallback: false };
  return { seconds: [...DEFAULT_QUERY_SCHEDULE], fallback: true };
}

/**
 * The planned query instants of one order: createdAt + each scheduled second that falls before
 * expireAt, then expireAt itself once (BR-PAY-04 「到 expire_at 再一次」), ascending.
 */
export function queryInstants(
  createdAt: Date,
  expireAt: Date,
  seconds: readonly number[],
): readonly Date[] {
  // Copies moved by the slot (no `new Date(` in app code; the given instants are never modified).
  const instants: Date[] = [];
  for (const second of seconds) {
    const at = structuredClone(createdAt);
    at.setTime(createdAt.getTime() + second * 1000);
    if (at.getTime() < expireAt.getTime()) instants.push(at);
  }
  instants.push(structuredClone(expireAt));
  return instants;
}

/** The slot of a planned instant: whole seconds after the order's creation (the job's singletonKey). */
export function querySlotSeconds(createdAt: Date, at: Date): number {
  return Math.round((at.getTime() - createdAt.getTime()) / 1000);
}

/** Seconds from now to a planned instant, never negative, rounded up so a job never runs early. */
export function delaySecondsUntil(now: Date, at: Date): number {
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000));
}

/** The first planned instant strictly after now, or null once the expire_at query is behind us. */
export function nextQueryInstant(instants: readonly Date[], now: Date): Date | null {
  for (const at of instants) {
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}
