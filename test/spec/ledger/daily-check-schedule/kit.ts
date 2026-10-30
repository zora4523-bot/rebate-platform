// B2-02q rule-test kit (claude-independent, SPEC_REF 37808a50): the schedule and assembly of the
// daily ledger check, 08 BR-FUND-19 (每日 01:00 +08:00 对会计日 D−1 运行 ledger_invariants.sql；
// 账户级差异冻结涉及用户提现；全局差异另将 settle.auto.enabled 置 off；冻结 = withdraw_holds，reason
// ledger_mismatch，source_ref 差错单，同一差错单对同一用户只新增 1 条).
// Conventions from the task brief (编排 10-30, D10-415 ①): queue `ledger-check` (exclusive, worker
// only), job `daily`, payload { app_id, accounting_date: D }, singletonKey `daily:<app_id>:<D>`; the
// run of D is due at D+1 01:00 +08:00 (at once when that has passed); each run enqueues D+1 on a
// transaction (self-rescheduling chain) and the worker seeds / heals it with a module timer (payment
// bill.recon, payout-recon and union-auth precedents); app.module adapts payout's
// createWithdrawHolds and content's createSystemSwitchWriter into the B2-02p ports.
// Real pieces: PostgreSQL through @couli/db/testing as couli_app (the int tests hand in
// createTestDatabase), the runner and the B2-02p execution step behind the job, and — in the
// assembly tests — the ports app.module builds. Synthetic: the job queue (a recorder of sends: which
// queue, job, payload, singletonKey, delay and whether a Kysely transaction was given), the invariant
// files of the job tests (fixture SQL in the unified output shape; their detail carries the checked
// day read from couli.check_date), and, in the job tests only, recording hold / switch ports. Users
// and ledger accounts are written as couli_app fixtures. No real user data.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Selectable } from 'kysely';
import { expect, vi } from 'vitest';
import {
  LedgerDailyCheckModule,
  LedgerError,
  createDailyCheckJob,
  type AutoSettlementSwitch,
  type AutoSettlementSwitchInput,
  type DailyCheckScheduleLogger,
  type LedgerDailyCheckWorkerOptions,
  type LedgerInvariantFile,
  type LedgerMismatchHoldInput,
  type LedgerMismatchHolds,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB as DB_TOKEN,
  FixedClock,
  JOB_QUEUE,
  ROOT_LOGGER,
  createRootLogger,
  loadConfig,
  type JobHandler,
  type JobPayload,
  type JobQueue,
  type ReceivedJob,
  type RootLogger,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);

/** Queue and job of the daily check (task brief). */
export const QUEUE = 'ledger-check';
export const JOB = 'daily';

export const APP = 'dcs-app-a';
export const OTHER = 'dcs-app-b';
export const THIRD = 'dcs-app-c';
export const DAY = '2032-06-15';
export const NEXT_DAY = '2032-06-16';
/** 2032-06-16 01:00 +08:00: the run time of DAY. */
export const RUN_AT = '2032-06-15T17:00:00.000Z';
/** 2032-06-17 01:00 +08:00: the run time of NEXT_DAY. */
export const NEXT_RUN_AT = '2032-06-16T17:00:00.000Z';
export const TIMEOUT = 60_000;
export const SWITCH_KEY = 'settle.auto.enabled';
/** payout's audit action of an added hold (application/withdraw-holds.ts). */
export const HOLD_ADD_ACTION = 'withdraw_hold.add';

export type DiffRow = Selectable<DB['recon_diffs']>;
export type HoldRow = Selectable<DB['withdraw_holds']>;

/** The singletonKey of the run of (app, D). */
export function keyOf(appId: string, day: string): string {
  return `daily:${appId}:${day}`;
}

// ---------------------------------------------------------------------------------------------
// Logging.

export interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string | undefined;
}

/** A logger of the schedule's shape that keeps every line. */
export function memoryLogger(): { logger: DailyCheckScheduleLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger: DailyCheckScheduleLogger = {
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

/** A pino root logger (the platform's) whose lines are parsed back. */
export function rootLogger(): { logger: RootLogger; lines: () => Record<string, unknown>[] } {
  const raw: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void raw.push(line) },
  );
  return { logger, lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>) };
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
  /** The send was given a Kysely transaction (not null, not the pool). */
  readonly inTransaction: boolean;
}

export interface FakeQueue extends JobQueue {
  readonly sent: SentJob[];
  /** Apps whose send rejects (nothing recorded for them). */
  readonly failing: Set<string>;
  /** register(queue, handler) calls, when used as a QueueRuntime. */
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

/** What a send looked like, without the transaction handle. */
export function sendView(job: SentJob) {
  return {
    queue: job.queue,
    name: job.name,
    payload: job.payload,
    singletonKey: job.options.singletonKey,
    delaySeconds: job.options.delaySeconds,
  };
}

/** The expected send of the run of (app, D) with this delay. */
export function expectedSend(appId: string, day: string, delaySeconds: number) {
  return {
    queue: QUEUE,
    name: JOB,
    payload: { app_id: appId, accounting_date: day },
    singletonKey: keyOf(appId, day),
    delaySeconds,
  };
}

/** The sends of one app (in send order). */
export function sentFor(queue: FakeQueue, appId: string): SentJob[] {
  return queue.sent.filter((job) => job.payload['app_id'] === appId);
}

/** A delivered `daily` job. */
export function dailyJob(payload: JobPayload, attempt = 1): ReceivedJob {
  return { id: randomUUID(), queue: QUEUE, name: JOB, payload, attempt };
}

// ---------------------------------------------------------------------------------------------
// The database.

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/** A fresh database; `db` (4 connections) and `observer` (1) as couli_app. */
export async function withDatabase(
  create: () => Promise<TestDatabase>,
  run: (db: Kysely<DB>, observer: Kysely<DB>) => Promise<void>,
): Promise<void> {
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  try {
    await run(db, observer);
  } finally {
    await Promise.all([destroyDb(db), destroyDb(observer)]);
    await database.drop();
  }
}

async function insert(db: Kysely<DB>, table: string, row: Record<string, unknown>) {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

/** A synthetic member (users row) of the app. */
export async function member(db: Kysely<DB>, clock: FixedClock, appId: string): Promise<string> {
  const id = randomUUID();
  await insert(db, 'users', {
    id,
    app_id: appId,
    nickname: 'synthetic member',
    avatar: '',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'member',
    register_method: 'synthetic',
    created_at: clock.now(),
    updated_at: clock.now(),
  });
  return id;
}

export interface UserAccount {
  readonly appId: string;
  readonly userId: string;
  readonly accountId: string;
}

/** A member and their USER_BALANCE account (owner_id = users.id). */
export async function userAccount(
  db: Kysely<DB>,
  clock: FixedClock,
  appId: string,
): Promise<UserAccount> {
  const userId = await member(db, clock, appId);
  const accountId = randomUUID();
  await insert(db, 'ledger_accounts', {
    id: accountId,
    app_id: appId,
    owner_type: 'user',
    owner_id: userId,
    subject: 'USER_BALANCE',
  });
  return { appId, userId, accountId };
}

/** Every recon_diffs row of the app, by ref_id then period. */
export function diffsOf(db: Kysely<DB>, appId: string): Promise<DiffRow[]> {
  return db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('ref_id')
    .orderBy('period')
    .execute();
}

/** Every withdraw_holds row of the app, by user then source. */
export function holdsOf(db: Kysely<DB>, appId: string): Promise<HoldRow[]> {
  return db
    .selectFrom('withdraw_holds')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('user_id')
    .orderBy('source_ref')
    .execute();
}

/** The source_ref of the holds a diff added. */
export function sourceOf(diffId: string): string {
  return `recon_diff:${diffId}`;
}

// ---------------------------------------------------------------------------------------------
// Fixture invariant files (unified output: invariant, checked_rows, scope, app_id, account_id,
// detail). Every difference's detail names its file and the day the runner set for it.

export interface FixtureRow {
  readonly scope: 'account' | 'global';
  readonly appId: string;
  /** account rows: the ledger account. */
  readonly accountId?: string;
  /** global rows: a voucher id (the executor registers the diff on it). */
  readonly voucherId?: string;
}

function rowSql(name: string, code: string, count: number, row: FixtureRow): string {
  const account = row.scope === 'account' ? `'${row.accountId ?? ''}'::uuid` : 'NULL::uuid';
  const voucher = row.voucherId === undefined ? '' : `, 'voucher_id', '${row.voucherId}'`;
  return `SELECT '${code}'::text AS invariant, ${count}::bigint AS checked_rows,
      '${row.scope}'::text AS scope, '${row.appId}'::text AS app_id, ${account} AS account_id,
      jsonb_build_object('fixture', '${name}',
        'check_date', current_setting('couli.check_date')${voucher}) AS detail`;
}

/** A file reporting these differences. */
export function differing(
  name: string,
  code: string,
  rows: readonly FixtureRow[],
): LedgerInvariantFile {
  const text = rows.map((row) => rowSql(name, code, rows.length, row)).join('\nUNION ALL\n');
  return { name, sql: text };
}

/** The clean sentinel of a file: one row inspected, nothing reported. */
export function clean(name: string, code: string): LedgerInvariantFile {
  return {
    name,
    sql: `SELECT '${code}'::text AS invariant, 1::bigint AS checked_rows,
      'none'::text AS scope, NULL::text AS app_id, NULL::uuid AS account_id, NULL::jsonb AS detail`,
  };
}

/** A file breaking the output contract (unknown scope): the runner refuses the whole run. */
export function broken(name: string, code: string): LedgerInvariantFile {
  return {
    name,
    sql: `SELECT '${code}'::text AS invariant, 1::bigint AS checked_rows,
      'sideways'::text AS scope, 'x'::text AS app_id, NULL::uuid AS account_id, NULL::jsonb AS detail`,
  };
}

// ---------------------------------------------------------------------------------------------
// Recording ports of the job tests.

export interface RecordingHolds extends LedgerMismatchHolds {
  readonly calls: LedgerMismatchHoldInput[];
  /** When true, add throws (the diff's transaction rolls back). */
  fail: boolean;
}

/** Writes the withdraw_holds row on the transaction it is given (as payout's add does). */
export function recordingHolds(clock: FixedClock): RecordingHolds {
  const port: RecordingHolds = {
    calls: [],
    fail: false,
    async add(trx, input) {
      port.calls.push(input);
      if (port.fail) throw new Error('synthetic hold failure');
      const id = randomUUID();
      await sql`INSERT INTO app.withdraw_holds
        (id, app_id, user_id, reason, source_ref, created_by, created_at, hold_until)
        VALUES (${id}, ${input.appId}, ${input.userId}, ${input.reason}, ${input.sourceRef},
          ${input.createdBy}, ${clock.now()}, ${input.holdUntil})`.execute(trx);
      return { id };
    },
  };
  return port;
}

export interface RecordingSwitch extends AutoSettlementSwitch {
  readonly turnOffs: AutoSettlementSwitchInput[];
  readonly alerts: AutoSettlementSwitchInput[];
}

export function recordingSwitch(): RecordingSwitch {
  const port: RecordingSwitch = {
    turnOffs: [],
    alerts: [],
    async turnOff(trx, input) {
      await sql`SELECT 1`.execute(trx);
      port.turnOffs.push(input);
      return { key: 'settle.auto.enabled', changed: true, version: 2, fromValue: true };
    },
    alertCommitted(input) {
      port.alerts.push(input);
    },
  };
  return port;
}

// ---------------------------------------------------------------------------------------------
// The job harness.

export interface JobHarness {
  readonly db: Kysely<DB>;
  readonly observer: Kysely<DB>;
  readonly clock: FixedClock;
  readonly lines: LogLine[];
  readonly queue: FakeQueue;
  readonly holds: RecordingHolds;
  readonly settle: RecordingSwitch;
  /** The handler of queue ledger-check over these files. */
  readonly job: JobHandler;
}

/** A fresh database and the `daily` handler over it, at `now`, running `files`. */
export async function withJobHarness(
  create: () => Promise<TestDatabase>,
  setup: { readonly now: string; readonly files: () => readonly LedgerInvariantFile[] },
  run: (h: JobHarness) => Promise<void>,
): Promise<void> {
  await withDatabase(create, async (db, observer) => {
    const clock = new FixedClock(setup.now);
    const { logger, lines } = memoryLogger();
    const queue = fakeQueue();
    const holds = recordingHolds(clock);
    const settle = recordingSwitch();
    const job = createDailyCheckJob({
      db,
      clock,
      queue,
      logger,
      holds,
      autoSettlement: settle,
      invariants: {
        async load() {
          return setup.files();
        },
      },
    });
    await run({ db, observer, clock, lines, queue, holds, settle, job });
  });
}

/** Every error along the `cause` chain (and inside an AggregateError). */
export function errorChain(error: unknown): unknown[] {
  const seen: unknown[] = [];
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.length < 32) {
    const item = queue.shift();
    if (item === undefined || item === null || seen.includes(item)) continue;
    seen.push(item);
    if (item instanceof AggregateError) queue.push(...item.errors);
    if (typeof item === 'object' && 'cause' in item) queue.push((item as { cause: unknown }).cause);
  }
  return seen;
}

/** The ledger error codes along the chain. */
export function ledgerCodes(error: unknown): string[] {
  return errorChain(error)
    .filter((item): item is LedgerError => item instanceof LedgerError)
    .map((item) => item.code);
}

/** The messages along the chain (a skeleton's NotImplemented is not an answer). */
export function messages(error: unknown): string {
  return errorChain(error)
    .map((item) => (item instanceof Error ? item.message : String(item)))
    .join(' | ');
}

/** Resolves to the rejection of `run` (fails the test when it resolves). */
export async function rejection(run: Promise<unknown>): Promise<unknown> {
  const outcome = await run.then(
    () => ({ rejected: false as const }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
  expect(outcome.rejected, 'expected a rejection').toBe(true);
  return outcome.rejected ? outcome.error : undefined;
}

// ---------------------------------------------------------------------------------------------
// The assembly (app.module's worker entry and the ledger module).

export interface WorkerModule {
  readonly module: unknown;
}

/**
 * The options app.module passes to LedgerDailyCheckModule.forWorker on the worker entry (captured;
 * the module is not built here). Fails an assertion when app.module does not call it exactly once.
 */
export async function capturedWorkerOptions(
  clock: FixedClock,
  logger: RootLogger,
): Promise<LedgerDailyCheckWorkerOptions> {
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const forWorker = vi
    .spyOn(LedgerDailyCheckModule, 'forWorker')
    .mockReturnValue({ module: LedgerDailyCheckModule });
  try {
    AppModule.forEntry({
      entry: 'worker',
      config: loadConfig({ APP_ENV: 'test' }),
      clock,
      logger,
    });
    expect(
      forWorker,
      'app.module does not assemble LedgerDailyCheckModule on the worker entry',
    ).toHaveBeenCalledTimes(1);
    return forWorker.mock.calls[0]![0];
  } finally {
    forWorker.mockRestore();
  }
}

export interface NestContext {
  get(token: unknown): unknown;
  close(): Promise<void>;
}

/**
 * A Nest application context holding `module` plus the platform tokens a worker module may use:
 * CLOCK, ROOT_LOGGER, APP_CONFIG and, when given, DB and JOB_QUEUE.
 */
export async function workerContext(
  module: unknown,
  deps: {
    readonly clock: FixedClock;
    readonly logger: RootLogger;
    readonly db?: Kysely<DB>;
    readonly queue?: FakeQueue;
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
