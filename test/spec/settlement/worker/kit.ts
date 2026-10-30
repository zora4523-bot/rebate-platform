// B2-04ze rule-test kit (claude-independent, SPEC_REF 8127341): the worker assembly and schedule of
// the monthly settlement (D10-443; 08 BR-FUND-04 ③ ⑥ ⑦ ⑨, BR-FUND-20; 02 §11 queue `settle`).
// Conventions fixed by these tests (task brief §1 / §9):
// - queue `settle` (exclusive, worker only), one handler dispatching on the job name;
// - job `bill`: payload { app_id, platform, accounting_date: D }, singletonKey
//   `bill:<app_id>:<platform>:<D>`, sent at once; the bill job runs with run_at = D 00:00 +08:00;
//   seeded every day for every app (distinct app_id of app.orders) × platform; a non-bill day is
//   the bill job's own not_due; deferred fails the delivery (not completed);
// - job `batch_execute`: payload { app_id, batch_id }, singletonKey
//   `batch_execute:<app_id>:<batch_id>`, sent at once by the scan for CONFIRMED due batches without
//   paused_by_switch_at, and for EXECUTING batches (SB9 take-over);
// - seed / scan decisions come from the queue and the database (SettleRunStore), never memory;
// - SettlementModule.forWorker(ports) uses only the platform tokens CLOCK, ROOT_LOGGER,
//   APP_CONFIG, DB, JOB_QUEUE, FIELD_CRYPTO and EVENT_BUS; app.module passes the owners' exports.
// Real pieces: PostgreSQL through @couli/db/testing as couli_app (the int tests hand in
// createTestDatabase), pg-boss on the test database where a test says so, the settlement bill job,
// executor and bill source behind the handler. Synthetic: the job queue recorder, the other
// modules' ports in the module tests, and every row (no real user data, low-entropy strings).
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import {
  APP_CONFIG,
  CLOCK,
  DB as DB_TOKEN,
  EVENT_BUS,
  FIELD_CRYPTO,
  FixedClock,
  JOB_QUEUE,
  ROOT_LOGGER,
  createRootLogger,
  loadConfig,
  type EventBus,
  type FieldCrypto,
  type JobHandler,
  type JobPayload,
  type JobQueue,
  type ReceivedJob,
  type RootLogger,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createQueueRuntime } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import type { BillReconDiffInput } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import type {
  SettleScheduleLogger,
  SettlementWorkerPorts,
} from '../../../../apps/api/src/modules/settlement/worker/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const TIMEOUT = 120_000;

export const QUEUE = 'settle';
export const DEAD_QUEUE = 'settle.dead';
export const BILL = 'bill';
export const EXECUTE = 'batch_execute';

export const APP = 'sw-app-a';
export const OTHER = 'sw-app-b';
export const THIRD = 'sw-app-c';
export const TAOBAO = 'taobao';
export const JD = 'jd';
export const PDD = 'pdd';

/** The default settle.bill_day (24) of July 2032; the bill month is 2032-06. */
export const BILL_DAY = '2032-07-24';
export const BILL_MONTH = '2032-06';
/** BILL_DAY 00:00 +08:00: the bill job's nominal run_at. */
export const BILL_DAY_START = '2032-07-23T16:00:00.000Z';
/** BILL_DAY 00:40 +08:00 (after the nominal snapshot window). */
export const BILL_DAY_NOW = '2032-07-23T16:40:00.000Z';
/** A day that is not the bill day. */
export const PLAIN_DAY = '2032-07-10';
/** PLAIN_DAY 10:00 +08:00. */
export const PLAIN_DAY_NOW = '2032-07-10T02:00:00.000Z';
/** When the test batches were confirmed (before every scan instant below). */
export const CONFIRMED_AT = '2032-07-24T09:00:00+08:00';
/** The scan instant of the batch tests: 2032-07-24 10:00 +08:00. */
export const SCAN_NOW = '2032-07-24T02:00:00.000Z';

export function billKey(appId: string, platform: string, day: string): string {
  return `bill:${appId}:${platform}:${day}`;
}

export function executeKey(appId: string, batchId: string): string {
  return `batch_execute:${appId}:${batchId}`;
}

// ---------------------------------------------------------------------------------------------
// Logging.

export interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string | undefined;
}

export function memoryLogger(): { logger: SettleScheduleLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger: SettleScheduleLogger = {
    info(fields, message) {
      lines.push({ level: 'info', fields, message });
    },
    warn(fields, message) {
      lines.push({ level: 'warn', fields, message });
    },
    error(fields, message) {
      lines.push({ level: 'error', fields, message });
    },
  };
  return { logger, lines };
}

export function silentRootLogger(): RootLogger {
  return createRootLogger({ level: 'silent', entry: 'worker', appEnv: 'test' }, { write() {} });
}

// ---------------------------------------------------------------------------------------------
// The job queue.

export function isTransaction(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTransaction?: unknown }).isTransaction === true
  );
}

export interface SentJob {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly options: SendOptions;
  readonly inTransaction: boolean;
}

export interface FakeQueue extends JobQueue {
  readonly sent: SentJob[];
  /** Apps whose sends reject (nothing recorded for them). */
  readonly failing: Set<string>;
  readonly registered: { readonly queue: string; readonly handler: JobHandler }[];
  register(queue: string, handler: JobHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function fakeQueue(): FakeQueue {
  const sent: SentJob[] = [];
  const failing = new Set<string>();
  const registered: { queue: string; handler: JobHandler }[] = [];
  return {
    sent,
    failing,
    registered,
    async send(queue, name, payload, options) {
      const appId = payload['app_id'];
      if (typeof appId === 'string' && failing.has(appId)) {
        throw new Error('synthetic send failure');
      }
      sent.push({ queue, name, payload, options, inTransaction: isTransaction(options.trx) });
      return randomUUID();
    },
    register(queue, handler) {
      registered.push({ queue, handler });
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

/** A send without its transaction handle; a missing delay counts as 0 (at once). */
export function sendView(job: SentJob) {
  return {
    queue: job.queue,
    name: job.name,
    payload: job.payload,
    singletonKey: job.options.singletonKey,
    delaySeconds: job.options.delaySeconds ?? 0,
  };
}

export function billSend(appId: string, platform: string, day: string) {
  return {
    queue: QUEUE,
    name: BILL,
    payload: { app_id: appId, platform, accounting_date: day },
    singletonKey: billKey(appId, platform, day),
    delaySeconds: 0,
  };
}

export function executeSend(appId: string, batchId: string) {
  return {
    queue: QUEUE,
    name: EXECUTE,
    payload: { app_id: appId, batch_id: batchId },
    singletonKey: executeKey(appId, batchId),
    delaySeconds: 0,
  };
}

/** Sorts send views by singletonKey (the seed's and scan's order is not part of the rule). */
export function byKey<T extends { singletonKey: string | undefined }>(views: readonly T[]): T[] {
  return [...views].sort((a, b) => ((a.singletonKey ?? '') < (b.singletonKey ?? '') ? -1 : 1));
}

export function receivedJob(name: string, payload: JobPayload, attempt = 1): ReceivedJob {
  return { id: randomUUID(), queue: QUEUE, name, payload, attempt };
}

// ---------------------------------------------------------------------------------------------
// Errors.

export function errorChain(error: unknown): unknown[] {
  const seen: unknown[] = [];
  const pending: unknown[] = [error];
  while (pending.length > 0 && seen.length < 32) {
    const item = pending.shift();
    if (item === undefined || item === null || seen.includes(item)) continue;
    seen.push(item);
    if (item instanceof AggregateError) pending.push(...item.errors);
    if (typeof item === 'object' && 'cause' in item)
      pending.push((item as { cause: unknown }).cause);
  }
  return seen;
}

export function messages(error: unknown): string {
  return errorChain(error)
    .map((item) => (item instanceof Error ? item.message : String(item)))
    .join(' | ');
}

/** Resolves to the rejection of `run` (fails the test when it resolves). */
export async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  const outcome = await Promise.resolve()
    .then(run)
    .then(
      () => ({ rejected: false as const }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
  expect(outcome.rejected, 'expected a rejection').toBe(true);
  return outcome.rejected ? outcome.error : undefined;
}

/** A rejection that is an answer of the implementation (a skeleton's NotImplemented is not). */
export async function refusal(run: () => Promise<unknown>): Promise<string> {
  const error = await rejection(run);
  const text = messages(error);
  expect(text).not.toMatch(/NotImplemented/u);
  return text;
}

// ---------------------------------------------------------------------------------------------
// The database.

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/** A fresh database; `db` (6 connections) and `observer` (2) as couli_app. */
export async function withDatabase(
  create: () => Promise<TestDatabase>,
  run: (db: Kysely<DB>, observer: Kysely<DB>) => Promise<void>,
): Promise<void> {
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
  const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  try {
    await run(db, observer);
  } finally {
    await Promise.all([destroyDb(db), destroyDb(observer)]);
    await database.drop();
  }
}

const EARLY = '2032-05-20T10:00:00+08:00';

export interface SeededOrder {
  readonly appId: string;
  readonly orderId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly key: string;
}

export interface OrderPatch {
  readonly rebateStatus?: 'ESTIMATED' | 'WAITING' | 'CREDITED' | 'VOID' | 'CLAWED_BACK';
  readonly settlePeriod?: string | null;
}

/** order_keys only (the owner of settlement rows), for a given order id. */
export async function seedKey(
  db: Kysely<DB>,
  appId: string,
  platform: string,
  orderId: string = randomUUID(),
): Promise<SeededOrder> {
  const subOrderId = `synthetic-${orderId}`;
  await db
    .withSchema('app')
    .insertInto('order_keys')
    .values({
      app_id: appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: new Date(EARLY),
    })
    .execute();
  return { appId, orderId, platform, subOrderId, key: `${platform}:${subOrderId}` };
}

/** The orders row of a seeded key. */
export async function insertOrderRow(
  db: Kysely<DB>,
  o: SeededOrder,
  patch: OrderPatch = {},
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('orders')
    .values({
      app_id: o.appId,
      order_id: o.orderId,
      platform: o.platform,
      sub_order_id: o.subOrderId,
      raw_item_id: 'synthetic-item',
      platform_status: 'RECEIVED',
      rebate_status: patch.rebateStatus ?? 'WAITING',
      hold: false,
      hold_reason: null,
      rights_pending: false,
      commission_version: 1,
      attr_at: new Date(EARLY),
      settle_period: patch.settlePeriod === undefined ? BILL_MONTH : patch.settlePeriod,
      created_at: new Date(EARLY),
      updated_at: new Date(EARLY),
    })
    .execute();
}

/** order_keys + orders (WAITING, settle_period 2032-06 unless patched). */
export async function seedOrder(
  db: Kysely<DB>,
  appId: string,
  platform: string = TAOBAO,
  patch: OrderPatch = {},
): Promise<SeededOrder> {
  const o = await seedKey(db, appId, platform);
  await insertOrderRow(db, o, patch);
  return o;
}

export async function seedSettlement(
  db: Kysely<DB>,
  o: SeededOrder,
  patch: { readonly seq?: number; readonly fen?: bigint; readonly createdAt?: string } = {},
): Promise<void> {
  const seq = patch.seq ?? 1;
  await db
    .withSchema('app')
    .insertInto('order_settlements')
    .values({
      app_id: o.appId,
      order_id: o.orderId,
      seq,
      source: 'API',
      settle_commission_fen: patch.fen ?? 1000n,
      settled_at: new Date('2032-07-20T10:00:00+08:00'),
      created_at: new Date(patch.createdAt ?? '2032-07-20T10:00:00+08:00'),
      content_hash: `synthetic-hash-${String(seq)}`,
    })
    .execute();
}

/** A settle_jobs row of (app, 'bill', platform, run_at). */
export async function seedSettleJob(
  db: Kysely<DB>,
  appId: string,
  platform: string,
  runAt: string,
  status: 'running' | 'done' | 'failed',
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('settle_jobs')
    .values({
      id: randomUUID(),
      app_id: appId,
      job: 'bill',
      platform,
      run_at: new Date(runAt),
      status,
      processed_count: 0,
      skipped_count: 0,
      started_at: new Date(runAt),
      finished_at: status === 'running' ? null : new Date(runAt),
    })
    .execute();
}

export async function settleJobsOf(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('settle_jobs')
    .select(['job', 'platform', 'run_at', 'status'])
    .where('app_id', '=', appId)
    .orderBy('platform')
    .orderBy('run_at')
    .execute();
}

export type BatchStatus = 'DRAFT' | 'CONFIRMED' | 'EXECUTING' | 'PARTIAL' | 'DONE' | 'CANCELLED';

export interface BatchSpec {
  readonly status: BatchStatus;
  readonly settleMode?: 'IMMEDIATE' | 'SCHEDULED';
  readonly scheduledAt?: string | null;
  readonly pausedBySwitchAt?: string | null;
  readonly platform?: string;
}

/** The app's admin and the 2032-06 bill row (once per app and database). */
async function billOwner(db: Kysely<DB>, appId: string): Promise<string> {
  const existing = await db
    .withSchema('app')
    .selectFrom('admin_users')
    .select('id')
    .where('app_id', '=', appId)
    .executeTakeFirst();
  if (existing !== undefined) return existing.id;
  const adminId = randomUUID();
  await db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: appId,
      login_name: `settle-worker-${adminId}`,
      password_hash: 'test-only',
      is_super: true,
      status: 'active',
    })
    .execute();
  await db
    .withSchema('app')
    .insertInto('settle_bills')
    .values({
      app_id: appId,
      bill_id: BILL_MONTH,
      generation_started_at: new Date('2032-07-24T08:00:00+08:00'),
      generated_at: new Date('2032-07-24T08:00:00+08:00'),
      created_at: new Date('2032-07-24T08:00:00+08:00'),
    })
    .execute();
  return adminId;
}

/** A settle batch without items, in the given state. */
export async function seedBatch(db: Kysely<DB>, appId: string, spec: BatchSpec): Promise<string> {
  const adminId = await billOwner(db, appId);
  const batchId = randomUUID();
  const confirmed = spec.status !== 'DRAFT' && spec.status !== 'CANCELLED';
  const mode = spec.settleMode ?? 'IMMEDIATE';
  const scheduledAt = spec.scheduledAt ?? null;
  const pausedAt = spec.pausedBySwitchAt ?? null;
  await db
    .withSchema('app')
    .insertInto('settle_batches')
    .values({
      batch_id: batchId,
      app_id: appId,
      bill_id: BILL_MONTH,
      platform: spec.platform ?? TAOBAO,
      kind: 'main',
      status: spec.status,
      settle_mode: mode,
      scheduled_at: mode === 'SCHEDULED' && scheduledAt !== null ? new Date(scheduledAt) : null,
      confirmed_by: confirmed ? adminId : null,
      confirmed_at: confirmed ? new Date(CONFIRMED_AT) : null,
      cancelled_reason: spec.status === 'CANCELLED' ? '测试驳回' : null,
      settle_run_id: null,
      order_count: 0,
      started_at:
        spec.status === 'EXECUTING' || spec.status === 'PARTIAL' || spec.status === 'DONE'
          ? new Date(CONFIRMED_AT)
          : null,
      finished_at: spec.status === 'DONE' ? new Date(CONFIRMED_AT) : null,
      paused_by_switch_at: pausedAt === null ? null : new Date(pausedAt),
      row_version: 1,
      created_at: new Date('2032-07-24T08:00:00+08:00'),
    })
    .execute();
  return batchId;
}

export async function batchRow(db: Kysely<DB>, batchId: string) {
  return db
    .withSchema('app')
    .selectFrom('settle_batches')
    .select(['status', 'paused_by_switch_at', 'started_at', 'finished_at'])
    .where('batch_id', '=', batchId)
    .executeTakeFirstOrThrow();
}

/** A synthetic member (users row) of the app. */
export async function member(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO app.users
      (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, created_at, updated_at)
    VALUES (${id}, ${appId}, 'synthetic member', '', ${randomUUID()}, ${randomUUID()}, 'member',
      'synthetic', ${new Date(EARLY)}, ${new Date(EARLY)})`.execute(db);
  return id;
}

export async function setConfig(
  db: Kysely<DB>,
  appId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('config_items')
    .values({ app_id: appId, key, value: JSON.stringify(value), updated_by: 'synthetic' })
    .execute();
}

// ---------------------------------------------------------------------------------------------
// pg-boss on the test database.

/**
 * A started api-entry queue runtime on `db` (sends only) behind the FakeQueue shape: every send is
 * recorded and forwarded to pg-boss; register only records.
 */
export async function withRealQueue(
  db: Kysely<DB>,
  run: (queue: FakeQueue) => Promise<void>,
): Promise<void> {
  const runtime = createQueueRuntime({
    entry: 'api',
    db,
    logger: createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' }, { write() {} }),
  });
  await runtime.start();
  const sent: SentJob[] = [];
  const failing = new Set<string>();
  const registered: FakeQueue['registered'][number][] = [];
  const queue: FakeQueue = {
    sent,
    failing,
    registered,
    async send(queueName, name, payload, options) {
      const id = await runtime.send(queueName, name, payload, options);
      sent.push({
        queue: queueName,
        name,
        payload,
        options,
        inTransaction: isTransaction(options.trx),
      });
      return id;
    },
    register(queueName, handler) {
      registered.push({ queue: queueName, handler });
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  try {
    await run(queue);
  } finally {
    await runtime.stop();
  }
}

export interface QueuedJob {
  readonly id: string;
  readonly state: string;
  readonly payload: JobPayload | null;
}

/** The jobs under a singletonKey on queue settle (pgboss.job), oldest first. */
export async function jobsUnder(db: Kysely<DB>, key: string): Promise<QueuedJob[]> {
  const result = await sql<QueuedJob>`
    SELECT id::text AS id, state::text AS state, data -> 'payload' AS payload
    FROM pgboss.job
    WHERE name = ${QUEUE} AND singleton_key = ${key}
    ORDER BY created_on, id`.execute(db);
  return result.rows;
}

export async function liveJobsUnder(db: Kysely<DB>, key: string): Promise<QueuedJob[]> {
  return (await jobsUnder(db, key)).filter((job) =>
    ['created', 'retry', 'active'].includes(job.state),
  );
}

export type WorkerTransition = 'active' | 'retry' | 'completed' | 'cancelled';

/** What a worker does to a job (plain SQL on pgboss.job; no handler involved). */
export async function transition(
  db: Kysely<DB>,
  jobId: string,
  state: WorkerTransition,
): Promise<void> {
  switch (state) {
    case 'active':
      await sql`UPDATE pgboss.job SET state = 'active', started_on = now()
        WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
      return;
    case 'retry':
      await sql`UPDATE pgboss.job SET state = 'retry', retry_count = retry_count + 1,
          started_on = NULL, start_after = now() + interval '10 seconds'
        WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
      return;
    case 'completed':
      await sql`UPDATE pgboss.job SET state = 'completed', completed_on = now(),
          started_on = COALESCE(started_on, now())
        WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
      return;
    case 'cancelled':
      await sql`UPDATE pgboss.job SET state = 'cancelled', completed_on = now()
        WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
      return;
  }
}

/** Attempts exhausted: the job fails and pg-boss's copy (same key) waits in settle.dead. */
export async function failToDead(db: Kysely<DB>, jobId: string): Promise<void> {
  await sql`UPDATE pgboss.job SET state = 'failed', retry_count = retry_limit,
      started_on = COALESCE(started_on, now()), completed_on = now(),
      output = '{"error":"handler_failed"}'::jsonb
    WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
  await sql`INSERT INTO pgboss.job (name, data, state, singleton_key, output)
    SELECT ${DEAD_QUEUE}, data, 'created'::pgboss.job_state, singleton_key, output
    FROM pgboss.job WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
}

// ---------------------------------------------------------------------------------------------
// The other modules' ports (synthetic) for the module tests.

export interface PortState {
  snapshot: 'pending' | 'complete' | 'timed_out';
  /** content's stored values by key (every app); a missing key is unset. */
  readonly config: Map<string, unknown>;
}

export interface PortCalls {
  readonly unionAuthoritative: { appId: string; orderKeys: string[] }[];
  readonly diffs: BillReconDiffInput[];
  readonly attribution: string[];
  readonly published: unknown[];
}

function unexpected(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`synthetic port ${name} was not expected to be called`));
}

export function fakePorts(state: PortState): { ports: SettlementWorkerPorts; calls: PortCalls } {
  const calls: PortCalls = { unionAuthoritative: [], diffs: [], attribution: [], published: [] };
  type DiffRow = Awaited<ReturnType<SettlementWorkerPorts['registerDiff']>>;
  const ports: SettlementWorkerPorts = {
    platforms: [TAOBAO],
    readAttribution: async (_trx, input) => {
      calls.attribution.push(input.orderId);
      throw new Error('synthetic attribution read was not expected');
    },
    readSnapshot: async () => null,
    readTljDeductFen: async () => 0n,
    appendBeneficiaryEvent: unexpected('appendBeneficiaryEvent'),
    readUnionAuthoritative: async (_db, selection) => {
      calls.unionAuthoritative.push({
        appId: selection.appId,
        orderKeys: [...selection.orderKeys],
      });
      return new Set<string>();
    },
    snapshotStatus: async () => ({
      state: state.snapshot,
      snapshotId: null,
      waitingComparable: null,
    }),
    registerDiff: async (_trx, input) => {
      calls.diffs.push(input);
      return { id: randomUUID() } as unknown as DiffRow;
    },
    readOrderNets: unexpected('readOrderNets'),
    ledger: () =>
      ({
        openUserAccount: unexpected('ledger.openUserAccount'),
        lockBalances: unexpected('ledger.lockBalances'),
        post: unexpected('ledger.post'),
      }) as unknown as ReturnType<SettlementWorkerPorts['ledger']>,
    lockUsers: async () => new Set<string>(),
    deletionStatus: () => ({ read: async () => new Map() }),
    realnameStatus: () => ({ read: async () => new Map() }),
    riskState: () => ({ read: async () => new Map() }),
    minors: () => ({ read: async () => new Set<string>() }),
    config: () => ({ get: async (_appId: string, key: string) => state.config.get(key) }),
  };
  return { ports, calls };
}

export function fakeEventBus(calls: PortCalls): EventBus {
  return {
    async publish(_trx, event) {
      calls.published.push(event);
      return { eventId: randomUUID() } as unknown as Awaited<ReturnType<EventBus['publish']>>;
    },
  };
}

/** A field cipher stand-in: the module tests never decrypt. */
export const FAKE_CRYPTO = {
  currentKeyVersion: 1,
  decrypt() {
    throw new Error('synthetic field cipher: decrypt was not expected');
  },
} as unknown as FieldCrypto;

// ---------------------------------------------------------------------------------------------
// The assembly.

export interface SettlementModuleLike {
  forWorker(ports: SettlementWorkerPorts): unknown;
}

/** settlement's barrel at run time (its controllers stay out of the spec project's compile). */
export async function settlementModule(): Promise<SettlementModuleLike> {
  const loaded = (await import(new URL('apps/api/src/modules/settlement/index.ts', ROOT).href)) as {
    SettlementModule: SettlementModuleLike;
  };
  return loaded.SettlementModule;
}

/**
 * The ports app.module passes to SettlementModule.forWorker on `entry` (captured; the module is
 * not built), or null when the entry does not call it. More than one call fails the assertion.
 */
export async function capturedPorts(
  entry: 'api' | 'worker' | 'admin' | 'stream' | 'payout',
): Promise<SettlementWorkerPorts | null> {
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const target = await settlementModule();
  const forWorker = vi.spyOn(target, 'forWorker').mockReturnValue({ module: class Stand {} });
  try {
    AppModule.forEntry({
      entry,
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock(BILL_DAY_NOW),
      logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }, { write() {} }),
    });
    expect(
      forWorker.mock.calls.length,
      `SettlementModule.forWorker calls on ${entry}`,
    ).toBeLessThanOrEqual(1);
    const first = forWorker.mock.calls[0];
    return first === undefined ? null : first[0];
  } finally {
    forWorker.mockRestore();
  }
}

export interface NestContext {
  get(token: unknown): unknown;
  close(): Promise<void>;
}

/** A Nest application context holding `module` and the platform tokens given. */
export async function workerContext(
  module: unknown,
  deps: {
    readonly clock: FixedClock;
    readonly logger: RootLogger;
    readonly db?: Kysely<DB>;
    readonly queue?: FakeQueue;
    readonly crypto?: FieldCrypto;
    readonly events?: EventBus;
  },
): Promise<NestContext> {
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(module: unknown, options: object): Promise<NestContext>;
    };
  };
  class Dependencies {}
  class Harness {}
  const providers = [
    { provide: CLOCK, useValue: deps.clock },
    { provide: ROOT_LOGGER, useValue: deps.logger },
    { provide: APP_CONFIG, useValue: loadConfig({ APP_ENV: 'test' }) },
    ...(deps.db === undefined ? [] : [{ provide: DB_TOKEN, useValue: deps.db }]),
    ...(deps.queue === undefined ? [] : [{ provide: JOB_QUEUE, useValue: deps.queue }]),
    ...(deps.crypto === undefined ? [] : [{ provide: FIELD_CRYPTO, useValue: deps.crypto }]),
    ...(deps.events === undefined ? [] : [{ provide: EVENT_BUS, useValue: deps.events }]),
  ];
  return NestFactory.createApplicationContext(
    {
      module: Harness,
      imports: [
        {
          module: Dependencies,
          global: true,
          providers,
          exports: providers.map((value) => value.provide),
        },
        module,
      ],
    },
    { logger: false, abortOnError: false },
  );
}

/** The one handler registered on queue settle (fails the assertion otherwise). */
export function settleHandler(queue: FakeQueue): JobHandler {
  const handlers = queue.registered.filter((entry) => entry.queue === QUEUE);
  expect(handlers).toHaveLength(1);
  const handler = handlers[0]?.handler;
  if (handler === undefined) throw new Error('unreachable: the expect above failed');
  return handler;
}
