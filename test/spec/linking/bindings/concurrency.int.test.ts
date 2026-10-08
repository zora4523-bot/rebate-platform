import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { RELATION, suite, type Fixture } from './kit.ts';
import { client, web } from './client.ts';
import { bindings, scenario, state, states } from './records.ts';
import { accepted, rejected } from './assertions.ts';

const use = suite(createTestDatabase, acquireTestRedis);

async function waitForInsertWaiters(f: Fixture, signal: AbortSignal) {
  while (!signal.aborted) {
    const result = await sql<{ waiting: number }>`
      SELECT count(DISTINCT pid)::int AS waiting
      FROM pg_locks
      WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND relation = 'app.union_bindings'::regclass
        AND mode = 'RowExclusiveLock'
        AND NOT granted
    `.execute(f.db);
    if (result.rows[0]?.waiting === 2) return true;
    // Poll an explicit database condition, never infer arrival from elapsed time.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

it.each(['different_users', 'same_user_two_devices'] as const)(
  '[AC-B1-06h#9] %s：两次换凭证都得同一 R，并发插入撞唯一约束仍返回业务结果',
  async (kind) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const other = await client(f, {
      appId: c.appId,
      ...(kind === 'same_user_two_devices' ? { uid: c.uid } : {}),
    });
    const firstState = await state(f, c);
    const secondState = await state(f, other);
    const issued = await states(f, c);
    const bothExchanges = Promise.withResolvers<void>();
    const releaseExchange = Promise.withResolvers<void>();
    let arrivals = 0;
    f.exchange.mockImplementation(async () => {
      arrivals += 1;
      if (arrivals === 2) bothExchanges.resolve();
      await releaseExchange.promise;
      return { kind: 'bound', relationId: RELATION };
    });

    // SHARE permits reads but holds both INSERTs before either becomes visible.
    // The exchange barrier alone would still let post-exchange lookups serialize.
    const locked = Promise.withResolvers<void>();
    const unlock = Promise.withResolvers<void>();
    const lock = f.db.transaction().execute(async (trx) => {
      await sql`LOCK TABLE app.union_bindings IN SHARE MODE`.execute(trx);
      locked.resolve();
      await unlock.promise;
    });
    await Promise.race([locked.promise, lock]);
    const requests = [
      c.post(web(firstState.state), { key: randomUUID() }),
      other.post(web(secondState.state), { key: randomUUID() }),
    ];
    const deadline = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => deadline.resolve(false), 5000);
    const stop = new AbortController();
    const prematureResponse = Promise.race(requests).then(() => false);
    let exchanged = false;
    let waiting = false;
    let observation: Promise<boolean> | undefined;
    try {
      exchanged = await Promise.race([
        bothExchanges.promise.then(() => true),
        prematureResponse,
        deadline.promise,
      ]);
      if (exchanged) {
        releaseExchange.resolve();
        observation = waitForInsertWaiters(f, stop.signal);
        waiting = await Promise.race([observation, prematureResponse, deadline.promise]);
      }
    } finally {
      clearTimeout(timer);
      stop.abort();
      releaseExchange.resolve();
      unlock.resolve();
      await lock;
      await observation;
      await Promise.allSettled(requests);
    }

    expect(exchanged, '两个独立 state 都必须进入换凭证端口').toBe(true);
    expect(waiting, '放行前两个 INSERT 均须等待数据库锁，确保实际覆盖唯一约束竞争').toBe(true);
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.statusCode).sort()).toEqual(
      kind === 'different_users' ? [200, 422] : [200, 200],
    );
    if (kind === 'different_users') {
      await accepted(responses.find((response) => response.statusCode === 200)!);
      await rejected(
        responses.find((response) => response.statusCode === 422)!,
        30151,
      );
    } else {
      for (const response of responses) await accepted(response);
    }
    const winner = responses[0]!.statusCode === 200 ? c : other;
    expect(await bindings(f, c)).toEqual([
      expect.objectContaining({
        app_id: c.appId,
        user_id: winner.uid,
        platform: 'taobao',
        union_account_id: accountId,
        relation_id: RELATION,
        status: 'active',
        bound_at: f.clock.now(),
        released_at: null,
        cooldown_until: null,
        blocked_reason: null,
      }),
    ]);
    expect(await states(f, c)).toEqual(issued.map((row) => ({ ...row, used_at: f.clock.now() })));
    expect(f.exchange).toHaveBeenCalledTimes(2);
  },
  20_000,
);
