import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { buildApp, type HttpApp, type Response } from '../../identity/sms-codes/http-kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import type {
  InviteBindCommand,
  InviteBindingResult,
} from '../../../../apps/api/src/modules/growth/application/invite-binder.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { RedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const PATH = '/v1/me/inviter';
export const NOW = '2031-05-06T09:00:00.000Z';
export const CODE = 'K7Q2MZ';
export const OTHER_CODE = 'R8W3NX';
type Growth = typeof import('../../../../apps/api/src/modules/growth/application/invite-binder.ts');
type Platform = typeof import('../../../../apps/api/src/modules/platform/index.ts');
type Tokens = typeof import('../../../../apps/api/src/modules/identity/application/tokens.ts');
type Sessions = typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
type Validation = typeof import('../../../../apps/api/src/modules/platform/validation/index.ts');
type Operation = {
  'x-implementation'?: string;
  'x-auth': string;
  'x-signed': boolean;
  'x-idempotent': boolean;
  requestBody: { content: Record<string, { schema: Record<string, unknown> }> };
  responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
};
export interface Fixture {
  app: HttpApp;
  appId: string;
  db: Kysely<DB>;
  clock: InstanceType<Platform['FixedClock']>;
  crypto: FieldCrypto;
  redis: RedisHandle;
  tokens: import('../../../../apps/api/src/modules/identity/application/access-tokens.ts').TokenService;
  calls: { command: InviteBindCommand; transactional: boolean }[];
  forced: Map<string, InviteBindingResult>;
  failAfterBind: Set<string>;
  boundBeforeFailure: string[];
  operation: Operation;
  compile: ReturnType<Validation['createValidatorCompiler']>;
}

// Real AppModule, guards, PG and Redis. The spy delegates to B1-11d except where a test
// explicitly injects a result / an exception to verify the HTTP boundary and rollback.
// App construction is inside each test, so a future NotImplemented is never a hook failure.
export async function withHttp(
  db: Kysely<DB>,
  redisUrl: string,
  run: (f: Fixture) => Promise<void>,
): Promise<void> {
  const growth = (await import(
    new URL('apps/api/src/modules/growth/application/invite-binder.ts', ROOT).href
  )) as Growth;
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as Platform;
  const tokenModule = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as Tokens;
  const validation = (await import(
    new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
  )) as Validation;
  const calls: Fixture['calls'] = [];
  const forced: Fixture['forced'] = new Map();
  const failAfterBind = new Set<string>();
  const boundBeforeFailure: string[] = [];
  const original = growth.createInviteBinder;
  const spy = vi.spyOn(growth, 'createInviteBinder').mockImplementation((deps) => {
    const binder = original(deps);
    return {
      async bind(trx, command) {
        calls.push({ command: { ...command }, transactional: trx.isTransaction });
        const injected = forced.get(command.user_id);
        if (injected !== undefined) return injected;
        const result = await binder.bind(trx, command);
        if (failAfterBind.has(command.user_id) && result.result === 'bound') {
          boundBeforeFailure.push(command.user_id);
          throw new Error('backfill test: fail after relation and audit writes');
        }
        return result;
      },
    };
  });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-11e-'));
  let app: HttpApp | undefined;
  try {
    const clock = new platform.FixedClock(NOW);
    app = await buildApp(db, dir, redisUrl, clock, memoryLogger().logger);
    await app.init();
    const parser = createRequire(new URL('apps/api/package.json', ROOT))(
      '@readme/openapi-parser',
    ) as {
      dereference(
        path: string,
        options: object,
      ): Promise<{ paths: Record<string, { post: Operation }> }>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      {
        resolve: { external: false },
      },
    );
    await run({
      app,
      appId: `backfill_${randomBytes(10).toString('hex')}`,
      db: db.withSchema('app'),
      clock,
      crypto: app.get(platform.FIELD_CRYPTO),
      redis: app.get(platform.REDIS),
      tokens: app.get(tokenModule.TOKEN_SERVICE),
      calls,
      forced,
      failAfterBind,
      boundBeforeFailure,
      operation: document.paths[PATH]!.post,
      compile: validation.createValidatorCompiler(),
    });
  } finally {
    try {
      await app?.close();
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export async function seed(
  f: Fixture,
  code: string,
  options: { appId?: string; phone?: boolean } = {},
) {
  const uid = randomUUID();
  const appId = options.appId ?? f.appId;
  const phone = options.phone === false ? null : randomBytes(32).toString('hex');
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status,
      phone_hmac, created_at, updated_at)
    VALUES (${uid}, ${appId}, 'fixture', 'fixture', ${code}, ${randomBytes(4).toString('hex')},
      'L1', 'sms', 'normal', ${phone}, ${new Date('2031-05-05T09:00:00Z')}, ${new Date(NOW)})`.execute(
    f.db,
  );
  return uid;
}

export async function client(
  f: Fixture,
  options: { appId?: string; uid?: string; phone?: boolean } = {},
) {
  const appId = options.appId ?? f.appId;
  const uid = options.uid ?? (await seed(f, 'A2B3C4', options));
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
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(registered.statusCode).toBe(200);
  expect(registered.json()).toMatchObject({ code: 0 });
  const device = registered.json<{ data: { device_id: string; install_secret: string } }>().data;
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as Sessions;
  const session = await f.db
    .transaction()
    .execute((trx) =>
      sessions.createSession(
        trx,
        { uid, app_id: appId, device_id: device.device_id, scp: 'full' },
        { clock: f.clock, tokens: f.tokens },
      ),
    );
  return {
    uid,
    appId,
    deviceId: device.device_id,
    async post(
      body: unknown = { invite_code: CODE },
      options: {
        key?: string | null;
        headers?: Record<string, string>;
      } = {},
    ) {
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const message = [
        'POST',
        PATH,
        timestamp,
        nonce,
        createHash('sha256').update(raw).digest('hex'),
      ].join('\n');
      const key = options.key === undefined ? randomUUID() : options.key;
      return f.app.inject({
        method: 'POST',
        url: PATH,
        payload: raw,
        headers: {
          ...headers,
          'x-device-id': device.device_id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': createHmac('sha256', device.install_secret).update(message).digest('hex'),
          authorization: `Bearer ${session.access_token}`,
          'x-trace-id': randomUUID(),
          ...(key === null ? {} : { 'idempotency-key': key }),
          ...options.headers,
        },
      });
    },
  };
}

export function answer(f: Fixture, response: Response, code = 0) {
  const status =
    code === 0
      ? 200
      : code === 10005
        ? 403
        : code === 42901
          ? 429
          : code === 50001
            ? 500
            : code === 20001
              ? 400
              : code === 20901
                ? 409
                : code === 10001 || code === 10401
                  ? 401
                  : code === 10403
                    ? 403
                    : 422;
  expect(response.statusCode, JSON.stringify(response.json())).toBe(status);
  const body = response.json<{ code: number; msg: string; data?: unknown; trace_id: string }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const schema =
    f.operation.responses[
      code === 0 ? '200' : code === 42901 ? '429' : code === 50001 ? '5XX' : '4XX'
    ]!.content['application/json']!.schema;
  const validate = f.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  if (code === 0) expect(body.data).toEqual({});
  if (code >= 30401 && code <= 30409) expect(body).not.toHaveProperty('data');
  return body;
}

export async function row(f: Fixture, uid: string, appId = f.appId) {
  return f.db
    .selectFrom('users')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', uid)
    .executeTakeFirstOrThrow();
}
export async function logs(f: Fixture, uid: string, appId = f.appId) {
  return f.db
    .selectFrom('relation_change_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('user_id', '=', uid)
    .orderBy('id')
    .execute();
}
export async function idem(f: Fixture, key: string) {
  return f.db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('key', '=', key)
    .where('path', '=', PATH)
    .execute();
}
export async function config(f: Fixture, key: string, value: unknown) {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${f.appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'b1-11e')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value`.execute(f.db);
}
export function callsFor(f: Fixture, uid: string) {
  return f.calls.filter((call) => call.command.user_id === uid);
}
export async function count(f: Fixture, uid: string) {
  const user = await row(f, uid);
  return f.redis.namespace('invite_fail').get(`${f.appId}:2031-05-06:${user.phone_hmac}`);
}
