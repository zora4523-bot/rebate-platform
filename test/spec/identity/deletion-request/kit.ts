// B1-15d rule-test fixture (08 BR-ID-27, BR-ID-08, BR-ID-31; orchestrator brief §9.2, ruling
// D10-97). The real AppModule as app.module assembles it — signature ①, tokens ② ③, idempotency
// ④, ④a, ⑤ (risk state, 10006 whitelist), identity's ⑫ step-up — over the business-role PG and a
// real Redis, with the real routes of getDeletion / requestDeletion / cancelDeletion. No route
// handler is replaced.
// Only IdentityModule's `withdrawalInFlight` option (WithdrawalInFlightReader, D10-97) is replaced,
// by a reader the test controls per (app_id, user_id): this is how "the port says in flight →
// 30412" proves the judgement goes through the port. The `deletionBalance` option stays the one
// app.module assembles over the ledger's getBalances (balances are seeded as ledger rows); it is
// only wrapped to record its calls. Mode `assembled` keeps app.module's own in-flight port too
// (D10-97: until B2-05 it truthfully answers "none"); modes `no_in_flight` / `no_balance` remove
// one option to check that a missing port answers 50001 instead of letting the application through.
// Step-up tokens are signed exactly as POST /v1/auth/step-up issues them (signScopedToken with the
// application's TOKEN_KEYS, aud=step_up). Only *.int.test.ts files call openFixture; the test
// database comes from the global setup's createTestDatabase (through registration/kit.ts).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import type {
  TokenKeyProvider,
  TokenService,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type * as AccessTokensApi from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type * as SessionsApi from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type * as IdentityTokensApi from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type { IssuedSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type { DeletionBalanceReader } from '../../../../apps/api/src/modules/identity/ports/deletion-balance.ts';
import type { WithdrawalInFlightReader } from '../../../../apps/api/src/modules/identity/ports/withdrawal-in-flight.ts';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type * as PlatformApi from '../../../../apps/api/src/modules/platform/index.ts';
import type { Idempotency } from '../../../../apps/api/src/modules/platform/index.ts';
import type { JsonSchema } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type * as RiskApi from '../../../../apps/api/src/modules/risk/index.ts';
import type { RiskStateService } from '../../../../apps/api/src/modules/risk/index.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';
import { apiRequire, ROOT, sign } from '../../risk/signature/kit.ts';
import { closeKit, openKit, seedUser, type Kit } from '../registration/kit.ts';
import { buildApp } from '../sms-codes/http-kit.ts';
import { acquireRedis, memoryLogger } from '../sms-codes/kit.ts';

export const INSTANT = '2026-10-16T02:00:00.000Z';
/** BR-ID-27: the cooling period, 7×24 hours. */
export const COOLING_MS = 7 * 24 * 60 * 60 * 1000;
/** BR-ID-08: a step_up_token is valid for 5 minutes. */
export const TTL_SECONDS = 300;
export const PATH = '/v1/me/deletion';
export const CANCEL_PATH = '/v1/me/deletion/cancel';

export type RequestStatus = 'cooling' | 'processing' | 'done' | 'cancelled';
export type CancelReason = 'user' | 'negative_balance';
export type PortMode = 'controlled' | 'assembled' | 'no_in_flight' | 'no_balance';
export type StepUpAction =
  'withdraw' | 'payout_account_change' | 'phone_change' | 'account_deletion';

export interface WireResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  payload: string;
  json<T = unknown>(): T;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(request: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<WireResponse>;
}
type Factory = (...args: never[]) => unknown;
interface FactoryOption {
  readonly inject?: readonly unknown[];
  readonly useFactory: Factory;
}

/** One call of a port, as the port saw it. */
export interface PortCall {
  readonly appId: string;
  readonly userId: string;
  /** The executor the port got was a Kysely Transaction (the caller's), not the pool. */
  readonly inTransaction: boolean;
}
/** One call of the in-flight port, with a probe of the caller's row lock on app.users. */
export interface InFlightCall extends PortCall {
  /**
   * While the port ran, another connection could not take FOR SHARE NOWAIT on the user's
   * app.users row (55P03): the request held the user's row lock (FOR NO KEY UPDATE / FOR UPDATE).
   */
  readonly userRowLocked: boolean;
}
/** What the controlled in-flight port does on its next call for a user. */
export type InFlightPlan = { readonly hold: Promise<void>; readonly entered: () => void };

export interface Fixture {
  kit: Kit;
  db: Kysely<DB>;
  app: App;
  clock: FixedClock;
  lines: string[];
  keys: TokenKeyProvider;
  idempotency: Idempotency;
  risk: RiskStateService;
  close(): Promise<void>;
}

const inFlightAnswers = new Map<string, boolean>();
const inFlightHolds = new Map<string, InFlightPlan[]>();
const inFlightCalls: InFlightCall[] = [];
const balanceCalls: PortCall[] = [];
const scopeKey = (appId: string, userId: string) => `${appId}/${userId}`;

/** Sets what the controlled in-flight port answers for (app_id, user_id) from now on. */
export function setInFlight(appId: string, userId: string, answer: boolean): void {
  inFlightAnswers.set(scopeKey(appId, userId), answer);
}
/** The next call of the in-flight port for this user calls `entered`, then waits for `hold`. */
export function holdInFlight(appId: string, userId: string, plan: InFlightPlan): void {
  const key = scopeKey(appId, userId);
  inFlightHolds.set(key, [...(inFlightHolds.get(key) ?? []), plan]);
}
export function inFlightCallsOf(appId: string, userId: string): InFlightCall[] {
  return inFlightCalls.filter((call) => call.appId === appId && call.userId === userId);
}
export function balanceCallsOf(appId: string, userId: string): PortCall[] {
  return balanceCalls.filter((call) => call.appId === appId && call.userId === userId);
}
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

function controlledInFlight(db: Kysely<DB>): WithdrawalInFlightReader {
  return {
    async hasInFlight(trx: Transaction<DB>, input) {
      const locked = await userRowLocked(db, input.appId, input.userId);
      inFlightCalls.push({
        appId: input.appId,
        userId: input.userId,
        inTransaction: isTransaction(trx),
        userRowLocked: locked,
      });
      const key = scopeKey(input.appId, input.userId);
      const plan = inFlightHolds.get(key)?.shift();
      if (plan !== undefined) {
        plan.entered();
        await plan.hold;
      }
      return inFlightAnswers.get(key) ?? false;
    },
  };
}

function recordingBalance(port: DeletionBalanceReader | null): DeletionBalanceReader | null {
  if (port === null || port === undefined) return port;
  return {
    availableFen(trx, input) {
      balanceCalls.push({
        appId: input.appId,
        userId: input.userId,
        inTransaction: isTransaction(trx),
      });
      return port.availableFen(trx, input);
    },
  };
}

function wrapBalanceOption(option: FactoryOption | undefined): FactoryOption | undefined {
  if (option === undefined) return undefined;
  return {
    ...option,
    useFactory: (...args: never[]) => {
      const made = option.useFactory(...args) as
        DeletionBalanceReader | null | Promise<DeletionBalanceReader | null>;
      return made instanceof Promise ? made.then(recordingBalance) : recordingBalance(made);
    },
  };
}

export async function openFixture(mode: PortMode = 'controlled'): Promise<Fixture> {
  const kit = await openKit();
  const server = await acquireRedis();
  expect(server, 'no test Redis').toBeDefined();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'spec-b1-15d-'));
  const { logger, lines } = memoryLogger();
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof PlatformApi;
  // identity's public surface (its index also exports the Nest module, outside the test project).
  const identity = (await import(new URL('apps/api/src/modules/identity/index.ts', ROOT).href)) as {
    IdentityModule: { forRoot(options: Record<string, unknown>): unknown };
  };
  const identityTokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof IdentityTokensApi;
  const riskIndex = (await import(
    new URL('apps/api/src/modules/risk/index.ts', ROOT).href
  )) as typeof RiskApi;
  const clock = new platform.FixedClock(INSTANT);
  const original = identity.IdentityModule.forRoot.bind(identity.IdentityModule);
  const identitySpy = vi.spyOn(identity.IdentityModule, 'forRoot').mockImplementation((options) => {
    const balance = options['deletionBalance'] as FactoryOption | undefined;
    const assembled: Record<string, unknown> = {
      ...options,
      deletionBalance: wrapBalanceOption(balance),
    };
    if (mode === 'controlled') {
      assembled['withdrawalInFlight'] = { useFactory: () => controlledInFlight(kit.db) };
    }
    if (mode === 'no_in_flight') delete assembled['withdrawalInFlight'];
    if (mode === 'no_balance') delete assembled['deletionBalance'];
    return original(assembled);
  });
  let app: App | undefined;
  try {
    app = (await buildApp(kit.db, dir, server!.url, clock, logger)) as unknown as App;
    await app.init();
    const running = app;
    return {
      kit,
      db: kit.db,
      app: running,
      clock,
      lines,
      keys: running.get<TokenKeyProvider>(identityTokens.TOKEN_KEYS),
      idempotency: running.get<Idempotency>(platform.IDEMPOTENCY),
      risk: running.get<RiskStateService>(riskIndex.riskStateServiceToken()),
      async close() {
        try {
          await running.close();
        } finally {
          try {
            await server!.stop();
          } finally {
            await closeKit(kit);
            rmSync(dir, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    await app?.close();
    await server!.stop();
    await closeKit(kit);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    identitySpy.mockRestore();
  }
}

export interface CallOptions {
  /** full (default): the user's access token; h5: an h5_token (scope standard) of that session. */
  readonly auth?: 'full' | 'h5';
  readonly version?: string;
}
export interface ApplyOptions extends CallOptions {
  /** The X-Step-Up-Token header; null sends none. */
  readonly stepUp: string | null;
  /** The Idempotency-Key header; null sends none; undefined: a fresh key. */
  readonly key?: string | null;
  /** The JSON body (signed as sent); default {}. */
  readonly body?: Record<string, unknown>;
}

export interface User {
  readonly appId: string;
  readonly uid: string;
  readonly deviceId: string;
  readonly session: IssuedSession;
  /** A step_up_token as POST /v1/auth/step-up issues it, with claim and timing overrides. */
  mint(
    action?: StepUpAction,
    options?: {
      readonly claims?: Readonly<Record<string, string | undefined>>;
      readonly issuedAt?: number;
    },
  ): Promise<string>;
  apply(options: ApplyOptions): Promise<WireResponse>;
  cancel(options?: CallOptions): Promise<WireResponse>;
  get(options?: CallOptions): Promise<WireResponse>;
}

/**
 * A fresh app id (no cached configuration, buckets or versions shared with another test), one
 * registered device, one user with a bound phone and one session of `scope` (default full) on that
 * device. `config` rows and an app_versions row (minimum `minVersion` for ios / appstore) are
 * written before any request.
 */
export async function user(
  f: Fixture,
  options: {
    readonly config?: Record<string, unknown>;
    readonly minVersion?: string;
    readonly scope?: 'full' | 'deletion_only';
    readonly appId?: string;
  } = {},
): Promise<User> {
  const appId = options.appId ?? `dr_${randomBytes(10).toString('hex')}`;
  const db = f.db;
  for (const [key, value] of Object.entries(options.config ?? {})) {
    await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
      VALUES (${appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'b1-15d-rule-test')`.execute(db);
  }
  if (options.minVersion !== undefined) {
    await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version,
      min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
      VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', ${options.minVersion},
        ${options.minVersion}, 'test', 'test', 'https://example.test/app', 'appstore',
        '[]'::jsonb)`.execute(db);
  }
  const headers = {
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const registered = await f.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(registered.statusCode, registered.payload).toBe(200);
  const device = registered.json<{ data: { device_id: string; install_secret: string } }>().data;
  expect(device).toMatchObject({
    device_id: expect.any(String),
    install_secret: expect.any(String),
  });
  const uid = await seedUser(db, appId, { phoneHmac: randomBytes(32).toString('hex') });
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as typeof SessionsApi;
  const access = (await import(
    new URL('apps/api/src/modules/identity/application/access-tokens.ts', ROOT).href
  )) as typeof AccessTokensApi;
  const identityTokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof IdentityTokensApi;
  const tokens = f.app.get<TokenService>(identityTokens.TOKEN_SERVICE);
  const session = await db
    .withSchema('app')
    .transaction()
    .execute((trx) =>
      sessions.createSession(
        trx,
        { uid, app_id: appId, device_id: device.device_id, scp: options.scope ?? 'full' },
        { clock: f.clock, tokens },
      ),
    );
  const nowSeconds = () => Math.floor(f.clock.now().getTime() / 1000);
  async function bearer(auth: CallOptions['auth']): Promise<string> {
    if (auth !== 'h5') return session.access_token;
    return access.signScopedToken(f.keys, {
      audience: access.H5_AUDIENCE,
      claims: {
        uid,
        app_id: appId,
        sid: session.sid,
        device_id: device.device_id,
        scp: 'standard',
      },
      issuedAt: nowSeconds(),
      ttlSeconds: 900,
    });
  }
  async function common(call: CallOptions): Promise<Record<string, string>> {
    return {
      ...headers,
      ...(call.version === undefined ? {} : { 'x-app-version': call.version }),
      'x-device-id': device.device_id,
      'x-trace-id': randomUUID(),
      authorization: `Bearer ${await bearer(call.auth)}`,
    };
  }
  return {
    appId,
    uid,
    deviceId: device.device_id,
    session,
    async mint(action = 'account_deletion', mintOptions = {}) {
      const claims: Record<string, string> = {};
      for (const [name, value] of Object.entries({
        uid,
        app_id: appId,
        sid: session.sid,
        device_id: device.device_id,
        action,
        jti: randomUUID(),
        ...mintOptions.claims,
      })) {
        if (value !== undefined) claims[name] = value;
      }
      return access.signScopedToken(f.keys, {
        audience: access.STEP_UP_AUDIENCE,
        claims,
        issuedAt: mintOptions.issuedAt ?? nowSeconds(),
        ttlSeconds: TTL_SECONDS,
      });
    },
    async apply(call) {
      const raw = JSON.stringify(call.body ?? {});
      const timestamp = String(nowSeconds());
      const nonce = randomBytes(16).toString('hex');
      const key = call.key === undefined ? randomUUID() : call.key;
      return f.app.inject({
        method: 'POST',
        url: PATH,
        payload: raw,
        headers: {
          ...(await common(call)),
          'content-type': 'application/json',
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign('POST', PATH, Buffer.from(raw), timestamp, nonce, device.install_secret),
          ...(key === null ? {} : { 'idempotency-key': key }),
          ...(call.stepUp === null ? {} : { 'x-step-up-token': call.stepUp }),
        },
      });
    },
    async cancel(call = {}) {
      return f.app.inject({ method: 'POST', url: CANCEL_PATH, headers: await common(call) });
    },
    async get(call = {}) {
      return f.app.inject({ method: 'GET', url: PATH, headers: await common(call) });
    },
  };
}

// ---- contract checks -------------------------------------------------------------------------

type Validate = ((value: unknown) => boolean) & { errors?: unknown };
let deletionValidator: Promise<Validate> | undefined;
async function deletionResponseValidator(): Promise<Validate> {
  deletionValidator ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
    );
    const validation = (await import(
      new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
    )) as typeof import('../../../../apps/api/src/modules/platform/validation/index.ts');
    const compile = validation.createValidatorCompiler();
    return compile({
      schema: document.components.schemas['DeletionResponse']!,
      httpPart: 'body',
    }) as Validate;
  })();
  return deletionValidator;
}

/** The Deletion object of the contract (date-times as strings). */
export interface DeletionData {
  status: RequestStatus;
  apply_at: string;
  cooling_until: string;
  can_cancel: boolean;
  cancelled_at: string | null;
  cancel_reason: CancelReason | null;
  processed_at: string | null;
}

/** HTTP 200, code 0, a body valid against DeletionResponse; returns data (a Deletion or null). */
export async function deletionData(response: WireResponse): Promise<DeletionData | null> {
  expect(response.statusCode, response.payload).toBe(200);
  const body = response.json<Record<string, unknown>>();
  expect(body).toMatchObject({ code: 0, msg: expect.any(String), trace_id: expect.any(String) });
  const validate = await deletionResponseValidator();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(response.headers['x-trace-id']).toBe(body['trace_id']);
  return body['data'] as DeletionData | null;
}
/** As deletionData, and the data is a Deletion (not null). */
export async function deletion(response: WireResponse): Promise<DeletionData> {
  const data = await deletionData(response);
  expect(data).not.toBeNull();
  return data!;
}

/** An error envelope with this HTTP status and code, valid against ErrorEnvelope. */
export async function failed(
  response: WireResponse,
  status: number,
  code: number,
): Promise<Record<string, unknown>> {
  expect(response.statusCode, response.payload).toBe(status);
  const body = response.json<Record<string, unknown>>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const validate = await envelopeValidator();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(response.headers['x-trace-id']).toBe(body['trace_id']);
  return body;
}

/** BR-ID-08: 10003, HTTP 403, an ErrorEnvelope without data. */
export async function stepUpRequired(response: WireResponse): Promise<void> {
  const body = await failed(response, 403, 10003);
  expect(body).not.toHaveProperty('data');
}

/** Milliseconds of a contract date-time string. */
export function ms(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  expect(Number.isNaN(parsed), value).toBe(false);
  return parsed;
}

// ---- seeding and reading ---------------------------------------------------------------------

/** One USER_BALANCE ledger account of the user with this available balance (bigint fen). */
export async function seedBalance(
  f: Fixture,
  appId: string,
  userId: string,
  availableFen: bigint,
): Promise<void> {
  const accountId = randomUUID();
  await sql`INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
    VALUES (${accountId}, ${appId}, 'user', ${userId}, 'USER_BALANCE')`.execute(f.db);
  await sql`INSERT INTO app.account_balances
    (app_id, account_id, available_fen, frozen_fen, negative_since, version)
    VALUES (${appId}, ${accountId}, ${availableFen}, 0,
      ${availableFen < 0n ? '2026-10-01' : null}::date, 1)`.execute(f.db);
}

/** A deletion request row written directly (synthetic fixture, not the lifecycle commands). */
export async function seedRequest(
  f: Fixture,
  appId: string,
  userId: string,
  status: RequestStatus,
  applyAt: Date,
  options: { readonly cancelReason?: CancelReason; readonly cancelledAt?: Date } = {},
): Promise<string> {
  const id = randomUUID();
  const until = new Date(applyAt.getTime() + COOLING_MS);
  const reason = status === 'cancelled' ? (options.cancelReason ?? 'user') : null;
  const cancelledAt =
    status === 'cancelled'
      ? (options.cancelledAt ?? (reason === 'negative_balance' ? until : applyAt))
      : null;
  await f.db
    .withSchema('app')
    .insertInto('deletion_requests')
    .values({
      id,
      app_id: appId,
      user_id: userId,
      status,
      apply_at: applyAt,
      cooling_until: until,
      cancelled_at: cancelledAt,
      cancel_reason: reason,
      processed_at: status === 'done' ? until : null,
      balance_snapshot_fen: 0n,
      created_at: applyAt,
      updated_at: applyAt,
    })
    .execute();
  return id;
}

export async function requests(f: Fixture, appId: string, userId: string) {
  return f.db
    .withSchema('app')
    .selectFrom('deletion_requests')
    .selectAll()
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .orderBy('apply_at')
    .orderBy('id')
    .execute();
}

/**
 * Waits until some session of this test database waits for a lock that is not granted (another
 * request queued behind a held row lock). A bounded poll of pg_locks, not a timed bet.
 */
export async function lockWaiter(f: Fixture): Promise<void> {
  let waiting = 0;
  for (let attempt = 0; attempt < 1500 && waiting === 0; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const { rows } = await sql<{ waiting: number }>`SELECT count(*)::int AS waiting
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database()`.execute(f.db);
    waiting = rows[0]!.waiting;
  }
  expect(waiting, 'no request waited on a lock within the bound').toBeGreaterThan(0);
}

/** A promise with its resolver, for barriers between a held port call and the test. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
