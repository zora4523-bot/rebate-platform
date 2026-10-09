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

/** B1-06f: a cached Baichuan instruction keeps its pairing (type=sdk iff sdk, 04 §8.4). */
function isSdk(value: unknown, stepValue: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const sdk = value as { provider?: unknown; open_by?: unknown; url?: unknown; item_id?: unknown };
  if (sdk.provider !== 'baichuan') return false;
  if (sdk.open_by === 'url') return typeof sdk.url === 'string' && sdk.url === stepValue;
  return sdk.open_by === 'code' && typeof sdk.item_id === 'string' && sdk.item_id === stepValue;
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
