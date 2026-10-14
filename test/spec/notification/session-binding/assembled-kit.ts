// B1-12b round 2: real AppModule, no test-supplied notification hooks.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { FIELD_CRYPTO, type FieldCrypto } from '../../../../apps/api/src/modules/platform/index.ts';
import { PHONE_BLIND_INDEX_CONTEXT } from '../../../../apps/api/src/modules/identity/application/registration.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type { SessionRevokeReason } from '../../../../apps/api/src/modules/identity/application/revoke-sessions.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { identityExports, type Suite } from '../../identity/session/kit.ts';
import {
  buildApp,
  outbox,
  type HttpApp,
  type Response,
} from '../../identity/sms-codes/http-kit.ts';
import { memoryLogger, phone } from '../../identity/sms-codes/kit.ts';
import { contract, sign } from '../../risk/signature/kit.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export { openSuite, closeSuite, type Suite } from '../../identity/session/kit.ts';

export async function openApp(suite: Suite) {
  const clock = new FixedClock('2026-10-08T04:00:00.000Z');
  const base = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-12b-assembled-'));
  // Real PostgreSQL row-lock failure injection, applicable to Kysely and raw SQL alike.
  // No DDL/migrator credentials: the shared test harness exposes only business roles.
  const url = new URL(suite.database.urlFor('couli_app'));
  url.searchParams.set('options', '-c lock_timeout=250ms');
  const db = createDb({ connectionString: url.href, max: 8 });
  let app: HttpApp | undefined;
  try {
    app = await buildApp(db, dir, suite.server.url, clock, memoryLogger().logger);
    await app.init();
    const live = app;
    return {
      app: live,
      clock,
      db,
      observer: suite.db.withSchema('app'),
      async close() {
        try {
          await live.close();
        } finally {
          await destroyDb(db);
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      await destroyDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  }
}
export type AppFixture = Awaited<ReturnType<typeof openApp>>;

let document: ReturnType<typeof contract> | undefined;
async function validateResponse(path: string, response: Response) {
  document ??= contract();
  const operation = (await document).paths[path]!.post!;
  const responses = operation['responses'] as Record<
    string,
    { content: Record<string, { schema: JsonSchema }> }
  >;
  const status = response.statusCode;
  const entry = responses[String(status)] ?? responses[`${Math.floor(status / 100)}XX`];
  expect(entry, `${path} HTTP ${status} must have a contract response`).toBeDefined();
  const check = createValidatorCompiler()({
    schema: entry!.content['application/json']!.schema,
    httpPart: 'body',
  });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}

export async function device(f: AppFixture) {
  const headers = {
    'content-type': 'application/json',
    'x-app-id': 'couli',
    'x-platform': 'ios',
    'x-app-version': '2.0.0',
  };
  const response = await f.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(response.statusCode).toBe(200);
  await validateResponse('/v1/devices', response);
  const { data } = response.json<{ data: { device_id: string; install_secret: string } }>();
  expect(data.device_id).toEqual(expect.any(String));
  return {
    id: data.device_id,
    async post(path: string, body: Record<string, unknown>, access?: string) {
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const response = await f.app.inject({
        method: 'POST',
        url: path,
        payload: raw,
        headers: {
          ...headers,
          'x-device-id': data.device_id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, data.install_secret),
          ...(access === undefined ? {} : { authorization: `Bearer ${access}` }),
        },
      });
      await validateResponse(path, response);
      return response;
    },
  };
}
export type Device = Awaited<ReturnType<typeof device>>;

export async function account(f: AppFixture) {
  const number = phone();
  const uid = await seedUser(f.db, 'couli', {
    phoneHmac: f.app.get<FieldCrypto>(FIELD_CRYPTO).blindIndex(number, PHONE_BLIND_INDEX_CONTEXT),
  });
  return { number, uid };
}

export async function loginBody(f: AppFixture, d: Device, number: string) {
  f.clock.advanceMs(61_000);
  const sent = await d.post('/v1/auth/sms-codes', { phone: number, purpose: 'login' });
  expect(sent.statusCode).toBe(200);
  const message = outbox(f.app).findLast(
    (item) => item.phone === number && item.purpose === 'login',
  );
  expect(message?.code).toMatch(/^\d{6}$/);
  return {
    phone: number,
    code: message!.code,
    legal_versions: { privacy: 7, agreement: 4 },
    consent_at: f.clock.now().toISOString(),
  };
}

export async function login(f: AppFixture, d: Device, number: string) {
  const response = await d.post('/v1/auth/login/sms', await loginBody(f, d, number));
  expect(response.statusCode).toBe(200);
  const { data } = response.json<{
    data: { user_id: string; tokens: { access_token: string; refresh_token: string } };
  }>();
  const principal = await f.app
    .get<TokenService>(TOKEN_SERVICE)
    .verifyAccess(data.tokens.access_token);
  expect(principal).toMatchObject({ uid: data.user_id, device_id: d.id, app_id: 'couli' });
  return { uid: data.user_id, sid: principal.sid, ...data.tokens };
}
export type Login = Awaited<ReturnType<typeof login>>;

export async function seedToken(
  f: AppFixture,
  d: Device,
  binding?: Login,
  frozenUntil: Date | null = null,
) {
  const id = randomUUID();
  await f.db
    .insertInto('push_tokens')
    .values({
      id,
      app_id: 'couli',
      device_id: d.id,
      user_id: binding?.uid ?? null,
      bound_sid: binding?.sid ?? null,
      provider: 'apns',
      token: `fixture-${id}`,
      token_set_at: f.clock.now(),
      frozen_until: frozenUntil,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  return id;
}

export function token(f: AppFixture, id: string) {
  return f.observer
    .selectFrom('push_tokens')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export async function assertBound(f: AppFixture, d: Device, id: string, session: Login) {
  expect(await token(f, id)).toMatchObject({
    user_id: session.uid,
    bound_sid: session.sid,
    revoked_at: null,
  });
  expect(
    await f.observer
      .selectFrom('devices')
      .select('last_login_sid')
      .where('id', '=', d.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ last_login_sid: session.sid });
}

export async function snapshot(f: AppFixture) {
  return {
    tokens: await f.observer.selectFrom('push_tokens').selectAll().orderBy('id').execute(),
    devices: await f.observer.selectFrom('devices').selectAll().orderBy('id').execute(),
    sessions: await f.observer.selectFrom('sessions').selectAll().orderBy('id').execute(),
    refresh: await f.observer.selectFrom('refresh_tokens').selectAll().orderBy('id').execute(),
  };
}

/** Hold only the token row: identity's session/device writes remain possible until unbinding. */
export async function withTokenWriteFailure(f: AppFixture, id: string, run: () => Promise<void>) {
  await f.observer.transaction().execute(async (locker) => {
    await locker
      .selectFrom('push_tokens')
      .select('id')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    // Verify the fault at PostgreSQL itself, not at a particular query-builder method.
    await expect(
      sql`UPDATE app.push_tokens SET bound_sid = bound_sid WHERE id = ${id}`.execute(f.db),
    ).rejects.toMatchObject({ code: '55P03' });
    await run();
  });
}

type RevokeUser = (
  trx: Transaction<DB>,
  input: {
    app_id: string;
    user_id: string;
    reason: SessionRevokeReason;
  },
) => Promise<string[]>;
type RevokeDevice = (
  trx: Transaction<DB>,
  input: {
    app_id: string;
    device_id: string;
    reason: SessionRevokeReason;
  },
) => Promise<string[]>;

/**
 * Assembly contract: use identity's existing public functions as Nest provider tokens.
 * The resolved callable owns its Clock/notification hook; callers supply only trx and input.
 * Missing wiring fails an assertion, never a Nest UnknownElementException/TypeError.
 */
export async function revocations(f: AppFixture) {
  const identity = await identityExports();
  const container = f.app as unknown as { get<T>(key: unknown): T };
  function resolve<T>(key: unknown): T {
    let result: T | undefined;
    try {
      result = container.get<T>(key);
    } catch {
      result = undefined;
    }
    expect(result, 'AppModule must expose the assembled identity revocation callable').toBeTypeOf(
      'function',
    );
    return result!;
  }
  return {
    byUser: resolve<RevokeUser>(identity.revokeSessionsByUser),
    byDevice: resolve<RevokeDevice>(identity.revokeSessionsByDevice),
  };
}
