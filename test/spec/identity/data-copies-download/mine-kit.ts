// B1-27i fixtures, App side: the real AppModule of the api entry over a cloned test database and a
// real Redis (container runner only; the *.int.test.ts entry supplies both, this kit never imports
// db/testing), as identity/me-invite does it. Users, devices (POST /v1/devices), sessions
// (createSession with scope full or deletion_only), risk states, appeals, deletion requests, their
// registrant admin accounts and the copy requests are written by the test; a copy's file is put
// into the entry's own MemoryExportStore (EXPORT_STORE, test env). Nothing of the entry is replaced.
// Sources: 08 BR-ID-40 细则「在 App 内下载」, BR-ID-31, BR-ID-01 细则「受限会话」; contract
// listMyDataCopies / getMyDataCopyDownload (CT-24q); task §9 ④.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Selectable } from 'kysely';
import { expect } from 'vitest';
import {
  dataCopyObjectKey,
  EXPORT_STORE,
  type MemoryExportStore,
} from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import type { Response } from '../../admin/auth/kit.ts';
import { OPERATIONS, MY_COPIES, MY_DOWNLOAD, validate, withoutTrace } from './schema.ts';

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
}
interface TestRedis {
  url: string;
}
type Platform = typeof import('../../../../apps/api/src/modules/platform/index.ts');
type Crypto = typeof import('../../../../apps/api/src/modules/platform/crypto/index.ts');
type Sessions = typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
type Tokens = typeof import('../../../../apps/api/src/modules/identity/application/tokens.ts');
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
  getHttpAdapter(): {
    getInstance(): { hasRoute(options: { method: string; url: string }): boolean };
  };
}
type CreateHttpApp = (
  entry: 'api',
  options: Pick<
    Parameters<Platform['PlatformModule']['forRoot']>[0],
    'config' | 'clock' | 'logger' | 'dbHandles' | 'redisUrl'
  >,
) => Promise<HttpApp>;

const ROOT = new URL('../../../../', import.meta.url);
/** 2026-11-03 10:20 +08:00. */
export const NOW = '2026-11-03T02:20:00.000Z';
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** BR-ID-40 细则「在 App 内下载」 / BR-ID-42: a signed link lives at most 5 minutes. */
export const LINK_MS = 5 * MINUTE_MS;
/** The client version of the requests; app_versions of a fresh app requires it at least. */
export const VERSION = '2.0.0';

export type CopyRow = Selectable<DB['personal_data_copies']>;
export type CopyStatus =
  'pending' | 'running' | 'ready' | 'delivered' | 'failed' | 'expired' | 'cancelled';
export type Delivery = 'in_app_sms' | 'wecom_session';

/** One listed copy (DataCopyItem). */
export interface Item {
  copy_id: string;
  status: 'ready' | 'delivered';
  generated_at: string;
  expires_at: string;
}
/** A user download's response data (DataCopyDownload). */
export interface Link {
  url: string;
  url_expires_at: string;
}

export async function open(database: TestDatabase, server: TestRedis) {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as Platform;
  const crypto = (await import(
    new URL('apps/api/src/modules/platform/crypto/index.ts', ROOT).href
  )) as Crypto;
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as Sessions;
  const tokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as Tokens;
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-27i-'));
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  let app: HttpApp | undefined;
  try {
    const master = randomBytes(32);
    const keyring = await crypto.createWrappedKeyring(new crypto.LocalKeyProvider(master));
    writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
    writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
    const clock = new platform.FixedClock(NOW);
    const lines: string[] = [];
    const logger = platform.createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    );
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
    return {
      app,
      db,
      dir,
      clock,
      lines,
      store: app.get<MemoryExportStore>(EXPORT_STORE),
      tokens: app.get<Parameters<Sessions['createSession']>[2]['tokens']>(tokens.TOKEN_SERVICE),
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

export interface Call {
  /** The session scope (default full). */
  readonly scope?: 'full' | 'deletion_only';
  /** X-App-Version (default VERSION). */
  readonly version?: string;
  /** false: no Authorization header. */
  readonly authenticated?: boolean;
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * A user of a fresh app (or of `appId`), with one registered device and the admin account that
 * registers its copy requests. Asserts first that the api entry serves both routes, so every
 * integration case is red before they exist.
 */
export async function member(kit: Kit, options: { readonly appId?: string } = {}) {
  for (const key of ['list', 'mine'] as const) {
    const spec = OPERATIONS[key];
    expect(
      kit.app.getHttpAdapter().getInstance().hasRoute({ method: spec.verb, url: spec.route }),
      `api 入口必须挂载 ${spec.verb} ${spec.path}`,
    ).toBe(true);
  }
  const appId = options.appId ?? `dd_${randomBytes(10).toString('hex')}`;
  if (options.appId === undefined) {
    await sql`INSERT INTO app.app_versions
      (id, app_id, platform, channel, latest_version, min_supported_version, update_title,
       update_notes, store_url, default_store, store_listings)
      VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', ${VERSION}, ${VERSION}, 'fixture',
       'fixture', 'https://example.test/app', 'appstore', '[]'::jsonb)`.execute(kit.db);
  }
  const uid = randomUUID();
  const inviteCode = [...randomBytes(6)].map((n) => ALPHABET[n % ALPHABET.length]).join('');
  const created = new Date(kit.clock.now().getTime() - 30 * DAY_MS);
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, phone_hmac,
     created_at, updated_at)
    VALUES (${uid}, ${appId}, '副本下载测试用户', 'https://example.test/avatar.png', ${inviteCode},
      ${randomUUID()}, 'L1', 'wechat', ${randomBytes(32).toString('hex')}, ${created}, ${created})`.execute(
    kit.db,
  );
  const registrant = randomUUID();
  await kit.db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      id: registrant,
      app_id: appId,
      login_name: `dd_${registrant}`,
      password_hash: 'synthetic-unused',
      is_super: false,
      status: 'active',
      created_at: created,
      updated_at: created,
    })
    .execute();
  const headers = {
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
  };
  const registered = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers, 'x-app-version': VERSION, 'content-type': 'application/json' },
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(registered.statusCode).toBe(200);
  const device = registered.json<{ data: { device_id: string } }>().data;
  expect(typeof device.device_id).toBe('string');

  async function get(url: string, call: Call = {}): Promise<Response> {
    // A session issued at the current instant of the Clock (the tests move it).
    const session = await kit.db
      .withSchema('app')
      .transaction()
      .execute((trx) =>
        kit.createSession(
          trx,
          { uid, app_id: appId, device_id: device.device_id, scp: call.scope ?? 'full' },
          { clock: kit.clock, tokens: kit.tokens },
        ),
      );
    return kit.app.inject({
      method: 'GET',
      url,
      headers: {
        ...headers,
        'x-app-version': call.version ?? VERSION,
        'x-device-id': device.device_id,
        'x-trace-id': randomUUID(),
        ...(call.authenticated === false
          ? {}
          : { authorization: `Bearer ${session.access_token}` }),
      },
    });
  }

  return {
    appId,
    uid,
    registrant,
    get,
    /** GET /v1/me/data-copies. */
    list: (call: Call = {}) => get(MY_COPIES, call),
    /** GET /v1/me/data-copies/{id}/download. */
    download: (id: string, call: Call = {}) =>
      get(MY_DOWNLOAD.replace('{id}', encodeURIComponent(id)), call),
  };
}
export type Member = Awaited<ReturnType<typeof member>>;

export interface CopySpec {
  readonly delivery?: Delivery;
  readonly status?: CopyStatus;
  readonly generatedAt?: Date | null;
  readonly expiresAt?: Date | null;
}

/**
 * A copy request of `owner` written directly (synthetic fixture). Defaults: in_app_sms, delivered,
 * generated an hour ago (expired: 25 hours ago), expiring 24 hours after generation; ready and
 * delivered ones hold a file in the store.
 */
export async function copy(kit: Kit, owner: Member, spec: CopySpec = {}): Promise<CopyRow> {
  const id = randomUUID();
  const now = kit.clock.now().getTime();
  const status = spec.status ?? 'delivered';
  const generated =
    status === 'expired'
      ? new Date(now - DAY_MS - HOUR_MS)
      : status === 'ready' || status === 'delivered'
        ? new Date(now - HOUR_MS)
        : null;
  const generatedAt = spec.generatedAt === undefined ? generated : spec.generatedAt;
  const expiresAt =
    spec.expiresAt === undefined
      ? generatedAt === null
        ? null
        : new Date(generatedAt.getTime() + DAY_MS)
      : spec.expiresAt;
  let objectKey: string | null = null;
  if (status === 'ready' || status === 'delivered') {
    objectKey = dataCopyObjectKey(owner.appId, id, 'seed');
    await kit.store.put({ key: objectKey, bytes: randomBytes(96), contentType: 'application/zip' });
  }
  const created = new Date(now - 2 * DAY_MS);
  return kit.db
    .withSchema('app')
    .insertInto('personal_data_copies')
    .values({
      id,
      app_id: owner.appId,
      user_id: owner.uid,
      requested_by: owner.registrant,
      delivery: spec.delivery ?? 'in_app_sms',
      status,
      retry_of: null,
      object_key: objectKey,
      due_at: new Date(now + 10 * DAY_MS),
      generated_at: generatedAt,
      delivered_at:
        status === 'delivered' && generatedAt !== null
          ? new Date(generatedAt.getTime() + MINUTE_MS)
          : null,
      expires_at: expiresAt,
      failure_reason: status === 'failed' ? '副本文件生成失败，请重新登记' : null,
      created_at: created,
      updated_at: created,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The user's risk state (BR-ID-31; same row shape as identity/me-invite). */
export async function risk(kit: Kit, owner: Member, state: 'banned' | 'appealing') {
  await sql`INSERT INTO app.user_risk_state
    (app_id, user_id, state, reason_category, frozen_until, changed_by, changed_at)
    VALUES (${owner.appId}, ${owner.uid}, ${state}, 'other', null, 'fixture', ${kit.clock.now()})
    ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state,
      reason_category = EXCLUDED.reason_category, frozen_until = EXCLUDED.frozen_until,
      row_version = app.user_risk_state.row_version + 1,
      changed_at = EXCLUDED.changed_at`.execute(kit.db);
  if (state === 'appealing') {
    await sql`INSERT INTO app.appeals
      (id, app_id, user_id, target_type, target_id, prev_risk_state, status, content, deadline_at)
      VALUES (${randomUUID()}, ${owner.appId}, ${owner.uid}, 'account', ${owner.uid}, 'banned',
        'processing', 'fixture', ${new Date(kit.clock.now().getTime() + 7 * DAY_MS)})`.execute(
      kit.db,
    );
  }
}

/** A deletion request of `owner` in `status` (BR-ID-27), consistent with the Clock. */
export async function deletion(kit: Kit, owner: Member, status: 'cooling' | 'processing' | 'done') {
  const now = kit.clock.now().getTime();
  const applied = status === 'cooling' ? now - DAY_MS : now - 20 * DAY_MS;
  await kit.db
    .withSchema('app')
    .insertInto('deletion_requests')
    .values({
      id: randomUUID(),
      app_id: owner.appId,
      user_id: owner.uid,
      status,
      apply_at: new Date(applied),
      cooling_until: new Date(applied + 7 * DAY_MS),
      processed_at: status === 'done' ? new Date(applied + 8 * DAY_MS) : null,
      balance_snapshot_fen: 0n,
    })
    .execute();
}

/** A contract date-time as epoch milliseconds. */
export const ms = (value: string | Date | null) =>
  value === null ? null : new Date(value).getTime();

/** A 200 list: envelope and the contract's 200 schema; returns the items. */
export async function listed(response: Response): Promise<Item[]> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, trace_id: expect.any(String) });
  await validate(response, 'list');
  return response.json<{ data: { items: Item[] } }>().data.items;
}

/** A row as the list shows it (instants as milliseconds, for comparisons). */
export const itemOf = (row: CopyRow) => ({
  copy_id: row.id,
  status: row.status,
  generated_at: ms(row.generated_at),
  expires_at: ms(row.expires_at),
});
/** Listed items with their instants as milliseconds. */
export const itemsOf = (items: readonly Item[]) =>
  items.map((item) => ({
    copy_id: item.copy_id,
    status: item.status,
    generated_at: ms(item.generated_at),
    expires_at: ms(item.expires_at),
  }));

/** A 200 download: envelope, Cache-Control: no-store and the contract's 200 schema. */
export async function linked(response: Response): Promise<Link> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, trace_id: expect.any(String) });
  expect(response.headers['cache-control']).toBe('no-store');
  await validate(response, 'mine');
  const data = response.json<{ data: Link }>().data;
  expect(Object.keys(data).sort(), '只给链接与有效期，不带提取码').toEqual([
    'url',
    'url_expires_at',
  ]);
  return data;
}

/** 30701 (HTTP 404) with the contract's 4XX schema; returns the body without trace_id. */
export async function notFound(response: Response): Promise<Record<string, unknown>> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(404);
  expect(response.json()).toMatchObject({ code: 30701, trace_id: expect.any(String) });
  await validate(response, 'mine');
  return withoutTrace(response);
}

/** The link names `row`'s object key and is valid now (memory store: <base>/<key>?...). */
export function expectLinkTo(kit: Kit, link: Link, row: CopyRow) {
  expect(row.object_key).not.toBeNull();
  expect(link.url).toContain(`/${row.object_key}?`);
  expect(kit.store.verify(link.url, kit.clock.now()), 'the link must be valid now').toBe(true);
  expect(
    kit.store.verify(link.url, new Date(Date.parse(link.url_expires_at))),
    'the link ends at url_expires_at',
  ).toBe(false);
}
