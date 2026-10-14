import { expect, it } from 'vitest';
import { createScan } from '../freeze-expiry/kit.ts';
import { exclusiveQueue, fixture, healer, job } from './kit.ts';

it('[AC-B1-03u#1] 健康链补投与 handle 续投完全同 key，重复 worker 被 exclusive 去重且不额外扫描', async () => {
  const f = await fixture();
  const scan = healer(f.scan);
  const q = exclusiveQueue(f);
  f.clock.set('2026-10-15T00:05:23+08:00');
  await scan.handle(job('freeze-expiry'));
  await scan.handle(job('daily-alerts'));
  const chained = f.send.mock.calls.map(([queue, name, payload, options]) => ({
    queue,
    name,
    payload,
    options,
  }));
  expect(q.accepted).toEqual(['freeze-expiry:2026-10-14T16:06', 'daily-alerts:2026-10-16']);
  const queryCount = f.queries.length;
  f.send.mockClear();
  const peer = healer(await createScan(f.options));
  await Promise.all([scan.heal(), peer.heal()]);
  expect(f.send).toHaveBeenCalledTimes(4);
  for (const task of chained) {
    expect(f.send.mock.calls.filter(([, name]) => name === task.name)).toEqual([
      [task.queue, task.name, task.payload, task.options],
      [task.queue, task.name, task.payload, task.options],
    ]);
  }
  expect(q.accepted).toEqual(['freeze-expiry:2026-10-14T16:06', 'daily-alerts:2026-10-16']);
  expect(q.pending.size).toBe(2);
  expect(f.queries).toHaveLength(queryCount);
  expect(f.writes).not.toHaveBeenCalled();
  expect(f.logs()).toEqual([]);
});

for (const [name, nextKey, due, followingKey, table] of [
  [
    'freeze-expiry',
    'freeze-expiry:2026-10-14T16:06',
    '2026-10-15T00:06:00+08:00',
    'freeze-expiry:2026-10-14T16:07',
    'user_risk_state',
  ],
  [
    'daily-alerts',
    'daily-alerts:2026-10-16',
    '2026-10-16T00:05:00+08:00',
    'daily-alerts:2026-10-17',
    'appeals',
  ],
] as const) {
  it(`[AC-B1-03u#2] ${name} 续投失败断链后，不重启，heal 接上未来任务并在到点处理后继续续投`, async () => {
    const f = await fixture();
    const scan = healer(f.scan);
    f.clock.set('2026-10-15T00:05:23+08:00');
    f.send.mockRejectedValueOnce(new Error('fixture-chain-interrupted'));
    await expect(scan.handle(job(name))).resolves.toBeUndefined();
    expect(f.logs()).toContainEqual(expect.objectContaining({ msg: 'risk_scan_enqueue_failed' }));
    const q = exclusiveQueue(f);
    f.queries.length = 0;
    await scan.heal();
    expect(q.pending.size).toBe(2);
    expect(q.pending.get(nextKey)?.due).toBe(Date.parse(due));
    expect(f.queries).toEqual([]);
    f.clock.set(due);
    await q.consume(nextKey);
    expect(q.completed).toEqual([nextKey]);
    expect(f.queries.some((sql) => sql.includes(table))).toBe(true);
    expect(q.pending.has(nextKey)).toBe(false);
    expect(q.pending.has(followingKey)).toBe(true);
    expect(q.accepted.filter((key) => key === nextKey)).toHaveLength(1);
  });
}

for (const [now, minute, minuteDelay, day, dayDelay] of [
  ['2026-10-15T00:00:00+08:00', '2026-10-14T16:01', 60, '2026-10-16', 86700],
  ['2026-10-15T00:04:59.999+08:00', '2026-10-14T16:05', 1, '2026-10-16', 86401],
  ['2026-10-15T00:05:00+08:00', '2026-10-14T16:06', 60, '2026-10-16', 86400],
  ['2026-12-31T23:59:59+08:00', '2026-12-31T16:00', 1, '2027-01-01', 301],
  ['2026-12-31T23:59:59Z', '2027-01-01T00:00', 1, '2027-01-02', 57901],
] as const) {
  it(`[AC-B1-03u#3] ${now} 只按注入 Clock 补下一 UTC 分钟和下一 +08 日期，不补当前槽`, async () => {
    const f = await fixture();
    const scan = healer(f.scan);
    f.clock.set(now);
    await scan.heal();
    expect(f.send).toHaveBeenCalledTimes(2);
    for (const [name, singletonKey, delaySeconds] of [
      ['freeze-expiry', `freeze-expiry:${minute}`, minuteDelay],
      ['daily-alerts', `daily-alerts:${day}`, dayDelay],
    ]) {
      expect(f.send).toHaveBeenCalledWith(
        'risk-scan',
        name,
        {},
        { trx: null, singletonKey, delaySeconds },
      );
    }
    expect(f.queries).toEqual([]);
    expect(f.writes).not.toHaveBeenCalled();
  });
}

it('[AC-B1-03u#4] 当天 daily-alerts 已完成不再占 key，heal 仍只补明天，不重复当天告警', async () => {
  const f = await fixture();
  const scan = healer(f.scan);
  f.clock.set('2026-10-15T00:05:00+08:00');
  const q = exclusiveQueue(f);
  await scan.seed();
  await q.consume('daily-alerts:2026-10-15');
  expect(q.pending.has('daily-alerts:2026-10-15')).toBe(false);
  const queries = f.queries.length;
  await scan.heal();
  await scan.heal();
  expect(q.accepted.filter((key) => key.startsWith('daily-alerts:'))).toEqual([
    'daily-alerts:2026-10-15',
    'daily-alerts:2026-10-16',
  ]);
  expect(f.queries).toHaveLength(queries);
});

for (const failed of ['freeze-expiry', 'daily-alerts', 'both'] as const) {
  it(`[AC-B1-03u#5] ${failed} 补投失败只记规定 warn；另一条独立投递，下次仍能恢复`, async () => {
    const f = await fixture();
    const scan = healer(f.scan);
    const error = new Error('private-queue-failure-details');
    error.name = 'QueueUnavailable';
    f.send.mockImplementation(async (_queue, name) => {
      if (failed === 'both' || name === failed) throw error;
      return 'accepted';
    });
    await expect(scan.heal()).resolves.toBeUndefined();
    expect(f.send.mock.calls.map(([, name]) => name).sort()).toEqual([
      'daily-alerts',
      'freeze-expiry',
    ]);
    const failedNames = failed === 'both' ? ['daily-alerts', 'freeze-expiry'] : [failed];
    const warnings = f.logs().filter((line) => line['msg'] === 'risk_scan_heal_failed');
    expect(warnings).toHaveLength(failedNames.length);
    for (const name of failedNames) {
      expect(warnings).toContainEqual(
        expect.objectContaining({
          level: 40,
          queue: 'risk-scan',
          job_name: name,
          error_name: 'QueueUnavailable',
        }),
      );
    }
    expect(JSON.stringify(warnings)).not.toContain('private-queue-failure-details');
    f.send.mockClear();
    const q = exclusiveQueue(f);
    f.clock.advanceMs(300_000);
    await expect(scan.heal()).resolves.toBeUndefined();
    expect(q.pending.size).toBe(2);
    expect(q.accepted).toContain('freeze-expiry:2026-10-14T16:06');
    expect(f.queries).toEqual([]);
  });
}
