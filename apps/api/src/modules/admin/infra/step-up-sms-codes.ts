// Redis state of the sms step-up tier (F1-06l; 08 BR-ID-34 短信档; ruling §9.2 #3, #4, §9.3 #4),
// namespace `admin-step-up`, per account (`<app>:<admin id>`, so every session of the account
// shares it):
//   sms-sent:<app>:<admin>  "<sent at ms>:<reservation id>" — the 60-second send limit by the
//                           Clock, taken atomically before the SMS goes out and released only when
//                           the provider definitely rejected it;
//   sms-code:<app>:<admin>  JSON {hash, exp} — the current code (the latest one sent and not yet
//                           used) with its expiry by the Clock;
//   sms-hist:<app>:<admin>  JSON [{hash, at}] — every code sent in the last 24 hours by the Clock
//                           (send time `at`; at most STEP_UP_SMS_HISTORY_KEEP, oldest dropped),
//                           kept apart from the current code so it outlives that record (ruling
//                           round 3 #1).
// Only keyed hashes (the field cipher's blind index) are stored, never a code. Expiry and the
// 24-hour window are judged by the Clock (ARGV); the Redis TTL (ARGV[1], at least 24 hours) only
// cleans up.
// Sending writes the record before the SMS goes out (repo hard rule 3: the record first): `store`
// makes the new code current (the previous one is no longer current) and adds it to the history;
// a definite rejection then `revoke`s the new code from both (ruling round 2 #1).
// Verification is one script: the current unexpired code → `ok` and it stops being current (a code
// serves one token; it stays in the history); any other code in the 24-hour history (replaced,
// used or expired) → `voided`; the expired current code outside the history → `expired`;
// anything else → `wrong` while a current unexpired code exists, else `none`. Only `wrong` counts
// as a failure (ruling round 2 #2, round 3 #1).
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import { randomUUID } from 'node:crypto';
import type { RedisNamespace } from '../../platform/index.ts';
import {
  STEP_UP_CLEANUP_MARGIN_SEC,
  STEP_UP_SMS_HISTORY_KEEP,
  STEP_UP_SMS_HISTORY_MS,
} from '../domain/step-up-policy.ts';

export type ReserveOutcome =
  | { readonly kind: 'reserved'; readonly reservation: string }
  | { readonly kind: 'limited'; readonly retryAfterMs: number };

export type CodeCheck = 'ok' | 'wrong' | 'voided' | 'expired' | 'none';

export interface StepUpSmsCodes {
  /** Hashes of the current code and the history (to draw a code that differs from them). */
  knownHashes(appId: string, adminId: string): Promise<ReadonlySet<string>>;
  /** Take the send slot unless the last send was less than `intervalMs` ago. */
  reserve(
    appId: string,
    adminId: string,
    nowMs: number,
    intervalMs: number,
  ): Promise<ReserveOutcome>;
  /** Give the slot back (the provider definitely rejected the SMS). */
  release(appId: string, adminId: string, reservation: string): Promise<void>;
  /** Make `hash` the current code until `expiresAtMs` and add it to the 24-hour history. */
  store(
    appId: string,
    adminId: string,
    hash: string,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<void>;
  /** Withdraw a stored code that was never delivered (the provider definitely rejected it). */
  revoke(appId: string, adminId: string, hash: string, nowMs: number): Promise<void>;
  /** Check (and on success consume) a submitted code's hash. */
  check(appId: string, adminId: string, hash: string, nowMs: number): Promise<CodeCheck>;
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

// Shared Lua over KEYS[1] (current code) and KEYS[2] (history); ARGV[1] is the cleanup TTL and
// ARGV[2] the Clock's now. A broken value holds no code. The history is cut to the 24-hour window
// by the Clock and to the newest KEEP entries, and deleted when empty.
const RECORD_LUA = `local now = tonumber(ARGV[2])
local function current()
  local raw = redis.call('GET', KEYS[1])
  if not raw then return nil end
  local ok, cur = pcall(cjson.decode, raw)
  if not ok or type(cur) ~= 'table' or type(cur.hash) ~= 'string' or not tonumber(cur.exp) then
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
table.insert(list, {hash = ARGV[3], at = now})
save_history(list)
redis.call('SET', KEYS[1], cjson.encode({hash = ARGV[3], exp = tonumber(ARGV[4])}), 'EX', ARGV[1])
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
local live = cur ~= nil and tonumber(cur.exp) > now
if live and cur.hash == ARGV[3] then
  redis.call('DEL', KEYS[1])
  local list = history()
  if not in_history(list, cur.hash) then
    table.insert(list, {hash = cur.hash, at = now})
    save_history(list)
  end
  return 'ok'
end
if in_history(history(), ARGV[3]) then return 'voided' end
if cur ~= nil and cur.hash == ARGV[3] then return 'expired' end
if live then return 'wrong' end
return 'none'`;

const sentKey = (appId: string, adminId: string): string => `sms-sent:${appId}:${adminId}`;
const codeKey = (appId: string, adminId: string): string => `sms-code:${appId}:${adminId}`;
const historyKey = (appId: string, adminId: string): string => `sms-hist:${appId}:${adminId}`;
const CHECKS: ReadonlySet<unknown> = new Set(['ok', 'wrong', 'voided', 'expired', 'none']);

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

export function createStepUpSmsCodes(deps: { readonly redis: RedisNamespace }): StepUpSmsCodes {
  const { redis } = deps;
  const ttlUntil = (untilMs: number, nowMs: number): number =>
    Math.max(1, Math.ceil((untilMs - nowMs) / 1000)) + STEP_UP_CLEANUP_MARGIN_SEC;
  // Cleanup lifetime of the code and history keys: the 24-hour window plus the margin (the
  // window itself is judged by the Clock).
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
      if (!Number.isSafeInteger(at)) throw new Error('admin step-up: unexpected reserve reply');
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

    async store(appId, adminId, hash, nowMs, expiresAtMs) {
      await redis.eval(STORE_SCRIPT, {
        keys: keysOf(appId, adminId),
        args: [String(nowMs), hash, String(expiresAtMs)],
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

    async check(appId, adminId, hash, nowMs) {
      const reply = await redis.eval(CHECK_SCRIPT, {
        keys: keysOf(appId, adminId),
        args: [String(nowMs), hash],
        ttlSeconds: recordTtl,
      });
      if (!CHECKS.has(reply)) throw new Error('admin step-up: unexpected code check reply');
      return reply as CodeCheck;
    },
  };
}
