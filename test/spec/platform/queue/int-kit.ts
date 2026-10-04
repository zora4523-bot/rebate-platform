// Helpers of the platform/queue rule tests that run against a real PostgreSQL (*.int.test.ts only).
// The test files create their databases themselves (`createTestDatabase()` of @couli/db/testing,
// ADR-0001 §4.2 #9) and hand them in; this file never imports the test-database base. Every
// connection is a business role (couli_app, couli_payout), never a superuser.
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import {
  createDbHandles,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  createQueueRuntime,
  type EntryPlan,
  type JobHandler,
  type QueueRuntime,
  type QueueSpec,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { TEST_CATALOG, TEST_PLAN, memoryLogger, type Entry } from './kit.ts';

/** The part of `TestDatabase` (@couli/db/testing) these helpers use. */
export interface Database {
  urlFor(role: 'couli_app' | 'couli_payout'): string;
}

/** The db handles of `entry` on the test database (payout connects as couli_payout). */
export function handlesOn(database: Database, entry: Entry): DbHandles {
  const role = entry === 'payout' ? 'couli_payout' : 'couli_app';
  const env: Record<string, string> = { DATABASE_URL: database.urlFor(role) };
  if (entry !== 'payout') env.REDIS_URL = 'redis://127.0.0.1:1/0';
  if (entry === 'admin') env.DATABASE_READ_URL = database.urlFor('couli_app');
  // The db handles log through their own logger, so that the queue's lines can be compared exactly.
  return createDbHandles(loadConnectionConfig(entry, env), { logger: memoryLogger(entry).logger });
}

export interface Setup {
  readonly entry: Entry;
  readonly handles: DbHandles;
  readonly runtime: QueueRuntime;
  readonly lines: string[];
  readonly logger: RootLogger;
}

/**
 * A runtime of `entry` on its own db handles, with the test catalog and plan unless `extra`
 * says otherwise, and a memory logger whose raw lines land in `lines`.
 */
export function setupOn(
  database: Database,
  entry: Entry,
  extra: {
    catalog?: readonly QueueSpec[];
    plan?: EntryPlan;
    stopTimeoutMs?: number;
    handlers?: Record<string, JobHandler>;
  } = {},
): Setup {
  const handles = handlesOn(database, entry);
  const { logger, lines } = memoryLogger(entry);
  const options = {
    entry,
    db: handles.db,
    logger,
    catalog: extra.catalog ?? TEST_CATALOG,
    plan: extra.plan ?? TEST_PLAN,
    ...(extra.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: extra.stopTimeoutMs }),
  };
  let runtime: QueueRuntime;
  try {
    runtime = createQueueRuntime(options);
  } catch (error) {
    void handles.close();
    throw error;
  }
  for (const [queue, handler] of Object.entries(extra.handlers ?? {})) {
    runtime.register(queue, handler);
  }
  return { entry, handles, runtime, lines, logger };
}

/** Stops the runtimes, then closes their handles; never throws. */
export async function teardown(setups: ReadonlyArray<Setup | undefined>): Promise<void> {
  for (const setup of setups) {
    if (setup === undefined) continue;
    await setup.runtime.stop().catch(() => undefined);
    await setup.handles.close().catch(() => undefined);
  }
}

/** A plain Kysely connection of couli_app for direct SQL on the pgboss and app tables. */
export function observerOn(database: Database): Kysely<DB> {
  return createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
}

export async function closeObserver(observer: Kysely<DB>): Promise<void> {
  await destroyDb(observer).catch(() => undefined);
}

export interface JobRow {
  readonly queue: string;
  readonly state: string;
  readonly retryCount: number;
  readonly output: string | null;
  readonly singletonKey: string | null;
}

/** The pgboss.job rows with this id (one per queue that has it), ordered by queue. */
export async function jobRows(observer: Kysely<DB>, id: string): Promise<JobRow[]> {
  const result = await sql<{
    name: string;
    state: string;
    retry_count: number;
    output: string | null;
    singleton_key: string | null;
  }>`
    SELECT name, state::text AS state, retry_count, output::text AS output, singleton_key
    FROM pgboss.job WHERE id = ${id}::uuid ORDER BY name
  `.execute(observer);
  return result.rows.map((row) => ({
    queue: row.name,
    state: row.state,
    retryCount: row.retry_count,
    output: row.output,
    singletonKey: row.singleton_key,
  }));
}

/** The state of the job `id` in `queue`, or 'missing'. */
export async function stateOf(observer: Kysely<DB>, queue: string, id: string): Promise<string> {
  const rows = await jobRows(observer, id);
  return rows.find((row) => row.queue === queue)?.state ?? 'missing';
}

/** Dead-letter copies of the job `id`: queue, state, source queue and output. */
export async function deadCopies(
  observer: Kysely<DB>,
  id: string,
): Promise<
  Array<{ queue: string; state: string; sourceName: string | null; output: string | null }>
> {
  const result = await sql<{
    name: string;
    state: string;
    source_name: string | null;
    output: string | null;
  }>`
    SELECT name, state::text AS state, source_name, output::text AS output
    FROM pgboss.job WHERE source_id = ${id}::uuid ORDER BY name
  `.execute(observer);
  return result.rows.map((row) => ({
    queue: row.name,
    state: row.state,
    sourceName: row.source_name,
    output: row.output,
  }));
}

/** Every job of `queue` with `singletonKey`: [state] in insertion order. */
export async function statesOfKey(
  observer: Kysely<DB>,
  queue: string,
  singletonKey: string,
): Promise<string[]> {
  const result = await sql<{ state: string }>`
    SELECT state::text AS state FROM pgboss.job
    WHERE name = ${queue} AND singleton_key = ${singletonKey}
    ORDER BY created_on, id
  `.execute(observer);
  return result.rows.map((row) => row.state);
}

/** Rows of pgboss.queue for `names`, ordered by name, in the shape of the catalog (section 1). */
export async function queueRows(
  observer: Kysely<DB>,
  names: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const result = await sql<{
    name: string;
    policy: string;
    retry_limit: number;
    retry_delay: number;
    retry_backoff: boolean;
    retry_delay_max: number | null;
    expire_seconds: number;
    retention_seconds: number;
    deletion_seconds: number;
    dead_letter: string | null;
    partition: boolean;
  }>`
    SELECT name, policy, retry_limit, retry_delay, retry_backoff, retry_delay_max, expire_seconds,
           retention_seconds, deletion_seconds, dead_letter, partition
    FROM pgboss.queue WHERE name = ANY(${[...names]}::text[]) ORDER BY name COLLATE "C"
  `.execute(observer);
  return result.rows.map((row) => ({ ...row }));
}

/** The expected pgboss.queue row of a catalog entry (section 1: one pg-boss queue per entry). */
export function expectedQueueRow(spec: QueueSpec): Record<string, unknown> {
  return {
    name: spec.name,
    policy: spec.policy,
    retry_limit: spec.retryLimit,
    retry_delay: spec.retryDelaySeconds,
    retry_backoff: spec.retryBackoff,
    retry_delay_max: spec.retryDelayMaxSeconds,
    expire_seconds: spec.expireInSeconds,
    retention_seconds: spec.retentionSeconds,
    deletion_seconds: spec.deleteAfterSeconds,
    dead_letter: spec.deadLetter,
    partition: false,
  };
}

/** A recorder of handler calls with a peak counter of concurrent calls. */
export function recorder(): {
  calls: Array<{ id: string; queue: string; name: string; attempt: number }>;
  active: () => number;
  peak: () => number;
  track: <T>(
    id: string,
    queue: string,
    name: string,
    attempt: number,
    run: () => Promise<T>,
  ) => Promise<T>;
} {
  const calls: Array<{ id: string; queue: string; name: string; attempt: number }> = [];
  let active = 0;
  let peak = 0;
  return {
    calls,
    active: () => active,
    peak: () => peak,
    async track(id, queue, name, attempt, run) {
      calls.push({ id, queue, name, attempt });
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await run();
      } finally {
        active -= 1;
      }
    },
  };
}
