import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createSmsLoginService,
  type SmsLoginCommand,
  type SmsLoginOptions,
  type SmsLoginResult,
} from '../../../../apps/api/src/modules/identity/application/sms-login.ts';
import {
  createRegistrationService,
  PHONE_BLIND_INDEX_CONTEXT,
  type RegistrationOptions,
} from '../../../../apps/api/src/modules/identity/application/registration.ts';
import { createTokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { keys } from '../token/kit.ts';
import { context, seedUser, type Kit } from '../registration/kit.ts';

export { openKit, closeKit } from '../registration/kit.ts';
export type { Kit } from '../registration/kit.ts';
export const DEVICE_CONTEXT = 'login_logs.device_id';

export async function fixture(kit: Kit, registrationPorts: Partial<RegistrationOptions> = {}) {
  const ctx = await context(kit);
  const deviceId = ctx.command.device_id!;
  await sql`INSERT INTO app.devices
    (id, app_id, device_hash, id_source, install_secret_cipher, platform, app_version, last_seen_at)
    VALUES (${deviceId}, ${ctx.appId}, ${ctx.hash}, 'idfv', ${Buffer.from('test-fixture')},
      'ios', '2.0.0', ${ctx.clock.now()})`.execute(kit.db);
  const command: SmsLoginCommand = {
    body: {
      phone: ctx.command.phone!,
      code: '123456',
      legal_versions: { privacy: 3, agreement: 2 },
      consent_at: new Date(ctx.clock.now().getTime() - 5000).toISOString(),
    },
    app_id: ctx.appId,
    device_id: deviceId,
    platform: 'ios',
    channel: 'test_channel',
    version: '2.0.0',
    client_ip: ctx.command.client_ip,
  };
  const verify = vi.fn<SmsLoginOptions['sms']['verifyAndConsume']>(async () => ({ code: 0 }));
  const minimum = vi.fn<SmsLoginOptions['versions']['minSupportedVersion']>(async () => null);
  const registration = createRegistrationService({ ...ctx.options, ...registrationPorts });
  const register = vi.fn(registration.register.bind(registration));
  const tokens = createTokenService({ clock: ctx.clock, keys: keys() });
  const options: SmsLoginOptions = {
    db: kit.db.withSchema('app'),
    clock: ctx.clock,
    crypto: kit.crypto,
    logger: ctx.options.logger,
    versions: { minSupportedVersion: minimum },
    sms: { verifyAndConsume: verify },
    registration: { register },
    tokens,
  };
  return {
    ...ctx,
    command,
    deviceId,
    options,
    verify,
    minimum,
    register,
    tokens,
    // Factory is deliberately inside the test's action, never a beforeAll hook.
    login: (input: Partial<SmsLoginCommand> = {}, ports: Partial<SmsLoginOptions> = {}) =>
      createSmsLoginService({ ...options, ...ports }).login({ ...command, ...input }),
    account: (status = 'normal', app = ctx.appId, phone = command.body.phone) =>
      seedUser(kit.db, app, {
        status,
        phoneHmac: kit.crypto.blindIndex(phone, PHONE_BLIND_INDEX_CONTEXT),
      }),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function success(result: SmsLoginResult) {
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('unreachable after assertion');
  return result.data;
}

export async function rows(kit: Kit, app: string) {
  const db = kit.db.withSchema('app');
  return {
    users: await db
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    registrations: await db
      .selectFrom('device_registrations')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('user_id')
      .execute(),
    consents: await db
      .selectFrom('consent_records')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    logs: await db
      .selectFrom('login_logs')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    sessions: await db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    refresh: await db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    devices: await db
      .selectFrom('devices')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
  };
}

export async function assertLogin(
  kit: Kit,
  f: Fixture,
  result: SmsLoginResult,
  isNew: boolean,
  scope: 'full' | 'deletion_only',
) {
  const data = success(result);
  expect(data.is_new_user).toBe(isNew);
  expect(data.tokens.session_scope).toBe(scope);
  const principal = await f.tokens.verifyAccess(data.tokens.access_token);
  expect(principal).toMatchObject({
    uid: data.user_id,
    app_id: f.appId,
    device_id: f.deviceId,
    scp: scope,
  });
  const state = await rows(kit, f.appId);
  const session = state.sessions.find((row) => row.sid === principal.sid);
  expect(session).toMatchObject({
    user_id: data.user_id,
    device_id: f.deviceId,
    created_at: f.clock.now(),
  });
  expect(state.refresh.filter((row) => row.sid === principal.sid)).toHaveLength(1);
  expect(state.refresh.find((row) => row.sid === principal.sid)?.token_hash).toBe(
    createHash('sha256').update(data.tokens.refresh_token).digest('hex'),
  );
  expect(state.devices.find((row) => row.id === f.deviceId)?.last_login_sid).toBe(principal.sid);
  const consents = state.consents.filter(
    (row) => row.user_id === data.user_id && row.channel === 'login_page',
  );
  expect(consents).toHaveLength(2);
  for (const type of ['privacy', 'agreement'] as const) {
    expect(consents.find((row) => row.type === type)).toMatchObject({
      subject_type: 'user',
      accepted: true,
      version: f.command.body.legal_versions[type],
      client_at: new Date(f.command.body.consent_at),
      server_at: f.clock.now(),
    });
  }
  expect(state.logs.filter((row) => row.user_id === data.user_id)).toEqual([
    expect.objectContaining({
      method: 'sms',
      ip: f.command.client_ip,
      created_at: f.clock.now(),
      device_id_hash: kit.crypto.blindIndex(f.deviceId, DEVICE_CONTEXT),
    }),
  ]);
  expect(state.logs[0]!.device_id_hash).not.toBe(f.deviceId);
  expect(state.logs[0]!.device_id_hash).not.toBe(f.hash);
  return data;
}

export async function consent(
  kit: Kit,
  f: Fixture,
  input: {
    user?: string;
    device?: string;
    type: string;
    version: number;
    at: number;
    accepted?: boolean;
  },
) {
  const at = new Date(f.clock.now().getTime() + input.at);
  return kit.db
    .withSchema('app')
    .insertInto('consent_records')
    .values({
      app_id: f.appId,
      subject_type: input.user === undefined ? 'device' : 'user',
      user_id: input.user ?? null,
      device_id: input.device ?? (input.user === undefined ? f.deviceId : null),
      type: input.type,
      version: input.version,
      accepted: input.accepted ?? true,
      channel: 'privacy_center',
      client_at: at,
      server_at: at,
      ...(input.type === 'labor_agreement'
        ? { text_sha256: 'a'.repeat(64), signer_snapshot: '{}' }
        : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function otherDevice(kit: Kit, f: Fixture) {
  const id = randomUUID();
  await sql`INSERT INTO app.devices
    (id, app_id, device_hash, id_source, install_secret_cipher, platform, app_version, last_seen_at)
    VALUES (${id}, ${f.appId}, ${createHash('sha256').update(id).digest('hex')}, 'idfv',
      ${Buffer.from('fixture')}, 'ios', '2.0.0', ${f.clock.now()})`.execute(kit.db);
  return id;
}
