// B1-10b（BR-ATTR-19；口径 4、7）：当日 ③④ 即时失败次数的 Redis 计数。
// Key: namespace `claim`, key `{app_id}:{user_id}:{yyyymmdd}` (08: claim:{app_id}:{user_id}:{yyyymmdd}),
// value the number of failed requests of that +08:00 day. Read with GET; one failure adds 1 with
// one atomic script (INCR + EXPIRE) whose TTL (ARGV[1]) ends the key at the next 00:00 +08:00.
// Any Redis failure rejects (the caller fails closed with 50001).
//
// One request counts once (Codex 资金评审 r1 S1 ①): a request with an Idempotency-Key also names
// its mark `{app_id}:{user_id}:{yyyymmdd}:req:{request id}` (request id = SHA-256 of the key and
// the request hash of the body, so a different body under the same key is another request). The
// same script adds only when the mark is not there yet and then sets it with the same TTL, so the
// mark ends with the day's count. A retry after a reply that was lost (the script ran, the caller
// answered 50001, idempotency kept no record) finds the mark and adds nothing.
import { createHash } from 'node:crypto';
import { requestHashOf, type RedisHandle } from '../../platform/index.ts';
import type { OrderSubject } from '../application/order-queries.ts';

export const CLAIM_COUNTER_NAMESPACE = 'claim';

/**
 * KEYS[1] the day's count, KEYS[2] (optional) the request's mark; ARGV[1] the TTL of every key it
 * writes. The mark is checked before anything is written (a failing INCR leaves no mark, so the
 * retry still counts) and set after the add. Reply: the new count, or 0 when the mark was there.
 */
const INCREMENT_SCRIPT = `if KEYS[2] and redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
if KEYS[2] then
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
end
return n`;

const COUNT = /^(0|[1-9]\d{0,15})$/;
const REQUEST_ID = /^[0-9a-f]{64}$/;

/** A value that is not a failure count (or a script reply that is not one). */
export class ClaimCounterError extends Error {
  constructor() {
    super('orders: unreadable claim failure counter');
    this.name = 'ClaimCounterError';
  }
}

export interface ClaimFailureCounter {
  /** The failures of the day so far (0 when the key does not exist). */
  read(day: string): Promise<number>;
  /**
   * Adds one failure; resolves with the new count. With `requestId` (claimRequestId), resolves
   * with null and adds nothing when that request was already counted on `day`.
   */
  increment(day: string, ttlSeconds: number, requestId?: string): Promise<number | null>;
}

export function claimCounterKey(subject: OrderSubject, day: string): string {
  return `${subject.app_id}:${subject.user_id}:${day}`;
}

export function claimRequestMarkKey(subject: OrderSubject, day: string, requestId: string): string {
  return `${claimCounterKey(subject, day)}:req:${requestId}`;
}

/**
 * The identity of one submission: its Idempotency-Key with the idempotency module's request hash
 * of the body (64 lowercase hex). Nothing of the body can be read back from it.
 */
export function claimRequestId(idempotencyKey: string, body: unknown): string {
  return createHash('sha256')
    .update(`${idempotencyKey}\n${requestHashOf(body)}`, 'utf8')
    .digest('hex');
}

/** Takes the namespace lazily: nothing touches Redis before the first read or increment. */
export function createClaimFailureCounter(
  redis: RedisHandle,
  subject: OrderSubject,
): ClaimFailureCounter {
  return {
    async read(day) {
      const value = await redis
        .namespace(CLAIM_COUNTER_NAMESPACE)
        .get(claimCounterKey(subject, day));
      if (value === null) return 0;
      if (!COUNT.test(value)) throw new ClaimCounterError();
      return Number(value);
    },
    async increment(day, ttlSeconds, requestId) {
      if (requestId !== undefined && !REQUEST_ID.test(requestId)) throw new ClaimCounterError();
      const keys = [claimCounterKey(subject, day)];
      if (requestId !== undefined) keys.push(claimRequestMarkKey(subject, day, requestId));
      const reply = await redis.namespace(CLAIM_COUNTER_NAMESPACE).eval(INCREMENT_SCRIPT, {
        keys,
        args: [],
        ttlSeconds,
      });
      if (typeof reply !== 'number' || !Number.isSafeInteger(reply)) throw new ClaimCounterError();
      if (reply === 0 && requestId !== undefined) return null;
      if (reply < 1) throw new ClaimCounterError();
      return reply;
    },
  };
}
