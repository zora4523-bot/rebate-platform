// B2-05n rule-test kit (claude-independent, SPEC_REF 9ab94dc0): the worker's review overdue check,
// 规划/08 BR-WDR-26 超时判定（超时检查任务每 5 分钟运行一次，review_deadline 到达后 ≤5 分钟内判定；判定时
// 状态仍 ∈ {PENDING_REVIEW, APPROVED} 即为审核超时；每单只判定一次）and BR-WDR-24（审核超时告警财务）;
// 编排裁定 D10-467 ④, D10-475 ②; 02 §11 event withdrawal.review_overdue (last in the list).
// Conventions of the task brief (§9.2), written out by hand, never read from the implementation:
//   - queue `payout-overdue` (exclusive, worker only, concurrency 1), job `check`, payload { slot },
//     singletonKey = the slot key `review-overdue:YYYY-MM-DDTHH:mm` (5-minute slots, minutes rounded
//     down to a multiple of 5; UTC as risk/domain/risk-scan-slots' keys). Each run enqueues the next
//     slot (trx null, its delay); the worker seeds the current slot after bootstrap and heals it on a
//     timer (exclusive key: a second seed of the same slot merges).
//   - createReviewOverdueCheck({ db, lockUsersForUpdate, eventBus, clock, logger }).run(now): every
//     app's withdrawals with review_deadline <= now, review_overdue_at IS NULL, status ∈
//     {PENDING_REVIEW, APPROVED}; per withdrawal one transaction: users lock { appId, userIds:
//     [user_id] } → reread → CAS review_overdue_at = now, updated_at = now (0 rows: skipped, no
//     event) → eventBus.publish(trx, withdrawal.review_overdue, { withdrawal_id, user_id,
//     review_deadline, overdue_at } as ISO strings; app_id on the envelope); after the commit
//     logger.warn({ app_id, withdrawal_id, review_deadline, overdue_at }, 'withdrawal_review_overdue').
//     A failure of one withdrawal: warn 'withdrawal_review_overdue_failed' (error_name), the others
//     go on, the first error is rethrown at the end. Resolves { scanned, judged }.
// Real pieces: PostgreSQL through @couli/db/testing as couli_app (the int tests hand in
// createTestDatabase), identity's lockUsersForUpdate (behind a recorder), the platform event bus
// (no subscriptions: the event_log row only). Synthetic: members and withdrawals inserted as
// couli_app fixtures (no real user data), the job queue (a recorder of sends) and the loggers.
// Every database case opens its own database: the check scans every app, so cases never share one.
// The check (or job) is built inside each test before anything is observed: red is the skeleton's
// NotImplemented.
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import {
  PayoutModule,
  createReviewOverdueCheck,
  type PayoutWorkerOptions,
  type ReviewOverdueCheck,
  type ReviewOverdueCheckOptions,
  type ReviewOverdueLogger,
} from '../../../../apps/api/src/modules/payout/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB as DB_TOKEN,
  EVENT_BUS,
  FixedClock,
  JOB_QUEUE,
  ROOT_LOGGER,
  createRootLogger,
  loadConfig,
  type EventBus,
  type JobHandler,
  type JobPayload,
  type JobQueue,
  type ReceivedJob,
  type RootLogger,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const TIMEOUT = 60_000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;

/** Queue, job and event of the task brief. */
export const QUEUE = 'payout-overdue';
export const JOB = 'check';
export const EVENT = 'withdrawal.review_overdue';
/** The warn line after the commit (BR-WDR-24 审核超时告警) and the line of a failed withdrawal. */
export const WARN = 'withdrawal_review_overdue';
export const FAILED_WARN = 'withdrawal_review_overdue_failed';

/**
 * BR-WDR-26 例: 周三 10:00 +08:00 提交 → review_deadline 周四 10:00 (2032-10-21 is a Thursday).
 * NOW is 7.5 minutes later, inside the slot 10:05–10:10 +08:00 (UTC 02:05–02:10).
 */
export const DEADLINE = new Date('2032-10-21T02:00:00.000Z');
export const CREATED_AT = new Date('2032-10-20T02:00:00.000Z');
export const NOW = new Date('2032-10-21T02:07:30.000Z');
/** The slot NOW falls in, the next one and the seconds from NOW until it is due. */
export const SLOT = 'review-overdue:2032-10-21T02:05';
export const NEXT_SLOT = 'review-overdue:2032-10-21T02:10';
export const NEXT_DELAY = 150;

/** The payee name of every fixture withdrawal (synthetic; must never reach a log line). */
export const PAYEE_NAME = '合成姓名';
/** A distinctive amount (its digits never occur in an id or an instant by chance). */
export const AMOUNT_FEN = 987_654_321n;

export type Status =
  'PENDING_REVIEW' | 'APPROVED' | 'PAYING' | 'PAID_API' | 'PAID_MANUAL' | 'REJECTED' | 'FAILED';

/** ISO string of an instant (Date or a driver string). */
export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

// ---------------------------------------------------------------------------------------------
// The database.

export interface Database {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export interface Harness {
  readonly database: Database;
  /** couli_app: the check's handle and the seeds. */
  readonly db: Kysely<DB>;
  /** couli_app: observations and the competing transactions of the lock tests. */
  readonly observer: Kysely<DB>;
}

export async function open(create: () => Promise<Database>): Promise<Harness> {
  const database = await create();
  const url = database.urlFor('couli_app');
  return {
    database,
    db: createDb({ connectionString: url, max: 8 }),
    observer: createDb({ connectionString: url, max: 3 }),
  };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (h === undefined) return;
  await Promise.all([destroyDb(h.db), destroyDb(h.observer)]);
  await h.database.drop();
}

/** A fresh database for one case (the check scans every app: cases never share one). */
export async function withHarness(
  create: () => Promise<Database>,
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await open(create);
  try {
    await run(h);
  } finally {
    await close(h);
  }
}

export function appId(): string {
  return `b205n-${randomUUID()}`;
}

/** A synthetic member of `app` (couli_app registers members). */
export async function member(db: Kysely<DB>, app: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
    VALUES (${id}, ${app}, 'fixture', 'fixture', ${randomBytes(4).toString('hex')},
      ${randomBytes(5).toString('hex')}, 'L1', 'sms', 'normal')`.execute(db);
  return id;
}

export interface Seeded {
  readonly id: string;
  readonly appId: string;
  readonly userId: string;
  readonly status: Status;
  readonly reviewDeadline: Date | null;
  readonly payeeHmac: string;
  readonly outBizNo: string;
}

export interface SeedValues {
  readonly status?: Status;
  /** null: a withdrawal without a deadline (never judged). Default DEADLINE. */
  readonly reviewDeadline?: Date | null;
  /** Already judged at this instant. Default null. */
  readonly reviewOverdueAt?: Date | null;
}

/** The columns a status needs beyond the common ones (the table's CHECK constraints). */
function statusColumns(status: Status): Record<string, unknown> {
  switch (status) {
    case 'PENDING_REVIEW':
      return {};
    case 'APPROVED':
      return { reviewer_id: randomUUID(), reviewed_at: CREATED_AT };
    case 'PAYING':
      return { executor_id: randomUUID(), executed_at: CREATED_AT, execute_seq: 1 };
    case 'PAID_API':
      return {
        executed_at: CREATED_AT,
        execute_seq: 1,
        paid_at: CREATED_AT,
        channel_order_id: `CH${randomBytes(8).toString('hex')}`,
      };
    case 'PAID_MANUAL':
      return {
        paid_at: CREATED_AT,
        manual_entry_by: randomUUID(),
        manual_confirm_by: randomUUID(),
        manual_resolution: 'paid',
      };
    case 'REJECTED':
      return { reviewer_id: randomUUID(), reviewed_at: CREATED_AT, reject_reason_code: 'OTHER' };
    case 'FAILED':
      return { executed_at: CREATED_AT, execute_seq: 1, fail_code: 'TEST_CONFIRMED_FAIL' };
  }
}

/** A manual-review alipay withdrawal of `user` in `status` (default PENDING_REVIEW, DEADLINE). */
export async function seedWithdrawal(
  db: Kysely<DB>,
  app: string,
  user: string,
  values: SeedValues = {},
): Promise<Seeded> {
  const status = values.status ?? 'PENDING_REVIEW';
  const reviewDeadline = values.reviewDeadline === undefined ? DEADLINE : values.reviewDeadline;
  const id = randomUUID();
  const payeeHmac = randomBytes(32).toString('hex');
  const outBizNo = randomBytes(16).toString('hex');
  const row: Record<string, unknown> = {
    id,
    app_id: app,
    user_id: user,
    amount_fen: AMOUNT_FEN,
    fee_fen: 0n,
    tax_fen: 0n,
    net_fen: AMOUNT_FEN,
    income_type: 'SERVICE_FEE',
    payout_method: 'alipay',
    payee_name: PAYEE_NAME,
    payee_account_cipher: Buffer.from('synthetic-encrypted-account'),
    payee_hmac: payeeHmac,
    status,
    out_biz_no: outBizNo,
    payout_channel: 'alipay',
    review_mode: 'manual',
    review_deadline: reviewDeadline,
    review_overdue_at: values.reviewOverdueAt ?? null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...statusColumns(status),
  };
  await sql`INSERT INTO app.withdrawals
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
  return { id, appId: app, userId: user, status, reviewDeadline, payeeHmac, outBizNo };
}

/** A fresh member of `app` and one withdrawal of theirs. */
export async function seed(db: Kysely<DB>, app: string, values: SeedValues = {}): Promise<Seeded> {
  return seedWithdrawal(db, app, await member(db, app), values);
}

export interface Stored {
  readonly status: string;
  readonly reviewOverdueAt: string | null;
  readonly updatedAt: string | null;
  readonly rowVersion: number;
}

export async function stored(db: Kysely<DB>, w: Pick<Seeded, 'id'>): Promise<Stored> {
  const row = await db
    .withSchema('app')
    .selectFrom('withdrawals')
    .select(['status', 'review_overdue_at', 'updated_at', 'row_version'])
    .where('id', '=', w.id)
    .executeTakeFirstOrThrow();
  return {
    status: row.status,
    reviewOverdueAt: iso(row.review_overdue_at),
    updatedAt: iso(row.updated_at),
    rowVersion: row.row_version,
  };
}

export interface StoredEvent {
  readonly appId: string;
  readonly payload: unknown;
}

/** The withdrawal.review_overdue rows of event_log (any app), oldest first. */
export async function overdueEvents(db: Kysely<DB>): Promise<StoredEvent[]> {
  const rows = await db
    .withSchema('app')
    .selectFrom('event_log')
    .select(['app_id', 'payload'])
    .where('name', '=', EVENT)
    .orderBy('id')
    .execute();
  return rows.map((row) => ({ appId: row.app_id, payload: row.payload }));
}

/** The event_log rows of a withdrawal (by data.withdrawal_id). */
export async function eventsOf(db: Kysely<DB>, w: Pick<Seeded, 'id'>): Promise<StoredEvent[]> {
  return (await overdueEvents(db)).filter(
    (event) =>
      (event.payload as { data?: { withdrawal_id?: unknown } } | null)?.data?.withdrawal_id ===
      w.id,
  );
}

/** The event_log row 02 §11 asks for: { v: 1, data: { the four fields } }, app on the row. */
export function expectedEvent(w: Seeded, at: Date = NOW): StoredEvent {
  return {
    appId: w.appId,
    payload: {
      v: 1,
      data: {
        withdrawal_id: w.id,
        user_id: w.userId,
        review_deadline: iso(w.reviewDeadline),
        overdue_at: at.toISOString(),
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Logging.

export interface LogLine {
  readonly level: 'info' | 'warn';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export function memoryLogger(): { logger: ReviewOverdueLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    logger: {
      info(fields, message) {
        lines.push({ level: 'info', fields, message });
      },
      warn(fields, message) {
        lines.push({ level: 'warn', fields, message });
      },
    },
  };
}

/** Fields of a line with Date values as ISO strings (pino would print them so). */
export function normalised(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

/** The overdue warn lines (message WARN), fields normalised. */
export function overdueWarns(lines: readonly LogLine[]): Record<string, unknown>[] {
  return lines
    .filter((line) => line.level === 'warn' && line.message === WARN)
    .map((line) => normalised(line.fields));
}

/** The warn line the brief asks for: exactly the app, the withdrawal and the two instants. */
export function expectedWarn(w: Seeded, at: Date = NOW): Record<string, unknown> {
  return {
    app_id: w.appId,
    withdrawal_id: w.id,
    review_deadline: iso(w.reviewDeadline),
    overdue_at: at.toISOString(),
  };
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

/**
 * No log line names an amount, a payee name, account or hmac, or carries one of their values
 * (规划/02 §19 日志脱敏; payout AGENTS.md rule 8; task brief: 日志不含金额 / 姓名 / 账户).
 */
export function expectNoPersonalData(
  lines: readonly { fields: Record<string, unknown> }[],
  seeded: readonly Seeded[],
): void {
  const text = JSON.stringify(
    lines.map((line) => line.fields),
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
  for (const key of lines.flatMap((line) => Object.keys(line.fields))) {
    expect(key, 'log field name').not.toMatch(
      /amount|_fen$|payee|account|phone|hmac|cipher|out_biz_no|^(?:name|nickname|real_?name)$/i,
    );
  }
  expect(text).not.toContain(PAYEE_NAME);
  expect(text).not.toContain('synthetic-encrypted-account');
  expect(text).not.toContain(String(AMOUNT_FEN));
  for (const w of seeded) {
    expect(text).not.toContain(w.payeeHmac);
    expect(text).not.toContain(w.outBizNo);
  }
}

// ---------------------------------------------------------------------------------------------
// The check.

export type LockUsers = ReviewOverdueCheckOptions['lockUsersForUpdate'];

export interface LockCall {
  readonly appId: string;
  readonly userIds: readonly string[];
  readonly inTransaction: boolean;
}

export function isTransaction(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTransaction?: unknown }).isTransaction === true
  );
}

/** identity's real users lock behind a recorder; `before` runs first (barriers of the tests). */
export function recordingLock(before?: () => Promise<void>): {
  lock: LockUsers;
  calls: LockCall[];
} {
  const calls: LockCall[] = [];
  const lock: LockUsers = async (trx, input) => {
    calls.push({
      appId: input.appId,
      userIds: [...input.userIds],
      inTransaction: isTransaction(trx),
    });
    if (before !== undefined) await before();
    return lockUsersForUpdate(trx, input);
  };
  return { lock, calls };
}

/** The platform event bus without subscriptions (event_log rows only; nothing sent). */
export function eventBus(clock: FixedClock): { bus: EventBus; sends: unknown[][] } {
  const sends: unknown[][] = [];
  const bus = createEventBus({
    clock,
    queue: {
      send: (...args: unknown[]) => {
        sends.push(args);
        return Promise.resolve(null);
      },
    } as JobQueue,
    subscriptions: [],
  });
  return { bus, sends };
}

export interface CheckFixture {
  readonly check: ReviewOverdueCheck;
  readonly clock: FixedClock;
  readonly lines: LogLine[];
  readonly locks: LockCall[];
}

/** The check over `h.db` (or `db`) at NOW, with a recording lock and a memory logger. */
export function buildCheck(
  h: Harness,
  overrides: { readonly db?: Kysely<DB>; readonly before?: () => Promise<void> } = {},
): CheckFixture {
  const clock = new FixedClock(NOW);
  const { logger, lines } = memoryLogger();
  const { lock, calls } = recordingLock(overrides.before);
  const check = createReviewOverdueCheck({
    db: overrides.db ?? h.db,
    lockUsersForUpdate: lock,
    eventBus: eventBus(clock).bus,
    clock,
    logger,
  });
  return { check, clock, lines, locks: calls };
}

/** The error a fault injector throws (its name is what the failed line reports). */
export class SyntheticCommitFault extends Error {
  constructor() {
    super('synthetic commit fault');
    this.name = 'SyntheticCommitFault';
  }
}

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * `db` whose transactions fail at the commit when `fails(trx)` says so: the transaction's callback
 * runs to its end, then the fault is thrown in place of the COMMIT, so everything the callback did
 * rolls back (as a failed commit does). Wraps db.transaction() and db.withSchema(...).transaction().
 */
export function faultyCommits(
  db: Kysely<DB>,
  fails: (trx: Transaction<DB>) => Promise<boolean>,
): Kysely<DB> {
  const builder = (inner: object): object =>
    new Proxy(inner, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property === 'execute') {
          return (callback: (trx: Transaction<DB>) => Promise<unknown>) =>
            (value as AnyFunction).call(target, async (trx: Transaction<DB>) => {
              const result = await callback(trx);
              if (await fails(trx)) throw new SyntheticCommitFault();
              return result;
            });
        }
        return (...args: unknown[]) => {
          const result = (value as AnyFunction).apply(target, args);
          return typeof result === 'object' && result !== null && 'execute' in result
            ? builder(result)
            : result;
        };
      },
    });
  const handle = (inner: Kysely<DB>): Kysely<DB> =>
    new Proxy(inner, {
      get(target, property) {
        if (property === 'transaction') return () => builder(target.transaction());
        if (property === 'withSchema') {
          return (schema: string) => handle(target.withSchema(schema));
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as AnyFunction).bind(target) : value;
      },
    });
  return handle(db);
}

/** Resolves to the rejection of `run` (fails the test when it resolves). */
export async function rejection(run: Promise<unknown>): Promise<unknown> {
  const outcome = await run.then(
    () => ({ rejected: false as const, error: undefined }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
  expect(outcome.rejected, 'expected a rejection').toBe(true);
  return outcome.error;
}

/** A promise with its resolve function (gates of the lock tests). */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The real setTimeout, taken before any fake timers are installed. */
const realSetTimeout = globalThis.setTimeout;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

/** Polls `check` on real time for up to `ms`. */
export async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(20);
  }
  return check();
}

// ---------------------------------------------------------------------------------------------
// The job queue.

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
  /** register(queue, handler) calls, when used as the entry's QueueRuntime. */
  readonly registered: { readonly queue: string; readonly handler: JobHandler }[];
  /** When set, every send rejects with it (nothing recorded). */
  failWith: Error | null;
  register(queue: string, handler: JobHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function fakeQueue(): FakeQueue {
  const queue: FakeQueue = {
    sent: [],
    registered: [],
    failWith: null,
    async send(name, job, payload, options) {
      if (queue.failWith !== null) throw queue.failWith;
      queue.sent.push({
        queue: name,
        name: job,
        payload,
        options,
        inTransaction: isTransaction(options.trx),
      });
      return randomUUID();
    },
    register(name, handler) {
      queue.registered.push({ queue: name, handler });
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  return queue;
}

/** The sends on payout-overdue, without the transaction handle (delay 0 shown as absent). */
export function overdueSends(queue: FakeQueue) {
  return queue.sent
    .filter((job) => job.queue === QUEUE)
    .map((job) => ({
      queue: job.queue,
      name: job.name,
      payload: job.payload,
      singletonKey: job.options.singletonKey,
      delaySeconds: job.options.delaySeconds === 0 ? undefined : job.options.delaySeconds,
      inTransaction: job.inTransaction,
    }));
}

/** The send of slot `key` (delay undefined: due at once). */
export function slotSend(key: string, delaySeconds?: number) {
  return {
    queue: QUEUE,
    name: JOB,
    payload: { slot: key },
    singletonKey: key,
    delaySeconds,
    inTransaction: false,
  };
}

/** A delivered `check` job of slot `key`. */
export function checkJob(key = SLOT, attempt = 1): ReceivedJob {
  return { id: randomUUID(), queue: QUEUE, name: JOB, payload: { slot: key }, attempt };
}

// ---------------------------------------------------------------------------------------------
// The worker assembly (app.module's worker entry and PayoutModule.forWorker).

/**
 * The options app.module passes to PayoutModule.forWorker on the worker entry (captured; the module
 * is not built here). Fails an assertion when app.module does not call it exactly once.
 */
export async function capturedWorkerOptions(
  clock: FixedClock,
  logger: RootLogger,
): Promise<PayoutWorkerOptions> {
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const forWorker = vi.spyOn(PayoutModule, 'forWorker').mockReturnValue({ module: PayoutModule });
  try {
    AppModule.forEntry({
      entry: 'worker',
      config: loadConfig({ APP_ENV: 'test' }),
      clock,
      logger,
    });
    expect(
      forWorker,
      'app.module does not assemble PayoutModule on the worker entry',
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
 * A Nest application context holding `module` plus the platform tokens of the worker entry:
 * CLOCK, ROOT_LOGGER, APP_CONFIG, DB, JOB_QUEUE and EVENT_BUS.
 */
export async function workerContext(
  module: unknown,
  deps: {
    readonly clock: FixedClock;
    readonly logger: RootLogger;
    readonly db: Kysely<DB>;
    readonly queue: FakeQueue;
    readonly eventBus: EventBus;
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
  class Root {}
  const providers = [
    { provide: CLOCK, useValue: deps.clock },
    { provide: ROOT_LOGGER, useValue: deps.logger },
    { provide: APP_CONFIG, useValue: loadConfig({ APP_ENV: 'test' }) },
    { provide: DB_TOKEN, useValue: deps.db },
    { provide: JOB_QUEUE, useValue: deps.queue },
    { provide: EVENT_BUS, useValue: deps.eventBus },
  ];
  return NestFactory.createApplicationContext(
    {
      module: Root,
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
