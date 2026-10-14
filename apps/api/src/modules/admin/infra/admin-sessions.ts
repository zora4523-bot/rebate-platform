// Admin sessions (F1-06k; 08 BR-ID-34 admin_token: 8 hours, 30 minutes idle; logout revokes the
// session), kept in Redis (namespace `admin-auth`, key `session:<jti>`). The record holds the
// account, the absolute expiry and the instant of the last request that passed the admin token
// check, all read from the injected Clock (ruling §9.2 #11: the Redis TTL only cleans up).
//
// `touch` rewrites the record only while it still exists (SET … XX in one script), so a request
// racing a logout never brings the revoked session back, and only with a later lastSeen, so an
// older concurrent request never overwrites a newer one.
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import type { Clock, RedisNamespace } from '../../platform/index.ts';
import { ADMIN_IDLE_TIMEOUT_SEC } from '../domain/login-policy.ts';

export interface SessionRecord {
  readonly adminId: string;
  readonly appId: string;
  /** Absolute expiry, epoch milliseconds. */
  readonly expiresAtMs: number;
  /** Last request that passed the admin token check, epoch milliseconds. */
  readonly lastSeenMs: number;
}

export interface AdminSessions {
  create(sessionId: string, record: SessionRecord): Promise<void>;
  read(sessionId: string): Promise<SessionRecord | undefined>;
  /** Records activity at `lastSeenMs` while the session exists; false when it is gone. */
  touch(sessionId: string, record: SessionRecord): Promise<boolean>;
  revoke(sessionId: string): Promise<void>;
}

/** Extra Redis lifetime beyond the Clock-judged limits: cleanup only. */
const CLEANUP_MARGIN_SEC = 60;

// Only a later lastSeen is written (F1-06l, F1-06k review S2): of concurrent requests, an older one
// that lands last never moves the idle period back; it still reports the live session (1).
const TOUCH_SCRIPT = `local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, record = pcall(cjson.decode, current)
if ok and type(record) == 'table' and tonumber(record.lastSeenMs) and tonumber(record.lastSeenMs) >= tonumber(ARGV[3]) then
  return 1
end
if redis.call('SET', KEYS[1], ARGV[2], 'XX', 'EX', ARGV[1]) then return 1 end
return 0`;
const REVOKE_SCRIPT = `return redis.call('DEL', KEYS[1])`;

const keyOf = (sessionId: string): string => `session:${sessionId}`;

function parse(value: unknown): SessionRecord | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<SessionRecord>;
    if (
      typeof parsed.adminId !== 'string' ||
      typeof parsed.appId !== 'string' ||
      typeof parsed.expiresAtMs !== 'number' ||
      typeof parsed.lastSeenMs !== 'number'
    ) {
      return undefined;
    }
    return parsed as SessionRecord;
  } catch {
    return undefined;
  }
}

export function createAdminSessions(deps: {
  readonly redis: RedisNamespace;
  readonly clock: Clock;
}): AdminSessions {
  const { redis, clock } = deps;
  const ttlOf = (record: SessionRecord): number => {
    const absolute = Math.ceil((record.expiresAtMs - clock.now().getTime()) / 1000);
    return Math.max(1, Math.min(absolute, ADMIN_IDLE_TIMEOUT_SEC)) + CLEANUP_MARGIN_SEC;
  };
  return {
    async create(sessionId, record) {
      await redis.set(keyOf(sessionId), JSON.stringify(record), ttlOf(record));
    },
    async read(sessionId) {
      return parse(await redis.get(keyOf(sessionId)));
    },
    async touch(sessionId, record) {
      const reply = await redis.eval(TOUCH_SCRIPT, {
        keys: [keyOf(sessionId)],
        args: [JSON.stringify(record), String(record.lastSeenMs)],
        ttlSeconds: ttlOf(record),
      });
      return reply === 1;
    },
    async revoke(sessionId) {
      await redis.eval(REVOKE_SCRIPT, { keys: [keyOf(sessionId)], args: [], ttlSeconds: 1 });
    },
  };
}
