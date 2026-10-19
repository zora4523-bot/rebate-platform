import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect } from 'vitest';
import {
  fixture as smsFixture,
  envelope as smsEnvelope,
  phone,
  TRACE,
  type Kit,
  type Response,
} from '../../identity/landing-sms/kit.ts';

export { openKit, phone, type Kit, type Response } from '../../identity/landing-sms/kit.ts';
export const PATH = '/v1/invites/landing-register';
export const CODE = 'K7Q2MZ';
export const IP = '203.0.113.88';
export const NOW = '2026-10-18T10:00:00+08:00';

export async function fixture(kit: Kit, legal = true) {
  const sms = smsFixture(kit);
  const { appId } = sms;
  async function config(key: string, value: unknown) {
    await kit.db
      .insertInto('config_items')
      .values({
        app_id: appId,
        key,
        value: JSON.stringify(value),
        updated_by: 'B1-11h',
      })
      .onConflict((oc) =>
        oc.columns(['app_id', 'key']).doUpdateSet({
          value: JSON.stringify(value),
        }),
      )
      .execute();
  }
  if (legal) {
    await config('legal.agreement.version', 7);
    await config('legal.privacy.version', 11);
  }
  async function seed(
    options: {
      number?: string;
      invite?: string;
      status?: string;
      hasPhone?: boolean;
    } = {},
  ) {
    const id = randomUUID();
    await kit.db
      .insertInto('users')
      .values({
        id,
        app_id: appId,
        nickname: 'fixture',
        avatar: 'fixture',
        invite_code: options.invite ?? 'R8W3NX',
        attr_code: randomBytes(4).toString('hex'),
        level: 'L1',
        register_method: 'sms',
        status: options.status ?? 'normal',
        phone_hmac:
          options.hasPhone === false
            ? null
            : kit.crypto.blindIndex(options.number ?? phone(), 'users.phone'),
        created_at: kit.clock.now(),
        updated_at: kit.clock.now(),
      })
      .execute();
    return id;
  }
  const inviter = await seed({ invite: CODE });
  const f = {
    kit,
    appId,
    inviter,
    config,
    seed,
    hash: (number: string) => kit.crypto.blindIndex(number, 'users.phone'),
    async sms(number = phone()) {
      // Sending and registration have different IP quotas. Use an independent sending IP;
      // the registration IP below is always the explicitly supplied remoteAddress.
      smsEnvelope(kit, await sms.send(number, { ip: '198.51.100.19' }));
      const messages = sms.messages().filter((message) => message.phone === number);
      expect(messages.length).toBeGreaterThan(0);
      return { phone: number, sms_code: messages.at(-1)!.code, invite_code: CODE, agreed: true };
    },
    post(
      body: Record<string, unknown>,
      options: {
        key?: string | null;
        ip?: string;
        headers?: Record<string, string>;
      } = {},
    ) {
      const key = options.key === undefined ? randomUUID() : options.key;
      return kit.app.inject({
        method: 'POST',
        url: PATH,
        remoteAddress: options.ip ?? IP,
        headers: {
          ...sms.headers,
          ...(key === null ? {} : { 'idempotency-key': key }),
          ...options.headers,
        },
        payload: JSON.stringify(body),
      });
    },
    blocked: sms.blocked,
    async risk(state: 'banned' | 'appealing' | 'frozen') {
      await kit.db
        .insertInto('user_risk_state')
        .values({
          app_id: appId,
          user_id: inviter,
          state,
          reason: 'fixture',
          reason_category: 'other',
          frozen_until: state === 'frozen' ? new Date('2026-11-01T00:00:00Z') : null,
          changed_by: 'fixture',
          changed_at: kit.clock.now(),
          created_at: kit.clock.now(),
          updated_at: kit.clock.now(),
        })
        .execute();
    },
    users: () =>
      kit.db.selectFrom('users').selectAll().where('app_id', '=', appId).orderBy('id').execute(),
    consents: () =>
      kit.db
        .selectFrom('consent_records')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('type')
        .execute(),
    relations: () =>
      kit.db
        .selectFrom('relation_change_logs')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
    idempotency: () =>
      kit.db
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('app_id', '=', appId)
        .where('path', '=', PATH)
        .orderBy('id')
        .execute(),
    async registrations() {
      // Missing implementation migrations must fail as an assertion, never SQL undefined_table.
      const exists = await sql<{
        present: boolean;
      }>`select to_regclass('app.landing_registrations') is not null as present`.execute(kit.db);
      expect(exists.rows[0]?.present, 'implementation must provide landing_registrations').toBe(
        true,
      );
      return (
        await sql<{ app_id: string; user_id: string; ip_hmac: string; created_at: Date }>`
        select app_id, user_id, ip_hmac, created_at from app.landing_registrations
        where app_id = ${appId} order by created_at, user_id`.execute(kit.db)
      ).rows;
    },
  };
  return f;
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function answer(f: Fixture, response: Response, code = 0, result = 'registered') {
  const status =
    code === 0
      ? 200
      : code === 10004 || code === 44001
        ? 403
        : code === 30401 || code === 30408
          ? 422
          : code === 42901
            ? 429
            : code === 20901
              ? 409
              : code === 50001
                ? 500
                : 400;
  expect(response.statusCode).toBe(status);
  const body = response.json();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: TRACE });
  expect(response.headers['set-cookie']).toBeUndefined();
  const key = status === 200 ? '200' : status === 429 ? '429' : status < 500 ? '4XX' : '5XX';
  const schema =
    f.kit.document.paths[PATH]!.post.responses[key]!.content['application/json']!.schema;
  const validate = f.kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  if (code === 0) expect(body['data']).toEqual({ result });
  return body;
}

export async function noAccount(f: Fixture, number: string) {
  expect((await f.users()).filter((u) => u.phone_hmac === f.hash(number))).toEqual([]);
  expect(await f.consents()).toEqual([]);
  expect(await f.relations()).toEqual([]);
  expect(await f.registrations()).toEqual([]);
}

export async function registered(f: Fixture, number: string, channel: string | null = null) {
  const users = (await f.users()).filter(
    (u) => u.phone_hmac === f.hash(number) && u.status !== 'deleted',
  );
  expect(users).toHaveLength(1);
  const user = users[0]!;
  const at = f.kit.clock.now();
  expect(user).toMatchObject({
    app_id: f.appId,
    register_method: 'h5_landing',
    registered_channel: channel,
    parent_id: f.inviter,
    parent_bind_source: 'landing',
    parent_bound_at: at,
    self_bind_used: true,
    created_at: at,
    updated_at: at,
    row_version: 1,
  });
  expect((await f.relations()).filter((r) => r.user_id === user.id)).toEqual([
    expect.objectContaining({
      app_id: f.appId,
      from_parent_id: null,
      to_parent_id: f.inviter,
      source: 'landing',
      operator: `user:${user.id}`,
      reason: null,
      at,
    }),
  ]);
  expect((await f.consents()).filter((r) => r.user_id === user.id)).toEqual(
    [
      ['agreement', 7],
      ['privacy', 11],
    ].map(([type, version]) =>
      expect.objectContaining({
        app_id: f.appId,
        user_id: user.id,
        subject_type: 'user',
        device_id: null,
        type,
        version,
        channel: 'h5_landing',
        accepted: true,
        client_at: at,
        server_at: at,
        created_at: at,
      }),
    ),
  );
  expect((await f.registrations()).filter((r) => r.user_id === user.id)).toEqual([
    {
      app_id: f.appId,
      user_id: user.id,
      ip_hmac: expect.stringMatching(/^[0-9a-f]{64}$/),
      created_at: at,
    },
  ]);
  for (const table of ['devices', 'device_registrations', 'sessions'] as const) {
    expect(
      await f.kit.db.selectFrom(table).selectAll().where('app_id', '=', f.appId).execute(),
    ).toEqual([]);
  }
  return user;
}
