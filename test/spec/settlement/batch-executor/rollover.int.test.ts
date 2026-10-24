// B2-04p rule tests on a real PostgreSQL: crossing midnight while executing. BR-FUND-04 细则
// 「到执行时刻开关为 off 与执行中跨日」④: before every item transaction starts and before it commits
// the injected clock is checked; past midnight while the new day's asset snapshot is neither
// complete nor timed out, stop at once (the in-flight item rolls back), the batch stays EXECUTING
// (no PARTIAL, no settle.batch_done); after the snapshot an SB9 take-over resumes from the first
// unprocessed item. BR-FUND-18; 规划/12 §4.3.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  creditedOnce,
  databaseFixture,
  fixture,
  nth,
  p0Orders,
  untouched,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const EVENING = '2032-07-23T23:59:50+08:00';
const AFTER_MIDNIGHT = '2032-07-24T00:00:05+08:00';

it(
  '[AC-B2-04p#18] 执行中跨过日切而新一天快照未完成：在途那一单提交前发现、整单回滚，批次保持 EXECUTING、不发 settle.batch_done；00:20 再投递仍等快照；快照完成后 SB9 从这一单续跑，每单只入账一次',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'midnight', 3);
    const b = await f.batch(orders, { confirmed_at: new Date('2032-07-23T23:00:00+08:00') });
    f.clock.set(EVENING);
    const second = nth(orders, 1);
    // 第 2 单的事务里时钟走过 00:00（07-23 的快照还没有，也没到 00:30）。
    f.onCredit(second, async () => {
      f.clock.set(AFTER_MIDNIGHT);
    });

    expect(await f.run(b)).toMatchObject({ outcome: 'day_rollover' });
    expect(await f.stored(b)).toMatchObject({ status: 'EXECUTING', finished_at: null });
    await creditedOnce(f, nth(orders, 0));
    expect((await f.itemOf(b, nth(orders, 0))).result).toBe('credited');
    for (const o of [second, nth(orders, 2)]) {
      await untouched(f, o);
      expect((await f.itemOf(b, o)).result).toBeNull();
    }
    expect(f.creditCalls.map((c) => c.input.orderId)).not.toContain(nth(orders, 2).orderId);
    expect(await f.doneEvents()).toHaveLength(0);

    // 快照仍未完成：调度接管也不执行。
    f.clock.set('2032-07-24T00:20:00+08:00');
    const before = await f.snapshot();
    expect(await f.run(b)).toMatchObject({ outcome: 'snapshot_pending' });
    expect(await f.snapshot()).toEqual(before);

    await f.snapshotDone('2032-07-23');
    const callsBefore = f.creditCalls.length;
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    expect(f.creditCalls.slice(callsBefore).map((c) => c.input.orderId)).toEqual([
      second.orderId,
      nth(orders, 2).orderId,
    ]);
    for (const o of orders) {
      await creditedOnce(f, o);
      expect((await f.itemOf(b, o)).result).toBe('credited');
    }
    expect(await f.stored(b)).toMatchObject({
      status: 'DONE',
      finished_at: new Date('2032-07-24T00:20:00+08:00'),
    });
    expect(await f.doneEvents()).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#19] 跨过日切时新一天的快照已完成：不停止，照常执行完 DONE',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'midnight-ok', 3);
    const b = await f.batch(orders, { confirmed_at: new Date('2032-07-23T23:00:00+08:00') });
    await f.snapshotDone('2032-07-23');
    f.clock.set(EVENING);
    f.onCredit(nth(orders, 1), async () => {
      f.clock.set(AFTER_MIDNIGHT);
    });
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    for (const o of orders) await creditedOnce(f, o);
    expect(await f.stored(b)).toMatchObject({
      status: 'DONE',
      finished_at: new Date(AFTER_MIDNIGHT),
    });
  },
  TIMEOUT,
);
