// B1-01zzh brief B.2: createMetricsRegistry({ entry, collect? }). Every entry carries the process
// level default metrics; only entry 'worker' with a collect function registers the five business
// gauges, and their values come from collect called at scrape time (render), never from a resident
// polling loop. api / stream / admin / payout never call collect and never name a business metric.
import { afterEach, expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  type WorkerMetricsSnapshot,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import {
  businessNamesIn,
  expectProcessMetrics,
  families,
  gauge,
  METRIC_KEYS,
  METRIC_NAMES,
  METRICS,
} from './kit.ts';

afterEach(() => {
  vi.useRealTimers();
});

const FIRST: WorkerMetricsSnapshot = {
  queueFailed: { notify: 2, 'notify.dead': 1, settle: 0, 'evt.payout-went-negative': 0 },
  deadLetters: { 'notify.dead': 3, 'order-sync.dead': 0 },
  backlog: { notify: 7, export: 0, 'evt.payout-went-negative': 4 },
  oldestDueEvtAgeSeconds: { 'evt.payout-went-negative': 125, 'evt.notification-risk-state': 0 },
  syncWatermarkLagSeconds: { taobao: 4000, pdd: 30 },
};

const SECOND: WorkerMetricsSnapshot = {
  queueFailed: { notify: 0, 'notify.dead': 5, settle: 1, 'evt.payout-went-negative': 0 },
  deadLetters: { 'notify.dead': 0, 'order-sync.dead': 2 },
  backlog: { notify: 1, export: 9, 'evt.payout-went-negative': 0 },
  oldestDueEvtAgeSeconds: { 'evt.payout-went-negative': 0, 'evt.notification-risk-state': 61 },
  // pdd's last cursor is gone: its series disappears instead of keeping the old value.
  syncWatermarkLagSeconds: { taobao: 1801 },
};

it('[AC-B1-01zzh#3] worker 的 registry 在 scrape 时调 collect，五类业务 gauge 的序列与数值同快照一致，并带进程级默认指标', async () => {
  const collect = vi.fn(async () => FIRST);
  const registry = createMetricsRegistry({ entry: 'worker', collect });
  expect(collect).not.toHaveBeenCalled();
  const text = await registry.render();
  expect(collect).toHaveBeenCalledTimes(1);
  for (const key of METRIC_KEYS) {
    expect(families(text).get(METRICS[key].name), `# TYPE of ${METRICS[key].name}`).toBe('gauge');
    expect(gauge(text, key), key).toEqual(FIRST[key]);
  }
  expect(businessNamesIn(text)).toEqual(METRIC_NAMES);
  expectProcessMetrics(text);
  expect(registry.contentType).toMatch(/^text\/plain\b/);
});

it('[AC-B1-01zzh#4] api / stream / admin / payout 只有进程级指标：给了 collect 也不调用、不出业务指标名；worker 不给 collect 同样没有', async () => {
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    const collect = vi.fn(async () => FIRST);
    for (const registry of [
      createMetricsRegistry({ entry }),
      createMetricsRegistry({ entry, collect }),
    ]) {
      const text = await registry.render();
      expectProcessMetrics(text);
      expect(businessNamesIn(text), entry).toEqual([]);
    }
    expect(collect, entry).not.toHaveBeenCalled();
  }
  const bare = await createMetricsRegistry({ entry: 'worker' }).render();
  expectProcessMetrics(bare);
  expect(businessNamesIn(bare)).toEqual([]);
});

it('[AC-B1-01zzh#5] 每次 scrape 取最新快照：不常驻轮询，消失的平台不留旧序列，多个 registry 互不干扰', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate'] });
  const collect = vi.fn<() => Promise<WorkerMetricsSnapshot>>();
  collect.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(SECOND);
  const worker = createMetricsRegistry({ entry: 'worker', collect });
  // A process-only registry of another entry in the same process must not clash or share series.
  const api = createMetricsRegistry({ entry: 'api' });
  vi.advanceTimersByTime(15 * 60_000);
  expect(collect).not.toHaveBeenCalled();
  vi.useRealTimers();

  const first = await worker.render();
  for (const key of METRIC_KEYS) expect(gauge(first, key), key).toEqual(FIRST[key]);
  const second = await worker.render();
  expect(collect).toHaveBeenCalledTimes(2);
  for (const key of METRIC_KEYS) expect(gauge(second, key), key).toEqual(SECOND[key]);
  expect(second).not.toMatch(/platform="pdd"/);
  expect(businessNamesIn(await api.render())).toEqual([]);
  expect(collect).toHaveBeenCalledTimes(2);
});
