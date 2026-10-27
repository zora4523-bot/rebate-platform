// B1-01zzp: createMetricsRegistry({ entry, collect?, collectFund?, collectAutoPayout? }). Only entry
// 'worker' with a collectAutoPayout function exports the two auto-payout daily gauges
// couli_auto_payout_daily_total_fen{app_id} and couli_auto_payout_daily_cap_fen{app_id}, filled by
// collectAutoPayout at scrape time (render), never by a resident polling loop; a rejected collection
// rejects render() (the scrape fails visibly, no value is made up). B1-01zzh's business gauges,
// B1-01zzi's fund gauges and the process metrics stay as they were.
import { afterEach, expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  type AutoPayoutDailySnapshot,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { FUND_METRIC_NAMES, fundFromText, fundNamesIn } from '../../fund-metrics/kit.ts';
import { FIRST, WORKER } from '../../metrics-followups/kit.ts';
import {
  businessNamesIn,
  expectProcessMetrics,
  families,
  gauge,
  METRIC_KEYS,
  METRIC_NAMES,
} from '../kit.ts';
import {
  APP_A,
  APP_B,
  AUTO_METRIC_NAMES,
  CAP_METRIC,
  TOTAL_METRIC,
  autoFromText,
  autoGauge,
  autoNamesIn,
} from './kit.ts';

afterEach(() => {
  vi.useRealTimers();
});

const ONE: AutoPayoutDailySnapshot = {
  totalFen: { [APP_A]: 160_000, [APP_B]: 0 },
  capFen: { [APP_A]: 200_000, [APP_B]: 50_000 },
};

const TWO: AutoPayoutDailySnapshot = {
  // APP_B's cap row was removed: its series disappear instead of keeping the old values.
  totalFen: { [APP_A]: 123_456_789 },
  capFen: { [APP_A]: 0 },
};

it('[AC-B1-01zzp#4] worker 的 registry 在 scrape 时调 collectAutoPayout：两个 gauge 按 app_id 各一条序列、值与快照一致（0 照样输出），B1-01zzh 业务 gauge、B1-01zzi 资金 gauge 与进程级指标照旧', async () => {
  const collect = vi.fn(async () => WORKER);
  const collectFund = vi.fn(async () => FIRST);
  const collectAutoPayout = vi.fn(async () => ONE);
  const registry = createMetricsRegistry({
    entry: 'worker',
    collect,
    collectFund,
    collectAutoPayout,
  });
  expect(collectAutoPayout).not.toHaveBeenCalled();
  const text = await registry.render();
  expect(collectAutoPayout).toHaveBeenCalledTimes(1);

  for (const name of AUTO_METRIC_NAMES) {
    expect(families(text).get(name), `# TYPE of ${name}`).toBe('gauge');
  }
  expect(autoNamesIn(text)).toEqual(AUTO_METRIC_NAMES);
  expect(autoFromText(text)).toEqual(ONE);
  expect(text).toMatch(new RegExp(`^${TOTAL_METRIC}\\{app_id="${APP_A}"\\} 160000$`, 'm'));
  expect(text).toMatch(new RegExp(`^${TOTAL_METRIC}\\{app_id="${APP_B}"\\} 0$`, 'm'));
  expect(text).toMatch(new RegExp(`^${CAP_METRIC}\\{app_id="${APP_A}"\\} 200000$`, 'm'));

  // The surfaces of B1-01zzh and B1-01zzi are unchanged next to the new gauges.
  for (const key of METRIC_KEYS) expect(gauge(text, key), key).toEqual(WORKER[key]);
  expect(businessNamesIn(text)).toEqual(METRIC_NAMES);
  expect(fundNamesIn(text)).toEqual(FUND_METRIC_NAMES);
  expect(fundFromText(text)).toEqual(FIRST);
  expectProcessMetrics(text);
});

it('[AC-B1-01zzp#5] 自动到账 gauge 只在 worker 且给了 collectAutoPayout 时出现：api / stream / admin / payout 给了也不调用、不出指标名；worker 不给也没有', async () => {
  // Baseline first: the worker with collectAutoPayout does export them.
  const baseline = await createMetricsRegistry({
    entry: 'worker',
    collectAutoPayout: async () => ONE,
  }).render();
  expect(autoNamesIn(baseline)).toEqual(AUTO_METRIC_NAMES);

  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    const collectAutoPayout = vi.fn(async () => ONE);
    for (const registry of [
      createMetricsRegistry({ entry }),
      createMetricsRegistry({ entry, collectAutoPayout }),
    ]) {
      const text = await registry.render();
      expectProcessMetrics(text);
      expect(autoNamesIn(text), entry).toEqual([]);
    }
    expect(collectAutoPayout, entry).not.toHaveBeenCalled();
  }
  for (const registry of [
    createMetricsRegistry({ entry: 'worker' }),
    createMetricsRegistry({
      entry: 'worker',
      collect: async () => WORKER,
      collectFund: async () => FIRST,
    }),
  ]) {
    const text = await registry.render();
    expectProcessMetrics(text);
    expect(autoNamesIn(text)).toEqual([]);
  }
});

it('[AC-B1-01zzp#6] 每次 scrape 取最新快照：不常驻轮询；消失的 app_id 不留旧序列；大额按整数输出；没有任何 app_id 时两个指标族仍有 TYPE 行而无序列', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate'] });
  const collectAutoPayout = vi.fn<() => Promise<AutoPayoutDailySnapshot>>();
  collectAutoPayout
    .mockResolvedValueOnce(ONE)
    .mockResolvedValueOnce(TWO)
    .mockResolvedValueOnce({ totalFen: {}, capFen: {} });
  const worker = createMetricsRegistry({ entry: 'worker', collectAutoPayout });
  vi.advanceTimersByTime(15 * 60_000);
  expect(collectAutoPayout).not.toHaveBeenCalled();
  vi.useRealTimers();

  expect(autoFromText(await worker.render())).toEqual(ONE);
  const second = await worker.render();
  expect(collectAutoPayout).toHaveBeenCalledTimes(2);
  expect(autoFromText(second)).toEqual(TWO);
  expect(second).not.toMatch(new RegExp(`app_id="${APP_B}"`));
  expect(second).toMatch(new RegExp(`^${TOTAL_METRIC}\\{app_id="${APP_A}"\\} 123456789$`, 'm'));

  const third = await worker.render();
  expect(collectAutoPayout).toHaveBeenCalledTimes(3);
  for (const name of AUTO_METRIC_NAMES) {
    expect(families(third).get(name), `# TYPE of ${name}`).toBe('gauge');
    expect(autoGauge(third, name), name).toEqual({});
  }
});

it('[AC-B1-01zzp#7] collectAutoPayout 拒绝或同步抛出时 render() 拒绝（抓取失败可见）：不把合计编造成 0，也不沿用上一次的快照；恢复后下一次 scrape 取新值', async () => {
  const failure = new Error('auto payout collection failed');
  const rejecting = vi.fn(async (): Promise<AutoPayoutDailySnapshot> => {
    throw failure;
  });
  const failing = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: async () => FIRST,
    collectAutoPayout: rejecting,
  });
  await expect(failing.render()).rejects.toBe(failure);
  expect(rejecting).toHaveBeenCalledTimes(1);

  const throwing = createMetricsRegistry({
    entry: 'worker',
    collectAutoPayout: (): Promise<AutoPayoutDailySnapshot> => {
      throw failure;
    },
  });
  await expect(throwing.render()).rejects.toBe(failure);

  const collectAutoPayout = vi.fn<() => Promise<AutoPayoutDailySnapshot>>();
  collectAutoPayout
    .mockResolvedValueOnce(ONE)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(TWO);
  const worker = createMetricsRegistry({ entry: 'worker', collectAutoPayout });
  expect(autoFromText(await worker.render())).toEqual(ONE);
  await expect(worker.render()).rejects.toBe(failure);
  const recovered = await worker.render();
  expect(collectAutoPayout).toHaveBeenCalledTimes(3);
  expect(autoFromText(recovered)).toEqual(TWO);
});
