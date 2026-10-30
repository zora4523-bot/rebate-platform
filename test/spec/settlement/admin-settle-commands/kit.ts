// B2-09f rule-test kit (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml CT-24zd
// confirmAdminSettleBill (POST /admin/v1/settle-bills/{bill_id}/confirm),
// cancelAdminSettleBatchSchedule, rejectAdminSettleBatch, resumeAdminSettleBatch
// (POST /admin/v1/settle-batches/{batch_id}/cancel-schedule, /reject, /resume) and
// createAdminSettleSupplementBatches (POST /admin/v1/settle-bills/{bill_id}/supplement-batches):
// settle.bill, step-up tier totp, audit; 08 BR-FUND-04 ⑥ ⑧, 迁移表 SB2 / SB3 / SB4 / SB8; 编排裁定
// D10-444 (one confirmation covers every DRAFT of the bill), D10-440 (any DRAFT refuses a launch,
// data.reason=pending_draft), D10-437 ③ (row_version always in the response).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer),
// the batch command service, the supplement command, ledger's registerReconDiff and
// getAssetSnapshotStatus, content's configuration reader, commission's snapshot reads, PostgreSQL
// through @couli/db/testing as couli_app, Redis for the admin sessions (../../payment/orders/kit.ts
// suite).
// Synthetic: the settle_bills / settle_batches / settle_batch_items rows (../admin-settle-bills/kit.ts
// seeds), the orders, order_keys, order_settlements and commission snapshot rows a launch reads, the
// config_items switches, the asset_snapshots rows, admin accounts, and a one-shot fault in the
// entry's database handle (a Kysely plugin, as ../../ledger/admin-recon-write-off/kit.ts) for the
// roll-back cases. The totp step-up token is issued the way POST /admin/v1/auth/step-up issues it
// after a correct authenticator code (admin's createAdminStepUpTokens on the entry's Redis namespace
// admin-step-up). No real user or merchant data.
// Missing pieces fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type KyselyPlugin, type Selectable } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FixedClock,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  batchView,
  contractPaths,
  counts,
  normalize,
  type BatchRow,
  type Fixture,
  type ItemCounts,
} from '../admin-settle-bills/kit.ts';
import {
  appendVersion,
  fixture as snapshotFixture,
} from '../../commission/snapshot-read/fixtures.ts';

export {
  GENERATING,
  NOW,
  ago,
  billView,
  counts,
  fixture,
  inDetailOrder,
  later,
  normalize,
  seedBatch,
  seedBill,
  seedOrderItem,
  suite,
  type BatchRow,
  type BatchSeed,
  type BillRow,
  type Fixture,
} from '../admin-settle-bills/kit.ts';

export const CONFIRM_PATH = '/admin/v1/settle-bills/{bill_id}/confirm';
export const SUPPLEMENT_PATH = '/admin/v1/settle-bills/{bill_id}/supplement-batches';
export const CANCEL_PATH = '/admin/v1/settle-batches/{batch_id}/cancel-schedule';
export const REJECT_PATH = '/admin/v1/settle-batches/{batch_id}/reject';
export const RESUME_PATH = '/admin/v1/settle-batches/{batch_id}/resume';
export const DETAIL_PATH = '/admin/v1/settle-bills/{bill_id}';
/** specs/permissions.yaml: settle.bill (step-up tier totp) writes; fund.view only reads. */
export const BILL = 'settle.bill';
export const VIEW = 'fund.view';
/** The audit actions of the contract. */
export const CONFIRM_ACTION = 'settle_bill_confirm';
export const CANCEL_ACTION = 'settle_batch_cancel_schedule';
export const REJECT_ACTION = 'settle_batch_reject';
export const RESUME_ACTION = 'settle_batch_resume';
export const SUPPLEMENT_ACTION = 'settle_supplement_create';
/** The switches SB8 and a launch read (BR-FUND-04 ⑦ ⑨). */
export const AUTO_SWITCH = 'settle.auto.enabled';
export const creditSwitch = (platform: string): string => `credit.enabled.${platform}`;
/** Longer than content's cache of any configuration value (at most 60 seconds). */
const CONFIG_CACHE_MS = 61_000;
/** 1000 fen of union commission at 15% reserve: B_settle 850 fen, equal to the snapshot's base. */
const COMMISSION_FEN = 1000n;
const BASE_FEN = 850n;

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// Rows. Every value below is synthetic.

/** A config_items row of the app (the value as content stores it). */
export async function setSwitch(f: Fixture, key: string, value: unknown): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${f.appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'synthetic')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value,
      version = app.config_items.version + 1`.execute(f.db);
}

/** Moves the clock past content's cache, so a switch changed in the test is read as changed. */
export function pastConfigCache(f: Fixture): void {
  f.clock.set(new Date(f.clock.now().getTime() + CONFIG_CACHE_MS));
}

/** The asset_snapshots row of accounting day `day` (BR-FUND-18: complete). */
export async function seedAssetSnapshot(f: Fixture, day: string): Promise<void> {
  await f.db
    .insertInto('asset_snapshots')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      snapshot_date: day,
      total_available_positive_fen: 0n,
      total_negative_fen: 0n,
      total_frozen_fen: 0n,
      total_waiting_fen: 0n,
      total_estimated_fen: 0n,
      waiting_comparable: true,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
}

export interface OrderSeed {
  readonly platform?: string;
  readonly rebateStatus?: 'WAITING' | 'CREDITED';
  readonly settlePeriod?: string;
  readonly hold?: boolean;
  readonly rightsPending?: boolean;
  /** The union's settle commission (default 1000 fen, B_settle equal to the snapshot's base). */
  readonly commissionFen?: bigint;
}

export interface SeededOrder {
  readonly orderId: string;
  readonly subOrderId: string;
  readonly platform: string;
}

/**
 * One sub-order of the app as a bill or supplement run reads it: order_keys, orders, its commission
 * snapshot (base 850 fen, version 1) and one order_settlements row taken before the fixture's clock.
 * Default: WAITING for bill month 2026-09, a candidate of a run on that bill.
 */
export async function seedOrder(f: Fixture, seed: OrderSeed = {}): Promise<SeededOrder> {
  const platform = seed.platform ?? 'taobao';
  const at = new Date(f.clock.now().getTime() - 40 * 86_400_000);
  const snapshot = snapshotFixture();
  const orderId = randomUUID();
  const subOrderId = `synthetic-${orderId}`;
  snapshot.input = { appId: f.appId, orderId, commissionVersion: 1 };
  await f.db
    .insertInto('order_keys')
    .values({
      app_id: f.appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: at,
    })
    .execute();
  // One published rule version per effective time of the app: later orders share the first.
  const published = await f.db
    .selectFrom('commission_rule_versions')
    .select('rule_version_id')
    .where('app_id', '=', f.appId)
    .where('status', '=', 'published')
    .where('effective_from', '=', snapshot.ruleEffectiveFrom)
    .executeTakeFirst();
  if (published === undefined) {
    await f.db
      .insertInto('commission_rule_versions')
      .values({
        app_id: f.appId,
        rule_version_id: snapshot.ruleVersionId,
        status: 'published',
        effective_from: snapshot.ruleEffectiveFrom,
        indirect_enabled: true,
        created_at: at,
      })
      .execute();
  } else {
    snapshot.ruleVersionId = published.rule_version_id;
  }
  await f.db
    .insertInto('commission_splits')
    .values({
      app_id: f.appId,
      order_id: orderId,
      rule_version_id: snapshot.ruleVersionId,
      order_type: 'self',
      activity_type: null,
      rebate_mode: null,
      paid_at: at,
      paid_at_source: 'platform',
      raw_n_fen: COMMISSION_FEN,
      subsidy_commission_fen: 0n,
      reserve_bp: 1500,
      reserve_fen: 150n,
      tlj_deduct_fen: 0n,
      base_fen: BASE_FEN,
      platform_retain_fen: 298n,
      beneficiaries: JSON.stringify(
        snapshot.people.map((p) => ({
          user_id: p.userId,
          role: p.role,
          ratio_bp: p.ratioBp,
          level: p.level,
          initial_status: p.initialStatus,
          forfeit_reason: p.forfeitReason,
        })),
      ),
      created_at: at,
    })
    .execute();
  await appendVersion(f.db, snapshot, 1, BASE_FEN, COMMISSION_FEN, [425n, 85n, 42n], 552n, at);
  const commission = seed.commissionFen ?? COMMISSION_FEN;
  await f.db
    .insertInto('orders')
    .values({
      app_id: f.appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      raw_item_id: 'synthetic-item',
      platform_status: 'SETTLED',
      rebate_status: seed.rebateStatus ?? 'WAITING',
      hold: seed.hold ?? false,
      rights_pending: seed.rightsPending ?? false,
      commission_version: 1,
      attr_at: at,
      settle_period: seed.settlePeriod ?? '2026-09',
      settle_commission_fen: commission,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await f.db
    .insertInto('order_settlements')
    .values({
      app_id: f.appId,
      order_id: orderId,
      seq: 1,
      source: 'API',
      settle_commission_fen: commission,
      settled_at: at,
      created_at: at,
      content_hash: randomUUID(),
    })
    .execute();
  return { orderId, subOrderId, platform };
}

/** An open first_credit obligation on `order` (a beneficiary make-up item of a run, ⑫). */
export async function seedObligation(f: Fixture, order: SeededOrder): Promise<string> {
  const userId = randomUUID();
  const creditId = randomUUID();
  await f.db
    .insertInto('users')
    .values({
      id: userId,
      app_id: f.appId,
      nickname: 'synthetic',
      avatar: '',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      status: 'normal',
      register_method: 'phone',
    })
    .execute();
  await f.db
    .insertInto('beneficiary_credits')
    .values({
      beneficiary_credit_id: creditId,
      app_id: f.appId,
      order_id: order.orderId,
      user_id: userId,
      role: 'self',
      kind: 'first_credit',
      opened_by: 'R5',
      opened_ref: `synthetic-credit-${order.orderId}`,
      split_ref: 'synthetic-attribution-v1',
      status: 'open',
      opened_at: f.clock.now(),
      created_at: f.clock.now(),
    })
    .execute();
  return creditId;
}

/** An order row of `batch` on the seeded order: what a reject and a resume must leave alone. */
export async function seedItemOf(f: Fixture, batch: BatchRow, order: SeededOrder): Promise<void> {
  await f.db
    .insertInto('settle_batch_items')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      batch_id: batch.batch_id,
      item_type: 'order',
      order_id: order.orderId,
      user_id: null,
      role: null,
      beneficiary_credit_id: null,
      settle_seq: 1,
      b_settle_fen: BASE_FEN,
      amount_fen: null,
      result: null,
      skip_reason: null,
      created_at: batch.created_at,
    })
    .execute();
}

/** One settle_batches row as it is now. */
export async function batchNow(f: Fixture, batch: BatchRow): Promise<BatchRow> {
  const row = await f.db
    .selectFrom('settle_batches')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('batch_id', '=', batch.batch_id)
    .executeTakeFirst();
  expect(row, `settle_batches ${batch.batch_id}`).toBeDefined();
  return row!;
}

/** Every settle_batches row of the app, by batch_id. */
export function allBatches(f: Fixture): Promise<BatchRow[]> {
  return f.db
    .selectFrom('settle_batches')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('batch_id')
    .execute();
}

/** Every settle_batch_items row of the app's given batches, by id. */
export function itemsOf(f: Fixture, batchIds: readonly string[]) {
  return f.db
    .selectFrom('settle_batch_items')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('batch_id', 'in', batchIds)
    .orderBy('id')
    .execute();
}

/** Every recon_diffs row of the app, by id. */
export function allDiffs(f: Fixture) {
  return f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

export type AuditRow = Selectable<DB['audit_logs']>;

/** The audit records of the app, in insertion order; only `action` when given. */
export function audits(f: Fixture, action?: string): Promise<AuditRow[]> {
  let query = f.db.selectFrom('audit_logs').selectAll().where('app_id', '=', f.appId);
  if (action !== undefined) query = query.where('action', '=', action);
  return query.orderBy('id').execute();
}

/** The idempotency records of the app. */
export function idempotencyRows(f: Fixture) {
  return f.db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

/**
 * Everything of the app a batch command or a launch may touch: bills, batches, items, orders,
 * settlement jobs, differences, vouchers, balances, audit records, idempotency records.
 */
export async function everything(f: Fixture) {
  return {
    bills: await f.db
      .selectFrom('settle_bills')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('bill_id')
      .execute(),
    batches: await allBatches(f),
    items: await f.db
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    orders: await f.db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('order_id')
      .execute(),
    jobs: await f.db
      .selectFrom('settle_jobs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    diffs: await allDiffs(f),
    vouchers: await f.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('uniq_key')
      .execute(),
    balances: await f.db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('account_id')
      .execute(),
    audits: await audits(f),
    idempotency: await idempotencyRows(f),
  };
}

// ---------------------------------------------------------------------------------------------
// A row lock held from a second connection, and requests waiting on it.

export interface HeldLock {
  release(): Promise<void>;
}

/** Holds `SELECT … FOR UPDATE` on the app's bill row from the suite's one-connection pool. */
export async function holdBill(f: Fixture, billId: string): Promise<HeldLock> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = f.s
    .holder()
    .transaction()
    .execute(async (trx) => {
      const rows = await sql`SELECT bill_id FROM app.settle_bills
        WHERE app_id = ${f.appId} AND bill_id = ${billId} FOR UPDATE`.execute(trx);
      expect(rows.rows, `settle_bills ${billId}`).toHaveLength(1);
      locked();
      await gate;
    });
  await Promise.race([ready, done]);
  return {
    async release() {
      open();
      await done;
    },
  };
}

export interface Tracked<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
}

/** A request whose completion can be looked at while it runs. */
export function track<T>(promise: Promise<T>): Tracked<T> {
  const state = { settled: false };
  const watched = promise.finally(() => {
    state.settled = true;
  });
  return {
    promise: watched,
    get settled() {
      return state.settled;
    },
  };
}

/**
 * True once at least `count` backends of the test database wait on a lock; false when one of the
 * requests ended first or after the timeout (the caller asserts).
 */
export async function waiting(
  f: Fixture,
  count: number,
  pending: readonly Tracked<unknown>[],
  timeoutMs = 10_000,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(f.db);
    if (Number(result.rows[0]?.n ?? '0') >= count) return true;
    if (pending.some((request) => request.settled)) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the entry's database handle.

export interface Fault {
  /** One-shot: set it, the next INSERT of an audit record of this action fails, back to null. */
  action: string | null;
  tripped: number;
}

function faultPlugin(fault: Fault): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  return {
    transformQuery({ node, queryId }) {
      const action = fault.action;
      if (action === null) return node;
      const compiled = compiler.compileQuery(node, queryId);
      const hit =
        /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?audit_logs\b/i.test(compiled.sql) &&
        (compiled.sql.includes(action) || JSON.stringify(compiled.parameters).includes(action));
      if (hit) {
        fault.action = null;
        fault.tripped += 1;
        throw new Error(`synthetic failure at the audit record ${action}`);
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

export type Operation =
  'confirm' | 'cancelSchedule' | 'reject' | 'resume' | 'supplement' | 'detail';

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

export interface CommandOptions {
  /** The caller: `biller` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
  /** Idempotency-Key of a launch: a fresh one by default; null sends none. */
  readonly key?: string | null;
}

export interface CommandsAdmin {
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier totp by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/settle-bills/{bill_id}/confirm with the JSON body. */
  confirm(billId: string, body: unknown, options?: CommandOptions): Promise<AdminSent>;
  /** POST /admin/v1/settle-batches/{batch_id}/cancel-schedule with the JSON body. */
  cancelSchedule(batchId: string, body: unknown, options?: CommandOptions): Promise<AdminSent>;
  /** POST /admin/v1/settle-batches/{batch_id}/reject with the JSON body. */
  reject(batchId: string, body: unknown, options?: CommandOptions): Promise<AdminSent>;
  /** POST /admin/v1/settle-batches/{batch_id}/resume with the JSON body. */
  resume(batchId: string, body: unknown, options?: CommandOptions): Promise<AdminSent>;
  /** POST /admin/v1/settle-bills/{bill_id}/supplement-batches with the JSON body. */
  supplement(billId: string, body: unknown, options?: CommandOptions): Promise<AdminSent>;
  /** GET /admin/v1/settle-bills/{bill_id} as `biller` unless given. */
  detail(billId: string, caller?: AdminCaller): Promise<AdminSent>;
  /** The bill_id → status of GET /admin/v1/settle-bills as `biller`. */
  listed(): Promise<Record<string, unknown>>;
  /** An account with settle.bill only. */
  readonly biller: AdminCaller;
  /** An account with fund.view only. */
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
  return `sb_${randomBytes(12).toString('hex')}`;
}

/**
 * Runs `run` against a started admin entry on the fixture's database (through the fault plugin),
 * clock and Redis.
 */
export async function withCommandsAdmin(f: Fixture, run: (h: CommandsAdmin) => Promise<void>) {
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
  const dir = mkdtempSync(join(base, 'b2-09f-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { action: null, tripped: 0 };
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
        JWT_KEY_ID: 'b2_09f_test',
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
    const caller: CommandsAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `sbcmd_${id}`,
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
    const stepUp: CommandsAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const biller = await caller([BILL]);
    const viewer = await caller([VIEW]);
    const sent = (op: Operation, response: { statusCode: number; body: string }): AdminSent => ({
      op,
      statusCode: response.statusCode,
      body: response.body,
      json: () => JSON.parse(response.body) as Envelope,
    });
    const post = async (
      op: Operation,
      url: string,
      body: unknown,
      options: CommandOptions = {},
    ): Promise<AdminSent> => {
      const who = options.caller === undefined ? biller : options.caller;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-trace-id': randomUUID(),
      };
      if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
      if (op === 'supplement' && options.key !== null) {
        headers['idempotency-key'] = options.key ?? newKey();
      }
      const token =
        options.stepUp !== undefined ? options.stepUp : who === null ? null : await stepUp(who);
      if (token !== null) headers['x-step-up-token'] = token;
      return sent(
        op,
        await server.inject({
          method: 'POST',
          url,
          headers,
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        }),
      );
    };
    const get = (url: string, who: AdminCaller) =>
      server.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${who.token}`, 'x-trace-id': randomUUID() },
        remoteAddress: '127.0.0.1',
      });
    const bills = (billId: string) => `/admin/v1/settle-bills/${encodeURIComponent(billId)}`;
    const batches = (batchId: string) => `/admin/v1/settle-batches/${encodeURIComponent(batchId)}`;
    await run({
      fault,
      caller,
      stepUp,
      biller,
      viewer,
      confirm: (billId, body, options) =>
        post('confirm', `${bills(billId)}/confirm`, body, options),
      cancelSchedule: (batchId, body, options) =>
        post('cancelSchedule', `${batches(batchId)}/cancel-schedule`, body, options),
      reject: (batchId, body, options) =>
        post('reject', `${batches(batchId)}/reject`, body, options),
      resume: (batchId, body, options) =>
        post('resume', `${batches(batchId)}/resume`, body, options),
      supplement: (billId, body, options) =>
        post('supplement', `${bills(billId)}/supplement-batches`, body, options),
      async detail(billId, who) {
        return sent('detail', await get(bills(billId), who ?? biller));
      },
      async listed() {
        const response = await get('/admin/v1/settle-bills?page_size=200', biller);
        expect(response.statusCode, response.body).toBe(200);
        const body = JSON.parse(response.body) as {
          data: { items: { bill_id: string; status: unknown }[] };
        };
        return Object.fromEntries(body.data.items.map((row) => [row.bill_id, row.status]));
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
  confirm: { path: CONFIRM_PATH, method: 'post' },
  cancelSchedule: { path: CANCEL_PATH, method: 'post' },
  reject: { path: REJECT_PATH, method: 'post' },
  resume: { path: RESUME_PATH, method: 'post' },
  supplement: { path: SUPPLEMENT_PATH, method: 'post' },
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

/** The 10403 of an account without settle.bill. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** The 10003 of a missing or wrong totp-tier step-up token. */
export function stepUpRequired(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10003, { tier: 'totp' });
}

/** The 20902 of a batch out of date or of a set that is not the bill's DRAFT batches. */
export function conflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'settle_batch' });
}

/** The 20001 naming these fields, with the guard's reason when given. */
export function refused(
  sent: AdminSent,
  fields: readonly string[],
  reason?: string,
): Promise<Envelope> {
  return answer(sent, 20001, reason === undefined ? { fields } : { fields, reason });
}

/** The `expected_batches` of these batches as a detail shows them. */
export function expected(batches: readonly BatchRow[]) {
  return batches.map((batch) => ({
    batch_id: batch.batch_id,
    expected_row_version: batch.row_version,
  }));
}

/** The body of cancel-schedule and resume for this batch. */
export function versionOf(batch: BatchRow) {
  return { expected_row_version: batch.row_version };
}

/** The AdminSettleBatch a stored row must be shown as, row_version included. */
export function shown(
  row: BatchRow,
  inCurrentRound: boolean,
  itemCounts: ItemCounts = counts(),
): Record<string, unknown> {
  return { ...batchView(row, inCurrentRound, itemCounts), row_version: row.row_version };
}

/** The data of a successful bill response, its instants as epoch milliseconds. */
export async function billOf(sent: AdminSent): Promise<Record<string, unknown>> {
  const data = normalize((await answer(sent, 0)).data);
  expect(typeof data === 'object' && data !== null, sent.body).toBe(true);
  return data as Record<string, unknown>;
}

/** The batches of a successful bill response. */
export async function batchesOf(sent: AdminSent): Promise<Record<string, unknown>[]> {
  const batches = (await billOf(sent))['batches'];
  expect(Array.isArray(batches), sent.body).toBe(true);
  return batches as Record<string, unknown>[];
}

export interface Launched {
  readonly bill_id: unknown;
  readonly platform: unknown;
  readonly outcome: unknown;
  readonly batch_ids: string[];
}

/** The data of a successful launch: exactly bill_id, platform, outcome and batch_ids. */
export async function launched(sent: AdminSent): Promise<Launched> {
  const data = (await answer(sent, 0)).data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual([
    'batch_ids',
    'bill_id',
    'outcome',
    'platform',
  ]);
  return data as unknown as Launched;
}

/** The record's target, before and after as one text. */
export function auditText(record: AuditRow): string {
  return JSON.stringify([record.target, record.before, record.after]);
}

/** The instants written in a text, as epoch milliseconds (the contract fixes no zone). */
export function instantsIn(text: string): number[] {
  const iso = /\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})/g;
  return [...text.matchAll(iso)].map((match) => Date.parse(match[0]));
}

/** The one audit record of `action`, by `adminId` at the fixture's clock. */
export async function oneAudit(f: Fixture, action: string, adminId: string): Promise<AuditRow> {
  const records = await audits(f, action);
  expect(records, action).toHaveLength(1);
  const record = records[0]!;
  expect(record.admin_id).toBe(adminId);
  expect(record.at).toEqual(f.clock.now());
  return record;
}
