import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

type Platform = typeof import('../../../../apps/api/src/modules/platform/index.ts');
type Crypto = typeof import('../../../../apps/api/src/modules/platform/crypto/index.ts');
type Validation = typeof import('../../../../apps/api/src/modules/platform/validation/index.ts');
type Sessions = typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
type Tokens = typeof import('../../../../apps/api/src/modules/identity/application/tokens.ts');
type Options = import('../../../../apps/api/src/modules/platform/index.ts').PlatformOptions;
interface Response {
  statusCode: number;
  body: string;
  json<T = Record<string, unknown>>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    payload?: string;
    headers: Record<string, string>;
  }): Promise<Response>;
}
type Operation = {
  operationId: string;
  'x-implementation'?: string;
  'x-auth': string;
  'x-signed': boolean;
  responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
};
export const ROOT = new URL('../../../../', import.meta.url);
export const PATH = '/v1/invites/me';
export const NOW = '2026-09-29T12:00:00.000Z';
export const CODE = 'K7M2QX';
export const DOMAIN = 'share.example.test';
export const PRIVATE_NAME = '邀请实名测试姓名';

// Only the integration test imports @couli/db/testing. Application imports are dynamic;
// no route, guard, reader, or business dependency is mocked.
export async function withHttp(
  db: Kysely<DB>,
  redisUrl: string,
  run: (f: Fixture) => Promise<void>,
) {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as Platform;
  const cryptoModule = (await import(
    new URL('apps/api/src/modules/platform/crypto/index.ts', ROOT).href
  )) as Crypto;
  const validation = (await import(
    new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
  )) as Validation;
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as Sessions;
  const tokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as Tokens;
  // Observe database requests without replacing any application reader or guard.
  const queries: string[] = [];
  const observedDb = db.withPlugin({
    transformQuery({ node }) {
      queries.push(
        JSON.stringify(node, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-11j-'));
  let app: HttpApp | undefined;
  try {
    const master = randomBytes(32);
    const keyring = await cryptoModule.createWrappedKeyring(
      new cryptoModule.LocalKeyProvider(master),
    );
    writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
    writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
    const clock = new platform.FixedClock(NOW);
    const lines: string[] = [];
    const logger = platform.createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    );
    const bootstrap = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp(
        entry: 'api',
        options: Pick<Options, 'config' | 'clock' | 'logger' | 'dbHandles' | 'redisUrl'>,
      ): Promise<HttpApp>;
    };
    app = await bootstrap.createHttpApp('api', {
      config: platform.loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
      }),
      clock,
      logger,
      dbHandles: { db: observedDb, dbRead: null, close: async () => undefined },
      redisUrl: platform.loadConnectionConfig('api', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: redisUrl,
      }).redisUrl,
    });
    await app.init();
    const parser = createRequire(new URL('apps/api/package.json', ROOT))(
      '@readme/openapi-parser',
    ) as {
      dereference(
        path: string,
        options: object,
      ): Promise<{ paths: Record<string, { get: Operation }> }>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      {
        resolve: { external: false },
      },
    );
    const f: Fixture = {
      app,
      appId: `invites_${randomBytes(10).toString('hex')}`,
      db: db.withSchema('app'),
      clock,
      lines,
      queries,
      crypto: app.get(platform.FIELD_CRYPTO),
      tokens: app.get(tokens.TOKEN_SERVICE),
      createSession: sessions.createSession,
      operation: document.paths[PATH]!.get,
      compile: validation.createValidatorCompiler(),
    };
    await shareDomains(f, [DOMAIN, 'backup.example.test']);
    await run(f);
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
export interface Fixture {
  app: HttpApp;
  appId: string;
  db: Kysely<DB>;
  clock: InstanceType<Platform['FixedClock']>;
  lines: string[];
  queries: string[];
  crypto: import('../../../../apps/api/src/modules/platform/crypto/index.ts').FieldCrypto;
  tokens: Parameters<Sessions['createSession']>[2]['tokens'];
  createSession: Sessions['createSession'];
  operation: Operation;
  compile: ReturnType<Validation['createValidatorCompiler']>;
}
export async function seed(
  f: Fixture,
  options: {
    code?: string;
    appId?: string;
    phone?: boolean;
    parent?: string;
    status?: string;
  } = {},
) {
  const uid = randomUUID();
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const code =
    options.code ?? [...randomBytes(6)].map((n) => alphabet[n % alphabet.length]).join('');
  const appId = options.appId ?? f.appId;
  await f.db
    .insertInto('users')
    .values({
      id: uid,
      app_id: appId,
      nickname: `私密昵称-${uid}`,
      avatar: 'https://private.example.test/avatar',
      invite_code: code,
      attr_code: randomBytes(4).toString('hex'),
      level: 'L1',
      register_method: 'sms',
      status: options.status ?? 'normal',
      phone_hmac: options.phone === false ? null : randomBytes(32).toString('hex'),
      parent_id: options.parent ?? null,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  return { uid, appId, code };
}
export type User = Awaited<ReturnType<typeof seed>>;
export async function client(f: Fixture, user: User) {
  const headers = {
    'content-type': 'application/json',
    'x-app-id': user.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const response = await f.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  const { device_id } = response.json<{ data: { device_id: string } }>().data;
  return {
    async get(extraHeaders: Record<string, string> = {}) {
      // Reissue at the injected time: boundary tests cannot fail merely due to JWT expiry.
      const session = await f.db
        .transaction()
        .execute((trx) =>
          f.createSession(
            trx,
            { uid: user.uid, app_id: user.appId, device_id, scp: 'full' },
            { clock: f.clock, tokens: f.tokens },
          ),
        );
      // getMyInvite is unsigned. No signing or idempotency headers are necessary.
      return f.app.inject({
        method: 'GET',
        url: PATH,
        headers: {
          ...headers,
          'x-device-id': device_id,
          authorization: `Bearer ${session.access_token}`,
          'x-trace-id': randomUUID(),
          ...extraHeaders,
        },
      });
    },
  };
}
export async function shareDomains(f: Fixture, value: unknown, appId = f.appId) {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${appId}, 'share_domains', ${JSON.stringify(value)}::jsonb, 'b1-11j')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value`.execute(f.db);
}
export async function risk(
  f: Fixture,
  user: User,
  state: 'normal' | 'banned' | 'appealing' | 'frozen',
) {
  await sql`INSERT INTO app.user_risk_state
    (app_id, user_id, state, reason, reason_category, changed_by, changed_at)
    VALUES (${user.appId}, ${user.uid}, ${state}, 'fixture', 'other', 'fixture', ${f.clock.now()})
    ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state,
      row_version = app.user_risk_state.row_version + 1`.execute(f.db);
}
export async function verified(f: Fixture, user: User, birth: string) {
  const id = `fixture-${user.uid}`;
  const encrypted = (value: string, context: string) =>
    Buffer.from(f.crypto.encrypt(value, context));
  await sql`INSERT INTO app.realname
    (id, app_id, user_id, status, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, provider, verified_at)
    VALUES (${randomUUID()}, ${user.appId}, ${user.uid}, 'verified',
      ${encrypted(PRIVATE_NAME, 'realname.name')}, ${encrypted(id, 'realname.id_no')},
      ${f.crypto.blindIndex(id, 'realname.id_no')}, ${encrypted(birth, 'realname.birth_date')},
      'test-two-elements', ${f.clock.now()})`.execute(f.db);
}
export async function processingAppeal(f: Fixture, user: User, previous: 'banned' | 'frozen') {
  await f.db
    .insertInto('appeals')
    .values({
      id: randomUUID(),
      app_id: user.appId,
      user_id: user.uid,
      target_type: 'account',
      target_id: user.uid,
      prev_risk_state: previous,
      status: 'processing',
      content: 'fixture appeal',
      deadline_at: new Date(f.clock.now().getTime() + 86_400_000),
    })
    .execute();
}

export function riskBlocked(f: Fixture, response: Response, queryStart: number) {
  // The merged risk gate returns 403/10006 without data (including without reason).
  expect(answer(f, response, 10006)).not.toHaveProperty('data');
  const queries = f.queries.slice(queryStart).join('\n');
  // No invitation-code read, child count, realname read, or share-domain lookup after refusal.
  expect(queries).not.toMatch(/invite_code|parent_id|realname|share_domains/);
  expect(queries).not.toMatch(/"func":"count"/);
}

export function answer(f: Fixture, response: Response, code = 0) {
  expect(response.statusCode, response.body).toBe(
    code === 0 ? 200 : code === 10005 || code === 10006 ? 403 : 422,
  );
  const body = response.json<{
    code: number;
    msg: string;
    trace_id: string;
    data?: Record<string, unknown>;
  }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const schema =
    f.operation.responses[code === 0 ? '200' : '4XX']!.content['application/json']!.schema;
  const validate = f.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  if (code === 30413) expect(body.data).toEqual({ reason: 'self_minor' });
  return body;
}
export function success(
  f: Fixture,
  response: Response,
  code = CODE,
  count = 0,
  domain: string | null = DOMAIN,
) {
  const body = answer(f, response);
  expect(body.data).toEqual({
    can_invite: true,
    invite_code: code,
    landing_url: domain === null ? null : `https://${domain}/i/${code}`,
    poster_url: null,
    direct_count: count,
  });
}
export function unavailable(f: Fixture, response: Response, count: number) {
  expect(answer(f, response).data).toEqual({
    can_invite: false,
    invite_code: null,
    landing_url: null,
    poster_url: null,
    direct_count: count,
  });
}
