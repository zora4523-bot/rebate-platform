// Redis state of the sms step-up tier (F1-06l; 08 BR-ID-34 短信档; ruling §9.2 #3, #4, §9.3 #4),
// namespace `admin-step-up`, per account (`<app>:<admin id>`, so every session of the account
// shares it):
//   sms-sent:<app>:<admin>  "<sent at ms>:<reservation id>" — the 60-second send limit by the
//                           Clock, taken atomically before the SMS goes out and released only when
//                           the provider definitely rejected it;
//   sms:<app>:<admin>       JSON {current?: {hash, exp}, voided: [{hash, exp}]} — the latest code
//                           sent (its keyed hash and expiry by the Clock) and the codes it replaced
//                           or that were used (the most recent VOIDED_KEEP). Only keyed hashes
//                           (the field cipher's blind index) are stored, never a code.
// Sending writes the record before the SMS goes out (repo hard rule 3: the record first): `store`
// makes the new code current and voids the previous one; a definite rejection then `revoke`s the
// new code (ruling round 2 #1).
// Verification is one script: the current unexpired code → `ok` and it moves to the voided list (a
// code serves one token); a replaced or used code → `voided`; the expired current code →
// `expired`; anything else → `wrong` while a current unexpired code exists, else `none`. Only
// `wrong` counts as a failure (ruling round 2 #2).
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import { randomUUID } from 'node:crypto';
import type { RedisNamespace } from '../../platform/index.ts';
import { STEP_UP_CLEANUP_MARGIN_SEC, STEP_UP_SMS_CODE_TTL_MS } from '../domain/step-up-policy.ts';

export type ReserveOutcome =
  | { readonly kind: 'reserved'; readonly reservation: string }
  | { readonly kind: 'limited'; readonly retryAfterMs: number };

export type CodeCheck = 'ok' | 'wrong' | 'voided' | 'expired' | 'none';

export interface StepUpSmsCodes {
  /** Hashes of the current and replaced codes (to draw a code that differs from them). */
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
  /** Make `hash` the current code until `expiresAtMs`; the previous code becomes voided. */
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

/** Replaced and used codes remembered per account (a submitted one answers 20003, not 20002). */
export const VOIDED_KEEP = 32;

// Shared Lua: decode the record (a broken one holds no code), keep the voided list bounded, and
// write it back with the remaining lifetime capped by ARGV[1] (or delete it when it holds nothing).
const RECORD_LUA = `local function load()
  local raw = redis.call('GET', KEYS[1])
  if not raw then return nil, {} end
  local ok, rec = pcall(cjson.decode, raw)
  if not ok or type(rec) ~= 'table' then return nil, {} end
  local voided = {}
  if type(rec.voided) == 'table' then
    for _, v in ipairs(rec.voided) do
      if type(v) == 'table' and type(v.hash) == 'string' then
        table.insert(voided, {hash = v.hash, exp = v.exp})
      end
    end
  end
  local cur = rec.current
  if type(cur) ~= 'table' or type(cur.hash) ~= 'string' or not tonumber(cur.exp) then cur = nil end
  return cur, voided
end
local function save(cur, voided, ttl)
  while #voided > ${String(VOIDED_KEEP)} do table.remove(voided, 1) end
  if cur == nil and #voided == 0 then
    redis.call('DEL', KEYS[1])
    return
  end
  local record = {}
  if cur ~= nil then record.current = cur end
  if #voided > 0 then record.voided = voided end
  redis.call('SET', KEYS[1], cjson.encode(record), 'EX', ttl)
end
local function remaining()
  local left = redis.call('TTL', KEYS[1])
  local cap = tonumber(ARGV[1])
  if left == nil or left < 1 or left > cap then return cap end
  return left
end
`;

const STORE_SCRIPT = `${RECORD_LUA}
local cur, voided = load()
if cur ~= nil then table.insert(voided, cur) end
save({hash = ARGV[3], exp = ARGV[4]}, voided, ARGV[1])
return 1`;

const REVOKE_SCRIPT = `${RECORD_LUA}
local cur, voided = load()
if cur ~= nil and cur.hash == ARGV[3] then cur = nil end
local kept = {}
for _, v in ipairs(voided) do
  if v.hash ~= ARGV[3] then table.insert(kept, v) end
end
save(cur, kept, remaining())
return 1`;

const CHECK_SCRIPT = `${RECORD_LUA}
local cur, voided = load()
local now = tonumber(ARGV[2])
local live = cur ~= nil and tonumber(cur.exp) > now
if live and cur.hash == ARGV[3] then
  table.insert(voided, cur)
  save(nil, voided, remaining())
  return 'ok'
end
for _, v in ipairs(voided) do
  if v.hash == ARGV[3] then return 'voided' end
end
if cur ~= nil and cur.hash == ARGV[3] then return 'expired' end
if live then return 'wrong' end
return 'none'`;

const sentKey = (appId: string, adminId: string): string => `sms-sent:${appId}:${adminId}`;
const codeKey = (appId: string, adminId: string): string => `sms:${appId}:${adminId}`;
const CHECKS: ReadonlySet<unknown> = new Set(['ok', 'wrong', 'voided', 'expired', 'none']);

function hashesOf(value: unknown): Set<string> {
  const hashes = new Set<string>();
  if (typeof value !== 'string') return hashes;
  try {
    const record = JSON.parse(value) as {
      current?: { hash?: unknown };
      voided?: unknown;
    };
    if (typeof record.current?.hash === 'string') hashes.add(record.current.hash);
    if (Array.isArray(record.voided)) {
      for (const entry of record.voided as { hash?: unknown }[]) {
        if (typeof entry?.hash === 'string') hashes.add(entry.hash);
      }
    }
  } catch {
    // A record that does not parse holds no code.
  }
  return hashes;
}

export function createStepUpSmsCodes(deps: { readonly redis: RedisNamespace }): StepUpSmsCodes {
  const { redis } = deps;
  const ttlUntil = (untilMs: number, nowMs: number): number =>
    Math.max(1, Math.ceil((untilMs - nowMs) / 1000)) + STEP_UP_CLEANUP_MARGIN_SEC;
  // Upper bound of a record's remaining lifetime (revoke and check keep the remaining one).
  const recordTtl = ttlUntil(STEP_UP_SMS_CODE_TTL_MS, 0);
  return {
    async knownHashes(appId, adminId) {
      return hashesOf(await redis.get(codeKey(appId, adminId)));
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
        keys: [codeKey(appId, adminId)],
        args: [String(nowMs), hash, String(expiresAtMs)],
        ttlSeconds: ttlUntil(expiresAtMs, nowMs),
      });
    },

    async revoke(appId, adminId, hash, nowMs) {
      await redis.eval(REVOKE_SCRIPT, {
        keys: [codeKey(appId, adminId)],
        args: [String(nowMs), hash],
        ttlSeconds: recordTtl,
      });
    },

    async check(appId, adminId, hash, nowMs) {
      const reply = await redis.eval(CHECK_SCRIPT, {
        keys: [codeKey(appId, adminId)],
        args: [String(nowMs), hash],
        ttlSeconds: recordTtl,
      });
      if (!CHECKS.has(reply)) throw new Error('admin step-up: unexpected code check reply');
      return reply as CodeCheck;
    },
  };
}
