import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { createTokenCheck } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createH5TokenService } from '../../../../apps/api/src/modules/identity/application/h5-token.ts';
import { createSessionLookup } from '../../../../apps/api/src/modules/identity/infra/session-lookup.ts';
import { request } from '../token/kit.ts';
import {
  H5,
  CONSENTS,
  accepted,
  rejected,
  fixture,
  jwt,
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

async function issue(f: Fixture, scope?: 'read_only' | 'standard') {
  return accepted<Schema<'H5TokenData'>>(
    kit,
    H5,
    await f.post(H5, scope === undefined ? {} : { scope }),
  );
}
function check(f: Fixture, token: string, method: string, path: string, appId = f.appId) {
  const input = request(
    { method, path },
    {
      'x-app-id': appId,
      'x-platform': 'h5',
      'x-channel': 'official',
      'x-app-version': '2.0.0',
      'x-device-id': f.device.deviceId,
      authorization: `Bearer ${token}`,
    },
  );
  input.verifiedDevice = { appId, deviceId: f.device.deviceId };
  const guard = createTokenCheck({ tokens: f.tokens, sessions: createSessionLookup(f.db) });
  return { input, run: () => guard(input) };
}

it.each([undefined, 'read_only', 'standard'] as const)(
  '[AC-B1-02f#50][BR-ID-32] scope=%s：缺省只读，ES256、aud=h5、sid、900 秒',
  async (scope) => {
    const f = await fixture(kit);
    const data = await issue(f, scope);
    expect(data.scope).toBe(scope ?? 'read_only');
    expect(jwt(f, data.token, 'h5', 900, data.expire_at)).toMatchObject({
      scp: scope ?? 'read_only',
    });
    expect(data.token).not.toBe(f.session.access_token);
    expect(kit.lines.join('')).not.toContain(data.token);
  },
);

it.each(['read_only', 'standard'] as const)(
  '[AC-B1-02f#51][BR-ID-32] %s 可通过普通登录 GET 守卫，principal 取令牌',
  async (scope) => {
    const f = await fixture(kit);
    const data = await issue(f, scope);
    // getMe is still planned. Exercise its real contract policy without faking a business GET.
    const read = check(f, data.token, 'GET', '/v1/me');
    await read.run();
    expect(read.input.principal).toMatchObject({
      uid: f.uid,
      app_id: f.appId,
      sid: f.session.sid,
      device_id: f.device.deviceId,
    });
  },
);

it('[AC-B1-02f#52][BR-ID-32] read_only 禁止轻量写，10403 reason=h5_read_only，无同意记录', async () => {
  const f = await fixture(kit);
  const data = await issue(f);
  const response = await f.post(
    CONSENTS,
    {
      type: 'agreement',
      version: 1,
      accepted: true,
      channel: 'privacy_center',
      client_at: kit.clock.now().toISOString(),
    },
    data.token,
  );
  rejected(kit, CONSENTS, response, 10403, { reason: 'h5_read_only' });
  expect(
    await f.db.selectFrom('consent_records').select('id').where('app_id', '=', f.appId).execute(),
  ).toEqual([]);
});

it('[AC-B1-02f#53][BR-ID-32] standard 可调用作用域内轻量写', async () => {
  const f = await fixture(kit);
  const data = await issue(f, 'standard');
  expect(
    accepted(
      kit,
      CONSENTS,
      await f.post(
        CONSENTS,
        {
          type: 'agreement',
          version: 1,
          accepted: true,
          channel: 'privacy_center',
          client_at: kit.clock.now().toISOString(),
        },
        data.token,
      ),
    ),
  ).toEqual({});
  expect(
    await f.db
      .selectFrom('consent_records')
      .select(['user_id', 'device_id'])
      .where('app_id', '=', f.appId)
      .execute(),
  ).toEqual([{ user_id: f.uid, device_id: f.device.deviceId }]);
});

it.each([
  ['POST', '/v1/auth/h5-token'],
  ['POST', '/v1/auth/logout'],
  ['POST', '/v1/auth/refresh'],
  ['POST', '/v1/auth/sms-codes'],
  ['GET', '/v1/withdrawals'],
  ['GET', '/v1/withdrawals/rules'],
  ['GET', '/v1/withdrawals/:withdrawal_id'],
  ['POST', '/v1/withdrawals'],
  ['GET', '/v1/me/payout-account'],
  ['PUT', '/v1/me/payout-account'],
  ['POST', '/v1/me/phone'],
  ['GET', '/v1/me/deletion'],
  ['POST', '/v1/me/deletion'],
  ['POST', '/v1/me/deletion/cancel'],
  ['POST', '/v1/links/convert'],
] as const)(
  '[AC-B1-02f#54][BR-ID-32] standard 越权 %s %s 返回 10403 而非 10001',
  async (method, path) => {
    const f = await fixture(kit);
    const data = await issue(f, 'standard');
    await expect(check(f, data.token, method, path).run()).rejects.toMatchObject({ code: 10403 });
  },
);

it('[AC-B1-02f#55][BR-ID-32] standard 不能通过真实 HTTP 再换取 h5_token', async () => {
  const f = await fixture(kit);
  const data = await issue(f, 'standard');
  rejected(kit, H5, await f.post(H5, {}, data.token), 10403);
});

it('[AC-B1-02f#56][BR-ID-32] logout 后该 sid 的 H5 立即失效，其他 sid 不受影响', async () => {
  const f = await fixture(kit);
  const data = await issue(f);
  const second = await f.issue();
  const other = accepted<Schema<'H5TokenData'>>(kit, H5, await f.post(H5, {}, second.access_token));
  const response = await f.post('/v1/auth/logout', {});
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await expect(check(f, data.token, 'GET', '/v1/me').run()).rejects.toMatchObject({ code: 10002 });
  rejected(kit, H5, await f.post(H5, {}), 10002);
  const stillActive = check(f, other.token, 'GET', '/v1/me');
  await stillActive.run();
  expect(stillActive.input.principal).toHaveProperty('sid', second.sid);
});

it.each([899_000, 900_000])('[AC-B1-02f#57][BR-ID-32] H5 到期边界 %i 毫秒', async (elapsed) => {
  const f = await fixture(kit);
  const data = await issue(f);
  kit.clock.advanceMs(elapsed);
  const read = check(f, data.token, 'GET', '/v1/me');
  if (elapsed === 900_000) await expect(read.run()).rejects.toMatchObject({ code: 10002 });
  else {
    await read.run();
    expect(read.input.principal).toHaveProperty('uid', f.uid);
  }
});

it('[AC-B1-02f#58][BR-ID-32] 配置 H5 TTL；已经吊销的会话不能再次签发', async () => {
  const f = await fixture(kit);
  const service = createH5TokenService({
    clock: kit.clock,
    keys: f.keys,
    sessions: createSessionLookup(f.db),
    config: {
      configValue: async (app, key) => {
        expect(app).toBe(f.appId);
        return key === 'auth.h5_token_ttl_sec' ? { value: 120, version: 1 } : null;
      },
    },
  });
  const result = await service.issue({ principal: f.principal, body: {} });
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('unreachable after assertion');
  expect(jwt(f, result.data.token, 'h5', 120, result.data.expire_at)).toHaveProperty(
    'scp',
    'read_only',
  );
  expect((await f.post('/v1/auth/logout', {})).statusCode).toBe(200);
  expect(await service.issue({ principal: f.principal, body: {} })).toEqual({ code: 10002 });
});

it('[AC-B1-02f#59][BR-ID-32] H5 的 app_id 不可由请求头改写', async () => {
  const f = await fixture(kit);
  const data = await issue(f);
  await expect(check(f, data.token, 'GET', '/v1/me', 'another_app').run()).rejects.toMatchObject({
    code: 10403,
  });
});
