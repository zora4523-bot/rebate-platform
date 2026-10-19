// F1-02z §9: independent copy of the established admin fixture; no frozen-test imports.
// The database testing entry is supplied only by *.int.test.ts.
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { hashAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

const ROOT = new URL('../../../../', import.meta.url);
export const NOW = '2026-10-19T02:00:00.000Z';
export const LIST = '/admin/v1/agreements';
export const PUBLISH = `${LIST}/{type}/versions`;
export const DETAIL = `${PUBLISH}/{version}`;
export const H5 = 'https://h5.example.test/legal/';
export type Kind = Schema<'AgreementType'>;
export type Version = Schema<'AdminAgreementVersion'>;
export type Page = Schema<'AdminAgreementVersionList'>;
export type Detail = Schema<'AdminAgreementVersionDetail'>;
export type Publish = Schema<'AdminAgreementPublishRequest'>;
export const BODY =
  '{ "type": "doc", "content": [{"type":"paragraph","content":[{"type":"text","text":"协议原文"}]}] }';
export function input(patch: Partial<Publish> = {}): Publish {
  return {
    title: '协议',
    body: BODY,
    min_version: 1,
    requires_resign: false,
    legal_confirmed_by: ' 法务甲 ',
    legal_confirm_note: ' 已确认原文 ',
    legal_confirmed_on: '2026-10-18',
    expected_version: 0,
    ...patch,
  };
}
export interface Response {
  statusCode: number;
  json<T = { code: number; data: Record<string, unknown>; trace_id: string }>(): T;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress?: string;
  }): Promise<Response>;
  getHttpAdapter(): {
    getInstance(): { hasRoute(input: { method: string; url: string }): boolean };
  };
}
export interface TestingEntry {
  createTestDatabase(): Promise<{ urlFor(role: 'couli_app'): string; drop(): Promise<unknown> }>;
  acquireTestRedis(): Promise<{ url: string; stop(): Promise<unknown> }>;
}
export interface Overrides {
  config: ReturnType<typeof loadConfig>;
  clock: FixedClock;
  logger: ReturnType<typeof createRootLogger>;
  dbHandles: DbHandles;
  redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
}
export async function factory() {
  return (
    (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp(entry: 'admin' | 'api', options: Overrides): Promise<HttpApp>;
    }
  ).createHttpApp;
}
export interface Harness {
  db: Kysely<DB>;
  redisUrl: Overrides['redisUrl'];
  fields: FieldCrypto;
  env: Record<string, string>;
  passwordHash: string;
  apps: HttpApp[];
}
export function useHarness(load: () => Promise<TestingEntry>): Harness {
  const h = {} as Harness;
  let database: Awaited<ReturnType<TestingEntry['createTestDatabase']>> | undefined;
  let redis: Awaited<ReturnType<TestingEntry['acquireTestRedis']>> | undefined;
  let dir: string | undefined;
  beforeAll(async () => {
    h.apps = [];
    const testing = await load();
    database = await testing.createTestDatabase();
    h.db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 }).withSchema('app');
    redis = await testing.acquireTestRedis();
    h.redisUrl = loadConnectionConfig('admin', {
      DATABASE_URL: database.urlFor('couli_app'),
      DATABASE_READ_URL: database.urlFor('couli_app'),
      REDIS_URL: redis.url,
    }).redisUrl;
    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    dir = mkdtempSync(join(base, 'f102z-'));
    const master = randomBytes(32);
    const provider = new LocalKeyProvider(master);
    const wrapped = await createWrappedKeyring(provider);
    h.fields = await openFieldCrypto(wrapped, provider);
    const masterFile = join(dir, 'synthetic-master.hex');
    const keyringFile = join(dir, 'synthetic-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
    const jwt = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    h.env = {
      APP_ENV: 'test',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      ADMIN_TOKEN_SIGNING_KEY: Buffer.alloc(32, 1).toString('base64url'),
      ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
      ADMIN_CORS_ORIGIN: 'https://admin.example.test',
      MEDIA_PUBLIC_BASE_URL: 'https://media.example.test/assets/',
      JWT_KEY_ID: 'f102z',
      JWT_PRIVATE_KEY_PEM: jwt.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    h.passwordHash = await hashAdminPassword('Aaaaaaaaaaaaaaa1!');
  }, 180_000);
  afterEach(async () => {
    for (const app of h.apps.splice(0)) await app.close();
  });
  afterAll(async () => {
    try {
      if (h.db !== undefined) await destroyDb(h.db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await redis?.stop();
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  return h;
}
export async function setup(
  h: Harness,
  options: { h5?: boolean; media?: boolean; db?: Kysely<DB> } = {},
) {
  const clock = new FixedClock(NOW);
  const lines: string[] = [];
  const overrides: Overrides = {
    config: {
      ...loadConfig(h.env),
      ...(options.media === false ? { mediaPublicBaseUrl: undefined } : {}),
    },
    clock,
    logger: createRootLogger(
      { level: 'info', entry: 'admin', appEnv: 'test' },
      {
        write: (line) => {
          lines.push(line);
        },
      },
    ),
    dbHandles: { db: options.db ?? h.db, dbRead: null, close: async () => undefined },
    redisUrl: h.redisUrl,
  };
  const app = await (await factory())('admin', overrides);
  h.apps.push(app);
  await app.init();
  // Negative cases also fail by assertion until the actual routes are mounted.
  for (const [method, url] of [
    ['GET', LIST],
    ['POST', PUBLISH],
    ['GET', DETAIL],
  ] as const) {
    expect(
      app
        .getHttpAdapter()
        .getInstance()
        .hasRoute({ method, url: url.replace(/\{(\w+)\}/g, ':$1') }),
      `${method} ${url}`,
    ).toBe(true);
  }
  const appId = `f102z_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  if (options.h5 !== false) await config(h, appId, 'h5_base_url', H5);
  const actor = await seed(h, appId, true);
  const base = { app, clock, lines, overrides, appId, actor };
  const token = await signedIn(base, actor);
  return { ...base, token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;
export async function seed(h: Harness, appId: string, isSuper = false) {
  const id = randomUUID();
  const username = `f102z_${id}`;
  const secret = 'A'.repeat(32); // Synthetic TOTP secret, never a real credential.
  await h.db
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: username,
      password_hash: h.passwordHash,
      is_super: isSuper,
      status: 'active',
      password_must_change: false,
      totp_secret_cipher: Buffer.from(
        h.fields.encrypt(secret, `admin_users.totp_secret:${appId}:${id}`),
      ),
      totp_bound_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  return { id, username, secret, appId };
}
export type Actor = Awaited<ReturnType<typeof seed>>;
export interface Caller {
  token: string;
  actor: Actor;
}
export async function member(
  h: Harness,
  f: Setup,
  permissions: readonly string[],
): Promise<Caller> {
  const actor = await seed(h, f.appId);
  if (permissions.length > 0)
    await h.db
      .insertInto('admin_permissions')
      .values(
        permissions.map((permission_key) => ({
          app_id: f.appId,
          admin_id: actor.id,
          permission_key,
          granted_by: f.actor.id,
          granted_at: f.clock.now(),
          created_at: f.clock.now(),
        })),
      )
      .execute();
  return { actor, token: await signedIn(f, actor) };
}
function totp(clock: FixedClock): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(clock.now().getTime() / 30_000)));
  const mac = createHmac('sha1', Buffer.alloc(20)).update(counter).digest();
  return String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
async function auth(f: Pick<Setup, 'app'>, suffix: string, body: object, token?: string) {
  const response = await f.app.inject({
    method: 'POST',
    url: `/admin/v1/auth/${suffix}`,
    payload: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-trace-id': randomUUID(),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    remoteAddress: '127.0.0.1',
  });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  return response.json().data;
}
async function signedIn(f: Pick<Setup, 'app' | 'clock'>, actor: Actor): Promise<string> {
  const ticket = await auth(f, 'login', {
    username: actor.username,
    password: 'Aaaaaaaaaaaaaaa1!',
  });
  expect(ticket.next).toBe('totp');
  const session = await auth(f, 'totp', { login_ticket: ticket.login_ticket, code: totp(f.clock) });
  expect(session.admin_token).toEqual(expect.any(String));
  return session.admin_token as string;
}
export async function stepUp(f: Setup, caller: Caller = f): Promise<string> {
  f.clock.advanceMs(30_000);
  const grant = await auth(f, 'step-up', { tier: 'totp', code: totp(f.clock) }, caller.token);
  expect(grant.step_up_token).toEqual(expect.any(String));
  return grant.step_up_token as string;
}
export interface Sent {
  response: Response;
  trace: string;
}
export async function request(
  app: HttpApp,
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: object,
  step?: string,
): Promise<Sent> {
  const trace = randomUUID();
  const response = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'x-trace-id': trace,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(step === undefined ? {} : { 'x-step-up-token': step }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    remoteAddress: '127.0.0.1',
  });
  return { response, trace };
}
export const publish = (
  f: Pick<Setup, 'app' | 'token'>,
  type: Kind,
  body: Publish,
  step?: string,
) => request(f.app, f.token, 'POST', `${LIST}/${type}/versions`, body, step);
export const list = (f: Pick<Setup, 'app' | 'token'>, query = '') =>
  request(f.app, f.token, 'GET', `${LIST}${query}`);
export const detail = (f: Pick<Setup, 'app' | 'token'>, type: Kind, version: number) =>
  request(f.app, f.token, 'GET', `${LIST}/${type}/versions/${version}`);
export type Operation =
  'list' | 'publish' | 'detail' | 'article' | 'dictList' | 'dictSave' | 'dictRead' | 'dictRollback';
let validators:
  Promise<Map<string, ReturnType<ReturnType<typeof createValidatorCompiler>>>> | undefined;
async function checks() {
  validators ??= (async () => {
    const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          Record<
            string,
            { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> }
          >
        >;
      }>;
    };
    const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    const compile = createValidatorCompiler();
    const result = new Map<string, ReturnType<typeof compile>>();
    for (const [op, path, method] of [
      ['list', LIST, 'get'],
      ['publish', PUBLISH, 'post'],
      ['detail', DETAIL, 'get'],
      ['article', '/v1/articles/{article_id}', 'get'],
      ['dictList', '/admin/v1/dict-items', 'get'],
      ['dictSave', '/admin/v1/dict-items', 'put'],
      ['dictRollback', '/admin/v1/dict-items/rollback', 'post'],
      ['dictRead', '/v1/dict', 'get'],
    ] as const) {
      for (const status of ['200', '4XX', '5XX'])
        result.set(
          `${op}:${status}`,
          compile({
            schema:
              doc.paths[path]![method]!.responses[status]!.content['application/json']!.schema,
            httpPart: 'body',
          }),
        );
    }
    return result;
  })();
  return validators;
}
export async function validate(sent: Sent, op: Operation) {
  const status =
    sent.response.statusCode < 400 ? '200' : sent.response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await checks()).get(`${op}:${status}`)!;
  expect(check(sent.response.json()), JSON.stringify(check.errors)).toBe(true);
  expect(sent.response.json().trace_id).toBe(sent.trace);
}
export async function success<T>(sent: Sent, op: Operation): Promise<T> {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(200);
  expect(sent.response.json().code).toBe(0);
  await validate(sent, op);
  return sent.response.json<{ data: T }>().data;
}
export async function rejected(sent: Sent, op: Operation, code: number, data?: object) {
  const status =
    code === 10403 || code === 10003
      ? 403
      : code === 20902
        ? 409
        : code === 30701
          ? 404
          : code >= 50000
            ? 500
            : 400;
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(status);
  expect(sent.response.json().code).toBe(code);
  if (data !== undefined) expect(sent.response.json().data).toEqual(data);
  await validate(sent, op);
}
export async function config(
  h: Harness,
  appId: string,
  key: string,
  value: unknown,
  version = 1,
  rowVersion = 0,
) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: appId,
      key,
      value: sql`${JSON.stringify(value)}::jsonb`,
      version,
      row_version: rowVersion,
      updated_by: 'fixture',
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}
export async function snapshot(h: Harness, appId: string) {
  return {
    articles: await h.db
      .selectFrom('articles')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .orderBy('version')
      .execute(),
    agreements: await h.db
      .selectFrom('agreements')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('type')
      .orderBy('version')
      .execute(),
    items: await h.db
      .selectFrom('config_items')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .execute(),
    versions: await h.db
      .selectFrom('config_item_versions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .orderBy('version')
      .execute(),
    audits: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}
export async function publishOk(f: Setup, type: Kind = 'privacy', patch: Partial<Publish> = {}) {
  const step = await stepUp(f);
  return success<Version>(await publish(f, type, input(patch), step), 'publish');
}
