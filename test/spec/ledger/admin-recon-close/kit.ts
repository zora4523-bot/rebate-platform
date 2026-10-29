// B2-09b rule-test kit (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// closeAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/close: fund.recon, no step-up,
// Idempotency-Key; only open / processing diffs of source R1–R3; status closed, handler_id the
// caller, closed_at = updated_at = the server clock, resolution.reason the trimmed reason; every
// unreleased withdraw_holds row whose source is the diff released in the same transaction;
// released_hold_count; audit recon_diff_close) and 08 BR-FUND-19 (差错单关闭时解除冻结记录), BR-WDR-05
// (冻结记录逐条解除, 新增和解除都记审计, 与 BR-WDR-07 一样先锁 users 行).
// Conventions from the task brief (编排核定 2026-10-29): the source of a diff's hold is
// source_ref = `recon_diff:<recon_diffs.id>` (the existing writer B2-07c), matched exactly; no
// step-up; each released hold gets its own withdraw_hold.release audit record.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation, PostgreSQL idempotency, the audit writer), PostgreSQL through
// @couli/db/testing as couli_app, Redis for the admin sessions (../../payment/orders/kit.ts suite).
// Synthetic: the recon_diffs rows (../admin-recon-diffs/kit.ts seedDiff), users and withdraw_holds
// rows written directly as the reconciliation would have left them (couli_app may INSERT), admin
// accounts, and a one-shot fault in the entry's database handle (a Kysely plugin, as
// ../../payment/refund/kit.ts) for the roll-back cases. No real user or merchant data.
// Missing pieces fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Insertable, type KyselyPlugin, type Selectable } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
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
import { user } from '../../payment/orders/kit.ts';
import { contractPaths, normalize, type DiffRow, type Fixture } from '../admin-recon-diffs/kit.ts';

export {
  DETAIL_KEYS,
  NOW,
  ago,
  allDiffs,
  contractPaths,
  detailView,
  fixture,
  normalize,
  seedDiff,
  suite,
  type DiffRow,
  type Fixture,
} from '../admin-recon-diffs/kit.ts';

export const CLOSE_PATH = '/admin/v1/recon-diffs/{recon_diff_id}/close';
export const DETAIL_PATH = '/admin/v1/recon-diffs/{recon_diff_id}';
/** specs/permissions.yaml: fund.recon (step-up null) closes; fund.view only reads. */
export const RECON = 'fund.recon';
export const VIEW = 'fund.view';
/** The audit action of the contract (closeAdminReconDiff). */
export const CLOSE_ACTION = 'recon_diff_close';
/** payout's audit action of one released hold (application/withdraw-holds.ts). */
export const RELEASE_ACTION = 'withdraw_hold.release';

const ROOT = new URL('../../../../', import.meta.url);

/** The source_ref of a hold whose source is the diff (B2-07c's writer, matched exactly). */
export function sourceOf(diffId: string): string {
  return `recon_diff:${diffId}`;
}

/** A trimmed reason text of `n` CJK characters (one UTF-16 unit and one code point each). */
export function chars(n: number): string {
  return '差'.repeat(n);
}

// ---------------------------------------------------------------------------------------------
// Users and holds.

export type HoldRow = Selectable<DB['withdraw_holds']>;

/** A synthetic member of the fixture's app (or `appId`). */
export function member(f: Fixture, appId = f.appId): Promise<string> {
  return user(f.db, appId, f.clock);
}

export type HoldSeed = Partial<Insertable<DB['withdraw_holds']>> & { readonly user_id: string };

/** A withdraw_holds row written directly (unreleased, no expiry unless patched). */
export async function seedHold(f: Fixture, patch: HoldSeed): Promise<HoldRow> {
  const id = patch.id ?? randomUUID();
  const appId = patch.app_id ?? f.appId;
  await f.db
    .insertInto('withdraw_holds')
    .values({
      app_id: appId,
      reason: 'recon_diff',
      source_ref: null,
      created_by: 'payout_recon',
      created_at: new Date(f.clock.now().getTime() - 90 * 60_000),
      hold_until: null,
      released_at: null,
      released_by: null,
      ...patch,
      id,
    })
    .execute();
  const row = await f.db
    .selectFrom('withdraw_holds')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `withdraw_holds ${id}`).toBeDefined();
  return row!;
}

/** Every withdraw_holds row of the app (or `appId`), by id. */
export function allHolds(f: Fixture, appId = f.appId): Promise<HoldRow[]> {
  return f.db
    .selectFrom('withdraw_holds')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

/** One withdraw_holds row as it is now. */
export async function holdNow(f: Fixture, hold: HoldRow): Promise<HoldRow> {
  const row = await f.db
    .selectFrom('withdraw_holds')
    .selectAll()
    .where('app_id', '=', hold.app_id)
    .where('id', '=', hold.id)
    .executeTakeFirst();
  expect(row, `withdraw_holds ${hold.id}`).toBeDefined();
  return row!;
}

/** One recon_diffs row of the app as it is now. */
export async function diffNow(f: Fixture, id: string): Promise<DiffRow> {
  const row = await f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `recon_diffs ${id}`).toBeDefined();
  return row!;
}

/** The hold after a release by `adminId` at the fixture's clock (nothing else changes). */
export function releasedBy(f: Fixture, hold: HoldRow, adminId: string): HoldRow {
  return { ...hold, released_at: f.clock.now(), released_by: adminId };
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

/** The number of ledger vouchers of the app (closing posts nothing). */
export async function voucherCount(f: Fixture): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.ledger_vouchers WHERE app_id = ${f.appId}`.execute(f.db);
  return Number(result.rows[0]?.n ?? '0');
}

// ---------------------------------------------------------------------------------------------
// Row locks held from a second connection, and requests waiting on them.

export interface HeldLock {
  release(): Promise<void>;
}

/** Holds `SELECT … FOR UPDATE` on one row of the app from the suite's one-connection pool. */
export async function holdRow(
  f: Fixture,
  table: 'recon_diffs' | 'users',
  id: string,
): Promise<HeldLock> {
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
      const rows =
        table === 'recon_diffs'
          ? await sql`SELECT id FROM app.recon_diffs
              WHERE app_id = ${f.appId} AND id = ${id} FOR UPDATE`.execute(trx)
          : await sql`SELECT id FROM app.users
              WHERE app_id = ${f.appId} AND id = ${id} FOR UPDATE`.execute(trx);
      expect(rows.rows, `${table} ${id}`).toHaveLength(1);
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

/**
 * Where the next failure is thrown: the UPDATE of withdraw_holds, the UPDATE of recon_diffs, the
 * INSERT of a withdraw_hold.release audit record, or the INSERT of the recon_diff_close record.
 */
export type FaultPoint = 'hold_update' | 'diff_update' | 'hold_audit' | 'close_audit';
export const FAULT_POINTS: readonly FaultPoint[] = [
  'hold_update',
  'diff_update',
  'hold_audit',
  'close_audit',
];

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  tripped: number;
}

function serialized(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ) ?? ''
  );
}

function rawText(node: Record<string, unknown>): string {
  const fragments = node['sqlFragments'];
  return Array.isArray(fragments) ? fragments.join(' ') : '';
}

function updates(node: Record<string, unknown>, table: string): boolean {
  if (node['kind'] === 'UpdateQueryNode') return serialized(node['table']).includes(`"${table}"`);
  if (node['kind'] !== 'RawNode') return false;
  return new RegExp(`update\\s+(?:"?app"?\\s*\\.\\s*)?"?${table}\\b`, 'i').test(rawText(node));
}

function audited(node: Record<string, unknown>, action: string): boolean {
  const into =
    node['kind'] === 'InsertQueryNode'
      ? serialized(node['into']).includes('"audit_logs"')
      : node['kind'] === 'RawNode' &&
        /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?audit_logs\b/i.test(rawText(node));
  return into && serialized(node).includes(JSON.stringify(action));
}

function faultPlugin(fault: Fault): KyselyPlugin {
  return {
    transformQuery({ node }) {
      const point = fault.point;
      if (point === null) return node;
      const plain = node as unknown as Record<string, unknown>;
      const hit =
        point === 'hold_update'
          ? updates(plain, 'withdraw_holds')
          : point === 'diff_update'
            ? updates(plain, 'recon_diffs')
            : audited(plain, point === 'hold_audit' ? RELEASE_ACTION : CLOSE_ACTION);
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

export type Operation = 'close' | 'detail';

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
}

export interface CloseOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: `recon` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
}

export interface CloseAdmin {
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** POST /admin/v1/recon-diffs/{recon_diff_id}/close with the JSON body. */
  close(reconDiffId: string, body: unknown, options?: CloseOptions): Promise<AdminSent>;
  /** GET /admin/v1/recon-diffs/{recon_diff_id} as `recon`. */
  detail(reconDiffId: string): Promise<AdminSent>;
  /** An account with fund.recon only. */
  readonly recon: AdminCaller;
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
  return `rc_${randomBytes(12).toString('hex')}`;
}

/** The concrete path of the close of a diff (also the idempotency scope's path). */
export function closePath(reconDiffId: string): string {
  return `/admin/v1/recon-diffs/${encodeURIComponent(reconDiffId)}/close`;
}

/**
 * Runs `run` against a started admin entry on the fixture's database (through the fault plugin),
 * clock and Redis.
 */
export async function withCloseAdmin(f: Fixture, run: (h: CloseAdmin) => Promise<void>) {
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
  const dir = mkdtempSync(join(base, 'b2-09b-'));
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
        JWT_KEY_ID: 'b2_09b_test',
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
    const caller: CloseAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `close_${id}`,
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
      return { id, token };
    };
    const recon = await caller([RECON]);
    const viewer = await caller([VIEW]);
    const sent = (op: Operation, response: { statusCode: number; body: string }): AdminSent => ({
      op,
      statusCode: response.statusCode,
      body: response.body,
      json: () => JSON.parse(response.body) as Envelope,
    });
    await run({
      fault,
      caller,
      recon,
      viewer,
      async close(reconDiffId, body, options = {}) {
        const who = options.caller === undefined ? recon : options.caller;
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-trace-id': randomUUID(),
        };
        if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
        if (options.key !== null) headers['idempotency-key'] = options.key ?? newKey();
        const response = await server.inject({
          method: 'POST',
          url: closePath(reconDiffId),
          headers,
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        });
        return sent('close', response);
      },
      async detail(reconDiffId) {
        const response = await server.inject({
          method: 'GET',
          url: `/admin/v1/recon-diffs/${encodeURIComponent(reconDiffId)}`,
          headers: { authorization: `Bearer ${recon.token}`, 'x-trace-id': randomUUID() },
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
  close: { path: CLOSE_PATH, method: 'post' },
  detail: { path: DETAIL_PATH, method: 'get' },
};

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
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

export interface Closed {
  /** data.recon_diff, its instants as epoch milliseconds. */
  readonly recon_diff: Record<string, unknown>;
  readonly released_hold_count: unknown;
}

/** The data of a successful close: exactly recon_diff and released_hold_count. */
export async function closed(sent: AdminSent): Promise<Closed> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual(['recon_diff', 'released_hold_count']);
  return {
    recon_diff: normalize(data['recon_diff']),
    released_hold_count: data['released_hold_count'],
  };
}

/** The 20902 of a diff that is no longer open or processing. */
export function conflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'recon_diff' });
}

/** The 10403 of an account without fund.recon. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** The data of a successful detail response, its instants as epoch milliseconds. */
export async function detailOf(sent: AdminSent): Promise<Record<string, unknown>> {
  return normalize((await answer(sent, 0)).data);
}

/**
 * The row after a close by `adminId` at the fixture's clock: status closed, handler, both instants
 * the clock, resolution an object whose `reason` is the trimmed reason; every other column as it
 * was. Returns the row as it is now.
 */
export async function expectClosed(
  f: Fixture,
  before: DiffRow,
  adminId: string,
  reason: string,
): Promise<DiffRow> {
  const now = await diffNow(f, before.id);
  const resolution = now.resolution as Record<string, unknown> | null;
  expect(typeof resolution === 'object' && resolution !== null, JSON.stringify(resolution)).toBe(
    true,
  );
  expect(resolution!['reason']).toBe(reason);
  expect(now).toEqual({
    ...before,
    status: 'closed',
    handler_id: adminId,
    closed_at: f.clock.now(),
    updated_at: f.clock.now(),
    resolution: now.resolution,
  });
  return now;
}
