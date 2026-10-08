import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createTokenCheck,
  TokenRejection,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import {
  FixedClock,
  IDEMPOTENCY,
  REDIS,
  type Idempotency,
  type PlatformOptions,
  type RedisHandle,
  type TokenPrincipal,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { buildApp, type Response } from '../../identity/sms-codes/http-kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { openKit, closeKit, seedUser, type Kit } from '../../identity/registration/kit.ts';
import { acquire, appId, apiRequire, ROOT, type Server } from './kit.ts';

export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(request: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress?: string;
  }): Promise<Response>;
}
interface Request {
  id: string;
  body: unknown;
  headers: Record<string, string>;
  principal: TokenPrincipal;
}
type Constructor = abstract new (...args: never[]) => unknown;

export interface HttpSuite {
  kit: Kit;
  server: Server;
}
export async function openHttpSuite(): Promise<HttpSuite> {
  const kit = await openKit();
  try {
    return { kit, server: await acquire() };
  } catch (error) {
    await closeKit(kit);
    throw error;
  }
}
export async function closeHttpSuite(suite: HttpSuite | undefined) {
  if (suite === undefined) return;
  try {
    await suite.server.stop();
  } finally {
    await closeKit(suite.kit);
  }
}

/** Actual AppModule + content reader + real PG idempotency + real Redis/signature.
 * Only planned controllers and token verification/session ports are test doubles.
 * Neither the rate-limit service nor any risk guard/hook is installed by this fixture.
 */
export async function withHttp(
  suite: HttpSuite,
  values: Record<string, unknown>,
  run: (f: HttpFixture) => Promise<void>,
  transactional = false,
) {
  const id = appId();
  const db = suite.kit.db;
  for (const [key, value] of Object.entries(values)) {
    await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
      VALUES (${id}, ${key}, ${JSON.stringify(value)}::jsonb, 'rate-limit-rule-test')`.execute(db);
  }
  await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version,
    min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
    VALUES (${randomUUID()}, ${id}, 'ios', 'appstore', '2.0.0', '2.0.0', 'test', 'test',
      'https://example.test/app', 'appstore', '[]'::jsonb)`.execute(db);
  const uid = await seedUser(db, id);
  const clock = new FixedClock('2031-05-06T07:08:09Z');
  const { logger, lines } = memoryLogger();
  const principals = new Map<string, TokenPrincipal>();
  const common = (await import(pathToFileURL(apiRequire.resolve('@nestjs/common')).href)) as {
    Controller(path: string): (target: Constructor) => void;
    Post(path: string): (target: object, name: string, descriptor: PropertyDescriptor) => void;
    Req(): (target: object, name: string, index: number) => void;
    HttpCode(code: number): (target: object, name: string, descriptor: PropertyDescriptor) => void;
    HttpException: new (body: unknown, status: number) => Error;
  };
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: PlatformOptions): Record<string, unknown> };
  };
  const { TOKEN_CHECK } = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as { TOKEN_CHECK: symbol };
  const tokenCheck = createTokenCheck({
    tokens: {
      async verifyAccess(token) {
        const principal = principals.get(token);
        if (principal === undefined) throw new TokenRejection(10002);
        return principal;
      },
      issueAccess: async () => {
        throw new Error('unused token issuance');
      },
      issueRefresh: () => {
        throw new Error('unused token issuance');
      },
    },
    sessions: { find: async () => ({ revoked_at: null }) },
  });
  let idem: Idempotency;
  let handled = 0;
  class PlannedEndpoints {
    tip(req: Request) {
      handled++;
      return { code: 0, msg: '', data: {}, trace_id: req.id };
    }
    async convert(req: Request) {
      const command = {
        appId: req.principal.app_id,
        actor: { userId: req.principal.uid, deviceId: null, phoneHmac: null },
        method: 'POST' as const,
        path: '/v1/links/convert',
        key: req.headers['idempotency-key'],
        body: req.body,
        traceId: req.id,
      };
      // Code 0 is stored by idempotency, enabling replay of exact response bytes.
      // The fixture payload avoids simulating union responses.
      const handler = async () => {
        handled++;
        return {
          status: 200,
          envelope: { code: 0, msg: '', data: { fixture: 'conversion' }, trace_id: req.id },
        };
      };
      const response = transactional
        ? await idem.executeInTransaction(command, handler)
        : await idem.execute(command, handler);
      if (response.status !== 200)
        throw new common.HttpException(JSON.parse(response.body) as unknown, response.status);
      return JSON.parse(response.body) as unknown;
    }
  }
  common.Controller('v1')(PlannedEndpoints);
  for (const [name, path] of [
    ['tip', 'me/tips/:tip_key/read'],
    ['convert', 'links/convert'],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(PlannedEndpoints.prototype, name)!;
    common.Req()(PlannedEndpoints.prototype, name, 0);
    common.Post(path)(PlannedEndpoints.prototype, name, descriptor);
    common.HttpCode(200)(PlannedEndpoints.prototype, name, descriptor);
  }
  const original = AppModule.forEntry.bind(AppModule);
  const spy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    return {
      ...module,
      controllers: [...((module['controllers'] ?? []) as unknown[]), PlannedEndpoints],
      providers: [
        ...((module['providers'] ?? []) as unknown[]),
        { provide: TOKEN_CHECK, useValue: tokenCheck },
      ],
    };
  });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'rate-limit-'));
  let app: HttpApp | undefined;
  try {
    app = (await buildApp(db, dir, suite.server.url, clock, logger)) as HttpApp;
    await app.init();
    idem = app.get<Idempotency>(IDEMPOTENCY);
    const headers = {
      'content-type': 'application/json',
      'x-app-id': id,
      'x-platform': 'ios',
      'x-app-version': '2.0.0',
      'x-channel': 'appstore',
    };
    const device = await app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers,
      payload: JSON.stringify({
        device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
        id_source: 'idfv',
      }),
    });
    expect(device.statusCode).toBe(200);
    const { device_id, install_secret } = device.json<{
      data: { device_id: string; install_secret: string };
    }>().data;
    principals.set('rate-limit-test', {
      uid,
      device_id,
      app_id: id,
      sid: randomUUID(),
      scp: 'full',
    });
    const running = app;
    const post = (
      path: string,
      payload: Record<string, unknown>,
      extra: Record<string, string> = {},
    ) => {
      const raw = JSON.stringify(payload);
      const timestamp = String(Math.floor(clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const message = [
        'POST',
        path,
        timestamp,
        nonce,
        createHash('sha256').update(raw).digest('hex'),
      ].join('\n');
      const signedHeaders: Record<string, string> = {
        ...headers,
        authorization: 'Bearer rate-limit-test',
        'x-device-id': device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': createHmac('sha256', install_secret).update(message).digest('hex'),
        ...extra,
      };
      if (extra['authorization'] === '') delete signedHeaders['authorization'];
      return running.inject({ method: 'POST', url: path, payload: raw, headers: signedHeaders });
    };
    await run({
      app: running,
      id,
      uid,
      device_id,
      clock,
      lines,
      headers: { ...headers, 'x-device-id': device_id },
      post,
      handled: () => handled,
      redis: running.get<RedisHandle>(REDIS),
    });
  } finally {
    spy.mockRestore();
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export interface HttpFixture {
  app: HttpApp;
  id: string;
  uid: string;
  device_id: string;
  clock: FixedClock;
  lines: string[];
  headers: Record<string, string>;
  redis: RedisHandle;
  post(
    path: string,
    body: Record<string, unknown>,
    extra?: Record<string, string>,
  ): Promise<Response>;
  handled(): number;
}
export async function limited(response: Response, seconds: number) {
  expect(response.statusCode).toBe(429);
  expect(String(response.headers['retry-after'])).toBe(String(seconds));
  expect(response.json()).toMatchObject({
    code: 42901,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string): Promise<{
      components: {
        responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
      };
    }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
  const schema = doc.components.responses['TooManyRequests']!.content['application/json']!.schema;
  const validate = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}
