// B2-04wa (closes B2-04w money r4 S2): a duplicate delivery that finds the day committed but not yet
// comparable must not report a timeout that did not happen. Its confirmation first locks the day's
// row and reads it again; only once it holds the lock does it read the Clock.
// Delivery A writes the day in time and is held inside its confirming UPDATE (row changed, lock
// held, not committed); delivery B, a duplicate, starts meanwhile and must wait for that lock.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAY,
  DEADLINE,
  NOMINAL,
  TIMED_OUT,
  TIMEOUT,
  close,
  contents,
  context,
  events,
  holdSnapshotUpdate,
  input,
  jobs,
  logged,
  open,
  snapshots,
  timedOutPayload,
  tracked,
  waitAnyBlocked,
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
  '[AC-B2-04wa#8] 并发重复投递不误报超时：另一投递持锁确认为可比时，截止后到达的重复投递等锁、重读为可比即返回，不发超时',
  async () => {
    const a = context(h, { now: NOMINAL });
    const b = context(h, { appId: a.appId, now: DEADLINE });
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = h.left.withPlugin(holdSnapshotUpdate({ held, release: release.promise }));
    const first = a.runner().run(holding, input(a.appId));
    const firstDone = Promise.allSettled([first]);
    let secondDone: Promise<unknown> | undefined;
    try {
      await Promise.race([
        held.promise,
        first.then(() => {
          throw new Error('the first delivery never confirmed its day');
        }),
      ]);
      const written = await snapshots(h.right, a.appId);
      expect(written).toMatchObject([{ day: DAY, waiting_comparable: false }]);
      const id = written[0]!.id;

      const second = b.runner().run(h.db, input(a.appId));
      secondDone = Promise.allSettled([second]);
      await waitAnyBlocked(h.right, tracked(second));
      release.resolve();

      expect(await first).toMatchObject({ snapshotId: id, accountingDate: DAY });
      expect(await second).toMatchObject({ snapshotId: id, accountingDate: DAY });
      expect(a.publish).not.toHaveBeenCalled();
      expect(b.publish).not.toHaveBeenCalled();
      expect(await events(h.db, a.appId)).toEqual([]);
      expect(await jobs(h.db, a.appId)).toEqual([]);
      expect(await snapshots(h.db, a.appId)).toMatchObject([{ id, waiting_comparable: true }]);
      expect(logged(b.logger, 'asset_snapshot_timeout')).toEqual([]);
    } finally {
      release.resolve();
      await firstDone;
      await secondDone;
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04wa#9] 持锁的确认回滚时，等锁的重复投递取得锁后才读时钟：等待期间跨过截止线即保持不可比并只发一次超时',
  async () => {
    const a = context(h, { now: NOMINAL });
    // B starts before the deadline; the clock crosses it while B waits for the lock.
    const b = context(h, { appId: a.appId, now: '2032-06-15T16:29:59.000Z' });
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error('confirmation lost');
    const gate = { held, release: release.promise, failure };
    const first = a.runner().run(h.left.withPlugin(holdSnapshotUpdate(gate)), input(a.appId));
    const firstDone = Promise.allSettled([first]);
    let secondDone: Promise<unknown> | undefined;
    try {
      await Promise.race([
        held.promise,
        first.then(() => {
          throw new Error('the first delivery never confirmed its day');
        }),
      ]);
      const written = await snapshots(h.right, a.appId);
      expect(written).toMatchObject([{ day: DAY, waiting_comparable: false }]);
      const id = written[0]!.id;

      const second = b.runner().run(h.db, input(a.appId));
      secondDone = Promise.allSettled([second]);
      await waitAnyBlocked(h.right, tracked(second));
      b.clock.set(DEADLINE);
      release.resolve();

      await expect(first).rejects.toThrow('confirmation lost');
      expect(await second).toMatchObject({ snapshotId: id, accountingDate: DAY });
      expect(a.publish).not.toHaveBeenCalled();
      expect(b.publish).toHaveBeenCalledTimes(1);
      const rows = await events(h.db, a.appId);
      expect(contents(rows)).toEqual([
        { name: TIMED_OUT, payload: { v: 1, data: timedOutPayload(a.appId) } },
      ]);
      expect(rows.map((row) => row.occurredAt.toISOString())).toEqual([DEADLINE]);
      expect(await jobs(h.db, a.appId)).toHaveLength(1);
      expect(await snapshots(h.db, a.appId)).toMatchObject([{ id, waiting_comparable: false }]);
    } finally {
      release.resolve();
      await firstDone;
      await secondDone;
    }
  },
  TIMEOUT,
);
