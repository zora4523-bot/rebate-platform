// B1-04zs (FU-RESCAN-FIRST-WINDOW): a round's start slides with now, so the cursor a rewind left
// there is older than the start one tick later. A cursor at most 30 minutes older than the start
// stays put, and the window the queue still holds keeps its compare-and-set. The literal 30 minutes
// is deliberate: the task's constant does not exist before the implementation.
import { expect, it } from 'vitest';
import { scheduleOrderRescan } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import type { OrderRescanWindow } from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import {
  rescanIntervalSeconds,
  windowSingletonKey,
} from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { handleOrderRescanWindow } from '../../../../apps/api/src/modules/orders/jobs/order-rescan.ts';
import { jdOrderWindow } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import {
  DAY_MS,
  HOUR_MS,
  JD_CAP_MS,
  JD_DAYS,
  MINUTE_MS,
  NOW_MS,
  fixture,
  iso,
  job,
  rescanWindow,
  roundStart,
  stream,
} from '../rescan/kit.ts';

const TOLERANCE_MS = 30 * MINUTE_MS;
// The pace of the default jd stream: 30 days of 60-minute windows.
const TICK_MS = rescanIntervalSeconds(30, JD_CAP_MS) * 1000;

type Fixture = ReturnType<typeof fixture>;

/**
 * The order-sync queue's exclusive policy: a singletonKey stays taken while its job is queued or
 * active. Returns what ends a job: the real handler, then the key is free again.
 */
function singletonQueue(f: Fixture): (win: OrderRescanWindow) => Promise<void> {
  const held = new Set<string | undefined>();
  f.send.mockImplementation(async (_queue, _name, _payload, options) => {
    if (held.has(options.singletonKey)) return null;
    held.add(options.singletonKey);
    return 'queued-rescan';
  });
  return async (win) => {
    await handleOrderRescanWindow(job(win), f.handler);
    held.delete(windowSingletonKey(win));
  };
}

async function tick(f: Fixture): Promise<void> {
  f.clock.advanceMs(TICK_MS);
  await scheduleOrderRescan(f.scheduler, ['jd']);
}

it('[AC-B1-04zs#1] 轮末回到起点后发首窗，任务未完成时过 1、2 拍：不再 rewind，同窗不出第二个任务，完成时 CAS 命中，游标前进一窗', async () => {
  expect(TICK_MS).toBe(120_000);
  const tail = iso(NOW_MS - 1);
  const f = fixture({ cursor: tail });
  const finish = singletonQueue(f);
  await scheduleOrderRescan(f.scheduler, ['jd']);
  const win = rescanWindow(roundStart(30));
  expect(f.rewind).toHaveBeenCalledExactlyOnceWith(stream, tail, win.window_start);
  // The first window goes out on the round's end or one tick later; it starts at the rewind.
  await tick(f);
  expect(f.sent().at(-1)).toEqual(win);
  for (const inFlight of [1, 2]) {
    await tick(f);
    expect(f.rewind, `在途第 ${inFlight} 拍`).toHaveBeenCalledTimes(1);
    expect(f.sent().at(-1), `在途第 ${inFlight} 拍`).toEqual(win);
    await expect(f.send.mock.results.at(-1)?.value).resolves.toBeNull();
  }
  expect(new Set(f.send.mock.calls.map(([, , , options]) => options.singletonKey))).toEqual(
    new Set([windowSingletonKey(win)]),
  );
  await finish(win);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
  expect(f.cursor()).toBe(win.window_end);
  await tick(f);
  expect(f.sent().at(-1)).toEqual(rescanWindow(win.window_end));
  expect(f.rewind).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zs#2] 游标比一轮起点早 30 分钟 + 1 毫秒：仍回到起点；窗口在途过一拍不再 rewind，完成时 CAS 命中', async () => {
  const stale = iso(NOW_MS - 30 * DAY_MS + HOUR_MS - TOLERANCE_MS - 1);
  const f = fixture({ cursor: stale });
  const finish = singletonQueue(f);
  await scheduleOrderRescan(f.scheduler, ['jd']);
  const win = rescanWindow(roundStart(30));
  expect(f.rewind).toHaveBeenCalledExactlyOnceWith(stream, stale, win.window_start);
  expect(f.rewind.mock.invocationCallOrder[0]).toBeLessThan(f.send.mock.invocationCallOrder[0]!);
  expect(f.sent()).toEqual([win]);
  await tick(f);
  expect(f.rewind).toHaveBeenCalledTimes(1);
  expect(f.sent()).toEqual([win, win]);
  await finish(win);
  expect(f.cursor()).toBe(win.window_end);
});

it('[AC-B1-04zs#3] days=90：容差内最旧的游标仍晚于 now − 90 天，窗口从游标起，真实 jdOrderWindow 不拒绝', async () => {
  const cursor = iso(NOW_MS - 90 * DAY_MS + HOUR_MS - TOLERANCE_MS);
  const f = fixture({ cursor, config: { [JD_DAYS]: 90 } });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  const win = rescanWindow(cursor);
  expect(f.sent()).toEqual([win]);
  expect(f.rewind).not.toHaveBeenCalled();
  expect(Date.parse(win.window_start)).toBeGreaterThan(NOW_MS - 90 * DAY_MS);
  const range = { from: win.window_start, to: win.window_end };
  expect(() => jdOrderWindow(range, new Date(NOW_MS))).not.toThrow();
  // The job runs after it was sent: the 30 minutes left of the margin still cover 29 of them.
  expect(() => jdOrderWindow(range, new Date(NOW_MS + 29 * MINUTE_MS))).not.toThrow();
});
