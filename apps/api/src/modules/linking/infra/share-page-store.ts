// B1-15u: the share page's tickets and its IP × link_id rate-limit buckets in Redis (orchestrator
// ruling for B1-15u: Redis, no table). Namespace `linking-share` (platform/redis prefixes every key).
//
// Keys (every one starts with the app, so tenants never share a key):
//   <app>:t:<link_id>:<sha256(ticket)>  hash {e: expiry ms on the injected Clock, n: exchanges}
//   <app>:r:<sha256([link_id, ip])>:<window>  counter of the window (minute number on the Clock)
// The ticket itself and the client IP never appear in a key name. Validity is judged on the stored
// expiry against the injected Clock, never on Redis TTLs (a FixedClock does not move Redis time);
// the TTLs only bound how long keys live. Each step is one Lua call, so the exchange count and the
// window counter are atomic under concurrency: a ticket exchanges at most `max` times and a
// window admits exactly its limit, however many requests arrive at once.
// Redis errors propagate as platform/redis errors; the use case decides (share-page.ts).
import { createHash, randomBytes } from 'node:crypto';
import type { RedisNamespace } from '../../platform/index.ts';
import {
  SHARE_TICKET_TTL_MS,
  SHARE_TPWD_WINDOW_MS,
  type ShareTicketStore,
} from '../application/share-page.ts';

export const SHARE_PAGE_REDIS_NAMESPACE = 'linking-share';

/** Seconds a ticket key lives in Redis (its validity is the stored expiry). */
const TICKET_TTL_SEC = SHARE_TICKET_TTL_MS / 1000;
/** A window's counter outlives its window, so a late request of the window still finds it. */
const WINDOW_TTL_SEC = (2 * SHARE_TPWD_WINDOW_MS) / 1000;

const ISSUE = `
redis.call('HSET', KEYS[1], 'e', ARGV[2], 'n', '0')
redis.call('EXPIRE', KEYS[1], ARGV[1])
return 1
`;

// ARGV[2] now (ms), ARGV[3] the most exchanges. A missing or expired ticket writes nothing.
const REDEEM = `
local e = redis.call('HGET', KEYS[1], 'e')
if not e then return 0 end
if tonumber(e) <= tonumber(ARGV[2]) then return 0 end
local n = redis.call('HINCRBY', KEYS[1], 'n', 1)
redis.call('EXPIRE', KEYS[1], ARGV[1])
if n > tonumber(ARGV[3]) then return 0 end
return 1
`;

const HIT = `
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return n
`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ticketKey(appId: string, linkId: string, ticket: string): string {
  return `${appId}:t:${linkId}:${sha256(ticket)}`;
}

/** 256 random bits from the CSPRNG, base64url (43 characters): it carries nothing in clear. */
export function newShareTicket(): string {
  return randomBytes(32).toString('base64url');
}

function integerReply(reply: unknown): number {
  const value = typeof reply === 'string' ? Number(reply) : reply;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('linking: unexpected reply of the share page store');
  }
  return value;
}

export function createRedisShareTicketStore(redis: RedisNamespace): ShareTicketStore {
  return {
    async issue(appId, linkId, expiresAtMs) {
      const ticket = newShareTicket();
      await redis.eval(ISSUE, {
        keys: [ticketKey(appId, linkId, ticket)],
        args: [String(expiresAtMs)],
        ttlSeconds: TICKET_TTL_SEC,
      });
      return ticket;
    },

    async redeem(appId, linkId, ticket, nowMs, maxUses) {
      const reply = await redis.eval(REDEEM, {
        keys: [ticketKey(appId, linkId, ticket)],
        args: [String(nowMs), String(maxUses)],
        ttlSeconds: TICKET_TTL_SEC,
      });
      return integerReply(reply) === 1;
    },

    async hit(appId, linkId, ip, window) {
      const bucket = sha256(JSON.stringify([linkId, ip]));
      const reply = await redis.eval(HIT, {
        keys: [`${appId}:r:${bucket}:${String(window)}`],
        args: [],
        ttlSeconds: WINDOW_TTL_SEC,
      });
      return integerReply(reply);
    },
  };
}

/** A process without Redis: no ticket is issued, every exchange and count fails closed. */
export const NO_SHARE_TICKET_STORE: ShareTicketStore = {
  issue: () => Promise.reject(new Error('linking: no Redis handle in this process')),
  redeem: () => Promise.reject(new Error('linking: no Redis handle in this process')),
  hit: () => Promise.reject(new Error('linking: no Redis handle in this process')),
};
