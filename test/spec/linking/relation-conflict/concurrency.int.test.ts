import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { RELATION, suite, type Fixture } from '../bindings/kit.ts';
import { client, web } from '../bindings/client.ts';
import { binding, bindings, scenario, state } from '../bindings/records.ts';
import { conflicts, TIMEOUT } from './records.ts';

const use = suite(createTestDatabase, acquireTestRedis);

async function waitingInserts(f: Fixture, signal: AbortSignal) {
  while (!signal.aborted) {
    const result = await sql<{ waiting: number }>`
      SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks
      WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND relation = 'app.union_bindings'::regclass
        AND mode = 'RowExclusiveLock' AND NOT granted
    `.execute(f.db);
    if (result.rows[0]?.waiting === 2) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

it(
  '[AC-B1-06z#5] 两个 INSERT 同时撞唯一约束：后到者 30151 且仅写一条 occupied',
  async () => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const other = await client(f, { appId: c.appId });
    const first = await state(f, c);
    const second = await state(f, other);
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let count = 0;
    f.exchange.mockImplementation(async () => {
      if (++count === 2) arrived.resolve();
      await release.promise;
      return { kind: 'bound', relationId: RELATION };
    });
    const locked = Promise.withResolvers<void>();
    const unlock = Promise.withResolvers<void>();
    const lock = f.db.transaction().execute(async (trx) => {
      await sql`LOCK TABLE app.union_bindings IN SHARE MODE`.execute(trx);
      locked.resolve();
      await unlock.promise;
    });
    await Promise.race([locked.promise, lock]);
    const pending = [c.post(web(first.state)), other.post(web(second.state))];
    const deadline = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => deadline.resolve(false), 8000);
    const stop = new AbortController();
    const premature = Promise.race(pending).then(() => false);
    let reached = false;
    let waiting = false;
    let observation: Promise<boolean> | undefined;
    try {
      reached = await Promise.race([arrived.promise.then(() => true), premature, deadline.promise]);
      if (reached) {
        release.resolve();
        observation = waitingInserts(f, stop.signal);
        waiting = await Promise.race([observation, premature, deadline.promise]);
      }
    } finally {
      clearTimeout(timer);
      stop.abort();
      release.resolve();
      unlock.resolve();
      await lock;
      await observation;
      await Promise.allSettled(pending);
    }
    expect(reached).toBe(true);
    expect(waiting, '两个 INSERT 必须在锁闸门处同时等待').toBe(true);
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.json<{ code: number }>().code).sort()).toEqual([0, 30151]);
    const winner = responses[0]!.statusCode === 200 ? c : other;
    const loser = winner === c ? other : c;
    expect(await conflicts(f.db, c.appId)).toEqual([
      expect.objectContaining({
        app_id: c.appId,
        user_id: loser.uid,
        platform: 'taobao',
        union_account_id: accountId,
        kind: 'occupied',
        occurred_at: f.clock.now(),
        resolved_at: null,
        resolution: null,
      }),
    ]);
    expect(await bindings(f, c)).toEqual([
      expect.objectContaining({
        user_id: winner.uid,
        status: 'active',
        relation_id: RELATION,
      }),
    ]);
    const rejected = responses.find((r) => r.statusCode === 422)!;
    expect(rejected.payload).not.toContain(winner.uid);
    expect(rejected.payload).not.toContain(RELATION);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06z#6] 换凭证期间本人变 active：写日志时重读并 already_active',
  async () => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const owner = await client(f, { appId: c.appId });
    await binding(f, owner, accountId);
    // Exchange is the explicit barrier after the handler's initial binding projection.
    f.exchange.mockImplementation(async () => {
      await binding(f, c, accountId, { relation_id: 'synthetic-concurrent-active' });
      return { kind: 'bound', relationId: RELATION };
    });
    const s = await state(f, c);
    const result = await c.post(web(s.state));
    expect(result.json()).toMatchObject({ code: 30151 });
    expect(await conflicts(f.db, c.appId)).toEqual([
      expect.objectContaining({
        user_id: c.uid,
        kind: 'occupied',
        occurred_at: f.clock.now(),
        resolved_at: f.clock.now(),
        resolution: 'already_active',
      }),
    ]);
  },
  TIMEOUT,
);
