// Daily real-name attempt counter (规划/08 BR-ID-25: 3 per user and +08:00 natural day; task B1-13d
// §9.2 #4; money review r1–r3 S1 rulings, precedent B1-11e): one count per request, and the
// request's definite outcome kept with it, so a retry never counts again nor calls the vendor again.
//
// Invariant: vendor calls with a definite answer ≤ the day's count ≤ REALNAME_DAILY_ATTEMPTS. (A
// vendor timeout / unavailability is given back by rule, BR-ID-25, and is the only call outside the
// count.) Only release() lowers the count, and only the request that reserved calls it, before its
// own vendor call or after an answer that is not definite — never on a retry.
//
// Redis namespace REALNAME_ATTEMPTS_NAMESPACE:
//   <app_id>:<YYYY-MM-DD +08:00>:<user_id>                  the day's count (plain integer string)
//   <app_id>:<YYYY-MM-DD +08:00>:<user_id>:seen:<sha256>    the request's mark; sha256 of
//       "<user_id>\n<Idempotency-Key>\n<request digest>" — the raw key never reaches Redis, and the
//       digest (a keyed blind index of the normalised name and ID number, made by the caller) ties
//       the mark to the submitted values: the same key with other values is another request.
// Mark values: `pending:<epoch ms>` (reserved at that Clock instant, outcome not known yet),
// `expired` (terminal: the pending lease ran out), `occupied` (30405), `match:<provider>`,
// `mismatch:<provider>`. A retry that finds a pending mark cannot know whether the earlier attempt
// got a definite answer (it may have died just before record()), so it never calls the vendor and
// never gives anything back (money review r3, ruling A): within the lease (REALNAME_PENDING_LEASE_MS,
// the vendor timeout cap plus a margin; precedent BR-WDR-02 细则「在途记录有租约」) → 'pending';
// after it, the same script turns the mark into `expired` → 'expired', and so it stays until the
// day's keys expire. Both are answered 50401; a new Idempotency-Key is a new request under the
// normal count and limit. Unreadable mark values are treated as `expired`.
// reserve() in one script: a mark exists → its value (the caller replays it; nothing changes);
// else count ≥ limit → 'full' (nothing written); else count + 1 and the mark pending. So the
// limit is judged only for requests without a mark, and a request with a mark never reaches the
// vendor a second time: the day's vendor calls stay ≤ the limit.
// record() stores the definite outcome only over this request's pending mark (before the database
// write); a missing or terminal mark is left as it is and the count is not touched.
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
/**
 * Upper bound of one vendor call. No vendor adapter (hence no vendor timeout setting) exists yet.
 * TODO(规划/11 §7.1): 改读二要素供应商适配器的超时配置 — blocked on 供应商选型与开通（BR-ID-25 细则「供应商」）
 */
export const REALNAME_VENDOR_TIMEOUT_MS = 10_000;
/** Lease of a pending mark: the vendor timeout cap plus a margin for the write around it. */
export const REALNAME_PENDING_LEASE_MS = REALNAME_VENDOR_TIMEOUT_MS + 20_000;

/**
 * KEYS[1] count, KEYS[2] mark; ARGV[1] ttl, ARGV[2] limit, ARGV[3] now (epoch ms, Clock),
 * ARGV[4] lease ms. Mark value (a pending mark past its lease becomes 'expired'), 1 reserved, 0 full.
 */
export const RESERVE_SCRIPT = `
local m = redis.call('GET', KEYS[2])
if m then
  if string.sub(m, 1, 8) == 'pending:' then
    local at = tonumber(string.sub(m, 9))
    if at == nil or tonumber(ARGV[3]) - at >= tonumber(ARGV[4]) then
      redis.call('SET', KEYS[2], 'expired', 'EX', ARGV[1])
      return 'expired'
    end
  end
  return m
end
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], tostring(n + 1), 'EX', ARGV[1])
redis.call('SET', KEYS[2], 'pending:' .. ARGV[3], 'EX', ARGV[1])
return 1`;
/** KEYS[1] count (unused), KEYS[2] mark; ARGV[1] ttl, ARGV[2] outcome. 1 stored, 0 not pending. */
export const RECORD_SCRIPT = `
local m = redis.call('GET', KEYS[2])
if m and string.sub(m, 1, 8) == 'pending:' then
  redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[1])
  return 1
end
return 0`;
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
  /** Its pending lease ran out (terminal for this request). */
  | { readonly kind: 'expired' }
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

/** A stored mark value; anything unreadable is treated as terminal (expired). */
function decode(value: string): Reservation {
  if (value === 'occupied') return { kind: 'recorded', outcome: { kind: 'occupied' } };
  const colon = value.indexOf(':');
  const kind = value.slice(0, colon);
  const provider = value.slice(colon + 1);
  if (colon > 0 && (kind === 'match' || kind === 'mismatch') && /\S/.test(provider)) {
    return { kind: 'recorded', outcome: { kind, provider } };
  }
  return kind === 'pending' ? { kind: 'pending' } : { kind: 'expired' };
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
      const answer = await run(RESERVE_SCRIPT, slot, now, [
        String(REALNAME_DAILY_ATTEMPTS),
        String(now.getTime()),
        String(REALNAME_PENDING_LEASE_MS),
      ]);
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
