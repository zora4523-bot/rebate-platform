// Helpers of the B1-03w rule tests against a real PostgreSQL (*.int.test.ts only). The test files
// create their databases themselves (`createTestDatabase()` of @couli/db/testing, ADR-0001 §4.2
// #9) and hand them in; this file never imports the test-database base. Connections are the
// business role couli_app, as the worker entry's.
//
// The chain runs on the production queue runtime (createQueueRuntime of platform/queue with the
// production QUEUE_CATALOG and ENTRY_PLAN, entry worker), the production risk state service and
// the production event bus (no subscriptions, so the only queue traffic is the chain's own).
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import {
  createQueueRuntime,
  type QueueRuntime,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  fixedClock,
  memoryLogger,
  scanModule,
  type Clock,
  type RiskState,
  type Scan,
} from './kit.ts';

/** The part of `TestDatabase` (@couli/db/testing) these helpers use. */
export interface Database {
  urlFor(role: 'couli_app'): string;
}

export interface JobRow {
  /** The job name inside the queue (what send() was given as `name`). */
  readonly job: string;
  readonly singletonKey: string | null;
  readonly state: string;
  /** start_after still in the future (a delayed send not yet due). */
  readonly deferred: boolean;
  readonly payload: unknown;
}

/** Every job of the risk-scan queue, by job name then key (byte order). */
export async function riskScanJobs(observer: Kysely<DB>): Promise<JobRow[]> {
  const result = await sql<{
    job: string;
    singleton_key: string | null;
    state: string;
    deferred: boolean;
    payload: unknown;
  }>`
    SELECT data->>'name' AS job, singleton_key, state::text AS state,
           start_after > now() AS deferred, data->'payload' AS payload
    FROM pgboss.job WHERE name = 'risk-scan'
    ORDER BY data->>'name' COLLATE "C", singleton_key COLLATE "C"
  `.execute(observer);
  return result.rows.map((row) => ({
    job: row.job,
    singletonKey: row.singleton_key,
    state: row.state,
    deferred: row.deferred,
    payload: row.payload,
  }));
}

/** Polls `check` every 250 ms until it holds or `attempts` polls have failed; never rejects. */
export async function until(check: () => Promise<boolean>, attempts = 160): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check().catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

interface EventsModule {
  createEventBus(options: object): unknown;
}
interface RiskStateModule {
  createRiskStateService(options: object): RiskState;
}

export interface Chain {
  readonly base: Kysely<DB>;
  /** `base` with schema app, as the fixtures of the risk rule tests use it. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly lines: string[];
  readonly logger: ReturnType<typeof memoryLogger>['logger'];
  readonly runtime: QueueRuntime;
  readonly scan: Scan;
  jobs(): Promise<JobRow[]>;
  user(input: {
    state?: 'frozen' | 'normal';
    frozen_until: Date | null;
    changed_at?: Date;
  }): Promise<{ app_id: string; user_id: string }>;
  stateOf(subject: { app_id: string; user_id: string }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * The worker's chain on `database`, its runtime started. `at`: the FixedClock's instant, or null
 * for the database's now() floored to the minute (event_log partitions follow the database's
 * date; the floor makes the next freeze_expiry slot a full minute away, so a continuation stays
 * queued while the test looks at it). `consume`: register the scan as the risk-scan handler, as
 * risk-scan.module.ts does (`queue.register(RISK_SCAN_QUEUE, (job) => scan.handle(job))`).
 */
export async function chainOn(
  database: Database,
  options: { at: string | null; consume: boolean },
): Promise<Chain> {
  const base = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  const db = base.withSchema('app');
  let runtime: QueueRuntime | undefined;
  try {
    const now = (await sql<{ now: Date }>`SELECT now() AS now`.execute(base)).rows[0]!.now;
    const clock = await fixedClock(
      options.at ?? new Date(Math.floor(now.getTime() / 60_000) * 60_000),
    );
    const { logger, lines } = memoryLogger();
    const started = createQueueRuntime({ entry: 'worker', db: base, logger });
    runtime = started;
    const { createEventBus } = (await import(
      new URL('../../../../apps/api/src/modules/platform/events/events.ts', import.meta.url).href
    )) as EventsModule;
    const { createRiskStateService } = (await import(
      new URL('../../../../apps/api/src/modules/risk/application/risk-state.ts', import.meta.url)
        .href
    )) as RiskStateModule;
    const events = createEventBus({ clock, queue: started, subscriptions: [] });
    const riskState = createRiskStateService({ db, clock, events });
    const { createRiskScan } = await scanModule();
    const scan = createRiskScan({ db, clock, riskState, queue: started, logger });
    if (options.consume) started.register('risk-scan', (job) => scan.handle(job));
    await started.start();
    return {
      base,
      db,
      clock,
      lines,
      logger,
      runtime: started,
      scan,
      jobs: () => riskScanJobs(base),
      async user(input) {
        const app_id = `scanq_${randomBytes(8).toString('hex')}`;
        const user_id = randomUUID();
        await db
          .insertInto('users')
          .values({
            id: user_id,
            app_id,
            nickname: 'fixture',
            avatar: 'fixture',
            invite_code: randomBytes(8).toString('hex'),
            attr_code: randomBytes(8).toString('hex'),
            level: 'L1',
            register_method: 'sms',
            status: 'normal',
          })
          .execute();
        const state = input.state ?? 'frozen';
        await db
          .insertInto('user_risk_state')
          .values({
            app_id,
            user_id,
            state,
            reason: state === 'normal' ? null : 'plain-plain-plain-plain',
            reason_category: state === 'normal' ? null : 'other',
            frozen_until: input.frozen_until,
            changed_by: 'fixture',
            changed_at: input.changed_at ?? clock.now(),
            row_version: 7,
          })
          .execute();
        return { app_id, user_id };
      },
      async stateOf(subject) {
        return (await db
          .selectFrom('user_risk_state')
          .selectAll()
          .where('app_id', '=', subject.app_id)
          .where('user_id', '=', subject.user_id)
          .executeTakeFirstOrThrow()) as unknown as Record<string, unknown>;
      },
      async close() {
        await started.stop();
        await destroyDb(base).catch(() => undefined);
      },
    };
  } catch (error) {
    await runtime?.stop();
    await destroyDb(base).catch(() => undefined);
    throw error;
  }
}
