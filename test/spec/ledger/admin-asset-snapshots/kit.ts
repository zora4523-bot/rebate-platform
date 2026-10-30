// B2-09e rule-test kit (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// listAdminAssetSnapshots (GET /admin/v1/asset-snapshots, CT-24zb) — fund.view only (a super admin
// holds every point), read only, no step-up; only the asset_snapshots of the caller's app, each
// with its asset_snapshot_receivables ordered by platform code; filters date_from / date_to
// (YYYY-MM-DD, inclusive); snapshot_date descending; page_size ≤ 200; amounts integer fen exactly
// as stored (never recomputed); a day without a written snapshot has no row; reading writes no
// audit record and neither writes nor triggers a snapshot (08 BR-FUND-18; 04 §3.2 asset_snapshots,
// asset_snapshot_receivables).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation), PostgreSQL through @couli/db/testing as couli_app, Redis for the admin
// sessions (../../payment/orders/kit.ts suite). Synthetic: the snapshot rows (written directly with
// INSERT, as couli_app may and as the D+1 00:01 snapshot run would have written them) and the admin
// accounts. No real user or merchant data. Missing pieces fail as assertions (an unregistered
// admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
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

/** 2026-10-30 10:00 +08:00: the snapshot of 2026-10-29 is written, the one of 2026-10-30 is not. */
export const NOW = '2026-10-30T02:00:00.000Z';
export const PATH = '/admin/v1/asset-snapshots';
/** specs/permissions.yaml: the read point of the fund console, step-up null. */
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
    appId: `snap_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
  };
}

/**
 * D+1 00:01:00 +08:00 of accounting day `day` (YYYY-MM-DD), plus `ms` milliseconds: when the
 * snapshot run of that day writes its row (BR-FUND-18).
 */
export function writtenAt(day: string, ms = 0): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  // D+1 00:01 +08:00 is D 16:01 UTC.
  return new Date(Date.UTC(year, month - 1, date, 16, 1, 0, 0) + ms);
}

/** The five totals of a snapshot, as stored (bigint fen). */
export interface Totals {
  readonly total_available_positive_fen: bigint;
  readonly total_negative_fen: bigint;
  readonly total_frozen_fen: bigint;
  readonly total_waiting_fen: bigint;
  readonly total_estimated_fen: bigint;
}

export interface SnapshotSeed extends Partial<Totals> {
  readonly day: string;
  readonly appId?: string;
  readonly waitingComparable?: boolean;
  /** platform code → union_receivable_fen, written as asset_snapshot_receivables rows. */
  readonly receivables?: Readonly<Record<string, bigint>>;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

/** A seeded snapshot: its row values as written, the date as YYYY-MM-DD text. */
export interface Seeded extends Totals {
  readonly id: string;
  readonly appId: string;
  readonly day: string;
  readonly waitingComparable: boolean;
  readonly receivables: Readonly<Record<string, bigint>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One asset_snapshots row (and its receivable rows) of the fixture's app (or `seed.appId`). */
export async function seedSnapshot(f: Fixture, seed: SnapshotSeed): Promise<Seeded> {
  const id = randomUUID();
  const appId = seed.appId ?? f.appId;
  const createdAt = seed.createdAt ?? writtenAt(seed.day, 1_500);
  const updatedAt = seed.updatedAt ?? createdAt;
  const row: Seeded = {
    id,
    appId,
    day: seed.day,
    total_available_positive_fen: seed.total_available_positive_fen ?? 1_250_000n,
    total_negative_fen: seed.total_negative_fen ?? 3_200n,
    total_frozen_fen: seed.total_frozen_fen ?? 48_000n,
    total_waiting_fen: seed.total_waiting_fen ?? 860_000n,
    total_estimated_fen: seed.total_estimated_fen ?? 2_310_000n,
    waitingComparable: seed.waitingComparable ?? true,
    receivables: seed.receivables ?? { taobao: 864_000n },
    createdAt,
    updatedAt,
  };
  await f.db
    .insertInto('asset_snapshots')
    .values({
      id,
      app_id: appId,
      snapshot_date: row.day,
      total_available_positive_fen: row.total_available_positive_fen,
      total_negative_fen: row.total_negative_fen,
      total_frozen_fen: row.total_frozen_fen,
      total_waiting_fen: row.total_waiting_fen,
      total_estimated_fen: row.total_estimated_fen,
      waiting_comparable: row.waitingComparable,
      created_at: createdAt,
      updated_at: updatedAt,
    })
    .execute();
  const platforms = Object.entries(row.receivables);
  if (platforms.length > 0) {
    await f.db
      .insertInto('asset_snapshot_receivables')
      .values(
        platforms.map(([platform, fen]) => ({
          asset_snapshot_id: id,
          app_id: appId,
          platform,
          union_receivable_fen: fen,
        })),
      )
      .execute();
  }
  return row;
}

/** Every asset_snapshots row of the app, by date (reads must leave them as they were). */
export function allSnapshots(f: Fixture, appId = f.appId) {
  return f.db
    .selectFrom('asset_snapshots')
    .selectAll()
    .select((eb) => eb.cast<string>('snapshot_date', 'text').as('day'))
    .where('app_id', '=', appId)
    .orderBy('snapshot_date')
    .execute();
}

/** Every asset_snapshot_receivables row of the app. */
export function allReceivables(f: Fixture, appId = f.appId) {
  return f.db
    .selectFrom('asset_snapshot_receivables')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('asset_snapshot_id')
    .orderBy('platform')
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

/** event_log rows of the app named after the snapshot or its alerts (reading raises none). */
export function snapshotEvents(f: Fixture) {
  return f.db
    .selectFrom('event_log')
    .select(['event_id', 'name'])
    .where('app_id', '=', f.appId)
    .where((eb) =>
      eb.or([eb('name', 'like', 'asset_snapshot%'), eb('name', 'like', 'union_receivable%')]),
    )
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Expected shapes.

/** The required keys of the contract's AdminAssetSnapshot (additionalProperties false). */
export const ITEM_KEYS = [
  'created_at',
  'receivables',
  'snapshot_date',
  'total_available_positive_fen',
  'total_estimated_fen',
  'total_frozen_fen',
  'total_negative_fen',
  'total_waiting_fen',
  'updated_at',
  'waiting_comparable',
] as const;

/** The AdminAssetSnapshot a seeded row must be shown as (instants as epoch milliseconds). */
export function view(row: Seeded): Record<string, unknown> {
  return {
    snapshot_date: row.day,
    total_available_positive_fen: Number(row.total_available_positive_fen),
    total_negative_fen: Number(row.total_negative_fen),
    total_frozen_fen: Number(row.total_frozen_fen),
    total_waiting_fen: Number(row.total_waiting_fen),
    total_estimated_fen: Number(row.total_estimated_fen),
    waiting_comparable: row.waitingComparable,
    // Ordered by platform code (plain code-unit order, as the contract example: jd before taobao).
    receivables: Object.entries(row.receivables)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([platform, fen]) => ({ platform, union_receivable_fen: Number(fen) })),
    created_at: row.createdAt.getTime(),
    updated_at: row.updatedAt.getTime(),
  };
}

/** A response item with its date-time strings turned into epoch milliseconds. */
export function normalize(item: unknown): Record<string, unknown> {
  expect(typeof item === 'object' && item !== null, JSON.stringify(item)).toBe(true);
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const key of ['created_at', 'updated_at'] as const) {
    const value = out[key];
    if (typeof value === 'string') out[key] = Date.parse(value);
  }
  return out;
}

/** Seeded rows latest snapshot day first. */
export function latestFirst(rows: readonly Seeded[]): Seeded[] {
  return [...rows].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface AdminSent {
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
}

export interface SnapshotAdmin {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** GET /admin/v1/asset-snapshots with the query, as `viewer` unless given (null: no token). */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
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
export async function withSnapshotAdmin(f: Fixture, run: (h: SnapshotAdmin) => Promise<void>) {
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
  const dir = mkdtempSync(join(base, 'b2-09e-'));
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
        JWT_KEY_ID: 'b2_09e_test',
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
    const caller: SnapshotAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `snap_${id}`,
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
    const viewer = await caller([VIEW]);
    await run({
      caller,
      viewer,
      async list(query, who) {
        const actor = who === undefined ? viewer : who;
        const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
        if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
        const text = new URLSearchParams(query ?? {}).toString();
        const response = await server.inject({
          method: 'GET',
          url: text === '' ? PATH : `${PATH}?${text}`,
          headers,
          remoteAddress: '127.0.0.1',
        });
        return {
          statusCode: response.statusCode,
          body: response.body,
          json: () => JSON.parse(response.body) as Envelope,
        };
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

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10403: 403,
  20001: 400,
};

/** The response body conforms to the operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[PATH]?.['get']?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${PATH} ${status}`).toBeDefined();
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

/** The snapshot_date of each item of a successful list response, in order. */
export async function days(sent: AdminSent): Promise<unknown[]> {
  return (await page(sent)).items.map((item) => item['snapshot_date']);
}
