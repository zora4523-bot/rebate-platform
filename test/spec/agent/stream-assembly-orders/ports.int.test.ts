// B3-08g · BR-AI-03 on the composition root: the real stream AppModule (bootstrap.createHttpApp, no
// listen) + real PG. agentStreamPortsToken()'s value gains orders' read-only queries (the three
// methods the order tools use), linking's link_logs reader and the daily counter; without a
// database the value stays null (B3-03j). The counter is Redis: without Redis, or when Redis fails,
// it rejects (fail-closed); with Redis the key is the caller's and it expires at the given instant.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { Logs, ManualTime, usePgEach } from '../stream-mount/kit.ts';
import { APP, bootStream, fakeRedis, present } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** The next +08:00 midnight after the ManualTime start (2026-10-06T02:00Z → 2026-10-06T16:00Z). */
function nextMidnight(time: ManualTime): Date {
  const now = time.clock.now().getTime();
  const day = 86_400_000;
  const offset = 8 * 3_600_000;
  return new Date(Math.floor((now + offset) / day) * day + day - offset);
}

it('[AC-B3-08g#5][BR-AI-03] stream 入口（有库）提供 orders（searchForAgent / findOwnByNumber / get，真实只读查询）、claimEntries.read、dailyCounter；无 Redis 时计数拒绝；无库时端口值仍为 null', async () => {
  const time = new ManualTime();
  const logs = new Logs();
  const { app, ports } = await bootStream({ db: pg.db, time, logs });
  try {
    const value = present(ports, 'agentStreamPortsToken() value with a database');
    const orders = present(value.orders, 'ports.orders');
    for (const method of ['searchForAgent', 'findOwnByNumber', 'get'] as const) {
      expect(typeof orders[method], `orders.${method}`).toBe('function');
    }
    const claimEntries = present(value.claimEntries, 'ports.claimEntries');
    expect(typeof claimEntries.read).toBe('function');
    const counter = present(value.dailyCounter, 'ports.dailyCounter');
    expect(typeof counter.incr).toBe('function');

    // orders' real queries over this database (nothing stored: nothing found).
    const subject = { app_id: APP, user_id: randomUUID() };
    expect(
      await orders.searchForAgent(subject, { date_from: '2026-10-01', date_to: '2026-10-06' }),
    ).toEqual({ orders: [], total: 0 });
    expect(await orders.findOwnByNumber(subject, { order_no: '3900112233445566778' })).toEqual([]);
    expect(await orders.get(subject, randomUUID())).toBeNull();
    // linking's real link_logs reader.
    const facts = await claimEntries.read({
      ...subject,
      from: new Date(time.clock.now().getTime() - 3_600_000),
      to: time.clock.now(),
    });
    expect(facts.logs).toEqual([]);

    // No Redis on this entry: the counter refuses, never counts in memory.
    await expect(counter.incr(`${APP}:synthetic-key`, nextMidnight(time))).rejects.toBeTruthy();
  } finally {
    await app.close();
  }

  const without = await bootStream({ time, logs });
  try {
    expect(without.ports ?? null, 'no database: no ports').toBeNull();
  } finally {
    await without.app.close();
  }
}, 120_000);

it('[AC-B3-08g#5][BR-AI-07] dailyCounter 走 Redis：一次脚本调用、键为给定键、过期时刻为给定 expireAt；返回新计数；Redis 出错 → 拒绝', async () => {
  const time = new ManualTime();
  const logs = new Logs();
  const redis = fakeRedis(4);
  const { app, ports } = await bootStream({ db: pg.db, redis: redis.handle, time, logs });
  try {
    const counter = present(present(ports, 'ports').dailyCounter, 'ports.dailyCounter');
    const key = `${APP}:synthetic-user:20261006`;
    const expireAt = nextMidnight(time);
    const before = redis.evals.length;
    expect(await counter.incr(key, expireAt)).toBe(4);
    const calls = redis.evals.slice(before);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(
      call.options.keys.some((k) => k === key || k.endsWith(`:${key}`)),
      JSON.stringify(call.options.keys),
    ).toBe(true);
    // The key expires at expireAt: as the script TTL (seconds left on the clock) or as EXPIREAT's
    // absolute epoch second among the script arguments.
    const secondsLeft = (expireAt.getTime() - time.clock.now().getTime()) / 1_000;
    const asTtl =
      call.ttlSeconds >= Math.floor(secondsLeft) && call.ttlSeconds <= Math.ceil(secondsLeft);
    const asAt = call.options.args.includes(String(Math.floor(expireAt.getTime() / 1_000)));
    const shown = `ttl ${String(call.ttlSeconds)}, args ${call.options.args.join(',')}`;
    expect(asTtl || asAt, shown).toBe(true);
  } finally {
    await app.close();
  }

  const failing = fakeRedis(new Error('synthetic redis failure'));
  const broken = await bootStream({ db: pg.db, redis: failing.handle, time, logs });
  try {
    const counter = present(present(broken.ports, 'ports').dailyCounter, 'ports.dailyCounter');
    await expect(
      counter.incr(`${APP}:synthetic-user:20261006`, nextMidnight(time)),
    ).rejects.toBeTruthy();
  } finally {
    await broken.app.close();
  }
}, 120_000);
