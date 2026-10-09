// SMS send risk (task B1-03g; 规划/08 BR-ID-05 and its 细则「发码与设备注册的风控默认值」). identity
// calls these ports from its SMS code service (deviceQuota, afterAccepted) and its account creation
// core (afterRegistered); app.module assembles them through ../index.ts.
//
// admit() is the 42901 step of the send order 签名 → 20001 → 44001 → 42901 (no human
// verification: 44003 is never answered and sms.captcha_mode is not read):
//   ① the client IP, one read-only script over two sorted sets of the window [now − 3600 s, now]
//      (both ends closed): new accounts registered from the IP (limit 5, 08 text) and SMS sends
//      accepted for the IP (sms.ip_sends_per_hour, default 20). Either reached → 42901 with the
//      later release: the (N−L+1)-th oldest record + 3601 s − now. Nothing is admitted then;
//   ② the device: the admission set of (app, device_hash), members the phone's keyed digest.
//      One Lua script cleans the expired members, then: a member → refreshed (its time only moves
//      forward: max of the held and this request's time) and admitted; not a
//      member with room → added and admitted; otherwise 42901 (not added) waiting for the
//      (N−L+1)-th oldest member (the earliest one when the set is exactly full) + 3601 s − now.
//      The same script appends a request record (time in ms, phone digest, result) to a capped
//      list of the device. An admission is never refunded (later phone quota, provider failure).
// Retry-After is rounded up to whole seconds, at least 1. Each script failing (or no Redis, or a
// key that cannot be derived) answers 42901 with Retry-After 1, never a pass:
// `sms_risk_store_unavailable` (error) on the first failure of an outage and
// `sms_risk_store_recovered` (info) on the next success.
//
// recordAccepted() runs after the provider accepted or the outcome is unknown: one record for the
// IP's send count and one for the app's daily budget (+08:00 natural day). The budget alert
// `sms_daily_budget_alert` (warn, flat: app_id, day, count, budget, level) fires once per day and
// tier — `ratio` when count × 10000 ≥ budget × sms.daily_budget_alert_ratio_bp, `full` when
// count ≥ budget — decided in the same script as the count, so concurrent processes alert once.
// Sending never stops on the budget. recordRegistered() records one new account for the IP.
// Their failures are logged (warn) and swallowed.
//
// Nothing stored or logged carries a phone number or an IP in clear: phones and IPs are keyed
// blind indexes under their own contexts. Every key lives at most a window (two days for the
// budget) and carries the app id.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Clock, FieldCrypto, RedisHandle, RootLogger } from '../../platform/index.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';

/** BR-ID-05 / B1-03g: identity resolves device_hash before calling this port. */
export interface SmsRiskRequest {
  readonly appId: string;
  readonly deviceHash: string;
  /** Already normalized by identity; stored only as a keyed digest. */
  readonly phone: string;
  /**
   * Absent only for an in-process send with no HTTP request behind it (no client IP to judge):
   * the IP step ① is skipped then and the device admission ② still applies.
   */
  readonly clientIp?: string;
}
export type SmsRiskAdmission =
  { readonly code: 0 } | { readonly code: 42901; readonly retryAfterSec: number };
export interface SmsRisk {
  /** IP checks precede the atomic device admission; admission is never refunded. */
  admit(input: SmsRiskRequest): Promise<SmsRiskAdmission>;
  /** Called once after accepted OR unknown delivery, never for explicit rejection. */
  /** Without a client IP only the daily budget counts. */
  recordAccepted(input: { appId: string; clientIp?: string }): Promise<void>;
  /** All register_method values count; called by identity before commit. */
  recordRegistered(input: { appId: string; clientIp: string; userId: string }): Promise<void>;
}
export interface SmsRiskOptions {
  readonly clock: Clock;
  readonly redis: RedisHandle | null;
  readonly logger: RootLogger;
  readonly config: RateLimitConfigReader;
  readonly crypto: Pick<FieldCrypto, 'blindIndex'>;
}

/** Config keys and defaults (08 BR-ID-05 细则). */
export const SMS_DEVICE_DISTINCT_PHONES_KEY = 'sms.device_distinct_phones_per_hour';
export const SMS_IP_SENDS_KEY = 'sms.ip_sends_per_hour';
export const SMS_DAILY_BUDGET_KEY = 'sms.daily_budget_count';
export const SMS_DAILY_BUDGET_RATIO_KEY = 'sms.daily_budget_alert_ratio_bp';
const DEVICE_DISTINCT_PHONES_DEFAULT = 3;
const IP_SENDS_DEFAULT = 20;
const DAILY_BUDGET_DEFAULT = 5000;
const DAILY_BUDGET_RATIO_DEFAULT = 8000;
/** New accounts from one IP within the window that stop its sends (08 text, not configurable). */
const IP_REGISTRATIONS_LIMIT = 5;
const MAX_THRESHOLD = 100_000;
const MAX_BUDGET = 100_000_000;
const BP_SCALE = 10_000;

/** Redis namespace; keys read `<kind>:<app_id>:<digest>`. */
export const SMS_RISK_NAMESPACE = 'sms_risk';
/** Blind index contexts (distinct from identity's and from B1-03f's IP context). */
export const SMS_RISK_PHONE_CONTEXT = 'risk.sms.phone';
export const SMS_RISK_IP_CONTEXT = 'risk.sms.ip';

const WINDOW_MS = 3_600_000;
const WINDOW_TTL_SEC = 3_602;
const BUDGET_TTL_SEC = 172_800;
const DAY_MS = 86_400_000;
const OFFSET_MS = 8 * 3_600_000;
/** Request records kept per device (the newest). */
const RECORD_CAP = 200;
const STORE_RETRY_AFTER_SEC = 1;
const STAGE = 'sms_risk';

/**
 * KEYS[1]: IP sends, KEYS[2]: IP registrations. ARGV[2]: now (ms), ARGV[3]: window (ms),
 * ARGV[4]: send limit, ARGV[5]: registration limit. Read-only. Returns {send wait ms, registration
 * wait ms}, 0 when the item is not reached.
 */
const IP_SCRIPT = `
local now = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local low = string.format('%.0f', now - window)
local high = string.format('%.0f', now)
local function wait(key, limit)
  local count = redis.call('ZCOUNT', key, low, high)
  if count < limit then return 0 end
  local entry = redis.call('ZRANGEBYSCORE', key, low, high, 'WITHSCORES', 'LIMIT', count - limit, 1)
  local ms = tonumber(entry[2]) + window + 1000 - now
  if ms < 1 then ms = 1 end
  return ms
end
return {wait(KEYS[1], tonumber(ARGV[4])), wait(KEYS[2], tonumber(ARGV[5]))}
`;

/**
 * KEYS[1]: the device's admission set, KEYS[2]: its request records. ARGV[1]: TTL (s), ARGV[2]:
 * now (ms), ARGV[3]: window (ms), ARGV[4]: limit, ARGV[5]: phone digest, ARGV[6]: record cap.
 * Returns {1, 0} admitted (added or refreshed) or {0, wait ms} refused (nothing added).
 */
const DEVICE_SCRIPT = `
local ttl = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local member = ARGV[5]
local stamp = string.format('%.0f', now)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. string.format('%.0f', now - window))
local result
local outcome
local held = redis.call('ZSCORE', KEYS[1], member)
if held then
  -- a refresh only moves a member's time forward: a late request (its clock read before a
  -- newer refresh by another process) must not pull the member back and age it out early
  if now > tonumber(held) then redis.call('ZADD', KEYS[1], stamp, member) end
  result = {1, 0}
  outcome = 'refreshed'
else
  local count = redis.call('ZCARD', KEYS[1])
  if count < limit then
    redis.call('ZADD', KEYS[1], stamp, member)
    result = {1, 0}
    outcome = 'admitted'
  else
    local entry = redis.call('ZRANGE', KEYS[1], count - limit, count - limit, 'WITHSCORES')
    local wait = tonumber(entry[2]) + window + 1000 - now
    if wait < 1 then wait = 1 end
    result = {0, wait}
    outcome = 'refused'
  end
end
if result[1] == 1 then redis.call('EXPIRE', KEYS[1], ttl) end
redis.call('LPUSH', KEYS[2], stamp .. '|' .. member .. '|' .. outcome)
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[6]) - 1)
redis.call('EXPIRE', KEYS[2], ttl)
return result
`;

/**
 * KEYS[1]: a sorted set of records. ARGV[1]: TTL (s), ARGV[2]: now (ms), ARGV[3]: window (ms),
 * ARGV[4]: member. Drops what left the window, adds the member.
 */
const RECORD_SCRIPT = `
local now = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. string.format('%.0f', now - tonumber(ARGV[3])))
redis.call('ZADD', KEYS[1], string.format('%.0f', now), ARGV[4])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return 1
`;

/**
 * KEYS[1]: the day's count, KEYS[2] / KEYS[3]: markers of the ratio / full alerts. ARGV[1]: TTL
 * (s), ARGV[2]: budget, ARGV[3]: ratio (bp). Returns {count, ratio alert (1/0), full alert (1/0)}.
 */
const BUDGET_SCRIPT = `
local ttl = tonumber(ARGV[1])
local budget = tonumber(ARGV[2])
local bp = tonumber(ARGV[3])
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ttl)
local ratio = 0
local full = 0
if count * 10000 >= budget * bp and redis.call('SET', KEYS[2], tostring(count), 'NX', 'EX', ttl) then
  ratio = 1
end
if count >= budget and redis.call('SET', KEYS[3], tostring(count), 'NX', 'EX', ttl) then
  full = 1
end
return {count, ratio, full}
`;

/** Flat, non-identifying fields of a failure (no message: it may quote a number or an IP). */
function failureFields(error: unknown): { reason: string; error_class: string } {
  const reason =
    typeof error === 'object' && error !== null && typeof Reflect.get(error, 'reason') === 'string'
      ? String(Reflect.get(error, 'reason'))
      : 'unknown';
  const errorClass = error instanceof Error ? error.name : typeof error;
  return { reason, error_class: errorClass };
}

class StoreNotConfigured extends Error {
  readonly reason = 'not_configured';
  constructor() {
    super('sms risk: no Redis in this process');
    this.name = 'StoreNotConfigured';
  }
}

class UnexpectedReply extends Error {
  readonly reason = 'unexpected_reply';
  constructor() {
    super('sms risk: unexpected script reply');
    this.name = 'UnexpectedReply';
  }
}

/** A script reply of `length` non-negative safe integers. */
function integers(reply: unknown, length: number): number[] {
  if (!Array.isArray(reply) || reply.length !== length) throw new UnexpectedReply();
  return (reply as unknown[]).map((value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new UnexpectedReply();
    }
    return value;
  });
}

/** Whole seconds of a wait in ms, rounded up, at least 1. */
function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** The +08:00 natural day of `ms` as YYYY-MM-DD (proleptic Gregorian, days from the epoch). */
export function smsBudgetDay(ms: number): string {
  const z = Math.floor((ms + OFFSET_MS) / DAY_MS) + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Process-local keyed index for a process without a keyring (local / test only: staging and
 * prod cannot start without one). Digests differ between processes and restarts.
 */
export function ephemeralSmsRiskIndex(): Pick<FieldCrypto, 'blindIndex'> {
  const key = randomBytes(32);
  return {
    blindIndex: (value, context) =>
      createHmac('sha256', key).update(`${context}\0${value}`).digest('hex'),
  };
}

export function createSmsRisk(options: SmsRiskOptions): SmsRisk {
  const { clock, redis, logger, config, crypto } = options;

  /** Outage state of this process; null while the store answers. */
  let outage: { since: number } | null = null;

  /** An integer in [min, max]; missing, malformed or unreadable → the default. */
  async function setting(
    appId: string,
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): Promise<number> {
    let value: unknown;
    try {
      const found = await config.configValue(appId, key);
      value = found === null ? undefined : found.value;
    } catch {
      return fallback;
    }
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : fallback;
  }

  function storeFailed(error: unknown): SmsRiskAdmission {
    if (outage === null) {
      outage = { since: clock.now().getTime() };
      logger.error({ stage: STAGE, ...failureFields(error) }, 'sms_risk_store_unavailable');
    }
    return { code: 42901, retryAfterSec: STORE_RETRY_AFTER_SEC };
  }

  function storeAnswered(): void {
    if (outage === null) return;
    logger.info(
      { stage: STAGE, outage_ms: clock.now().getTime() - outage.since },
      'sms_risk_store_recovered',
    );
    outage = null;
  }

  const ipDigest = (clientIp: string): string =>
    crypto.blindIndex(clientIp, SMS_RISK_IP_CONTEXT).slice(0, 32);

  /** Adds one record of `kind` for the client IP; failures are logged and swallowed. */
  async function recordIp(
    store: RedisHandle,
    kind: 'ip_send' | 'ip_reg',
    appId: string,
    clientIp: string,
  ): Promise<void> {
    try {
      await store.namespace(SMS_RISK_NAMESPACE).eval(RECORD_SCRIPT, {
        keys: [`${kind}:${appId}:${ipDigest(clientIp)}`],
        args: [String(clock.now().getTime()), String(WINDOW_MS), randomUUID()],
        ttlSeconds: WINDOW_TTL_SEC,
      });
    } catch (error) {
      logger.warn(
        { stage: STAGE, app_id: appId, kind, ...failureFields(error) },
        'sms_risk_record_failed',
      );
    }
  }

  async function countBudget(store: RedisHandle, appId: string): Promise<void> {
    try {
      const budget = await setting(
        appId,
        SMS_DAILY_BUDGET_KEY,
        DAILY_BUDGET_DEFAULT,
        1,
        MAX_BUDGET,
      );
      const ratio = await setting(
        appId,
        SMS_DAILY_BUDGET_RATIO_KEY,
        DAILY_BUDGET_RATIO_DEFAULT,
        1,
        BP_SCALE,
      );
      const day = smsBudgetDay(clock.now().getTime());
      const base = `budget:${appId}:${day}`;
      const reply = await store.namespace(SMS_RISK_NAMESPACE).eval(BUDGET_SCRIPT, {
        keys: [base, `${base}:ratio`, `${base}:full`],
        args: [String(budget), String(ratio)],
        ttlSeconds: BUDGET_TTL_SEC,
      });
      const [count, ratioAlert, fullAlert] = integers(reply, 3) as [number, number, number];
      if (ratioAlert === 1) {
        logger.warn(
          { app_id: appId, day, count, budget, level: 'ratio' },
          'sms_daily_budget_alert',
        );
      }
      if (fullAlert === 1) {
        logger.warn({ app_id: appId, day, count, budget, level: 'full' }, 'sms_daily_budget_alert');
      }
    } catch (error) {
      logger.warn(
        { stage: STAGE, app_id: appId, kind: 'budget', ...failureFields(error) },
        'sms_risk_record_failed',
      );
    }
  }

  return {
    async admit({ appId, deviceHash, phone, clientIp }) {
      if (redis === null) return storeFailed(new StoreNotConfigured());
      const sendLimit = await setting(appId, SMS_IP_SENDS_KEY, IP_SENDS_DEFAULT, 1, MAX_THRESHOLD);
      const deviceLimit = await setting(
        appId,
        SMS_DEVICE_DISTINCT_PHONES_KEY,
        DEVICE_DISTINCT_PHONES_DEFAULT,
        1,
        MAX_THRESHOLD,
      );
      const now = clock.now().getTime();

      // ① the IP: both items in one read; either reached ends the decision here. A send with
      // no client IP (no HTTP request behind it) has no IP to judge and goes on to ②.
      if (clientIp !== undefined) {
        let ipWaits: number[];
        try {
          const ip = ipDigest(clientIp);
          const reply = await redis.namespace(SMS_RISK_NAMESPACE).eval(IP_SCRIPT, {
            keys: [`ip_send:${appId}:${ip}`, `ip_reg:${appId}:${ip}`],
            args: [
              String(now),
              String(WINDOW_MS),
              String(sendLimit),
              String(IP_REGISTRATIONS_LIMIT),
            ],
            ttlSeconds: WINDOW_TTL_SEC,
          });
          ipWaits = integers(reply, 2);
        } catch (error) {
          return storeFailed(error);
        }
        storeAnswered();
        const ipWait = Math.max(...ipWaits);
        if (ipWait > 0) return { code: 42901, retryAfterSec: seconds(ipWait) };
      }

      // ② the device's admission set, judged, recorded and logged in one atomic step. Its time is
      // read after ①, so the IP round trip does not make it older than a concurrent request's.
      const deviceNow = clock.now().getTime();
      let verdict: number[];
      try {
        const member = crypto.blindIndex(phone, SMS_RISK_PHONE_CONTEXT);
        const reply = await redis.namespace(SMS_RISK_NAMESPACE).eval(DEVICE_SCRIPT, {
          keys: [`dev:${appId}:${deviceHash}`, `req:${appId}:${deviceHash}`],
          args: [
            String(deviceNow),
            String(WINDOW_MS),
            String(deviceLimit),
            member,
            String(RECORD_CAP),
          ],
          ttlSeconds: WINDOW_TTL_SEC,
        });
        verdict = integers(reply, 2);
        if (verdict[0]! > 1) throw new UnexpectedReply();
      } catch (error) {
        return storeFailed(error);
      }
      storeAnswered();
      if (verdict[0] === 1) return { code: 0 };
      return { code: 42901, retryAfterSec: seconds(verdict[1]!) };
    },

    async recordAccepted({ appId, clientIp }) {
      if (redis === null) return;
      if (clientIp !== undefined) await recordIp(redis, 'ip_send', appId, clientIp);
      await countBudget(redis, appId);
    },

    async recordRegistered({ appId, clientIp }) {
      if (redis === null) return;
      await recordIp(redis, 'ip_reg', appId, clientIp);
    },
  };
}
