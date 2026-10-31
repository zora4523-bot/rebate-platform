// Leases on the shared TEST_REDIS_URL (CT-06zzu), with an injected command runner: no Redis, no
// listening socket.
import { afterEach, expect, it, vi } from 'vitest';

import {
  LEASE_KEY_PREFIX,
  LEASE_RENEW_MS,
  LEASE_RETRY_MS,
  LEASE_TTL_MS,
  LEASE_WAIT_MS,
  RedisErrorReply,
  leaseTestRedis,
  parseReply,
  type RedisCommandRunner,
  type RedisReply,
} from './redis.ts';

const URL_WITH_SECRET = 'redis://lease-user:s%40cret@redis.test:6390/0';

type Call = string[][];

/**
 * A tiny in-memory Redis that understands the lease scripts: lease keys live in database 0,
 * `held` keys belong to other holders, `failures` are connection error codes thrown by the next
 * round trips. Plain SELECT / FLUSHDB / SET are refused: everything must go through a script.
 */
function fakeRedis(
  options: { databases?: number; held?: Record<number, string>; failures?: string[] } = {},
) {
  const databases = options.databases ?? 16;
  const leases = new Map<string, string>();
  for (const [n, owner] of Object.entries(options.held ?? {}))
    leases.set(LEASE_KEY_PREFIX + n, owner);
  const failures = [...(options.failures ?? [])];
  const calls: Call[] = [];
  const flushes: number[] = [];
  const run: RedisCommandRunner = (_url, commands) => {
    calls.push(commands.map((command) => [...command]));
    const failure = failures.shift();
    if (failure !== undefined)
      return Promise.reject(
        Object.assign(new Error(`Redis probe failed: ${failure}`), { code: failure }),
      );
    const replies = commands.map((command): RedisReply => {
      const [name, script = '', numkeys = '0', ...rest] = command;
      if (name === 'CONFIG') return ['databases', String(databases)];
      if (name !== 'EVAL') return new RedisErrorReply(`ERR ${String(name)} outside a script`);
      const keys = rest.slice(0, Number(numkeys));
      const argv = rest.slice(Number(numkeys));
      if (script.includes('ipairs')) {
        for (const [i, key] of keys.entries()) {
          if (leases.has(key)) continue;
          leases.set(key, argv[0] ?? '');
          return Number(argv[i + 2]);
        }
        return 0;
      }
      const [key = ''] = keys;
      if (leases.get(key) !== argv[0]) return 0;
      if (script.includes('FLUSHDB')) {
        const db = Number(argv[1]);
        if (!(db >= 0 && db < databases))
          return new RedisErrorReply('ERR DB index is out of range');
        flushes.push(db);
        return 1;
      }
      if (script.includes("'DEL'")) leases.delete(key);
      return 1;
    });
    return Promise.resolve(replies);
  };
  const scripts = (marker: string): string[][] =>
    calls.flat().filter((command) => command[0] === 'EVAL' && command[1]?.includes(marker));
  return { run, calls, leases, flushed: () => [...flushes], scripts };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('[CT-06zzu#1] reads the database count with CONFIG GET and never leases databases 0 and 13', async () => {
  const fake = fakeRedis({ databases: 15 });
  const held: Awaited<ReturnType<typeof leaseTestRedis>>[] = [];
  for (let i = 0; i < 13; i += 1) held.push(await leaseTestRedis(URL_WITH_SECRET, fake));
  expect(fake.calls[0]).toEqual([['CONFIG', 'GET', 'databases']]);
  const dbs = held.map((redis) => Number(new URL(redis.url).pathname.slice(1)));
  expect(dbs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]);
  expect([...fake.leases.keys()]).not.toContain(`${LEASE_KEY_PREFIX}0`);
  expect([...fake.leases.keys()]).not.toContain(`${LEASE_KEY_PREFIX}13`);
  expect(fake.flushed()).not.toContain(0);
  expect(fake.flushed()).not.toContain(13);
  for (const redis of held) await redis.stop();
});

it('[CT-06zzu#2] the url only changes the database path and keeps host, port and credentials', async () => {
  const fake = fakeRedis({ held: { 1: 'other', 2: 'other' } });
  const redis = await leaseTestRedis(URL_WITH_SECRET, fake);
  expect(redis.source).toBe('env');
  expect(redis.url).toBe('redis://lease-user:s%40cret@redis.test:6390/3');
  const noPath = await leaseTestRedis('redis://:pw@10.0.0.7:6379', fake);
  expect(noPath.url).toBe('redis://:pw@10.0.0.7:6379/4');
  await redis.stop();
  await noPath.stop();
});

it('[CT-06zzu#3] one lease script tries every candidate with SET NX PX and takes the first free one', async () => {
  const fake = fakeRedis({ databases: 5, held: { 1: 'other', 2: 'other' } });
  const redis = await leaseTestRedis(URL_WITH_SECRET, { ...fake, token: () => 'tok-3' });
  const [lease] = fake.scripts('ipairs');
  expect(fake.scripts('ipairs')).toHaveLength(1);
  expect(lease?.[1]).toContain("'SET', key, ARGV[1], 'NX', 'PX', ARGV[2]");
  expect(lease?.slice(2)).toEqual([
    '4',
    `${LEASE_KEY_PREFIX}1`,
    `${LEASE_KEY_PREFIX}2`,
    `${LEASE_KEY_PREFIX}3`,
    `${LEASE_KEY_PREFIX}4`,
    'tok-3',
    String(LEASE_TTL_MS),
    '1',
    '2',
    '3',
    '4',
  ]);
  expect(redis.url.endsWith('/3')).toBe(true);
  // Leased, then flushed by the atomic check-and-flush script.
  expect(fake.calls.at(-1)).toEqual([
    ['EVAL', expect.stringContaining('FLUSHDB'), '1', `${LEASE_KEY_PREFIX}3`, 'tok-3', '3'],
  ]);
  expect(fake.flushed()).toEqual([3]);
  expect(fake.leases.get(`${LEASE_KEY_PREFIX}1`)).toBe('other');
  expect(fake.calls.flat().filter((command) => command[0] !== 'EVAL')).toEqual([
    ['CONFIG', 'GET', 'databases'],
  ]);
  await redis.stop();
});

it('[CT-06zzu#4] waits at a fixed interval while every database is leased and fails at the limit without the URL', async () => {
  const fake = fakeRedis({ databases: 4, held: { 1: 'a', 2: 'b', 3: 'c' } });
  let clock = 1_000;
  const sleeps: number[] = [];
  const attempt = leaseTestRedis(URL_WITH_SECRET, {
    ...fake,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    waitMs: 1_000,
  });
  const error = await attempt.then(
    () => undefined,
    (reason: unknown) => reason as Error,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toMatch(/leased/);
  expect(error?.message).not.toMatch(/redis:|lease-user|s%40cret|s@cret|redis\.test|6390/);
  expect(sleeps.length).toBe(1_000 / LEASE_RETRY_MS);
  expect(new Set(sleeps)).toEqual(new Set([LEASE_RETRY_MS]));
  expect(fake.flushed()).toEqual([]);
});

it('[CT-06zzu#4] a database freed while waiting is leased', async () => {
  const fake = fakeRedis({ databases: 3, held: { 1: 'a', 2: 'b' } });
  const redis = await leaseTestRedis(URL_WITH_SECRET, {
    ...fake,
    sleep: () => {
      fake.leases.delete(`${LEASE_KEY_PREFIX}2`);
      return Promise.resolve();
    },
  });
  expect(redis.url.endsWith('/2')).toBe(true);
  await redis.stop();
});

it('[CT-06zzu#5] stop is idempotent, flushes only the leased database and releases with the token', async () => {
  const fake = fakeRedis({ held: { 1: 'other' } });
  const redis = await leaseTestRedis(URL_WITH_SECRET, { ...fake, token: () => 'tok-mine' });
  const before = fake.calls.length;
  await Promise.all([redis.stop(), redis.stop()]);
  await redis.stop();
  const stopCalls = fake.calls.slice(before);
  // One script checks the token and flushes, then release compares the token.
  expect(stopCalls).toEqual([
    [['EVAL', expect.stringContaining('FLUSHDB'), '1', `${LEASE_KEY_PREFIX}2`, 'tok-mine', '2']],
    [['EVAL', expect.stringContaining("'DEL'"), '1', `${LEASE_KEY_PREFIX}2`, 'tok-mine']],
  ]);
  const flushScript = stopCalls[0]?.[0]?.[1] ?? '';
  // The token check comes before SELECT, and SELECT before FLUSHDB.
  expect(flushScript.indexOf("redis.call('GET', KEYS[1]) ~= ARGV[1]")).toBeGreaterThanOrEqual(0);
  expect(flushScript.indexOf("'GET'")).toBeLessThan(flushScript.indexOf("'SELECT'"));
  expect(flushScript.indexOf("'SELECT'")).toBeLessThan(flushScript.indexOf("'FLUSHDB'"));
  expect(stopCalls[1]?.[0]?.[1]).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
  expect(fake.flushed()).toEqual([2, 2]);
  expect(fake.leases.has(`${LEASE_KEY_PREFIX}2`)).toBe(false);
  expect(fake.leases.get(`${LEASE_KEY_PREFIX}1`)).toBe('other');
  // No bare SELECT or FLUSHDB is ever sent: a failed SELECT can never leave FLUSHDB on database 0.
  expect(fake.calls.flat().filter((command) => command[0] !== 'EVAL')).toEqual([
    ['CONFIG', 'GET', 'databases'],
  ]);
});

it('[CT-06zzu#5] stop neither flushes nor deletes when the token no longer holds the lease', async () => {
  const fake = fakeRedis();
  const redis = await leaseTestRedis(URL_WITH_SECRET, { ...fake, token: () => 'tok-old' });
  expect(fake.flushed()).toEqual([1]);
  fake.leases.set(`${LEASE_KEY_PREFIX}1`, 'tok-new');
  const before = fake.calls.length;
  await redis.stop();
  await redis.stop();
  expect(fake.flushed()).toEqual([1]);
  // Only the check-and-flush script, which found another token and flushed nothing; no DEL.
  expect(fake.calls.slice(before)).toEqual([
    [['EVAL', expect.stringContaining('FLUSHDB'), '1', `${LEASE_KEY_PREFIX}1`, 'tok-old', '1']],
  ]);
  expect(fake.leases.get(`${LEASE_KEY_PREFIX}1`)).toBe('tok-new');
});

it('[CT-06zzu#6] a renewal that finds the lease lost stops renewing, and stop then sends no FLUSHDB', async () => {
  vi.useFakeTimers();
  const fake = fakeRedis();
  const redis = await leaseTestRedis(URL_WITH_SECRET, { ...fake, token: () => 'tok-a' });
  // The lease expired (event loop stalled) and another file leased database 1.
  fake.leases.set(`${LEASE_KEY_PREFIX}1`, 'tok-b');
  await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
  const renewals = (): number =>
    fake.calls.flat().filter((command) => command[0] === 'EVAL' && command[1]?.includes('PEXPIRE'))
      .length;
  expect(renewals()).toBe(1);
  await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS * 3);
  expect(renewals()).toBe(1);
  const before = fake.calls.length;
  await redis.stop();
  expect(fake.calls.slice(before)).toEqual([]);
  expect(fake.flushed()).toEqual([1]);
  expect(fake.leases.get(`${LEASE_KEY_PREFIX}1`)).toBe('tok-b');
});

it('[CT-06zzu#6] renews the lease on an unref timer with the token and stops renewing on stop', async () => {
  vi.useFakeTimers();
  const spy = vi.spyOn(globalThis, 'setInterval');
  const fake = fakeRedis();
  const redis = await leaseTestRedis(URL_WITH_SECRET, { ...fake, token: () => 'tok-r' });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]?.[1]).toBe(LEASE_RENEW_MS);
  const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
  expect(timer.hasRef()).toBe(false);

  await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
  const renewals = (): Call =>
    fake.calls.flat().filter((command) => command[0] === 'EVAL' && command[1]?.includes('PEXPIRE'));
  expect(renewals()).toEqual([
    [
      'EVAL',
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      '1',
      `${LEASE_KEY_PREFIX}1`,
      'tok-r',
      String(LEASE_TTL_MS),
    ],
  ]);
  expect(LEASE_RENEW_MS).toBeLessThan(LEASE_TTL_MS);

  await redis.stop();
  await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS * 3);
  expect(renewals()).toHaveLength(1);
});

it('[CT-06zzu#7] connection errors while waiting are retried within the same limit', async () => {
  const fake = fakeRedis({
    held: { 1: 'other' },
    failures: ['ECONNRESET', 'EADDRNOTAVAIL', 'ETIMEDOUT', 'ECLOSED'],
  });
  const sleeps: number[] = [];
  const redis = await leaseTestRedis(URL_WITH_SECRET, {
    ...fake,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  expect(sleeps).toEqual([LEASE_RETRY_MS, LEASE_RETRY_MS, LEASE_RETRY_MS, LEASE_RETRY_MS]);
  expect(redis.url.endsWith('/2')).toBe(true);
  await redis.stop();
});

it('[CT-06zzu#7] errors never put the URL in the message: lasting connection errors, refusals, no database count', async () => {
  let clock = 0;
  const failing: RedisCommandRunner = () =>
    Promise.reject(
      Object.assign(new Error('Redis probe failed: ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
  const sleeps: number[] = [];
  const error = await leaseTestRedis(URL_WITH_SECRET, {
    run: failing,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  }).then(
    () => undefined,
    (reason: unknown) => reason as Error,
  );
  expect(error?.message).toContain('ECONNREFUSED');
  expect(error?.message).not.toMatch(/redis:|lease-user|cret|redis\.test/);
  expect(sleeps.length).toBe(LEASE_WAIT_MS / LEASE_RETRY_MS);

  const wrongPassword: RedisCommandRunner = () =>
    Promise.reject(
      Object.assign(new Error('Redis probe failed: WRONGPASS'), { code: 'WRONGPASS' }),
    );
  const denied = await leaseTestRedis(URL_WITH_SECRET, {
    run: wrongPassword,
    sleep: () => Promise.reject(new Error('an auth error is not retried')),
  }).then(
    () => undefined,
    (reason: unknown) => reason as Error,
  );
  expect(denied?.message).toContain('WRONGPASS');
  expect(denied?.message).not.toMatch(/redis:|lease-user|cret|redis\.test/);

  const noConfig: RedisCommandRunner = () =>
    Promise.resolve([new RedisErrorReply('ERR unknown command CONFIG')]);
  const refused = await leaseTestRedis(URL_WITH_SECRET, { run: noConfig }).then(
    () => undefined,
    (reason: unknown) => reason as Error,
  );
  expect(refused?.message).toMatch(/database count/);
  expect(refused?.message).not.toMatch(/redis:|lease-user|cret|redis\.test/);
});

it('[CT-06zzu#8] parseReply reads RESP2 replies and waits for incomplete ones', () => {
  const wire = Buffer.from('*2\r\n$9\r\ndatabases\r\n$2\r\n16\r\n+OK\r\n:1\r\n$-1\r\n-ERR no\r\n');
  const replies: RedisReply[] = [];
  let at = 0;
  for (;;) {
    const parsed = parseReply(wire, at);
    if (parsed === undefined) break;
    replies.push(parsed.reply);
    at = parsed.next;
  }
  expect(replies).toEqual([['databases', '16'], 'OK', 1, null, new RedisErrorReply('ERR no')]);
  expect(parseReply(Buffer.from('$5\r\nab'))).toBeUndefined();
  expect(parseReply(Buffer.from('*2\r\n+OK\r\n'))).toBeUndefined();
});
