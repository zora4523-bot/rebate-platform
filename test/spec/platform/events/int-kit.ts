// Helpers of the platform/events rule tests that run against a real PostgreSQL (*.int.test.ts only).
// The test files create their databases themselves (`createTestDatabase()` of @couli/db/testing,
// ADR-0001 §4.2 #9) and hand them in; this file never imports the test-database base. Every
// connection is the business role couli_app, never a superuser.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import {
  createEventBus,
  type EventBus,
} from '../../../../apps/api/src/modules/platform/events/index.ts';
import type { JobHandler } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { setupOn, type Database, type Setup } from '../queue/int-kit.ts';
import { EVT_CATALOG, EVT_PLAN, SUBS } from './kit.ts';

/** The clock instant of the tests: far from the wall clock, so SQL now() cannot pass for it. */
export const INSTANT = '2031-02-03T04:05:06.789Z';

/** A FixedClock whose reads are counted. */
export function clockAt(instant: string): {
  clock: { now: () => Date };
  fixed: FixedClock;
  reads: () => number;
} {
  const fixed = new FixedClock(instant);
  let reads = 0;
  return {
    fixed,
    reads: () => reads,
    clock: {
      now: () => {
        reads += 1;
        return fixed.now();
      },
    },
  };
}

/** A runtime of `entry` with the events test catalog and plan, plus a bus over it. */
export function busOn(
  database: Database,
  entry: 'api' | 'worker',
  clock: { now: () => Date },
  handlers: Record<string, JobHandler> = {},
): { setup: Setup; bus: EventBus } {
  const setup = setupOn(database, entry, { catalog: EVT_CATALOG, plan: EVT_PLAN, handlers });
  const bus = createEventBus({
    queue: setup.runtime,
    clock,
    subscriptions: SUBS,
    catalog: EVT_CATALOG,
  });
  return { setup, bus };
}

export interface LogRow {
  readonly appId: string;
  readonly eventId: string;
  readonly name: string;
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly createdAt: boolean;
}

/** Every app.event_log row (any partition), ordered by id. */
export async function eventLog(observer: Kysely<DB>): Promise<LogRow[]> {
  const result = await sql<{
    app_id: string;
    event_id: string;
    name: string;
    payload: unknown;
    occurred_at: Date;
    has_created_at: boolean;
  }>`
    SELECT app_id, event_id::text AS event_id, name, payload, occurred_at,
           created_at IS NOT NULL AS has_created_at
    FROM app.event_log ORDER BY id
  `.execute(observer);
  return result.rows.map((row) => ({
    appId: row.app_id,
    eventId: row.event_id,
    name: row.name,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.has_created_at,
  }));
}

/** Every job of the evt.* queues: [queue, id, state], ordered by queue and id. */
export async function evtJobs(observer: Kysely<DB>): Promise<Array<[string, string, string]>> {
  const result = await sql<{ name: string; id: string; state: string }>`
    SELECT name, id::text AS id, state::text AS state FROM pgboss.job
    WHERE name LIKE 'evt.%' ORDER BY name COLLATE "C", id
  `.execute(observer);
  return result.rows.map((row) => [row.name, row.id, row.state]);
}

/** Every app.processed_events row: [consumer, event_id], ordered. */
export async function processed(observer: Kysely<DB>): Promise<Array<[string, string]>> {
  const result = await sql<{ consumer: string; event_id: string }>`
    SELECT consumer, event_id::text AS event_id FROM app.processed_events
    ORDER BY consumer COLLATE "C", event_id
  `.execute(observer);
  return result.rows.map((row) => [row.consumer, row.event_id]);
}

let effectSeq = 0;

/**
 * A business effect written with `trx`: one app.idempotency_keys row of subject `evt-effect` whose
 * key starts with `tag`. Every call writes a new row, so a repeated effect shows as a second row.
 */
export async function effect(trx: Transaction<DB> | Kysely<DB>, tag: string): Promise<void> {
  effectSeq += 1;
  await trx
    .insertInto('idempotency_keys')
    .values({
      app_id: 'couli',
      subject: 'evt-effect',
      method: 'POST',
      path: '/effect',
      key: `${tag}#${effectSeq}`,
      request_hash: 'h',
      status: 'processing',
      expire_at: '2099-01-01T00:00:00Z',
    })
    .execute();
}

/** Number of effects whose tag is `tag`. */
export async function effects(observer: Kysely<DB>, tag: string): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.idempotency_keys
    WHERE subject = 'evt-effect' AND key LIKE ${`${tag}#%`}
  `.execute(observer);
  return Number(result.rows[0]?.n ?? '-1');
}

/** The expected reduced line (see reduceLine of ../queue/kit.ts) of an info line of the worker. */
export function infoLine(fields: Record<string, unknown>, msg: string): Record<string, unknown> {
  return { level: 30, entry: 'worker', env: 'test', ...fields, msg };
}
