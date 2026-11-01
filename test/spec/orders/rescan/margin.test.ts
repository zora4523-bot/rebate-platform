// B1-04zm: a round starts one hour after now − days. The adapters judge from ≥ their own now − 90
// days in milliseconds and a job always runs after it was sent, so a start of exactly now − 90 days
// would be refused on every attempt and the stream would never leave its first window.
import { expect, it } from 'vitest';
import { scheduleOrderRescan } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import type { OrderRescanWindow } from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import { jdOrderWindow } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { incrementWindow } from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';
import { DAY_MS, HOUR_MS, JD_DAYS, MINUTE_MS, NOW_MS, fixture } from './kit.ts';

it('[AC-B1-04zm#67] days=90：首窗起点距 now 严格小于 90 天且相差 1 小时，晚 59 分钟执行仍不越界', async () => {
  const f = fixture({ config: { [JD_DAYS]: 90 } });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  const first = f.sent()[0] as OrderRescanWindow;
  const ageMs = NOW_MS - Date.parse(first.window_start);
  expect(ageMs).toBeLessThan(90 * DAY_MS);
  expect(90 * DAY_MS - ageMs).toBe(HOUR_MS);
  const win = { from: first.window_start, to: first.window_end };
  const lateMs = NOW_MS + 59 * MINUTE_MS;
  expect(() => jdOrderWindow(win, new Date(lateMs))).not.toThrow();
  expect(() => incrementWindow(win, lateMs)).not.toThrow();
});
