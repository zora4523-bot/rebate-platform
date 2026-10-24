// B1-03w rule tests on the real queue runtime and a real PostgreSQL: the risk-scan chain's sends
// (seed at worker start, continuation after a handled job, self-heal) are accepted by
// platform/queue — the job rows exist in pgboss.job — and the worker actually consumes them: a
// freeze past frozen_until is released through the risk state service (BR-ID-31 / BR-ID-36) and
// the daily alerts are logged. Job names `freeze_expiry` / `daily_alerts` (orchestrator §9.2 #1);
// keys accept either readable prefix (§9.2 #2, see ./kit.ts). Top-level it() only.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  DAY_MS,
  MINUTE_MS,
  dayOf,
  keyPattern,
  linesOf,
  minuteOf,
  scanModule,
  settle,
} from './kit.ts';
import { chainOn, until, type Chain } from './int-kit.ts';

const FAILURES = [
  'risk_scan_seed_failed',
  'risk_scan_heal_failed',
  'risk_scan_enqueue_failed',
  'job_failed',
  'job_failed_final',
];

async function withChain<T>(
  options: { at: string | null; consume: boolean },
  run: (chain: Chain) => Promise<T>,
): Promise<T> {
  const database: TestDatabase = await createTestDatabase();
  try {
    const chain = await chainOn(database, options);
    try {
      return await run(chain);
    } finally {
      await chain.close();
    }
  } finally {
    await database.drop();
  }
}

it('[B1-03w#1] worker 启动种子（seedRiskScan → seed）被真实队列接受：risk-scan 队列里两种任务各一个、当前槽位 key、立即可取，不记 risk_scan_seed_failed；重复 seed 不重复入队', async () => {
  const seen = await withChain({ at: '2026-10-15T00:00:23+08:00', consume: false }, async (c) => {
    const { seedRiskScan } = await scanModule();
    await seedRiskScan(
      () => c.scan,
      c.logger,
      () => false,
    );
    const again = await settle(c.scan.seed());
    return { again, jobs: await c.jobs(), failures: linesOf(c.lines, FAILURES) };
  });
  expect(seen).toEqual({
    again: 'resolved',
    jobs: [
      {
        job: 'daily_alerts',
        singletonKey: expect.stringMatching(keyPattern('daily_alerts', '2026-10-15')),
        state: 'created',
        deferred: false,
        payload: {},
      },
      {
        job: 'freeze_expiry',
        singletonKey: expect.stringMatching(keyPattern('freeze_expiry', '2026-10-14T16:00')),
        state: 'created',
        deferred: false,
        payload: {},
      },
    ],
    failures: [],
  });
}, 180_000);

it('[B1-03w#2] heal 把两个「下一槽位」任务送进真实队列（延后到期），重复 heal 由 singletonKey 去重不重复入队，不记 risk_scan_heal_failed', async () => {
  const seen = await withChain({ at: '2026-10-15T00:00:23+08:00', consume: false }, async (c) => {
    const first = await settle(c.scan.heal());
    const second = await settle(c.scan.heal());
    return { first, second, jobs: await c.jobs(), failures: linesOf(c.lines, FAILURES) };
  });
  expect(seen).toEqual({
    first: 'resolved',
    second: 'resolved',
    jobs: [
      {
        job: 'daily_alerts',
        singletonKey: expect.stringMatching(keyPattern('daily_alerts', '2026-10-16')),
        state: 'created',
        deferred: true,
        payload: {},
      },
      {
        job: 'freeze_expiry',
        singletonKey: expect.stringMatching(keyPattern('freeze_expiry', '2026-10-14T16:01')),
        state: 'created',
        deferred: true,
        payload: {},
      },
    ],
    failures: [],
  });
}, 180_000);

it('[B1-03w#3][BR-ID-31] worker 真正消费：freeze_expiry 把 frozen_until 已过的用户经风控状态服务解冻、daily_alerts 记不定期冻结超期告警，两者各自续排下一槽位；先跑的 heal 与续排同键去重，队列里每种任务恰好一个已完成的当前槽与一个排队中的下一槽', async () => {
  const seen = await withChain({ at: null, consume: true }, async (c) => {
    const now = c.clock.now().getTime();
    const expiring = await c.user({ frozen_until: new Date(now - 1) });
    const indefinite = await c.user({
      frozen_until: null,
      changed_at: new Date(now - 30 * DAY_MS),
    });
    const healed = await settle(c.scan.heal());
    const { seedRiskScan } = await scanModule();
    await seedRiskScan(
      () => c.scan,
      c.logger,
      () => false,
    );
    const overdue = () =>
      linesOf(c.lines, ['risk_freeze_indefinite_overdue']).filter(
        (line) => line['user_id'] === indefinite.user_id,
      );
    const settled = await until(async () => {
      const jobs = await c.jobs();
      const released = (await c.stateOf(expiring))['state'] === 'normal';
      const completed = new Set(
        jobs.filter((job) => job.state === 'completed').map((job) => job.job),
      );
      return released && overdue().length > 0 && completed.size === 2;
    });
    return {
      settled,
      healed,
      expiring: await c.stateOf(expiring),
      indefinite: (await c.stateOf(indefinite))['state'],
      overdue: overdue().map((line) => ({
        level: line['level'],
        app_id: line['app_id'],
        user_id: line['user_id'],
      })),
      jobs: await c.jobs(),
      failures: linesOf(c.lines, FAILURES),
      keys: {
        minute: minuteOf(now),
        nextMinute: minuteOf(now + MINUTE_MS),
        day: dayOf(now),
        nextDay: dayOf(now + DAY_MS),
      },
      expiringSubject: expiring,
      indefiniteSubject: indefinite,
    };
  });
  const { keys } = seen;
  expect(seen).toEqual({
    settled: true,
    healed: 'resolved',
    expiring: expect.objectContaining({
      ...seen.expiringSubject,
      state: 'normal',
      frozen_until: null,
      reason: null,
      changed_by: 'system:freeze-expiry',
      row_version: 8,
    }),
    indefinite: 'frozen',
    overdue: [{ level: 40, ...seen.indefiniteSubject }],
    jobs: [
      {
        job: 'daily_alerts',
        singletonKey: expect.stringMatching(keyPattern('daily_alerts', keys.day)),
        state: 'completed',
        deferred: false,
        payload: {},
      },
      {
        job: 'daily_alerts',
        singletonKey: expect.stringMatching(keyPattern('daily_alerts', keys.nextDay)),
        state: 'created',
        deferred: true,
        payload: {},
      },
      {
        job: 'freeze_expiry',
        singletonKey: expect.stringMatching(keyPattern('freeze_expiry', keys.minute)),
        state: 'completed',
        deferred: false,
        payload: {},
      },
      {
        job: 'freeze_expiry',
        singletonKey: expect.stringMatching(keyPattern('freeze_expiry', keys.nextMinute)),
        state: 'created',
        deferred: true,
        payload: {},
      },
    ],
    failures: [],
    keys,
    expiringSubject: seen.expiringSubject,
    indefiniteSubject: seen.indefiniteSubject,
  });
}, 240_000);
