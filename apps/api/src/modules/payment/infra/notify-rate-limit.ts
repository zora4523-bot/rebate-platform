// B2-15c: the per-address limit of the notification entry (08 BR-PAY-08 ③ / specs/pay-notify.md
// §1 「限流」; 02 §12.2 限流行, §14 every Redis key carries a TTL, §15 a Redis outage refuses the
// limited operation). The entry has no user, device or app before the signature is verified, so
// the only dimension is the client address (Fastify request.ip): a fixed window per address and
// channel, counted in platform's Redis. The address itself never reaches Redis or a log line: the
// key part is the deployment's keyed blind index (FIELD_CRYPTO, the same practice as risk's rate
// limit, B1-03e), or an unkeyed sha256 where no keyring is wired. The limit is generous — channel
// notifications come in bursts from a handful of addresses, and a refused one is only re-sent —
// and fixed in code: there is no app to read configuration for at this point.
// Also compiled by the `test` project (through the module's imports): erasable syntax only.
import { createHash } from 'node:crypto';
import type { Clock, FieldCrypto, RedisHandle, RedisNamespace } from '../../platform/index.ts';
import type { PayChannelCode } from '../domain/types.ts';

/** Redis namespace of the counters (platform rule: lowercase letters, digits, _ and -). */
export const NOTIFY_RATE_LIMIT_NAMESPACE = 'pay-notify';
/** Blind index context of the address part of a key. */
export const NOTIFY_RATE_LIMIT_KEY_CONTEXT = 'payment.notify.ip';
/** Notifications per address, per channel, per window (fixed in code, see above). */
export const NOTIFY_RATE_LIMIT = Object.freeze({ limit: 300, windowSeconds: 60 });

/** One window's counter: INCR, with the key's TTL set when it is created (ARGV[1], the cap). */
const COUNT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return n
`;

export interface NotifyRateLimiter {
  /** True when this request may proceed; rejects (RedisUnavailableError) when the store fails. */
  allow(channel: PayChannelCode, ip: string): Promise<boolean>;
}

export interface NotifyRateLimiterOptions {
  readonly redis: Pick<RedisHandle, 'namespace'>;
  readonly clock: Clock;
  readonly crypto: Pick<FieldCrypto, 'blindIndex'> | null;
}

export function createNotifyRateLimiter(options: NotifyRateLimiterOptions): NotifyRateLimiter {
  const namespace: RedisNamespace = options.redis.namespace(NOTIFY_RATE_LIMIT_NAMESPACE);
  const windowMs = NOTIFY_RATE_LIMIT.windowSeconds * 1000;
  const digest = (ip: string): string =>
    options.crypto === null
      ? createHash('sha256').update(ip, 'utf8').digest('hex')
      : options.crypto.blindIndex(ip, NOTIFY_RATE_LIMIT_KEY_CONTEXT);
  return {
    async allow(channel, ip) {
      const window = Math.floor(options.clock.now().getTime() / windowMs);
      const key = `${channel}:${digest(ip)}:${window}`;
      const count = await namespace.eval(COUNT_SCRIPT, {
        keys: [key],
        args: [],
        ttlSeconds: NOTIFY_RATE_LIMIT.windowSeconds * 2,
      });
      return Number(count) <= NOTIFY_RATE_LIMIT.limit;
    },
  };
}
