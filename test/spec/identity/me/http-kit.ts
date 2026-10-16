// B1-02z GET /v1/me rule tests: real PG + Redis, HTTP level through the api entry (createHttpApp),
// same suite as test/spec/identity/tips. Fixtures write rows directly (test-owned setup); nothing
// here calls a B1-02z skeleton. Every fixture uses a fresh app_id, and every row it needs is in
// place before the first GET of that user, so no read cache (risk ≤60 s, content config) can hold
// an older value. Sources: 04 §6.1, §2.5; 08 BR-ID-01, BR-ID-12, BR-INV-07, BR-INV-18, BR-INV-21;
// task brief §9.3.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { Response } from '../sms-codes/http-kit.ts';
import { seedUser } from '../registration/kit.ts';
import { openKit, closeKit, type Kit } from '../tips/http-kit.ts';

export { openKit, closeKit, type Kit };

const ROOT = new URL('../../../../', import.meta.url);
export const ME = '/v1/me';
/** A whole second, so 168 h later is the boundary itself whatever precision is kept. */
export const CREATED = '2031-05-06T07:08:09.000Z';
export const HOUR = 3_600_000;
/** The default backfill window (BR-INV-07 (b) / BR-INV-21: 168 hours). */
export const BACKFILL_MS = 168 * HOUR;
/** domain/registration.ts DEFAULT_AVATAR: what a new account is created with. */
export const DEFAULT_AVATAR = 'avatar:default';
export const NICKNAME = '凑狸用户 8000';
export type Scope = 'full' | 'deletion_only';
export type Platform = 'taobao' | 'pdd';

export interface Me {
  user_id: string;
  nickname: string;
  avatar_url: string;
  invite_code: string | null;
  inviter_bound: boolean;
  invite_backfill: { eligible: boolean; deadline_at: string | null };
  identity_level: string;
  phone_bound: boolean;
  balance: { available_fen: number; withdrawable_fen: number; estimated_total_fen: number };
  union_bindings: { platform: string; status: string }[];
  realname_status: string;
  need_reconsent: boolean;
  risk: { state: string; reason_category: string | null; frozen_until: string | null };
}

export function instant(offsetMs: number): Date {
  return new Date(Date.parse(CREATED) + offsetMs);
}

export interface UserOptions {
  appId?: string;
  method?: string;
  phone?: boolean;
  parentId?: string;
  selfBindUsed?: boolean;
  avatar?: string;
}

/** A new app (app_versions row) and one user created at CREATED; the Clock is CREATED + 1 h. */
export async function fixture(kit: Kit, options: UserOptions = {}) {
  kit.clock.set(instant(HOUR));
  const appId = options.appId ?? `me_${randomBytes(12).toString('hex')}`;
  const db = kit.suite.db.withSchema('app');
  if (options.appId === undefined) {
    await db
      .insertInto('app_versions')
      .values({
        id: randomUUID(),
        app_id: appId,
        platform: 'ios',
        channel: 'appstore',
        latest_version: '2.0.0',
        min_supported_version: '2.0.0',
        update_title: 'test',
        update_notes: 'test',
        store_url: 'https://example.test/app',
        default_store: 'appstore',
        store_listings: JSON.stringify([]),
      })
      .execute();
  }
  const uid = await seedUser(db, appId, {
    method: options.method ?? 'wechat',
    ...(options.phone ? { phoneHmac: randomBytes(32).toString('hex') } : {}),
  });
  await sql`UPDATE app.users SET nickname = ${NICKNAME},
      avatar = ${options.avatar ?? DEFAULT_AVATAR},
      created_at = ${new Date(CREATED)},
      parent_id = ${options.parentId ?? null},
      parent_bind_source = ${options.parentId === undefined ? null : 'register'},
      parent_bound_at = ${options.parentId === undefined ? null : new Date(CREATED)},
      self_bind_used = ${options.selfBindUsed ?? options.parentId !== undefined}
    WHERE app_id = ${appId} AND id = ${uid}`.execute(kit.suite.db);
  const row = () =>
    db
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', uid)
      .executeTakeFirstOrThrow();
  const sessions = new Map<Scope, Awaited<ReturnType<typeof client>>>();
  const session = async (scope: Scope = 'full') => {
    const existing = sessions.get(scope);
    if (existing !== undefined) return existing;
    const created = await client(kit, appId, uid, scope);
    sessions.set(scope, created);
    return created;
  };
  return {
    appId,
    uid,
    db,
    row,
    session,
    /** GET /v1/me with this user's session (full unless asked). */
    get: async (scope: Scope = 'full') => (await session(scope)).request(ME),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A registered device and a session of the given scope (B1-02k createSession, as tips/http-kit). */
export async function client(kit: Kit, appId: string, uid: string, scp: Scope) {
  const headers = {
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({ code: 0 });
  const { device_id } = created.json<{ data: { device_id: string } }>().data;
  const { TOKEN_SERVICE } = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as { TOKEN_SERVICE: symbol };
  const { createSession } = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
  const tokens = kit.app.get<Parameters<typeof createSession>[2]['tokens']>(TOKEN_SERVICE);
  const session = await kit.suite.db
    .withSchema('app')
    .transaction()
    .execute((trx) =>
      createSession(trx, { uid, app_id: appId, device_id, scp }, { clock: kit.clock, tokens }),
    );
  return {
    deviceId: device_id,
    async request(url: string, options: { guest?: boolean } = {}): Promise<Response> {
      return kit.app.inject({
        method: 'GET',
        url,
        headers: {
          ...headers,
          'x-device-id': device_id,
          ...(options.guest ? {} : { authorization: `Bearer ${session.access_token}` }),
        },
      });
    },
  };
}

/** The response envelope, validated against the contract's getMe response schema. */
export function envelope(kit: Kit, response: Response, code = 0): unknown {
  expect(response.statusCode).toBe(code === 0 ? 200 : code === 10001 ? 401 : 403);
  const body = response.json<{ code: number; data: unknown }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const operation = kit.document.paths[ME]!['get']! as {
    responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
  };
  const schema =
    operation.responses[code === 0 ? '200' : '4XX']!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body.data;
}

/** GET /v1/me data: HTTP 200, code 0, and the body passes the contract schema. */
export function me(kit: Kit, response: Response): Me {
  return envelope(kit, response) as Me;
}

/** The getMe operation object of the dereferenced contract (x-* extensions included). */
export function operation(kit: Kit): Record<string, unknown> {
  return kit.document.paths[ME]!['get'] as unknown as Record<string, unknown>;
}

/** Two date-time strings name the same instant (format is the contract's date-time). */
export function at(value: string | null | undefined, expected: Date | string): void {
  expect(typeof value).toBe('string');
  expect(Date.parse(value!)).toBe(new Date(expected).getTime());
}

export async function config(kit: Kit, appId: string, key: string, value: unknown) {
  await kit.suite.db
    .withSchema('app')
    .insertInto('config_items')
    .values({ app_id: appId, key, value: JSON.stringify(value), version: 1, updated_by: 'fixture' })
    .execute();
}

/** One user-level consent record (consent_records is insert-only; current = latest server_at). */
export async function consent(
  kit: Kit,
  f: Fixture,
  type: 'privacy' | 'agreement',
  version: number,
  accepted: boolean,
  serverAt: Date,
  subject: { device: string } | 'user' = 'user',
) {
  await kit.suite.db
    .withSchema('app')
    .insertInto('consent_records')
    .values({
      app_id: f.appId,
      subject_type: subject === 'user' ? 'user' : 'device',
      user_id: subject === 'user' ? f.uid : null,
      device_id: subject === 'user' ? null : subject.device,
      type,
      version,
      channel: 'login_page',
      accepted,
      client_at: serverAt,
      server_at: serverAt,
      created_at: serverAt,
    })
    .execute();
}

/** Both user-level consents accepted at the given versions (need_reconsent false baseline). */
export async function consentAll(kit: Kit, f: Fixture, privacy = 1, agreement = 1) {
  await consent(kit, f, 'privacy', privacy, true, instant(-HOUR));
  await consent(kit, f, 'agreement', agreement, true, instant(-HOUR));
}

export async function riskState(
  kit: Kit,
  f: Fixture,
  state: 'frozen' | 'appealing' | 'banned',
  reasonCategory: string,
  frozenUntil: Date | null = null,
) {
  await kit.suite.db
    .withSchema('app')
    .insertInto('user_risk_state')
    .values({
      user_id: f.uid,
      app_id: f.appId,
      state,
      reason: 'private rule details never returned',
      reason_category: reasonCategory,
      frozen_until: frozenUntil,
      changed_by: 'fixture_operator',
      changed_at: kit.clock.now(),
      created_at: kit.clock.now(),
      updated_at: kit.clock.now(),
    })
    .execute();
}

export async function appeal(
  kit: Kit,
  f: Fixture,
  previous: 'banned' | 'frozen',
  status: 'processing' | 'upheld' = 'processing',
) {
  const now = kit.clock.now();
  await sql`INSERT INTO app.appeals
      (id, app_id, user_id, target_type, target_id, prev_risk_state, status, content, deadline_at,
       handler_id, closed_at)
    VALUES (${randomUUID()}, ${f.appId}, ${f.uid}, 'account', ${f.uid}, ${previous}, ${status},
      'fixture appeal', ${new Date(now.getTime() + 86_400_000)},
      ${status === 'processing' ? null : 'fixture_handler'},
      ${status === 'processing' ? null : now})`.execute(kit.suite.db);
}

/** An order (order_keys first, as the orders FK requires) attributed to the given user. */
export async function order(
  kit: Kit,
  f: Fixture,
  rebateStatus: string,
  platformStatus: string,
  userId: string = f.uid,
) {
  const orderId = randomUUID();
  const subOrderId = `me-${randomBytes(8).toString('hex')}`;
  const attrAt = instant(30 * 60_000);
  const db = kit.suite.db.withSchema('app');
  await db
    .insertInto('order_keys')
    .values({
      platform: 'taobao',
      sub_order_id: subOrderId,
      order_id: orderId,
      app_id: f.appId,
      attr_at: attrAt,
    })
    .execute();
  await db
    .insertInto('orders')
    .values({
      order_id: orderId,
      app_id: f.appId,
      platform: 'taobao',
      sub_order_id: subOrderId,
      raw_item_id: 'fixture-item',
      user_id: userId,
      buy_type: 'self',
      platform_status: platformStatus,
      rebate_status: rebateStatus,
      attr_at: attrAt,
    })
    .execute();
}

/** A direct subordinate (users.parent_id = the fixture user) in the same app. */
export async function child(kit: Kit, f: Fixture, status = 'normal') {
  const id = await seedUser(kit.suite.db.withSchema('app'), f.appId, { status });
  await sql`UPDATE app.users SET parent_id = ${f.uid}, parent_bind_source = 'register',
      parent_bound_at = ${kit.clock.now()} WHERE app_id = ${f.appId} AND id = ${id}`.execute(
    kit.suite.db,
  );
  return id;
}

/** A union_bindings row (with its union account) for the fixture user. */
export async function binding(
  kit: Kit,
  f: Fixture,
  platform: Platform,
  status: 'pending_auth' | 'active' | 'invalid' | 'released' | 'blocked',
) {
  const db = kit.suite.db.withSchema('app');
  const accountId = randomUUID();
  const now = kit.clock.now();
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: f.appId,
      platform,
      account_name: `synthetic-${platform}-${accountId.slice(0, 8)}`,
      status: 'active',
      auth_status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
  const released = status === 'released';
  await db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      user_id: f.uid,
      platform,
      union_account_id: accountId,
      relation_id: status === 'pending_auth' ? null : `rel-${randomBytes(6).toString('hex')}`,
      status,
      bound_at: status === 'pending_auth' ? null : now,
      released_at: released ? now : null,
      cooldown_until: released ? new Date(now.getTime() + 86_400_000) : null,
      blocked_reason: status === 'blocked' ? 'admin_disable' : null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}
