// Redis state of a pending verify-phone change (B1-34i; 08 BR-ID-45, BR-ID-33; contract CT-24o),
// namespace `admin-step-up`, one record per account (`<app>:<admin id>`; the holder's own change
// and a super admin's change on the holder's behalf share it, so either send replaces the other):
//   vp-sent:<app>:<admin>  "<sent at ms>:<reservation id>" — the 60-second send limit by the Clock,
//                          taken atomically before the SMS goes out and released only when the
//                          provider definitely rejected it (apart from the sms step-up tier's own
//                          limit, which keeps serving the current phone during a change);
//   vp-code:<app>:<admin>  JSON {phone, hash, exp, wrong} — the pending change: the new phone's
//                          blind index (never the phone), the code's keyed hash (never the code),
//                          its expiry by the Clock and the wrong tries so far;
//   vp-hist:<app>:<admin>  JSON [{hash, at}] — every code sent in the last 24 hours by the Clock
//                          (oldest dropped beyond the keep limit), so a replaced, used or voided
//                          code answers `gone` rather than a counted `wrong`.
// Expiry and the 24-hour window are judged by the Clock (ARGV); the Redis TTL (ARGV[1]) only
// cleans up. The record is written before the SMS goes out (repo hard rule 3); a definite rejection
// then `revoke`s it.
// Verification is one script: the live pending code for this phone → `ok` and the record goes (the
// code stays in the history); a code in the history → `gone`; a different code while a live code
// for this phone is pending → `wrong` (the `max`-th wrong try voids the pending code); anything
// else (nothing pending, another phone, expired) → `gone`.
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import { randomUUID } from 'node:crypto';
import type { RedisNamespace } from '../../platform/index.ts';
import {
  STEP_UP_CLEANUP_MARGIN_SEC,
  STEP_UP_SMS_HISTORY_KEEP,
  STEP_UP_SMS_HISTORY_MS,
} from '../domain/step-up-policy.ts';
import type { ReserveOutcome } from './step-up-sms-codes.ts';

export type VerifyPhoneCodeCheck = 'ok' | 'wrong' | 'gone';

export interface VerifyPhoneCodes {
  /** Hashes of the pending code and the history (to draw a code that differs from them). */
  knownHashes(appId: string, adminId: string): Promise<ReadonlySet<string>>;
  /** Take the send slot unless the last send was less than `intervalMs` ago. */
  reserve(
    appId: string,
    adminId: string,
    nowMs: number,
    intervalMs: number,
  ): Promise<ReserveOutcome>;
  /** Give the slot back (nothing was sent). */
  release(appId: string, adminId: string, reservation: string): Promise<void>;
  /** Make (`phone`, `hash`) the pending change until `expiresAtMs`; the earlier one is void. */
  store(
    appId: string,
    adminId: string,
    pending: { readonly phone: string; readonly hash: string },
    nowMs: number,
    expiresAtMs: number,
  ): Promise<void>;
  /** Withdraw a stored code that was never delivered. */
  revoke(appId: string, adminId: string, hash: string, nowMs: number): Promise<void>;
  /** Check (and on success consume) a submitted phone's blind index and code hash. */
  check(
    appId: string,
    adminId: string,
    submitted: { readonly phone: string; readonly hash: string },
    nowMs: number,
    maxWrong: number,
  ): Promise<VerifyPhoneCodeCheck>;
}

const RESERVE_SCRIPT = `local v = redis.call('GET', KEYS[1])
if v then
  local at = tonumber(string.match(v, '^(%d+):'))
  if at and tonumber(ARGV[2]) - at < tonumber(ARGV[3]) then return at end
end
redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[1])
return -1`;

const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[2] then return redis.call('DEL', KEYS[1]) end
return 0`;

// Shared Lua over KEYS[1] (pending change) and KEYS[2] (history); ARGV[1] is the cleanup TTL and
// ARGV[2] the Clock's now. A broken value holds no code.
const RECORD_LUA = `local now = tonumber(ARGV[2])
local function current()
  local raw = redis.call('GET', KEYS[1])
  if not raw then return nil end
  local ok, cur = pcall(cjson.decode, raw)
  if not ok or type(cur) ~= 'table' or type(cur.hash) ~= 'string' or type(cur.phone) ~= 'string'
    or not tonumber(cur.exp) then
    return nil
  end
  return cur
end
local function history()
  local kept = {}
  local raw = redis.call('GET', KEYS[2])
  if not raw then return kept end
  local ok, list = pcall(cjson.decode, raw)
  if not ok or type(list) ~= 'table' then return kept end
  for _, v in ipairs(list) do
    if type(v) == 'table' and type(v.hash) == 'string' and tonumber(v.at)
      and now - tonumber(v.at) < ${String(STEP_UP_SMS_HISTORY_MS)} then
      table.insert(kept, {hash = v.hash, at = tonumber(v.at)})
    end
  end
  return kept
end
local function save_history(list)
  while #list > ${String(STEP_UP_SMS_HISTORY_KEEP)} do table.remove(list, 1) end
  if #list == 0 then
    redis.call('DEL', KEYS[2])
  else
    redis.call('SET', KEYS[2], cjson.encode(list), 'EX', ARGV[1])
  end
end
local function in_history(list, hash)
  for _, v in ipairs(list) do
    if v.hash == hash then return true end
  end
  return false
end
`;

const STORE_SCRIPT = `${RECORD_LUA}
local list = history()
table.insert(list, {hash = ARGV[4], at = now})
save_history(list)
redis.call('SET', KEYS[1],
  cjson.encode({phone = ARGV[3], hash = ARGV[4], exp = tonumber(ARGV[5]), wrong = 0}),
  'EX', ARGV[1])
return 1`;

const REVOKE_SCRIPT = `${RECORD_LUA}
local cur = current()
if cur ~= nil and cur.hash == ARGV[3] then redis.call('DEL', KEYS[1]) end
local kept = {}
for _, v in ipairs(history()) do
  if v.hash ~= ARGV[3] then table.insert(kept, v) end
end
save_history(kept)
return 1`;

const CHECK_SCRIPT = `${RECORD_LUA}
local cur = current()
local live = cur ~= nil and tonumber(cur.exp) > now and cur.phone == ARGV[3]
if live and cur.hash == ARGV[4] then
  redis.call('DEL', KEYS[1])
  local list = history()
  if not in_history(list, cur.hash) then
    table.insert(list, {hash = cur.hash, at = now})
    save_history(list)
  end
  return 'ok'
end
if in_history(history(), ARGV[4]) then return 'gone' end
if live then
  local wrong = (tonumber(cur.wrong) or 0) + 1
  if wrong >= tonumber(ARGV[5]) then
    redis.call('DEL', KEYS[1])
  else
    redis.call('SET', KEYS[1],
      cjson.encode({phone = cur.phone, hash = cur.hash, exp = tonumber(cur.exp), wrong = wrong}),
      'EX', ARGV[1])
  end
  return 'wrong'
end
return 'gone'`;

const sentKey = (appId: string, adminId: string): string => `vp-sent:${appId}:${adminId}`;
const codeKey = (appId: string, adminId: string): string => `vp-code:${appId}:${adminId}`;
const historyKey = (appId: string, adminId: string): string => `vp-hist:${appId}:${adminId}`;
const CHECKS: ReadonlySet<unknown> = new Set(['ok', 'wrong', 'gone']);

function hashesOf(current: unknown, history: unknown): Set<string> {
  const hashes = new Set<string>();
  try {
    if (typeof current === 'string') {
      const record = JSON.parse(current) as { hash?: unknown } | null;
      if (typeof record?.hash === 'string') hashes.add(record.hash);
    }
  } catch {
    // A record that does not parse holds no code.
  }
  try {
    if (typeof history === 'string') {
      const list = JSON.parse(history) as unknown;
      if (Array.isArray(list)) {
        for (const entry of list as ({ hash?: unknown } | null)[]) {
          if (typeof entry?.hash === 'string') hashes.add(entry.hash);
        }
      }
    }
  } catch {
    // A history that does not parse holds no code.
  }
  return hashes;
}

export function createVerifyPhoneCodes(deps: { readonly redis: RedisNamespace }): VerifyPhoneCodes {
  const { redis } = deps;
  const ttlUntil = (untilMs: number, nowMs: number): number =>
    Math.max(1, Math.ceil((untilMs - nowMs) / 1000)) + STEP_UP_CLEANUP_MARGIN_SEC;
  const recordTtl = ttlUntil(STEP_UP_SMS_HISTORY_MS, 0);
  const keysOf = (appId: string, adminId: string): string[] => [
    codeKey(appId, adminId),
    historyKey(appId, adminId),
  ];
  return {
    async knownHashes(appId, adminId) {
      const [current, history] = await Promise.all([
        redis.get(codeKey(appId, adminId)),
        redis.get(historyKey(appId, adminId)),
      ]);
      return hashesOf(current, history);
    },

    async reserve(appId, adminId, nowMs, intervalMs) {
      const reservation = `${String(nowMs)}:${randomUUID()}`;
      const reply = await redis.eval(RESERVE_SCRIPT, {
        keys: [sentKey(appId, adminId)],
        args: [String(nowMs), String(intervalMs), reservation],
        ttlSeconds: ttlUntil(nowMs + intervalMs, nowMs),
      });
      const at = Number(reply);
      if (!Number.isSafeInteger(at))
        throw new Error('admin verify phone: unexpected reserve reply');
      if (at < 0) return { kind: 'reserved', reservation };
      return { kind: 'limited', retryAfterMs: at + intervalMs - nowMs };
    },

    async release(appId, adminId, reservation) {
      await redis.eval(RELEASE_SCRIPT, {
        keys: [sentKey(appId, adminId)],
        args: [reservation],
        ttlSeconds: 1,
      });
    },

    async store(appId, adminId, pending, nowMs, expiresAtMs) {
      await redis.eval(STORE_SCRIPT, {
        keys: keysOf(appId, adminId),
        args: [String(nowMs), pending.phone, pending.hash, String(expiresAtMs)],
        ttlSeconds: recordTtl,
      });
    },

    async revoke(appId, adminId, hash, nowMs) {
      await redis.eval(REVOKE_SCRIPT, {
        keys: keysOf(appId, adminId),
        args: [String(nowMs), hash],
        ttlSeconds: recordTtl,
      });
    },

    async check(appId, adminId, submitted, nowMs, maxWrong) {
      const reply = await redis.eval(CHECK_SCRIPT, {
        keys: keysOf(appId, adminId),
        args: [String(nowMs), submitted.phone, submitted.hash, String(maxWrong)],
        ttlSeconds: recordTtl,
      });
      if (!CHECKS.has(reply)) throw new Error('admin verify phone: unexpected code check reply');
      return reply as VerifyPhoneCodeCheck;
    },
  };
}
