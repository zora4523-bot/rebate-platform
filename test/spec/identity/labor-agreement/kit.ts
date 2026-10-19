// Real AppModule, PostgreSQL and Redis. No handler, guard or repository replacements.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb } from '@couli/db';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';
import type * as Crypto from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type * as Validation from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type * as Sessions from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type * as Tokens from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type * as Identity from '../../../../apps/api/src/modules/identity/ports/labor-agreement.ts';

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
}
interface TestRedis {
  url: string;
}
export const ROOT = new URL('../../../../', import.meta.url);
export const PATH = '/v1/me/labor-agreement';
export const SIGN = `${PATH}/sign`;
export const NOW = '2026-10-18T15:59:00.000Z';
export const SHA = 'a'.repeat(64);
export const NAME = '欧阳小明';
export const ID = '11010519491231002X';
export const BODY = { version: 1, text_sha256: SHA, agreed: true };
export const CONFIG = {
  'legal.labor_agreement.version': 1,
  'legal.labor_agreement.text_url': 'https://example.test/legal/labor-v1.html',
  'legal.labor_agreement.text_sha256': SHA,
  'legal.labor_agreement.resign_from_version': 1,
  'legal.operator_entity.name': '测试运营主体',
  'legal.operator_entity.credit_code': '91350211M000100Y46',
};
type Contract = {
  paths: Record<
    string,
    Record<
      string,
      {
        'x-implementation'?: string;
        responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
      }
    >
  >;
};
export interface Response {
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
type CreateHttpApp = (
  entry: 'api',
  options: Pick<Platform.PlatformOptions, 'config' | 'clock' | 'logger' | 'dbHandles' | 'redisUrl'>,
) => Promise<HttpApp>;

export async function open(database: TestDatabase, server: TestRedis) {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof Platform;
  const cryptoModule = (await import(
    new URL('apps/api/src/modules/platform/crypto/index.ts', ROOT).href
  )) as typeof Crypto;
  const validation = (await import(
    new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
  )) as typeof Validation;
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as typeof Sessions;
  const tokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof Tokens;
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-13h-'));
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
  let app: HttpApp | undefined;
  try {
    const bootstrap = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp: CreateHttpApp;
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
      dbHandles: { db, dbRead: null, close: async () => undefined },
      redisUrl: platform.loadConnectionConfig('api', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: server.url,
      }).redisUrl,
    });
    await app.init();
    const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
    const parser = requireApi('@readme/openapi-parser') as {
      dereference(path: string, options: object): Promise<Contract>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      { resolve: { external: false } },
    );
    return {
      app,
      db,
      dir,
      clock,
      lines,
      document,
      compile: validation.createValidatorCompiler(),
      crypto: app.get<Platform.FieldCrypto>(platform.FIELD_CRYPTO),
      tokens: app.get<Parameters<typeof sessions.createSession>[2]['tokens']>(tokens.TOKEN_SERVICE),
      createSession: sessions.createSession,
    };
  } catch (error) {
    await app?.close();
    await destroyDb(db);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
export type Kit = Awaited<ReturnType<typeof open>>;
export async function close(kit: Kit | undefined) {
  if (!kit) return;
  try {
    await kit.app.close();
  } finally {
    await destroyDb(kit.db);
    rmSync(kit.dir, { recursive: true, force: true });
  }
}
export async function config(kit: Kit, appId: string, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
      VALUES (${appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'b1-13h-fixture')
      ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value, version = app.config_items.version + 1`.execute(
      kit.db,
    );
  }
}
export async function fixture(
  kit: Kit,
  options: {
    appId?: string;
    verified?: boolean;
    idNo?: string;
    config?: Record<string, unknown>;
  } = {},
) {
  const appId = options.appId ?? `la_${randomBytes(10).toString('hex')}`;
  const uid = randomUUID();
  const realnameId = randomUUID();
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  if (options.appId === undefined) {
    await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version, min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
      VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', '2.0.0', '2.0.0', 'fixture', 'fixture', 'https://example.test/app', 'appstore', '[]'::jsonb)`.execute(
      kit.db,
    );
    await config(kit, appId, options.config ?? CONFIG);
  }
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  const device = created.json<{ data: { device_id: string; install_secret: string } }>().data;
  await sql`INSERT INTO app.users (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, phone_hmac)
    VALUES (${uid}, ${appId}, 'fixture', 'https://example.test/avatar.png', ${randomUUID()}, ${randomUUID()}, 'L1', 'wechat', ${randomBytes(32).toString('hex')})`.execute(
    kit.db,
  );
  if (options.verified !== false) {
    const idNo = options.idNo ?? ID;
    const encrypted = (value: string, context: string) =>
      Buffer.from(kit.crypto.encrypt(value, context));
    await sql`INSERT INTO app.realname (id, app_id, user_id, status, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, provider, verified_at)
      VALUES (${realnameId}, ${appId}, ${uid}, 'verified', ${encrypted(NAME, 'realname.name')}, ${encrypted(idNo, 'realname.id_no')}, ${kit.crypto.blindIndex(idNo, 'realname.id_no')}, ${encrypted('1949-12-31', 'realname.birth_date')}, 'test-two-elements', ${kit.clock.now()})`.execute(
      kit.db,
    );
  }
  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: { key?: string; token?: string; anonymous?: boolean } = {},
  ) => {
    const session =
      options.token === undefined && options.anonymous !== true
        ? await kit.db
            .withSchema('app')
            .transaction()
            .execute((trx) =>
              kit.createSession(
                trx,
                { uid, app_id: appId, device_id: device.device_id, scp: 'full' },
                { clock: kit.clock, tokens: kit.tokens },
              ),
            )
        : null;
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const text = [
      method,
      path,
      timestamp,
      nonce,
      createHash('sha256').update(raw).digest('hex'),
    ].join('\n');
    return kit.app.inject({
      method,
      url: path,
      ...(body === undefined ? {} : { payload: raw }),
      headers: {
        ...headers,
        ...(options.anonymous === true
          ? {}
          : { authorization: `Bearer ${options.token ?? session?.access_token}` }),
        'x-device-id': device.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': createHmac('sha256', device.install_secret).update(text).digest('hex'),
        'idempotency-key': options.key ?? randomUUID(),
        'x-trace-id': randomUUID(),
      },
    });
  };
  return {
    appId,
    uid,
    realnameId,
    deviceId: device.device_id,
    request,
    get: () => request('GET', PATH),
    sign: (body: unknown = BODY, key?: string) =>
      request('POST', SIGN, body, key === undefined ? {} : { key }),
    rows: async () =>
      (
        await sql<
          Record<string, unknown>
        >`SELECT * FROM app.consent_records WHERE app_id = ${appId} AND user_id = ${uid} ORDER BY id`.execute(
          kit.db,
        )
      ).rows,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function envelope(kit: Kit, response: Response, code: number, path = PATH, method = 'get') {
  const statuses: Record<number, number> = {
    0: 200,
    10001: 401,
    10403: 403,
    20001: 400,
    30304: 422,
    50001: 500,
  };
  expect(response.statusCode, response.body).toBe(statuses[code]);
  const body = response.json<{
    code: number;
    msg: string;
    trace_id: string;
    data?: Record<string, unknown>;
  }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const operation = kit.document.paths[path]![method]!;
  const schema =
    operation.responses[code === 0 ? '200' : code >= 50000 ? '5XX' : '4XX']!.content[
      'application/json'
    ]!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}
export function signed(kit: Kit, response: Response, code = 0) {
  return envelope(kit, response, code, SIGN, 'post');
}
export async function port() {
  return (await import(new URL('apps/api/src/modules/identity/index.ts', ROOT).href)) as Pick<
    typeof Identity,
    'laborAgreementSigned'
  >;
}
export async function history(
  kit: Kit,
  f: Fixture,
  version: number,
  at: string,
  type = 'labor_agreement',
) {
  await sql`INSERT INTO app.consent_records (app_id, subject_type, user_id, device_id, type, version, accepted, channel, text_sha256, signer_snapshot, client_at, server_at, created_at)
    VALUES (${f.appId}, 'user', ${f.uid}, ${f.deviceId}, ${type}, ${version}, true, 'withdraw_flow', ${SHA}, ${JSON.stringify({ platform: { name: CONFIG['legal.operator_entity.name'], credit_code: CONFIG['legal.operator_entity.credit_code'] }, user: { user_id: f.uid, realname_id: f.realnameId, masked_name: '***明' } })}::jsonb, ${new Date(at)}, ${new Date(at)}, ${new Date(at)})`.execute(
    kit.db,
  );
}
export function privateDataAbsent(kit: Kit, responses: Response[], rows: unknown = []) {
  const text =
    kit.lines.join('\n') +
    responses.map((r) => r.body).join('\n') +
    JSON.stringify(rows, (_, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  for (const secret of [NAME, ID, '1949-12-31']) expect(text).not.toContain(secret);
}
