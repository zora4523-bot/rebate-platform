// B2-15e: the pure part of the refund result judgement (08 BR-PAY-06 ④ ⑤ and 细则). No clock, no
// database: our refund and the configuration values come in as arguments. The rule tests in
// test/spec/payment/refund/** import this file by path; the names, signatures and semantics written
// here are the contract.
//
// judgeRefundResult — one verified refund notification or one refund query answer, next to our
//   facts. The checks run in the order of BR-PAY-06 ④; the first failing one decides, so a later
//   check never masks an earlier one:
//     ① identity ours (PayChannel.ownerAppOf resolved this app)            else rejected
//     ② our refund of the reported out_refund_no in this app               else refund_not_found
//     ③ the original is the refund's target: of the two pairs (reported out_trade_no vs the
//       target's out_trade_no, reported channel trade number vs the target's), at least one pair
//       has both values and they are equal, and no pair has both values and they differ
//                                                                           else original_mismatch
//     ④ the reporting channel is the refund's (its target's pay_channel)   else channel_mismatch
//     ⑤ the reported refund amount is present and equals the refund's amount_fen
//                                                                           else amount_mismatch
//     ⑥ the channel state is in successStates → succeed (PROCESSING) / already_final (SUCCESS,
//       FAILED); in failStates → fail (PROCESSING) / already_final; in neither (or absent)
//                                                                           → state_not_listed
//   A mismatch never moves the refund: it stays PROCESSING and keeps its amount reserved; the
//   caller keeps the record and alerts (BR-PAY-06 ④). succeed: RF2 with refunded_fen, the PAY_REFUND
//   voucher (or the reverse PAY_ANOMALY), the recovery job and pay_refund.succeeded in one
//   transaction; fail: RF3, the reserved amount is free again (BR-PAY-06 ⑤).
//
// refundStatesOf — `pay.<pay_channel>.refund_success_states` / `refund_fail_states` (BR-PAY-06 细则):
//   absent (null / undefined) → the default, fallback false: success lists only the state the
//   official documents name as a successful refund (wechat_pay SUCCESS — 退款查询 status /
//   退款结果通知 refund_status; alipay REFUND_SUCCESS — alipay.trade.fastpay.refund.query
//   refund_status; docs-mirror, 待实测), fail is empty until a tested sample exists (a failure is
//   treated as unknown, the amount stays reserved);
//   success: a non-empty array of non-empty strings → as configured;
//   fail: an array (empty allowed) of non-empty strings → as configured;
//   anything else → the default with fallback true (the caller alerts).
// Also compiled by the `test` project: erasable syntax only.
import type { PayChannelCode, PayRefundStatus } from './types.ts';

/** Our refund of the reported out_refund_no, as the judgement needs it. */
export interface RefundResultRefund {
  readonly status: PayRefundStatus;
  /** The channel of the refund's target (the pay order's or the anomaly's pay_channel). */
  readonly payChannel: PayChannelCode;
  /** pay_refunds.amount_fen. */
  readonly amountFen: bigint;
  /** The target's out_trade_no (null for an anomaly receipt without one). */
  readonly targetOutTradeNo: string | null;
  /** The target's channel trade number (null when we have none). */
  readonly targetChannelTradeNo: string | null;
}

/** What a verified refund notification or a refund query answer says, next to our facts. */
export interface RefundResultFacts {
  /** ① the merchant / application identity resolves to this app. */
  readonly ours: boolean;
  /** ② our refund of that out_refund_no in this app; null when there is none. */
  readonly refund: RefundResultRefund | null;
  /** The channel that reported (the notification route's, or the queried adapter's). */
  readonly channel: PayChannelCode;
  /** The original's merchant number as reported (null when not reported). */
  readonly outTradeNo: string | null;
  /** The original's channel trade number as reported (null when not reported). */
  readonly channelTradeNo: string | null;
  /** The refunded amount as reported in fen (null when not reported). */
  readonly refundFen: bigint | null;
  /** The channel's own refund state, exact and case-sensitive (null when not reported). */
  readonly channelState: string | null;
  /** refundStatesOf(channel, 'success', …).states */
  readonly successStates: readonly string[];
  /** refundStatesOf(channel, 'fail', …).states */
  readonly failStates: readonly string[];
}

export type RefundMismatchReason =
  | 'refund_not_found'
  | 'original_mismatch'
  | 'channel_mismatch'
  | 'amount_mismatch'
  | 'state_not_listed';

export type RefundResultVerdict =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'mismatch'; readonly reason: RefundMismatchReason }
  | { readonly kind: 'succeed' }
  | { readonly kind: 'fail' }
  | { readonly kind: 'already_final' };

/** Which configured list: refund_success_states or refund_fail_states. */
export type RefundStateList = 'success' | 'fail';

/**
 * ③ of the header: at least one compared pair (both values present), every compared pair equal.
 * A pair with a value missing on either side is not compared (an anomaly receipt may have no
 * merchant number of ours; a channel may report only one of the two numbers).
 */
function originalMatches(facts: RefundResultFacts, refund: RefundResultRefund): boolean {
  let compared = 0;
  for (const [reported, ours] of [
    [facts.outTradeNo, refund.targetOutTradeNo],
    [facts.channelTradeNo, refund.targetChannelTradeNo],
  ] as const) {
    if (reported === null || ours === null) continue;
    if (reported !== ours) return false;
    compared += 1;
  }
  return compared > 0;
}

/** BR-PAY-06 ④ in the fixed order ① ～ ⑥ (see the header). */
export function judgeRefundResult(facts: RefundResultFacts): RefundResultVerdict {
  if (!facts.ours) return { kind: 'rejected' };
  const refund = facts.refund;
  if (refund === null) return { kind: 'mismatch', reason: 'refund_not_found' };
  if (!originalMatches(facts, refund)) return { kind: 'mismatch', reason: 'original_mismatch' };
  if (facts.channel !== refund.payChannel) return { kind: 'mismatch', reason: 'channel_mismatch' };
  if (facts.refundFen === null || facts.refundFen !== refund.amountFen) {
    return { kind: 'mismatch', reason: 'amount_mismatch' };
  }
  const state = facts.channelState;
  if (state !== null && facts.successStates.includes(state)) {
    return refund.status === 'PROCESSING' ? { kind: 'succeed' } : { kind: 'already_final' };
  }
  if (state !== null && facts.failStates.includes(state)) {
    return refund.status === 'PROCESSING' ? { kind: 'fail' } : { kind: 'already_final' };
  }
  return { kind: 'mismatch', reason: 'state_not_listed' };
}

/**
 * The documented refund success state of each channel (BR-PAY-06 细则 默认值, 待实测): WeChat Pay
 * 退款查询 status / 退款结果通知 refund_status SUCCESS; Alipay alipay.trade.fastpay.refund.query
 * refund_status REFUND_SUCCESS. Source: docs-mirror/wechat-pay, docs-mirror/alipay/app-pay (not
 * verified against a real merchant account yet).
 */
const DEFAULT_REFUND_SUCCESS_STATES: Readonly<Record<PayChannelCode, readonly string[]>> =
  Object.freeze({
    wechat_pay: Object.freeze(['SUCCESS']),
    alipay: Object.freeze(['REFUND_SUCCESS']),
  });

function isStringArray(raw: unknown, allowEmpty: boolean): raw is readonly string[] {
  return (
    Array.isArray(raw) &&
    (allowEmpty || raw.length > 0) &&
    raw.every((item: unknown) => typeof item === 'string' && item !== '')
  );
}

/** `pay.<pay_channel>.refund_<list>_states` in effect (see the header). */
export function refundStatesOf(
  channel: PayChannelCode,
  list: RefundStateList,
  raw: unknown,
): { readonly states: readonly string[]; readonly fallback: boolean } {
  const defaults = list === 'success' ? [...DEFAULT_REFUND_SUCCESS_STATES[channel]] : [];
  if (raw === null || raw === undefined) return { states: defaults, fallback: false };
  if (isStringArray(raw, list === 'fail')) return { states: [...raw], fallback: false };
  return { states: defaults, fallback: true };
}
