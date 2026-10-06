// Redis store of the SMS codes and of the per-phone send quota (BR-ID-05; orchestrator ruling B1-02e
// §9.3 #2–#4: Redis, no table; every key carries a TTL; reserve → confirm after acceptance / release
// after a definite rejection, each one atomic Lua call).
//
// Namespace `sms` (platform/redis prefixes every key with `sms:`). Keys hold no phone number and
// no code in clear: the caller passes `phoneKey`, an HMAC of the normalised number, and the code's
// HMAC.
//   q:<phoneKey>                    sorted set, the send history of one phone over every app and
//                                   purpose: member `a:<token>` scored with the acceptance time of
//                                   an accepted (or outcome unknown) SMS, member `p:<token>` scored
//                                   with the time of a reservation still waiting for the provider.
//                                   TTL 25 h, refreshed on every write (garbage collection only).
//   c:<app_id>:<purpose>:<phoneKey> hash { h: HMAC of the valid code ('' when there is none),
//                                   e: wrong tries, t: issued at (ms), u: purpose, v: comma-separated
//                                   HMACs of the codes of this key that were replaced, consumed or
//                                   voided (newest last, at most VOID_LIMIT) }. TTL 300 s, refreshed
//                                   on every write (garbage collection only).
// A submitted code found in `v` answers «void» (20003, BR-ID-05: a replaced or consumed code is
// void, not wrong) and is not counted as a wrong try. HMACs are hex, so `,` never occurs in one.
// Times are the injected Clock's epoch milliseconds, passed in by the caller: windows and expiry are
// judged on them, never on Redis TTLs (ADR-0001 §4.2 #10; a FixedClock does not move Redis time).
// A pending reservation counts towards every limit (so concurrent requests for one phone cannot
// both pass) and expires by Clock after RESERVATION_LEASE_MS; its Retry-After is then that of the
// 60-second window (ruling §9.5 #5).
//
// Every script expires each key it writes with ARGV[1], the TTL platform/redis passes; the
// caller's arguments start at ARGV[2]. Failures are platform/redis errors (RedisUnavailableError
// when Redis cannot answer); the caller decides.
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
/** How long a reservation may wait for the provider before it stops counting (by Clock). */
const RESERVATION_LEASE_MS = SMS_RESEND_INTERVAL_MS;

/**
 * Shared Lua: prune the history by Clock and compute the release time of the limits.
 * ARGV[2] now, [3] token, [4] hour start, [5] next hour, [6] day start, [7] next day,
 * [8] lease, [9] interval, [10] per hour, [11] per day, [12] per rolling window, [13] window.
 */
const QUOTA_LIB = `
local key = KEYS[1]
local now = tonumber(ARGV[2])
local token = ARGV[3]
local hour_start, next_hour = tonumber(ARGV[4]), tonumber(ARGV[5])
local day_start, next_day = tonumber(ARGV[6]), tonumber(ARGV[7])
local lease, interval = tonumber(ARGV[8]), tonumber(ARGV[9])
local per_hour, per_day = tonumber(ARGV[10]), tonumber(ARGV[11])
local per_window, window = tonumber(ARGV[12]), tonumber(ARGV[13])
local wrote = false
local function history()
  local entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
  local times = {}
  for i = 1, #entries, 2 do
    local member, at = entries[i], tonumber(entries[i + 1])
    local pending = string.sub(member, 1, 2) == 'p:'
    if (pending and at <= now - lease) or ((not pending) and at <= now - window) then
      redis.call('ZREM', key, member)
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
`;

/** Reserve one send: {1, 0} when reserved, {0, release ms} when a limit (or a reservation) holds. */
const RESERVE = `${QUOTA_LIB}
local release = release_at(history())
if release > now then
  if wrote and redis.call('EXISTS', key) == 1 then redis.call('EXPIRE', key, ARGV[1]) end
  return {0, release}
end
redis.call('ZADD', key, now, 'p:' .. token)
redis.call('EXPIRE', key, ARGV[1])
return {1, 0}
`;

/** Count the reserved send as accepted at `now`; returns when the next send may go (ms). */
const CONFIRM = `${QUOTA_LIB}
redis.call('ZREM', key, 'p:' .. token)
redis.call('ZADD', key, now, 'a:' .. token)
local release = release_at(history())
redis.call('EXPIRE', key, ARGV[1])
return release
`;

/** Drop the reservation of a definitely rejected send: it counts towards nothing. */
const RELEASE = `
redis.call('ZREM', KEYS[1], 'p:' .. ARGV[2])
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return 1
`;

/** Most void code HMACs a code record keeps (at most 10 sends a day reach one phone). */
const VOID_LIMIT = 16;

/** Shared Lua: append an HMAC to the comma-separated void list, keeping the newest entries. */
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
`;

/**
 * Replace the code of the key: the previous code of the same app, phone and purpose becomes void.
 * ARGV[2] code HMAC, [3] issued at (ms), [4] purpose.
 */
const STORE_CODE = `${VOID_LIB}
local key = KEYS[1]
local previous = redis.call('HMGET', key, 'h', 'v')
local void = with_void(previous[2], previous[1])
redis.call('DEL', key)
redis.call('HSET', key, 'h', ARGV[2], 'e', '0', 't', ARGV[3], 'u', ARGV[4], 'v', void)
redis.call('EXPIRE', key, ARGV[1])
return 1
`;

/**
 * Check and consume: 0 consumed; 2 wrong (counted; the fifth wrong try voids the code);
 * 3 no valid code (none, replaced, consumed, expired by Clock, or void). A consumed, expired or
 * voided code stays in the void list. ARGV[2] code HMAC ('' never matches), [3] now,
 * [4] lifetime ms, [5] max wrong tries.
 */
const VERIFY = `${VOID_LIB}
local key = KEYS[1]
local given = ARGV[2]
local stored = redis.call('HMGET', key, 'h', 'e', 't', 'v')
local current = stored[1]
if not current then return 3 end
local function void_current()
  redis.call('HSET', key, 'h', '', 'v', with_void(stored[4], current))
  redis.call('EXPIRE', key, ARGV[1])
end
if given ~= '' and stored[4] then
  for item in string.gmatch(stored[4], '[^,]+') do
    if item == given then return 3 end
  end
end
if current == '' then return 3 end
local errors = tonumber(stored[2]) or 0
local issued = tonumber(stored[3]) or 0
local now, lifetime, max_errors = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
if now - issued >= lifetime or errors >= max_errors then
  void_current()
  return 3
end
if given ~= '' and current == given then
  void_current()
  return 0
end
errors = redis.call('HINCRBY', key, 'e', 1)
if errors >= max_errors then
  void_current()
else
  redis.call('EXPIRE', key, ARGV[1])
end
return 2
`;

export type ReserveOutcome =
  { readonly reserved: true } | { readonly reserved: false; readonly releaseAtMs: number };

export type VerifyOutcome = 'consumed' | 'wrong' | 'void';

export interface SmsCodeStore {
  reserve(phoneKey: string, token: string, nowMs: number): Promise<ReserveOutcome>;
  /** Returns when the next send of this phone may go (epoch ms). */
  confirm(phoneKey: string, token: string, nowMs: number): Promise<number>;
  release(phoneKey: string, token: string): Promise<void>;
  storeCode(codeKey: string, codeHash: string, purpose: string, issuedAtMs: number): Promise<void>;
  verify(codeKey: string, codeHash: string, nowMs: number): Promise<VerifyOutcome>;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RedisUnavailableError('unexpected_reply');
  }
  return value;
}

function quotaArgs(token: string, nowMs: number): string[] {
  const windows = naturalWindows(nowMs);
  return [
    String(nowMs),
    token,
    String(windows.hourStartMs),
    String(windows.nextHourMs),
    String(windows.dayStartMs),
    String(windows.nextDayMs),
    String(RESERVATION_LEASE_MS),
    String(SMS_RESEND_INTERVAL_MS),
    String(SMS_PER_NATURAL_HOUR),
    String(SMS_PER_NATURAL_DAY),
    String(SMS_PER_ROLLING_WINDOW),
    String(SMS_ROLLING_WINDOW_MS),
  ];
}

export function createSmsCodeStore(redis: Pick<RedisHandle, 'namespace'>): SmsCodeStore {
  // Taken per call: a handle closed later rejects there, never while the service is built.
  const eval_ = async (
    script: string,
    keys: readonly string[],
    args: readonly string[],
    ttlSeconds: number,
  ): Promise<unknown> => await redis.namespace(NAMESPACE).eval(script, { keys, args, ttlSeconds });

  return Object.freeze({
    async reserve(phoneKey: string, token: string, nowMs: number): Promise<ReserveOutcome> {
      const reply = await eval_(
        RESERVE,
        [`q:${phoneKey}`],
        quotaArgs(token, nowMs),
        QUOTA_TTL_SECONDS,
      );
      if (!Array.isArray(reply) || reply.length !== 2) {
        throw new RedisUnavailableError('unexpected_reply');
      }
      const [reserved, releaseAtMs] = [integer(reply[0]), integer(reply[1])];
      if (reserved === 1) return { reserved: true };
      if (reserved !== 0) throw new RedisUnavailableError('unexpected_reply');
      return { reserved: false, releaseAtMs };
    },
    async confirm(phoneKey: string, token: string, nowMs: number): Promise<number> {
      return integer(
        await eval_(CONFIRM, [`q:${phoneKey}`], quotaArgs(token, nowMs), QUOTA_TTL_SECONDS),
      );
    },
    async release(phoneKey: string, token: string): Promise<void> {
      await eval_(RELEASE, [`q:${phoneKey}`], [token], QUOTA_TTL_SECONDS);
    },
    async storeCode(
      codeKey: string,
      codeHash: string,
      purpose: string,
      issuedAtMs: number,
    ): Promise<void> {
      await eval_(
        STORE_CODE,
        [`c:${codeKey}`],
        [codeHash, String(issuedAtMs), purpose],
        SMS_CODE_LIFETIME_SECONDS,
      );
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
