// Redis store of the SMS codes and of the per-phone send quota (BR-ID-05; orchestrator ruling B1-02e
// §9.3 #2–#4: Redis, no table; every key carries a TTL; reserve → commit after acceptance / release
// after a definite rejection, each one atomic Lua call; review round 1: an unconfirmed send is never
// forgotten, and the candidate code is stored before the SMS goes out).
//
// Namespace `sms` (platform/redis prefixes every key with `sms:`). Keys hold no phone number and
// no code in clear: the caller passes `phoneKey`, an HMAC of the normalised number, and code HMACs
// (hex, so `,` never occurs in one).
//   q:<phoneKey>                    sorted set, the send history of one phone over every app and
//                                   purpose: `a:<token>` scored with the acceptance time of an
//                                   accepted (or outcome unknown) SMS, `p:<token>` scored with the
//                                   reservation time of a send not committed (in flight, or its
//                                   commit failed). Both count towards every limit until they leave
//                                   the 24-hour window; only a definite rejection removes a `p:`.
//                                   TTL 25 h, refreshed on every write (garbage collection only).
//   c:<app_id>:<purpose>:<phoneKey> hash, the codes of one app, purpose and phone:
//                                     h, t, e    the code in force: HMAC ('' when none), issued at
//                                                (ms), wrong tries;
//                                     n, k, nt, ne  the candidate of a send not committed: HMAC
//                                                ('' when none), reservation token, reservation
//                                                time, wrong tries;
//                                     u          purpose;
//                                     v          HMACs of replaced, consumed and voided codes,
//                                                comma-separated, newest last, at most VOID_LIMIT.
//                                   TTL 300 s, refreshed on every write (garbage collection only).
//
// State machine of one send (token T, candidate C):
//   reserve  — limits hold → limited, nothing written. C equals h, n or a void HMAC → collision,
//              nothing written (the caller draws another code). Otherwise one call adds p:T and
//              stores C as the candidate (n=C, k=T, nt=now). A candidate already there (an earlier
//              send never committed nor released) counts as sent: it becomes the code in force and
//              the code it replaces goes to v.
//   (the SMS is sent; while n is set, n is the current code and h is void)
//   commit   — after acceptance or an unknown outcome: p:T becomes a:T at the acceptance time and,
//              if the candidate is still T's, C becomes the code in force (h=C, t=now) and the
//              replaced code goes to v. Idempotent per token: a retry after a lost reply neither
//              counts twice nor resends anything. When it never runs, p:T keeps counting at its
//              reservation time and C stays verifiable, so nothing is under-counted.
//   release  — after a definite rejection: p:T is removed and T's candidate dropped, so the
//              previous code is in force again.
//   verify   — a code in v (or the previous code while a candidate is out) is void; the current
//              code is n when set, else h, valid for the code lifetime from nt / t; a match consumes
//              it, the fifth wrong try voids it; consuming or voiding moves h and n to v.
// Times are the injected Clock's epoch milliseconds, passed in by the caller: windows and expiry are
// judged on them, never on Redis TTLs (ADR-0001 §4.2 #10; a FixedClock does not move Redis time).
//
// TTLs: platform/redis passes one TTL as ARGV[1]. The verify script writes only the code key and
// expires it with ARGV[1]. Reserve, commit and release must change both keys atomically (review
// round 1), and the keys live for different times (25 h of history, 300 s of codes): they expire
// the quota key with ARGV[1] and the code key with ARGV[13], the code TTL; every key either script
// writes gets a TTL in the same call.
//
// Failures are platform/redis errors (RedisUnavailableError when Redis cannot answer); the caller
// decides.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import { RedisUnavailableError, type RedisHandle } from '../../platform/index.ts';
import {
  SMS_CODE_LIFETIME_SECONDS,
  SMS_CODE_MAX_ERRORS,
  SMS_PER_NATURAL_DAY,
  SMS_PER_NATURAL_HOUR,
  SMS_PER_ROLLING_WINDOW,
  SMS_RESEND_INTERVAL_MS,
  SMS_ROLLING_WINDOW_MS,
  naturalWindows,
} from '../domain/sms-limits.ts';

const NAMESPACE = 'sms';
/** Longer than the 24-hour rolling window and the natural day; garbage collection only. */
const QUOTA_TTL_SECONDS = 90_000;
/** Most void code HMACs a code record keeps (at most 10 sends a day reach one phone). */
const VOID_LIMIT = 16;

/** Shared Lua: the comma-separated void list. */
const VOID_LIB = `
local function with_void(list, hash)
  local items = {}
  if list and list ~= '' then
    for item in string.gmatch(list, '[^,]+') do items[#items + 1] = item end
  end
  if hash and hash ~= '' then items[#items + 1] = hash end
  while #items > ${String(VOID_LIMIT)} do table.remove(items, 1) end
  return table.concat(items, ',')
end
local function in_void(list, hash)
  if hash == '' or not list or list == '' then return false end
  for item in string.gmatch(list, '[^,]+') do
    if item == hash then return true end
  end
  return false
end
`;

/**
 * Shared Lua of reserve, commit and release. KEYS[1] quota key, KEYS[2] code key. ARGV[1] quota
 * TTL, [2] now, [3] token, [4] hour start, [5] next hour, [6] day start, [7] next day,
 * [8] interval, [9] per hour, [10] per day, [11] per rolling window, [12] window, [13] code TTL,
 * [14] candidate HMAC (reserve), [15] purpose (reserve).
 */
const QUOTA_LIB = `${VOID_LIB}
local key, code_key = KEYS[1], KEYS[2]
local now = tonumber(ARGV[2])
local token = ARGV[3]
local hour_start, next_hour = tonumber(ARGV[4]), tonumber(ARGV[5])
local day_start, next_day = tonumber(ARGV[6]), tonumber(ARGV[7])
local interval = tonumber(ARGV[8])
local per_hour, per_day = tonumber(ARGV[9]), tonumber(ARGV[10])
local per_window, window = tonumber(ARGV[11]), tonumber(ARGV[12])
local code_ttl = ARGV[13]
local wrote = false
-- Accepted and uncommitted sends alike, ascending; entries leave only with the 24-hour window.
local function history()
  local entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
  local times = {}
  for i = 1, #entries, 2 do
    local at = tonumber(entries[i + 1])
    if at <= now - window then
      redis.call('ZREM', key, entries[i])
      wrote = true
    else
      times[#times + 1] = at
    end
  end
  return times
end
local function release_at(times)
  local release = 0
  local n = #times
  if n > 0 and times[n] + interval > now then release = times[n] + interval end
  local in_hour, in_day = 0, 0
  for i = 1, n do
    if times[i] >= hour_start then in_hour = in_hour + 1 end
    if times[i] >= day_start then in_day = in_day + 1 end
  end
  if in_hour >= per_hour and next_hour > release then release = next_hour end
  if in_day >= per_day and next_day > release then release = next_day end
  if n >= per_window then
    local rolling = times[n - per_window + 1] + window
    if rolling > release then release = rolling end
  end
  return release
end
local function touch_quota()
  if wrote and redis.call('EXISTS', key) == 1 then redis.call('EXPIRE', key, ARGV[1]) end
end
`;

/**
 * {0, release ms} limited; {2, 0} the candidate collides with a code of the record; {1, release ms}
 * reserved and candidate stored, with the release this send causes when counted at its
 * reservation time (the caller's fallback when the commit cannot run).
 */
const RESERVE = `${QUOTA_LIB}
local candidate = ARGV[14]
local times = history()
local release = release_at(times)
if release > now then
  touch_quota()
  return {0, release}
end
local r = redis.call('HMGET', code_key, 'h', 't', 'e', 'n', 'nt', 'ne', 'v')
local h, t, e = r[1] or '', r[2] or '0', r[3] or '0'
local n, nt, ne, v = r[4] or '', r[5] or '0', r[6] or '0', r[7] or ''
if candidate == h or candidate == n or in_void(v, candidate) then
  touch_quota()
  return {2, 0}
end
redis.call('ZADD', key, now, 'p:' .. token)
redis.call('EXPIRE', key, ARGV[1])
if n ~= '' then
  -- An earlier send was never committed nor released: it counts as sent, its code is in force.
  v = with_void(v, h)
  h, t, e = n, nt, ne
end
redis.call('HSET', code_key, 'h', h, 't', t, 'e', e, 'n', candidate, 'k', token, 'nt', ARGV[2],
  'ne', '0', 'u', ARGV[15], 'v', v)
redis.call('EXPIRE', code_key, code_ttl)
times[#times + 1] = now
return {1, release_at(times)}
`;

/** Count the send as accepted at now and put its candidate in force; returns the next release. */
const COMMIT = `${QUOTA_LIB}
if not redis.call('ZSCORE', key, 'a:' .. token) then
  redis.call('ZREM', key, 'p:' .. token)
  redis.call('ZADD', key, now, 'a:' .. token)
end
local r = redis.call('HMGET', code_key, 'h', 'n', 'k', 'ne', 'v')
if r[3] == token and r[2] and r[2] ~= '' then
  redis.call('HSET', code_key, 'h', r[2], 't', ARGV[2], 'e', r[4] or '0', 'n', '', 'k', '',
    'nt', '', 'ne', '0', 'v', with_void(r[5] or '', r[1] or ''))
  redis.call('EXPIRE', code_key, code_ttl)
end
local release = release_at(history())
redis.call('EXPIRE', key, ARGV[1])
return release
`;

/** A definite rejection: the reservation counts towards nothing and the candidate is dropped. */
const RELEASE = `${QUOTA_LIB}
redis.call('ZREM', key, 'p:' .. token)
if redis.call('EXISTS', key) == 1 then redis.call('EXPIRE', key, ARGV[1]) end
local r = redis.call('HMGET', code_key, 'h', 'k', 'v')
if r[2] == token then
  if (r[1] or '') == '' and (r[3] or '') == '' then
    redis.call('DEL', code_key)
  else
    redis.call('HSET', code_key, 'n', '', 'k', '', 'nt', '', 'ne', '0')
    redis.call('EXPIRE', code_key, code_ttl)
  end
end
return 1
`;

/**
 * Check and consume: 0 consumed; 2 wrong (counted; the fifth wrong try voids the code); 3 no valid
 * code (none, replaced, consumed, expired by Clock, void, or the previous code while a candidate is
 * out). KEYS[1] code key. ARGV[1] code TTL, [2] code HMAC ('' never matches), [3] now,
 * [4] lifetime ms, [5] max wrong tries.
 */
const VERIFY = `${VOID_LIB}
local key = KEYS[1]
local given = ARGV[2]
local now, lifetime, max_errors = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local r = redis.call('HMGET', key, 'h', 't', 'e', 'n', 'nt', 'ne', 'v')
if not r[1] and not r[4] then return 3 end
local h, n, v = r[1] or '', r[4] or '', r[7] or ''
local function close()
  redis.call('HSET', key, 'h', '', 'e', '0', 'n', '', 'k', '', 'nt', '', 'ne', '0',
    'v', with_void(with_void(v, h), n))
  redis.call('EXPIRE', key, ARGV[1])
end
if in_void(v, given) then return 3 end
local current, issued, errors, counter = h, tonumber(r[2]) or 0, tonumber(r[3]) or 0, 'e'
if n ~= '' then
  -- A candidate is out: it is the current code, and the code it replaces is void.
  if given ~= '' and given == h then return 3 end
  current, issued, errors, counter = n, tonumber(r[5]) or 0, tonumber(r[6]) or 0, 'ne'
end
if current == '' then return 3 end
if now - issued >= lifetime or errors >= max_errors then
  close()
  return 3
end
if given ~= '' and given == current then
  close()
  return 0
end
errors = redis.call('HINCRBY', key, counter, 1)
if errors >= max_errors then
  close()
else
  redis.call('EXPIRE', key, ARGV[1])
end
return 2
`;

/** The two keys of one send: the phone's history and the codes of (app, purpose, phone). */
export interface SmsKeys {
  readonly phoneKey: string;
  /** `<app_id>:<purpose>:<phoneKey>` */
  readonly codeKey: string;
}

export type ReserveOutcome =
  /** `releaseAtMs`: next release if this send counts at its reservation time. */
  | { readonly kind: 'reserved'; readonly releaseAtMs: number }
  | { readonly kind: 'limited'; readonly releaseAtMs: number }
  | { readonly kind: 'collision' };

export type VerifyOutcome = 'consumed' | 'wrong' | 'void';

export interface SmsCodeStore {
  reserve(
    keys: SmsKeys,
    token: string,
    candidateHash: string,
    purpose: string,
    nowMs: number,
  ): Promise<ReserveOutcome>;
  /** Idempotent per token. Returns when the next send of this phone may go (epoch ms). */
  commit(keys: SmsKeys, token: string, nowMs: number): Promise<number>;
  release(keys: SmsKeys, token: string, nowMs: number): Promise<void>;
  verify(codeKey: string, codeHash: string, nowMs: number): Promise<VerifyOutcome>;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RedisUnavailableError('unexpected_reply');
  }
  return value;
}

function sendArgs(token: string, nowMs: number, candidateHash = '', purpose = ''): string[] {
  const windows = naturalWindows(nowMs);
  return [
    String(nowMs),
    token,
    String(windows.hourStartMs),
    String(windows.nextHourMs),
    String(windows.dayStartMs),
    String(windows.nextDayMs),
    String(SMS_RESEND_INTERVAL_MS),
    String(SMS_PER_NATURAL_HOUR),
    String(SMS_PER_NATURAL_DAY),
    String(SMS_PER_ROLLING_WINDOW),
    String(SMS_ROLLING_WINDOW_MS),
    String(SMS_CODE_LIFETIME_SECONDS),
    candidateHash,
    purpose,
  ];
}

const sendKeys = (keys: SmsKeys): string[] => [`q:${keys.phoneKey}`, `c:${keys.codeKey}`];

export function createSmsCodeStore(redis: Pick<RedisHandle, 'namespace'>): SmsCodeStore {
  // Taken per call: a handle closed later rejects there, never while the service is built.
  const eval_ = async (
    script: string,
    keys: readonly string[],
    args: readonly string[],
    ttlSeconds: number,
  ): Promise<unknown> => await redis.namespace(NAMESPACE).eval(script, { keys, args, ttlSeconds });

  return Object.freeze({
    async reserve(
      keys: SmsKeys,
      token: string,
      candidateHash: string,
      purpose: string,
      nowMs: number,
    ): Promise<ReserveOutcome> {
      const reply = await eval_(
        RESERVE,
        sendKeys(keys),
        sendArgs(token, nowMs, candidateHash, purpose),
        QUOTA_TTL_SECONDS,
      );
      if (!Array.isArray(reply) || reply.length !== 2) {
        throw new RedisUnavailableError('unexpected_reply');
      }
      const [state, releaseAtMs] = [integer(reply[0]), integer(reply[1])];
      if (state === 1) return { kind: 'reserved', releaseAtMs };
      if (state === 0) return { kind: 'limited', releaseAtMs };
      if (state === 2) return { kind: 'collision' };
      throw new RedisUnavailableError('unexpected_reply');
    },
    async commit(keys: SmsKeys, token: string, nowMs: number): Promise<number> {
      return integer(
        await eval_(COMMIT, sendKeys(keys), sendArgs(token, nowMs), QUOTA_TTL_SECONDS),
      );
    },
    async release(keys: SmsKeys, token: string, nowMs: number): Promise<void> {
      await eval_(RELEASE, sendKeys(keys), sendArgs(token, nowMs), QUOTA_TTL_SECONDS);
    },
    async verify(codeKey: string, codeHash: string, nowMs: number): Promise<VerifyOutcome> {
      const reply = integer(
        await eval_(
          VERIFY,
          [`c:${codeKey}`],
          [
            codeHash,
            String(nowMs),
            String(SMS_CODE_LIFETIME_SECONDS * 1000),
            String(SMS_CODE_MAX_ERRORS),
          ],
          SMS_CODE_LIFETIME_SECONDS,
        ),
      );
      if (reply === 0) return 'consumed';
      if (reply === 2) return 'wrong';
      if (reply === 3) return 'void';
      throw new RedisUnavailableError('unexpected_reply');
    },
  });
}
