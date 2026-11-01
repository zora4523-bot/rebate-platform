// 单元测试（不连库）：执行器的纯函数。真实 PG 行为由 test/spec/settlement/batch-executor 覆盖。
import { expect, it } from 'vitest';
import {
  compareItems,
  previousDay,
  runCredited,
  runDoneEventId,
  runRest,
  type RunMember,
  switchOn,
  type SortableItem,
} from './rules.ts';

it('[AC-B2-04p-UNIT#1] 开关只认 true 与 on，缺省、false、off 及其他值都是 off', () => {
  expect(switchOn(true)).toBe(true);
  expect(switchOn('on')).toBe(true);
  for (const value of [false, 'off', undefined, null, 1, 'true', 'ON']) {
    expect(switchOn(value)).toBe(false);
  }
});

it('[AC-B2-04p-UNIT#2] 前一自然日：月内、月初、年初、闰年二月', () => {
  expect(previousDay('2032-07-24')).toBe('2032-07-23');
  expect(previousDay('2032-08-01')).toBe('2032-07-31');
  expect(previousDay('2032-05-01')).toBe('2032-04-30');
  expect(previousDay('2033-01-01')).toBe('2032-12-31');
  expect(previousDay('2032-03-01')).toBe('2032-02-29');
  expect(previousDay('2033-03-01')).toBe('2033-02-28');
});

function item(over: Partial<SortableItem>): SortableItem {
  return {
    id: 'i',
    item_type: 'order',
    platform: 'taobao',
    sub_order_id: 's',
    user_id: null,
    role: null,
    ...over,
  };
}

it('[AC-B2-04p-UNIT#3] 明细按 order_key 升序；同一订单先子订单项、再按用户与角色的补记项', () => {
  const rows = [
    item({ id: '4', sub_order_id: 'b', item_type: 'beneficiary', user_id: 'u2', role: 'self' }),
    item({ id: '3', sub_order_id: 'b', item_type: 'beneficiary', user_id: 'u1', role: 'self' }),
    item({ id: '2', sub_order_id: 'b' }),
    item({ id: '1', sub_order_id: 'a' }),
  ];
  expect([...rows].sort(compareItems).map((r) => r.id)).toEqual(['1', '2', '3', '4']);
});

/** Batches of one run, by status; 'CONFIRMED*' is a CONFIRMED batch with paused_by_switch_at set. */
function run(...statuses: readonly string[]): RunMember[] {
  return statuses.map((s) =>
    s === 'CONFIRMED*'
      ? { status: 'CONFIRMED', pausedBySwitch: true }
      : { status: s, pausedBySwitch: false },
  );
}

it('[AC-B2-04zf-UNIT#1] run 只在没有 EXECUTING / 待开始的 CONFIRMED 批次时结束；有 PARTIAL 为 partial，否则 done；DRAFT、CANCELLED 不计不挡', () => {
  expect(runRest(run('DONE', 'DONE', 'DONE'))).toEqual({
    settled: true,
    outcome: 'done',
    batchCount: 3,
  });
  expect(runRest(run('DONE', 'PARTIAL'))).toEqual({
    settled: true,
    outcome: 'partial',
    batchCount: 2,
  });
  expect(runRest(run('PARTIAL', 'PARTIAL'))).toEqual({
    settled: true,
    outcome: 'partial',
    batchCount: 2,
  });
  expect(runRest(run('DONE', 'CANCELLED', 'DRAFT'))).toEqual({
    settled: true,
    outcome: 'done',
    batchCount: 1,
  });
  for (const waiting of ['CONFIRMED', 'EXECUTING']) {
    expect(runRest(run('DONE', 'PARTIAL', waiting))).toEqual({ settled: false });
  }
  expect(runRest(run())).toEqual({ settled: false });
  expect(runRest(run('CANCELLED'))).toEqual({ settled: false });
});

it('[AC-B2-04zf-UNIT#3] 开关在开始前停住的批次（CONFIRMED + paused_by_switch_at，SB5c）视同因开关停止：不挡 run 结束，使 outcome=partial', () => {
  // money r1 S1: taobao DONE / PARTIAL while the jd batch of the same run is paused before start.
  for (const finished of ['DONE', 'PARTIAL']) {
    expect(runRest(run(finished, 'CONFIRMED*'))).toEqual({
      settled: true,
      outcome: 'partial',
      batchCount: 2,
    });
  }
  // The pause itself is the run's last move.
  expect(runRest(run('CONFIRMED*'))).toEqual({ settled: true, outcome: 'partial', batchCount: 1 });
  expect(runRest(run('DONE', 'CONFIRMED*', 'CANCELLED'))).toEqual({
    settled: true,
    outcome: 'partial',
    batchCount: 2,
  });
  // Still waiting: another batch is executing or not yet started.
  expect(runRest(run('CONFIRMED*', 'EXECUTING'))).toEqual({ settled: false });
  expect(runRest(run('CONFIRMED*', 'CONFIRMED'))).toEqual({ settled: false });
});

it('[AC-B2-04zf-UNIT#2] run 事件 id 是小写规范 UUID，同一 (app, run, part) 相同，不同则不同', () => {
  const run = '0b7c2d1e-0000-4000-8000-000000000001';
  const id = runDoneEventId('app-a', run, 1);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(runDoneEventId('app-a', run, 1)).toBe(id);
  expect(new Set([id, runDoneEventId('app-a', run, 2), runDoneEventId('app-b', run, 1)]).size).toBe(
    3,
  );
});

it('[AC-B2-04zf-UNIT#4] 本次执行一笔都没入账（全部批次开始前被开关停住、PARTIAL 无入账明细、DONE 早于本次起点）不发；有新 DONE 或 PARTIAL 的已入账部分才发', () => {
  const m = (status: string, creditedItems = 0, doneSinceStart = false) => ({
    status,
    creditedItems,
    doneSinceStart,
  });
  // D10-477 补正: both batches paused before they started, nothing credited.
  expect(runCredited([m('CONFIRMED'), m('CONFIRMED')])).toBe(false);
  expect(runCredited([m('PARTIAL', 0), m('CONFIRMED')])).toBe(false);
  // A DONE batch that finished before this execution started.
  expect(runCredited([m('DONE', 0, false), m('PARTIAL', 0)])).toBe(false);
  // Something credited in this execution.
  expect(runCredited([m('DONE', 0, true), m('CONFIRMED')])).toBe(true);
  expect(runCredited([m('PARTIAL', 2), m('CONFIRMED')])).toBe(true);
  expect(runCredited([m('DONE', 0, false), m('PARTIAL', 1)])).toBe(true);
});

it('[AC-B2-04zf-UNIT#5] 继续执行后第一笔前又被开关停住（本次新入账 0）不发、part 不加；之后继续执行到 DONE 才发', () => {
  // money r2 S1 / D10-492 ④: creditedItems counts only the items credited since part_started_at,
  // so o0 credited before part 1 no longer counts for the PARTIAL batch after it.
  const m = (status: string, creditedItems = 0, doneSinceStart = false) => ({
    status,
    creditedItems,
    doneSinceStart,
  });
  // Single batch: continued, stopped again before o1.
  expect(runCredited([m('PARTIAL', 0)])).toBe(false);
  // taobao continued and stopped again, jd still paused before start, nothing new.
  expect(runCredited([m('PARTIAL', 0), m('CONFIRMED')])).toBe(false);
  // jd reached DONE in part 1, taobao continued and stopped again with nothing new.
  expect(runCredited([m('PARTIAL', 0), m('DONE', 0, false)])).toBe(false);
  // The next continue that credits, or reaches DONE, publishes.
  expect(runCredited([m('PARTIAL', 1), m('CONFIRMED')])).toBe(true);
  expect(runCredited([m('DONE', 0, true)])).toBe(true);
});
