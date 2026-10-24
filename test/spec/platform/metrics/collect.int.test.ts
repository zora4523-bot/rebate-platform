// B1-01zzh brief B.2: collectWorkerMetrics(db, clock) reads pgboss.job and app.sync_cursors with
// read-only SQL. Backlog and the evt age count only created jobs that are due (start_after ≤ now,
// ADR-0001 §4.2 #14, 规划/02 §13); "now" is the injected clock, never the database's now(): the
// fixture's clock is years after the database's real time. It runs on a session whose every
// transaction is READ ONLY, so any write fails in PostgreSQL itself.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  collectWorkerMetrics,
  createMetricsRegistry,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import {
  BUSINESS_QUEUES,
  DEAD_QUEUES,
  METRIC_KEYS,
  NOW,
  at,
  businessNamesIn,
  cursorSnapshot,
  expectProcessMetrics,
  expectSeries,
  gauge,
  insertJob,
  jobSnapshot,
  prepareQueues,
  readOnlyUrl,
  seedFixture,
} from './kit.ts';

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  return {
    db,
    readOnly,
    async close() {
      await destroyDb(readOnly);
      await destroyDb(db);
      await database.drop();
    },
  };
}

it('[AC-B1-01zzh#6] 快照与夹具一致：failed 按队列（含 .dead）、死信只计 created/retry、积压与 evt 年龄只计 created 且按注入时钟已到期、水位延迟按平台取最老游标', async () => {
  const t = await open();
  try {
    const expected = await seedFixture(t.db);
    // The session really is read-only: the collector cannot write behind the test's back.
    await expect(
      insertJob(t.readOnly, 'notify', 'created', at(0)),
      'fixture session must be read-only',
    ).rejects.toThrow(/read-only/);
    const jobsBefore = await jobSnapshot(t.db);
    const cursorsBefore = await cursorSnapshot(t.db);
    const clock = new FixedClock(NOW);

    const snapshot = await collectWorkerMetrics(t.readOnly, clock);
    expectSeries(snapshot.queueFailed, 'queueFailed', expected.queueFailed);
    expectSeries(snapshot.deadLetters, 'deadLetters', expected.deadLetters);
    expectSeries(snapshot.backlog, 'backlog', expected.backlog);
    expectSeries(
      snapshot.oldestDueEvtAgeSeconds,
      'oldestDueEvtAgeSeconds',
      expected.oldestDueEvtAgeSeconds,
    );
    // Platforms without a cursor have no series at all.
    expect(snapshot.syncWatermarkLagSeconds).toEqual(expected.syncWatermarkLagSeconds);
    // A dead letter queue is not a business queue, and an evt dead letter queue is no event queue.
    expect(Object.keys(snapshot.backlog).filter((q) => q.endsWith('.dead'))).toEqual([]);
    expect(
      Object.keys(snapshot.oldestDueEvtAgeSeconds).filter(
        (q) => !q.startsWith('evt.') || q.endsWith('.dead'),
      ),
    ).toEqual([]);
    expect(
      Object.keys(snapshot.deadLetters).filter((q) => !q.endsWith('.dead') && q !== 'dead-letter'),
    ).toEqual([]);

    // One minute later on the injected clock only: due-ness and ages follow the clock.
    clock.advanceMs(60_000);
    const later = await collectWorkerMetrics(t.readOnly, clock);
    expectSeries(later.backlog, 'backlog', {
      ...expected.backlog,
      notify: 4, // the job due at +60 s is due now (start_after ≤ now)
      poster: 1,
      'evt.notification-risk-state': 1,
    });
    expectSeries(later.oldestDueEvtAgeSeconds, 'oldestDueEvtAgeSeconds', {
      'evt.payout-went-negative': 185,
      'evt.notification-claim-result': 60,
      'evt.notification-risk-state': 55,
    });
    expect(later.syncWatermarkLagSeconds).toEqual({ taobao: 4060, pdd: 90 });
    expectSeries(later.queueFailed, 'queueFailed', expected.queueFailed);
    expectSeries(later.deadLetters, 'deadLetters', expected.deadLetters);

    expect(await jobSnapshot(t.db)).toEqual(jobsBefore);
    expect(await cursorSnapshot(t.db)).toEqual(cursorsBefore);
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzh#7] 空库：各目录队列都列出且为 0，没有游标就没有水位序列', async () => {
  const t = await open();
  try {
    await prepareQueues(t.db, [...BUSINESS_QUEUES, ...DEAD_QUEUES]);
    const snapshot = await collectWorkerMetrics(t.readOnly, new FixedClock(NOW));
    for (const key of METRIC_KEYS.filter((k) => k !== 'syncWatermarkLagSeconds')) {
      expectSeries(snapshot[key], key, {});
    }
    expect(snapshot.syncWatermarkLagSeconds).toEqual({});
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzh#8] worker registry 以真实库为 collect 渲染：五类指标的文本数值与夹具、快照一致', async () => {
  const t = await open();
  try {
    const expected = await seedFixture(t.db);
    const clock = new FixedClock(NOW);
    const registry = createMetricsRegistry({
      entry: 'worker',
      collect: () => collectWorkerMetrics(t.readOnly, clock),
    });
    const text = await registry.render();
    expectProcessMetrics(text);
    expect(businessNamesIn(text).length).toBe(METRIC_KEYS.length);
    for (const key of METRIC_KEYS.filter((k) => k !== 'syncWatermarkLagSeconds')) {
      expectSeries(gauge(text, key), key, expected[key]);
    }
    expect(gauge(text, 'syncWatermarkLagSeconds')).toEqual(expected.syncWatermarkLagSeconds);
    expect(text).toMatch(/^couli_queue_failed_jobs\{[^}]*queue="settle"[^}]*\} 0$/m);
    expect(text).toMatch(/^couli_queue_dead_letters\{[^}]*queue="notify\.dead"[^}]*\} 2$/m);
    expect(text).toMatch(
      /^couli_evt_oldest_due_created_age_seconds\{[^}]*queue="evt\.payout-went-negative"[^}]*\} 125$/m,
    );
    expect(text).toMatch(/^couli_sync_watermark_lag_seconds\{[^}]*platform="taobao"[^}]*\} 4000$/m);
    // Scrape time, not creation time: the next scrape sees the next minute and a new failed job.
    await insertJob(t.db, 'settle', 'failed', at(-1));
    clock.advanceMs(60_000);
    const next = await registry.render();
    expect(gauge(next, 'queueFailed')['settle']).toBe(1);
    expect(gauge(next, 'syncWatermarkLagSeconds')).toEqual({ taobao: 4060, pdd: 90 });
  } finally {
    await t.close();
  }
}, 60_000);
