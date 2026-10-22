// B1-15f rule-test fixture (08 BR-ID-27, BR-ID-01; orchestrator brief §9.2 #1-#10, «已定» 2026-10-21).
// The runner is identity's createDeletionExpiry (through identity/index.ts only) over the business
// role couli_app of a cloned test database, with an injected FixedClock, a memory pino logger and
// three controlled ports: the withdrawal port (WithdrawalNonTerminalReader.hasNonTerminal, answer
// per (app_id, user_id): this is how "the port says non-terminal → nothing moves" proves the
// judgement goes through the port), identity's balance port (DeletionBalanceReader.availableFen,
// bigint fen per user) and the calendar configuration. Every port call records whether it got a
// Kysely Transaction and whether the user's app.users row was locked by another session at that
// moment (FOR SHARE NOWAIT from a second connection fails with 55P03). The real ledger behind the
// balance port is exercised by ./assembled.int.test.ts through app.module's own assembly.
// The test database is the global setup's createTestDatabase; this kit only sees a structural type
// (depcruise allows @couli/db/testing in *.int.test.ts only). No timing bets: barriers are promises
// and a bounded poll of pg_locks.
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, type DB } from '@couli/db';
import {
  sql,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type Selectable,
  type Transaction,
  type UnknownRow,
} from 'kysely';
import { expect, vi } from 'vitest';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';

interface TestDatabaseUrls {
  urlFor(role: string): string;
}

export const ROOT = new URL('../../../../', import.meta.url);
/** 2026-10-21 12:00 +08:00. */
export const NOW = '2026-10-21T04:00:00.000Z';
/** BR-ID-27: the cooling period, 7×24 hours. */
export const COOLING_MS = 7 * 24 * 60 * 60 * 1000;
/** Brief §9.2 #1: the timer's interval. */
export const INTERVAL_MS = 60_000;
export const DEFERRED = 'identity_deletion_deferred';
export const OVERDUE = 'identity_deletion_overdue';

export type RequestStatus = 'cooling' | 'processing' | 'done' | 'cancelled';
export type RequestRow = Selectable<DB['deletion_requests']>;
export type UserRow = Selectable<DB['users']>;

export interface PortInput {
  readonly appId: string;
  readonly userId: string;
}
export interface WithdrawalsPort {
  hasNonTerminal(trx: Transaction<DB>, input: PortInput): Promise<boolean>;
}
export interface BalancePort {
  availableFen(trx: Transaction<DB>, input: PortInput): Promise<bigint>;
}
export interface CalendarPort {
  configValue(appId: string, key: string): Promise<{ readonly value: unknown } | null>;
}
export interface Runner {
  runOnce(stopping?: () => boolean): Promise<{ scanned: number }>;
}
export type Schedule = (tick: () => Promise<void>, intervalMs: number) => { stop(): void };
export interface WorkerModule {
  module: unknown;
  controllers?: unknown[];
}
export interface ExpiryApi {
  createDeletionExpiry(options: {
    db: Kysely<DB>;
    clock: Platform.Clock;
    logger: Platform.RootLogger;
    withdrawals: WithdrawalsPort;
    balance: BalancePort;
    calendar: CalendarPort;
    batchSize?: number;
  }): Runner;
  startDeletionExpiry(
    resolve: () => unknown,
    logger: Platform.RootLogger,
    stopping: () => boolean,
    schedule?: Schedule,
  ): { stop(): Promise<void> };
  deletionExpiryToken(): symbol;
  IdentityDeletionExpiryModule: { forWorker(options: never): WorkerModule };
  payoutVerifyRecheckToken(): symbol;
  startPayoutVerifyRecheck(...args: unknown[]): { stop(): Promise<void> };
}

export async function identity(): Promise<ExpiryApi> {
  return (await import(new URL('apps/api/src/modules/identity/index.ts', ROOT).href)) as ExpiryApi;
}

export async function ports() {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof Platform;
  const clock = new platform.FixedClock(NOW);
  const lines: string[] = [];
  const logger = platform.createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { platform, clock, lines, logger, logs };
}
export type Ports = Awaited<ReturnType<typeof ports>>;

/** A log line without pino's own fields and the message. */
export function fields(line: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(line).filter(
      ([key]) => !['level', 'time', 'pid', 'hostname', 'entry', 'env', 'msg'].includes(key),
    ),
  );
}

export function compileOnlyDb(queries: string[]) {
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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function manualSchedule() {
  let tick: (() => Promise<void>) | undefined;
  const cancel = vi.fn();
  const schedule = vi.fn<Schedule>((callback) => {
    tick = callback;
    return { stop: cancel };
  });
  return {
    schedule,
    cancel,
    async fire() {
      expect(tick).toEqual(expect.any(Function));
      await tick!();
    },
  };
}

/**
 * A Nest application context holding `module` plus the platform tokens a worker module may use:
 * CLOCK, ROOT_LOGGER, APP_CONFIG and, when given, DB.
 */
export async function workerHarness(
  p: Ports,
  module: unknown,
  appEnv: 'test' | 'local' | 'staging' | 'prod',
  db?: Kysely<DB>,
) {
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(
        module: unknown,
        options: object,
      ): Promise<{ get(token: unknown): unknown; close(): Promise<void> }>;
    };
  };
  class Dependencies {}
  class Harness {}
  const providers = [
    { provide: p.platform.CLOCK, useValue: p.clock },
    { provide: p.platform.ROOT_LOGGER, useValue: p.logger },
    { provide: p.platform.APP_CONFIG, useValue: { appEnv } },
    ...(db === undefined ? [] : [{ provide: p.platform.DB, useValue: db }]),
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

/**
 * The options app.module passes to IdentityDeletionExpiryModule.forWorker on the worker entry
 * (captured; the module is not built here). Fails an assertion when app.module does not call it.
 */
export async function capturedWorkerOptions(api: ExpiryApi, p: Ports): Promise<unknown> {
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const forWorker = vi
    .spyOn(api.IdentityDeletionExpiryModule, 'forWorker')
    .mockReturnValue({ module: api.IdentityDeletionExpiryModule });
  try {
    AppModule.forEntry({
      entry: 'worker',
      config: p.platform.loadConfig({ APP_ENV: 'test' }),
      clock: p.clock,
      logger: p.logger,
    });
    expect(
      forWorker,
      'app.module does not assemble IdentityDeletionExpiryModule',
    ).toHaveBeenCalledTimes(1);
    return forWorker.mock.calls[0]![0] as unknown;
  } finally {
    forWorker.mockRestore();
  }
}

// ---- controlled ports ------------------------------------------------------------------------

export interface PortCall {
  readonly appId: string;
  readonly userId: string;
  /** The executor the port got was a Kysely Transaction (the caller's), not the pool. */
  readonly inTransaction: boolean;
  /** Another connection could not take FOR SHARE NOWAIT on the user's row (55P03). */
  readonly userRowLocked: boolean;
}
export interface HoldPlan {
  readonly hold: Promise<void>;
  readonly entered: () => void;
}

const key = (appId: string, userId: string) => `${appId}/${userId}`;

function isTransaction(executor: unknown): boolean {
  return (
    typeof executor === 'object' &&
    executor !== null &&
    (executor as { isTransaction?: unknown }).isTransaction === true
  );
}

async function userRowLocked(db: Kysely<DB>, appId: string, userId: string): Promise<boolean> {
  try {
    await db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM app.users WHERE app_id = ${appId} AND id = ${userId}
        FOR SHARE NOWAIT`.execute(trx);
    });
    return false;
  } catch (error) {
    if ((error as { code?: unknown }).code === '55P03') return true;
    throw error;
  }
}

export async function open(database: TestDatabaseUrls) {
  const p = await ports();
  const api = await identity();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
  const nonTerminal = new Map<string, boolean>();
  const balances = new Map<string, bigint>();
  const holds = new Map<string, HoldPlan[]>();
  const withdrawalCalls: PortCall[] = [];
  const balanceCalls: PortCall[] = [];
  const calendarValues = new Map<string, unknown>();
  const calendarCalls: { appId: string; key: string }[] = [];
  const withdrawals: WithdrawalsPort = {
    async hasNonTerminal(trx, input) {
      withdrawalCalls.push({
        appId: input.appId,
        userId: input.userId,
        inTransaction: isTransaction(trx),
        userRowLocked: await userRowLocked(db, input.appId, input.userId),
      });
      const plan = holds.get(key(input.appId, input.userId))?.shift();
      if (plan !== undefined) {
        plan.entered();
        await plan.hold;
      }
      return nonTerminal.get(key(input.appId, input.userId)) ?? false;
    },
  };
  const balance: BalancePort = {
    async availableFen(trx, input) {
      balanceCalls.push({
        appId: input.appId,
        userId: input.userId,
        inTransaction: isTransaction(trx),
        userRowLocked: await userRowLocked(db, input.appId, input.userId),
      });
      return balances.get(key(input.appId, input.userId)) ?? 0n;
    },
  };
  const calendar: CalendarPort = {
    async configValue(appId, configKey) {
      calendarCalls.push({ appId, key: configKey });
      return calendarValues.has(configKey)
        ? { value: calendarValues.get(configKey), version: 1 }
        : null;
    },
  };
  /** A new runner (call it in the test body: NotImplemented must fail each test). */
  const runner = (options: { batchSize?: number; db?: Kysely<DB> } = {}) =>
    api.createDeletionExpiry({
      db: options.db ?? db,
      clock: p.clock,
      logger: p.logger,
      withdrawals,
      balance,
      calendar,
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    });
  return {
    ...p,
    api,
    db,
    nonTerminal,
    balances,
    holds,
    withdrawalCalls,
    balanceCalls,
    calendarValues,
    calendarCalls,
    runner,
    setNonTerminal(owner: Owner, answer: boolean) {
      nonTerminal.set(key(owner.appId, owner.uid), answer);
    },
    setBalance(owner: Owner, fen: bigint) {
      balances.set(key(owner.appId, owner.uid), fen);
    },
    hold(owner: Owner, plan: HoldPlan) {
      const k = key(owner.appId, owner.uid);
      holds.set(k, [...(holds.get(k) ?? []), plan]);
    },
    withdrawalCallsOf(owner: Owner) {
      return withdrawalCalls.filter((c) => c.appId === owner.appId && c.userId === owner.uid);
    },
    balanceCallsOf(owner: Owner) {
      return balanceCalls.filter((c) => c.appId === owner.appId && c.userId === owner.uid);
    },
  };
}
export type Kit = Awaited<ReturnType<typeof open>>;

/**
 * Between tests: every open request of earlier tests reaches done (couli_app cannot DELETE), so a
 * cross-app round only sees this test's rows; ports, logs and the clock are reset.
 */
export async function reset(kit: Kit) {
  await sql`UPDATE app.deletion_requests SET status = 'done', processed_at = cooling_until,
    row_version = row_version + 1 WHERE status IN ('cooling', 'processing')`.execute(kit.db);
  kit.clock.set(NOW);
  kit.lines.length = 0;
  kit.nonTerminal.clear();
  kit.balances.clear();
  kit.holds.clear();
  kit.withdrawalCalls.length = 0;
  kit.balanceCalls.length = 0;
  kit.calendarValues.clear();
  kit.calendarCalls.length = 0;
}

export async function close(kit: Kit | undefined) {
  await kit?.db.destroy();
}

// ---- seeding and reading ---------------------------------------------------------------------

export interface Owner {
  readonly appId: string;
  readonly uid: string;
}

/** A fresh app id (unless given) and one user of it with users.status `status` (default normal). */
export async function owner(
  db: Kysely<DB>,
  options: { readonly appId?: string; readonly status?: string } = {},
): Promise<Owner> {
  const appId = options.appId ?? `dx_${randomBytes(10).toString('hex')}`;
  const uid = randomUUID();
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status,
     phone_hmac)
    VALUES (${uid}, ${appId}, 'fixture', 'https://example.test/avatar',
      ${randomBytes(6).toString('hex')}, ${randomBytes(6).toString('hex')}, 'L1', 'sms',
      ${options.status ?? 'normal'}, ${randomBytes(32).toString('hex')})`.execute(db);
  return { appId, uid };
}

/**
 * A deletion request written directly (synthetic fixture). Default: cooling, applied exactly one
 * cooling period before `coolingUntil` (default: the kit's NOW, i.e. due now).
 */
export async function seedRequest(
  db: Kysely<DB>,
  o: Owner,
  options: {
    readonly status?: RequestStatus;
    readonly applyAt?: Date;
    readonly coolingUntil?: Date;
    readonly snapshotFen?: bigint;
  } = {},
): Promise<RequestRow> {
  const until =
    options.coolingUntil ??
    (options.applyAt === undefined
      ? new Date(NOW)
      : new Date(options.applyAt.getTime() + COOLING_MS));
  const applyAt = options.applyAt ?? new Date(until.getTime() - COOLING_MS);
  const status = options.status ?? 'cooling';
  return db
    .withSchema('app')
    .insertInto('deletion_requests')
    .values({
      id: randomUUID(),
      app_id: o.appId,
      user_id: o.uid,
      status,
      apply_at: applyAt,
      cooling_until: until,
      cancelled_at: status === 'cancelled' ? applyAt : null,
      cancel_reason: status === 'cancelled' ? 'user' : null,
      processed_at: status === 'done' ? until : null,
      balance_snapshot_fen: options.snapshotFen ?? 1234n,
      created_at: applyAt,
      updated_at: applyAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function request(db: Kysely<DB>, id: string): Promise<RequestRow> {
  return db
    .withSchema('app')
    .selectFrom('deletion_requests')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export async function userRow(db: Kysely<DB>, o: Owner): Promise<UserRow> {
  return db
    .withSchema('app')
    .selectFrom('users')
    .selectAll()
    .where('app_id', '=', o.appId)
    .where('id', '=', o.uid)
    .executeTakeFirstOrThrow();
}

/** One USER_BALANCE ledger account of the user with this available balance (bigint fen). */
export async function seedLedgerBalance(db: Kysely<DB>, o: Owner, availableFen: bigint) {
  const accountId = randomUUID();
  await sql`INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
    VALUES (${accountId}, ${o.appId}, 'user', ${o.uid}, 'USER_BALANCE')`.execute(db);
  await sql`INSERT INTO app.account_balances
    (app_id, account_id, available_fen, frozen_fen, negative_since, version)
    VALUES (${o.appId}, ${accountId}, ${availableFen}, 0,
      ${availableFen < 0n ? '2026-10-01' : null}::date, 1)`.execute(db);
}

/** Warn lines (level 40) of one message, optionally of one app. */
export function warnings(kit: Pick<Kit, 'logs'>, msg: string, appId?: string) {
  return kit
    .logs()
    .filter(
      (line) =>
        line['level'] === 40 &&
        line['msg'] === msg &&
        (appId === undefined || line['app_id'] === appId),
    );
}

/** Milliseconds of a logged instant (an ISO string, as pino writes a Date). */
export function instant(value: unknown): number {
  expect(typeof value, `not a logged instant: ${String(value)}`).toBe('string');
  const parsed = Date.parse(value as string);
  expect(Number.isNaN(parsed), String(value)).toBe(false);
  return parsed;
}

// ---- barriers --------------------------------------------------------------------------------

/**
 * Waits until at least `count` sessions of this test database wait for a lock that is not granted.
 * A bounded poll of pg_locks, not a timed bet.
 */
export async function lockWaiters(db: Kysely<DB>, count: number): Promise<void> {
  let waiting = 0;
  for (let attempt = 0; attempt < 1500 && waiting < count; attempt += 1) {
    if (attempt > 0) await delay(10);
    const { rows } = await sql<{ waiting: number }>`SELECT count(DISTINCT l.pid)::int AS waiting
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database()`.execute(db);
    waiting = rows[0]!.waiting;
  }
  expect(
    waiting,
    `fewer than ${count} sessions waited on a lock within the bound`,
  ).toBeGreaterThanOrEqual(count);
}

/** A promise with its opener. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Holds a transaction open on its own connection: `body` runs, then the transaction waits until
 * `commit()` and commits. `done` settles with the transaction.
 */
export function heldTransaction<T>(
  db: Kysely<DB>,
  body: (trx: Transaction<DB>) => Promise<T>,
): { ready: Promise<T>; commit: () => void; done: Promise<void> } {
  const release = gate();
  let resolveReady!: (value: T) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<T>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = db.transaction().execute(async (trx) => {
    resolveReady(await body(trx));
    await release.promise;
  });
  done.catch(rejectReady);
  return { ready, commit: release.open, done };
}

/**
 * A copy of `db` whose second write (UPDATE / INSERT on app.users or app.deletion_requests) fails
 * AFTER the database executed it: the transaction around it must roll both writes back. `fired()`
 * tells whether the failure was injected.
 */
export function failAfterSecondWrite(db: Kysely<DB>) {
  const writes = new WeakSet<object>();
  let count = 0;
  let injected = false;
  const target = /"?(users|deletion_requests)"?/;
  function isWrite(node: RootOperationNode): boolean {
    if (node.kind === 'UpdateQueryNode' || node.kind === 'InsertQueryNode') {
      return target.test(JSON.stringify(node));
    }
    if (node.kind === 'RawNode') {
      const text = node.sqlFragments.join('?').trim().toLowerCase();
      return (text.startsWith('update') || text.startsWith('insert')) && target.test(text);
    }
    return false;
  }
  const plugin: KyselyPlugin = {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      if (isWrite(args.node)) writes.add(args.queryId);
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      if (writes.has(args.queryId)) {
        count += 1;
        if (count === 2) {
          injected = true;
          throw new Error('injected failure after the second write');
        }
      }
      return args.result;
    },
  };
  return { db: db.withPlugin(plugin), fired: () => injected };
}
