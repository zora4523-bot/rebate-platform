// Helpers of the B2-04wa rule tests: durable asset snapshot alerts over the platform event bus
// (BR-FUND-18, BR-FUND-20; 规划/02 §11 asset_snapshot.timed_out, union_receivable.exposure_exceeded;
// D10-188 ①). Expected names and payloads are written out by hand from 02 §11, never taken from the
// implementation. Nothing here imports the test-database base: only *.int.test.ts may.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type KyselyPlugin, type QueryId, type TableNode } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createAssetSnapshot,
  createAssetSnapshotAlertQueue,
  LedgerError,
  type AssetSnapshotAlert,
  type AssetSnapshotAlertQueue,
  type PendingEarningsSource,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock, type EventBus } from '../../../../apps/api/src/modules/platform/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import { entry, platform, voucher } from '../../db/ledger/invariants/kit.ts';
import { setupOn, teardown } from '../../platform/queue/int-kit.ts';
import { spec } from '../../platform/queue/kit.ts';

export const TIMEOUT = 120_000;
export const DAY = '2032-06-15';
/** D+1 00:01 +08:00 of DAY. */
export const NOMINAL = '2032-06-15T16:01:00.000Z';
/** D+1 00:30 +08:00 of DAY: at or after it the day is timed out. */
export const DEADLINE = '2032-06-15T16:30:00.000Z';
export const NEXT_DAY = '2032-06-16';
export const NEXT_NOMINAL = '2032-06-16T16:01:00.000Z';
export const NEXT_DEADLINE = '2032-06-16T16:30:00.000Z';

/** The two names of 规划/02 §11 (D10-188), copied by hand. */
export const TIMED_OUT = 'asset_snapshot.timed_out';
export const EXPOSURE = 'union_receivable.exposure_exceeded';

export const CONSUMER = 'asset-alert-test';
export const QUEUE = `evt.${CONSUMER}`;
const CATALOG = [spec(QUEUE, { deadLetter: null })];

/**
 * 02 §11 payload of asset_snapshot.timed_out: { app_id, accounting_date, type, waiting_comparable };
 * type is the alert kind of the idempotency key (app_id, accounting date, type).
 */
export function timedOutPayload(appId: string, day = DAY) {
  return {
    app_id: appId,
    accounting_date: day,
    type: 'asset_snapshot_timeout',
    waiting_comparable: false,
  };
}

/**
 * 02 §11 payload of union_receivable.exposure_exceeded: { app_id, accounting_date, type, sum_fen,
 * threshold_fen }; amounts are JSON integers of fen (ADR-0001 §4.2 第 3 项).
 */
export function exposurePayload(appId: string, sumFen: number, thresholdFen: number, day = DAY) {
  return {
    app_id: appId,
    accounting_date: day,
    type: 'ledger_advance_exposure',
    sum_fen: sumFen,
    threshold_fen: thresholdFen,
  };
}

interface Database {
  urlFor(role: 'couli_app' | 'couli_payout'): string;
  drop(): Promise<void>;
}

export async function open(create: () => Promise<Database>) {
  const database = await create();
  const connectionString = database.urlFor('couli_app');
  const setup = setupOn(database, 'api', {
    catalog: CATALOG,
    plan: { api: [], stream: [], admin: [], worker: [], payout: [] },
  });
  await setup.runtime.start();
  return {
    database,
    setup,
    db: createDb({ connectionString, max: 5 }),
    left: createDb({ connectionString, max: 1 }),
    right: createDb({ connectionString, max: 1 }),
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;

export async function close(h: Harness | undefined) {
  if (!h) return;
  await teardown([h.setup]);
  await Promise.all([h.db, h.left, h.right].map(destroyDb));
  await h.database.drop();
}

export interface ContextOptions {
  readonly appId?: string;
  readonly now?: string;
  readonly threshold?: bigint | null;
}

/**
 * One delivery's world: its own clock, a spied bus routing both alert events to QUEUE, the alert
 * port under test (results recorded in `enqueued`) and the snapshot dependencies.
 */
export function context(h: Harness, options: ContextOptions = {}) {
  const appId = options.appId ?? `alerts-${randomUUID()}`;
  const clock = new FixedClock(options.now ?? NOMINAL);
  const publish = vi.fn<EventBus['publish']>();
  // Built first, inside each test: the skeleton's NotImplemented is the red, before the bus is.
  const port = createAssetSnapshotAlertQueue({ publish });
  const send = vi.fn(h.setup.runtime.send.bind(h.setup.runtime));
  const bus = createEventBus({
    clock,
    queue: { send },
    catalog: CATALOG,
    subscriptions: [{ consumer: CONSUMER, events: [TIMED_OUT, EXPOSURE] }],
  });
  publish.mockImplementation((trx, event) => bus.publish(trx, event));
  const enqueued: Array<{ alert: AssetSnapshotAlert; duplicate: boolean }> = [];
  const alertQueue: AssetSnapshotAlertQueue = {
    async enqueue(trx, alert) {
      const result = await port.enqueue(trx, alert);
      enqueued.push({ alert, duplicate: result.duplicate });
      return result;
    },
  };
  const readAppTotals = vi.fn<PendingEarningsSource['readAppTotals']>().mockResolvedValue({
    total_waiting_fen: 0n,
    total_estimated_fen: 0n,
  });
  const readUser = vi
    .fn<PendingEarningsSource['readUser']>()
    .mockRejectedValue(new Error('the snapshot reads app totals only'));
  const threshold = options.threshold === undefined ? null : options.threshold;
  const getAdvanceAlertFen = vi
    .fn<(appId: string) => Promise<bigint | null>>()
    .mockResolvedValue(threshold);
  const logger = { warn: vi.fn(), error: vi.fn() };
  const dependencies = {
    clock,
    pendingEarnings: { readAppTotals, readUser },
    getAdvanceAlertFen,
    logger,
  };
  const runner = () => createAssetSnapshot({ ...dependencies, alertQueue });
  return {
    appId,
    clock,
    bus,
    publish,
    send,
    port,
    enqueued,
    readAppTotals,
    getAdvanceAlertFen,
    logger,
    dependencies,
    runner,
  };
}
export type Context = ReturnType<typeof context>;

export function input(appId: string, nominal = NOMINAL) {
  return { appId, nominalRunAt: new FixedClock(nominal).now() };
}

/** One UNION_RECEIVABLE:{name} account of the app with one entry of `amount` dated DAY. */
export async function receivable(db: Kysely<DB>, appId: string, name: string, amount: bigint) {
  const account = await platform(db, `UNION_RECEIVABLE:${name}`, appId);
  await entry(db, account, await voucher(db, { app_id: appId }), amount);
}

export async function snapshots(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('asset_snapshots')
    .select(['id', 'waiting_comparable'])
    .select((eb) => eb.cast<string>('snapshot_date', 'text').as('day'))
    .where('app_id', '=', appId)
    .orderBy('snapshot_date')
    .execute();
}

/** event_log rows of the two alert events of the app, by day then name. */
export async function events(db: Kysely<DB>, appId: string) {
  const rows = await db
    .withSchema('app')
    .selectFrom('event_log')
    .select(['event_id', 'name', 'payload', 'occurred_at'])
    .where('app_id', '=', appId)
    .where('name', 'in', [TIMED_OUT, EXPOSURE])
    .execute();
  return rows
    .map((row) => ({
      eventId: row.event_id,
      name: row.name,
      payload: row.payload as unknown as { v: unknown; data: Record<string, unknown> },
      occurredAt: row.occurred_at,
    }))
    .sort((a, b) =>
      `${String(a.payload.data['accounting_date'])} ${a.name}`.localeCompare(
        `${String(b.payload.data['accounting_date'])} ${b.name}`,
      ),
    );
}

/** Jobs of the test consumer queue for the app (job id = event id). */
export async function jobs(db: Kysely<DB>, appId: string) {
  const result = await sql<{ id: string; data: unknown; state: string }>`
    SELECT id::text, data, state::text FROM pgboss.job
    WHERE name = ${QUEUE} AND data->'payload'->>'app_id' = ${appId}
    ORDER BY id`.execute(db);
  return result.rows;
}

/** The name and payload data of each event_log row, for exact comparison. */
export function contents(rows: Awaited<ReturnType<typeof events>>) {
  return rows.map((row) => ({ name: row.name, payload: row.payload }));
}

/** How a synchronous call refused: name and code of a LedgerError, else a description. */
export function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (error instanceof LedgerError) return { name: error.name, code: error.code };
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return `thrown ${String(error)}`;
  }
  return 'returned';
}

/** A write that fails at the child-table statement, before any alert is enqueued. */
export function failReceivableWrite(error: Error): KyselyPlugin {
  return {
    transformQuery({ node }) {
      if (
        node.kind === 'InsertQueryNode' &&
        node.into?.table.identifier.name === 'asset_snapshot_receivables'
      ) {
        throw error;
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
}

/**
 * Holds the first UPDATE of app.asset_snapshots on this handle (the confirming false → true of a
 * delivery) open after it ran: `held` resolves once the row is changed and still locked, the
 * statement returns when `release` resolves, then fails with `failure` when one is given (its
 * transaction then rolls back).
 */
export function holdSnapshotUpdate(gate: {
  readonly held: PromiseWithResolvers<void>;
  readonly release: Promise<void>;
  readonly failure?: Error;
}): KyselyPlugin {
  const marked = new WeakSet<QueryId>();
  let used = false;
  return {
    transformQuery({ node, queryId }) {
      if (
        !used &&
        node.kind === 'UpdateQueryNode' &&
        node.table?.kind === 'TableNode' &&
        (node.table as TableNode).table.identifier.name === 'asset_snapshots'
      ) {
        used = true;
        marked.add(queryId);
      }
      return node;
    },
    async transformResult({ queryId, result }) {
      if (marked.has(queryId)) {
        gate.held.resolve();
        await gate.release;
        if (gate.failure !== undefined) throw gate.failure;
      }
      return result;
    },
  };
}

/**
 * Waits until some backend of this database waits on a lock held by another one; fails as soon as
 * `settled()` reports that the waiting side already finished without such a wait.
 */
export async function waitAnyBlocked(db: Kysely<DB>, settled: () => boolean): Promise<void> {
  // Observe a real server-side wait, never infer it from a sleep.
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const result = await sql<{ blocked: number }>`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0
        AND query NOT ILIKE '%pgboss%'`.execute(db);
    if ((result.rows[0]?.blocked ?? 0) > 0) return;
    if (settled()) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect.fail('the duplicate delivery never waited for the confirming one');
}

/** Tracks whether a promise has settled, without leaving a rejection unhandled. */
export function tracked(promise: Promise<unknown>): () => boolean {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return () => done;
}

/** Log lines of the runner for one alert kind. */
export function logged(
  logger: Context['logger'],
  event: 'asset_snapshot_timeout' | 'ledger_advance_exposure',
): Record<string, unknown>[] {
  return [...logger.warn.mock.calls, ...logger.error.mock.calls]
    .map((call) => call[0] as Record<string, unknown>)
    .filter((fields) => fields['event'] === event);
}
