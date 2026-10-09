// B1-06w: the open's conversion cache (BR-ATTR-05 ②) in Redis. One string key per cache identity
// (link-open-requote.ts LinkOpenCacheKey), the identity hashed so no user or pid appears in a key
// name; the value is the cached jump as JSON, expiring with the jump (at most 900 seconds). Redis
// is called while the open holds its database transaction, never the database (B1-06m).
// A Redis failure is a miss on read and a skipped write: the open converts afresh instead.
import { createHash } from 'node:crypto';
import type { Clock, RedisNamespace } from '../../platform/index.ts';
import { MAX_CONVERT_CACHE_TTL_SEC } from '../domain/rules.ts';
import type { LinkOpenCacheKey, LinkOpenCachedJump } from '../application/link-open-requote.ts';

export const LINK_JUMP_REDIS_NAMESPACE = 'linking-jump';

export interface LinkJumpCache {
  get(key: LinkOpenCacheKey): Promise<LinkOpenCachedJump | null>;
  put(key: LinkOpenCacheKey, value: LinkOpenCachedJump): Promise<void>;
}

interface Warn {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

function redisKey(key: LinkOpenCacheKey): string {
  const identity = JSON.stringify([
    key.userId,
    key.platform,
    key.productKey,
    key.rawItemId,
    key.pid,
    key.pidScene,
    key.noRebate,
    key.variant ?? null,
  ]);
  return `${key.appId}:${createHash('sha256').update(identity).digest('hex')}`;
}

/** The error class only: messages of transport errors are not logged. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

const STEP_TYPES = new Set(['scheme', 'universal_link', 'h5']);

const SDK_KEYS = new Set(['provider', 'open_by', 'url', 'page', 'item_id', 'sku_id', 'taoke']);
const TAOKE_KEYS = new Set(['pid', 'relation_id']);
/** contracts BaichuanTaoke.pid. */
const TAOKE_PID = /^mm_\d+_\d+_\d+$/;

function onlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((name) => allowed.has(name));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}

function isTaoke(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!onlyKeys(value, TAOKE_KEYS)) return false;
  const taoke = value as { pid?: unknown; relation_id?: unknown };
  if (!boundedString(taoke.pid, 64) || !TAOKE_PID.test(taoke.pid)) return false;
  return !Object.hasOwn(taoke, 'relation_id') || boundedString(taoke.relation_id, 32);
}

function isHttpsUrl(value: unknown): value is string {
  if (!boundedString(value, 2048)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.host !== '';
  } catch {
    return false;
  }
}

/**
 * B1-06f: a cached Baichuan instruction is reused only in a contract shape (BaichuanOpen, 04 §8.4):
 * url branch = provider, open_by, url only; code branch = page=detail, item_id, a valid taoke and
 * an optional sku_id, no url; the step value repeats sdk.url / sdk.item_id. Anything else is a miss.
 */
function isSdk(value: unknown, stepValue: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!onlyKeys(value, SDK_KEYS)) return false;
  const sdk = value as Record<string, unknown>;
  if (sdk.provider !== 'baichuan') return false;
  const has = (name: string) => Object.hasOwn(sdk, name);
  if (sdk.open_by === 'url') {
    if (has('taoke') || has('page') || has('item_id') || has('sku_id')) return false;
    return isHttpsUrl(sdk.url) && sdk.url === stepValue;
  }
  if (sdk.open_by !== 'code' || has('url')) return false;
  if (sdk.page !== 'detail' || !boundedString(sdk.item_id, 64) || sdk.item_id !== stepValue) {
    return false;
  }
  if (has('sku_id') && !boundedString(sdk.sku_id, 64)) return false;
  return isTaoke(sdk.taoke);
}

function isStep(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const step = value as { type?: unknown; value?: unknown; sdk?: unknown };
  if (typeof step.value !== 'string') return false;
  if (step.type === 'sdk') return isSdk(step.sdk, step.value);
  return typeof step.type === 'string' && STEP_TYPES.has(step.type) && !Object.hasOwn(step, 'sdk');
}

function cachedJumpOf(text: string): LinkOpenCachedJump | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as { jump?: unknown; fetchedAt?: unknown; variant?: unknown; tag?: unknown };
  const jump = entry.jump as { primary?: unknown; fallbacks?: unknown; expire_at?: unknown };
  if (
    typeof jump !== 'object' ||
    jump === null ||
    !isStep(jump.primary) ||
    !Array.isArray(jump.fallbacks) ||
    !jump.fallbacks.every(isStep) ||
    typeof jump.expire_at !== 'string' ||
    typeof entry.fetchedAt !== 'string' ||
    (entry.variant !== undefined && typeof entry.variant !== 'string') ||
    (entry.tag !== undefined && typeof entry.tag !== 'string')
  ) {
    return null;
  }
  return entry as LinkOpenCachedJump;
}

export function createRedisJumpCache(
  redis: RedisNamespace,
  clock: Clock,
  logger: Warn,
): LinkJumpCache {
  return {
    async get(key) {
      let text: string | null;
      try {
        text = await redis.get(redisKey(key));
      } catch (error) {
        logger.warn(
          {
            event: 'linking.open.jump_cache_unavailable',
            app_id: key.appId,
            op: 'get',
            reason: reasonOf(error),
          },
          'linking: jump cache read failed; treated as a miss',
        );
        return null;
      }
      return text === null ? null : cachedJumpOf(text);
    },
    async put(key, value) {
      const remainingMs = Date.parse(value.jump.expire_at) - clock.now().getTime();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) return;
      const ttlSeconds = Math.min(MAX_CONVERT_CACHE_TTL_SEC, Math.ceil(remainingMs / 1000));
      try {
        await redis.set(redisKey(key), JSON.stringify(value), ttlSeconds);
      } catch (error) {
        logger.warn(
          {
            event: 'linking.open.jump_cache_unavailable',
            app_id: key.appId,
            op: 'set',
            reason: reasonOf(error),
          },
          'linking: jump cache write failed; not cached',
        );
      }
    },
  };
}

/** Without a REDIS provider (isolated HTTP unit tests) nothing is cached. */
export const NO_JUMP_CACHE: LinkJumpCache = {
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(),
};
