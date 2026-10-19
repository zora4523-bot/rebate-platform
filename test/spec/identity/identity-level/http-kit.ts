// Real AppModule, PG and Redis; only planned payout handlers are replaced. No level check is
// installed by this fixture: app.module must supply both production paths itself.
// B1-13j: B1-13e implemented getPayoutAccount, so each payout operation is judged on its own. A
// planned one still gets the stub handler below; an implemented one keeps its real route (a stub
// on the same method and path would collide with it) and its real handler is wrapped, before the
// routes are registered, so `handled` still counts every entry into the business handler.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';
import type * as Access from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type * as Sessions from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type * as Tokens from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type * as StepUp from '../../../../apps/api/src/modules/identity/application/step-up-verify.ts';
import type * as Risk from '../../../../apps/api/src/modules/risk/index.ts';
import { seedUser } from '../registration/kit.ts';
import { buildApp } from '../sms-codes/http-kit.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { apiRequire, ROOT, sign } from '../../risk/signature/kit.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';

export const PAYOUT = '/v1/me/payout-account';
export const BODY = { fixture: 'identity-level' };
type Method = 'GET' | 'PUT' | 'POST';
export interface Response {
  statusCode: number;
  payload: string;
  headers: Record<string, unknown>;
  json<T = Record<string, unknown>>(): T;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol | Constructor): T;
  inject(options: {
    method: Method;
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}
interface Request extends StepUp.StepUpHttpRequest {
  id: string;
  body: unknown;
  readonly headers: Record<string, string | undefined>;
}
type Constructor = abstract new (...args: never[]) => unknown;
type Handler = (this: unknown, ...args: unknown[]) => unknown;
// reflect-metadata (loaded by @nestjs/common): the route metadata lives on the handler function.
const metadata = Reflect as unknown as {
  getMetadata(key: unknown, target: object): unknown;
  getOwnMetadataKeys(target: object): unknown[];
  getOwnMetadata(key: unknown, target: object): unknown;
  defineMetadata(key: unknown, value: unknown, target: object): void;
};
type Decorator = (target: object, name: string, descriptor: PropertyDescriptor) => void;

export async function openHttp(db: Kysely<DB>, redisUrl: string) {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof Platform;
  const identity = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as Pick<typeof StepUp, 'withStepUp'>;
  const tokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof Tokens;
  const risk = (await import(
    new URL('apps/api/src/modules/risk/index.ts', ROOT).href
  )) as typeof Risk;
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: Platform.PlatformOptions): Record<string, unknown> };
  };
  const common = (await import(pathToFileURL(apiRequire.resolve('@nestjs/common')).href)) as {
    Controller(path: string): (target: Constructor) => void;
    Get(path: string): Decorator;
    Put(path: string): Decorator;
    Req(): (target: object, name: string, index: number) => void;
    HttpException: new (body: unknown, status: number) => Error;
    RequestMethod: { GET: number; PUT: number };
  };
  const constants = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/common/constants.js')).href
  )) as { PATH_METADATA: string; METHOD_METADATA: string };
  const core = (await import(pathToFileURL(apiRequire.resolve('@nestjs/core')).href)) as {
    ModulesContainer: new () => Map<string, { controllers: Map<unknown, { metatype: unknown }> }>;
  };
  const clock = new platform.FixedClock('2026-10-17T02:00:00.000Z');
  const handled = new Map<string, number>();
  const stepUpCalls: string[] = [];
  let idem: Platform.Idempotency;
  class PlannedPayout {
    get(request: Request) {
      const uid = request.principal!.uid;
      handled.set(uid, (handled.get(uid) ?? 0) + 1);
      return { code: 0, msg: '', data: { fixture: true }, trace_id: request.id };
    }
    async put(request: Request) {
      const principal = request.principal!;
      const response = await identity.withStepUp(request, () =>
        idem.executeInTransaction(
          {
            appId: principal.app_id,
            actor: { userId: principal.uid, deviceId: null, phoneHmac: null },
            method: 'PUT',
            path: PAYOUT,
            key: request.headers['idempotency-key'],
            body: request.body,
            traceId: request.id,
          },
          async () => ({ status: 200, envelope: this.get(request) }),
        ),
      );
      if (response.status !== 200)
        throw new common.HttpException(JSON.parse(response.body), response.status);
      return JSON.parse(response.body) as unknown;
    }
  }
  const projection = (await import(
    new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', ROOT).href
  )) as { CONTRACT_ROUTE_SCHEMAS: Record<string, unknown> };
  // B1-13j: per operation, not "both planned". GET is judged by the level guard before the
  // handler, so entering the real handler is the same event the stub counted. PUT is judged inside
  // the handler's idempotency call (post-miss check) and its contract body is not BODY, so entering
  // a real PUT handler is not that event: when savePayoutAccount lands (B1-13f) the probe and BODY
  // need their own test change instead of a weaker count.
  const operations = [
    { operation: 'getPayoutAccount', name: 'get', method: 'GET', probe: true },
    { operation: 'savePayoutAccount', name: 'put', method: 'PUT', probe: false },
  ] as const;
  const implemented = operations.filter(({ operation }) =>
    Object.hasOwn(projection.CONTRACT_ROUTE_SCHEMAS, operation),
  );
  for (const { operation, probe } of implemented) {
    expect(
      probe,
      `${operation} 已实现：真实路由的业务入口探针与合契约的请求体需另开 test-change（B1-13j 注释）`,
    ).toBe(true);
  }
  const planned = operations.filter((entry) => !implemented.includes(entry));
  common.Controller('v1/me/payout-account')(PlannedPayout);
  for (const { name } of planned) {
    common.Req()(PlannedPayout.prototype, name, 0);
    (name === 'get' ? common.Get('') : common.Put(''))(
      PlannedPayout.prototype,
      name,
      Object.getOwnPropertyDescriptor(PlannedPayout.prototype, name)!,
    );
  }
  // Counts an entry into a real handler under the token principal it was called for; an entry
  // whose arguments carry no principal counts against every user (never silently dropped).
  const count = (args: unknown[]) => {
    const carrier = args.find(
      (arg): arg is { principal: { uid: string } } =>
        typeof arg === 'object' &&
        arg !== null &&
        typeof (arg as { principal?: { uid?: unknown } }).principal?.uid === 'string',
    );
    const uid = carrier?.principal.uid ?? '*';
    handled.set(uid, (handled.get(uid) ?? 0) + 1);
  };
  const restore: (() => void)[] = [];
  const segments = (value: unknown) =>
    (Array.isArray(value) ? value : [value ?? ''])
      .map((path) => String(path).replace(/^\/+|\/+$/g, ''))
      .filter((path) => path !== '');
  // Before init (Nest registers routes in init and keeps the handler function it finds then).
  const probeRealRoutes = (running: App) => {
    for (const { operation, method } of implemented) {
      let wrapped = 0;
      const seen = new Set<unknown>();
      for (const module of running
        .get<Map<string, { controllers: Map<unknown, { metatype: unknown }> }>>(
          core.ModulesContainer,
        )
        .values()) {
        for (const { metatype } of module.controllers.values()) {
          if (typeof metatype !== 'function' || seen.has(metatype)) continue;
          seen.add(metatype);
          const prefixes = segments(metadata.getMetadata(constants.PATH_METADATA, metatype));
          for (
            let proto = metatype.prototype as object | null;
            proto !== null && proto !== Object.prototype;
            proto = Object.getPrototypeOf(proto) as object | null
          ) {
            for (const name of Object.getOwnPropertyNames(proto)) {
              const descriptor = Object.getOwnPropertyDescriptor(proto, name)!;
              if (name === 'constructor' || typeof descriptor.value !== 'function') continue;
              const original = descriptor.value as Handler;
              if (
                metadata.getMetadata(constants.METHOD_METADATA, original) !==
                common.RequestMethod[method]
              )
                continue;
              const paths = segments(metadata.getMetadata(constants.PATH_METADATA, original));
              const full = (prefixes.length === 0 ? [''] : prefixes).flatMap((prefix) =>
                (paths.length === 0 ? [''] : paths).map((path) =>
                  [prefix, path].filter((part) => part !== '').join('/'),
                ),
              );
              if (!full.includes(PAYOUT.slice(1))) continue;
              const probe: Handler = function (this: unknown, ...args: unknown[]) {
                count(args);
                return original.apply(this, args);
              };
              for (const key of metadata.getOwnMetadataKeys(original))
                metadata.defineMetadata(key, metadata.getOwnMetadata(key, original), probe);
              Object.defineProperty(proto, name, { ...descriptor, value: probe });
              const owner = proto;
              restore.push(() => Object.defineProperty(owner, name, descriptor));
              wrapped += 1;
            }
          }
        }
      }
      expect(wrapped, `${operation} 已实现，但找不到 ${method} ${PAYOUT} 的真实处理函数`).toBe(1);
    }
  };
  const unprobe = () => {
    for (const undo of restore.splice(0).reverse()) undo();
  };
  // Observe actual Redis commands as well as the final key: a reserve-then-release must fail.
  const originalPlatform = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const redisSpy = vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
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
        const factory = provider.useFactory as () => Promise<Platform.RedisHandle>;
        return {
          provide: platform.REDIS,
          useFactory: async () => {
            const handle = await factory();
            return {
              ...handle,
              namespace(name: string) {
                const ns = handle.namespace(name);
                return {
                  get: (key: string) => ns.get(key),
                  set: ns.set.bind(ns),
                  eval: (script: string, args: Parameters<Platform.RedisNamespace['eval']>[1]) => {
                    if (name === 'step_up') stepUpCalls.push(...args.keys);
                    return ns.eval(script, args);
                  },
                };
              },
              close: () => handle.close(),
              onApplicationShutdown: () => handle.onApplicationShutdown(),
            };
          },
        };
      }),
    };
  });
  const original = AppModule.forEntry.bind(AppModule);
  const entrySpy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    return {
      ...module,
      controllers: [
        ...((module['controllers'] ?? []) as unknown[]),
        ...(planned.length === 0 ? [] : [PlannedPayout]),
      ],
    };
  });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-02za-'));
  const { logger } = memoryLogger();
  let app: App | undefined;
  try {
    app = (await buildApp(db, dir, redisUrl, clock, logger)) as unknown as App;
    probeRealRoutes(app);
    await app.init();
    idem = app.get<Platform.Idempotency>(platform.IDEMPOTENCY);
    const running = app;
    return {
      db,
      app: running,
      clock,
      idem,
      stepUpCalls,
      keys: app.get<Access.TokenKeyProvider>(tokens.TOKEN_KEYS),
      tokens: app.get<Access.TokenService>(tokens.TOKEN_SERVICE),
      redis: app.get<Platform.RedisHandle>(platform.REDIS),
      risk: app.get<Risk.RiskStateService>(risk.riskStateServiceToken()),
      // '*': a real-handler entry without a principal counts against every user (B1-13j).
      handled: (uid: string) => (handled.get(uid) ?? 0) + (handled.get('*') ?? 0),
      async close() {
        try {
          await running.close();
        } finally {
          unprobe();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      unprobe();
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    entrySpy.mockRestore();
    redisSpy.mockRestore();
  }
}
export type Fixture = Awaited<ReturnType<typeof openHttp>>;

export async function client(
  f: Fixture,
  options: {
    phone?: boolean;
    scope?: 'full' | 'deletion_only';
    minVersion?: string;
    config?: Record<string, unknown>;
  } = {},
) {
  const appId = `il_${randomBytes(10).toString('hex')}`;
  for (const [key, value] of Object.entries(options.config ?? {})) {
    await sql`INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
      (${appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'b1-02za')`.execute(f.db);
  }
  if (options.minVersion !== undefined) {
    await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version,
      min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
      VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', ${options.minVersion},
      ${options.minVersion}, 'test', 'test', 'https://example.test/store', 'appstore', '[]'::jsonb)`.execute(
      f.db,
    );
  }
  const headers = {
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const registration = await f.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(registration.statusCode).toBe(200);
  const device = registration.json<{ data: { device_id: string; install_secret: string } }>().data;
  const uid = await seedUser(
    f.db,
    appId,
    options.phone ? { phoneHmac: randomBytes(32).toString('hex') } : {},
  );
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as typeof Sessions;
  const access = (await import(
    new URL('apps/api/src/modules/identity/application/access-tokens.ts', ROOT).href
  )) as typeof Access;
  const session = await f.db
    .withSchema('app')
    .transaction()
    .execute((trx) =>
      sessions.createSession(
        trx,
        { uid, app_id: appId, device_id: device.device_id, scp: options.scope ?? 'full' },
        { clock: f.clock, tokens: f.tokens },
      ),
    );
  return {
    uid,
    appId,
    session,
    async bind(phone: boolean) {
      await f.db
        .withSchema('app')
        .updateTable('users')
        .set({ phone_hmac: phone ? randomBytes(32).toString('hex') : null })
        .where('id', '=', uid)
        .where('app_id', '=', appId)
        .execute();
    },
    async ban(state: 'normal' | 'banned') {
      await f.db.transaction().execute((trx) =>
        f.risk.setRiskState(trx, {
          app_id: appId,
          user_id: uid,
          state,
          reason: 'identity-level fixture',
          reason_category: state === 'normal' ? null : 'other',
          frozen_until: null,
          changed_by: 'fixture',
        }),
      );
    },
    async stepUp() {
      const jti = randomUUID();
      const token = await access.signScopedToken(f.keys, {
        audience: 'step_up',
        claims: {
          uid,
          app_id: appId,
          sid: session.sid,
          device_id: device.device_id,
          action: 'payout_account_change',
          jti,
        },
        issuedAt: Math.floor(f.clock.now().getTime() / 1000),
        ttlSeconds: 300,
      });
      return { token, jti };
    },
    async accessWithClaims(extra: Record<string, unknown>) {
      const jose = (await import(pathToFileURL(apiRequire.resolve('jose')).href)) as {
        SignJWT: new (claims: object) => {
          setProtectedHeader(value: object): {
            setIssuer(value: string): {
              setAudience(value: string): {
                setIssuedAt(value: number): {
                  setExpirationTime(value: number): {
                    sign(key: Access.TokenKeyProvider['privateKey']): Promise<string>;
                  };
                };
              };
            };
          };
        };
      };
      const now = Math.floor(f.clock.now().getTime() / 1000);
      return new jose.SignJWT({
        uid,
        app_id: appId,
        sid: session.sid,
        device_id: device.device_id,
        scp: options.scope ?? 'full',
        ...extra,
      })
        .setProtectedHeader({ alg: 'ES256', kid: f.keys.kid, typ: 'JWT' })
        .setIssuer('couli-api')
        .setAudience('app')
        .setIssuedAt(now)
        .setExpirationTime(now + 900)
        .sign(f.keys.privateKey);
    },
    send(
      method: Method,
      path = PAYOUT,
      options: {
        key?: string | null;
        stepUp?: string;
        token?: string;
        version?: string;
        body?: object;
        headers?: Record<string, string>;
      } = {},
    ) {
      const raw = method === 'GET' ? '' : JSON.stringify(options.body ?? BODY);
      const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const key = options.key === undefined ? randomUUID() : options.key;
      return f.app.inject({
        method,
        url: path,
        ...(method === 'GET' ? {} : { payload: raw }),
        headers: {
          ...headers,
          ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
          'x-device-id': device.device_id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign(method, path, Buffer.from(raw), timestamp, nonce, device.install_secret),
          authorization: `Bearer ${options.token ?? session.access_token}`,
          'x-trace-id': randomUUID(),
          ...(key === null ? {} : { 'idempotency-key': key }),
          ...(options.stepUp === undefined ? {} : { 'x-step-up-token': options.stepUp }),
          ...(options.version === undefined ? {} : { 'x-app-version': options.version }),
          ...options.headers,
        },
      });
    },
  };
}

export async function refusal(response: Response, status: number, code: number, noData = true) {
  expect(response.statusCode, response.payload).toBe(status);
  const body = response.json();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  if (noData) expect(body).not.toHaveProperty('data');
  expect(response.headers['x-trace-id']).toBe(body['trace_id']);
  const validate = await envelopeValidator();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}
