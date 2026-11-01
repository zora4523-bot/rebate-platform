// B2-04zf rule tests on a real PostgreSQL: settle.run_done is published on the transaction of the
// batch transition that triggers it (D10-467 ③ / D10-477): the last batch's EXECUTING → DONE (SB6)
// or the stopping batch's EXECUTING → PARTIAL (SB7). A refused publish rolls that transaction back
// (the batch stays EXECUTING, nothing is published, committed credits stay); the next delivery makes
// the transition again and publishes exactly once. Inside the publish the transition is already
// visible on that transaction while another connection still sees the batch EXECUTING.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  BATCH_DONE,
  RUN_DONE,
  TIMEOUT,
  at,
  creditedOnce,
  databaseFixture,
  fixture,
  nth,
  untouched,
  type Fixture,
  type Publish,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each([RUN_DONE, BATCH_DONE])(
  '[AC-B2-04zf#7] 最后一个批次完成事务里 %s 发布失败：执行拒绝，批次保持 EXECUTING（finished_at 为空），settle.batch_done 与 settle.run_done 都没有写入，已入账的订单不回滚；再次投递执行到 DONE，恰好一条 settle.run_done（part=1、outcome=done）',
  async (refused) => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups(`refuse-${refused.replace('.', '-')}`, [1, 1]);
    const { runId, batches } = await f.seedRun(groups);
    const [first, last] = [at(batches, 0), at(batches, 1)];
    await f.finish(first);

    const refuse: Publish = async (trx, event) => {
      if (event.name === refused) throw new Error('refused by the run-done test');
      return f.write(trx, event);
    };
    await expect(f.deliver(last, { publish: refuse })).rejects.toThrow();

    expect(await f.stored(last)).toMatchObject({ status: 'EXECUTING', finished_at: null });
    expect(await f.batchDone(last)).toBe(0);
    expect(await f.runDone()).toEqual([]);
    for (const o of at(groups, 1)) await creditedOnce(f, o);

    await f.finish(last);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 2)]);
    expect(await f.batchDone(last)).toBe(1);
    for (const group of groups) for (const o of group) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#8] 因开关停止转 PARTIAL 的事务里 settle.run_done 发布失败：执行拒绝，批次保持 EXECUTING，没有 settle.run_done，未处理的订单保持 WAITING；开关仍关时再次投递，接管后停在 PARTIAL 并恰好发一条 part=1 partial；继续执行完再发 part=2 done',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('refuse-partial', [1, 2]);
    const { runId, batches } = await f.seedRun(groups);
    const [first, last] = [at(batches, 0), at(batches, 1)];
    const [head, tail] = [nth(at(groups, 1), 0), nth(at(groups, 1), 1)];
    await f.finish(first);

    const refuse: Publish = async (trx, event) => {
      if (event.name === RUN_DONE) throw new Error('refused by the run-done test');
      return f.write(trx, event);
    };
    f.stopAfter(head);
    await expect(f.deliver(last, { publish: refuse })).rejects.toThrow();

    expect(await f.status(last)).toBe('EXECUTING');
    expect(await f.runDone()).toEqual([]);
    await untouched(f, tail);

    // 开关仍为 off：下一次投递接管（SB9）后在第一条未处理的明细前停住。
    await f.stop(last);
    const partial = f.runEvent(runId, 1, 'partial', 2);
    expect(await f.runDone()).toStrictEqual([partial]);
    await untouched(f, tail);

    f.switchBackOn();
    await f.resume(last);
    await f.finish(last);
    expect(await f.runDone()).toStrictEqual([partial, f.runEvent(runId, 2, 'done', 2)]);
    for (const group of groups) for (const o of group) await creditedOnce(f, o);
  },
  TIMEOUT,
);

interface Seen {
  readonly isTransaction: boolean;
  readonly inside: Record<string, string>;
  readonly outside: string;
}

/** A publish that, for settle.run_done, records the run's batches on the trx and `watched` outside. */
function looking(f: Fixture, runId: string, watched: string, seen: Seen[]): Publish {
  return async (trx, event) => {
    if (event.name === RUN_DONE) {
      const inside = await trx
        .selectFrom('settle_batches')
        .select(['batch_id', 'status'])
        .where('app_id', '=', f.appId)
        .where('settle_run_id', '=', runId)
        .execute();
      const outside = await f.db
        .selectFrom('settle_batches')
        .select('status')
        .where('app_id', '=', f.appId)
        .where('batch_id', '=', watched)
        .executeTakeFirstOrThrow();
      const statuses: Record<string, string> = {};
      for (const row of inside) statuses[row.batch_id] = row.status;
      seen.push({ isTransaction: trx.isTransaction, inside: statuses, outside: outside.status });
    }
    return f.write(trx, event);
  };
}

it(
  '[AC-B2-04zf#9] outcome=done 的 settle.run_done 在最后一个批次转 DONE 的同一事务内发布：发布时该事务里 run 的全部批次已是 DONE，另一连接看到的最后一个批次仍是 EXECUTING；提交后两边一致',
  async () => {
    const f = await fixture(p.db);
    const { runId, batches } = await f.seedRun(await f.orderGroups('same-trx', [1, 1]));
    const [first, last] = [at(batches, 0), at(batches, 1)];
    await f.finish(first);

    const seen: Seen[] = [];
    await f.finish(last, { publish: looking(f, runId, last.batchId, seen) });

    expect(seen).toEqual([
      {
        isTransaction: true,
        inside: { [first.batchId]: 'DONE', [last.batchId]: 'DONE' },
        outside: 'EXECUTING',
      },
    ]);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 2)]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#10] outcome=partial 的 settle.run_done 在批次因开关转 PARTIAL 的同一事务内发布：发布时该事务里停下的批次已是 PARTIAL、其余为 DONE，另一连接看到的仍是 EXECUTING；提交后为 PARTIAL',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('same-trx-partial', [1, 2]);
    const { runId, batches } = await f.seedRun(groups);
    const [first, last] = [at(batches, 0), at(batches, 1)];
    await f.finish(first);

    const seen: Seen[] = [];
    f.stopAfter(nth(at(groups, 1), 0));
    await f.stop(last, { publish: looking(f, runId, last.batchId, seen) });

    expect(seen).toEqual([
      {
        isTransaction: true,
        inside: { [first.batchId]: 'DONE', [last.batchId]: 'PARTIAL' },
        outside: 'EXECUTING',
      },
    ]);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'partial', 2)]);
  },
  TIMEOUT,
);
