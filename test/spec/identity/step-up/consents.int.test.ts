import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { createConsentService } from '../../../../apps/api/src/modules/identity/application/consents.ts';
import { userConsentRecords } from '../../../../apps/api/src/modules/identity/infra/consent-records.ts';
import { seedUser } from '../registration/kit.ts';
import {
  ATTEMPTS,
  CONSENTS,
  H5,
  accepted,
  rejected,
  fixture,
  client,
  openHttpKit,
  closeHttpKit,
  type Fixture,
  type HttpKit,
} from './http-kit.ts';

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
    type: 'agreement',
    version: 3,
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
async function push(f: Fixture, deviceId: string, sid: string) {
  const id = randomUUID();
  await f.db
    .insertInto('push_tokens')
    .values({
      id,
      app_id: f.appId,
      user_id: f.uid,
      bound_sid: sid,
      device_id: deviceId,
      provider: 'apns',
      token: `test-${id}`,
      token_set_at: kit.clock.now(),
    })
    .execute();
  return id;
}

it.each(['privacy', 'agreement', 'ai_third_party', 'id_verification', 'personalization'] as const)(
  '[AC-B1-02f#70][BR-ID-12/13] 登录记录 %s：所有字段正确，主体取 principal',
  async (type) => {
    const f = await fixture(kit);
    const input = body({ type });
    expect(
      accepted(
        kit,
        CONSENTS,
        await f.post(CONSENTS, input, f.session.access_token, { 'x-device-id': randomUUID() }),
      ),
    ).toEqual({});
    const recorded = await rows(f);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      app_id: f.appId,
      subject_type: 'user',
      user_id: f.uid,
      device_id: f.device.deviceId,
      type,
      version: input.version,
      accepted: true,
      channel: input.channel,
      client_at: new Date(input.client_at),
      server_at: kit.clock.now(),
      created_at: kit.clock.now(),
    });
  },
);

it('[AC-B1-02f#71][BR-ID-12] 游客已登记设备记录一行，user_id 为空', async () => {
  const f = await fixture(kit);
  const input = body({ type: 'privacy', channel: 'first_launch' });
  expect(accepted(kit, CONSENTS, await f.device.post(CONSENTS, input))).toEqual({});
  const recorded = await rows(f);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    app_id: f.appId,
    subject_type: 'device',
    user_id: null,
    device_id: f.device.deviceId,
    type: input.type,
    version: input.version,
    accepted: true,
    channel: input.channel,
    client_at: new Date(input.client_at),
    server_at: kit.clock.now(),
    created_at: kit.clock.now(),
  });
});

it.each(['unknown', 'foreign_app', 'revoked'] as const)(
  '[AC-B1-02f#72][BR-ID-12] 游客设备 %s 返回 20001 fields=[X-Device-Id]，不落记录',
  async (kind) => {
    const f = await fixture(kit);
    let deviceId: string = randomUUID();
    if (kind === 'foreign_app') deviceId = (await client(kit, 'another_app')).deviceId;
    if (kind === 'revoked') {
      deviceId = f.device.deviceId;
      await f.db
        .updateTable('devices')
        .set({ revoked_at: kit.clock.now() })
        .where('id', '=', deviceId)
        .execute();
    }
    rejected(
      kit,
      CONSENTS,
      await f.device.post(CONSENTS, body(), undefined, { 'x-device-id': deviceId }),
      20001,
      { fields: ['X-Device-Id'] },
    );
    expect(await rows(f)).toEqual([]);
  },
);

it.each([
  { type: 'labor_agreement' },
  { channel: 'login_merge' },
  { channel: 'h5_landing' },
  { channel: 'withdraw_flow' },
  { type: 'user_agreement' },
  { type: 'agent_ai' },
  { version: 0 },
  { accepted: 'true' },
  { client_at: 'invalid' },
])('[AC-B1-02f#73][BR-ID-12] 非法同意参数 %j 拒绝且无副作用', async (invalid) => {
  const f = await fixture(kit);
  const response = await f.post(CONSENTS, { ...body(), ...invalid });
  rejected(kit, CONSENTS, response, 20001);
  expect(response.json<{ data: { fields: string[] } }>().data.fields).toContain(
    Object.keys(invalid)[0],
  );
  expect(await rows(f)).toEqual([]);
});

it('[AC-B1-02f#74][BR-ID-12] 同 type 只追加不覆盖，当前状态取最新 server_at 而非最大 version/client_at', async () => {
  const f = await fixture(kit);
  accepted(
    kit,
    CONSENTS,
    await f.post(CONSENTS, body({ version: 9, client_at: '2026-10-08T01:59:00Z' })),
  );
  const first = (await rows(f))[0]!;
  kit.clock.advanceMs(1000);
  const latest = kit.clock.now();
  accepted(
    kit,
    CONSENTS,
    await f.post(
      CONSENTS,
      body({ version: 1, accepted: false, client_at: '2026-10-07T00:00:00Z' }),
    ),
  );
  const all = await rows(f);
  expect(all).toHaveLength(2);
  expect(all[0]).toEqual(first);
  const history = await f.db
    .transaction()
    .execute((trx) => userConsentRecords(trx, f.appId, f.uid));
  expect(history.sort((a, b) => b.server_at.getTime() - a.server_at.getTime())[0]).toMatchObject({
    type: 'agreement',
    accepted: false,
    version: 1,
    server_at: latest,
  });
});

it('[AC-B1-02f#75][BR-ID-13] 撤回隐私总是设备级：吊销该设备所有 sid、密钥、推送，另一设备不受影响', async () => {
  const f = await fixture(kit);
  accepted(kit, CONSENTS, await f.post(CONSENTS, body({ type: 'privacy' })));
  const before = await rows(f);
  const anotherUser = await seedUser(f.db, f.appId);
  const extraSession = await f.issue(anotherUser);
  const secondDevice = await client(kit, f.appId);
  const secondSession = await f.issue(f.uid, secondDevice.deviceId);
  await push(f, f.device.deviceId, f.session.sid);
  const retainedPush = await push(f, secondDevice.deviceId, secondSession.sid);
  accepted(kit, CONSENTS, await f.post(CONSENTS, body({ type: 'privacy', accepted: false })));
  const all = await rows(f);
  expect(all).toHaveLength(2);
  expect(all[0]).toEqual(before[0]);
  expect(all[1]).toMatchObject({
    subject_type: 'device',
    user_id: f.uid,
    device_id: f.device.deviceId,
    type: 'privacy',
    accepted: false,
    server_at: kit.clock.now(),
    created_at: kit.clock.now(),
  });
  const sessions = await f.db
    .selectFrom('sessions')
    .select(['sid', 'revoked_at'])
    .where('app_id', '=', f.appId)
    .execute();
  expect(sessions).toEqual(
    expect.arrayContaining([
      { sid: f.session.sid, revoked_at: kit.clock.now() },
      { sid: extraSession.sid, revoked_at: kit.clock.now() },
      { sid: secondSession.sid, revoked_at: null },
    ]),
  );
  expect(
    await f.db
      .selectFrom('devices')
      .select('revoked_at')
      .where('id', '=', f.device.deviceId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ revoked_at: kit.clock.now() });
  expect(
    await f.db
      .selectFrom('devices')
      .select('revoked_at')
      .where('id', '=', secondDevice.deviceId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ revoked_at: null });
  expect(
    await f.db.selectFrom('push_tokens').select('id').where('app_id', '=', f.appId).execute(),
  ).toEqual([{ id: retainedPush }]);
  rejected(kit, H5, await f.post(H5, {}), 10002);
  rejected(kit, H5, await f.post(H5, {}, extraSession.access_token), 10002);
  accepted(kit, H5, await secondDevice.post(H5, {}, secondSession.access_token));
  rejected(
    kit,
    ATTEMPTS,
    await f.device.post(ATTEMPTS, { provider: 'wechat', purpose: 'login' }),
    10402,
  );
  expect(
    await f.db
      .selectFrom('users')
      .select('status')
      .where('id', '=', f.uid)
      .executeTakeFirstOrThrow(),
  ).toEqual({ status: 'normal' });
});

it('[AC-B1-02f#76][BR-ID-13] 游客同样可以撤回隐私，user_id 空且设备密钥和推送失效', async () => {
  const f = await fixture(kit);
  await push(f, f.device.deviceId, f.session.sid);
  accepted(
    kit,
    CONSENTS,
    await f.device.post(CONSENTS, body({ type: 'privacy', accepted: false })),
  );
  expect(await rows(f)).toEqual([
    expect.objectContaining({
      subject_type: 'device',
      user_id: null,
      device_id: f.device.deviceId,
      type: 'privacy',
      accepted: false,
    }),
  ]);
  expect(
    await f.db
      .selectFrom('devices')
      .select('revoked_at')
      .where('id', '=', f.device.deviceId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ revoked_at: kit.clock.now() });
  expect(
    await f.db.selectFrom('push_tokens').select('id').where('app_id', '=', f.appId).execute(),
  ).toEqual([]);
  rejected(kit, H5, await f.post(H5, {}), 10002);
});

it('[AC-B1-02f#77][BR-ID-13] 个性化开关每次写审计并同步 users.personalization_off', async () => {
  const f = await fixture(kit);
  for (const value of [false, true]) {
    accepted(
      kit,
      CONSENTS,
      await f.post(CONSENTS, body({ type: 'personalization', accepted: value })),
    );
    expect(
      await f.db
        .selectFrom('users')
        .select('personalization_off')
        .where('id', '=', f.uid)
        .executeTakeFirstOrThrow(),
    ).toEqual({ personalization_off: !value });
    kit.clock.advanceMs(1000);
  }
  const history = await rows(f);
  expect(
    history.map((row) => ({ type: row.type, subject: row.subject_type, accepted: row.accepted })),
  ).toEqual([
    { type: 'personalization', subject: 'user', accepted: false },
    { type: 'personalization', subject: 'user', accepted: true },
  ]);
  expect((await f.post(H5, {})).statusCode).toBe(200);
});

it('[AC-B1-02f#78][BR-ID-12/13] 撤回非隐私同意仍是用户级，不吊销会话或设备', async () => {
  const f = await fixture(kit);
  accepted(
    kit,
    CONSENTS,
    await f.post(CONSENTS, body({ type: 'ai_third_party', accepted: false })),
  );
  expect(await rows(f)).toEqual([
    expect.objectContaining({ subject_type: 'user', user_id: f.uid, accepted: false }),
  ]);
  expect((await f.post(H5, {})).statusCode).toBe(200);
  expect(
    await f.db
      .selectFrom('devices')
      .select('revoked_at')
      .where('id', '=', f.device.deviceId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ revoked_at: null });
});

it('[AC-B1-02f#79][BR-ID-12] server_at 与 created_at 用同一次 Clock 读取，不采信 client_at', async () => {
  const f = await fixture(kit);
  const now = vi.fn(() => {
    const instant = kit.clock.now();
    kit.clock.advanceMs(1000);
    return instant;
  });
  const expectedTime = kit.clock.now();
  const service = createConsentService({ db: f.db, clock: { now } });
  expect(await service.record({ app_id: f.appId, principal: f.principal, body: body() })).toEqual({
    code: 0,
    data: {},
  });
  expect(now).toHaveBeenCalledTimes(1);
  expect(await rows(f)).toEqual([
    expect.objectContaining({
      server_at: expectedTime,
      created_at: expectedTime,
      client_at: new Date(body().client_at),
    }),
  ]);
});

it('[AC-B1-02f#80][BR-ID-13] 清理推送失败时整笔事务回滚，同意、会话、设备不得部分提交', async () => {
  const f = await fixture(kit);
  const pushId = await push(f, f.device.deviceId, f.session.sid);
  const fault = vi.fn(() => {
    throw new Error('test push deletion unavailable');
  });
  const db = f.db.withPlugin({
    transformQuery(args) {
      if (args.node.kind === 'DeleteQueryNode' && JSON.stringify(args.node).includes('push_tokens'))
        fault();
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const service = createConsentService({ db, clock: kit.clock });
  await expect(
    service.record({
      app_id: f.appId,
      principal: f.principal,
      body: body({ type: 'privacy', accepted: false }),
    }),
  ).rejects.toThrow('test push deletion unavailable');
  expect(fault).toHaveBeenCalledTimes(1);
  expect(await rows(f)).toEqual([]);
  expect(
    await f.db
      .selectFrom('sessions')
      .select('revoked_at')
      .where('sid', '=', f.session.sid)
      .executeTakeFirstOrThrow(),
  ).toEqual({ revoked_at: null });
  expect(
    await f.db
      .selectFrom('devices')
      .select('revoked_at')
      .where('id', '=', f.device.deviceId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ revoked_at: null });
  expect(
    await f.db.selectFrom('push_tokens').select('id').where('app_id', '=', f.appId).execute(),
  ).toEqual([{ id: pushId }]);
});
