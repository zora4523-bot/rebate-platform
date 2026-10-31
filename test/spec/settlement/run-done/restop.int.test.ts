// B2-04zf rule tests on a real PostgreSQL: a manual continue (SB8) that is stopped by a switch again
// before it credits anything (money review r2 S1; D10-477 补正: 本次执行一笔都没入账则不发、part 不加).
// The run already has its part=1 'partial' event from the first execution. The continue moves the
// PARTIAL batch to EXECUTING, the switch goes off before the next order and the batch goes straight
// back to PARTIAL with nothing credited: no further settle.run_done, and the part of the next event
// is still 2. Only the event list is asserted, not which delivery published it.
//
// SB10 (finance starts a paused batch by hand) is not open yet, so #22 stands in for it with the row
// change SB10 makes (as paused.int.test.ts does): CONFIRMED → EXECUTING, started_at and row_version
// + 1, paused_by_switch_at left as it is.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  at,
  creditedOnce,
  databaseFixture,
  fixture,
  nth,
  p0Orders,
  untouched,
  type Fixture,
  type SeededBatch,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

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
  '[AC-B2-04zf#21] 单批次 run（o0、o1、o2）：第 1 次执行入账 o0 后因 settle.auto.enabled 停在 PARTIAL → 恰一条 part=1 partial；开关恢复、继续执行（SB8），处理 o1 之前开关再次关闭、批次回到 PARTIAL（本次零入账）→ 不再发，列表仍只有 part=1 partial；之后继续执行到 DONE → 再发 part=2 done（不是 part=3）',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('zero', [3]);
    const { runId, batches } = await f.seedRun(groups);
    const only = at(batches, 0);
    const orders = at(groups, 0);

    f.stopAfter(nth(orders, 0));
    await f.stop(only);
    const first = f.runEvent(runId, 1, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([first]);

    // 继续执行后、处理 o1 之前开关再次关闭：本次执行一笔都没入账。
    f.switchBackOn();
    await f.resume(only);
    switchOff(f);
    await f.stop(only);
    expect(await f.runDone()).toStrictEqual([first]);
    await creditedOnce(f, nth(orders, 0));
    await untouched(f, nth(orders, 1));
    await untouched(f, nth(orders, 2));

    f.switchBackOn();
    await f.resume(only);
    await f.finish(only);

    expect(await f.runDone()).toStrictEqual([first, f.runEvent(runId, 2, 'done', 1)]);
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#22] 同一 run 的 taobao、jd 两批：taobao 批入账 o0 后因 settle.auto.enabled 停在 PARTIAL、jd 批因同一开关带停住标记停在 CONFIRMED → 恰一条 part=1 partial；taobao 批继续执行零入账又停、jd 批仍停在 CONFIRMED → 不再发；之后两批继续执行到全部 DONE → 再发 part=2 done（不是 part=3），batch_count 始终为 2',
  async () => {
    const f = await fixture(p.db);
    f.switches.set('credit.enabled.jd', true);
    const taobao = await p0Orders(f, 'zero-tb', 2);
    const jd = await p0Orders(f, 'zero-jd', 1, () => ({ platform: 'jd' }));
    const { runId, batches } = await f.seedRun([taobao, jd], [{}, { platform: 'jd' }]);
    const [first, second] = [at(batches, 0), at(batches, 1)];

    // taobao 批第 1 单的事务里关掉 settle.auto.enabled：第 2 单前停住（SB7）；jd 批到执行时刻没开始。
    f.stopAfter(nth(taobao, 0));
    await f.stop(first);
    await pausedAtStart(f, second);
    const partial = f.runEvent(runId, 1, 'partial', 2);
    expect(await f.runDone()).toStrictEqual([partial]);

    // taobao 批继续执行，处理第 2 单之前开关再次关闭：本次执行一笔都没入账，jd 批仍停住。
    f.switchBackOn();
    await f.resume(first);
    switchOff(f);
    await f.stop(first);
    expect(await f.status(second)).toBe('CONFIRMED');
    expect(await f.runDone()).toStrictEqual([partial]);
    await creditedOnce(f, nth(taobao, 0));
    await untouched(f, nth(taobao, 1));
    await untouched(f, nth(jd, 0));

    f.switchBackOn();
    await f.resume(first);
    await manualStart(f, second);
    await f.finish(first);
    await f.finish(second);

    expect(await f.runDone()).toStrictEqual([partial, f.runEvent(runId, 2, 'done', 2)]);
    for (const o of [...taobao, ...jd]) await creditedOnce(f, o);
  },
  TIMEOUT,
);
