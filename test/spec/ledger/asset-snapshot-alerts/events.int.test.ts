// B2-04wa: the asset snapshot alerts are domain events of 规划/02 §11, enqueued on the snapshot's
// own transaction through the platform event bus, keyed by (app_id, accounting date, type).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EVENT_NAMES } from '../../../../apps/api/src/modules/platform/index.ts';
import { PLAN_02_EVENTS } from '../../platform/events/kit.ts';
import {
  DAY,
  DEADLINE,
  EXPOSURE,
  NEXT_DAY,
  NEXT_DEADLINE,
  NEXT_NOMINAL,
  TIMED_OUT,
  TIMEOUT,
  close,
  contents,
  context,
  events,
  exposurePayload,
  failReceivableWrite,
  input,
  jobs,
  open,
  receivable,
  snapshots,
  timedOutPayload,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it(
  '[AC-B2-04wa#1] 两个告警事件按 02 §11 的位置登记，名字与载荷逐字一致：只含 app_id、会计日、类型与各自字段，金额为整数分',
  async () => {
    const f = context(h, { now: DEADLINE, threshold: 100n });
    expect(EVENT_NAMES).toContain(TIMED_OUT);
    expect(EVENT_NAMES).toContain(EXPOSURE);
    const plan: readonly string[] = PLAN_02_EVENTS;
    expect(EVENT_NAMES.filter((name) => plan.includes(name))).toEqual(
      plan.filter((name) => EVENT_NAMES.includes(name)),
    );
    expect(EVENT_NAMES.indexOf(EXPOSURE)).toBeGreaterThan(EVENT_NAMES.indexOf(TIMED_OUT));

    await receivable(h.db, f.appId, 'taobao', 70n);
    await receivable(h.db, f.appId, 'jd', 50n);
    // Read at the deadline: written late, so the timeout goes with the row, as does the exposure.
    await f.runner().run(h.db, input(f.appId));
    const rows = await events(h.db, f.appId);
    expect(contents(rows)).toEqual([
      { name: TIMED_OUT, payload: { v: 1, data: timedOutPayload(f.appId) } },
      { name: EXPOSURE, payload: { v: 1, data: exposurePayload(f.appId, 120, 100) } },
    ]);
    expect(rows.map((row) => row.occurredAt.toISOString())).toEqual([DEADLINE, DEADLINE]);
    const queued = await jobs(h.db, f.appId);
    expect(queued.map((job) => job.id).sort()).toEqual(rows.map((row) => row.eventId).sort());
    for (const row of rows) {
      expect(queued.find((job) => job.id === row.eventId)).toMatchObject({
        state: 'created',
        data: {
          name: row.name,
          payload: { app_id: f.appId, v: 1, occurred_at: DEADLINE, data: row.payload.data },
        },
      });
    }
    // One publish per alert, on the port's own event ids.
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.calls.map(([, event]) => event.eventId).sort()).toEqual(
      rows.map((row) => row.eventId).sort(),
    );
    expect(f.publish.mock.calls.map(([, event]) => event.appId)).toEqual([f.appId, f.appId]);
    expect(f.enqueued.map((item) => item.duplicate)).toEqual([false, false]);
    expect(await snapshots(h.db, f.appId)).toMatchObject([{ day: DAY, waiting_comparable: false }]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04wa#2] 告警与快照行在同一写事务入队：事务内可见、提交前其他连接看不到快照、事件和任务，提交后各自一一对应',
  async () => {
    const f = context(h, { now: DEADLINE, threshold: 0n });
    await receivable(h.db, f.appId, 'taobao', 1n);
    const seen: Array<Record<string, number>> = [];
    f.publish.mockImplementation(async (trx, event) => {
      const result = await f.bus.publish(trx, event);
      seen.push({
        snapshotsInside: (await snapshots(trx, f.appId)).length,
        eventsInside: (await events(trx, f.appId)).length,
        jobsInside: (await jobs(trx, f.appId)).length,
        snapshotsOutside: (await snapshots(h.right, f.appId)).length,
        eventsOutside: (await events(h.right, f.appId)).length,
        jobsOutside: (await jobs(h.right, f.appId)).length,
      });
      return result;
    });
    await f.runner().run(h.db, input(f.appId));
    const outside = { snapshotsOutside: 0, eventsOutside: 0, jobsOutside: 0 };
    expect(seen).toEqual([
      { snapshotsInside: 1, eventsInside: 1, jobsInside: 1, ...outside },
      { snapshotsInside: 1, eventsInside: 2, jobsInside: 2, ...outside },
    ]);
    const [trx, ...others] = f.publish.mock.calls.map((call) => call[0]);
    for (const other of others) expect(other).toBe(trx);
    expect(f.send).toHaveBeenCalledTimes(2);
    for (const call of f.send.mock.calls) expect(call[3].trx).toBe(trx);
    expect(contents(await events(h.right, f.appId))).toEqual([
      { name: TIMED_OUT, payload: { v: 1, data: timedOutPayload(f.appId) } },
      { name: EXPOSURE, payload: { v: 1, data: exposurePayload(f.appId, 1, 0) } },
    ]);
    expect(await jobs(h.right, f.appId)).toHaveLength(2);
    expect(await snapshots(h.right, f.appId)).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04wa#3] 告警入队之后写事务失败：快照、已发布的事件留痕与任务一起回滚，原错误不变；重试后各一条且不是重复',
  async () => {
    const f = context(h, { now: DEADLINE, threshold: 10n });
    await receivable(h.db, f.appId, 'jd', 11n);
    const failure = new Error('queue unavailable');
    f.send
      .mockImplementationOnce(h.setup.runtime.send.bind(h.setup.runtime))
      .mockRejectedValueOnce(failure);
    await expect(f.runner().run(h.db, input(f.appId))).rejects.toBe(failure);
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(await snapshots(h.db, f.appId)).toEqual([]);
    expect(await events(h.db, f.appId)).toEqual([]);
    expect(await jobs(h.db, f.appId)).toEqual([]);

    await f.runner().run(h.db, input(f.appId));
    expect(await snapshots(h.db, f.appId)).toHaveLength(1);
    expect(contents(await events(h.db, f.appId))).toEqual([
      { name: TIMED_OUT, payload: { v: 1, data: timedOutPayload(f.appId) } },
      { name: EXPOSURE, payload: { v: 1, data: exposurePayload(f.appId, 11, 10) } },
    ]);
    expect(await jobs(h.db, f.appId)).toHaveLength(2);
    // The event of the failed attempt went with its rollback: nothing of the retry is a duplicate.
    expect(f.enqueued.map((item) => item.duplicate)).toEqual([false, false, false]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04wa#4] 快照写入在告警之前失败即不入队：没有事件留痕与任务；修复后重跑才入队',
  async () => {
    const f = context(h, { now: DEADLINE, threshold: 0n });
    await receivable(h.db, f.appId, 'taobao', 5n);
    const failure = new Error('child write failed');
    await expect(
      f.runner().run(h.db.withPlugin(failReceivableWrite(failure)), input(f.appId)),
    ).rejects.toThrow('child write failed');
    expect(f.publish).not.toHaveBeenCalled();
    expect(await snapshots(h.db, f.appId)).toEqual([]);
    expect(await events(h.db, f.appId)).toEqual([]);
    expect(await jobs(h.db, f.appId)).toEqual([]);

    await f.runner().run(h.db, input(f.appId));
    expect(contents(await events(h.db, f.appId))).toEqual([
      { name: TIMED_OUT, payload: { v: 1, data: timedOutPayload(f.appId) } },
      { name: EXPOSURE, payload: { v: 1, data: exposurePayload(f.appId, 5, 0) } },
    ]);
    expect(await jobs(h.db, f.appId)).toHaveLength(2);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04wa#5] 并发投递、重放与新实例不重复入队：每个 (app_id, 会计日, 类型) 只有一条事件和一个任务，迟写后再超时不冲突；另一 app、次日各自入队',
  async () => {
    const f = context(h, { now: DEADLINE, threshold: 100n });
    const g = context(h, { now: DEADLINE, threshold: 100n });
    await receivable(h.db, f.appId, 'taobao', 120n);
    await receivable(h.db, g.appId, 'taobao', 120n);

    await Promise.all([
      f.runner().run(h.db, input(f.appId)),
      f.runner().run(h.db, input(f.appId)),
      f.runner().run(h.db, input(f.appId)),
    ]);
    const first = await events(h.db, f.appId);
    expect(contents(first)).toEqual([
      { name: TIMED_OUT, payload: { v: 1, data: timedOutPayload(f.appId) } },
      { name: EXPOSURE, payload: { v: 1, data: exposurePayload(f.appId, 120, 100) } },
    ]);
    expect(await jobs(h.db, f.appId)).toHaveLength(2);
    // A delivery that starts after the winner committed takes the replay path: only duplicates.
    expect(f.enqueued.filter((item) => !item.duplicate)).toHaveLength(2);

    // Redeliveries after the deadline: the late row stays not comparable, so any timeout sent again
    // carries the day's key and the same content — a duplicate, never a conflict or a second job.
    await f.runner().run(h.db, input(f.appId));
    const again = context(h, { appId: f.appId, now: DEADLINE, threshold: 100n });
    await again.runner().run(h.db, input(f.appId));
    expect(f.enqueued.filter((item) => !item.duplicate)).toHaveLength(2);
    expect(again.enqueued.every((item) => item.duplicate)).toBe(true);
    expect(await events(h.db, f.appId)).toEqual(first);
    expect(await jobs(h.db, f.appId)).toHaveLength(2);
    expect(await snapshots(h.db, f.appId)).toMatchObject([{ day: DAY, waiting_comparable: false }]);

    // Another app on the same day: its own key.
    await g.runner().run(h.db, input(g.appId));
    expect(contents(await events(h.db, g.appId))).toEqual([
      { name: TIMED_OUT, payload: { v: 1, data: timedOutPayload(g.appId) } },
      { name: EXPOSURE, payload: { v: 1, data: exposurePayload(g.appId, 120, 100) } },
    ]);

    // The next day, still exposed and late: alerted again under the next day's key.
    f.clock.set(NEXT_DEADLINE);
    await f.runner().run(h.db, input(f.appId, NEXT_NOMINAL));
    const both = await events(h.db, f.appId);
    expect(contents(both)).toEqual([
      { name: TIMED_OUT, payload: { v: 1, data: timedOutPayload(f.appId) } },
      { name: EXPOSURE, payload: { v: 1, data: exposurePayload(f.appId, 120, 100) } },
      { name: TIMED_OUT, payload: { v: 1, data: timedOutPayload(f.appId, NEXT_DAY) } },
      { name: EXPOSURE, payload: { v: 1, data: exposurePayload(f.appId, 120, 100, NEXT_DAY) } },
    ]);
    expect(await jobs(h.db, f.appId)).toHaveLength(4);
    expect(await jobs(h.db, g.appId)).toHaveLength(2);
    const ids = [...both, ...(await events(h.db, g.appId))].map((row) => row.eventId);
    expect(new Set(ids).size).toBe(6);
  },
  TIMEOUT,
);
