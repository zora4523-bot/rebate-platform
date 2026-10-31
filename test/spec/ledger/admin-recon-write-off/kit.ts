// B2-07e rule-test kit (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// writeOffAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/write-off: payout.execute,
// step-up tier totp, Idempotency-Key; order permission → step-up → body → recon_diff_id → status →
// the W11 guard; effects in one transaction: the withdrawal APPROVED → PAID_API with the success
// voucher `wd:{id}:PAID`, the difference written_off with resolution.w11 and note, every unreleased
// hold whose source is the difference released, audit recon_diff_write_off, the withdrawal change
// published, the attempt-append job queued) and 08 BR-WDR-23 ③ 决-08 A, BR-WDR-08 W11, BR-WDR-09,
// BR-FUND-19; task §9.2 (releasedBy admin:<id>, voucher operator admin:<id>).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer,
// the started JOB_QUEUE and the event bus), ledger, PostgreSQL through @couli/db/testing (couli_app
// for the entry and the seeds, couli_payout for the attempt seeds), Redis for the admin sessions.
// Synthetic: the R2 difference with its bill line, the W9-returned withdrawal with its FREEZE
// voucher and failed transfer attempt (../../payout/proven-success/kit.ts), the holds, admin
// accounts and a one-shot fault in the entry's database handle for the roll-back cases. The
// totp step-up token is issued the way POST /admin/v1/auth/step-up issues it after a correct
// authenticator code (admin's createAdminStepUpTokens on the entry's Redis namespace
// admin-step-up), as ../../payment/admin/kit.ts does. No real user, payee or merchant data.
// Missing pieces fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { createLedger, type Ledger } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FixedClock,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  BILL_DATE,
  billLineJson,
  channelOrderOf,
  newMember,
  seedReturned,
  setConfig,
  type ReturnedSeed,
  type Seeded,
} from '../../payout/proven-success/kit.ts';
import { seedHold, type HoldRow } from '../admin-recon-close/kit.ts';
import {
  NOW,
  contractPaths,
  normalize,
  seedDiff,
  type DiffRow,
  type DiffSeed,
  type Fixture,
} from '../admin-recon-diffs/kit.ts';

export {
  BILL_DATE,
  BOOKED_AT,
  BOOKED_AT_MS,
  PAYEE_NAME,
  SWITCH,
  attemptRows,
  balanceOf,
  billLineJson,
  changes,
  channelOrderOf,
  entries,
  frozenMismatches,
  lockUsersRow,
  paidEntries,
  rejectWithdrawal,
  seedAttempt,
  voucherOf,
  withdrawalRow,
  withdrawalVouchers,
  type Seeded,
} from '../../payout/proven-success/kit.ts';
export {
  allHolds,
  audits,
  chars,
  diffNow,
  holdNow,
  holdRow,
  idempotencyRows,
  seedHold,
  sourceOf,
  track,
  waiting,
  type HoldRow,
} from '../admin-recon-close/kit.ts';
export {
  DETAIL_KEYS,
  NOW,
  ago,
  allDiffs,
  contractPaths,
  detailView,
  normalize,
  seedDiff,
  type DiffRow,
} from '../admin-recon-diffs/kit.ts';

export const WRITE_OFF_PATH = '/admin/v1/recon-diffs/{recon_diff_id}/write-off';
export const DETAIL_PATH = '/admin/v1/recon-diffs/{recon_diff_id}';
/** specs/permissions.yaml: payout.execute (step-up tier totp) writes off; fund.* only read / close. */
export const EXECUTE = 'payout.execute';
export const RECON = 'fund.recon';
export const VIEW = 'fund.view';
/** The audit action of the contract (writeOffAdminReconDiff). */
export const WRITE_OFF_ACTION = 'recon_diff_write_off';
/** The payout process's queue of the W11 attempt records (task §9.3). */
export const ATTEMPT_QUEUE = 'payout-attempt-append';
/** The body the console sends (expected status fixed APPROVED). */
export const BODY = { expected_withdrawal_status: 'APPROVED' } as const;

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// Database of one test file: couli_app (entry and seeds), a one-connection couli_app pool for row
// locks, couli_payout (attempt seeds), Redis. Helpers imported at run time like
// ../../payment/orders/kit.ts (no static dependency on @couli/db/testing).

interface TestDatabase {
  urlFor(role: string): string;
  drop(): Promise<void>;
}
interface TestRedis {
  url: string;
  stop(): Promise<void>;
}
interface Testing {
  createTestDatabase(): Promise<TestDatabase>;
  acquireTestRedis(): Promise<TestRedis>;
}
function testing(): Promise<Testing> {
  return import(
    new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
  ) as Promise<Testing>;
}

export function suite() {
  let database: TestDatabase | undefined;
  let server: TestRedis | undefined;
  let db: Kysely<DB> | undefined;
  let holder: Kysely<DB> | undefined;
  let payout: Kysely<DB> | undefined;
  beforeAll(async () => {
    const t = await testing();
    database = await t.createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
    holder = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 3 });
    server = await t.acquireTestRedis();
  }, 180_000);
  afterAll(async () => {
    try {
      await Promise.all(
        [holder, db, payout].flatMap((handle) => (handle ? [destroyDb(handle)] : [])),
      );
    } finally {
      try {
        await database?.drop();
      } finally {
        await server?.stop();
      }
    }
  }, 30_000);
  return {
    db(): Kysely<DB> {
      expect(db, 'test database').toBeDefined();
      return db!;
    },
    /** A second pool of one connection, for the row locks held from outside. */
    holder(): Kysely<DB> {
      expect(holder, 'test database').toBeDefined();
      return holder!;
    },
    /** couli_payout. */
    payout(): Kysely<DB> {
      expect(payout, 'test database').toBeDefined();
      return payout!;
    },
    redisUrl(): string {
      expect(server, 'test redis').toBeDefined();
      return server!.url;
    },
  };
}
export type WriteOffSuite = ReturnType<typeof suite>;

export interface WriteOffFixture extends Fixture {
  readonly payout: Kysely<DB>;
  /** The ledger of the seeds (FREEZE vouchers, balances). */
  readonly ledger: Ledger;
}

export function fixture(s: WriteOffSuite, instant = NOW): WriteOffFixture {
  const clock = new FixedClock(instant);
  return {
    s,
    db: s.db(),
    payout: s.payout(),
    clock,
    ledger: createLedger({ clock }),
    appId: `w11_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
  };
}

/**
 * B2-08b: a verified real name, as BR-WDR-03 requires of every withdrawal; W11 keeps tax_ytd per
 * real-name identity (id_no_hmac) in the same transaction and refuses a member without one. One
 * app.realname row, status verified, synthetic ciphers only (couli_app may INSERT it).
 */
async function seedVerifiedRealname(db: Kysely<DB>, appId: string, userId: string): Promise<void> {
  const hmac = randomBytes(32).toString('hex');
  await sql`INSERT INTO app.realname
    (id, app_id, user_id, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, status,
     provider, verified_at, tax_retained)
    VALUES (${randomUUID()}, ${appId}, ${userId}, ${Buffer.from('synthetic-name')},
      ${Buffer.from('synthetic-id-no')}, ${hmac}, ${Buffer.from('synthetic-birth-date')},
      ${'verified'}, ${'synthetic'}, ${new Date('2026-10-01T02:00:00.000Z')}, ${false})`.execute(
    db,
  );
}

/**
 * A synthetic member of the fixture's app with a funded ledger account and a verified real name
 * (the precondition of every withdrawal, BR-WDR-03; W11 needs it for tax_ytd, B2-08b).
 */
export async function memberOf(f: WriteOffFixture, balance?: bigint): Promise<string> {
  const userId = await newMember(f.db, f.ledger, f.appId, balance);
  await seedVerifiedRealname(f.db, f.appId, userId);
  return userId;
}

/** A config row of the fixture's app (set before the first request of the app). */
export function setSwitch(f: WriteOffFixture, key: string, value: unknown): Promise<void> {
  return setConfig(f.db, f.appId, key, value);
}

/** A withdrawal of the fixture's app (default: as W9 returned it, see seedReturned). */
export function seedWithdrawal(
  f: WriteOffFixture,
  values: Omit<ReturnedSeed, 'appId'>,
): Promise<Seeded> {
  return seedReturned({ db: f.db, payout: f.payout }, f.ledger, { ...values, appId: f.appId });
}

/** The resolution the R2 reconciliation stores for an APPROVED withdrawal returned by W9. */
export function returnedResolution(
  w: Pick<Seeded, 'id' | 'outBizNo' | 'net'>,
  line: Record<string, string | null> | null = billLineJson(w),
): Record<string, unknown> {
  return {
    case: 'payer_side_returned',
    bill_date: BILL_DATE,
    bill_line: line,
    withdrawal_id: w.id,
    out_biz_no: w.outBizNo,
    our_status: 'APPROVED',
    w11_by_bill_line: true,
  };
}

/** The R2 difference of `w` as the reconciliation registers it (overridable). */
export function seedReturnedDiff(
  f: WriteOffFixture,
  w: Pick<Seeded, 'id' | 'outBizNo' | 'net'>,
  patch: DiffSeed = {},
): Promise<DiffRow> {
  return seedDiff(f, {
    source: 'R2',
    type: 'channel_mismatch',
    period: BILL_DATE,
    ref_type: 'withdrawal',
    ref_id: w.id,
    expected_fen: 0n,
    actual_fen: w.net,
    diff_fen: -w.net,
    dedupe_key: `R2:alipay:${BILL_DATE}:wd:${w.id}`,
    created_at: new Date(f.clock.now().getTime() - 6 * 3_600_000),
    updated_at: new Date(f.clock.now().getTime() - 6 * 3_600_000),
    resolution: returnedResolution(w),
    ...patch,
  });
}

export interface Case {
  readonly userId: string;
  readonly w: Seeded;
  readonly diff: DiffRow;
  /** The member's hold of reason recon_diff whose source is the difference (unreleased). */
  readonly hold: HoldRow | null;
}

/**
 * The whole case of BR-WDR-23 ③ for W11: a funded member, the withdrawal W9 returned (one failed
 * transfer attempt, amount frozen), the R2 difference with its bill line, and (unless `hold` is
 * false) the member's hold source_ref `recon_diff:<id>` the reconciliation added. Every part
 * overridable.
 */
export async function seedCase(
  f: WriteOffFixture,
  options: {
    readonly withdrawal?: Omit<ReturnedSeed, 'appId' | 'userId'>;
    readonly diff?: (w: Seeded) => DiffSeed;
    readonly hold?: boolean;
  } = {},
): Promise<Case> {
  const userId = await memberOf(f);
  const w = await seedWithdrawal(f, { ...options.withdrawal, userId });
  const diff = await seedReturnedDiff(f, w, options.diff?.(w) ?? {});
  const hold =
    options.hold === false
      ? null
      : await seedHold(f, {
          user_id: userId,
          reason: 'recon_diff',
          source_ref: `recon_diff:${diff.id}`,
          created_by: 'system:payout-recon',
        });
  return { userId, w, diff, hold };
}

/**
 * Everything a write-off may change in the fixture's app: differences, holds, withdrawals,
 * attempts, vouchers, balances, events, queued jobs (any queue) and audit records.
 */
export async function everything(f: WriteOffFixture) {
  const jobs = await sql<{ name: string; data: unknown }>`
    SELECT name, data FROM pgboss.job WHERE data->'payload'->>'app_id' = ${f.appId}
    ORDER BY name, created_on, id`.execute(f.db);
  return {
    diffs: await f.db
      .selectFrom('recon_diffs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    holds: await f.db
      .selectFrom('withdraw_holds')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    withdrawals: await f.db
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    attempts: await f.db
      .selectFrom('payout_attempts')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    vouchers: await f.db
      .selectFrom('ledger_vouchers')
      .select(['uniq_key', 'operator'])
      .where('app_id', '=', f.appId)
      .orderBy('uniq_key')
      .execute(),
    balances: await f.db
      .selectFrom('account_balances')
      .select(['account_id', 'available_fen', 'frozen_fen'])
      .where('app_id', '=', f.appId)
      .orderBy('account_id')
      .execute(),
    events: await f.db
      .selectFrom('event_log')
      .select(['name', 'payload'])
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    jobs: jobs.rows,
    audits: await f.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

/** The attempt-append jobs (pgboss.job) naming the withdrawal. */
export async function attemptJobs(f: WriteOffFixture, withdrawalId: string) {
  const result = await sql<{ state: string; data: { name: string; payload: unknown } }>`
    SELECT state::text AS state, data FROM pgboss.job
    WHERE name = ${ATTEMPT_QUEUE} AND data->'payload'->>'withdrawal_id' = ${withdrawalId}
    ORDER BY created_on, id`.execute(f.db);
  return result.rows;
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the entry's database handle.

/**
 * Where the next failure is thrown: the INSERT of the recon_diff_write_off audit record, the
 * UPDATE of withdraw_holds, or the UPDATE of recon_diffs.
 */
export type FaultPoint = 'audit' | 'hold_update' | 'diff_update';
export const FAULT_POINTS: readonly FaultPoint[] = ['audit', 'hold_update', 'diff_update'];

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  tripped: number;
}

function faultPlugin(fault: Fault): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  return {
    transformQuery({ node, queryId }) {
      const point = fault.point;
      if (point === null) return node;
      const compiled = compiler.compileQuery(node, queryId);
      const text = compiled.sql;
      const hit =
        point === 'audit'
          ? /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?audit_logs\b/i.test(text) &&
            (text.includes(WRITE_OFF_ACTION) ||
              JSON.stringify(compiled.parameters).includes(WRITE_OFF_ACTION))
          : new RegExp(
              `^\\s*update\\s+(?:"?app"?\\s*\\.\\s*)?"?${point === 'hold_update' ? 'withdraw_holds' : 'recon_diffs'}\\b`,
              'i',
            ).test(text);
      if (hit) {
        fault.point = null;
        fault.tripped += 1;
        throw new Error(`synthetic failure at ${point}`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'writeOff' | 'detail';

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface AdminSent {
  readonly op: Operation;
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface WriteOffOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: `executor` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface WriteOffAdmin {
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier totp by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/recon-diffs/{recon_diff_id}/write-off with the JSON body. */
  writeOff(reconDiffId: string, body: unknown, options?: WriteOffOptions): Promise<AdminSent>;
  /** GET /admin/v1/recon-diffs/{recon_diff_id} as `viewer`. */
  detail(reconDiffId: string): Promise<AdminSent>;
  /** An account with payout.execute only. */
  readonly executor: AdminCaller;
  /** An account with fund.recon and fund.view (closes and reads, cannot write off). */
  readonly viewer: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** A fresh Idempotency-Key of the contract format (8–64 of [A-Za-z0-9_-]). */
export function newKey(): string {
  return `wo_${randomBytes(12).toString('hex')}`;
}

/** The concrete path of the write-off of a difference (also the idempotency scope's path). */
export function writeOffPath(reconDiffId: string): string {
  return `/admin/v1/recon-diffs/${encodeURIComponent(reconDiffId)}/write-off`;
}

/**
 * Runs `run` against a started admin entry on the fixture's database (through the fault plugin),
 * clock and Redis.
 */
export async function withWriteOffAdmin(
  f: WriteOffFixture,
  run: (h: WriteOffAdmin) => Promise<void>,
) {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-07e-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { point: null, tripped: 0 };
  const store = f.db.withPlugin(faultPlugin(fault));
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_07e_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: store, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const caller: WriteOffAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `w11_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        })
        .execute();
      if (permissions.length > 0) {
        await f.db
          .insertInto('admin_permissions')
          .values(
            permissions.map((permission_key) => ({
              app_id: f.appId,
              admin_id: id,
              permission_key,
              granted_by: id,
              granted_at: f.clock.now(),
            })),
          )
          .execute();
      }
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
        adminId: id,
        appId: f.appId,
      });
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
        claims.sessionId,
        {
          adminId: id,
          appId: f.appId,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: f.clock.now().getTime(),
        },
      );
      return { id, token, sessionId: claims.sessionId };
    };
    const stepUp: WriteOffAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const executor = await caller([EXECUTE]);
    const viewer = await caller([RECON, VIEW]);
    const sent = (op: Operation, response: { statusCode: number; body: string }): AdminSent => ({
      op,
      statusCode: response.statusCode,
      body: response.body,
      json: () => JSON.parse(response.body) as Envelope,
    });
    await run({
      fault,
      caller,
      stepUp,
      executor,
      viewer,
      async writeOff(reconDiffId, body, options = {}) {
        const who = options.caller === undefined ? executor : options.caller;
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-trace-id': randomUUID(),
        };
        if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
        if (options.key !== null) headers['idempotency-key'] = options.key ?? newKey();
        const token =
          options.stepUp !== undefined ? options.stepUp : who === null ? null : await stepUp(who);
        if (token !== null) headers['x-step-up-token'] = token;
        const response = await server.inject({
          method: 'POST',
          url: writeOffPath(reconDiffId),
          headers,
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        });
        return sent('writeOff', response);
      },
      async detail(reconDiffId) {
        const response = await server.inject({
          method: 'GET',
          url: `/admin/v1/recon-diffs/${encodeURIComponent(reconDiffId)}`,
          headers: { authorization: `Bearer ${viewer.token}`, 'x-trace-id': randomUUID() },
          remoteAddress: '127.0.0.1',
        });
        return sent('detail', response);
      },
    });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The contract.

const PATHS: Record<Operation, { path: string; method: 'get' | 'post' }> = {
  writeOff: { path: WRITE_OFF_PATH, method: 'post' },
  detail: { path: DETAIL_PATH, method: 'get' },
};

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  20902: 409,
  40901: 409,
  50001: 500,
};

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const { path, method } = PATHS[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.[method]?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${path} ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(sent.body) as unknown;
  } catch {
    parsed = sent.body;
  }
  expect(check(parsed), `${sent.body} ${JSON.stringify(check.errors)}`).toBe(true);
}

/** Status, code and (when given) exact data, then the contract schema. */
export async function answer(sent: AdminSent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

export interface WrittenOff {
  /** data.recon_diff, its instants as epoch milliseconds. */
  readonly recon_diff: Record<string, unknown>;
  /** data.withdrawal, paid_at as epoch milliseconds. */
  readonly withdrawal: Record<string, unknown>;
  readonly released_hold_count: unknown;
}

/** The data of a successful write-off: exactly recon_diff, withdrawal and released_hold_count. */
export async function writtenOff(sent: AdminSent): Promise<WrittenOff> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual([
    'recon_diff',
    'released_hold_count',
    'withdrawal',
  ]);
  const withdrawal = { ...(data['withdrawal'] as Record<string, unknown>) };
  if (typeof withdrawal['paid_at'] === 'string') {
    withdrawal['paid_at'] = Date.parse(withdrawal['paid_at']);
  }
  return {
    recon_diff: normalize(data['recon_diff']),
    withdrawal,
    released_hold_count: data['released_hold_count'],
  };
}

/** The 20902 of a difference that is no longer open or processing. */
export function diffConflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'recon_diff' });
}

/** The 20902 of a withdrawal that is no longer APPROVED. */
export function withdrawalConflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'withdrawal' });
}

/** The 20001 of a W11 guard refusal with its reason. */
export function refused(sent: AdminSent, reason: string): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['recon_diff_id'], reason });
}

/** The 10403 of an account without payout.execute. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** The 10003 of a missing or wrong totp-tier step-up token. */
export function stepUpRequired(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10003, { tier: 'totp' });
}

/**
 * The difference after a write-off by `adminId` at the fixture's clock: status written_off,
 * handler, both instants the clock, resolution the stored keys plus w11 { withdrawal_id, paid_at,
 * operator } and (when given) the trimmed note; every other column as it was. Returns the row.
 */
export async function expectWrittenOff(
  f: WriteOffFixture,
  before: DiffRow,
  expected: {
    readonly adminId: string;
    readonly withdrawalId: string;
    readonly paidAtMs: number;
    readonly note?: string;
  },
): Promise<DiffRow> {
  const now = await f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('id', '=', before.id)
    .executeTakeFirstOrThrow();
  const resolution = now.resolution as Record<string, unknown> | null;
  expect(typeof resolution === 'object' && resolution !== null, JSON.stringify(resolution)).toBe(
    true,
  );
  const w11 = resolution!['w11'] as Record<string, unknown> | undefined;
  expect(Object.keys(w11 ?? {}).sort(), JSON.stringify(resolution)).toEqual([
    'operator',
    'paid_at',
    'withdrawal_id',
  ]);
  expect(w11!['withdrawal_id']).toBe(expected.withdrawalId);
  expect(w11!['operator']).toBe(expected.adminId);
  expect(typeof w11!['paid_at']).toBe('string');
  expect(Date.parse(w11!['paid_at'] as string)).toBe(expected.paidAtMs);
  expect(resolution).toEqual({
    ...(before.resolution as Record<string, unknown>),
    w11,
    ...(expected.note === undefined ? {} : { note: expected.note }),
  });
  expect(now).toEqual({
    ...before,
    status: 'written_off',
    handler_id: expected.adminId,
    closed_at: f.clock.now(),
    updated_at: f.clock.now(),
    resolution: now.resolution,
  });
  return now;
}

/** The withdrawal part of the response after W11 (paid_at as epoch milliseconds). */
export function paidView(
  w: Pick<Seeded, 'id' | 'outBizNo'>,
  paidAtMs: number,
  channelOrderId: string | null = channelOrderOf(w),
): Record<string, unknown> {
  return {
    withdrawal_id: w.id,
    status: 'PAID_API',
    paid_at: paidAtMs,
    channel_order_id: channelOrderId,
  };
}
