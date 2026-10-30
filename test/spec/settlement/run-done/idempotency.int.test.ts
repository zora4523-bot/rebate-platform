// B2-04zf rule tests on a real PostgreSQL: one settle.run_done per run (D10-467 ③). Later
// deliveries of finished batches publish nothing; a duplicate delivery of the last batch on another
// connection does not publish twice; two batches of one run completed at the same time by two
// executors on two connections publish exactly one event in total — never none (each completing
// transaction blind to the other's uncommitted DONE) and never two.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  batchAt,
  databaseFixture,
  fixture,
  lockWaiting,
  runPayload,
  waitUntil,
  type Publish,
  type SeededBatch,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zf#8] 重放不重发：run 已发过 settle.run_done 后，再投递其中每个批次都是 idle，不再发布任何事件；最后一个批次在两条连接上被重复投递时也只执行一次、只发一条',
  async () => {
    const f = await fixture(p.db);
    const { runId, batches } = await f.seedRun(await f.orderGroups('replay', [1, 2]));
    const [first, last] = [batchAt(batches, 0), batchAt(batches, 1)];
    await f.finish(first);

    const token = randomUUID().slice(0, 8);
    const outcomes = await Promise.all([
      f.deliver(last, { via: p.pool(`replay-x-${token}`), by: 'x' }),
      f.deliver(last, { via: p.pool(`replay-y-${token}`), by: 'y' }),
    ]);
    expect(outcomes.filter((r) => r.outcome === 'done')).toHaveLength(1);
    expect(await f.status(last)).toBe('DONE');
    expect(await f.runDone()).toStrictEqual([{ app_id: f.appId, payload: runPayload(runId, 2) }]);

    const before = f.calls.length;
    for (const batch of [first, last, first, last]) {
      expect(await f.deliver(batch, { by: 'replay' })).toMatchObject({ outcome: 'idle' });
    }
    expect(f.calls).toHaveLength(before);
    expect(await f.runDone()).toStrictEqual([{ app_id: f.appId, payload: runPayload(runId, 2) }]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#9] 同一 run 的两个批次由两个执行者在两条连接上同时执行完（各自的完成事务都等到对方也到达完成事务、对方在锁上等待或对方已结束才继续）：两批都 DONE 后恰好一条 settle.run_done，batch_count=2；并发输家可以失败，补投递后仍只有一条',
  async () => {
    const f = await fixture(p.db);
    const { runId, batches } = await f.seedRun(await f.orderGroups('race', [1, 1]));
    const [a, b] = [batchAt(batches, 0), batchAt(batches, 1)];
    const token = randomUUID().slice(0, 8);
    const names = { a: `run-done-a-${token}`, b: `run-done-b-${token}` };

    const arrived = new Set<'a' | 'b'>();
    /** Executors whose delivery already ended (done, busy or rejected, e.g. a deadlock victim). */
    const ended = new Set<'a' | 'b'>();
    /** One entry per executor that reached its completing transaction: did the other show up? */
    const met: boolean[] = [];
    function held(by: 'a' | 'b'): Publish {
      const other = by === 'a' ? 'b' : 'a';
      let first = true;
      return async (trx, event) => {
        if (first) {
          first = false;
          arrived.add(by);
          met.push(
            await waitUntil(
              async () =>
                arrived.has(other) || ended.has(other) || (await lockWaiting(f.db, names[other])),
            ),
          );
        }
        return f.write(trx, event);
      };
    }
    function deliverHeld(batch: SeededBatch, by: 'a' | 'b') {
      return f
        .deliver(batch, { via: p.pool(names[by]), by, publish: held(by) })
        .finally(() => ended.add(by));
    }

    const settled = await Promise.allSettled([deliverHeld(a, 'a'), deliverHeld(b, 'b')]);
    const done = settled.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'done');
    expect(done.length).toBeGreaterThan(0);
    // 并发输家（死锁检测、序列化失败等）留在 EXECUTING：补投递把它执行完。
    for (const batch of [a, b]) {
      if ((await f.status(batch)) !== 'DONE') await f.finish(batch, { by: 'again' });
    }

    expect(met.length).toBeGreaterThan(0);
    expect(met.every(Boolean)).toBe(true);
    expect([await f.status(a), await f.status(b)]).toEqual(['DONE', 'DONE']);
    // 只数提交了的：回滚事务里的发布不算（event_log 随事务回滚）。
    expect(await f.runDone()).toStrictEqual([{ app_id: f.appId, payload: runPayload(runId, 2) }]);
    expect([await f.batchDone(a), await f.batchDone(b)]).toEqual([1, 1]);
  },
  TIMEOUT,
);
