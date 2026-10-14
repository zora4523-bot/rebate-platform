// Unit tests of the chain self-heal (B1-03u §10): heal() sends and the heal timer. No database:
// heal() reads nothing, so the scan runs on a Kysely handle that is never queried.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock, createRootLogger, type JobQueue } from '../../platform/index.ts';
import { startRiskScanHeal, type RiskScanHealSchedule } from './risk-scan-heal.ts';
import { createRiskScan } from './risk-scan.ts';
import type { RiskStateService } from './risk-state.ts';

function harness() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const send = vi.fn<JobQueue['send']>(async () => 'job');
  const clock = new FixedClock('2026-10-15T00:05:23+08:00');
  const scan = createRiskScan({
    db: {} as Kysely<DB>,
    clock,
    riskState: {} as RiskStateService,
    queue: { send },
    logger,
  });
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, send, scan, logs };
}

it('[B1-03u §10] heal sends the next slot of both jobs with the continuation keys and logs nothing', async () => {
  const h = harness();
  await h.scan.heal();
  expect(h.send.mock.calls).toEqual([
    [
      'risk-scan',
      'freeze-expiry',
      {},
      { trx: null, singletonKey: 'freeze-expiry:2026-10-14T16:06', delaySeconds: 37 },
    ],
    [
      'risk-scan',
      'daily-alerts',
      {},
      { trx: null, singletonKey: 'daily-alerts:2026-10-16', delaySeconds: 86_377 },
    ],
  ]);
  expect(h.logs()).toEqual([]);
});

it('[B1-03u §10] a failed heal send is a warn line and the other job is still sent', async () => {
  const h = harness();
  h.send.mockRejectedValueOnce(new Error('queue-down-detail'));
  await expect(h.scan.heal()).resolves.toBeUndefined();
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(h.logs()).toEqual([
    expect.objectContaining({
      level: 40,
      msg: 'risk_scan_heal_failed',
      queue: 'risk-scan',
      job_name: 'freeze-expiry',
      error_name: 'Error',
    }),
  ]);
  expect(JSON.stringify(h.logs())).not.toContain('queue-down-detail');
});

it('[B1-03u §10] a failing provider lookup installs no timer and is a warn line', () => {
  const h = harness();
  const schedule = vi.fn<RiskScanHealSchedule>(() => ({ stop: () => undefined }));
  const control = startRiskScanHeal(
    () => {
      throw new Error('no-provider');
    },
    h.logger,
    () => false,
    schedule,
  );
  control.stop();
  expect(schedule).not.toHaveBeenCalled();
  expect(h.logs()).toEqual([
    expect.objectContaining({ level: 40, msg: 'risk_scan_heal_failed', queue: 'risk-scan' }),
  ]);
});

it('[B1-03u §10] stop cancels the timer once, however often it is called', () => {
  const h = harness();
  const cancel = vi.fn();
  const control = startRiskScanHeal(
    () => h.scan,
    h.logger,
    () => false,
    () => ({ stop: cancel }),
  );
  control.stop();
  control.stop();
  expect(cancel).toHaveBeenCalledTimes(1);
});
