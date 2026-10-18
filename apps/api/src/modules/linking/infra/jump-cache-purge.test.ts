import { describe, expect, it } from 'vitest';
import { FixedClock, type RedisNamespace } from '../../platform/index.ts';
import type { LinkOpenCacheKey, LinkOpenCachedJump } from '../application/link-open-requote.ts';
import { createRedisJumpCache, createRedisJumpCachePurger } from './jump-cache.ts';

const USER = '0199a3b4-5c6d-7000-8000-00000000000a';
const OTHER = '0199a3b4-5c6d-7000-8000-00000000000b';
const key: LinkOpenCacheKey = {
  appId: 'synthetic-app',
  userId: USER,
  platform: 'taobao',
  productKey: 'tb:1',
  rawItemId: '1',
  pid: 'mm_1_2_3',
  pidScene: 'self_buy',
  noRebate: false,
};
const value: LinkOpenCachedJump = {
  jump: {
    primary: { type: 'h5', value: 'https://example.test/u' },
    fallbacks: [],
    expire_at: '2031-05-06T07:10:00.000Z',
  },
  fetchedAt: '2031-05-06T07:00:00.000Z',
};

function memory() {
  const store = new Map<string, { value: string; ttl: number }>();
  const redis: RedisNamespace = {
    get: async (name) => store.get(name)?.value ?? null,
    set: async (name, text, ttl) => {
      store.set(name, { value: text, ttl });
    },
    eval: async () => null,
  };
  return { store, redis };
}

describe('jump cache per-user clear (F1-07c)', () => {
  it('[AC-F1-07c] a purge makes every entry of the user a miss, others and other apps kept', async () => {
    const clock = new FixedClock('2031-05-06T07:00:00.000Z');
    const { store, redis } = memory();
    const cache = createRedisJumpCache(redis, clock, { warn: () => undefined });
    const mine = [key, { ...key, platform: 'pdd' }, { ...key, variant: 'android:true' }];
    const kept = [
      { ...key, userId: OTHER },
      { ...key, appId: 'synthetic-other' },
      { ...key, userId: null },
    ];
    for (const k of [...mine, ...kept]) await cache.put(k, value);
    await createRedisJumpCachePurger(redis).purgeUser(key.appId, USER);
    for (const k of mine) expect(await cache.get(k)).toBeNull();
    for (const k of kept) expect(await cache.get(k)).toEqual(value);
    // The generation outlives every entry written before it moved; no identity in its name.
    const generation = [...store.entries()].find(([name]) => name.includes(':g:'))!;
    expect(generation[1].ttl).toBe(1800);
    expect(generation[0]).not.toContain(USER);
    // Entries written after the purge are hits again; a second purge clears them too.
    await cache.put(key, value);
    expect(await cache.get(key)).toEqual(value);
    await createRedisJumpCachePurger(redis).purgeUser(key.appId, USER);
    expect(await cache.get(key)).toBeNull();
  });
});
