// B1-01zzh rule-test kit (规划/02 §11, §13; ADR-0001 §4.2 #14; orchestrator brief B.1–B.4).
// The queue list and the metric names are written out here, independent of the code under test, so
// a forgotten queue or a renamed gauge fails instead of passing empty. Prometheus text is parsed by
// a small strict reader below. The test database comes from the int tests (@couli/db/testing is
// allowed in *.int.test.ts only); this kit only sees a structural `urlFor`.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  sql,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect } from 'vitest';
import type { WorkerMetricsSnapshot } from '../../../../apps/api/src/modules/platform/metrics/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);

/** The injected clock's instant. The database's own now() is years earlier on purpose. */
export const NOW = '2031-04-05T06:07:08.000Z';

/** NOW shifted by whole seconds, as an ISO instant. */
export function at(offsetSeconds: number): string {
  return new Date(Date.parse(NOW) + offsetSeconds * 1000).toISOString();
}

// Same list as B1-01zzg's kit, kept independent of apps/api's catalog.
export const BUSINESS_QUEUES = [
  'order-sync',
  'order-rescan',
  'settle',
  'payout',
  'notify',
  'union-auth',
  'evt.notification-risk-state',
  'evt.notification-appeal-result',
  'evt.notification-claim-result',
  'evt.payout-went-negative',
  'pay',
  'pool-refresh',
  'page-schedule',
  'poster',
  'agent-trace',
  'risk-scan',
  'export',
] as const;
export const DEAD_QUEUES: readonly string[] = BUSINESS_QUEUES.map((q) => `${q}.dead`);
export const EVT_QUEUES: readonly string[] = BUSINESS_QUEUES.filter((q) => q.startsWith('evt.'));

/** Orchestrator brief B.2: the five business gauges and their one label. */
export const METRICS = {
  queueFailed: { name: 'couli_queue_failed_jobs', label: 'queue' },
  deadLetters: { name: 'couli_queue_dead_letters', label: 'queue' },
  backlog: { name: 'couli_queue_backlog_jobs', label: 'queue' },
  oldestDueEvtAgeSeconds: { name: 'couli_evt_oldest_due_created_age_seconds', label: 'queue' },
  syncWatermarkLagSeconds: { name: 'couli_sync_watermark_lag_seconds', label: 'platform' },
} as const satisfies Record<keyof WorkerMetricsSnapshot, { name: string; label: string }>;
export const METRIC_KEYS = Object.keys(METRICS) as (keyof WorkerMetricsSnapshot)[];
export const METRIC_NAMES: readonly string[] = METRIC_KEYS.map((key) => METRICS[key].name);

// ---- Prometheus text ---------------------------------------------------------------------------

export interface Sample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?[ \t]+(\S+)(?:[ \t]+-?\d+)?$/;
const LABEL_PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** Every sample line of a text exposition (comments and blank lines skipped). */
export function samples(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const match = SAMPLE_LINE.exec(line);
    expect(match, `not a Prometheus sample line: ${line}`).not.toBeNull();
    const labels: Record<string, string> = {};
    for (const pair of (match![2] ?? '').matchAll(LABEL_PAIR)) {
      labels[pair[1]!] = pair[2]!.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
    }
    out.push({ name: match![1]!, labels, value: Number(match![3]) });
  }
  return out;
}

/** `# TYPE <name> <type>` lines: metric family name → type. */
export function families(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of text.matchAll(/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (\w+)$/gm)) {
    out.set(match[1]!, match[2]!);
  }
  return out;
}

/** One gauge's series as { label value: sample value }. Every series must carry the label. */
export function gauge(text: string, key: keyof WorkerMetricsSnapshot): Record<string, number> {
  const { name, label } = METRICS[key];
  const out: Record<string, number> = {};
  for (const sample of samples(text).filter((s) => s.name === name)) {
    const value = sample.labels[label];
    expect(value, `${name} series without label ${label}`).toEqual(expect.any(String));
    expect(Object.hasOwn(out, value!), `${name}{${label}="${value}"} appears twice`).toBe(false);
    out[value!] = sample.value;
  }
  return out;
}

/** Text names any of the five business metrics (a sample, HELP or TYPE line). */
export function businessNamesIn(text: string): string[] {
  return METRIC_NAMES.filter((name) => new RegExp(`(^|[\\s{])${name}([\\s{]|$)`, 'm').test(text));
}

/** Process-level default metrics are present (process_* and nodejs_* families). */
export function expectProcessMetrics(text: string): void {
  const names = [...families(text).keys()];
  expect(names.some((name) => name.startsWith('process_'))).toBe(true);
  expect(names.some((name) => name.startsWith('nodejs_'))).toBe(true);
}

// ---- database fixtures -------------------------------------------------------------------------

export interface TestDatabaseUrls {
  urlFor(role: 'couli_app'): string;
}

/** The same role's URL, but every transaction of the session is READ ONLY (server side). */
export function readOnlyUrl(database: TestDatabaseUrls): string {
  const url = new URL(database.urlFor('couli_app'));
  url.searchParams.set('options', '-c default_transaction_read_only=on');
  return url.toString();
}

/** Prepares queues independently of the migrations and catalog under test (idempotent). */
export async function prepareQueues(db: Kysely<DB>, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await sql`SELECT pgboss.create_queue(${name}, ${JSON.stringify({
      policy: 'standard',
      retryLimit: 0,
      retentionSeconds: 2_592_000,
      deleteAfterSeconds: 2_592_000,
    })}::jsonb)`.execute(db);
  }
}

export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';

export async function insertJob(
  db: Kysely<DB>,
  queue: string,
  state: JobState,
  startAfter: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await sql`
    INSERT INTO pgboss.job (name, data, state, start_after)
    VALUES (${queue}, ${JSON.stringify(data)}::jsonb, ${state}::pgboss.job_state,
      ${startAfter}::timestamptz)
  `.execute(db);
}

/** One sync stream of a new union account of `platform` whose watermark is `cursorAt`. */
export async function insertCursor(
  db: Kysely<DB>,
  platform: string,
  cursorAt: string,
  appId = 'couli',
): Promise<void> {
  const accountId = randomUUID();
  await sql`
    INSERT INTO app.union_accounts (id, app_id, platform, account_name, status, auth_status)
    VALUES (${accountId}, ${appId}, ${platform}, ${`synthetic-${accountId}`}, 'active', 'active')
  `.execute(db);
  await sql`
    INSERT INTO app.sync_cursors
      (app_id, platform, union_account_id, query_kind, scene, cursor_at, updated_at)
    VALUES (${appId}, ${platform}, ${accountId}, 'updated_at', '-', ${cursorAt}::timestamptz,
      ${cursorAt}::timestamptz)
  `.execute(db);
}

export async function jobSnapshot(db: Kysely<DB>): Promise<unknown[]> {
  return (await sql`SELECT to_jsonb(j) AS row FROM pgboss.job j ORDER BY name, id`.execute(db))
    .rows;
}

export async function cursorSnapshot(db: Kysely<DB>): Promise<unknown[]> {
  return (await sql`SELECT to_jsonb(c) AS row FROM app.sync_cursors c ORDER BY id`.execute(db))
    .rows;
}

/**
 * The fixture of the collection tests. Comments give each job's contribution; offsets are seconds
 * from NOW. Returns the nonzero values expected at NOW; every other listed queue expects 0.
 */
export async function seedFixture(db: Kysely<DB>) {
  await prepareQueues(db, [
    ...BUSINESS_QUEUES,
    ...DEAD_QUEUES,
    'extension-job',
    'extension-job.dead',
  ]);
  // notify: backlog 3 (−10, −1 and exactly NOW are due), failed 2.
  await insertJob(db, 'notify', 'created', at(-10));
  await insertJob(db, 'notify', 'created', at(-1));
  await insertJob(db, 'notify', 'created', at(0));
  await insertJob(db, 'notify', 'created', at(60)); // not yet due
  await insertJob(db, 'notify', 'retry', at(-30)); // waiting for a retry: not backlog
  await insertJob(db, 'notify', 'active', at(-40));
  await insertJob(db, 'notify', 'failed', at(-50));
  await insertJob(db, 'notify', 'failed', at(-60));
  await insertJob(db, 'notify', 'completed', at(-70));
  await insertJob(db, 'notify', 'cancelled', at(-80));
  // poster: failed 1; its created job is due one second after NOW.
  await insertJob(db, 'poster', 'failed', at(-5));
  await insertJob(db, 'poster', 'created', at(1));
  // export: backlog 1.
  await insertJob(db, 'export', 'created', at(-3600));
  // evt.payout-went-negative: backlog 2, oldest due created 125 s, failed 1.
  await insertJob(db, 'evt.payout-went-negative', 'created', at(-125));
  await insertJob(db, 'evt.payout-went-negative', 'created', at(-30));
  await insertJob(db, 'evt.payout-went-negative', 'created', at(600));
  await insertJob(db, 'evt.payout-went-negative', 'retry', at(-9999));
  await insertJob(db, 'evt.payout-went-negative', 'active', at(-5000));
  await insertJob(db, 'evt.payout-went-negative', 'failed', at(-7000));
  // evt.notification-claim-result: backlog 1, age 0 (due exactly at NOW).
  await insertJob(db, 'evt.notification-claim-result', 'created', at(0));
  // evt.notification-risk-state: nothing due yet (5 s after NOW).
  await insertJob(db, 'evt.notification-risk-state', 'created', at(5));
  // Dead letter queues: only created / retry wait there; failed counts as failed of that queue.
  await insertJob(db, 'notify.dead', 'created', at(-100_000));
  await insertJob(db, 'notify.dead', 'retry', at(-5));
  await insertJob(db, 'notify.dead', 'failed', at(-6));
  await insertJob(db, 'notify.dead', 'completed', at(-7));
  await insertJob(db, 'notify.dead', 'cancelled', at(-8));
  // An evt dead letter queue is neither an event queue nor backlog, however old its job.
  await insertJob(db, 'evt.payout-went-negative.dead', 'created', at(-100_000));
  await insertJob(db, 'order-sync.dead', 'created', at(-10), { platform: 'pdd' });
  // Queues found in SQL rather than from a hard-coded list (B1-01zzg's .dead reading).
  await insertJob(db, 'extension-job', 'failed', at(-1));
  await insertJob(db, 'extension-job.dead', 'created', at(-1));
  // Watermarks: taobao's oldest stream lags 4000 s, pdd's 30 s; jd has no cursor.
  await insertCursor(db, 'taobao', at(-100));
  await insertCursor(db, 'taobao', at(-4000));
  await insertCursor(db, 'pdd', at(-30));
  return {
    queueFailed: {
      notify: 2,
      poster: 1,
      'evt.payout-went-negative': 1,
      'notify.dead': 1,
      'extension-job': 1,
    },
    deadLetters: {
      'notify.dead': 2,
      'evt.payout-went-negative.dead': 1,
      'order-sync.dead': 1,
      'extension-job.dead': 1,
    },
    backlog: {
      notify: 3,
      export: 1,
      'evt.payout-went-negative': 2,
      'evt.notification-claim-result': 1,
    },
    oldestDueEvtAgeSeconds: { 'evt.payout-went-negative': 125 },
    syncWatermarkLagSeconds: { taobao: 4000, pdd: 30 },
  } satisfies WorkerMetricsSnapshot;
}

/** The label values each gauge must always list (0 when nothing matches). */
export const ALWAYS_LISTED: Readonly<Record<keyof WorkerMetricsSnapshot, readonly string[]>> = {
  queueFailed: [...BUSINESS_QUEUES, ...DEAD_QUEUES],
  deadLetters: DEAD_QUEUES,
  backlog: BUSINESS_QUEUES,
  oldestDueEvtAgeSeconds: EVT_QUEUES,
  syncWatermarkLagSeconds: [],
};

/**
 * One gauge's values against the fixture: every always-listed label value is present with its
 * expected value (0 unless named), the named nonzero values match, and nothing else is nonzero.
 */
export function expectSeries(
  actual: Readonly<Record<string, number>> | undefined,
  key: keyof WorkerMetricsSnapshot,
  nonzero: Readonly<Record<string, number>>,
): void {
  expect(actual, `${key} missing`).toEqual(expect.any(Object));
  for (const name of ALWAYS_LISTED[key]) {
    expect(actual![name], `${key}[${name}]`).toBe(nonzero[name] ?? 0);
  }
  for (const [name, value] of Object.entries(nonzero)) {
    expect(actual![name], `${key}[${name}]`).toBe(value);
  }
  const unexpected = Object.entries(actual!).filter(
    ([name, value]) => value !== 0 && !Object.hasOwn(nonzero, name),
  );
  expect(unexpected, `${key} has unexpected nonzero series`).toEqual([]);
}

/** A Kysely that compiles and logs every query but never connects (rows are always empty). */
export function compileOnlyDb(queries: string[]): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      queries.push(event.query.sql);
    },
  });
}
