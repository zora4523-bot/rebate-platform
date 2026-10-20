import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, type DB } from '@couli/db';
import type { TestDatabase } from '@couli/db/testing';
import {
  sql,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Insertable,
} from 'kysely';
import { expect, vi } from 'vitest';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';

// Structural public contracts keep Nest's decorated HTTP graph out of the spec TS project.
// Runtime loading of identity is exclusively its public index, never internal implementations.
export interface Verifier {
  verify(input: {
    vendor_request_id: string;
    name: string;
    id_no: string;
    card_no: string;
  }): Promise<'match' | 'mismatch'>;
  query(id: string): Promise<'match' | 'mismatch' | 'not_found' | 'unknown'>;
}
export interface Config {
  configValue(appId: string, key: string, db: Kysely<DB>): Promise<{ value: unknown } | null>;
}
export interface Attempts {
  takeover(subject: { appId: string; id: string }): Promise<void>;
  recheck(subject: { appId: string; id: string }): Promise<void>;
}
export interface Runner {
  runOnce(stopping?: () => boolean): Promise<{ scanned: number }>;
}
export type Schedule = (tick: () => Promise<void>, intervalMs: number) => { stop(): void };
export interface WorkerOptions {
  payoutAccountConfig: {
    inject?: unknown[];
    useFactory(clock: Platform.Clock): Config | Promise<Config>;
  };
}
export interface WorkerModule {
  module: unknown;
  controllers?: unknown[];
}
export interface IdentityApi {
  PAYOUT_VERIFY_RECHECK_INTERVAL_MS?: number;
  createPayoutAccountVerifyAttempts(options: {
    db: Kysely<DB>;
    clock: Platform.Clock;
    logger: Platform.RootLogger;
    verifier: Verifier | null;
    config: Config;
  }): Attempts;
  createPayoutVerifyRecheck(options: {
    db: Kysely<DB>;
    clock: Platform.Clock;
    logger: Platform.RootLogger;
    attempts: Attempts;
    batchSize?: number;
  }): Runner;
  startPayoutVerifyRecheck(
    resolve: () => unknown,
    logger: Platform.RootLogger,
    stopping: () => boolean,
    schedule?: Schedule,
  ): { stop(): Promise<void> };
  payoutVerifyRecheckToken(): symbol;
  IdentityWorkerModule: { forWorker(options: WorkerOptions): WorkerModule };
}

export const ROOT = new URL('../../../../', import.meta.url);
export const NOW = '2026-10-20T04:00:00.000Z';
export const INFLIGHT = 'withdraw.payout_account_verify_inflight_timeout_sec';
export const RECHECK = 'withdraw.payout_account_verify_recheck_minutes';

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

export async function identity() {
  return (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as IdentityApi;
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

export async function workerContext(
  api: IdentityApi,
  p: Awaited<ReturnType<typeof ports>>,
  config: Config,
  appEnv: 'test' | 'local' | 'staging' | 'prod',
  db?: Kysely<DB>,
) {
  const module = api.IdentityWorkerModule.forWorker({
    payoutAccountConfig: { useFactory: () => config },
  });
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(
        module: unknown,
        options: object,
      ): Promise<{
        get(token: unknown): unknown;
        close(): Promise<void>;
      }>;
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
  const context = await NestFactory.createApplicationContext(
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
  return { module, context };
}

export function fields(line: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(line).filter(
      ([key]) => !['level', 'time', 'pid', 'hostname', 'entry', 'env', 'msg'].includes(key),
    ),
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await delay(10);
  }
  expect.fail('expected event was not observed');
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

export async function open(database: TestDatabase) {
  const p = await ports();
  const api = await identity();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
  const verify = vi.fn<Verifier['verify']>().mockResolvedValue('match');
  const query = vi.fn<Verifier['query']>().mockResolvedValue('unknown');
  const values = new Map<string, unknown>();
  const config: Config = {
    configValue: vi.fn(async (appId, key) => ({
      value: values.has(`${appId}:${key}`)
        ? values.get(`${appId}:${key}`)
        : key === INFLIGHT
          ? 60
          : 30,
    })),
  };
  const attempts = (verifier: Verifier | null = { verify, query }) =>
    api.createPayoutAccountVerifyAttempts({
      db,
      clock: p.clock,
      logger: p.logger,
      verifier,
      config,
    });
  const runner = (
    options: {
      batchSize?: number;
      verifier?: Verifier | null;
      attempts?: Attempts;
    } = {},
  ) =>
    api.createPayoutVerifyRecheck({
      db,
      clock: p.clock,
      logger: p.logger,
      attempts: options.attempts ?? attempts(options.verifier),
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    });
  return { ...p, api, db, values, config, verify, query, attempts, runner };
}
export type Kit = Awaited<ReturnType<typeof open>>;

export async function reset(kit: Kit) {
  // Finish previous test fixtures; couli_app deliberately cannot DELETE verification records.
  await kit.db
    .updateTable('payout_account_verify_attempts')
    .set({ status: 'expired_unresolved', resolved_at: kit.clock.now() })
    .where('status', 'in', ['reserved', 'unknown'])
    .execute();
  kit.clock.set(NOW);
  kit.lines.length = 0;
  kit.values.clear();
  kit.query.mockReset().mockResolvedValue('unknown');
  kit.verify.mockClear();
}

export async function owner(kit: Kit) {
  const appId = `recheck_${randomUUID()}`;
  const uid = randomUUID();
  await sql`INSERT INTO app.app_versions
    (id, app_id, platform, channel, latest_version, min_supported_version, update_title,
     update_notes, store_url, default_store, store_listings)
    VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', '2.0.0', '2.0.0', 'fixture',
    'fixture', 'https://example.test/app', 'appstore', '[]'::jsonb)`.execute(kit.db);
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method,
     phone_cipher, phone_hmac)
    VALUES (${uid}, ${appId}, 'fixture', 'https://example.test/avatar', ${randomUUID()},
    ${randomUUID()}, 'L1', 'wechat', ${Buffer.from('synthetic-cipher')}, ${randomUUID()})`.execute(
    kit.db,
  );
  return { appId, uid };
}
export type Owner = Awaited<ReturnType<typeof owner>>;

export async function seed(
  kit: Kit,
  f: Owner,
  patch: Partial<Insertable<DB['payout_account_verify_attempts']>> = {},
) {
  return kit.db
    .insertInto('payout_account_verify_attempts')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      user_id: f.uid,
      verify_date: '2026-10-20',
      status: 'unknown',
      vendor_request_id: randomUUID(),
      request_fingerprint: `synthetic-realname:${randomUUID()}`,
      reserved_at: new Date('2026-10-20T03:58:00Z'),
      unknown_at: new Date('2026-10-20T03:59:00Z'),
      resolved_at: null,
      origin_action: 'payout_account_change',
      idempotency_key: randomUUID(),
      created_at: kit.clock.now(),
      updated_at: kit.clock.now(),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function row(kit: Kit, id: string) {
  return kit.db
    .selectFrom('payout_account_verify_attempts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export async function protectedState(kit: Kit, f: Owner) {
  const scoped = kit.db.withSchema('app');
  return {
    accounts: await scoped
      .selectFrom('payout_accounts')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    changes: await scoped
      .selectFrom('payout_account_changes')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    idempotency: await scoped
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    users: await scoped.selectFrom('users').selectAll().where('app_id', '=', f.appId).execute(),
    occupied: await scoped
      .selectFrom('payout_account_verify_attempts')
      .select(['id', 'verify_date', 'vendor_request_id', 'idempotency_key', 'request_fingerprint'])
      .where('app_id', '=', f.appId)
      .where('status', '<>', 'released')
      .orderBy('id')
      .execute(),
  };
}
