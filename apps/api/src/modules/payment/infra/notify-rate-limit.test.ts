// B2-15c unit tests of the notification entry's per-address limit (specs/pay-notify.md §1 限流):
// a fake Redis namespace counts the script's INCR; the address never appears in a key.
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { RedisScriptOptions } from '../../platform/index.ts';
import { NOTIFY_RATE_LIMIT, createNotifyRateLimiter } from './notify-rate-limit.ts';

function fakeRedis() {
  const counters = new Map<string, number>();
  const ttls: number[] = [];
  return {
    counters,
    ttls,
    namespace: () => ({
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      eval: (_script: string, options: RedisScriptOptions) => {
        const key = options.keys[0] ?? '';
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        ttls.push(options.ttlSeconds);
        return Promise.resolve(next);
      },
    }),
  };
}

describe('[AC-B2-15c] notification rate limit', () => {
  it('allows up to the limit per address, channel and window, then refuses; the window moves with the Clock', async () => {
    const redis = fakeRedis();
    const clock = new FixedClock('2026-10-22T01:00:00.000Z');
    const limiter = createNotifyRateLimiter({ redis, clock, crypto: null });
    for (let i = 0; i < NOTIFY_RATE_LIMIT.limit; i += 1) {
      expect(await limiter.allow('wechat_pay', '198.18.0.1')).toBe(true);
    }
    expect(await limiter.allow('wechat_pay', '198.18.0.1')).toBe(false);
    // Another address and another channel have their own counters.
    expect(await limiter.allow('wechat_pay', '198.18.0.2')).toBe(true);
    expect(await limiter.allow('alipay', '198.18.0.1')).toBe(true);
    clock.advanceMs(NOTIFY_RATE_LIMIT.windowSeconds * 1000);
    expect(await limiter.allow('wechat_pay', '198.18.0.1')).toBe(true);
    for (const key of redis.counters.keys()) expect(key.includes('198.18')).toBe(false);
    expect(new Set(redis.ttls)).toEqual(new Set([NOTIFY_RATE_LIMIT.windowSeconds * 2]));
  });

  it("keys the address through the field cipher's blind index when one is wired", async () => {
    const redis = fakeRedis();
    const limiter = createNotifyRateLimiter({
      redis,
      clock: new FixedClock('2026-10-22T01:00:00.000Z'),
      crypto: { blindIndex: (value, context) => `${context}:${value.length}` },
    });
    await limiter.allow('alipay', '198.18.0.9');
    expect([...redis.counters.keys()]).toEqual([
      expect.stringContaining('alipay:payment.notify.ip:10:'),
    ]);
  });
});
