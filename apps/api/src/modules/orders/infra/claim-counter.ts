// B1-10b（BR-ATTR-19；口径 4、7）：当日 ③④ 即时失败次数的 Redis 计数。
// Key: namespace `claim`, key `{app_id}:{user_id}:{yyyymmdd}` (08: claim:{app_id}:{user_id}:{yyyymmdd}),
// value the number of failed requests of that +08:00 day. Read with GET; one failure adds 1 with
// an atomic INCR + EXPIRE script whose TTL (ARGV[1]) ends the key at the next 00:00 +08:00. Any
// Redis failure rejects (the caller fails closed with 50001).
import type { RedisHandle } from '../../platform/index.ts';
import type { OrderSubject } from '../application/order-queries.ts';

export const CLAIM_COUNTER_NAMESPACE = 'claim';

/** INCR then EXPIRE with ARGV[1]: every key the script writes gets the caller's TTL. */
const INCREMENT_SCRIPT = `local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return n`;

const COUNT = /^(0|[1-9]\d{0,15})$/;

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
  /** Adds one failure; resolves with the new count. */
  increment(day: string, ttlSeconds: number): Promise<number>;
}

export function claimCounterKey(subject: OrderSubject, day: string): string {
  return `${subject.app_id}:${subject.user_id}:${day}`;
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
    async increment(day, ttlSeconds) {
      const reply = await redis.namespace(CLAIM_COUNTER_NAMESPACE).eval(INCREMENT_SCRIPT, {
        keys: [claimCounterKey(subject, day)],
        args: [],
        ttlSeconds,
      });
      if (typeof reply !== 'number' || !Number.isSafeInteger(reply) || reply < 1) {
        throw new ClaimCounterError();
      }
      return reply;
    },
  };
}
