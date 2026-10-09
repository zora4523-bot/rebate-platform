import { describe, expect, it } from 'vitest';
import { FixedClock, type RedisNamespace } from '../../platform/index.ts';
import type { LinkOpenCacheKey, LinkOpenCachedJump } from '../application/link-open-requote.ts';
import { createRedisJumpCache } from './jump-cache.ts';

const key: LinkOpenCacheKey = {
  appId: 'synthetic-app',
  userId: '0199a3b4-5c6d-7000-8000-00000000000a',
  platform: 'jd',
  productKey: 'jd:12345',
  rawItemId: '12345',
  pid: 'synthetic-pid',
  pidScene: 'self_buy',
  noRebate: false,
  variant: 'ios:true',
};

function entry(expireAt: string): LinkOpenCachedJump {
  return {
    jump: {
      primary: { type: 'h5', value: 'https://example.test/u' },
      fallbacks: [],
      expire_at: expireAt,
    },
    fetchedAt: '2031-05-06T07:00:00.000Z',
    variant: 'ios:true',
  };
}

function memory() {
  const store = new Map<string, { value: string; ttl: number }>();
  const redis: RedisNamespace = {
    get: async (name) => store.get(name)?.value ?? null,
    set: async (name, value, ttl) => {
      store.set(name, { value, ttl });
    },
    eval: async () => null,
  };
  return { store, redis };
}

const warnings: unknown[] = [];
const logger = { warn: (fields: Readonly<Record<string, unknown>>) => void warnings.push(fields) };

describe('Redis jump cache (B1-06w)', () => {
  it('[AC-B1-06w] round-trips a jump, expiring with it (at most 900 s), no identity in the key', async () => {
    const clock = new FixedClock('2031-05-06T07:00:00.000Z');
    const { store, redis } = memory();
    const cache = createRedisJumpCache(redis, clock, logger);
    await cache.put(key, entry('2031-05-06T07:10:00.000Z'));
    const [name, stored] = [...store.entries()][0]!;
    expect(stored.ttl).toBe(600);
    expect(name.startsWith('synthetic-app:')).toBe(true);
    expect(name).not.toContain(key.userId!);
    expect(name).not.toContain(key.pid!);
    expect(await cache.get(key)).toEqual(entry('2031-05-06T07:10:00.000Z'));
    expect(await cache.get({ ...key, variant: 'android:true' })).toBeNull();
    await cache.put(key, entry('2031-05-06T09:00:00.000Z'));
    expect([...store.values()][0]!.ttl).toBe(900);
  });

  it('[AC-B1-06w] an expired jump is not written; a malformed value or a Redis failure is a miss', async () => {
    const clock = new FixedClock('2031-05-06T07:00:00.000Z');
    const { store, redis } = memory();
    const cache = createRedisJumpCache(redis, clock, logger);
    await cache.put(key, entry('2031-05-06T06:59:59.000Z'));
    expect(store.size).toBe(0);
    await cache.put(key, entry('2031-05-06T07:10:00.000Z'));
    const name = [...store.keys()][0]!;
    store.set(name, { value: '{', ttl: 1 });
    expect(await cache.get(key)).toBeNull();
    store.set(name, { value: JSON.stringify({ jump: { primary: {} } }), ttl: 1 });
    expect(await cache.get(key)).toBeNull();
    const failing = createRedisJumpCache(
      {
        get: () => Promise.reject(new Error('synthetic outage')),
        set: () => Promise.reject(new Error('synthetic outage')),
        eval: async () => null,
      },
      clock,
      logger,
    );
    expect(await failing.get(key)).toBeNull();
    await expect(failing.put(key, entry('2031-05-06T07:10:00.000Z'))).resolves.toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('[AC-B1-06f] a Baichuan step round-trips only with its sdk pairing intact', async () => {
    const clock = new FixedClock('2031-05-06T07:00:00.000Z');
    const { store, redis } = memory();
    const cache = createRedisJumpCache(redis, clock, logger);
    const sdk: LinkOpenCachedJump = {
      jump: {
        primary: {
          type: 'sdk',
          value: '00012345',
          sdk: {
            provider: 'baichuan',
            open_by: 'code',
            page: 'detail',
            item_id: '00012345',
            taoke: { pid: 'mm_1_2_3', relation_id: 'rel-1' },
          },
        },
        fallbacks: [],
        expire_at: '2031-05-06T07:10:00.000Z',
      },
      fetchedAt: '2031-05-06T07:00:00.000Z',
      variant: 'ios:true',
    };
    await cache.put(key, sdk);
    expect(await cache.get(key)).toEqual(sdk);
    const name = [...store.keys()][0]!;
    for (const primary of [
      { type: 'sdk', value: '00012345' },
      { type: 'sdk', value: 'other', sdk: sdk.jump.primary.sdk },
      { type: 'h5', value: 'https://example.test/u', sdk: sdk.jump.primary.sdk },
    ]) {
      store.set(name, {
        value: JSON.stringify({ ...sdk, jump: { ...sdk.jump, primary } }),
        ttl: 1,
      });
      expect(await cache.get(key)).toBeNull();
    }
    // BaichuanOpen in full: a shape the contract refuses is a miss, never a 200 instruction.
    const code = {
      provider: 'baichuan',
      open_by: 'code',
      page: 'detail',
      item_id: '00012345',
      taoke: { pid: 'mm_1_2_3', relation_id: 'rel-1' },
    };
    const url = { provider: 'baichuan', open_by: 'url', url: 'https://promo.example.test/s' };
    const invalid: [string, Record<string, unknown>][] = [
      ['00012345', { provider: 'baichuan', open_by: 'code', item_id: '00012345' }],
      ['00012345', { ...code, page: undefined }],
      ['00012345', { ...code, page: 'shop' }],
      ['00012345', { ...code, taoke: undefined }],
      ['00012345', { ...code, taoke: {} }],
      ['00012345', { ...code, taoke: { pid: 'synthetic-pid' } }],
      ['00012345', { ...code, taoke: { pid: 'mm_1_2_3', relation_id: '' } }],
      ['00012345', { ...code, taoke: { pid: 'mm_1_2_3', relation_id: 'r'.repeat(33) } }],
      ['00012345', { ...code, taoke: { pid: 'mm_1_2_3', extra: 'x' } }],
      ['00012345', { ...code, url: 'https://promo.example.test/s' }],
      ['00012345', { ...code, sku_id: '' }],
      ['00012345', { ...code, extra: 'x' }],
      ['00012345', { ...code, provider: 'other' }],
      ['https://promo.example.test/s', { ...url, taoke: { pid: 'mm_1_2_3' } }],
      ['https://promo.example.test/s', { ...url, item_id: '00012345' }],
      ['https://promo.example.test/s', { ...url, page: 'detail' }],
      ['https://promo.example.test/s', { ...url, sku_id: '1' }],
      ['https://promo.example.test/s', { ...url, url: undefined }],
      ['not a url', { ...url, url: 'not a url' }],
      ['http://promo.example.test/s', { ...url, url: 'http://promo.example.test/s' }],
    ];
    for (const [value, body] of invalid) {
      const primary = { type: 'sdk', value, sdk: JSON.parse(JSON.stringify(body)) as unknown };
      store.set(name, {
        value: JSON.stringify({ ...sdk, jump: { ...sdk.jump, primary } }),
        ttl: 1,
      });
      expect(await cache.get(key)).toBeNull();
    }
    for (const [value, body] of [
      ['https://promo.example.test/s', url],
      ['00012345', { ...code, sku_id: '67890', taoke: { pid: 'mm_1_2_3' } }],
    ] as const) {
      const primary = { type: 'sdk', value, sdk: body };
      store.set(name, {
        value: JSON.stringify({ ...sdk, jump: { ...sdk.jump, primary } }),
        ttl: 1,
      });
      expect(await cache.get(key)).toMatchObject({ jump: { primary } });
    }
    // The port's cache tag (relation_id) round-trips; a non-string tag is no entry.
    await cache.put(key, { ...sdk, tag: 'relation:rel-1' });
    expect(await cache.get(key)).toMatchObject({ tag: 'relation:rel-1' });
    store.set(name, { value: JSON.stringify({ ...sdk, tag: 7 }), ttl: 1 });
    expect(await cache.get(key)).toBeNull();
  });
});
