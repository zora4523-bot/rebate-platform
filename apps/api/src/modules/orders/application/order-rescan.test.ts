import { expect, it, vi } from 'vitest';
import { FixedClock, type JobQueue } from '../../platform/index.ts';
import { scheduleOrderRescan, type OrderRescanSchedulerDeps } from './order-rescan.ts';
import type { OrderRescanWindow, RescanCursorStore } from './sync-ports.ts';

const NOW = '2026-10-17T02:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const iso = (ms: number): string => new Date(ms).toISOString();

function harness(rescanCursor: string, incrementCursor: string) {
  let cursor = rescanCursor;
  const clock = new FixedClock(NOW);
  const send = vi.fn<JobQueue['send']>().mockResolvedValue('queued');
  const read = vi.fn<RescanCursorStore['read']>(async (stream) =>
    stream.query_kind === 'increment' ? incrementCursor : cursor,
  );
  const advance = vi.fn<RescanCursorStore['advance']>(async () => true);
  const rewind = vi.fn<RescanCursorStore['rewind']>(async (_stream, _expected, to) => {
    cursor = to;
    return true;
  });
  const deps: OrderRescanSchedulerDeps = {
    clock,
    queue: { send },
    cursors: { read, advance, rewind },
    config: { get: async () => undefined },
    capsMs: { jd: HOUR_MS },
    access: {
      listEnabledAccounts: async () => [
        {
          app_id: 'rescan-unit',
          platform: 'jd',
          union_account_id: ACCOUNT,
          sync_start_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      siteAuthAvailable: async () => true,
      offlineCircuitOpen: async () => false,
    },
  };
  return { clock, deps, send, advance, rewind };
}

it('[AC-B1-04zm] 回到轮首后首窗放不进 increment 游标之前：游标非空时也不发', async () => {
  const roundStartMs = NOW_MS - 30 * DAY_MS + HOUR_MS;
  // The rescan cursor is set and past the ceiling; the ceiling leaves 30 minutes of the round.
  const ceiling = iso(roundStartMs + HOUR_MS / 2);
  const f = harness(iso(NOW_MS - 2 * DAY_MS), ceiling);
  await scheduleOrderRescan(f.deps, ['jd']);
  await scheduleOrderRescan(f.deps, ['jd']);
  expect(f.rewind.mock.calls[0]?.[2]).toBe(iso(roundStartMs));
  expect(f.send).not.toHaveBeenCalled();
});

it('[AC-B1-04zm] 回到轮首后的下一窗终点在 min(now, increment 游标) 之内', async () => {
  const ceilingMs = NOW_MS - 3 * HOUR_MS;
  const f = harness(iso(ceilingMs + 1), iso(ceilingMs));
  await scheduleOrderRescan(f.deps, ['jd']);
  expect(f.send).not.toHaveBeenCalled();
  await scheduleOrderRescan(f.deps, ['jd']);
  const win = f.send.mock.calls[0]?.[2] as OrderRescanWindow;
  expect(Date.parse(win.window_end)).toBeLessThanOrEqual(ceilingMs);
});

it('[AC-B1-04zm] 调度只移动 rescan 流的游标', async () => {
  const f = harness(iso(NOW_MS - 45 * DAY_MS), NOW);
  await scheduleOrderRescan(f.deps, ['jd']);
  expect(f.rewind.mock.calls.map(([stream]) => stream.query_kind)).toEqual(['rescan']);
  expect(f.advance).not.toHaveBeenCalled();
});
