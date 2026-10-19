// F1-02zd: independent fixture adapted from the established admin HTTP setup.
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
export type AdminDict = Schema<'AdminDict'>;
export const KEYS = {
  general: 'admin_dict.appeal_status.processing',
  second: 'admin_dict.union_accounts.last_probe_ok.true',
  fund: 'admin_dict.withdrawal_status.APPROVED',
  commission: 'admin_dict.risk_action.void_commission',
  high: 'admin_dict.withdrawals.auto_decision.failed_conditions.warn_high_commission',
  public: 'about.copy_diagnostics',
  unknown: 'admin_dict.missing_enum.missing_code',
} as const;
export const ROUTES = {
  read: { method: 'GET', path: '/admin/v1/dict' },
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
  entry: 'admin' | 'api',
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
  const dir = mkdtempSync(join(base, 'f1_02zd_'));
  const apps: HttpApp[] = [];
  // Pause after PG produces the version SELECT; a second connection commits while
  // the read is paused. No sleeps and no SQL result substitution.
  const reads = new Set<object>();
  const probe: { afterVersion?: () => Promise<void> } = {};
  const store = db.withPlugin({
    transformQuery({ node, queryId }) {
      const encoded = JSON.stringify(node, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      if (
        node.kind === 'SelectQueryNode' &&
        encoded.includes('"name":"config_items"') &&
        encoded.includes('"value":"dict_version"')
      )
        reads.add(queryId);
      return node;
    },
    async transformResult({ result, queryId }) {
      if (reads.delete(queryId)) await probe.afterVersion?.();
      return result;
    },
  });
  const logs: string[] = [];
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
      JWT_KEY_ID: 'f1_02zd_test',
      JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp: CreateHttpApp;
    };
    const app = await createHttpApp('admin', {
      config,
      clock,
      logger: createRootLogger(
        { level: 'warn', entry: 'admin', appEnv: 'test' },
        { write: (line: string) => void logs.push(line) },
      ),
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
      probe,
      logs,
      app,
      clock,
      tokenKey,
      async startApi() {
        const api = await createHttpApp('api', {
          config,
          clock,
          logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
          dbHandles: { db, dbRead: null, close: async () => undefined },
          redisUrl: loadConnectionConfig('api', { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl })
            .redisUrl,
        });
        apps.push(api);
        await api.init();
        return api;
      },
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
  const appId = `f102zd_${randomBytes(10).toString('hex')}`;
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
        'x-auth'?: string;
        operationId: string;
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
  options: {
    token?: string;
    stepUp?: string;
    query?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const route = ROUTES[op];
  const response = await f.app.inject({
    method: route.method,
    url: route.path + (options.query ?? ''),
    headers: {
      ...options.headers,
      authorization: `Bearer ${options.token ?? f.token}`,
      'x-trace-id': randomUUID(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.stepUp === undefined ? {} : { 'x-step-up-token': options.stepUp }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    remoteAddress: '127.0.0.1',
  });
  expect(response.statusCode, `${route.path} must not return a missing route`).not.toBe(404);
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
    code === 10001
      ? 401
      : code === 10403 || code === 10003
        ? 403
        : code === 20902
          ? 409
          : code >= 50000
            ? 500
            : 400,
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
export async function seedVersion(h: Harness, appId: string, value: unknown, version = 1) {
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
export function defaults(
  file: 'texts.default.json' | 'texts.admin.default.json',
): Record<string, string> {
  return (
    JSON.parse(readFileSync(new URL(`contracts/${file}`, ROOT), 'utf8')) as {
      texts: Record<string, string>;
    }
  ).texts;
}
/** Independent oracle: regexp captures the final dot, not the store's first-dot split. */
export function expectedItems(overrides: Record<string, string> = {}): AdminDict['items'] {
  const groups = new Map<string, [string, string][]>();
  for (const [key, text] of Object.entries({
    ...defaults('texts.admin.default.json'),
    ...overrides,
  })) {
    const match = /^admin_dict\.(.+)\.([^.]+)$/.exec(key);
    if (match === null) throw new Error(`invalid fixture key: ${key}`);
    const group = groups.get(match[1]!) ?? [];
    group.push([match[2]!, text]);
    groups.set(match[1]!, group);
  }
  return Object.fromEntries([...groups].map(([key, values]) => [key, Object.fromEntries(values)]));
}
export async function readPublic(app: HttpApp, appId: string): Promise<AdminDict> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/dict',
    remoteAddress: '127.0.0.1',
    headers: {
      'x-app-id': appId,
      'x-platform': 'ios',
      'x-app-version': '2.0.0',
      'x-trace-id': randomUUID(),
    },
  });
  const schema = (await contract()).paths['/v1/dict']!.get!.responses['200']!.content[
    'application/json'
  ]!.schema;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  return success<AdminDict>(response);
}
