// BR-ID-36 细则「规则清单的启停」 × BR-ID-05 同设备注册上限 (rule DEVICE_REGISTER_LIMIT; D10-536
// §9.2 2): identity's registration asks the rule status before counting the device against the
// limit, so a disabled rule lets the registration through and records no hit. Real signed SMS code
// request and SMS login (POST /v1/auth/login/sms) on the real AppModule.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { accepted, rejected, type Fixture } from '../../identity/oauth-login/kit.ts';
import { phone } from '../../identity/sms-codes/kit.ts';
import {
  SMS_LOGIN_PATH,
  TTL_MS,
  appHits,
  deviceRegistrations,
  fillDevice,
  masked,
  phoneDigest,
  smsLogin,
  toggle,
  withApp,
} from './kit.ts';

async function accountsOf(f: Fixture, number: string) {
  const result = await sql<{ id: string }>`SELECT id FROM app.users
    WHERE app_id = ${f.appId} AND phone_hmac = ${phoneDigest(f, number)}`.execute(f.kit.suite.db);
  return result.rows;
}

/** A new account on the full device: 200, is_new_user, its registration recorded. */
async function registered(f: Fixture, number: string) {
  const data = accepted(f.kit, SMS_LOGIN_PATH, await smsLogin(f, number));
  expect(data.is_new_user).toBe(true);
  expect(await accountsOf(f, number)).toEqual([{ id: data.user_id }]);
  expect(await deviceRegistrations(f)).toContainEqual({ user_id: data.user_id });
  return data;
}

/** 44001, no account, and exactly one DEVICE_REGISTER_LIMIT hit of this number. */
async function refusedWithHit(f: Fixture, number: string) {
  rejected(f.kit, SMS_LOGIN_PATH, await smsLogin(f, number), 44001);
  expect(await accountsOf(f, number)).toEqual([]);
  const rows = await appHits(f);
  expect(rows.filter((row) => row.related_phone_hmac === phoneDigest(f, number))).toEqual([
    expect.objectContaining({
      app_id: f.appId,
      user_id: null,
      rule_id: 'DEVICE_REGISTER_LIMIT',
      risk_action: 'block',
      dimension: 'device',
      value_hmac: f.device.deviceHash,
      ref_type: 'blocked_request',
      request_type: 'register',
      related_phone_masked: masked(number),
      created_at: f.kit.clock.now(),
    }),
  ]);
}

it('[AC-B1-03zh#9][BR-ID-36][BR-ID-05] DEVICE_REGISTER_LIMIT 停用：满额设备照常注册、不记命中；启用并过缓存周期后恢复拦截与记命中', async () => {
  await withApp(async (f) => {
    await fillDevice(f);
    await toggle(f, 'DEVICE_REGISTER_LIMIT', 'disabled');
    await registered(f, phone());
    expect(await deviceRegistrations(f)).toHaveLength(4);
    expect(await appHits(f)).toEqual([]);

    await toggle(f, 'DEVICE_REGISTER_LIMIT', 'enabled');
    f.kit.clock.advanceMs(TTL_MS);
    await refusedWithHit(f, phone());
    expect(await deviceRegistrations(f)).toHaveLength(4);
    expect(await appHits(f)).toHaveLength(1);
  });
});

it('[AC-B1-03zh#10][BR-ID-36] 停用前的设备上限命中保留不变；停用不追溯，之后的注册不再判定', async () => {
  await withApp(async (f) => {
    await fillDevice(f);
    // No row yet: the limit applies and its hit is recorded.
    await refusedWithHit(f, phone());
    const before = await appHits(f);

    await toggle(f, 'DEVICE_REGISTER_LIMIT', 'disabled');
    f.kit.clock.advanceMs(TTL_MS);
    await registered(f, phone());
    expect(await appHits(f)).toEqual(before);
  });
});
