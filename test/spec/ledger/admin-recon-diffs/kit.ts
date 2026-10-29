// B2-09a rule-test kit (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// listAdminReconDiffs (GET /admin/v1/recon-diffs) and getAdminReconDiff
// (GET /admin/v1/recon-diffs/{recon_diff_id}) — fund.recon or fund.view, read only, no step-up;
// only recon_diffs of source R1–R3 of the caller's app; filters type / source / status /
// period_from / period_to (inclusive, string order) / ref_id (exact); created_at then recon_diff_id
// descending; page_size ≤ 200; 20001 data.fields; reading writes no audit record (08 BR-FUND-22
// 差错单, 04 §3.2 recon_diffs).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation), PostgreSQL through @couli/db/testing as couli_app, Redis for the admin
// sessions (../../payment/orders/kit.ts suite). Synthetic: the recon_diffs rows (written directly,
// as any reconciliation would have registered them; couli_app may INSERT) and the admin accounts.
// No real user or merchant data. Missing pieces fail as assertions (an unregistered admin route
// answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type Selectable } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
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
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { Suite } from '../../payment/orders/kit.ts';

export { suite } from '../../payment/orders/kit.ts';

export const NOW = '2026-10-29T08:00:00.000Z';
export const MINUTE = 60_000;
export const LIST_PATH = '/admin/v1/recon-diffs';
export const DETAIL_PATH = '/admin/v1/recon-diffs/{recon_diff_id}';
/** specs/permissions.yaml: both read points, step-up null. */
export const RECON = 'fund.recon';
export const VIEW = 'fund.view';

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// One app on the suite's database.

export interface Fixture {
  readonly s: Suite;
  readonly db: Kysely<DB>;
  readonly clock: FixedClock;
  readonly appId: string;
}

export function fixture(s: Suite, instant = NOW): Fixture {
  return {
    s,
    db: s.db(),
    clock: new FixedClock(instant),
    appId: `recon_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
  };
}

/** An instant `minutes` before the fixture's clock. */
export function ago(f: Fixture, minutes: number): Date {
  return new Date(f.clock.now().getTime() - minutes * MINUTE);
}

export type DiffRow = Selectable<DB['recon_diffs']>;

/** A JSON object as stored in recon_diffs.resolution. */
export type Resolution = Record<string, unknown>;

export type DiffSeed = Partial<Omit<Insertable<DB['recon_diffs']>, 'resolution'>> & {
  readonly resolution?: Resolution | null;
};

/** A recon_diffs row of the fixture's app (or `patch.app_id`) written directly. */
export async function seedDiff(f: Fixture, patch: DiffSeed = {}): Promise<DiffRow> {
  const id = patch.id ?? randomUUID();
  const appId = patch.app_id ?? f.appId;
  const now = f.clock.now();
  const { resolution, ...rest } = patch;
  await f.db
    .insertInto('recon_diffs')
    .values({
      app_id: appId,
      type: 'ledger_mismatch',
      source: 'R3',
      period: '2026-10-28',
      ref_type: 'account',
      ref_id: randomUUID(),
      expected_fen: 12_000n,
      actual_fen: 11_800n,
      diff_fen: 200n,
      status: 'open',
      handler_id: null,
      closed_at: null,
      dedupe_key: null,
      created_at: now,
      updated_at: now,
      ...rest,
      resolution:
        resolution === undefined || resolution === null
          ? null
          : sql<DiffRow['resolution']>`${JSON.stringify(resolution)}::jsonb`,
      id,
    })
    .execute();
  const row = await f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `recon_diffs ${id}`).toBeDefined();
  return row!;
}

/** Every recon_diffs row of the app, by id (reads must leave them as they were). */
export function allDiffs(f: Fixture): Promise<DiffRow[]> {
  return f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

/** Every audit record of the app (reading writes none). */
export function allAudits(f: Fixture) {
  return f.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Expected shapes.

/** The required keys of the contract's AdminReconDiff (additionalProperties false). */
export const LIST_KEYS = [
  'actual_fen',
  'closed_at',
  'created_at',
  'diff_fen',
  'expected_fen',
  'period',
  'recon_diff_id',
  'ref_id',
  'ref_type',
  'source',
  'status',
  'type',
] as const;

/** The required keys of the contract's AdminReconDiffDetail (additionalProperties false). */
export const DETAIL_KEYS = [...LIST_KEYS, 'handler_id', 'resolution', 'updated_at'].sort();

const INSTANTS = ['created_at', 'closed_at', 'updated_at'] as const;

/** The AdminReconDiff a row must be shown as (instants as epoch milliseconds). */
export function listView(row: DiffRow): Record<string, unknown> {
  return {
    recon_diff_id: row.id,
    source: row.source,
    type: row.type,
    period: row.period,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    expected_fen: Number(row.expected_fen),
    actual_fen: Number(row.actual_fen),
    diff_fen: Number(row.diff_fen),
    status: row.status,
    created_at: row.created_at.getTime(),
    closed_at: row.closed_at === null ? null : row.closed_at.getTime(),
  };
}

/** The AdminReconDiffDetail a row must be shown as (instants as epoch milliseconds). */
export function detailView(row: DiffRow): Record<string, unknown> {
  return {
    ...listView(row),
    handler_id: row.handler_id,
    updated_at: row.updated_at.getTime(),
    resolution: row.resolution,
  };
}

/** A response item with its date-time strings turned into epoch milliseconds. */
export function normalize(item: unknown): Record<string, unknown> {
  expect(typeof item === 'object' && item !== null, JSON.stringify(item)).toBe(true);
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const key of INSTANTS) {
    const value = out[key];
    if (typeof value === 'string') out[key] = Date.parse(value);
  }
  return out;
}

/** Rows newest first: created_at descending, then id descending (uuid order = hex text order). */
export function newestFirst(rows: readonly DiffRow[]): DiffRow[] {
  return [...rows].sort((a, b) => {
    const at = b.created_at.getTime() - a.created_at.getTime();
    if (at !== 0) return at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'list' | 'detail';

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

export interface ReconAdmin {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** GET /admin/v1/recon-diffs with the query parameters, as `recon` unless given (null: no token). */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
  /** GET /admin/v1/recon-diffs/{recon_diff_id}, as `recon` unless given (null: no token). */
  detail(reconDiffId: string, caller?: AdminCaller | null): Promise<AdminSent>;
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
    method: 'GET';
    url: string;
    headers: Record<string, string>;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withReconAdmin(f: Fixture, run: (h: ReconAdmin) => Promise<void>) {
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
  const dir = mkdtempSync(join(base, 'b2-09a-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
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
        JWT_KEY_ID: 'b2_09a_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const caller: ReconAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `recon_${id}`,
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
    const send = async (
      op: Operation,
      url: string,
      who: AdminCaller | null | undefined,
    ): Promise<AdminSent> => {
      const actor = who === undefined ? recon : who;
      const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
      if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
      const response = await server.inject({
        method: 'GET',
        url,
        headers,
        remoteAddress: '127.0.0.1',
      });
      return {
        op,
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    await run({
      caller,
      recon,
      viewer,
      list(query, who) {
        const text = new URLSearchParams(query ?? {}).toString();
        return send('list', text === '' ? LIST_PATH : `${LIST_PATH}?${text}`, who);
      },
      detail(reconDiffId, who) {
        return send('detail', `${LIST_PATH}/${encodeURIComponent(reconDiffId)}`, who);
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

export interface ContractOperation {
  readonly operationId?: string;
  readonly 'x-implementation'?: string;
  readonly 'x-auth'?: string;
  readonly 'x-error-codes'?: readonly number[];
  readonly responses: Record<
    string,
    { readonly content?: Record<string, { readonly schema: JsonSchema }> }
  >;
}
type ContractPaths = Record<string, Record<string, ContractOperation>>;
let contractPromise: Promise<ContractPaths> | undefined;

/** The dereferenced paths of contracts/openapi.yaml. */
export function contractPaths(): Promise<ContractPaths> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<{ paths: ContractPaths }>;
  };
  contractPromise ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then((document) => document.paths);
  return contractPromise;
}

const PATHS: Record<Operation, string> = { list: LIST_PATH, detail: DETAIL_PATH };

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10403: 403,
  20001: 400,
};

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const path = PATHS[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.['get']?.responses[status]?.content?.[
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

export interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** The page of a successful list response. */
export async function page(sent: AdminSent): Promise<Page> {
  const body = await answer(sent, 0);
  const data = body.data;
  expect(typeof data === 'object' && data !== null, sent.body).toBe(true);
  expect(Array.isArray((data as Record<string, unknown>)['items']), sent.body).toBe(true);
  return data as Page;
}

/** The recon_diff_id of each item of a successful list response, in order. */
export async function ids(sent: AdminSent): Promise<unknown[]> {
  return (await page(sent)).items.map((item) => item['recon_diff_id']);
}

/** The data of a successful detail response, its instants as epoch milliseconds. */
export async function detailOf(sent: AdminSent): Promise<Record<string, unknown>> {
  return normalize((await answer(sent, 0)).data);
}
