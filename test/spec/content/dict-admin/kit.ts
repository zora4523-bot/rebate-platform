// F1-02t §9: standalone fixtures, no imports from other tasks' frozen tests.
// Real admin token/session and step-up grants seed authenticated callers; the HTTP
// token check, permission guard, controller, transaction and audit writer remain real.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import { createAdminStepUpTokens } from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  FixedClock,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type RedisHandle,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export type ItemPage = Schema<'AdminDictItemPage'>;
export type HistoryPage = Schema<'AdminDictItemVersionPage'>;
export type Saved = Schema<'AdminDictSaveResult'>;
export const ROOT = new URL('../../../../', import.meta.url);
export const KEYS = {
  // F1-02zzg：与 texts 内容解耦（CT-16i 新增 about.* 键）。general/second 须是 texts.default.json 里
  // 归 general 的一对嵌套键，且整个 dict 只有这两个键（#1 按 dict 前缀、#8 按 general 前缀列默认全集）。
  general: 'notify_settings.service_push',
  second: 'notify_settings.service_push.desc',
  variable: 'agent.match.title_shows',
  fund: 'order_status_group.credited',
  agreement: 'privacy.btn.agree',
  unknown: 'unclassified.test_key',
} as const;
export const ROUTES = {
  list: { method: 'GET', path: '/admin/v1/dict-items' },
  save: { method: 'PUT', path: '/admin/v1/dict-items' },
  history: { method: 'GET', path: '/admin/v1/dict-items/versions' },
  rollback: { method: 'POST', path: '/admin/v1/dict-items/rollback' },
} as const;
export type Operation = keyof typeof ROUTES;
export interface Response {
  statusCode: number;
  json<T = { code: number; data: Record<string, unknown> }>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(input: {
    method: 'GET' | 'PUT' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response>;
  getHttpAdapter(): {
    getInstance(): { hasRoute(input: { method: string; url: string }): boolean };
  };
}
type CreateHttpApp = (
  entry: 'admin',
  overrides: {
    config: ReturnType<typeof loadConfig>;
    clock: FixedClock;
    logger: ReturnType<typeof createRootLogger>;
    dbHandles: DbHandles;
    redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
  },
) => Promise<HttpApp>;

export async function harness(db: Kysely<DB>, databaseUrl: string, redisUrl: string) {
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'f1_02t_'));
  const apps: HttpApp[] = [];
  // Fail the final business audit insert, after preceding writes have reached real PG.
  const fault = { audit: false };
  const store = db.withPlugin({
    transformQuery({ node }) {
      if (
        fault.audit &&
        node.kind === 'InsertQueryNode' &&
        JSON.stringify(node.into).includes('"name":"audit_logs"')
      ) {
        throw new Error('synthetic dict audit unavailable');
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const clock = new FixedClock('2026-10-19T01:00:00.000Z');
  const tokenKey = randomBytes(32);
  try {
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(dir, 'synthetic-master.hex');
    const keyringFile = join(dir, 'synthetic-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const config = loadConfig({
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
      ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
      ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
      JWT_KEY_ID: 'f1_02t_test',
      JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp: CreateHttpApp;
    };
    const app = await createHttpApp('admin', {
      config,
      clock,
      logger: createRootLogger({ level: 'silent', entry: 'admin', appEnv: 'test' }),
      dbHandles: { db: store, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: databaseUrl,
        DATABASE_READ_URL: databaseUrl,
        REDIS_URL: redisUrl,
      }).redisUrl,
    });
    apps.push(app);
    await app.init();
    return {
      db: store.withSchema('app'),
      fault,
      app,
      clock,
      tokenKey,
      async close() {
        try {
          for (const instance of apps) await instance.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      for (const instance of apps) await instance.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof harness>>;

export async function member(h: Harness, appId: string, permissions: readonly string[]) {
  const id = randomUUID();
  const loginName = `dict_${id}`;
  await h.db
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: loginName,
      password_hash: 'unused-test-login',
      is_super: false,
      status: 'active',
      password_must_change: false,
      totp_bound_at: h.clock.now(),
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .execute();
  if (permissions.length > 0) {
    await h.db
      .insertInto('admin_permissions')
      .values(
        permissions.map((permission_key) => ({
          app_id: appId,
          admin_id: id,
          permission_key,
          granted_by: id,
          granted_at: h.clock.now(),
        })),
      )
      .execute();
  }
  const { token, claims } = await createAdminTokens({ key: h.tokenKey, clock: h.clock }).issue({
    adminId: id,
    appId,
  });
  await createAdminSessions({
    redis: h.app.get<RedisHandle>(REDIS).namespace('admin-auth'),
    clock: h.clock,
  }).create(claims.sessionId, {
    adminId: id,
    appId,
    expiresAtMs: claims.expiresAt * 1000,
    lastSeenMs: h.clock.now().getTime(),
  });
  return { id, loginName, token, sessionId: claims.sessionId, appId };
}
export async function setup(h: Harness) {
  for (const route of Object.values(ROUTES)) {
    expect(
      h.app.getHttpAdapter().getInstance().hasRoute({
        method: route.method,
        url: route.path,
      }),
      `${route.method} ${route.path} must be registered`,
    ).toBe(true);
  }
  const appId = `f102t_${randomBytes(10).toString('hex')}`;
  const actor = await member(h, appId, ['config.general']);
  return { ...actor, actor, app: h.app };
}
export type Setup = Awaited<ReturnType<typeof setup>>;
export async function stepUp(h: Harness, actor: Setup['actor'], tier: 'totp' | 'sms' = 'totp') {
  h.clock.advanceMs(30_000);
  const grant = await createAdminStepUpTokens({
    clock: h.clock,
    redis: h.app.get<RedisHandle>(REDIS).namespace('admin-step-up'),
  }).issue({ appId: actor.appId, adminId: actor.id, sessionId: actor.sessionId, tier });
  return grant.step_up_token;
}

const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
interface Contract {
  paths: Record<
    string,
    Record<
      string,
      {
        'x-implementation'?: string;
        responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
      }
    >
  >;
}
let contractPromise: Promise<Contract> | undefined;
export function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Contract>;
  };
  return (contractPromise ??= parser.dereference(
    fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
    {
      resolve: { external: false },
    },
  ));
}
export async function send(
  f: Pick<Setup, 'app' | 'token'>,
  op: Operation,
  body?: object,
  options: { token?: string; stepUp?: string; query?: string } = {},
) {
  const route = ROUTES[op];
  const response = await f.app.inject({
    method: route.method,
    url: route.path + (options.query ?? ''),
    headers: {
      authorization: `Bearer ${options.token ?? f.token}`,
      'x-trace-id': randomUUID(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.stepUp === undefined ? {} : { 'x-step-up-token': options.stepUp }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    remoteAddress: '127.0.0.1',
  });
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contract()).paths[route.path]![route.method.toLowerCase()]!.responses[
    status
  ]!.content['application/json']!.schema;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  return response;
}
export function success<T>(response: Response): T {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json().code).toBe(0);
  return response.json<{ data: T }>().data;
}
export function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode).toBe(
    code === 10403 || code === 10003 ? 403 : code === 20902 ? 409 : code >= 50000 ? 500 : 400,
  );
  expect(response.json().code).toBe(code);
  if (data !== undefined) expect(response.json().data).toEqual(data);
}
export async function snapshot(h: Harness, appId: string) {
  return {
    items: await h.db
      .selectFrom('dict_items')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('version')
      .orderBy('dict')
      .orderBy('code')
      .execute(),
    config: await h.db
      .selectFrom('config_items')
      .selectAll()
      .where('app_id', '=', appId)
      .where('key', '=', 'dict_version')
      .execute(),
    versions: await h.db
      .selectFrom('config_item_versions')
      .selectAll()
      .where('app_id', '=', appId)
      .where('key', '=', 'dict_version')
      .orderBy('version')
      .execute(),
    audits: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .where('action', 'in', ['dict_items_save', 'dict_items_rollback', 'dict_items_denied'])
      .orderBy('id')
      .execute(),
  };
}
export async function seedItem(
  h: Harness,
  f: Setup,
  key: string,
  version: number,
  text: string | null,
) {
  const dot = key.indexOf('.');
  await h.db
    .insertInto('dict_items')
    .values({
      app_id: f.appId,
      dict: dot < 0 ? key : key.slice(0, dot),
      code: dot < 0 ? '' : key.slice(dot + 1),
      version,
      text,
      created_by: f.actor.id,
      created_at: h.clock.now(),
    })
    .execute();
}
export async function seedVersion(h: Harness, appId: string, value: string, version = 1) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: appId,
      key: 'dict_version',
      value: JSON.stringify(value),
      version,
      updated_by: 'fixture',
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .execute();
}
export function defaults(): Record<string, string> {
  return (
    JSON.parse(readFileSync(new URL('contracts/texts.default.json', ROOT), 'utf8')) as {
      texts: Record<string, string>;
    }
  ).texts;
}
/**
 * F1-02zg (test-change): the console-only default names (CT-02w contracts/texts.admin.default.json).
 * The orchestrator ruled (2026-10-20 04:0x) that dict-items accepts keys of both default files;
 * a key present in both files is a fixture error.
 */
export function defaultsWithAdmin(): Record<string, string> {
  const base = defaults();
  const admin = (
    JSON.parse(readFileSync(new URL('contracts/texts.admin.default.json', ROOT), 'utf8')) as {
      texts: Record<string, string>;
    }
  ).texts;
  for (const key of Object.keys(admin)) {
    if (key in base) throw new Error(`key in both default files: ${key}`);
  }
  return { ...base, ...admin };
}
