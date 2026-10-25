// B1-01zzi brief B.2: createMetricsRegistry({ entry, collect?, collectFund? }). Only entry 'worker'
// with a collectFund function exports the five fund gauges, filled by collectFund at scrape time
// (render), never by a resident polling loop: couli_order_sync_pending_open{reason} and the four
// unlabelled gauges couli_settle_bill_jobs_failed, couli_settle_batches_partial,
// couli_beneficiary_held_over_30d, couli_withdrawals_paying_needs_manual. B1-01zzh's process
// metrics and five business gauges stay as they were.
import { afterEach, expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  type FundMetricsSnapshot,
  type WorkerMetricsSnapshot,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import {
  businessNamesIn,
  expectProcessMetrics,
  families,
  gauge,
  METRIC_KEYS,
  METRIC_NAMES,
} from '../metrics/kit.ts';
import {
  FUND_METRIC_NAMES,
  PENDING_METRIC,
  SCALAR_KEYS,
  SCALAR_METRICS,
  fundFromText,
  fundNamesIn,
  pendingGauge,
  scalarGauge,
} from './kit.ts';

afterEach(() => {
  vi.useRealTimers();
});

const WORKER: WorkerMetricsSnapshot = {
  queueFailed: { notify: 2, settle: 0 },
  deadLetters: { 'notify.dead': 1 },
  backlog: { notify: 7 },
  oldestDueEvtAgeSeconds: { 'evt.payout-went-negative': 125 },
  syncWatermarkLagSeconds: { taobao: 4000 },
};

const FIRST: FundMetricsSnapshot = {
  orderSyncPendingOpen: { UNMAPPED_STATUS: 3, ILLEGAL_TRANSITION: 1 },
  billJobsFailed: 2,
  partialBatches: 1,
  beneficiariesHeldOver30Days: 4,
  payingNeedsManual: 5,
};

const SECOND: FundMetricsSnapshot = {
  // ILLEGAL_TRANSITION was closed: its series disappears instead of keeping the old value.
  orderSyncPendingOpen: { UNMAPPED_STATUS: 1, NO_RECEIVED_AT: 2 },
  // Zero values are exported as 0, not left out (the rules compare with > 0).
  billJobsFailed: 0,
  partialBatches: 3,
  beneficiariesHeldOver30Days: 0,
  payingNeedsManual: 1,
};

it('[AC-B1-01zzi#1] worker 的 registry 在 scrape 时调 collectFund：五类资金 gauge（pending 带 reason，其余四个无标签）与快照一致，B1-01zzh 的业务 gauge 与进程级指标照旧', async () => {
  const collect = vi.fn(async () => WORKER);
  const collectFund = vi.fn(async () => FIRST);
  const registry = createMetricsRegistry({ entry: 'worker', collect, collectFund });
  expect(collectFund).not.toHaveBeenCalled();
  const text = await registry.render();
  expect(collectFund).toHaveBeenCalledTimes(1);
  expect(collect).toHaveBeenCalledTimes(1);

  for (const name of FUND_METRIC_NAMES) {
    expect(families(text).get(name), `# TYPE of ${name}`).toBe('gauge');
  }
  expect(fundNamesIn(text)).toEqual(FUND_METRIC_NAMES);
  expect(fundFromText(text)).toEqual(FIRST);
  expect(text).toMatch(/^couli_order_sync_pending_open\{reason="UNMAPPED_STATUS"\} 3$/m);
  expect(text).toMatch(/^couli_withdrawals_paying_needs_manual 5$/m);

  // B1-01zzh's surface is unchanged next to the fund gauges.
  for (const key of METRIC_KEYS) expect(gauge(text, key), key).toEqual(WORKER[key]);
  expect(businessNamesIn(text)).toEqual(METRIC_NAMES);
  expectProcessMetrics(text);
});

it('[AC-B1-01zzi#2] 资金指标只在 worker 且给了 collectFund 时出现：api / stream / admin / payout 给了也不调用、不出资金指标名；worker 不给 collectFund 也没有', async () => {
  // Baseline first: the worker with collectFund does export them.
  const baseline = await createMetricsRegistry({
    entry: 'worker',
    collectFund: async () => FIRST,
  }).render();
  expect(fundNamesIn(baseline)).toEqual(FUND_METRIC_NAMES);

  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    const collectFund = vi.fn(async () => FIRST);
    for (const registry of [
      createMetricsRegistry({ entry }),
      createMetricsRegistry({ entry, collectFund }),
    ]) {
      const text = await registry.render();
      expectProcessMetrics(text);
      expect(fundNamesIn(text), entry).toEqual([]);
    }
    expect(collectFund, entry).not.toHaveBeenCalled();
  }
  for (const registry of [
    createMetricsRegistry({ entry: 'worker' }),
    createMetricsRegistry({ entry: 'worker', collect: async () => WORKER }),
  ]) {
    const text = await registry.render();
    expectProcessMetrics(text);
    expect(fundNamesIn(text)).toEqual([]);
  }
});

it('[AC-B1-01zzi#3] 每次 scrape 取最新资金快照：不常驻轮询，消失的 reason 不留旧序列，0 照样输出', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate'] });
  const collectFund = vi.fn<() => Promise<FundMetricsSnapshot>>();
  collectFund.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(SECOND);
  const worker = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund,
  });
  vi.advanceTimersByTime(15 * 60_000);
  expect(collectFund).not.toHaveBeenCalled();
  vi.useRealTimers();

  const first = await worker.render();
  expect(pendingGauge(first)).toEqual(FIRST.orderSyncPendingOpen);
  for (const key of SCALAR_KEYS) expect(scalarGauge(first, key), key).toBe(FIRST[key]);

  const second = await worker.render();
  expect(collectFund).toHaveBeenCalledTimes(2);
  expect(pendingGauge(second)).toEqual(SECOND.orderSyncPendingOpen);
  expect(second).not.toMatch(/reason="ILLEGAL_TRANSITION"/);
  for (const key of SCALAR_KEYS) expect(scalarGauge(second, key), key).toBe(SECOND[key]);
  expect(second).toMatch(new RegExp(`^${SCALAR_METRICS.billJobsFailed} 0$`, 'm'));
  expect(second).toMatch(new RegExp(`^${SCALAR_METRICS.beneficiariesHeldOver30Days} 0$`, 'm'));

  // No open pending row at all: the family has no series rather than a made-up one.
  collectFund.mockResolvedValueOnce({ ...SECOND, orderSyncPendingOpen: {} });
  const third = await worker.render();
  expect(pendingGauge(third)).toEqual({});
  expect(third).not.toMatch(new RegExp(`^${PENDING_METRIC}[{ ]`, 'm'));
  for (const key of SCALAR_KEYS) expect(scalarGauge(third, key), key).toBe(SECOND[key]);
});

it('[AC-B1-01zzi#16] collectFund 拒绝时 render() 拒绝（抓取失败可见）：不把资金 gauge 编造成 0，也不沿用上一次的快照；恢复后下一次 scrape 取新值', async () => {
  const failure = new Error('fund collection failed');
  // Rejected from the first scrape on.
  const rejecting = vi.fn(async (): Promise<FundMetricsSnapshot> => {
    throw failure;
  });
  const failing = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: rejecting,
  });
  await expect(failing.render()).rejects.toBe(failure);
  expect(rejecting).toHaveBeenCalledTimes(1);

  // A collector that throws synchronously still makes the scrape fail, not a text without values.
  const throwing = createMetricsRegistry({
    entry: 'worker',
    collectFund: (): Promise<FundMetricsSnapshot> => {
      throw failure;
    },
  });
  await expect(throwing.render()).rejects.toBe(failure);

  // After a good scrape, a failing one rejects instead of re-serving FIRST or zeros; the next good
  // scrape renders its own values.
  const collectFund = vi.fn<() => Promise<FundMetricsSnapshot>>();
  collectFund
    .mockResolvedValueOnce(FIRST)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(SECOND);
  const worker = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund,
  });
  expect(fundFromText(await worker.render())).toEqual(FIRST);
  await expect(worker.render()).rejects.toBe(failure);
  const recovered = await worker.render();
  expect(collectFund).toHaveBeenCalledTimes(3);
  expect(fundFromText(recovered)).toEqual(SECOND);
});
