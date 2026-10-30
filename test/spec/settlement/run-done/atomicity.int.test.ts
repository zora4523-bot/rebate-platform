// B2-04zf rule tests on a real PostgreSQL: settle.run_done is published on the transaction that
// moves the last batch of the run to DONE (D10-467 ③; executor step 5, SB6). A refused publish
// of either event rolls the whole completing transaction back (the batch stays EXECUTING, nothing
// is published); the next delivery completes it and publishes exactly once. Inside the publish the
// whole run is already DONE on that transaction while another connection still sees the last
// batch EXECUTING.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  BATCH_DONE,
  RUN_DONE,
  TIMEOUT,
  batchAt,
  creditedOnce,
  databaseFixture,
  fixture,
  runPayload,
  type Publish,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each([RUN_DONE, BATCH_DONE])(
  '[AC-B2-04zf#6] 最后一个批次完成事务里 %s 发布失败：执行拒绝，批次保持 EXECUTING（finished_at 为空），settle.batch_done 与 settle.run_done 都没有写入，已入账的订单不回滚；再次投递执行到 DONE，恰好一条 settle.run_done',
  async (refused) => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups(`refuse-${refused.replace('.', '-')}`, [1, 1]);
    const { runId, batches } = await f.seedRun(groups);
    const [first, last] = [batchAt(batches, 0), batchAt(batches, 1)];
    await f.finish(first);

    const refuse: Publish = async (trx, event) => {
      if (event.name === refused) throw new Error('refused by the run-done test');
      return f.write(trx, event);
    };
    await expect(f.deliver(last, { publish: refuse })).rejects.toThrow();

    expect(await f.stored(last)).toMatchObject({ status: 'EXECUTING', finished_at: null });
    expect(await f.batchDone(last)).toBe(0);
    expect(await f.runDone()).toEqual([]);
    for (const o of groups[1] ?? []) await creditedOnce(f, o);

    await f.finish(last);
    expect(await f.runDone()).toStrictEqual([{ app_id: f.appId, payload: runPayload(runId, 2) }]);
    expect(await f.batchDone(last)).toBe(1);
    for (const group of groups) for (const o of group) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#7] settle.run_done 在最后一个批次转 DONE 的同一事务内发布：发布时该事务里 run 的全部批次已是 DONE，另一连接看到的最后一个批次仍是 EXECUTING；提交后两边一致',
  async () => {
    const f = await fixture(p.db);
    const { runId, batches } = await f.seedRun(await f.orderGroups('same-trx', [1, 1]));
    const [first, last] = [batchAt(batches, 0), batchAt(batches, 1)];
    await f.finish(first);

    const seen: { isTransaction: boolean; inside: string[]; outside: string }[] = [];
    const look: Publish = async (trx, event) => {
      if (event.name === RUN_DONE) {
        const inside = await trx
          .selectFrom('settle_batches')
          .select(['batch_id', 'status'])
          .where('app_id', '=', f.appId)
          .where('settle_run_id', '=', runId)
          .orderBy('batch_id')
          .execute();
        const outside = await f.db
          .selectFrom('settle_batches')
          .select('status')
          .where('app_id', '=', f.appId)
          .where('batch_id', '=', last.batchId)
          .executeTakeFirstOrThrow();
        seen.push({
          isTransaction: trx.isTransaction,
          inside: inside.map((row) => row.status),
          outside: outside.status,
        });
      }
      return f.write(trx, event);
    };
    await f.finish(last, { publish: look });

    const expected = { isTransaction: true, inside: ['DONE', 'DONE'], outside: 'EXECUTING' };
    expect(seen).toEqual([expected]);
    expect(await f.runDone()).toStrictEqual([{ app_id: f.appId, payload: runPayload(runId, 2) }]);
  },
  TIMEOUT,
);
