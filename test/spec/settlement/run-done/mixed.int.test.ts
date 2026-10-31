// B2-04zf rule tests on a real PostgreSQL: settle.run_done of a run whose batches end differently
// (D10-477, review r2; BR-TEXT-09 「同一月结账单一次确认的批次全部执行完，或因开关停止置 PARTIAL 时对已入账部分」).
// One run, a taobao batch and a jd batch (one confirmation, BR-FUND-04 ⑥). Only the final event
// list is asserted, not which delivery published it: once no batch of the run is still waiting and
// one of them is PARTIAL, the run has exactly one 'partial' event of that part; a manual continue
// (SB8) that brings every batch to DONE adds exactly one 'done' event with part + 1.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { SeededOrder } from '../credit/kit.ts';
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
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** A taobao batch (two orders) and a jd batch (one order) of the same settle run. */
async function taobaoAndJd(f: Fixture, tag: string) {
  f.switches.set('credit.enabled.jd', true);
  const taobao = await p0Orders(f, `${tag}-tb`, 2);
  const jd = await p0Orders(f, `${tag}-jd`, 1, () => ({ platform: 'jd' }));
  const { runId, batches } = await f.seedRun([taobao, jd], [{}, { platform: 'jd' }]);
  return { runId, first: at(batches, 0), second: at(batches, 1), taobao, jd };
}

/**
 * Inside the credit transaction of `o`, credit.enabled.taobao goes off (and the clock moves past
 * the 10-second bound): the taobao batch stops before its next order (SB7), jd is not affected.
 */
function stopTaobaoAfter(f: Fixture, o: SeededOrder): void {
  f.onCredit(o, async () => {
    f.switches.set('credit.enabled.taobao', false);
    f.clock.advanceMs(11_000);
  });
}

it(
  '[AC-B2-04zf#15] 同一 run 的 taobao、jd 两批：taobao 批先因 credit.enabled.taobao 关闭停在 PARTIAL，jd 批随后执行到 DONE → 最终恰好一条 settle.run_done，part=1、outcome=partial、batch_count=2（不发 done，也不是一条都没有）',
  async () => {
    const f = await fixture(p.db);
    const s = await taobaoAndJd(f, 'mix');

    stopTaobaoAfter(f, nth(s.taobao, 0));
    await f.stop(s.first);
    await f.finish(s.second);

    expect(await f.runDone()).toStrictEqual([f.runEvent(s.runId, 1, 'partial', 2)]);
    await creditedOnce(f, nth(s.taobao, 0));
    await untouched(f, nth(s.taobao, 1));
    await creditedOnce(f, nth(s.jd, 0));
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#16] 接 #15：开关恢复后手动继续（SB8）taobao 批执行到 DONE → 在 part=1 的 partial 之后恰好追加一条 part=2、outcome=done、batch_count=2',
  async () => {
    const f = await fixture(p.db);
    const s = await taobaoAndJd(f, 'cont');

    stopTaobaoAfter(f, nth(s.taobao, 0));
    await f.stop(s.first);
    await f.finish(s.second);

    f.switches.set('credit.enabled.taobao', true);
    f.clock.advanceMs(11_000);
    await f.resume(s.first);
    await f.finish(s.first);

    expect(await f.runDone()).toStrictEqual([
      f.runEvent(s.runId, 1, 'partial', 2),
      f.runEvent(s.runId, 2, 'done', 2),
    ]);
    for (const o of [...s.taobao, ...s.jd]) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#17] 同一 run 的 taobao、jd 两批都因 settle.auto.enabled 关闭停在 PARTIAL（taobao 批执行中停住；jd 批已在 EXECUTING、被接管时第一单前即停）→ 最终恰好一条 settle.run_done，part=1、outcome=partial、batch_count=2',
  async () => {
    const f = await fixture(p.db);
    f.switches.set('credit.enabled.jd', true);
    const taobao = await p0Orders(f, 'auto-tb', 2);
    const jd = await p0Orders(f, 'auto-jd', 2, () => ({ platform: 'jd' }));
    // jd 批已由另一执行者开始（EXECUTING）、执行者已不在，等待接管（SB9）。
    const { runId, batches } = await f.seedRun(
      [taobao, jd],
      [{}, { platform: 'jd', status: 'EXECUTING' }],
    );
    const [first, second] = [at(batches, 0), at(batches, 1)];

    // taobao 批第 1 单的事务里关掉 settle.auto.enabled：第 2 单前停住（SB7）。
    f.stopAfter(nth(taobao, 0));
    await f.stop(first);
    // settle.auto.enabled 仍为 off：接管 jd 批时第一单前即停止，批次 PARTIAL。
    await f.stop(second);

    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'partial', 2)]);
    await creditedOnce(f, nth(taobao, 0));
    await untouched(f, nth(taobao, 1));
    for (const o of jd) await untouched(f, o);
  },
  TIMEOUT,
);
