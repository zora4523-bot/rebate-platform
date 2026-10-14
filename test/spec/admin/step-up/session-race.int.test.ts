import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { RedisNamespace } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { fixture, useHarness } from '../auth/kit.ts';
import { redisOf } from './kit.ts';

const h = useHarness();

it('[AC-F1-06l#31] 并发续期中旧请求晚落库不覆盖较新的 lastSeen；退出也不能被续期复活', async () => {
  const f = await fixture(h);
  const clock = new FixedClock(f.clock.now());
  const redis = (await redisOf(f)).namespace('admin-auth');
  const ordinary = createAdminSessions({ clock, redis });
  // Delay only the older request at the Redis boundary; no sleep, deterministic interleaving.
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const delayed: RedisNamespace = {
    get: (key) => redis.get(key),
    set: (key, value, ttl) => redis.set(key, value, ttl),
    async eval(script, options) {
      entered();
      await gate;
      return redis.eval(script, options);
    },
  };
  const olderWriter = createAdminSessions({ clock, redis: delayed });
  const id = randomUUID();
  const record = {
    adminId: randomUUID(),
    appId: 'couli',
    expiresAtMs: clock.now().getTime() + 28_800_000,
    lastSeenMs: clock.now().getTime(),
  };
  await ordinary.create(id, record);
  const old = { ...record, lastSeenMs: record.lastSeenMs + 10_000 };
  const newer = { ...record, lastSeenMs: record.lastSeenMs + 20_000 };
  const inFlight = olderWriter.touch(id, old);
  try {
    await arrived;
    expect(await ordinary.touch(id, newer)).toBe(true);
  } finally {
    resume();
    await inFlight;
  }
  expect(await ordinary.read(id)).toEqual(newer);
  await ordinary.revoke(id);
  expect(await olderWriter.touch(id, { ...newer, lastSeenMs: newer.lastSeenMs + 1 })).toBe(false);
  expect(await ordinary.read(id)).toBeUndefined();
}, 30_000);
