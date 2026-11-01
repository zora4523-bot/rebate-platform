// B2-05o: createMetricsRegistry({ entry, …, collectReviewOverdue? }). Only entry 'worker' with a
// collectReviewOverdue function exports couli_withdrawals_review_overdue: one unlabelled gauge with
// its # HELP and # TYPE gauge lines, filled by collectReviewOverdue at scrape time (render), never by
// a resident polling loop; 0 is exported too (the rule compares with > 0). A rejected or throwing
// collection rejects render() (the scrape fails visibly, no 0 is made up, no older value reused).
// B1-01zzh's business gauges, B1-01zzi's fund gauges, B1-01zzp's auto-payout gauges and the process
// metrics stay as they were.
import { afterEach, expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  type AutoPayoutDailySnapshot,
  type ReviewOverdueSnapshot,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { FUND_METRIC_NAMES, fundFromText, fundNamesIn } from '../../fund-metrics/kit.ts';
import { FIRST, WORKER } from '../../metrics-followups/kit.ts';
import { AUTO_METRIC_NAMES, autoFromText, autoNamesIn } from '../fund-alerts/kit.ts';
import {
  businessNamesIn,
  expectProcessMetrics,
  families,
  gauge,
  METRIC_KEYS,
  METRIC_NAMES,
} from '../kit.ts';
import { OVERDUE_METRIC, mentionsOverdue, overdueHelp, overdueValue } from './kit.ts';

afterEach(() => {
  vi.useRealTimers();
});

const AUTO: AutoPayoutDailySnapshot = {
  totalFen: { review_overdue_a: 1_000 },
  capFen: { review_overdue_a: 2_000 },
};

it('[AC-B2-05o#6] worker 的 registry 在 scrape 时调 collectReviewOverdue：有 # HELP 与 # TYPE couli_withdrawals_review_overdue gauge、无标签一条、值与快照一致；其余指标照旧', async () => {
  const collectReviewOverdue = vi.fn(async (): Promise<ReviewOverdueSnapshot> => ({
    reviewOverdue: 3,
  }));
  const registry = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: async () => FIRST,
    collectAutoPayout: async () => AUTO,
    collectReviewOverdue,
  });
  expect(collectReviewOverdue).not.toHaveBeenCalled();
  const text = await registry.render();
  expect(collectReviewOverdue).toHaveBeenCalledTimes(1);

  expect(families(text).get(OVERDUE_METRIC), `# TYPE of ${OVERDUE_METRIC}`).toBe('gauge');
  expect(overdueHelp(text).length, `# HELP of ${OVERDUE_METRIC}`).toBeGreaterThan(0);
  expect(overdueValue(text)).toBe(3);
  expect(text).toMatch(new RegExp(`^${OVERDUE_METRIC} 3$`, 'm'));

  // The surfaces of B1-01zzh, B1-01zzi and B1-01zzp are unchanged next to the new gauge.
  for (const key of METRIC_KEYS) expect(gauge(text, key), key).toEqual(WORKER[key]);
  expect(businessNamesIn(text)).toEqual(METRIC_NAMES);
  expect(fundNamesIn(text)).toEqual(FUND_METRIC_NAMES);
  expect(fundFromText(text)).toEqual(FIRST);
  expect(autoNamesIn(text)).toEqual(AUTO_METRIC_NAMES);
  expect(autoFromText(text)).toEqual(AUTO);
  expectProcessMetrics(text);
});

it('[AC-B2-05o#7] 0 也照样输出（规则读 > 0）；每次 scrape 取最新值、不常驻轮询', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate'] });
  const collectReviewOverdue = vi.fn<() => Promise<ReviewOverdueSnapshot>>();
  collectReviewOverdue
    .mockResolvedValueOnce({ reviewOverdue: 0 })
    .mockResolvedValueOnce({ reviewOverdue: 12 })
    .mockResolvedValueOnce({ reviewOverdue: 0 });
  const worker = createMetricsRegistry({ entry: 'worker', collectReviewOverdue });
  vi.advanceTimersByTime(15 * 60_000);
  expect(collectReviewOverdue).not.toHaveBeenCalled();
  vi.useRealTimers();

  const first = await worker.render();
  expect(families(first).get(OVERDUE_METRIC), `# TYPE of ${OVERDUE_METRIC}`).toBe('gauge');
  expect(overdueValue(first)).toBe(0);
  expect(overdueValue(await worker.render())).toBe(12);
  expect(overdueValue(await worker.render())).toBe(0);
  expect(collectReviewOverdue).toHaveBeenCalledTimes(3);
});

it('[AC-B2-05o#8] 只在 worker 且给了 collectReviewOverdue 时出现：api / stream / admin / payout 给了也不调用、不出指标名；worker 不给也没有', async () => {
  // Baseline first: the worker with collectReviewOverdue does export it.
  const baseline = await createMetricsRegistry({
    entry: 'worker',
    collectReviewOverdue: async () => ({ reviewOverdue: 1 }),
  }).render();
  expect(mentionsOverdue(baseline), 'worker baseline').toBe(true);

  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    const collectReviewOverdue = vi.fn(async () => ({ reviewOverdue: 1 }));
    for (const registry of [
      createMetricsRegistry({ entry }),
      createMetricsRegistry({ entry, collectReviewOverdue }),
    ]) {
      const text = await registry.render();
      expectProcessMetrics(text);
      expect(mentionsOverdue(text), entry).toBe(false);
    }
    expect(collectReviewOverdue, entry).not.toHaveBeenCalled();
  }
  for (const registry of [
    createMetricsRegistry({ entry: 'worker' }),
    createMetricsRegistry({
      entry: 'worker',
      collect: async () => WORKER,
      collectFund: async () => FIRST,
      collectAutoPayout: async () => AUTO,
    }),
  ]) {
    const text = await registry.render();
    expectProcessMetrics(text);
    expect(mentionsOverdue(text)).toBe(false);
  }
});

it('[AC-B2-05o#9] collectReviewOverdue 拒绝或同步抛出时 render() 拒绝（抓取失败可见）：不把计数编造成 0，也不沿用上一次的值；恢复后下一次 scrape 取新值', async () => {
  const failure = new Error('review overdue collection failed');
  const rejecting = vi.fn(async (): Promise<ReviewOverdueSnapshot> => {
    throw failure;
  });
  const failing = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: async () => FIRST,
    collectAutoPayout: async () => AUTO,
    collectReviewOverdue: rejecting,
  });
  await expect(failing.render()).rejects.toBe(failure);
  expect(rejecting).toHaveBeenCalledTimes(1);

  const throwing = createMetricsRegistry({
    entry: 'worker',
    collectReviewOverdue: (): Promise<ReviewOverdueSnapshot> => {
      throw failure;
    },
  });
  await expect(throwing.render()).rejects.toBe(failure);

  const collectReviewOverdue = vi.fn<() => Promise<ReviewOverdueSnapshot>>();
  collectReviewOverdue
    .mockResolvedValueOnce({ reviewOverdue: 4 })
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({ reviewOverdue: 2 });
  const worker = createMetricsRegistry({ entry: 'worker', collectReviewOverdue });
  expect(overdueValue(await worker.render())).toBe(4);
  await expect(worker.render()).rejects.toBe(failure);
  expect(overdueValue(await worker.render())).toBe(2);
  expect(collectReviewOverdue).toHaveBeenCalledTimes(3);
});
