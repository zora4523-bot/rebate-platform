// The Lua state machine of the SMS code store against a real Redis (review round 1): an
// uncommitted send keeps counting, the candidate is current while it is out, a rejection puts the
// previous code back, colliding candidates are refused, the commit is idempotent per token.
// Each test uses its own random phone key; the shared test Redis is never flushed.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { acquireTestRedis, type TestRedis } from '@couli/db/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FixedClock,
  PlatformModule,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type RedisHandle,
} from '../../platform/index.ts';
import { createSmsCodeStore, type SmsCodeStore, type SmsKeys } from './sms-code-store.ts';

let server: TestRedis | undefined;
let context: INestApplicationContext | undefined;
let redis: RedisHandle | undefined;
let store: SmsCodeStore | undefined;

beforeAll(async () => {
  server = await acquireTestRedis();
  context = await NestFactory.createApplicationContext(
    PlatformModule.forRoot({
      entry: 'api',
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock('2026-10-06T10:00:00+08:00'),
      logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
      redisUrl: loadConnectionConfig('api', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: server.url,
      }).redisUrl,
    }),
    { logger: false },
  );
  redis = context.get<RedisHandle>(REDIS);
  store = createSmsCodeStore(redis);
}, 180_000);

afterAll(async () => {
  await context?.close();
  await server?.stop();
});

const at = (time: string): number => new Date(`2026-10-06T${time}+08:00`).getTime();
const hex = (): string => randomBytes(32).toString('hex');
function keys(): SmsKeys {
  const phoneKey = hex();
  return { phoneKey, codeKey: `couli:login:${phoneKey}` };
}

/** One accepted send: reserve and commit with the same token. */
async function sent(k: SmsKeys, hash: string, reservedAt: number, acceptedAt = reservedAt) {
  const token = hex();
  expect(await store!.reserve(k, token, hash, 'login', reservedAt)).toMatchObject({
    kind: 'reserved',
  });
  return { token, release: await store!.commit(k, token, acceptedAt) };
}

it('[BR-ID-05] an uncommitted send leaves the 60-second window after 60 s but keeps counting towards the hour', async () => {
  expect(store).toBeDefined();
  const k = keys();
  for (const time of ['10:00:00', '10:10:00', '10:20:00', '10:30:00'])
    await sent(k, hex(), at(time));
  // The fifth is accepted, but its commit never runs (Redis failed after the provider answered).
  expect(await store!.reserve(k, hex(), hex(), 'login', at('10:40:00'))).toEqual({
    kind: 'reserved',
    releaseAtMs: at('11:00:00'),
  });
  expect(await store!.reserve(k, hex(), hex(), 'login', at('10:40:59'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('11:00:00'),
  });
  // A minute later it no longer blocks as an in-flight send, and it still counts as the fifth.
  expect(await store!.reserve(k, hex(), hex(), 'login', at('10:41:00'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('11:00:00'),
  });
  expect(await store!.reserve(k, hex(), hex(), 'login', at('11:00:00'))).toMatchObject({
    kind: 'reserved',
  });
});

it('[BR-ID-05] an uncommitted send blocks the phone for 60 s from its reservation, then lets the next one through', async () => {
  expect(store).toBeDefined();
  const k = keys();
  expect(await store!.reserve(k, hex(), hex(), 'login', at('10:00:00'))).toMatchObject({
    kind: 'reserved',
  });
  expect(await store!.reserve(k, hex(), hex(), 'login', at('10:00:59'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('10:01:00'),
  });
  expect(await store!.reserve(k, hex(), hex(), 'login', at('10:01:00'))).toMatchObject({
    kind: 'reserved',
  });
});

it('[BR-ID-05] a late commit by the original token counts the send once at acceptance and is idempotent', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const token = hex();
  const code = hex();
  await store!.reserve(k, token, code, 'login', at('10:00:00'));
  expect(await store!.commit(k, token, at('10:00:05'))).toBe(at('10:01:05'));
  // A retry after a lost reply: neither a second count nor a later acceptance time.
  expect(await store!.commit(k, token, at('10:00:30'))).toBe(at('10:01:05'));
  expect(await store!.reserve(k, hex(), hex(), 'login', at('10:01:04'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('10:01:05'),
  });
  expect(await store!.verify(k.codeKey, code, at('10:01:00'))).toBe('consumed');
  // Three more and this one make five in the hour: a double count would refuse it.
  for (const time of ['10:10:00', '10:20:00', '10:30:00']) await sent(k, hex(), at(time));
  expect(await store!.reserve(k, hex(), hex(), 'login', at('10:40:00'))).toMatchObject({
    kind: 'reserved',
  });
});

it('[BR-ID-05] while a candidate is out the previous code is void and the candidate verifies, also when the commit never runs', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  const b = hex();
  await sent(k, a, at('10:00:00'));
  const tokenB = hex();
  await store!.reserve(k, tokenB, b, 'login', at('10:01:00'));
  expect(await store!.verify(k.codeKey, a, at('10:01:01'))).toBe('void');
  // Wrong tries count against the candidate, not against the void code.
  expect(await store!.verify(k.codeKey, hex(), at('10:01:02'))).toBe('wrong');
  expect(await store!.verify(k.codeKey, b, at('10:01:03'))).toBe('consumed');
  expect(await store!.verify(k.codeKey, a, at('10:01:04'))).toBe('void');
  // A commit after the candidate was consumed counts the send but never revives the code.
  await store!.commit(k, tokenB, at('10:01:05'));
  expect(await store!.verify(k.codeKey, b, at('10:01:06'))).toBe('void');
  // Every key the store wrote carries a TTL: 25 h of history, 300 s of codes.
  const ttl = async (key: string) =>
    (await redis!.namespace('sms').eval("return redis.call('PTTL', KEYS[1])", {
      keys: [key],
      args: [],
      ttlSeconds: 1,
    })) as number;
  const quota = await ttl(`q:${k.phoneKey}`);
  expect(quota).toBeGreaterThan(89_000_000);
  expect(quota).toBeLessThanOrEqual(90_000_000);
  const codes = await ttl(`c:${k.codeKey}`);
  expect(codes).toBeGreaterThan(0);
  expect(codes).toBeLessThanOrEqual(300_000);
});

it('[BR-ID-05] a definite rejection drops the candidate, puts the previous code back and counts nothing', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  const b = hex();
  await sent(k, a, at('10:00:00'));
  const tokenB = hex();
  await store!.reserve(k, tokenB, b, 'login', at('10:01:00'));
  expect(await store!.verify(k.codeKey, a, at('10:01:01'))).toBe('void');
  await store!.release(k, tokenB, at('10:01:02'));
  expect(await store!.verify(k.codeKey, b, at('10:01:03'))).toBe('wrong');
  // The released reservation does not hold the 60-second window.
  expect(await store!.reserve(k, hex(), hex(), 'login', at('10:01:04'))).toMatchObject({
    kind: 'reserved',
  });
  const first = keys();
  const c = hex();
  const tokenC = hex();
  await store!.reserve(first, tokenC, c, 'login', at('10:00:00'));
  await store!.release(first, tokenC, at('10:00:01'));
  expect(await store!.verify(first.codeKey, c, at('10:00:02'))).toBe('void');

  const restored = keys();
  const old = hex();
  await sent(restored, old, at('10:00:00'));
  const tokenD = hex();
  await store!.reserve(restored, tokenD, hex(), 'login', at('10:01:00'));
  await store!.release(restored, tokenD, at('10:01:01'));
  expect(await store!.verify(restored.codeKey, old, at('10:01:02'))).toBe('consumed');
});

it('[BR-ID-05] a candidate equal to the current, the pending or a void code is a collision and writes nothing', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  await sent(k, a, at('10:00:00'));
  expect(await store!.reserve(k, hex(), a, 'login', at('10:01:00'))).toEqual({ kind: 'collision' });
  // Nothing was reserved by the collision: the next draw passes at the same instant.
  const b = hex();
  const tokenB = hex();
  expect(await store!.reserve(k, tokenB, b, 'login', at('10:01:00'))).toMatchObject({
    kind: 'reserved',
  });
  await store!.commit(k, tokenB, at('10:01:00'));
  // a is void now (replaced by b); b is current.
  expect(await store!.reserve(k, hex(), a, 'login', at('10:02:00'))).toEqual({ kind: 'collision' });
  expect(await store!.reserve(k, hex(), b, 'login', at('10:02:00'))).toEqual({ kind: 'collision' });
  const c = hex();
  await store!.reserve(k, hex(), c, 'login', at('10:02:00'));
  expect(await store!.reserve(k, hex(), c, 'login', at('10:03:00'))).toEqual({ kind: 'collision' });
  expect(await store!.verify(k.codeKey, c, at('10:03:01'))).toBe('consumed');
});

it('[BR-ID-05] an earlier candidate never committed nor released counts as sent when the next one is reserved', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  const b = hex();
  await sent(k, a, at('10:00:00'));
  await store!.reserve(k, hex(), b, 'login', at('10:01:00'));
  const tokenC = hex();
  await store!.reserve(k, tokenC, hex(), 'login', at('10:02:00'));
  await store!.release(k, tokenC, at('10:02:01'));
  // b went out (or may have): it is in force, and a stays void.
  expect(await store!.verify(k.codeKey, a, at('10:02:02'))).toBe('void');
  expect(await store!.verify(k.codeKey, b, at('10:02:03'))).toBe('consumed');
});
