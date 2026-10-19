// B1-02zc §9: real AppModule, guards, signing keys, Redis and business-role database.
// Existing routes are the test seam; no replacement controller or implementation stub is needed.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { sign } from '../../risk/signature/kit.ts';
import {
  accepted,
  rejected,
  validate,
  client,
  fixture,
  openHttpKit,
  closeHttpKit,
  CONSENTS,
  type Fixture,
  type HttpKit,
} from '../step-up/http-kit.ts';

let kit: HttpKit;
beforeAll(async () => {
  kit = await openHttpKit();
}, 180_000);
afterAll(async () => {
  await closeHttpKit(kit);
});

function body(
  overrides: Partial<Schema<'RecordConsentRequest'>> = {},
): Schema<'RecordConsentRequest'> {
  return {
    type: 'clipboard_auto_import',
    version: '2026-10-17',
    accepted: true,
    channel: 'privacy_center',
    client_at: '2026-10-07T01:02:03.456Z',
    ...overrides,
  };
}

function rows(f: Fixture) {
  return f.db
    .selectFrom('consent_records')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

function unsigned(f: Fixture, input: Schema<'RecordConsentRequest'>, token?: string) {
  return kit.app.inject({
    method: 'POST',
    url: CONSENTS,
    payload: JSON.stringify(input),
    headers: {
      'content-type': 'application/json',
      'x-app-id': f.appId,
      'x-platform': 'ios',
      'x-channel': 'appstore',
      'x-app-version': '2.0.0',
      'x-device-id': f.device.deviceId,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });
}

it.each([
  { loggedIn: false, value: true, version: '1' },
  { loggedIn: false, value: false, version: '2026-10-17' },
  { loggedIn: true, value: true, version: 'release_2026-10-17' },
  { loggedIn: true, value: false, version: 'v'.repeat(32) },
])(
  '[AC-B1-02zc#1] 设备同意 loggedIn=$loggedIn accepted=$value version=$version 原样保存字符串',
  async ({ loggedIn, value, version }) => {
    const f = await fixture(kit);
    const input = body({ accepted: value, version });
    expect(
      accepted(
        kit,
        CONSENTS,
        await f.device.post(CONSENTS, input, loggedIn ? f.session.access_token : undefined),
      ),
    ).toEqual({});
    expect(await rows(f)).toEqual([
      expect.objectContaining({
        app_id: f.appId,
        subject_type: 'device',
        device_id: f.device.deviceId,
        user_id: loggedIn ? f.uid : null,
        type: 'clipboard_auto_import',
        version: 0,
        version_label: version,
        accepted: value,
        channel: input.channel,
        client_at: new Date(input.client_at),
        server_at: kit.clock.now(),
        created_at: kit.clock.now(),
      }),
    ]);
    // A clipboard withdrawal must not perform the privacy withdrawal's revocation actions.
    expect(
      await f.db
        .selectFrom('devices')
        .select('revoked_at')
        .where('id', '=', f.device.deviceId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: null });
    expect(
      await f.db
        .selectFrom('sessions')
        .select('revoked_at')
        .where('sid', '=', f.session.sid)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: null });
  },
);

it('[AC-B1-02zc#2] 同一用户两台设备互不覆盖，追加撤回并按 server_at 取当前状态', async () => {
  const f = await fixture(kit);
  const other = await client(kit, f.appId);
  const secondSession = await f.issue(f.uid, other.deviceId);
  accepted(kit, CONSENTS, await f.post(CONSENTS, body({ version: 'z99' })));
  accepted(
    kit,
    CONSENTS,
    await other.post(CONSENTS, body({ version: 'v2' }), secondSession.access_token),
  );
  const before = await rows(f);
  kit.clock.advanceMs(1000);
  accepted(
    kit,
    CONSENTS,
    await f.post(
      CONSENTS,
      body({ version: 'a1', accepted: false, client_at: '2026-10-01T00:00:00Z' }),
    ),
  );
  const all = await rows(f);
  expect(all).toHaveLength(3);
  expect(all.filter((row) => before.some((old) => old.id === row.id))).toEqual(before);
  expect(all.filter((row) => row.device_id === other.deviceId)).toEqual(
    before.filter((row) => row.device_id === other.deviceId),
  );
  expect(all.every((row) => row.subject_type === 'device' && row.user_id === f.uid)).toBe(true);
  const { deviceConsentRecords } =
    await import('../../../../apps/api/src/modules/identity/infra/consent-records.ts');
  const { currentStates } =
    await import('../../../../apps/api/src/modules/identity/domain/login.ts');
  const history = await f.db
    .transaction()
    .execute((trx) => deviceConsentRecords(trx, f.appId, f.device.deviceId));
  expect(history).toHaveLength(2);
  expect(currentStates(history).get('clipboard_auto_import')).toMatchObject({
    accepted: false,
    server_at: kit.clock.now(),
  });
});

it.each([1, 2147483647])(
  '[AC-B1-02zc#3] 剪贴板整数版本 %s 拒绝，改为字符串后可以记录',
  async (version) => {
    const f = await fixture(kit);
    rejected(kit, CONSENTS, await f.post(CONSENTS, body({ version })), 20001, {
      fields: ['version'],
    });
    expect(await rows(f)).toEqual([]);
    accepted(kit, CONSENTS, await f.post(CONSENTS, body({ version: String(version) })));
    expect(await rows(f)).toEqual([
      expect.objectContaining({ version: 0, version_label: String(version) }),
    ]);
  },
);

it.each(['privacy', 'agreement', 'ai_third_party', 'id_verification', 'personalization'] as const)(
  '[AC-B1-02zc#4] 原类型 %s 仍用整数、无需签名且 version_label 为空，字符串返回 version 错误',
  async (type) => {
    const f = await fixture(kit);
    rejected(
      kit,
      CONSENTS,
      await unsigned(f, body({ type, version: '3' }), f.session.access_token),
      20001,
      { fields: ['version'] },
    );
    expect(await rows(f)).toEqual([]);
    accepted(kit, CONSENTS, await unsigned(f, body({ type, version: 3 }), f.session.access_token));
    accepted(kit, CONSENTS, await unsigned(f, body({ type, version: 2 })));
    expect(await rows(f)).toEqual([
      expect.objectContaining({
        type,
        subject_type: 'user',
        user_id: f.uid,
        version: 3,
        version_label: null,
      }),
      expect.objectContaining({
        type,
        subject_type: 'device',
        user_id: null,
        version: 2,
        version_label: null,
      }),
    ]);
  },
);

it.each([false, true])(
  '[AC-B1-02zc#5] 剪贴板缺少签名返回 10401，带令牌=%s 不能绕过',
  async (loggedIn) => {
    const f = await fixture(kit);
    rejected(
      kit,
      CONSENTS,
      await unsigned(f, body(), loggedIn ? f.session.access_token : undefined),
      10401,
    );
    expect(await rows(f)).toEqual([]);
  },
);

it.each([{ 'x-sign': '0'.repeat(64) }, { 'x-timestamp': '1000000000' }, { 'x-nonce': 'invalid' }])(
  '[AC-B1-02zc#6] 剪贴板无效签名材料 %j 返回 10401 且不写记录',
  async (headers) => {
    const f = await fixture(kit);
    for (const token of [undefined, f.session.access_token]) {
      rejected(kit, CONSENTS, await f.device.post(CONSENTS, body(), token, headers), 10401);
      expect(await rows(f)).toEqual([]);
    }
  },
);

it('[AC-B1-02zc#7] 剪贴板签名 nonce 只能使用一次，重放不追加记录', async () => {
  const f = await fixture(kit);
  const headers = {
    'content-type': 'application/json',
    'x-app-id': f.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const device = accepted<Schema<'RegisterDeviceData'>>(
    kit,
    '/v1/devices',
    await kit.app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers,
      payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
    }),
  );
  const session = await f.issue(f.uid, device.device_id);
  const payload = JSON.stringify(body());
  const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
  const nonce = randomBytes(16).toString('hex');
  // Construct once and send twice through HTTP, retaining the exact signed bytes and nonce.
  const request = {
    method: 'POST' as const,
    url: CONSENTS,
    payload,
    headers: {
      ...headers,
      'x-device-id': device.device_id,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-sign': sign(
        'POST',
        CONSENTS,
        Buffer.from(payload),
        timestamp,
        nonce,
        device.install_secret,
      ),
      authorization: `Bearer ${session.access_token}`,
    },
  };
  const response = await kit.app.inject(request);
  expect(response.statusCode).toBe(200);
  accepted(kit, CONSENTS, response);
  const before = await rows(f);
  expect(before).toHaveLength(1);
  const replay = await kit.app.inject(request);
  expect(replay.statusCode).toBe(401);
  rejected(kit, CONSENTS, replay, 10401);
  expect(await rows(f)).toEqual(before);
});

it.each(['unknown', 'revoked'] as const)(
  '[AC-B1-02zc#8] 剪贴板设备 %s 返回 10402 且不写记录',
  async (kind) => {
    const f = await fixture(kit);
    if (kind === 'revoked') {
      await f.db
        .updateTable('devices')
        .set({ revoked_at: kit.clock.now() })
        .where('id', '=', f.device.deviceId)
        .execute();
    }
    rejected(
      kit,
      CONSENTS,
      await f.device.post(
        CONSENTS,
        body(),
        undefined,
        kind === 'unknown' ? { 'x-device-id': randomUUID() } : {},
      ),
      10402,
    );
    expect(await rows(f)).toEqual([]);
  },
);

it('[AC-B1-02zc#9] 真实短信登录不把剪贴板记录并入用户，但仍合并普通设备同意', async () => {
  const f = await fixture(kit, true);
  accepted(kit, CONSENTS, await f.device.post(CONSENTS, body()));
  accepted(
    kit,
    CONSENTS,
    await f.device.post(CONSENTS, body({ type: 'personalization', version: 9, accepted: false })),
  );
  const before = await rows(f);
  const code = await f.send('login');
  const response = await f.device.post('/v1/auth/login/sms', {
    phone: f.number,
    code,
    legal_versions: { privacy: 3, agreement: 2 },
    consent_at: body().client_at,
  });
  expect(accepted(kit, '/v1/auth/login/sms', response)).toMatchObject({
    user_id: f.uid,
    is_new_user: false,
  });
  const all = await rows(f);
  expect(all.filter((row) => before.some((old) => old.id === row.id))).toEqual(before);
  expect(all.filter((row) => row.type === 'clipboard_auto_import')).toEqual(
    before.filter((row) => row.type === 'clipboard_auto_import'),
  );
  expect(all.filter((row) => row.channel === 'login_merge')).toEqual([
    expect.objectContaining({
      type: 'personalization',
      subject_type: 'user',
      user_id: f.uid,
      version: 9,
      version_label: null,
      accepted: false,
    }),
  ]);
});

it('[AC-B1-02zc#10] 低版本不能新增剪贴板同意，仍可签名撤回', async () => {
  const f = await fixture(kit);
  await f.db
    .insertInto('app_versions')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      platform: 'ios',
      channel: 'appstore',
      latest_version: '3.0.0',
      min_supported_version: '3.0.0',
      update_title: '测试版本',
      update_notes: '剪贴板同意版本门',
      store_url: 'https://example.invalid/app',
      default_store: 'app_store',
      store_listings: sql`'[]'::jsonb`,
    })
    .execute();
  const blocked = await f.post(CONSENTS, body());
  expect(blocked.statusCode).toBe(403);
  expect(blocked.json()).toMatchObject({ code: 10405, data: { min_supported_version: '3.0.0' } });
  validate(kit, CONSENTS, blocked);
  expect(await rows(f)).toEqual([]);
  accepted(kit, CONSENTS, await f.post(CONSENTS, body({ accepted: false })));
  expect(await rows(f)).toEqual([
    expect.objectContaining({
      subject_type: 'device',
      accepted: false,
      version_label: '2026-10-17',
    }),
  ]);
});
