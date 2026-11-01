// B2-04zf rule tests on a real PostgreSQL: settle.run_done keeps its part and outcome on
// settlement's own app.settle_runs (D10-492; migration 0108, B2-04zfa), not on event_log (02 §11:
// audit only). The event shape and the publish / no-publish rules of D10-477 and its correction stay
// as they are; these cases add what the run row must show:
//   - a publish moves part and last_outcome of the run's row to the payload's part and outcome and
//     increases row_version, on the publishing transaction (a refused publish leaves both as they
//     were; another connection sees the old values while the publish is still open);
//   - the next part is the row's part + 1, also when the audit copies of earlier events are gone;
//   - an execution that credited nothing publishes nothing and leaves part / last_outcome alone;
//   - what counts as credited is only what this execution did (since its start), not the batches or
//     items of an earlier execution;
//   - two executors reaching the publish point of the same part at once publish it once.
// Who inserts the row and when (at the start of an execution or at the first publish) is not fixed:
// a run without a row reads as part 0 with no outcome, and row_version is compared only once a row
// has been published.
//
// SB10 (finance starts a paused batch by hand) is not open yet, so #27 and #28 stand in for it with
// the row change SB10 makes (as paused.int.test.ts does).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  RUN_DONE,
  TIMEOUT,
  at,
  creditedOnce,
  databaseFixture,
  fixture,
  lockWaiting,
  nth,
  runPayload,
  untouched,
  waitUntil,
  type Fixture,
  type Publish,
  type SeededBatch,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

interface RunRow {
  readonly part: number;
  readonly last_outcome: string | null;
  readonly row_version: number;
}

interface Published {
  readonly part: number;
  readonly last_outcome: string | null;
}

/** Nothing published for the run yet (no row, or a row still at its defaults). */
const NOTHING: Published = { part: 0, last_outcome: null };

/** The run's settle_runs row in this app, or undefined while there is none (committed state). */
function runRow(f: Fixture, runId: string): Promise<RunRow | undefined> {
  return f.db
    .selectFrom('settle_runs')
    .select(['part', 'last_outcome', 'row_version'])
    .where('app_id', '=', f.appId)
    .where('settle_run_id', '=', runId)
    .executeTakeFirst();
}

/** What the row records as published: part 0 and no outcome while there is no row. */
function published(row: RunRow | undefined): Published {
  return { part: row?.part ?? 0, last_outcome: row?.last_outcome ?? null };
}

/** row_version of the row, -1 while there is none. */
function versionOf(row: RunRow | undefined): number {
  return row?.row_version ?? -1;
}

/** A writer that refuses settle.run_done (the publishing transaction rolls back). */
function refuse(f: Fixture): Publish {
  return async (trx, event) => {
    if (event.name === RUN_DONE) throw new Error('refused by the run-done test');
    return f.write(trx, event);
  };
}

interface Seen {
  readonly payload: unknown;
  /** The row as another connection sees it while the publish is open. */
  readonly outside: Published;
}

/** A writer that, for settle.run_done, records the payload and the row seen from outside. */
function watching(f: Fixture, runId: string, seen: Seen[]): Publish {
  return async (trx, event) => {
    if (event.name === RUN_DONE) {
      seen.push({ payload: event.payload, outside: published(await runRow(f, runId)) });
    }
    return f.write(trx, event);
  };
}

interface Kept {
  readonly name: string;
  readonly payload: unknown;
}

/**
 * A writer that keeps the events in memory only: nothing reaches event_log, as if the audit
 * retention had already removed them.
 */
function lostSink(kept: Kept[]): Publish {
  return async (_trx, event) => {
    kept.push({ name: event.name, payload: event.payload });
    return { eventId: event.eventId ?? randomUUID(), duplicate: false };
  };
}

/** settle.auto.enabled off (and the clock past the 10-second bound) before the next delivery. */
function switchOff(f: Fixture): void {
  f.switches.set('settle.auto.enabled', false);
  f.clock.advanceMs(11_000);
}

/** One delivery of `b` at its execution instant with a switch off: SB5 c, CONFIRMED + marker. */
async function pausedAtStart(f: Fixture, b: SeededBatch): Promise<void> {
  expect(await f.deliver(b)).toMatchObject({ outcome: 'switched_off' });
  const row = await f.stored(b);
  expect(row.status).toBe('CONFIRMED');
  expect(row.paused_by_switch_at).not.toBeNull();
  expect(row.started_at).toBeNull();
}

/** Stand-in for SB10 (not open yet): the paused CONFIRMED batch moves to EXECUTING. */
async function manualStart(f: Fixture, b: SeededBatch): Promise<void> {
  const row = await f.stored(b);
  const updated = await f.db
    .updateTable('settle_batches')
    .set({ status: 'EXECUTING', started_at: f.clock.now(), row_version: row.row_version + 1 })
    .where('app_id', '=', f.appId)
    .where('batch_id', '=', b.batchId)
    .where('status', '=', 'CONFIRMED')
    .where('paused_by_switch_at', 'is not', null)
    .where('row_version', '=', row.row_version)
    .executeTakeFirst();
  expect(updated.numUpdatedRows).toBe(1n);
}

it(
  '[AC-B2-04zf#23] outcome=done 的发布与 settle_runs 同一事务：最后一个批次完成事务里 settle.run_done 被拒 → 行仍为 part 0、无 outcome；再次投递发布时另一连接看到的行仍未变，提交后行为 part=1、last_outcome=done，与载荷一致',
  async () => {
    const f = await fixture(p.db);
    const { runId, batches } = await f.seedRun(await f.orderGroups('row-done', [1, 1]));
    const [first, last] = [at(batches, 0), at(batches, 1)];
    await f.finish(first);
    expect(published(await runRow(f, runId))).toEqual(NOTHING);

    await expect(f.deliver(last, { publish: refuse(f) })).rejects.toThrow();
    expect(await f.status(last)).toBe('EXECUTING');
    expect(await f.runDone()).toEqual([]);
    expect(published(await runRow(f, runId))).toEqual(NOTHING);

    const seen: Seen[] = [];
    await f.finish(last, { publish: watching(f, runId, seen) });

    expect(seen).toEqual([{ payload: runPayload(runId, 1, 'done', 2), outside: NOTHING }]);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 2)]);
    expect(published(await runRow(f, runId))).toEqual({ part: 1, last_outcome: 'done' });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#24] outcome=partial 的发布与 settle_runs 同一事务：part=1 partial 后继续执行、因开关再停的事务里 settle.run_done 被拒 → 行仍为 part=1 partial；再次投递停在 PARTIAL 并发 part=2 partial，发布时另一连接仍看到 part=1，提交后行为 part=2 partial、row_version 增加',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('row-partial', [3]);
    const { runId, batches } = await f.seedRun(groups);
    const only = at(batches, 0);
    const orders = at(groups, 0);

    f.stopAfter(nth(orders, 0));
    await f.stop(only);
    const first = await runRow(f, runId);
    expect(published(first)).toEqual({ part: 1, last_outcome: 'partial' });

    // 继续执行，第 2 单的事务里开关关闭；停住的事务里 settle.run_done 被拒。
    f.switchBackOn();
    await f.resume(only);
    f.stopAfter(nth(orders, 1));
    await expect(f.deliver(only, { publish: refuse(f) })).rejects.toThrow();
    expect(await f.status(only)).toBe('EXECUTING');
    expect(published(await runRow(f, runId))).toEqual({ part: 1, last_outcome: 'partial' });
    await creditedOnce(f, nth(orders, 1));
    await untouched(f, nth(orders, 2));

    // 开关仍为 off：下一次投递接管后停住，本次执行已入账第 2 单。
    const seen: Seen[] = [];
    await f.stop(only, { publish: watching(f, runId, seen) });

    expect(seen).toEqual([
      {
        payload: runPayload(runId, 2, 'partial', 1),
        outside: { part: 1, last_outcome: 'partial' },
      },
    ]);
    expect(await f.runDone()).toStrictEqual([
      f.runEvent(runId, 1, 'partial', 1),
      f.runEvent(runId, 2, 'partial', 1),
    ]);
    const second = await runRow(f, runId);
    expect(published(second)).toEqual({ part: 2, last_outcome: 'partial' });
    expect(versionOf(second)).toBeGreaterThan(versionOf(first));
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#25] part 以 settle_runs 为准：第 1 次执行停在 PARTIAL 时发出的 part=1 partial 没有留在 event_log（审计副本已清理），继续执行到 DONE 仍发 part=2 done（不是 part=1）；settle_runs 行依次为 part=1 partial、part=2 done',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('row-cleaned', [2]);
    const { runId, batches } = await f.seedRun(groups);
    const only = at(batches, 0);
    const orders = at(groups, 0);

    const kept: Kept[] = [];
    f.stopAfter(nth(orders, 0));
    await f.stop(only, { publish: lostSink(kept) });
    const lost = kept.filter((e) => e.name === RUN_DONE).map((e) => e.payload);
    expect(lost).toStrictEqual([runPayload(runId, 1, 'partial', 1)]);
    expect(await f.runDone()).toEqual([]);
    const first = await runRow(f, runId);
    expect(published(first)).toEqual({ part: 1, last_outcome: 'partial' });

    f.switchBackOn();
    await f.resume(only);
    await f.finish(only);

    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 2, 'done', 1)]);
    const second = await runRow(f, runId);
    expect(published(second)).toEqual({ part: 2, last_outcome: 'done' });
    expect(versionOf(second)).toBeGreaterThan(versionOf(first));
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#26] 本次执行无入账不加 part：单批次 run 第 1 次执行入账 o0 后停在 PARTIAL（行 part=1 partial）；继续执行、处理 o1 之前开关再次关闭、零入账回到 PARTIAL → 不发，行仍为 part=1 partial；再继续执行到 DONE → 发 part=2 done，行为 part=2 done、row_version 增加',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('row-zero', [3]);
    const { runId, batches } = await f.seedRun(groups);
    const only = at(batches, 0);
    const orders = at(groups, 0);

    f.stopAfter(nth(orders, 0));
    await f.stop(only);
    const partial = f.runEvent(runId, 1, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([partial]);
    const first = await runRow(f, runId);
    expect(published(first)).toEqual({ part: 1, last_outcome: 'partial' });

    f.switchBackOn();
    await f.resume(only);
    switchOff(f);
    await f.stop(only);
    expect(await f.runDone()).toStrictEqual([partial]);
    expect(published(await runRow(f, runId))).toEqual({ part: 1, last_outcome: 'partial' });
    await untouched(f, nth(orders, 1));

    f.switchBackOn();
    await f.resume(only);
    await f.finish(only);

    expect(await f.runDone()).toStrictEqual([partial, f.runEvent(runId, 2, 'done', 1)]);
    const second = await runRow(f, runId);
    expect(published(second)).toEqual({ part: 2, last_outcome: 'done' });
    expect(versionOf(second)).toBeGreaterThan(versionOf(first));
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#27] 同一 run 两批到执行时刻都因 settle.auto.enabled 关闭停在 CONFIRMED（带停住标记）、一笔未入账 → 不发，settle_runs 行无发布（无行，或 part 0、无 outcome）；开关恢复、两批手动开始（SB10）执行到全部 DONE → 发 part=1 done，行为 part=1 done',
  async () => {
    const f = await fixture(p.db);
    const { runId, batches } = await f.seedRun(await f.orderGroups('row-idle', [1, 1]));
    const [first, second] = [at(batches, 0), at(batches, 1)];

    switchOff(f);
    await pausedAtStart(f, first);
    await pausedAtStart(f, second);
    expect(await f.runDone()).toEqual([]);
    expect(published(await runRow(f, runId))).toEqual(NOTHING);

    f.switchBackOn();
    await manualStart(f, first);
    await manualStart(f, second);
    await f.finish(first);
    await f.finish(second);

    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 2)]);
    expect(published(await runRow(f, runId))).toEqual({ part: 1, last_outcome: 'done' });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#28] 本次执行的入账只看本次起点之后：同一 run 两批，第 1 批执行到 DONE、第 2 批到执行时刻因 settle.auto.enabled 关闭停在 CONFIRMED → part=1 partial；第 2 批手动开始（SB10）后开关又关、零入账停在 PARTIAL → 不发（上一次执行的 DONE 批次不算本次入账），行仍为 part=1 partial；继续执行到 DONE → 发 part=2 done',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('row-earlier', [1, 1]);
    const { runId, batches } = await f.seedRun(groups);
    const [first, second] = [at(batches, 0), at(batches, 1)];

    await f.finish(first);
    switchOff(f);
    await pausedAtStart(f, second);
    const partial = f.runEvent(runId, 1, 'partial', 2);
    expect(await f.runDone()).toStrictEqual([partial]);
    const before = await runRow(f, runId);
    expect(published(before)).toEqual({ part: 1, last_outcome: 'partial' });

    // 新的一次执行：第 2 批开始后开关又关，第一单前即停（本次零入账）。
    f.switchBackOn();
    await manualStart(f, second);
    switchOff(f);
    await f.stop(second);
    expect(await f.runDone()).toStrictEqual([partial]);
    expect(published(await runRow(f, runId))).toEqual({ part: 1, last_outcome: 'partial' });
    await untouched(f, nth(at(groups, 1), 0));

    f.switchBackOn();
    await f.resume(second);
    await f.finish(second);

    expect(await f.runDone()).toStrictEqual([partial, f.runEvent(runId, 2, 'done', 2)]);
    const after = await runRow(f, runId);
    expect(published(after)).toEqual({ part: 2, last_outcome: 'done' });
    expect(versionOf(after)).toBeGreaterThan(versionOf(before));
    for (const group of groups) for (const o of group) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#29] 并发同一 part：两批先都因开关停在 PARTIAL（part=1 partial），继续执行后由两个执行者在两条连接上同时执行完（各自的完成事务都等到对方也到达、对方在锁上等待或对方已结束才继续）→ 只多一条 part=2 done，settle_runs 行 part=2 done（part 只加一）；之后重放都是 idle，行不再变',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('row-race', [2, 2]);
    // 第 2 批已由另一执行者开始（EXECUTING）、执行者已不在，等待接管（SB9）。
    const { runId, batches } = await f.seedRun(groups, [{}, { status: 'EXECUTING' }]);
    const [a, b] = [at(batches, 0), at(batches, 1)];

    f.stopAfter(nth(at(groups, 0), 0));
    await f.stop(a);
    await f.stop(b);
    const partial = f.runEvent(runId, 1, 'partial', 2);
    expect(await f.runDone()).toStrictEqual([partial]);
    const first = await runRow(f, runId);
    expect(published(first)).toEqual({ part: 1, last_outcome: 'partial' });

    f.switchBackOn();
    await f.resume(a);
    await f.resume(b);

    const token = randomUUID().slice(0, 8);
    const names = { a: `run-row-a-${token}`, b: `run-row-b-${token}` };
    const arrived = new Set<'a' | 'b'>();
    /** Executors whose delivery already ended (done, busy or rejected, e.g. a deadlock victim). */
    const ended = new Set<'a' | 'b'>();
    /** One entry per executor that reached its completing transaction: did the other show up? */
    const met: boolean[] = [];
    function held(by: 'a' | 'b'): Publish {
      const other = by === 'a' ? 'b' : 'a';
      let firstCall = true;
      return async (trx, event) => {
        if (firstCall) {
          firstCall = false;
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
    // 并发输家（死锁检测、序列化失败、CAS 冲突等）留在 EXECUTING：补投递把它执行完。
    for (const batch of [a, b]) {
      if ((await f.status(batch)) !== 'DONE') await f.finish(batch, { by: 'again' });
    }

    expect(met.length).toBeGreaterThan(0);
    expect(met.every(Boolean)).toBe(true);
    expect([await f.status(a), await f.status(b)]).toEqual(['DONE', 'DONE']);
    const finished = f.runEvent(runId, 2, 'done', 2);
    expect(await f.runDone()).toStrictEqual([partial, finished]);
    const second = await runRow(f, runId);
    expect(published(second)).toEqual({ part: 2, last_outcome: 'done' });
    expect(versionOf(second)).toBeGreaterThan(versionOf(first));

    for (const batch of [a, b, a, b]) {
      expect(await f.deliver(batch, { by: 'replay' })).toMatchObject({ outcome: 'idle' });
    }
    expect(await runRow(f, runId)).toEqual(second);
    expect(await f.runDone()).toStrictEqual([partial, finished]);
    for (const group of groups) for (const o of group) await creditedOnce(f, o);
  },
  TIMEOUT,
);
