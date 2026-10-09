// Redis state of the sms step-up tier (F1-06l; 08 BR-ID-34 短信档; ruling §9.2 #3, #4, §9.3 #4),
// namespace `admin-step-up`, per account (`<app>:<admin id>`, so every session of the account
// shares it):
//   sms-sent:<app>:<admin>  "<sent at ms>:<reservation id>" — the 60-second send limit by the
//                           Clock, taken atomically before the SMS goes out and released only when
//                           the provider definitely rejected it;
//   sms:<app>:<admin>       JSON {current: {hash, exp}, voided: [{hash, exp}]} — the latest code
//                           sent (its keyed hash and expiry by the Clock) and the still-unexpired
//                           codes it replaced. Only keyed hashes (the field cipher's blind index)
//                           are stored, never a code.
// Verification is one script: no current unexpired code → `none`; the current code → `ok` and the
// record goes (a code serves one token); a replaced code → `voided`; anything else → `wrong` (the
// current code stays valid).
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import { randomUUID } from 'node:crypto';
import type { RedisNamespace } from '../../platform/index.ts';
import { STEP_UP_CLEANUP_MARGIN_SEC } from '../domain/step-up-policy.ts';

export type ReserveOutcome =
  | { readonly kind: 'reserved'; readonly reservation: string }
  | { readonly kind: 'limited'; readonly retryAfterMs: number };

export type CodeCheck = 'ok' | 'wrong' | 'voided' | 'none';

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

const STORE_SCRIPT = `local now = tonumber(ARGV[2])
local voided = {}
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, rec = pcall(cjson.decode, raw)
  if ok and type(rec) == 'table' then
    if type(rec.voided) == 'table' then
      for _, v in ipairs(rec.voided) do
        if type(v) == 'table' and tonumber(v.exp) and tonumber(v.exp) > now then
          table.insert(voided, {hash = v.hash, exp = v.exp})
        end
      end
    end
    local cur = rec.current
    if type(cur) == 'table' and tonumber(cur.exp) and tonumber(cur.exp) > now then
      table.insert(voided, {hash = cur.hash, exp = cur.exp})
    end
  end
end
local record = {current = {hash = ARGV[3], exp = ARGV[4]}}
if #voided > 0 then record.voided = voided end
redis.call('SET', KEYS[1], cjson.encode(record), 'EX', ARGV[1])
return 1`;

const CHECK_SCRIPT = `local raw = redis.call('GET', KEYS[1])
if not raw then return 'none' end
local ok, rec = pcall(cjson.decode, raw)
if not ok or type(rec) ~= 'table' then return 'none' end
local now = tonumber(ARGV[2])
local cur = rec.current
if type(cur) ~= 'table' or not tonumber(cur.exp) or tonumber(cur.exp) <= now then return 'none' end
if cur.hash == ARGV[3] then
  redis.call('DEL', KEYS[1])
  return 'ok'
end
if type(rec.voided) == 'table' then
  for _, v in ipairs(rec.voided) do
    if type(v) == 'table' and v.hash == ARGV[3] and tonumber(v.exp) and tonumber(v.exp) > now then
      return 'voided'
    end
  end
end
return 'wrong'`;

const sentKey = (appId: string, adminId: string): string => `sms-sent:${appId}:${adminId}`;
const codeKey = (appId: string, adminId: string): string => `sms:${appId}:${adminId}`;
const CHECKS: ReadonlySet<unknown> = new Set(['ok', 'wrong', 'voided', 'none']);

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

    async check(appId, adminId, hash, nowMs) {
      const reply = await redis.eval(CHECK_SCRIPT, {
        keys: [codeKey(appId, adminId)],
        args: [String(nowMs), hash],
        ttlSeconds: 1,
      });
      if (!CHECKS.has(reply)) throw new Error('admin step-up: unexpected code check reply');
      return reply as CodeCheck;
    },
  };
}
