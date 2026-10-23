// B1-27b fixtures: real database, FieldCrypto, Redis and admin sessions (container runner only).
// Users, sessions, push tokens and blocklist entries are written straight into app.* by the test,
// so every expected value is derived from what was seeded here. Sources: 08 BR-ID-44 细则「后台编辑
// 会员信息」, BR-ID-39 细则「后台改昵称」, BR-ID-06 正文 (deleted_identities 180 days), BR-ID-07 (the
// revocation and 10404); contract adminEditUserProfile; task §9 (orchestrator choices).
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createSession,
  type IssuedSession,
} from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { createTokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createRefreshService } from '../../../../apps/api/src/modules/identity/application/refresh.ts';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { REDIS, type RedisHandle } from '../../../../apps/api/src/modules/platform/index.ts';
import { grant, seed, type Seed } from '../../admin/accounts/kit.ts';
import {
  fixture,
  signedIn,
  totp,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';
import { keys } from '../token/kit.ts';
import { DETAIL, PROFILE, validate, validateDetail } from './schema.ts';

export const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const REASON = '企业微信核对注册时间与最近一笔订单号，旧号已停用，改为新号';
export const ACTION = 'user_profile_edit';
/** A word the nickname seed list (identity/infra/sensitive-words.nickname.txt) names (B1-20d). */
export const SEED_WORD = '赌博';
/** BR-ID-06 正文: the old phone_hmac of a change is kept 180 days. */
export const RETENTION_MS = 180 * 86_400_000;
const PHONE_CONTEXT = 'users.phone';

export type Detail = Schema<'AdminUserDetail'>;
export type EditBody = Record<string, unknown>;

interface Inject {
  method: 'PATCH' | 'GET';
  url: string;
  headers: Record<string, string>;
  payload?: string;
  remoteAddress?: string;
}
interface PatchApp {
  inject(request: Inject): Promise<Response>;
  getHttpAdapter(): {
    getInstance(): { hasRoute(options: { method: string; url: string }): boolean };
  };
}
const patchApp = (app: HttpApp) => app as unknown as PatchApp;

export function mounted(app: HttpApp): boolean {
  return patchApp(app)
    .getHttpAdapter()
    .getInstance()
    .hasRoute({ method: 'PATCH', url: PROFILE.replace('{user_id}', ':user_id') });
}

export async function setup(h: Harness) {
  const f = await fixture(h);
  // Every integration case is red before the route exists, negative cases included.
  expect(mounted(f.app), 'admin 入口必须挂载 PATCH /admin/v1/users/{user_id}/profile').toBe(true);
  const appId = `b1-27b-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  f.overrides.logger.info({ event: 'admin_profile_test_capture_ready' }, 'capture ready');
  return { ...f, h, appId, actor, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** A non-super admin of the same app holding exactly `permissions`. */
export async function member(s: Setup, permissions: readonly string[]) {
  const who = await seed(s.h, s.appId);
  if (permissions.length !== 0) await grant(s.h, who, s.actor, permissions);
  const session = await signedIn(s, who);
  return { who, token: session.admin_token };
}
export type Member = Awaited<ReturnType<typeof member>>;

/** A fresh totp-tier step-up token of `who` (each save consumes one). */
export async function stepUp(s: Setup, who: Seed = s.actor, token = s.token): Promise<string> {
  s.clock.advanceMs(30_000);
  const response = await s.post(
    '/step-up',
    { tier: 'totp', code: totp(who.secret, s.clock) },
    { authorization: `Bearer ${token}` },
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  const data = response.json<{ data: { step_up_token: string } }>().data;
  expect(typeof data.step_up_token).toBe('string');
  return data.step_up_token;
}

export interface EditOptions {
  /** The admin doing the save (default: the super admin of setup). */
  as?: Member;
  /** null: no admin_token at all. */
  token?: string | null;
  /** undefined: a fresh valid totp token of the admin; null: no X-Step-Up-Token. */
  stepUp?: string | null;
  headers?: Record<string, string>;
}

/** PATCH /admin/v1/users/{user_id}/profile with `body` as JSON. */
export async function edit(s: Setup, userId: string, body: EditBody, options: EditOptions = {}) {
  const who = options.as?.who ?? s.actor;
  const token = options.token === undefined ? (options.as?.token ?? s.token) : options.token;
  const step =
    options.stepUp === undefined
      ? token === null
        ? null
        : await stepUp(s, who, token)
      : options.stepUp;
  return patchApp(s.app).inject({
    method: 'PATCH',
    url: PROFILE.replace('{user_id}', encodeURIComponent(userId)),
    headers: {
      'content-type': 'application/json',
      'x-trace-id': TRACE,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(step === null ? {} : { 'x-step-up-token': step }),
      ...options.headers,
    },
    payload: JSON.stringify(body),
    remoteAddress: '127.0.0.1',
  });
}

/** A 200 save: the contract envelope and its 200 schema; returns data. */
export async function ok(response: Response): Promise<Detail> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  await validate(response);
  return response.json<{ data: Detail }>().data;
}

/** A refusal: code, HTTP status (contracts/error-codes.yaml) and, when given, the exact data. */
export async function rejected(response: Response, code: number, data?: object) {
  const status: Record<number, number> = {
    10001: 401,
    10003: 403,
    10403: 403,
    20001: 400,
    30411: 422,
    44001: 403,
  };
  expect(response.statusCode, JSON.stringify(response.json())).toBe(status[code]);
  expect(response.json()).toMatchObject({ code, trace_id: TRACE });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response);
}

/** GET /admin/v1/users/{user_id} as the super admin of setup (what the save must answer). */
export async function detail(s: Setup, userId: string): Promise<Detail> {
  const response = await patchApp(s.app).inject({
    method: 'GET',
    url: DETAIL.replace('{user_id}', encodeURIComponent(userId)),
    headers: { 'x-trace-id': TRACE, authorization: `Bearer ${s.token}` },
    remoteAddress: '127.0.0.1',
  });
  expect(response.statusCode).toBe(200);
  await validateDetail(response);
  return response.json<{ data: Detail }>().data;
}

let serial = randomInt(10_000);
/** An obviously synthetic mainland mobile number of the 199 0000 test range. */
export function testPhone(): string {
  serial = (serial + 1) % 10_000;
  return `1990000${String(serial).padStart(4, '0')}`;
}
export const masked = (phone: string) => `${phone.slice(0, 3)}****${phone.slice(-4)}`;
export const hmacOf = (h: Harness, phone: string) => h.fields.blindIndex(phone, PHONE_CONTEXT);

export interface UserOptions {
  phone?: string | null;
  nickname?: string;
  status?: 'normal' | 'deleting' | 'deleted';
  month?: string | null;
  count?: number;
}

export async function user(h: Harness, appId: string, options: UserOptions = {}) {
  const id = randomUUID();
  const phone = options.phone === undefined ? testPhone() : options.phone;
  const nickname = options.nickname ?? `会员${randomBytes(3).toString('hex')}`;
  const cipher = phone === null ? null : Buffer.from(h.fields.encrypt(phone, PHONE_CONTEXT));
  const hmac = phone === null ? null : hmacOf(h, phone);
  const status = options.status ?? 'normal';
  await h.db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname,
      avatar: 'avatar:default',
      phone_cipher: cipher,
      phone_hmac: hmac,
      nickname_change_month: options.month ?? null,
      nickname_change_count: options.count ?? 0,
      invite_code: `i-${id}`,
      attr_code: `a-${id}`,
      level: 'L1',
      status,
      deleted_reason: status === 'deleted' ? 'user_request' : null,
      register_method: phone === null ? 'wechat' : 'phone',
      registered_channel: 'test',
    })
    .execute();
  return { id, appId, phone, nickname, cipher, hmac };
}
export type User = Awaited<ReturnType<typeof user>>;

export const row = (h: Harness, target: { id: string }) =>
  h.db.selectFrom('users').selectAll().where('id', '=', target.id).executeTakeFirstOrThrow();

/** The plaintext behind a stored users.phone_cipher. */
export function decrypted(h: Harness, cipher: Uint8Array | null): string | null {
  return cipher === null
    ? null
    : h.fields.decrypt(Buffer.from(cipher).toString('utf8'), PHONE_CONTEXT);
}

/** An active phone blocklist entry of the app (BR-ID-31), by the users.phone blind index. */
export async function blocked(h: Harness, clock: FixedClock, appId: string, phone: string) {
  await h.db
    .insertInto('blocklist')
    .values({
      id: randomUUID(),
      app_id: appId,
      dimension: 'phone',
      value_hmac: hmacOf(h, phone),
      violation_type: 'other',
      status: 'active',
      created_by: 'b1-27b',
      expire_at: new Date(clock.now().getTime() + 30 * 86_400_000),
    })
    .execute();
}

/**
 * `count` signed-in devices of the user, each with its own session and refresh token, and a push
 * token bound to that session (BR-ID-07 细则「推送令牌与会话」).
 */
export async function devices(h: Harness, clock: FixedClock, target: User, count = 2) {
  const tokens = createTokenService({ clock, keys: keys() });
  const pairs: (IssuedSession & { deviceId: string; pushId: string })[] = [];
  for (let i = 0; i < count; i += 1) {
    const deviceId = randomUUID();
    await h.db
      .insertInto('devices')
      .values({
        id: deviceId,
        app_id: target.appId,
        device_hash: randomUUID().replaceAll('-', '').repeat(2),
        id_source: 'idfv',
        install_secret_cipher: Buffer.from('fixture'),
        platform: 'ios',
        app_version: '2.0.0',
        last_seen_at: clock.now(),
      })
      .execute();
    const pair = await h.db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { app_id: target.appId, uid: target.id, device_id: deviceId, scp: 'full' },
          { clock, tokens },
        ),
      );
    const pushId = randomUUID();
    await h.db
      .insertInto('push_tokens')
      .values({
        id: pushId,
        app_id: target.appId,
        device_id: deviceId,
        user_id: target.id,
        bound_sid: pair.sid,
        provider: 'apns',
        token: `fixture-${pushId}`,
        token_set_at: clock.now(),
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    pairs.push({ ...pair, deviceId, pushId });
  }
  return { tokens, pairs };
}
export type Devices = Awaited<ReturnType<typeof devices>>;

/** POST /v1/auth/refresh's use case for one device of `devices` (BR-ID-07; 10404 once revoked). */
export function refresh(s: Setup, set: Devices, pair: Devices['pairs'][number], appId: string) {
  return createRefreshService({
    db: s.h.db,
    clock: s.clock,
    tokens: set.tokens,
    crypto: s.h.fields,
    redis: s.app.get<RedisHandle>(REDIS),
    versions: { minSupportedVersion: async () => null },
    logger: s.overrides.logger,
  }).refresh({
    refresh_token: pair.refresh_token,
    verifiedDevice: { appId, deviceId: pair.deviceId },
    platform: 'ios',
    channel: 'appstore',
    version: '2.0.0',
  });
}

export const sessionsOf = (h: Harness, target: { appId: string; id: string }) =>
  h.db
    .selectFrom('sessions')
    .selectAll()
    .where('app_id', '=', target.appId)
    .where('user_id', '=', target.id)
    .orderBy('sid')
    .execute();

export const pushTokensOf = (h: Harness, appId: string) =>
  h.db.selectFrom('push_tokens').selectAll().where('app_id', '=', appId).orderBy('id').execute();

export const identities = (h: Harness, appId: string) =>
  h.db
    .selectFrom('deleted_identities')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();

export const audits = (h: Harness, appId: string) =>
  h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('action', '=', ACTION)
    .orderBy('id')
    .execute();
export type AuditRow = Awaited<ReturnType<typeof audits>>[number];

/** Everything a save may write (or a refusal must leave alone) in the app. */
export async function snapshot(h: Harness, appId: string) {
  return {
    users: await h.db
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    sessions: await h.db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('sid')
      .execute(),
    refreshTokens: await h.db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    pushTokens: await pushTokensOf(h, appId),
    identities: await identities(h, appId),
    audits: await audits(h, appId),
    riskHits: await h.db
      .selectFrom('risk_hits')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

/** The audit rows added after `before`. */
export function added(before: readonly AuditRow[], after: readonly AuditRow[]): AuditRow[] {
  return after.filter((entry) => !before.some((old) => old.id === entry.id));
}

/** The whole audit row as text (bigint ids included), for containment checks. */
export function auditText(entry: AuditRow): string {
  return JSON.stringify(entry, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/** No full phone number in the response body or in any log line of the test. */
export function noPlaintext(s: Setup, phones: readonly (string | null)[], response?: Response) {
  expect(s.lines.length, '日志捕获器必须启用').toBeGreaterThan(0);
  const logs = s.lines.join('\n');
  const body = response === undefined ? '' : JSON.stringify(response.json());
  for (const phone of phones) {
    if (phone === null) continue;
    expect(logs).not.toContain(phone);
    expect(body).not.toContain(phone);
  }
}
