// B1-02d rule-test kit: the real AppModule over a test database and Redis; only the external
// third-party exchange (CT-15i) is a test double, swapped in through IdentityModule.forRoot like
// test/spec/identity/step-up/http-kit.ts. Modules of apps/api are imported at run time.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/index.ts';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { JsonSchema } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, ROOT, sign } from '../../risk/signature/kit.ts';
import { seedUser } from '../registration/kit.ts';
import { openSuite, closeSuite, type Suite } from '../session/kit.ts';
import { buildApp, type HttpApp, type Response } from '../sms-codes/http-kit.ts';
import { memoryLogger } from '../sms-codes/kit.ts';

export type Provider = 'wechat' | 'apple';
export const ATTEMPTS = '/v1/auth/oauth-attempts';
export const LOGIN: Record<Provider, string> = {
  wechat: '/v1/auth/login/wechat',
  apple: '/v1/auth/login/apple',
};
export const INSTANT = '2026-10-08T02:00:00.000Z';
export const CONSENT_AT = '2026-10-08T01:59:55.000Z';
export const LEGAL = { privacy: 7, agreement: 4 };
/** Channel whose minimum version (3.0.0) is seeded per app; RESTRICTED headers are below it. */
export const RESTRICTED = { 'x-channel': 'restricted', 'x-app-version': '1.0.0' };
/** Field-cipher context of the Apple refresh token (table.column, as users.phone). */
export const APPLE_REFRESH_CONTEXT = 'user_oauth.apple_refresh_token';
export const DEVICE_LOG_CONTEXT = 'login_logs.device_id';

export interface ExchangeInput {
  readonly provider: Provider | 'huawei';
  readonly code?: string;
  readonly identity_token?: string;
  readonly authorization_code?: string;
  readonly nonce: string;
}
export type ExchangeAnswer =
  | { readonly union_id?: string; readonly open_id?: string; readonly apple_refresh_token?: string }
  | { readonly unavailable: true }
  | { readonly invalid: true };

type Contract = {
  paths: Record<
    string,
    {
      post: {
        'x-implementation'?: string;
        responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
      };
    }
  >;
};

export interface OauthKit {
  suite: Suite;
  app: HttpApp;
  dir: string;
  clock: FixedClock;
  document: Contract;
  exchange: ReturnType<typeof vi.fn<(input: ExchangeInput) => Promise<ExchangeAnswer>>>;
  lines: string[];
  compile: ReturnType<
    typeof import('../../../../apps/api/src/modules/platform/validation/index.ts').createValidatorCompiler
  >;
}

/**
 * stub: the exchange is kit.exchange; none: the option is removed (what staging / prod get);
 * assembled: app.module's own wiring of the test environment, untouched.
 */
export async function openOauthKit(
  mode: 'stub' | 'none' | 'assembled' = 'stub',
): Promise<OauthKit> {
  const suite = await openSuite();
  const base = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-02d-'));
  const { FixedClock } = (await import(
    new URL('apps/api/src/modules/platform/clock/index.ts', ROOT).href
  )) as typeof import('../../../../apps/api/src/modules/platform/clock/index.ts');
  const clock = new FixedClock(INSTANT);
  const { logger, lines } = memoryLogger();
  const exchange = vi
    .fn<(input: ExchangeInput) => Promise<ExchangeAnswer>>()
    .mockResolvedValue({ unavailable: true });
  const { IdentityModule } = (await import(
    new URL('apps/api/src/modules/identity/identity.module.ts', ROOT).href
  )) as {
    IdentityModule: {
      forRoot(options: {
        config: unknown;
        thirdPartyIdentity?: { useFactory(): unknown };
      }): unknown;
    };
  };
  const original = IdentityModule.forRoot;
  const wiring = vi.spyOn(IdentityModule, 'forRoot').mockImplementation((options) => {
    if (mode === 'assembled') return original.call(IdentityModule, options);
    const changed = { ...options };
    delete changed.thirdPartyIdentity;
    return original.call(
      IdentityModule,
      mode === 'stub'
        ? { ...changed, thirdPartyIdentity: { useFactory: () => ({ exchange }) } }
        : changed,
    );
  });
  let app: HttpApp | undefined;
  try {
    app = await buildApp(suite.db, dir, suite.server.url, clock, logger);
    await app.init();
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(path: string, options: object): Promise<Contract>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      { resolve: { external: false } },
    );
    const validation = (await import(
      new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
    )) as typeof import('../../../../apps/api/src/modules/platform/validation/index.ts');
    const compile = validation.createValidatorCompiler();
    return { suite, app, dir, clock, document, exchange, lines, compile };
  } catch (error) {
    await app?.close();
    await closeSuite(suite);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    wiring.mockRestore();
  }
}

export async function closeOauthKit(kit: OauthKit | undefined): Promise<void> {
  if (!kit) return;
  try {
    await kit.app.close();
  } finally {
    try {
      await closeSuite(kit.suite);
    } finally {
      rmSync(kit.dir, { recursive: true, force: true });
    }
  }
}

async function platform() {
  return (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof import('../../../../apps/api/src/modules/platform/index.ts');
}
async function identityTokens() {
  return (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof import('../../../../apps/api/src/modules/identity/application/tokens.ts');
}

export async function client(kit: OauthKit, appId: string) {
  const deviceHash = randomBytes(32).toString('hex');
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: deviceHash, id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({ code: 0 });
  const data = created.json<{ data: { device_id: string; install_secret: string } }>().data;
  const post = (path: string, body: object, extra: Record<string, string> = {}) => {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    return kit.app.inject({
      method: 'POST',
      url: path,
      payload: raw,
      headers: {
        ...headers,
        'x-device-id': data.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, data.install_secret),
        ...extra,
      },
    });
  };
  /** A login-purpose attempt of this device; its nonce is what the exchange must receive. */
  const attempt = async (provider: Provider, extra: Record<string, string> = {}) => {
    const response = await post(ATTEMPTS, { provider, purpose: 'login' }, extra);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 0 });
    return response.json<{ data: { attempt_id: string; nonce: string; expire_at: string } }>().data;
  };
  return { deviceId: data.device_id, deviceHash, post, attempt };
}
export type Client = Awaited<ReturnType<typeof client>>;

/** Fresh credentials per call, so that a leak of one is attributable. */
export function credentials(provider: Provider) {
  const tag = randomUUID();
  return provider === 'wechat'
    ? { code: `wechat-code-${tag}` }
    : {
        identity_token: `apple-identity-token-${tag}`,
        authorization_code: `apple-authorization-code-${tag}`,
      };
}
export function loginBody(provider: Provider, attemptId: string, given = credentials(provider)) {
  return { attempt_id: attemptId, ...given, legal_versions: LEGAL, consent_at: CONSENT_AT };
}
/** What the exchange port must be called with: the credentials and the attempt's nonce. */
export function portInput(provider: Provider, body: object, nonce: string) {
  const { attempt_id, legal_versions, consent_at, ...given } = body as Record<string, unknown>;
  expect([attempt_id, legal_versions, consent_at]).not.toContain(undefined);
  return { provider, ...given, nonce };
}

export async function fixture(kit: OauthKit) {
  kit.clock.set(INSTANT);
  kit.exchange.mockReset().mockResolvedValue({ unavailable: true });
  const appId = `ol_${randomBytes(12).toString('hex')}`;
  const db = kit.suite.db.withSchema('app');
  // Seeded before this app's first request, so the content reader never caches a missing row.
  await db
    .insertInto('app_versions')
    .values({
      id: randomUUID(),
      app_id: appId,
      platform: 'ios',
      channel: RESTRICTED['x-channel'],
      latest_version: '3.0.0',
      min_supported_version: '3.0.0',
      update_title: '测试版本',
      update_notes: '第三方登录受限作用域测试',
      store_url: 'https://example.invalid/app',
      default_store: 'app_store',
      store_listings: sql`'[]'::jsonb`,
    })
    .execute();
  const device = await client(kit, appId);
  const { FIELD_CRYPTO } = await platform();
  const { TOKEN_SERVICE } = await identityTokens();
  const crypto = kit.app.get<FieldCrypto>(FIELD_CRYPTO);
  const tokens = kit.app.get<TokenService>(TOKEN_SERVICE);
  /** An existing account bound to a third-party identity (status as given). */
  const account = async (provider: Provider, status = 'normal') => {
    const uid = await seedUser(kit.suite.db, appId, { status, method: provider });
    const unionId = `union-${randomUUID()}`;
    await db
      .insertInto('user_oauth')
      .values({ id: randomUUID(), app_id: appId, user_id: uid, provider, union_id: unionId })
      .execute();
    return { uid, unionId };
  };
  const pushToken = async (deviceId = device.deviceId) => {
    const id = randomUUID();
    await db
      .insertInto('push_tokens')
      .values({
        id,
        app_id: appId,
        device_id: deviceId,
        user_id: null,
        bound_sid: null,
        provider: 'apns',
        token: `fixture-token-${id}`,
        token_set_at: kit.clock.now(),
        acquired_by_move_at: null,
        frozen_until: null,
        revoked_at: null,
        created_at: kit.clock.now(),
        updated_at: kit.clock.now(),
      })
      .execute();
    return id;
  };
  return { kit, db, appId, device, crypto, tokens, account, pushToken };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function rows(f: Fixture) {
  const app = f.appId;
  return {
    users: await f.db
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    oauth: await f.db
      .selectFrom('user_oauth')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    consents: await f.db
      .selectFrom('consent_records')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    sessions: await f.db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    logs: await f.db
      .selectFrom('login_logs')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    refresh: await f.db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    registrations: await f.db
      .selectFrom('device_registrations')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('user_id')
      .execute(),
  };
}

/** Columns added by migration 0033 (B1-02w) are read by name, never through generated types. */
export function column(row: object | undefined, name: string): unknown {
  expect(row).toBeDefined();
  return (row as Record<string, unknown>)[name];
}

export function validate(kit: OauthKit, path: string, response: Response): void {
  const status = response.statusCode === 200 ? '200' : response.statusCode >= 500 ? '5XX' : '4XX';
  const schema =
    kit.document.paths[path]!.post.responses[status]!.content['application/json']!.schema;
  const check = kit.compile({ schema, httpPart: 'body' });
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

export interface LoginData {
  user_id: string;
  is_new_user: boolean;
  tokens: {
    access_token: string;
    refresh_token: string;
    session_scope: 'full' | 'deletion_only';
  };
}
export function accepted(kit: OauthKit, path: string, response: Response): LoginData {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
  validate(kit, path, response);
  return response.json<{ data: LoginData }>().data;
}
const STATUS: Record<number, number> = {
  10007: 403,
  10405: 403,
  44001: 403,
  20001: 400,
  20004: 400,
  50001: 500,
  50305: 503,
};
export function rejected(
  kit: OauthKit,
  path: string,
  response: Response,
  code: number,
  data?: object,
): void {
  expect(response.statusCode).toBe(STATUS[code]);
  expect(response.json()).toMatchObject({
    code,
    trace_id: expect.any(String),
    ...(data === undefined ? {} : { data }),
  });
  expect(response.json()).not.toHaveProperty('data.tokens');
  validate(kit, path, response);
}

/** Warn lines (pino level 40) written since `start`, parsed. */
export function warnings(kit: OauthKit, start: number): Record<string, unknown>[] {
  return kit.lines
    .slice(start)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['level'] === 40);
}

/** Every value written for the app, as text: no credential may appear in it. */
export async function stored(f: Fixture): Promise<string> {
  const state = await rows(f);
  return JSON.stringify(state, (_key, value: unknown) =>
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
      ? Buffer.from((value as { data: number[] }).data).toString('utf8')
      : value,
  );
}

/** A session of an existing user on this device (to carry its token into a login). */
export async function issueSession(f: Fixture, uid: string) {
  const { createSession } = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
  return f.db
    .transaction()
    .execute((trx) =>
      createSession(
        trx,
        { uid, app_id: f.appId, device_id: f.device.deviceId, scp: 'full' },
        { clock: f.kit.clock, tokens: f.tokens },
      ),
    );
}

/** Resolves every call once `count` calls are waiting (or after a bound), all with `answer`. */
export function gate(count: number, answer: ExchangeAnswer) {
  const waiting: (() => void)[] = [];
  return () =>
    new Promise<ExchangeAnswer>((resolve) => {
      const release = () => resolve(answer);
      waiting.push(release);
      if (waiting.length >= count) for (const next of waiting.splice(0)) next();
      else setTimeout(release, 3000);
    });
}
