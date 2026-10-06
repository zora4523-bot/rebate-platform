// The Lua state machine of the SMS code store against a real Redis (review rounds 1–2): uncommitted
// sends count conservatively over [reservation, reservation + D], the candidate is current only
// once it is sending, a reservation whose reply was lost leaves the code in force valid, a
// rejection puts the previous code back with the candidate's wrong tries, colliding candidates are
// refused, the commit is idempotent per token. Each test uses its own random phone key; the shared
// test Redis is never flushed.
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

/** The in-flight bound D of these tests: an uncommitted send may have been accepted until t + D. */
const D = 15_000;

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
  store = createSmsCodeStore(redis, { inFlightMs: D });
}, 180_000);

afterAll(async () => {
  await context?.close();
  await server?.stop();
});

const at = (time: string, day = '06'): number => new Date(`2026-10-${day}T${time}+08:00`).getTime();
const hex = (): string => randomBytes(32).toString('hex');
function keys(): SmsKeys {
  const phoneKey = hex();
  return { phoneKey, codeKey: `couli:login:${phoneKey}` };
}

/** Reserve and mark: the candidate is sending (the SMS may be out); returns the token. */
async function sending(k: SmsKeys, hash: string, reservedAt: number): Promise<string> {
  const token = hex();
  expect(await store!.reserve(k, token, hash, 'login', reservedAt)).toMatchObject({
    kind: 'reserved',
  });
  expect(await store!.mark(k, token, reservedAt)).toBe(true);
  return token;
}

/** One accepted send: reserve, mark and commit with the same token. */
async function sent(k: SmsKeys, hash: string, reservedAt: number, acceptedAt = reservedAt) {
  const token = await sending(k, hash, reservedAt);
  return { token, release: await store!.commit(k, token, acceptedAt) };
}

const reserveAt = (k: SmsKeys, time: number) => store!.reserve(k, hex(), hex(), 'login', time);

/** The members of the phone's history, without scores (p:, s:, a: plus token). */
async function members(k: SmsKeys): Promise<string[]> {
  return (await redis!.namespace('sms').eval("return redis.call('ZRANGE', KEYS[1], 0, -1)", {
    keys: [`q:${k.phoneKey}`],
    args: [],
    ttlSeconds: 1,
  })) as string[];
}

it('[BR-ID-05] an uncommitted send keeps counting towards its hour after it left the 60-second window', async () => {
  expect(store).toBeDefined();
  const k = keys();
  for (const time of ['10:00:00', '10:10:00', '10:20:00', '10:30:00'])
    await sent(k, hex(), at(time));
  // The fifth goes out, but its commit never runs (Redis failed after the provider answered).
  await sending(k, hex(), at('10:40:00'));
  expect(await reserveAt(k, at('10:41:15'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('11:00:00'),
  });
  expect(await reserveAt(k, at('11:00:00'))).toMatchObject({ kind: 'reserved' });
});

it('[BR-ID-05] a send reserved at 10:59:59 whose commit never runs counts in both hours: 11 o’clock allows only 4 more', async () => {
  expect(store).toBeDefined();
  const k = keys();
  await sending(k, hex(), at('10:59:59'));
  // It may have been accepted up to 11:00:14, so the 60-second window holds until 11:01:14.
  expect(await reserveAt(k, at('11:00:30'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('11:01:14'),
  });
  for (const time of ['11:01:14', '11:10:00', '11:20:00', '11:30:00'])
    await sent(k, hex(), at(time));
  expect(await reserveAt(k, at('11:40:00'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('12:00:00'),
  });
});

it('[BR-ID-05] an uncommitted send holds the 60-second window until t + D + 60 s', async () => {
  expect(store).toBeDefined();
  const k = keys();
  expect(await reserveAt(k, at('10:00:00'))).toEqual({
    kind: 'reserved',
    releaseAtMs: at('10:01:15'),
  });
  expect(await reserveAt(k, at('10:01:14'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('10:01:15'),
  });
  expect(await reserveAt(k, at('10:01:15'))).toMatchObject({ kind: 'reserved' });
});

it('[BR-ID-05] an uncommitted send stays in the rolling 24 hours until now − 24 h passes t + D', async () => {
  expect(store).toBeDefined();
  const k = keys();
  await sending(k, hex(), at('22:10:00'));
  for (const time of ['22:20:00', '22:30:00', '22:40:00', '22:50:00'])
    await sent(k, hex(), at(time));
  for (const time of ['23:10:00', '23:20:00', '23:30:00', '23:40:00', '23:50:00']) {
    await sent(k, hex(), at(time));
  }
  // The natural day of 10-07 is empty; the rolling window still holds ten until 22:10:15.
  expect(await reserveAt(k, at('22:10:00', '07'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('22:10:15', '07'),
  });
  expect(await reserveAt(k, at('22:10:15', '07'))).toMatchObject({ kind: 'reserved' });
});

it('[BR-ID-05] a late commit by the original token counts the send once at acceptance and is idempotent', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const code = hex();
  const token = await sending(k, code, at('10:00:00'));
  expect(await store!.commit(k, token, at('10:00:05'))).toBe(at('10:01:05'));
  // A retry after a lost reply: neither a second count nor a later acceptance time.
  expect(await store!.commit(k, token, at('10:00:30'))).toBe(at('10:01:05'));
  expect(await reserveAt(k, at('10:01:04'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('10:01:05'),
  });
  expect(await store!.verify(k.codeKey, code, at('10:01:00'))).toBe('consumed');
  // Three more and this one make five in the hour: a double count would refuse it.
  for (const time of ['10:10:00', '10:20:00', '10:30:00']) await sent(k, hex(), at(time));
  expect(await reserveAt(k, at('10:40:00'))).toMatchObject({ kind: 'reserved' });
});

it('[BR-ID-05] a reserved candidate is not a code yet: the code in force stays valid and the candidate counts as a wrong try', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  const b = hex();
  await sent(k, a, at('10:00:00'));
  await store!.reserve(k, hex(), b, 'login', at('10:01:00'));
  expect(await store!.verify(k.codeKey, b, at('10:01:01'))).toBe('wrong');
  expect(await store!.verify(k.codeKey, a, at('10:01:02'))).toBe('consumed');
});

it('[BR-ID-05] a reservation whose reply was lost, released by its token, leaves the code in force valid and counts nothing', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  await sent(k, a, at('10:00:00'));
  const lost = hex();
  await store!.reserve(k, lost, hex(), 'login', at('10:01:00'));
  await store!.release(k, lost, at('10:01:00'));
  await store!.release(k, lost, at('10:01:00'));
  expect(await reserveAt(k, at('10:01:00'))).toMatchObject({ kind: 'reserved' });
  const first = keys();
  const token = hex();
  const c = hex();
  await store!.reserve(first, token, c, 'login', at('10:00:00'));
  await store!.release(first, token, at('10:00:01'));
  expect(await store!.verify(first.codeKey, c, at('10:00:02'))).toBe('void');
  expect(await store!.verify(k.codeKey, a, at('10:01:01'))).toBe('consumed');
});

it('[BR-ID-05] when mark does not run the code in force stays valid; mark is idempotent and refuses a token whose candidate is gone', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  await sent(k, a, at('10:00:00'));
  const token = hex();
  await store!.reserve(k, token, hex(), 'login', at('10:01:00'));
  await store!.release(k, token, at('10:01:01'));
  expect(await store!.mark(k, token, at('10:01:02'))).toBe(false);
  expect(await store!.verify(k.codeKey, a, at('10:01:03'))).toBe('consumed');
  const other = keys();
  const twice = hex();
  await store!.reserve(other, twice, hex(), 'login', at('10:00:00'));
  expect(await store!.mark(other, twice, at('10:00:00'))).toBe(true);
  expect(await store!.mark(other, twice, at('10:00:01'))).toBe(true);
  expect(await store!.mark(other, hex(), at('10:00:01'))).toBe(false);
});

it('[BR-ID-05] while a candidate is sending the previous code is void and the candidate verifies, also when the commit never runs', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  const b = hex();
  await sent(k, a, at('10:00:00'));
  const tokenB = await sending(k, b, at('10:01:00'));
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

it('[BR-ID-05] four wrong tries while sending carry over to the committed code: one more voids it', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const b = hex();
  const token = await sending(k, b, at('10:00:00'));
  for (let i = 0; i < 4; i++) {
    expect(await store!.verify(k.codeKey, hex(), at('10:00:01'))).toBe('wrong');
  }
  await store!.commit(k, token, at('10:00:02'));
  expect(await store!.verify(k.codeKey, hex(), at('10:00:03'))).toBe('wrong');
  expect(await store!.verify(k.codeKey, b, at('10:00:04'))).toBe('void');
});

it('[BR-ID-05] a committed code is valid 300 s from its acceptance; a sending one from its reservation', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const b = hex();
  await sent(k, b, at('10:00:00'), at('10:00:10'));
  expect(await store!.verify(k.codeKey, hex(), at('10:05:00'))).toBe('wrong');
  expect(await store!.verify(k.codeKey, b, at('10:05:10'))).toBe('void');
  // Uncommitted, the acceptance time is not known: the earlier reservation time is used.
  const pending = keys();
  const c = hex();
  await sending(pending, c, at('10:00:00'));
  expect(await store!.verify(pending.codeKey, hex(), at('10:04:59'))).toBe('wrong');
  expect(await store!.verify(pending.codeKey, c, at('10:05:00'))).toBe('void');
});

it('[BR-ID-05] a definite rejection drops the sending candidate and puts the previous code back with the candidate’s wrong tries', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  const b = hex();
  await sent(k, a, at('10:00:00'));
  const tokenB = await sending(k, b, at('10:01:00'));
  expect(await store!.verify(k.codeKey, a, at('10:01:01'))).toBe('void');
  for (let i = 0; i < 3; i++) {
    expect(await store!.verify(k.codeKey, hex(), at('10:01:02'))).toBe('wrong');
  }
  await store!.release(k, tokenB, at('10:01:03'));
  // Three tries carried over: the fourth wrong try leaves one, and the code still verifies.
  expect(await store!.verify(k.codeKey, b, at('10:01:04'))).toBe('wrong');
  expect(await store!.verify(k.codeKey, a, at('10:01:05'))).toBe('consumed');
  // The released reservation does not hold the 60-second window.
  expect(await reserveAt(k, at('10:01:06'))).toMatchObject({ kind: 'reserved' });

  const full = keys();
  const old = hex();
  await sent(full, old, at('10:00:00'));
  for (let i = 0; i < 2; i++) await store!.verify(full.codeKey, hex(), at('10:00:30'));
  const token = await sending(full, hex(), at('10:01:00'));
  for (let i = 0; i < 3; i++) await store!.verify(full.codeKey, hex(), at('10:01:01'));
  await store!.release(full, token, at('10:01:02'));
  // Two plus three wrong tries: the previous code is void instead of a fresh probe target.
  expect(await store!.verify(full.codeKey, old, at('10:01:03'))).toBe('void');
});

it('[BR-ID-05] a candidate equal to the current, the pending or a void code is a collision and writes nothing', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  await sent(k, a, at('10:00:00'));
  expect(await store!.reserve(k, hex(), a, 'login', at('10:01:00'))).toEqual({ kind: 'collision' });
  // Nothing was reserved by the collision: the next draw passes at the same instant.
  const b = hex();
  await sent(k, b, at('10:01:00'));
  // a is void now (replaced by b); b is current.
  expect(await store!.reserve(k, hex(), a, 'login', at('10:02:00'))).toEqual({ kind: 'collision' });
  expect(await store!.reserve(k, hex(), b, 'login', at('10:02:00'))).toEqual({ kind: 'collision' });
  const c = hex();
  await sending(k, c, at('10:02:00'));
  expect(await store!.reserve(k, hex(), c, 'login', at('10:03:15'))).toEqual({ kind: 'collision' });
  expect(await store!.verify(k.codeKey, c, at('10:03:16'))).toBe('consumed');
});

it('[BR-ID-05] the next reservation puts a sending candidate in force and drops a reserved one with its reservation', async () => {
  expect(store).toBeDefined();
  // Sending (it may have gone out): in force, the previous code stays void.
  const k = keys();
  const a = hex();
  const b = hex();
  await sent(k, a, at('10:00:00'));
  await sending(k, b, at('10:01:00'));
  const tokenC = hex();
  await store!.reserve(k, tokenC, hex(), 'login', at('10:02:15'));
  await store!.release(k, tokenC, at('10:02:16'));
  expect(await store!.verify(k.codeKey, a, at('10:02:17'))).toBe('void');
  expect(await store!.verify(k.codeKey, b, at('10:02:18'))).toBe('consumed');

  // Reserved (never sent): dropped with its reservation once it cannot be in flight any more.
  const r = keys();
  const old = hex();
  await sent(r, old, at('10:00:00'));
  await store!.reserve(r, hex(), hex(), 'login', at('10:01:00'));
  expect(await reserveAt(r, at('10:02:14'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('10:02:15'),
  });
  const tokenD = hex();
  expect(await store!.reserve(r, tokenD, hex(), 'login', at('10:02:15'))).toMatchObject({
    kind: 'reserved',
  });
  await store!.commit(r, tokenD, at('10:02:15'));
  // The dropped reservation counts for nothing: with it, 10:30 would be the sixth of the hour.
  for (const time of ['10:10:00', '10:20:00']) await sent(r, hex(), at(time));
  expect(await reserveAt(r, at('10:30:00'))).toMatchObject({ kind: 'reserved' });
});

it('[BR-ID-05] the history records the state of a send: p: when reserved, s: once marked, a: once committed', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const token = hex();
  await store!.reserve(k, token, hex(), 'login', at('10:00:00'));
  expect(await members(k)).toEqual([`p:${token}`]);
  expect(await store!.mark(k, token, at('10:00:01'))).toBe(true);
  expect(await members(k)).toEqual([`s:${token}`]);
  await store!.commit(k, token, at('10:00:02'));
  expect(await members(k)).toEqual([`a:${token}`]);
});

it('[BR-ID-05] mark refuses a reservation older than D, so nothing is sent and the code in force stays valid', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  await sent(k, a, at('10:00:00'));
  const token = hex();
  await store!.reserve(k, token, hex(), 'login', at('10:01:00'));
  expect(await store!.mark(k, token, at('10:01:15.001'))).toBe(false);
  expect(await members(k)).toContain(`p:${token}`);
  await store!.release(k, token, at('10:01:16'));
  expect(await store!.verify(k.codeKey, a, at('10:01:17'))).toBe('consumed');
  // Within D it marks, and a retry after the deadline still answers 1: it was marked in time.
  const other = keys();
  const marked = hex();
  await store!.reserve(other, marked, hex(), 'login', at('10:00:00'));
  expect(await store!.mark(other, marked, at('10:00:15'))).toBe(true);
  expect(await store!.mark(other, marked, at('10:00:30'))).toBe(true);
});

it('[BR-ID-05] an unmarked reservation left by an expired code key or another purpose is dropped after t + D + 60 s and no longer counts', async () => {
  expect(store).toBeDefined();
  const phoneKey = hex();
  const login: SmsKeys = { phoneKey, codeKey: `couli:login:${phoneKey}` };
  const bind: SmsKeys = { phoneKey, codeKey: `couli:bind:${phoneKey}` };
  const orphan = hex();
  await store!.reserve(login, orphan, hex(), 'login', at('10:00:00'));
  // Its code record is gone (as after the 300 s TTL): nothing on the code key can clean it.
  await redis!.namespace('sms').eval("return redis.call('DEL', KEYS[1])", {
    keys: [`c:${login.codeKey}`],
    args: [],
    ttlSeconds: 1,
  });
  // Another purpose of the same phone: held until 10:01:15, then the orphan is gone.
  expect(await reserveAt(bind, at('10:01:14'))).toEqual({
    kind: 'limited',
    releaseAtMs: at('10:01:15'),
  });
  await sent(bind, hex(), at('10:01:15'));
  expect(await members(login)).not.toContain(`p:${orphan}`);
  // With the orphan still counted, 10:40 would be the sixth send of the hour.
  for (const time of ['10:10:00', '10:20:00', '10:30:00']) await sent(bind, hex(), at(time));
  expect(await reserveAt(bind, at('10:40:00'))).toMatchObject({ kind: 'reserved' });
});

it('[BR-ID-05] a sending candidate consumed or voided before its release does not bring the previous code back', async () => {
  expect(store).toBeDefined();
  const k = keys();
  const a = hex();
  const b = hex();
  await sent(k, a, at('10:00:00'));
  const token = await sending(k, b, at('10:01:00'));
  expect(await store!.verify(k.codeKey, b, at('10:01:01'))).toBe('consumed');
  await store!.release(k, token, at('10:01:02'));
  expect(await store!.verify(k.codeKey, a, at('10:01:03'))).toBe('void');
  expect(await store!.verify(k.codeKey, b, at('10:01:04'))).toBe('void');

  const v = keys();
  const old = hex();
  await sent(v, old, at('10:00:00'));
  const voided = await sending(v, hex(), at('10:01:00'));
  for (let i = 0; i < 5; i++) {
    expect(await store!.verify(v.codeKey, hex(), at('10:01:01'))).toBe('wrong');
  }
  await store!.release(v, voided, at('10:01:02'));
  expect(await store!.verify(v.codeKey, old, at('10:01:03'))).toBe('void');
});
