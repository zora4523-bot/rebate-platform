// B2-15e: the merchant refund number of a refund and the rhythm of its active queries (08
// BR-PAY-06 ② out_refund_no 创建时生成、唯一、不得修改; ⑤ 结果未知时只查询). Pure: no clock, no
// database. Also compiled by the `test` project: erasable syntax only.
import { randomInt } from 'node:crypto';

/** The alphabet of a generated number: upper-case ASCII letters and digits only. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Random characters after the `R` prefix: 21 characters in all, inside both channels' limits. */
const RANDOM_LENGTH = 20;

/**
 * A new out_refund_no: `R` followed by 20 upper-case ASCII letters or digits from a CSPRNG (21
 * characters; pay_refunds_out_refund_no_check allows 1–32 of [A-Za-z0-9], the intersection of the
 * WeChat Pay and Alipay merchant refund number limits, 待实测). It carries no user, app, order or
 * refund information and is never derived from one; uniqueness is backed by the
 * (app_id, out_refund_no) unique key. The `R` prefix keeps it apart from an out_trade_no (`P`).
 */
export function generateOutRefundNo(): string {
  let out = 'R';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * The active queries of a PROCESSING refund, in seconds after its creation (BR-PAY-06 ⑤: 结果未知时
 * 只查询; D10-351 ③: the first one is enqueued with the refund). 08 gives no rhythm for refunds;
 * these slots are the implementation's default (an orchestrator value, not a business rule): one
 * minute, five minutes, half an hour, two hours, one day. After the last slot the refund stays
 * PROCESSING and the worker alerts (pay_refund_query_exhausted); the console sees it on the list.
 */
export const REFUND_QUERY_SCHEDULE_SECONDS: readonly number[] = Object.freeze([
  60, 300, 1800, 7200, 86400,
]);

/** The planned query instants of one refund, ascending. */
export function refundQueryInstants(createdAt: Date): readonly Date[] {
  return REFUND_QUERY_SCHEDULE_SECONDS.map((second) => {
    // A copy moved by the slot (no `new Date(` in app code; the given instant is never modified).
    const at = structuredClone(createdAt);
    at.setTime(createdAt.getTime() + second * 1000);
    return at;
  });
}

/** The first planned instant strictly after now, or null once the schedule is exhausted. */
export function nextRefundQueryInstant(createdAt: Date, now: Date): Date | null {
  for (const at of refundQueryInstants(createdAt)) {
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/** The slot of a planned instant: whole seconds after the refund's creation (the job's singletonKey). */
export function refundQuerySlotSeconds(createdAt: Date, at: Date): number {
  return Math.round((at.getTime() - createdAt.getTime()) / 1000);
}
