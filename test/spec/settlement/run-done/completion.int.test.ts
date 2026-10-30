// B2-04zf rule tests on a real PostgreSQL: when the run completion event is published (D10-467 ③).
// A settle run is the set of batches of one confirmation (same settle_run_id, BR-FUND-04 ⑥;
// BR-TEXT-09 「同一月结账单一次确认的批次全部执行完」). Exactly when the last batch of the run moves to
// DONE, one settle.run_done is published (payload: settle_run_id, bill_id, batch_count; app_id in
// the envelope). A batch of the run still CONFIRMED, EXECUTING or PARTIAL means no event; batches of
// another run, of another app or without a settle_run_id neither count nor block.
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
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zf#1] 同一 run 三个批次（含补充批次）逐个执行：前两个 DONE 时不发；第三个 DONE 时由它的执行发布恰好一条 settle.run_done，信封 app_id 为本 app，载荷恰为 settle_run_id、bill_id、batch_count=3；每批照旧各一条 settle.batch_done',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('run3', [2, 1, 1]);
    const { runId, batches } = await f.seedRun(groups, [{}, {}, { kind: 'supplement' }]);
    const [a, b, c] = [batchAt(batches, 0), batchAt(batches, 1), batchAt(batches, 2)];

    await f.finish(a, { by: 'a' });
    expect(await f.runDone()).toEqual([]);
    await f.finish(b, { by: 'b' });
    expect(await f.runDone()).toEqual([]);
    await f.finish(c, { by: 'c' });

    expect(await f.runDone()).toStrictEqual([{ app_id: f.appId, payload: runPayload(runId, 3) }]);
    expect(f.calls.filter((call) => call.name === RUN_DONE)).toEqual([{ by: 'c', name: RUN_DONE }]);
    for (const batch of [a, b, c]) expect(await f.batchDone(batch)).toBe(1);
    for (const group of groups) for (const o of group) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#2] 只有一个批次的 run：该批次 DONE 即发布一条 settle.run_done，batch_count=1；这次执行恰好发布 settle.batch_done 与 settle.run_done 各一次',
  async () => {
    const f = await fixture(p.db);
    const { runId, batches } = await f.seedRun(await f.orderGroups('run1', [2]));
    const only = batchAt(batches, 0);

    await f.finish(only);

    expect(await f.runDone()).toStrictEqual([{ app_id: f.appId, payload: runPayload(runId, 1) }]);
    expect(await f.batchDone(only)).toBe(1);
    expect(f.calls.map((call) => call.name).sort()).toEqual([BATCH_DONE, RUN_DONE].sort());
  },
  TIMEOUT,
);

it.each(['CONFIRMED', 'EXECUTING', 'PARTIAL'] as const)(
  '[AC-B2-04zf#3] run 中另一批次仍为 %s 时本批次 DONE 不发 settle.run_done；那一批次随后（PARTIAL 经手动继续）执行到 DONE 时才发恰好一条，batch_count=2',
  async (other) => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups(`wait-${other.toLowerCase()}`, [1, 2]);
    const { runId, batches } = await f.seedRun(groups, [{}, { status: other }]);
    const [first, pending] = [batchAt(batches, 0), batchAt(batches, 1)];

    await f.finish(first, { by: 'first' });
    expect(await f.status(pending)).toBe(other);
    expect(await f.runDone()).toEqual([]);
    expect(f.calls.filter((call) => call.name === RUN_DONE)).toEqual([]);

    if (other === 'PARTIAL') await f.resume(pending);
    await f.finish(pending, { by: 'pending' });

    expect(await f.runDone()).toStrictEqual([{ app_id: f.appId, payload: runPayload(runId, 2) }]);
    expect(f.calls.filter((call) => call.name === RUN_DONE)).toEqual([
      { by: 'pending', name: RUN_DONE },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#4] 执行中因开关停在 PARTIAL 的批次：PARTIAL 本身不发 settle.run_done（即使 run 的其余批次都已 DONE）；手动继续执行完 DONE 后才发一条，batch_count=2',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('switch', [1, 2]);
    const { runId, batches } = await f.seedRun(groups);
    const [done, stopped] = [batchAt(batches, 0), batchAt(batches, 1)];
    await f.finish(done);

    // 第 2 个批次第 1 单的事务里关掉 settle.auto.enabled：第 2 单前停住，批次 PARTIAL（SB7）。
    const head = groups[1]?.[0];
    if (head === undefined) throw new Error('no order to stop on');
    f.onCredit(head, async () => {
      f.switches.set('settle.auto.enabled', false);
      f.clock.advanceMs(11_000);
    });
    expect(await f.deliver(stopped)).toMatchObject({ outcome: 'partial' });
    expect(await f.status(stopped)).toBe('PARTIAL');
    expect(await f.runDone()).toEqual([]);

    f.switches.set('settle.auto.enabled', true);
    f.clock.advanceMs(11_000);
    await f.resume(stopped);
    await f.finish(stopped);

    expect(await f.runDone()).toStrictEqual([{ app_id: f.appId, payload: runPayload(runId, 2) }]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#5] run 只按本 app 的同一 settle_run_id 计：同账单另一 run 的 CONFIRMED 批次、settle_run_id 为空的批次、别的 app 里同 settle_run_id 的批次都不计入也不挡；空 settle_run_id 的批次 DONE 不发；另一 run 执行完单独发一条',
  async () => {
    const f = await fixture(p.db);
    const other = await fixture(p.db);
    const groups = await f.orderGroups('scope', [1, 1, 1]);
    const { runId, batches } = await f.seedRun([groups[0] ?? []]);
    const mine = batchAt(batches, 0);
    const second = await f.seedRun([groups[1] ?? []]);
    const later = batchAt(second.batches, 0);
    const legacy = await f.batch(groups[2] ?? [], { settle_run_id: null });
    // 别的 app：同一个 settle_run_id、同账单月，仍在 CONFIRMED。
    await other.seedRun([[]], [], runId);

    await f.finish(mine);
    expect(await f.runDone()).toStrictEqual([{ app_id: f.appId, payload: runPayload(runId, 1) }]);

    await f.finish(legacy);
    expect(await f.runDone()).toHaveLength(1);

    await f.finish(later);
    expect(await f.runDone()).toStrictEqual([
      { app_id: f.appId, payload: runPayload(runId, 1) },
      { app_id: f.appId, payload: runPayload(second.runId, 1) },
    ]);
    expect(await other.runDone()).toEqual([]);
  },
  TIMEOUT,
);
