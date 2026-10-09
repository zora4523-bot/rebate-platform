// Device registration risk (task B1-03f; 规划/08 BR-ID-05 细则「发码与设备注册的风控默认值」
// device.ip_register_per_hour, BR-ID-09 细则「设备标识的无效值」监控 device.hash_hot_alert_count;
// 04 §6.1 POST /v1/devices). identity calls these ports from its registration use case; app.module
// assembles them through ../index.ts.
//
// Per-IP hourly cap (reserve / release / reconcile): one Redis sorted set per (app, client IP),
// key `ip_reg:<app_id>:<blind index of the IP, 32 hex>`, one member per reserved registration
// scored by the injected Clock's milliseconds. One Lua script drops the members older than the
// window [now − 3600 s, now] (both ends closed), judges and records in one step, so concurrent
// requests never pass the limit L. A refusal waits until the (N−L+1)-th oldest member has left the
// window: its time + 3601 s − now, rounded up to whole seconds, at least 1 (BR-ID-05 example).
// identity reserves before issuing anything, releases on an explicit failure, and on an unknown
// outcome keeps the slot while it checks the device row (release only on confirmed absence).
// Store outage (no Redis, a failed script or a key that cannot be derived): 42901 with
// Retry-After 1, never a pass; `device_register_store_unavailable` (error) on the first failure of
// an outage and `device_register_store_recovered` (info) on the next success. Logs carry no IP.
//
// Hot device_hash (recordSuccess): one sorted set per (app, device_hash) of the device ids
// registered in the last 24 hours (sliding, Clock milliseconds) plus an alert marker; reaching
// the threshold logs `device_hash_hot_alert` (warn, flat: app_id, device_hash, count, window) at
// most once per 24 hours per hash. Alert only, never a refusal; any failure here is logged and
// swallowed, so the registration it follows stays successful.
//
// Thresholds: content's configValue through RateLimitConfigReader; a missing key, a value that is
// not a positive integer or a failed read uses the default (30, 20) and is not a store outage.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import { createHash, randomUUID } from 'node:crypto';
import type { Clock, FieldCrypto, RedisHandle, RootLogger } from '../../platform/index.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';

/** B1-03f: identity calls these ports before issuance and after the database outcome. */
export interface DeviceRegistrationReservation {
  readonly appId: string;
  readonly ipDigest: string;
  readonly token: string;
}

export type DeviceRegistrationAdmission =
  | { readonly code: 0; readonly reservation: DeviceRegistrationReservation }
  | { readonly code: 42901; readonly retryAfterSec: number };

export interface DeviceRegistrationRisk {
  reserve(input: { appId: string; clientIp: string }): Promise<DeviceRegistrationAdmission>;
  release(reservation: DeviceRegistrationReservation): Promise<void>;
  /** Keep the reservation while checking; release only on confirmed absence, never on error. */
  reconcile(
    reservation: DeviceRegistrationReservation,
    deviceId: string,
    exists: (deviceId: string) => Promise<boolean>,
  ): Promise<void>;
  recordSuccess(input: { appId: string; deviceHash: string; deviceId: string }): Promise<void>;
}

export interface DeviceRegistrationRiskOptions {
  readonly clock: Clock;
  readonly redis: RedisHandle | null;
  readonly logger: RootLogger;
  /** Existing B1-03e configValue boundary; content is assembled outside risk. */
  readonly config: RateLimitConfigReader;
  readonly crypto: Pick<FieldCrypto, 'blindIndex'>;
}

/** Config keys and defaults (08 BR-ID-05 / BR-ID-09). */
export const IP_REGISTER_PER_HOUR_KEY = 'device.ip_register_per_hour';
export const HASH_HOT_ALERT_COUNT_KEY = 'device.hash_hot_alert_count';
const IP_REGISTER_PER_HOUR_DEFAULT = 30;
const HASH_HOT_ALERT_COUNT_DEFAULT = 20;
/** Upper bound of a configured threshold; also the size cap of a hot-hash set. */
const MAX_THRESHOLD = 100_000;

/** Redis namespaces: keys read `ip_reg:<app_id>:<ip digest>` and `dev_hot:<app_id>:<hash>…`. */
export const IP_REGISTER_NAMESPACE = 'ip_reg';
export const HASH_HOT_NAMESPACE = 'dev_hot';
/** Blind index context of the IP part of a reservation key. */
export const IP_REGISTER_KEY_CONTEXT = 'risk.device_register.ip';

const IP_WINDOW_MS = 3_600_000;
const IP_TTL_SEC = 3_602;
const HOT_WINDOW_MS = 86_400_000;
const HOT_TTL_SEC = 86_402;
const HOT_WINDOW_LABEL = '24h';
/** Retry-After of a refusal caused by the store. */
const STORE_RETRY_AFTER_SEC = 1;
const STAGE = 'device_register';

/**
 * KEYS[1]: the reservation set. ARGV[1]: TTL (s), ARGV[2]: now (ms), ARGV[3]: limit,
 * ARGV[4]: window (ms), ARGV[5]: member. Returns {1, 0} after recording the member, or {0, wait_ms}
 * without recording: wait_ms = time of the (N−L+1)-th oldest member + window + 1 s − now.
 */
const RESERVE_SCRIPT = `
local ttl = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. string.format('%.0f', now - window))
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local entry = redis.call('ZRANGE', KEYS[1], count - limit, count - limit, 'WITHSCORES')
  local wait = tonumber(entry[2]) + window + 1000 - now
  if wait < 1 then wait = 1 end
  return {0, wait}
end
redis.call('ZADD', KEYS[1], string.format('%.0f', now), ARGV[5])
redis.call('EXPIRE', KEYS[1], ttl)
return {1, 0}
`;

/** KEYS[1]: the reservation set. ARGV[2]: member. Removing an absent member is a no-op. */
const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[2])
return 1
`;

/**
 * KEYS[1]: device ids of one hash, KEYS[2]: the alert marker (Clock ms of the last alert).
 * ARGV[1]: TTL (s), ARGV[2]: now (ms), ARGV[3]: window (ms), ARGV[4]: threshold, ARGV[5]: device
 * id, ARGV[6]: size cap. Returns {count, alert (1/0)}.
 */
const HOT_SCRIPT = `
local ttl = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local threshold = tonumber(ARGV[4])
local cap = tonumber(ARGV[6])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. string.format('%.0f', now - window))
redis.call('ZADD', KEYS[1], string.format('%.0f', now), ARGV[5])
redis.call('EXPIRE', KEYS[1], ttl)
local count = redis.call('ZCARD', KEYS[1])
if count > cap then
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - cap - 1)
  count = cap
end
if count < threshold then return {count, 0} end
local last = tonumber(redis.call('GET', KEYS[2]))
if last ~= nil and last >= now - window then return {count, 0} end
redis.call('SET', KEYS[2], string.format('%.0f', now), 'EX', ttl)
return {count, 1}
`;

/** Flat, non-identifying fields of a failure. */
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
    super('device registration risk: no Redis in this process');
    this.name = 'StoreNotConfigured';
  }
}

class UnexpectedReply extends Error {
  readonly reason = 'unexpected_reply';
  constructor() {
    super('device registration risk: unexpected script reply');
    this.name = 'UnexpectedReply';
  }
}

/** A script reply of two non-negative safe integers. */
function pair(reply: unknown): [number, number] {
  if (!Array.isArray(reply) || reply.length !== 2) throw new UnexpectedReply();
  const [a, b] = reply as unknown[];
  if (typeof a !== 'number' || typeof b !== 'number') throw new UnexpectedReply();
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0) {
    throw new UnexpectedReply();
  }
  return [a, b];
}

/** Unkeyed stand-in of the blind index for a process without a keyring. */
export function unkeyedDeviceRegistrationIndex(): Pick<FieldCrypto, 'blindIndex'> {
  return {
    blindIndex: (value, context) =>
      createHash('sha256').update(`${context}\0${value}`).digest('hex'),
  };
}

export function createDeviceRegistrationRisk(
  options: DeviceRegistrationRiskOptions,
): DeviceRegistrationRisk {
  const { clock, redis, logger, config, crypto } = options;

  /** Outage state of this process; null while the store answers. */
  let outage: { since: number } | null = null;

  /** A positive integer threshold; missing, malformed or unreadable → the default. */
  async function threshold(appId: string, key: string, fallback: number): Promise<number> {
    let value: unknown;
    try {
      const found = await config.configValue(appId, key);
      value = found === null ? undefined : found.value;
    } catch {
      return fallback;
    }
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= MAX_THRESHOLD
      ? value
      : fallback;
  }

  function storeFailed(error: unknown): DeviceRegistrationAdmission {
    if (outage === null) {
      outage = { since: clock.now().getTime() };
      logger.error({ stage: STAGE, ...failureFields(error) }, 'device_register_store_unavailable');
    }
    return { code: 42901, retryAfterSec: STORE_RETRY_AFTER_SEC };
  }

  function storeAnswered(): void {
    if (outage === null) return;
    logger.info(
      { stage: STAGE, outage_ms: clock.now().getTime() - outage.since },
      'device_register_store_recovered',
    );
    outage = null;
  }

  async function release(reservation: DeviceRegistrationReservation): Promise<void> {
    if (redis === null) return;
    try {
      await redis.namespace(IP_REGISTER_NAMESPACE).eval(RELEASE_SCRIPT, {
        keys: [`${reservation.appId}:${reservation.ipDigest}`],
        args: [reservation.token],
        ttlSeconds: IP_TTL_SEC,
      });
    } catch (error) {
      // The slot then leaves with the window; over-counting is the safe side.
      logger.warn(
        { stage: STAGE, app_id: reservation.appId, ...failureFields(error) },
        'device_register_release_failed',
      );
    }
  }

  return {
    async reserve({ appId, clientIp }) {
      const limit = await threshold(appId, IP_REGISTER_PER_HOUR_KEY, IP_REGISTER_PER_HOUR_DEFAULT);
      if (redis === null) return storeFailed(new StoreNotConfigured());
      const token = randomUUID();
      let digest: string;
      let verdict: [number, number];
      try {
        digest = crypto.blindIndex(clientIp, IP_REGISTER_KEY_CONTEXT).slice(0, 32);
        const reply = await redis.namespace(IP_REGISTER_NAMESPACE).eval(RESERVE_SCRIPT, {
          keys: [`${appId}:${digest}`],
          args: [String(clock.now().getTime()), String(limit), String(IP_WINDOW_MS), token],
          ttlSeconds: IP_TTL_SEC,
        });
        verdict = pair(reply);
        if (verdict[0] > 1) throw new UnexpectedReply();
      } catch (error) {
        return storeFailed(error);
      }
      storeAnswered();
      if (verdict[0] === 1) return { code: 0, reservation: { appId, ipDigest: digest, token } };
      return { code: 42901, retryAfterSec: Math.max(1, Math.ceil(verdict[1] / 1000)) };
    },

    release,

    async reconcile(reservation, deviceId, exists) {
      let present: boolean;
      try {
        present = await exists(deviceId);
      } catch (error) {
        // Still unknown: keep the slot.
        logger.warn(
          { stage: STAGE, app_id: reservation.appId, ...failureFields(error) },
          'device_register_reconcile_failed',
        );
        return;
      }
      if (!present) await release(reservation);
    },

    async recordSuccess({ appId, deviceHash, deviceId }) {
      if (redis === null) return;
      try {
        const limit = await threshold(
          appId,
          HASH_HOT_ALERT_COUNT_KEY,
          HASH_HOT_ALERT_COUNT_DEFAULT,
        );
        const reply = await redis.namespace(HASH_HOT_NAMESPACE).eval(HOT_SCRIPT, {
          keys: [`${appId}:${deviceHash}`, `${appId}:${deviceHash}:alerted`],
          args: [
            String(clock.now().getTime()),
            String(HOT_WINDOW_MS),
            String(limit),
            deviceId,
            String(MAX_THRESHOLD),
          ],
          ttlSeconds: HOT_TTL_SEC,
        });
        const [count, alert] = pair(reply);
        if (alert === 1) {
          logger.warn(
            { app_id: appId, device_hash: deviceHash, count, window: HOT_WINDOW_LABEL },
            'device_hash_hot_alert',
          );
        }
      } catch (error) {
        logger.warn(
          { stage: STAGE, app_id: appId, ...failureFields(error) },
          'device_hash_hot_count_failed',
        );
      }
    },
  };
}
