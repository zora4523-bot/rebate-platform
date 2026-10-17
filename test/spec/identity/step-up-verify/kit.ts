// B1-02y rule-test fixture (BR-ID-08, BR-ID-01 ⑫; orchestrator ruling §9.3): the real AppModule as
// app.module assembles it — signature ①, tokens ② ③, idempotency ④, ④a, ⑤, ⑬ and identity's ⑫ —
// over the business-role PG and a real Redis. Only the still planned business handlers of
// POST /v1/me/deletion and POST /v1/withdrawals are test controllers (precedent
// test/spec/risk/signature/devices.int.test.ts, test/spec/risk/rate-limit/http-kit.ts): each runs
// the real IDEMPOTENCY executeInTransaction through identity's withStepUp, with an outcome the test
// chooses. The REDIS handle is the real one behind a switch that can fail its commands, either
// only inside the idempotency post-miss phase (where ⑫ judges) or everywhere (while settling).
// Step-up tokens are signed exactly as POST /v1/auth/step-up issues them (signScopedToken with the
// application's TOKEN_KEYS, aud=step_up). Only the orchestrator runs these fixtures, inside the
// isolated integration-test container.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import type {
  TokenKeyProvider,
  TokenService,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type * as AccessTokensApi from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type * as SessionsApi from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type * as IdentityTokensApi from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type * as StepUpVerifyApi from '../../../../apps/api/src/modules/identity/application/step-up-verify.ts';
import type * as PlatformApi from '../../../../apps/api/src/modules/platform/index.ts';
import type * as RiskApi from '../../../../apps/api/src/modules/risk/index.ts';
import type { IssuedSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type { StepUpHttpRequest } from '../../../../apps/api/src/modules/identity/application/step-up-verify.ts';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  Idempotency,
  IdempotentResponse,
  PlatformOptions,
  RedisHandle,
  RedisNamespace,
  TokenPrincipal,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { RiskStateService } from '../../../../apps/api/src/modules/risk/index.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';
import { apiRequire, ROOT, sign } from '../../risk/signature/kit.ts';
import { closeKit, openKit, seedUser, type Kit } from '../registration/kit.ts';
import { buildApp } from '../sms-codes/http-kit.ts';
import { acquireRedis, memoryLogger } from '../sms-codes/kit.ts';

export const INSTANT = '2026-10-16T02:00:00.000Z';
/** BR-ID-08: a step_up_token is valid for 5 minutes. */
export const TTL_SECONDS = 300;
export const OPERATIONS = {
  deletion: { path: '/v1/me/deletion', action: 'account_deletion', operationId: 'requestDeletion' },
  withdraw: { path: '/v1/withdrawals', action: 'withdraw', operationId: 'createWithdrawal' },
} as const;
export type OperationName = keyof typeof OPERATIONS;
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
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
  }): Promise<WireResponse>;
}
interface StubRequest extends StepUpHttpRequest {
  readonly id: string;
  readonly body: unknown;
  readonly headers: Record<string, string | undefined>;
  readonly principal?: TokenPrincipal;
}
type Constructor = abstract new (...args: never[]) => unknown;

/** What the stub business handler does on its next call for a user (default: success). */
export type Outcome =
  | 'ok'
  /** code 30412, HTTP 422: a business refusal the idempotency module stores (3xxxx). */
  | 'refused_stored'
  /** code 20002, HTTP 400: a business refusal that is not stored (the key may be sent again). */
  | 'refused_unstored'
  /** The handler throws (the transaction rolls back; 50001). */
  | 'throw'
  /** Success, but every Redis command fails from the end of the handler on (settling). */
  | 'ok_then_redis_down'
  /** Success once `release` resolves; `entered` is called when the handler starts. */
  | { readonly hold: Promise<void>; readonly entered: () => void };

/** none: Redis works; post_miss: commands fail inside the post-miss phase only; all: always. */
export type RedisFault = 'none' | 'post_miss' | 'all';

export interface Fixture {
  kit: Kit;
  app: App;
  clock: FixedClock;
  lines: string[];
  keys: TokenKeyProvider;
  idempotency: Idempotency;
  risk: RiskStateService;
  setRedisFault(fault: RedisFault): void;
  close(): Promise<void>;
}

/** Calls of the stub handler and planned outcomes, per user id. */
const handled = new Map<string, number>();
const plans = new Map<string, Outcome[]>();
let fault: RedisFault = 'none';

export async function openFixture(): Promise<Fixture> {
  const kit = await openKit();
  const server = await acquireRedis();
  expect(server, 'no test Redis').toBeDefined();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'spec-b1-02y-'));
  const { logger, lines } = memoryLogger();
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof PlatformApi;
  // identity's public surface (its index also exports the Nest module, outside the test project).
  const identity = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as Pick<typeof StepUpVerifyApi, 'withStepUp'>;
  const identityTokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof IdentityTokensApi;
  const riskIndex = (await import(
    new URL('apps/api/src/modules/risk/index.ts', ROOT).href
  )) as typeof RiskApi;
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: PlatformOptions): Record<string, unknown> };
  };
  const common = (await import(pathToFileURL(apiRequire.resolve('@nestjs/common')).href)) as {
    Controller(path: string): (target: Constructor) => void;
    Post(path: string): (target: object, name: string, descriptor: PropertyDescriptor) => void;
    Req(): (target: object, name: string, index: number) => void;
    HttpCode(code: number): (target: object, name: string, descriptor: PropertyDescriptor) => void;
    HttpException: new (body: unknown, status: number) => Error;
  };
  const clock = new platform.FixedClock(INSTANT);
  let idempotency: Idempotency | undefined;

  async function business(request: StubRequest, name: OperationName): Promise<unknown> {
    const principal = request.principal!;
    const operation = OPERATIONS[name];
    const command = {
      appId: principal.app_id,
      actor: { userId: principal.uid, deviceId: null, phoneHmac: null },
      method: 'POST' as const,
      path: operation.path,
      key: request.headers['idempotency-key'],
      body: request.body,
      traceId: request.id,
    };
    const response: IdempotentResponse = await identity.withStepUp(request, () =>
      idempotency!.executeInTransaction(command, async () => {
        handled.set(principal.uid, (handled.get(principal.uid) ?? 0) + 1);
        const outcome = plans.get(principal.uid)?.shift() ?? 'ok';
        if (outcome === 'throw') throw new Error('fixture business failure');
        if (outcome === 'refused_stored')
          return {
            status: 422,
            envelope: { code: 30412, msg: 'fixture refusal', trace_id: request.id },
          };
        if (outcome === 'refused_unstored')
          return {
            status: 400,
            envelope: { code: 20002, msg: 'fixture refusal', trace_id: request.id },
          };
        if (typeof outcome === 'object') {
          outcome.entered();
          await outcome.hold;
        }
        if (outcome === 'ok_then_redis_down') fault = 'all';
        return {
          status: 200,
          envelope: {
            code: 0,
            msg: '',
            data: { fixture: name, call: handled.get(principal.uid) },
            trace_id: request.id,
          },
        };
      }),
    );
    if (response.status !== 200)
      throw new common.HttpException(JSON.parse(response.body) as unknown, response.status);
    return JSON.parse(response.body) as unknown;
  }
  class PlannedStepUpEndpoints {
    deletion(request: StubRequest) {
      return business(request, 'deletion');
    }
    withdraw(request: StubRequest) {
      return business(request, 'withdraw');
    }
  }
  common.Controller('v1')(PlannedStepUpEndpoints);
  for (const [name, path] of [
    ['deletion', 'me/deletion'],
    ['withdraw', 'withdrawals'],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(PlannedStepUpEndpoints.prototype, name)!;
    common.Req()(PlannedStepUpEndpoints.prototype, name, 0);
    common.Post(path)(PlannedStepUpEndpoints.prototype, name, descriptor);
    common.HttpCode(200)(PlannedStepUpEndpoints.prototype, name, descriptor);
  }
  const inPostMiss = () => platform.idempotencyPostMissTransaction() !== undefined;
  const failing = () => fault === 'all' || (fault === 'post_miss' && inPostMiss());
  const down = () => Promise.reject(new platform.RedisUnavailableError('command_failed'));
  const switchable = (handle: RedisHandle): RedisHandle => ({
    namespace(name: string): RedisNamespace {
      const namespace = handle.namespace(name);
      return {
        get: (key) => (failing() ? down() : namespace.get(key)),
        set: (key, value, ttl) => (failing() ? down() : namespace.set(key, value, ttl)),
        eval: (script, options) => (failing() ? down() : namespace.eval(script, options)),
      };
    },
    close: () => handle.close(),
    onApplicationShutdown: () => handle.onApplicationShutdown(),
  });
  const originalPlatform = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const platformSpy = vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = originalPlatform(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) => {
        if (
          typeof provider !== 'object' ||
          provider === null ||
          !('provide' in provider) ||
          provider.provide !== platform.REDIS ||
          !('useFactory' in provider)
        )
          return provider;
        const factory = provider.useFactory as () => Promise<RedisHandle>;
        return { provide: platform.REDIS, useFactory: async () => switchable(await factory()) };
      }),
    };
  });
  // Planned operations only: once their real controllers exist, these stubs would collide with
  // them and the fixture has to switch to the method swap of test/spec/risk/rate-limit/http-kit.ts.
  const routes = (await import(
    new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', ROOT).href
  )) as { CONTRACT_ROUTE_SCHEMAS: Record<string, unknown> };
  for (const operation of Object.values(OPERATIONS)) {
    expect(
      Object.hasOwn(routes.CONTRACT_ROUTE_SCHEMAS, operation.operationId),
      `${operation.operationId} 已实现，改用真实路由的替换办法`,
    ).toBe(false);
  }
  const original = AppModule.forEntry.bind(AppModule);
  const entrySpy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    return {
      ...module,
      controllers: [...((module['controllers'] ?? []) as unknown[]), PlannedStepUpEndpoints],
    };
  });
  let app: App | undefined;
  try {
    app = (await buildApp(kit.db, dir, server!.url, clock, logger)) as unknown as App;
    await app.init();
    idempotency = app.get<Idempotency>(platform.IDEMPOTENCY);
    const running = app;
    return {
      kit,
      app: running,
      clock,
      lines,
      keys: running.get<TokenKeyProvider>(identityTokens.TOKEN_KEYS),
      idempotency,
      risk: running.get<RiskStateService>(riskIndex.riskStateServiceToken()),
      setRedisFault(next) {
        fault = next;
      },
      async close() {
        fault = 'none';
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
    entrySpy.mockRestore();
    platformSpy.mockRestore();
  }
}

export interface SendOptions {
  /** The X-Step-Up-Token header; null sends none. */
  readonly stepUp: string | null;
  /** The Idempotency-Key header; null sends none. */
  readonly key?: string | null;
  readonly body?: Record<string, unknown>;
  readonly version?: string;
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
      readonly audience?: 'step_up' | 'h5';
    },
  ): Promise<string>;
  send(operation: OperationName, options: SendOptions): Promise<WireResponse>;
  plan(...outcomes: Outcome[]): void;
  handled(): number;
}

/**
 * A fresh app id (no cached configuration, buckets or versions shared with another test), one
 * registered device, one user and one full session of that user on that device. `config` rows and
 * an app_versions row (minimum `minVersion` for ios / appstore) are written before any request.
 */
export async function user(
  f: Fixture,
  options: { readonly config?: Record<string, unknown>; readonly minVersion?: string } = {},
): Promise<User> {
  const appId = `su_${randomBytes(10).toString('hex')}`;
  const db = f.kit.db;
  for (const [key, value] of Object.entries(options.config ?? {})) {
    await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
      VALUES (${appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'b1-02y-rule-test')`.execute(db);
  }
  if (options.minVersion !== undefined) {
    await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version,
      min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
      VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', ${options.minVersion},
        ${options.minVersion}, 'test', 'test', 'https://example.test/app', 'appstore',
        '[]'::jsonb)`.execute(db);
  }
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const registered = await f.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(registered.statusCode).toBe(200);
  const device = registered.json<{ data: { device_id: string; install_secret: string } }>().data;
  expect(device).toMatchObject({
    device_id: expect.any(String),
    install_secret: expect.any(String),
  });
  const uid = await seedUser(db, appId);
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
        { uid, app_id: appId, device_id: device.device_id, scp: 'full' },
        { clock: f.clock, tokens },
      ),
    );
  handled.set(uid, 0);
  plans.set(uid, []);
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
        audience: mintOptions.audience ?? access.STEP_UP_AUDIENCE,
        claims,
        issuedAt: mintOptions.issuedAt ?? Math.floor(f.clock.now().getTime() / 1000),
        ttlSeconds: TTL_SECONDS,
      });
    },
    send(operation, sendOptions) {
      const path = OPERATIONS[operation].path;
      const raw = JSON.stringify(sendOptions.body ?? { fixture: operation });
      const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const key = sendOptions.key === undefined ? randomUUID() : sendOptions.key;
      return f.app.inject({
        method: 'POST',
        url: path,
        payload: raw,
        headers: {
          ...headers,
          ...(sendOptions.version === undefined ? {} : { 'x-app-version': sendOptions.version }),
          'x-device-id': device.device_id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, device.install_secret),
          'x-trace-id': randomUUID(),
          authorization: `Bearer ${session.access_token}`,
          ...(key === null ? {} : { 'idempotency-key': key }),
          ...(sendOptions.stepUp === null ? {} : { 'x-step-up-token': sendOptions.stepUp }),
        },
      });
    },
    plan(...outcomes) {
      plans.get(uid)!.push(...outcomes);
    },
    handled: () => handled.get(uid) ?? 0,
  };
}

/** BR-ID-08: 10003, HTTP 403, an ErrorEnvelope without data (the user side has no tier). */
export async function stepUpRequired(response: WireResponse): Promise<void> {
  expect(response.statusCode, response.payload).toBe(403);
  const body = response.json<Record<string, unknown>>();
  expect(body).toMatchObject({
    code: 10003,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
  expect(body).not.toHaveProperty('data');
  const validate = await envelopeValidator();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(response.headers['x-trace-id']).toBe(body['trace_id']);
}

/** The stub business ran and succeeded: HTTP 200, code 0. */
export function succeeded(response: WireResponse): void {
  expect(response.statusCode, response.payload).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', data: expect.any(Object) });
}

/** An error envelope with this HTTP status and code. */
export function failed(response: WireResponse, status: number, code: number): void {
  expect(response.statusCode, response.payload).toBe(status);
  expect(response.json()).toMatchObject({
    code,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
}

/** The pino lines written since `from`, parsed. */
export function linesSince(f: Fixture, from: number): Record<string, unknown>[] {
  return f.lines.slice(from).map((line) => JSON.parse(line) as Record<string, unknown>);
}
