// BR-ID-36 细则「规则清单的启停」 × BR-ID-05 号段拦截 (rule SMS_BLOCKED_PREFIX; D10-536 §9.2 2):
// identity asks the rule status before deciding, so a disabled rule neither refuses (no 44001
// blocked_prefix) nor records a hit. Real signed POST /v1/auth/sms-codes on the real AppModule.
import { expect, it } from 'vitest';
import { fixture, rejected, type Fixture } from '../../identity/oauth-login/kit.ts';
import { phone } from '../../identity/sms-codes/kit.ts';
import {
  SMS_PATH,
  TTL_MS,
  appHits,
  appeals,
  codeSent,
  masked,
  nothingSent,
  phoneDigest,
  seedAppeal,
  sendCode,
  toggle,
  withApp,
} from './kit.ts';

/** A number inside the default blocked prefixes (sms.blocked_prefixes unset: 170, 171, …). */
const blockedNumber = () => phone('170');

/** 44001, nothing sent, and exactly one SMS_BLOCKED_PREFIX hit of this number. */
async function refusedWithHit(f: Fixture, number: string) {
  const response = await sendCode(f, number);
  rejected(f.kit, SMS_PATH, response, 44001);
  nothingSent(f, number);
  const rows = await appHits(f);
  expect(rows.filter((row) => row.related_phone_hmac === phoneDigest(f, number))).toEqual([
    expect.objectContaining({
      app_id: f.appId,
      user_id: null,
      rule_id: 'SMS_BLOCKED_PREFIX',
      risk_action: 'block',
      dimension: 'phone_prefix',
      value_hmac: phoneDigest(f, number),
      ref_type: 'blocked_request',
      request_type: 'register',
      related_phone_masked: masked(number),
      created_at: f.kit.clock.now(),
    }),
  ]);
}

it('[AC-B1-03zh#5][BR-ID-36][BR-ID-05] SMS_BLOCKED_PREFIX 停用：号段内号码照常发码、不回 44001、不写命中；启用并过缓存周期后恢复拦截与记命中', async () => {
  await withApp(async (f) => {
    await toggle(f, 'SMS_BLOCKED_PREFIX', 'disabled');
    const passed = blockedNumber();
    codeSent(f, await sendCode(f, passed), passed);
    expect(await appHits(f)).toEqual([]);

    await toggle(f, 'SMS_BLOCKED_PREFIX', 'enabled');
    f.kit.clock.advanceMs(TTL_MS);
    await refusedWithHit(f, blockedNumber());
    expect(await appHits(f)).toHaveLength(1);
  });
});

it('[AC-B1-03zh#6][BR-ID-36] 停用前已写的命中与申诉不变，停用不追溯；停用后的请求不再判定', async () => {
  await withApp(async (f) => {
    // No row yet: the rule takes part, and the hit writer registers it.
    await refusedWithHit(f, blockedNumber());
    const [hit] = await appHits(f);
    expect(hit).toBeDefined();
    await seedAppeal(f.kit.suite.db, f.appId, hit!, f.kit.clock.now());
    const hitsBefore = await appHits(f);
    const appealsBefore = await appeals(f.kit.suite.db, f.appId);

    await toggle(f, 'SMS_BLOCKED_PREFIX', 'disabled');
    f.kit.clock.advanceMs(TTL_MS);
    const later = blockedNumber();
    codeSent(f, await sendCode(f, later), later);
    expect(await appHits(f)).toEqual(hitsBefore);
    expect(await appeals(f.kit.suite.db, f.appId)).toEqual(appealsBefore);
  });
});

it('[AC-B1-03zh#7][BR-ID-36] A app 停用 SMS_BLOCKED_PREFIX 不影响 B app 同名规则', async () => {
  await withApp(async (a) => {
    const b = await fixture(a.kit);
    await toggle(a, 'SMS_BLOCKED_PREFIX', 'disabled');
    await toggle(b, 'SMS_BLOCKED_PREFIX', 'enabled');
    const inA = blockedNumber();
    codeSent(a, await sendCode(a, inA), inA);
    expect(await appHits(a)).toEqual([]);
    await refusedWithHit(b, blockedNumber());
    expect(await appHits(b)).toHaveLength(1);
  });
});

it('[AC-B1-03zh#8][BR-ID-36][04 §10.2] 缓存周期内停用不立即生效（照旧拦截且每次拒绝都有命中），满周期后才放行', async () => {
  await withApp(async (f) => {
    await refusedWithHit(f, blockedNumber());
    await toggle(f, 'SMS_BLOCKED_PREFIX', 'disabled');
    f.kit.clock.advanceMs(TTL_MS - 1);
    // Still in force: the refusal and its hit go together (never a refusal without a hit).
    await refusedWithHit(f, blockedNumber());
    expect(await appHits(f)).toHaveLength(2);
    f.kit.clock.advanceMs(1);
    const passed = blockedNumber();
    codeSent(f, await sendCode(f, passed), passed);
    expect(await appHits(f)).toHaveLength(2);
  });
});
