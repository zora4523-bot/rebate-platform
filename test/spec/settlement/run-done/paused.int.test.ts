// B2-04zf rule tests on a real PostgreSQL: settle.run_done when a batch of the run never started
// because a switch was off at its execution instant (D10-477 补正; BR-FUND-04 ⑦ and 细则「到执行时刻
// 开关为 off 与执行中跨日」, SB5 / SB10; BR-TEXT-09 「因开关停止置 PARTIAL 时对已入账部分」).
// Such a batch stays CONFIRMED with paused_by_switch_at and counts as stopped by a switch, so it does
// not hold the run back: once no batch of the run is EXECUTING and the others are DONE, PARTIAL or
// paused, the run gets one 'partial' event — only when this execution credited something (a DONE
// batch, or the credited part of a PARTIAL one). With nothing credited there is no event and no part
// is used up. Only the final event list is asserted, not which delivery published it.
//
// SB10 (finance starts a paused batch by hand) is not open yet (08 迁移表 SB10: 财务确认前不开放; the
// B2-04o command rejects it), so #20 stands in for it with the row change SB10 makes: CONFIRMED →
// EXECUTING, started_at and row_version + 1, paused_by_switch_at left as it is (as SB8 does). The
// executor then carries the batch on like any EXECUTING batch without a live executor (SB9).
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

/** A taobao batch (two orders) and a jd batch (one order) of the same settle run. */
async function taobaoAndJd(f: Fixture, tag: string) {
  f.switches.set('credit.enabled.jd', true);
  const taobao = await p0Orders(f, `${tag}-tb`, 2);
  const jd = await p0Orders(f, `${tag}-jd`, 1, () => ({ platform: 'jd' }));
  const { runId, batches } = await f.seedRun([taobao, jd], [{}, { platform: 'jd' }]);
  return { runId, first: at(batches, 0), second: at(batches, 1), taobao, jd };
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

it.each(['paused-first', 'done-first'] as const)(
  '[AC-B2-04zf#18] 同一 run 的 taobao、jd 两批：taobao 批到执行时刻因 credit.enabled.taobao 关闭没有开始、带停住标记停在 CONFIRMED，jd 批执行到 DONE（先后：%s）→ 最终恰好一条 settle.run_done，part=1、outcome=partial、batch_count=2',
  async (order) => {
    const f = await fixture(p.db);
    const s = await taobaoAndJd(f, `pause-${order}`);

    if (order === 'done-first') await f.finish(s.second);
    f.switches.set('credit.enabled.taobao', false);
    await pausedAtStart(f, s.first);
    if (order === 'paused-first') await f.finish(s.second);

    expect(await f.runDone()).toStrictEqual([f.runEvent(s.runId, 1, 'partial', 2)]);
    for (const o of s.taobao) await untouched(f, o);
    await creditedOnce(f, nth(s.jd, 0));
  },
  TIMEOUT,
);

it.each([
  { label: 'settle.auto.enabled', off: ['settle.auto.enabled'] },
  {
    label: 'credit.enabled.taobao 与 credit.enabled.jd',
    off: ['credit.enabled.taobao', 'credit.enabled.jd'],
  },
])(
  '[AC-B2-04zf#19] 同一 run 的 taobao、jd 两批到执行时刻都因 $label 关闭没有开始、都带停住标记停在 CONFIRMED，一笔未入账 → 不发 settle.run_done',
  async ({ off }) => {
    const f = await fixture(p.db);
    const s = await taobaoAndJd(f, 'idle');

    for (const key of off) f.switches.set(key, false);
    await pausedAtStart(f, s.first);
    await pausedAtStart(f, s.second);

    expect(await f.runDone()).toEqual([]);
    for (const o of [...s.taobao, ...s.jd]) await untouched(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zf#20] 接 #19：settle.auto.enabled 恢复后再投递两批仍不自动开始；两批手动开始（SB10）并执行到全部 DONE → 最终恰好一条 settle.run_done，part=1、outcome=done、batch_count=2（停住时没发，part 不加）',
  async () => {
    const f = await fixture(p.db);
    const s = await taobaoAndJd(f, 'start');

    f.switches.set('settle.auto.enabled', false);
    await pausedAtStart(f, s.first);
    await pausedAtStart(f, s.second);

    f.switchBackOn();
    for (const b of [s.first, s.second]) {
      expect(await f.deliver(b)).toMatchObject({ outcome: 'idle' });
    }
    await manualStart(f, s.first);
    await manualStart(f, s.second);
    await f.finish(s.first);
    await f.finish(s.second);

    expect(await f.runDone()).toStrictEqual([f.runEvent(s.runId, 1, 'done', 2)]);
    for (const o of [...s.taobao, ...s.jd]) await creditedOnce(f, o);
  },
  TIMEOUT,
);
