import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type {
  LinkOpenCacheKey,
  LinkOpenCachedJump,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { createRedisJumpCache } from '../../../../apps/api/src/modules/linking/infra/jump-cache.ts';
import {
  FixedClock,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { built } from './kit.ts';

it('[AC-B1-08s#23] 实际 Redis 缓存编码区分 lk；未注入时保留原键，不能读到其他 link 的跳转', async () => {
  const store = new Map<string, string>();
  const redis: RedisNamespace = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    eval: async () => null,
  };
  const clock = new FixedClock('2031-05-06T07:00:00.000Z');
  const cache = await built(() => createRedisJumpCache(redis, clock, { warn: vi.fn() }));
  const base: LinkOpenCacheKey = {
    appId: 'cache-app',
    userId: 'synthetic-owner',
    platform: 'jd',
    productKey: 'jd:123',
    rawItemId: '123',
    pid: 'synthetic-pid',
    pidScene: 'self_buy',
    noRebate: false,
    variant: 'ios:true',
  };
  const value: LinkOpenCachedJump = {
    fetchedAt: clock.now().toISOString(),
    variant: 'ios:true',
    jump: {
      primary: { type: 'h5', value: 'https://example.test/a' },
      fallbacks: [],
      expire_at: '2031-05-06T07:10:00.000Z',
    },
  };
  const a = { ...base, linkCode: 'aaaaaa' };
  const b = { ...base, linkCode: 'bbbbbb' };
  await cache.put(a, value);
  expect(await cache.get(b)).toBeNull();
  expect(await cache.get(base)).toBeNull();
  expect(await cache.get(a)).toEqual(value);
  await cache.put(base, value);
  const oldKey = `${base.appId}:${createHash('sha256')
    .update(
      JSON.stringify([
        base.userId,
        base.platform,
        base.productKey,
        base.rawItemId,
        base.pid,
        base.pidScene,
        false,
        base.variant,
      ]),
    )
    .digest('hex')}`;
  expect(store.get(oldKey)).toBe(JSON.stringify(value));
  expect(store.size).toBe(2);
});
