// Daily real-name attempt counter (规划/08 BR-ID-25: 3 per user and +08:00 natural day; task B1-13d
// §9.2 #4, money review r1 S1 ruling, precedent B1-11e: one count per Idempotency-Key).
//
// Redis namespace REALNAME_ATTEMPTS_NAMESPACE:
//   <app_id>:<YYYY-MM-DD +08:00>:<user_id>                  the day's count (plain integer string)
//   <app_id>:<YYYY-MM-DD +08:00>:<user_id>:seen:<sha256>    this request's mark; sha256 of
//                                                           "<user_id>\n<Idempotency-Key>" (the raw
//                                                           key never reaches Redis)
// reserve() in one script: a key already marked → 'seen' (it was counted before: a retry of the same
// request after a failure that left no stored result, e.g. a database error after a definite vendor
// answer, goes on without a second count); else count ≥ limit → 'full' (nothing written); else
// count + 1 and the mark → 'reserved'.
// release() gives back only what this key added: in one script it deletes the mark and, only when
// the mark existed, decrements the count (never below zero). The same key can then reserve again
// (50401 / 50301 do not count). Call it only after 'reserved'.
// Every write expires at one absolute instant per day key (end of that +08:00 day plus
// EXPIRY_GRACE_MS), so later writes never extend the window; the day in the key decides counting.
// Redis failures reject unchanged (the caller answers 50001 or logs).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { createHash } from 'node:crypto';
import { chinaDayRange } from '@couli/domain';
import type { RedisHandle } from '../../platform/index.ts';

/** BR-ID-25: attempts per user and +08:00 natural day. */
export const REALNAME_DAILY_ATTEMPTS = 3;
/** Redis namespace of the daily attempt counters. */
export const REALNAME_ATTEMPTS_NAMESPACE = 'realname_attempts';
/** Keys outlive their day by this much (cleanup only; the day in the key decides counting). */
const EXPIRY_GRACE_MS = 24 * 3600 * 1000;

/** KEYS[1] count, KEYS[2] mark; ARGV[1] ttl, ARGV[2] limit. 2 seen, 1 reserved, 0 full. */
export const RESERVE_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], tostring(n + 1), 'EX', ARGV[1])
redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
return 1`;
/** KEYS[1] count, KEYS[2] mark; ARGV[1] ttl. 1 given back, 0 nothing of this key to give back. */
export const RELEASE_SCRIPT = `
if redis.call('DEL', KEYS[2]) == 0 then return 0 end
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n <= 0 then return 0 end
redis.call('SET', KEYS[1], tostring(n - 1), 'EX', ARGV[1])
return 1`;

export interface AttemptSlot {
  readonly appId: string;
  readonly userId: string;
  /** The +08:00 day of the request (accountingDate), YYYY-MM-DD. */
  readonly day: string;
  /** The request's Idempotency-Key, already validated by the idempotency module. */
  readonly idempotencyKey: string;
}

export type Reservation = 'reserved' | 'seen' | 'full';

export interface RealnameAttempts {
  reserve(slot: AttemptSlot, now: Date): Promise<Reservation>;
  release(slot: AttemptSlot, now: Date): Promise<void>;
}

function keysOf(slot: AttemptSlot): [string, string] {
  const count = `${slot.appId}:${slot.day}:${slot.userId}`;
  const mark = createHash('sha256').update(`${slot.userId}\n${slot.idempotencyKey}`).digest('hex');
  return [count, `${count}:seen:${mark}`];
}

/** Seconds from now to the day key's fixed expiry instant (at least 1). */
export function attemptTtlSeconds(day: string, now: Date): number {
  const expireAt = Date.parse(chinaDayRange(day).end) + EXPIRY_GRACE_MS;
  return Math.max(1, Math.ceil((expireAt - now.getTime()) / 1000));
}

export function createRealnameAttempts(redis: RedisHandle): RealnameAttempts {
  return Object.freeze({
    async reserve(slot: AttemptSlot, now: Date): Promise<Reservation> {
      const answer = await redis.namespace(REALNAME_ATTEMPTS_NAMESPACE).eval(RESERVE_SCRIPT, {
        keys: keysOf(slot),
        args: [String(REALNAME_DAILY_ATTEMPTS)],
        ttlSeconds: attemptTtlSeconds(slot.day, now),
      });
      if (answer === 1) return 'reserved';
      if (answer === 2) return 'seen';
      if (answer === 0) return 'full';
      throw new Error('identity: unexpected real-name reservation answer');
    },
    async release(slot: AttemptSlot, now: Date): Promise<void> {
      await redis.namespace(REALNAME_ATTEMPTS_NAMESPACE).eval(RELEASE_SCRIPT, {
        keys: keysOf(slot),
        args: [],
        ttlSeconds: attemptTtlSeconds(slot.day, now),
      });
    },
  });
}
