// B2-04zf rule tests on a real PostgreSQL: when settle.run_done is published (D10-467 ③, corrected
// by D10-477; BR-TEXT-09 「同一月结账单一次确认的批次全部执行完，或因开关停止置 PARTIAL 时对已入账部分」).
// A settle run is the set of batches of one confirmation (same settle_run_id, BR-FUND-04 ⑥).
// (a) The last batch of the run moves to DONE → outcome 'done'. (b) The execution is stopped by a
// switch and a batch moves to PARTIAL while the other batches of the run are DONE → outcome
// 'partial'. After a manual continue (SB8) the next (a) or (b) publishes again with part + 1.
// Payload exactly { settle_run_id, bill_id, part, outcome, batch_count }; app_id in the envelope.
// A batch of the run still CONFIRMED or EXECUTING means no event; batches of another run, of another
// app or without a settle_run_id neither count nor block.
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
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zf#1] 同一 run 三个批次（含补充批次）逐个执行：前两个 DONE 时不发；第三个 DONE 时由它的执行发布恰好一条 settle.run_done，信封 app_id 为本 app，载荷恰为 settle_run_id、bill_id、part=1、outcome=done、batch_count=3；每批照旧各一条 settle.batch_done',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('run3', [2, 1, 1]);
    const { runId, batches } = await f.seedRun(groups, [{}, {}, { kind: 'supplement' }]);
    const [a, b, c] = [at(batches, 0), at(batches, 1), at(batches, 2)];

    await f.finish(a, { by: 'a' });
    expect(await f.runDone()).toEqual([]);
    await f.finish(b, { by: 'b' });
    expect(await f.runDone()).toEqual([]);
    await f.finish(c, { by: 'c' });

    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 3)]);
    expect(f.runDoneBy()).toEqual(['c']);
    for (const batch of [a, b, c]) expect(await f.batchDone(batch)).toBe(1);
    for (const group of groups) for (const o of group) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#2] 只有一个批次的 run：该批次 DONE 即发布一条 settle.run_done（part=1、outcome=done、batch_count=1）；这次执行恰好发布 settle.batch_done 与 settle.run_done 各一次',
  async () => {
    const f = await fixture(p.db);
    const { runId, batches } = await f.seedRun(await f.orderGroups('run1', [2]));
    const only = at(batches, 0);

    await f.finish(only);

    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 1)]);
    expect(await f.batchDone(only)).toBe(1);
    expect(f.calls.map((call) => call.name).sort()).toEqual([BATCH_DONE, RUN_DONE].sort());
  },
  TIMEOUT,
);

it.each(['CONFIRMED', 'EXECUTING'] as const)(
  '[AC-B2-04zf#3] run 中另一批次仍为 %s 时本批次 DONE 不发 settle.run_done；那一批次随后执行到 DONE 时才发恰好一条，part=1、outcome=done、batch_count=2',
  async (other) => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups(`wait-${other.toLowerCase()}`, [1, 2]);
    const { runId, batches } = await f.seedRun(groups, [{}, { status: other }]);
    const [first, pending] = [at(batches, 0), at(batches, 1)];

    await f.finish(first, { by: 'first' });
    expect(await f.status(pending)).toBe(other);
    expect(await f.runDone()).toEqual([]);
    expect(f.runDoneBy()).toEqual([]);

    await f.finish(pending, { by: 'pending' });

    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 2)]);
    expect(f.runDoneBy()).toEqual(['pending']);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#4] run 的其余批次都已 DONE、最后一个批次执行中因开关停在 PARTIAL：由停下的这次执行发布一条 settle.run_done（part=1、outcome=partial、batch_count=2）；手动继续（SB8）执行到 DONE 后再发一条 part=2、outcome=done',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('switch', [1, 2]);
    const { runId, batches } = await f.seedRun(groups);
    const [done, stopped] = [at(batches, 0), at(batches, 1)];
    const [head, tail] = [nth(at(groups, 1), 0), nth(at(groups, 1), 1)];
    await f.finish(done, { by: 'done' });
    expect(await f.runDone()).toEqual([]);

    // 第 2 个批次第 1 单的事务里关掉 settle.auto.enabled：第 2 单前停住，批次 PARTIAL（SB7）。
    f.stopAfter(head);
    await f.stop(stopped, { by: 'stop' });
    const partial = f.runEvent(runId, 1, 'partial', 2);
    expect(await f.runDone()).toStrictEqual([partial]);
    expect(f.runDoneBy()).toEqual(['stop']);
    await untouched(f, tail);

    f.switchBackOn();
    await f.resume(stopped);
    await f.finish(stopped, { by: 'resumed' });

    expect(await f.runDone()).toStrictEqual([partial, f.runEvent(runId, 2, 'done', 2)]);
    expect(f.runDoneBy()).toEqual(['stop', 'resumed']);
    for (const group of groups) for (const o of group) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#5] 单批次 run 停在 PARTIAL、继续执行后再次因开关停止、再继续执行完：依次发布 part=1 partial、part=2 partial、part=3 done 各恰好一条，每次都由那次执行发布；batch_count 始终为 1',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('again', [3]);
    const { runId, batches } = await f.seedRun(groups);
    const only = at(batches, 0);
    const orders = at(groups, 0);

    f.stopAfter(nth(orders, 0));
    await f.stop(only, { by: 'stop-1' });
    const first = f.runEvent(runId, 1, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([first]);
    await untouched(f, nth(orders, 2));

    f.switchBackOn();
    await f.resume(only);
    f.stopAfter(nth(orders, 1));
    await f.stop(only, { by: 'stop-2' });
    const second = f.runEvent(runId, 2, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([first, second]);
    await untouched(f, nth(orders, 2));

    f.switchBackOn();
    await f.resume(only);
    await f.finish(only, { by: 'finish' });

    expect(await f.runDone()).toStrictEqual([first, second, f.runEvent(runId, 3, 'done', 1)]);
    expect(f.runDoneBy()).toEqual(['stop-1', 'stop-2', 'finish']);
    expect(await f.batchDone(only)).toBe(1);
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#6] run 只按本 app 的同一 settle_run_id 计：同账单另一 run 的 CONFIRMED 批次、settle_run_id 为空的批次、别的 app 里同 settle_run_id 的批次都不计入也不挡；空 settle_run_id 的批次 DONE 不发；另一 run 执行完单独发一条，part 各自从 1 起',
  async () => {
    const f = await fixture(p.db);
    const other = await fixture(p.db);
    const groups = await f.orderGroups('scope', [1, 1, 1]);
    const { runId, batches } = await f.seedRun([at(groups, 0)]);
    const mine = at(batches, 0);
    const second = await f.seedRun([at(groups, 1)]);
    const later = at(second.batches, 0);
    const legacy = await f.batch(at(groups, 2), { settle_run_id: null });
    // 别的 app：同一个 settle_run_id、同账单月，仍在 CONFIRMED。
    await other.seedRun([[]], [], runId);

    await f.finish(mine);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 1)]);

    await f.finish(legacy);
    expect(await f.runDone()).toHaveLength(1);

    await f.finish(later);
    expect(await f.runDone()).toStrictEqual([
      f.runEvent(runId, 1, 'done', 1),
      f.runEvent(second.runId, 1, 'done', 1),
    ]);
    expect(await other.runDone()).toEqual([]);
  },
  TIMEOUT,
);
