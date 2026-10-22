import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { hashAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  EXPORT_STORE,
  type ExportStore,
} from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import type { JobQueue } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  apiRequire,
  fixture,
  ORIGIN,
  signedIn,
  totp,
  type Harness,
  type Response,
} from '../auth/kit.ts';
import { grant, seed } from '../accounts/kit.ts';
import { guardOf } from '../guard-mount/kit.ts';
import { ok as stepOk, STEP, type Grant } from '../step-up/kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const LIST = '/admin/v1/exports';
export const DOWNLOAD = `${LIST}/{id}/download`;
export const RETRY = `${LIST}/{id}/retry`;
export type View = Schema<'AdminExport'>;
export type Page = Schema<'AdminExportPage'>;
export type Download = Schema<'AdminExportDownload'>;

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  url: string;
  stop(): Promise<void>;
}

/** Provisioners are passed by integration test files; the kit imports no database test entry. */
export function harness(
  provision: () => Promise<TestDatabase>,
  redis: () => Promise<TestRedis>,
): Harness {
  const h = {} as Harness;
  let database: TestDatabase | undefined;
  let dir: string | undefined;
  beforeAll(async () => {
    h.apps = [];
    database = await provision();
    h.db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 }).withSchema('app');
    h.redis = await redis();
    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    dir = mkdtempSync(join(base, 'b1-34f-'));
    const master = randomBytes(32);
    const provider = new LocalKeyProvider(master);
    const wrapped = await createWrappedKeyring(provider);
    h.fields = await openFieldCrypto(wrapped, provider);
    const masterFile = join(dir, 'master.hex');
    const keyringFile = join(dir, 'keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
    h.appKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    h.env = {
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      ADMIN_TOKEN_SIGNING_KEY: randomBytes(32).toString('base64url'),
      ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
      ADMIN_CORS_ORIGIN: ORIGIN,
      JWT_KEY_ID: 'b1-34f-app',
      JWT_PRIVATE_KEY_PEM: h.appKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    h.password = randomBytes(24).toString('base64url');
    h.passwordHash = await hashAdminPassword(h.password);
  }, 180_000);
  afterEach(async () => {
    for (const app of h.apps.splice(0)) await app.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    try {
      if (h.db !== undefined) await destroyDb(h.db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await h.redis?.stop();
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  return h;
}

export async function setup(
  h: Harness,
  permissions: readonly string[] = ['export', 'user.list', 'pii.reveal_phone'],
  isSuper = false,
) {
  const f = await fixture(h);
  const appId = `e_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const actor = await seed(h, appId, { isSuper });
  if (permissions.length > 0) await grant(h, actor, actor, permissions);
  const session = await signedIn(f, actor);
  const guard = await guardOf(f.app);
  const guarded = vi.spyOn(guard, 'run');
  const { JOB_QUEUE } = (await import(
    new URL('apps/api/src/modules/platform/platform.module.ts', ROOT).href
  )) as { JOB_QUEUE: symbol };
  const queue = f.app.get<JobQueue>(JOB_QUEUE);
  const realSend = queue.send.bind(queue);
  const send = vi.spyOn(queue, 'send');
  const store = f.app.get<ExportStore>(EXPORT_STORE);
  const sign = vi.spyOn(store, 'signedUrl');
  const request = (
    method: 'GET' | 'POST',
    url: string,
    body?: object,
    stepToken?: string,
    token = session.admin_token,
  ) =>
    f.app.inject({
      method,
      url,
      remoteAddress: '127.0.0.1',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(stepToken === undefined ? {} : { 'x-step-up-token': stepToken }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const create = (body: object = { resource: 'users', filters: {} }, step?: string) =>
    request('POST', LIST, body, step);
  const list = (query = '') => request('GET', `${LIST}${query}`);
  const download = (id: string) => request('GET', `${LIST}/${id}/download`);
  const retry = (id: string, body: object = {}, step?: string) =>
    request('POST', `${LIST}/${id}/retry`, body, step);
  const issue = async () => {
    f.clock.advanceMs(30_000);
    return stepOk<Grant>(
      await f.post(
        '/step-up',
        {
          tier: 'totp',
          code: totp(actor.secret, f.clock),
        },
        { authorization: `Bearer ${session.admin_token}` },
      ),
      STEP,
    );
  };
  const revoke = (permission: string) =>
    h.db
      .deleteFrom('admin_permissions')
      .where('app_id', '=', appId)
      .where('admin_id', '=', actor.id)
      .where('permission_key', '=', permission)
      .execute();
  const tasks = () =>
    h.db.selectFrom('export_tasks').selectAll().where('app_id', '=', appId).execute();
  const read = (id: string) =>
    h.db
      .selectFrom('export_tasks')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const audits = () =>
    h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .where('action', 'like', 'export_%')
      .orderBy('id')
      .execute();
  const task = async (patch: Partial<Insertable<DB['export_tasks']>> = {}) => {
    const publicId = `exp_${randomUUID().replaceAll('-', '')}`;
    return h.db
      .insertInto('export_tasks')
      .values({
        id: randomUUID(),
        app_id: appId,
        public_id: publicId,
        created_by: actor.id,
        resource: 'users',
        filters: {},
        filters_summary: '风控状态：全部',
        masked: true,
        status: 'failed',
        progress: null,
        failure_reason: '演示失败',
        file_name: null,
        object_key: null,
        row_count: null,
        generated_at: null,
        expires_at: null,
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
        ...patch,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  };
  const done = async (
    remainingMs = 3_600_000,
    masked = true,
    patch: Partial<Pick<Insertable<DB['export_tasks']>, 'resource' | 'app_id' | 'created_by'>> = {},
  ) => {
    const row = await task({
      status: 'done',
      progress: 100,
      failure_reason: null,
      masked,
      file_name: 'users.csv',
      row_count: 4,
      generated_at: f.clock.now(),
      expires_at: new Date(f.clock.now().getTime() + remainingMs),
      ...patch,
    });
    const key = `${row.app_id}/${row.public_id}.csv`;
    const completed = await h.db
      .updateTable('export_tasks')
      .set({ object_key: key })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await store.put({
      key,
      bytes: Buffer.from('phone\r\n138****5678\r\n'),
      contentType: 'text/csv',
    });
    return completed;
  };
  return {
    ...f,
    appId,
    actor,
    session,
    guarded,
    queue,
    realSend,
    send,
    store,
    sign,
    request,
    create,
    list,
    download,
    retry,
    issue,
    revoke,
    tasks,
    read,
    audits,
    task,
    done,
  };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

type Operation = {
  operationId: string;
  'x-auth': string;
  'x-implementation'?: string;
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
};
let document: Promise<{ paths: Record<string, Record<string, Operation>> }> | undefined;
export function contract() {
  document ??= (
    apiRequire('@readme/openapi-parser') as {
      dereference(path: string, options: object): NonNullable<typeof document>;
    }
  ).dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
  return document;
}
export async function validate(response: Response, path = LIST, method = 'post') {
  const status =
    response.statusCode < 400
      ? String(response.statusCode)
      : response.statusCode < 500
        ? '4XX'
        : '5XX';
  const schema = (await contract()).paths[path]![method]!.responses[status]!.content[
    'application/json'
  ]!.schema;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}
export async function ok<T>(response: Response, path = LIST, method = 'post'): Promise<T> {
  expect(response.statusCode).toBe(path === LIST && method === 'post' ? 202 : 200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, path, method);
  return response.json<{ data: T }>().data;
}
export async function error(
  response: Response,
  code: number,
  data: object | undefined,
  path = LIST,
  method = 'post',
) {
  expect(response.statusCode).toBe(
    code === 30417
      ? 422
      : code === 10001
        ? 401
        : code === 10003 || code === 10403
          ? 403
          : code >= 50000
            ? 500
            : 400,
  );
  expect(response.json()).toMatchObject({ code });
  expect(response.json().data).toEqual(data);
  await validate(response, path, method);
}
export function text(value: unknown) {
  return JSON.stringify(value, (_key, child: unknown) =>
    typeof child === 'bigint' ? String(child) : child,
  );
}
