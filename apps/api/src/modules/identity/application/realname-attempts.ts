// Daily real-name attempt counter (规划/08 BR-ID-25: 3 per user and +08:00 natural day; task B1-13d
// §9.2 #4; money review r1 / r2 S1 rulings, precedent B1-11e): one count per request, and the
// request's definite outcome kept with it, so a retry never counts again nor calls the vendor again.
//
// Redis namespace REALNAME_ATTEMPTS_NAMESPACE:
//   <app_id>:<YYYY-MM-DD +08:00>:<user_id>                  the day's count (plain integer string)
//   <app_id>:<YYYY-MM-DD +08:00>:<user_id>:seen:<sha256>    the request's mark; sha256 of
//       "<user_id>\n<Idempotency-Key>\n<request digest>" — the raw key never reaches Redis, and the
//       digest (a keyed blind index of the normalised name and ID number, made by the caller) ties
//       the mark to the submitted values: the same key with other values is another request.
// Mark values: `pending` (reserved, outcome not known yet), `occupied` (30405), `match:<provider>`,
// `mismatch:<provider>`.
// reserve() in one script: a mark exists → its value (the caller replays it; nothing changes);
// else count ≥ limit → 'full' (nothing written); else count + 1 and the mark `pending`. So the
// limit is judged only for requests without a mark, and a request with a mark never reaches the
// vendor a second time: the day's vendor calls stay ≤ the limit.
// record() stores the definite outcome in the mark (before the database write); if the mark is
// gone (given back meanwhile), it counts the attempt again with it.
// release() gives back only what this request added: it deletes the mark and, only when the mark
// existed, decrements the count (never below zero). The same request can then reserve again.
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

/** KEYS[1] count, KEYS[2] mark; ARGV[1] ttl, ARGV[2] limit. Mark value, 1 reserved, 0 full. */
export const RESERVE_SCRIPT = `
local m = redis.call('GET', KEYS[2])
if m then return m end
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], tostring(n + 1), 'EX', ARGV[1])
redis.call('SET', KEYS[2], 'pending', 'EX', ARGV[1])
return 1`;
/** KEYS[1] count, KEYS[2] mark; ARGV[1] ttl, ARGV[2] outcome. A missing mark is counted again. */
export const RECORD_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 0 then
  local n = tonumber(redis.call('GET', KEYS[1]) or '0')
  redis.call('SET', KEYS[1], tostring(n + 1), 'EX', ARGV[1])
end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[1])
return 1`;
/** KEYS[1] count, KEYS[2] mark; ARGV[1] ttl. 1 given back, 0 nothing of this request to give back. */
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
  /** A keyed digest of the normalised submitted values (never the values themselves). */
  readonly requestDigest: string;
}

/** A definite outcome kept in the mark. */
export type AttemptOutcome =
  | { readonly kind: 'occupied' }
  | { readonly kind: 'match' | 'mismatch'; readonly provider: string };

export type Reservation =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'full' }
  /** Reserved earlier, outcome unknown (that request died or is still running). */
  | { readonly kind: 'pending' }
  | { readonly kind: 'recorded'; readonly outcome: AttemptOutcome };

export interface RealnameAttempts {
  reserve(slot: AttemptSlot, now: Date): Promise<Reservation>;
  record(slot: AttemptSlot, outcome: AttemptOutcome, now: Date): Promise<void>;
  release(slot: AttemptSlot, now: Date): Promise<void>;
}

function keysOf(slot: AttemptSlot): [string, string] {
  const count = `${slot.appId}:${slot.day}:${slot.userId}`;
  const mark = createHash('sha256')
    .update(`${slot.userId}\n${slot.idempotencyKey}\n${slot.requestDigest}`)
    .digest('hex');
  return [count, `${count}:seen:${mark}`];
}

/** Seconds from now to the day key's fixed expiry instant (at least 1). */
export function attemptTtlSeconds(day: string, now: Date): number {
  const expireAt = Date.parse(chinaDayRange(day).end) + EXPIRY_GRACE_MS;
  return Math.max(1, Math.ceil((expireAt - now.getTime()) / 1000));
}

function encode(outcome: AttemptOutcome): string {
  return outcome.kind === 'occupied' ? 'occupied' : `${outcome.kind}:${outcome.provider}`;
}

/** A stored mark value; anything unreadable is treated as an unknown outcome (pending). */
function decode(value: string): Reservation {
  if (value === 'occupied') return { kind: 'recorded', outcome: { kind: 'occupied' } };
  const colon = value.indexOf(':');
  const kind = value.slice(0, colon);
  const provider = value.slice(colon + 1);
  if (colon > 0 && (kind === 'match' || kind === 'mismatch') && /\S/.test(provider)) {
    return { kind: 'recorded', outcome: { kind, provider } };
  }
  return { kind: 'pending' };
}

export function createRealnameAttempts(redis: RedisHandle): RealnameAttempts {
  const run = (script: string, slot: AttemptSlot, now: Date, args: readonly string[]) =>
    redis.namespace(REALNAME_ATTEMPTS_NAMESPACE).eval(script, {
      keys: keysOf(slot),
      args,
      ttlSeconds: attemptTtlSeconds(slot.day, now),
    });
  return Object.freeze({
    async reserve(slot: AttemptSlot, now: Date): Promise<Reservation> {
      const answer = await run(RESERVE_SCRIPT, slot, now, [String(REALNAME_DAILY_ATTEMPTS)]);
      if (answer === 1) return { kind: 'reserved' };
      if (answer === 0) return { kind: 'full' };
      if (typeof answer === 'string') return decode(answer);
      throw new Error('identity: unexpected real-name reservation answer');
    },
    async record(slot: AttemptSlot, outcome: AttemptOutcome, now: Date): Promise<void> {
      await run(RECORD_SCRIPT, slot, now, [encode(outcome)]);
    },
    async release(slot: AttemptSlot, now: Date): Promise<void> {
      await run(RELEASE_SCRIPT, slot, now, []);
    },
  });
}
