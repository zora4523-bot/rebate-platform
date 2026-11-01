// BR-ID-36 细则「规则清单的启停」 at risk's own hit writers (D10-536 §9.2 2): with the rule
// disabled none of them writes risk_hits, and where risk itself decides (blocklist check and the
// registration match, the same-device judgement) the disabled rule decides nothing either, so no
// refusal ever goes out without a hit to appeal. Writers keep their existing options and read the
// status themselves; a change takes effect after the configuration items' cache period. Every
// service is created inside the test body.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createBlocklistService,
  createInviteRelationHitWriter,
  createOrderBlocklistPorts,
  createSameDeviceAccountsCheck,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { closeKit, openKit, seedUser, type Kit } from '../../identity/registration/kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { seedBlock } from '../blocklist/kit.ts';
import { H, login } from '../same-device/kit.ts';
import { AT, DEVICE_DIGEST, TTL_MS, hits, newAppId, setRuleStatus, type RuleId } from './kit.ts';

type SameDeviceLogins =
  typeof import('../../../../apps/api/src/modules/identity/ports/same-device-logins.ts');

const PHONE = '13812345678';
let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

function blocklist(clock: FixedClock) {
  return createBlocklistService({
    db: kit.db,
    clock,
    crypto: kit.crypto,
    logger: memoryLogger().logger,
  });
}
function phoneDigest(): string {
  return kit.crypto.blindIndex(PHONE, 'users.phone');
}
function status(appId: string, ruleId: RuleId, value: 'enabled' | 'disabled', clock: FixedClock) {
  return setRuleStatus(kit.db, appId, ruleId, value, clock.now());
}

it.each([
  { rule_id: 'SMS_BLOCKED_PREFIX', dimension: 'phone_prefix' },
  { rule_id: 'DEVICE_REGISTER_LIMIT', dimension: 'device' },
] as const)(
  '[AC-B1-03zh#13][BR-ID-36] blocklist.recordHit：$rule_id 停用不写命中，启用并过缓存周期后照常写',
  async ({ rule_id, dimension }) => {
    const appId = newAppId();
    const clock = new FixedClock(AT);
    await status(appId, rule_id, 'disabled', clock);
    const service = blocklist(clock);
    const input = {
      app_id: appId,
      request_type: 'register' as const,
      related_phone: PHONE,
      dimension,
      rule_id,
      value_hmac: dimension === 'device' ? DEVICE_DIGEST : phoneDigest(),
    };
    await service.recordHit(input);
    expect(await hits(kit.db, appId)).toEqual([]);

    await status(appId, rule_id, 'enabled', clock);
    clock.advanceMs(TTL_MS);
    await service.recordHit(input);
    expect(await hits(kit.db, appId)).toEqual([
      expect.objectContaining({
        rule_id,
        dimension,
        value_hmac: input.value_hmac,
        ref_type: 'blocked_request',
        request_type: 'register',
        created_at: clock.now(),
      }),
    ]);
  },
);

it('[AC-B1-03zh#14][BR-ID-36][BR-ID-31] blocklist.check：BLACKLIST_PHONE 停用时不判定（无 44001）、不写命中；启用后恢复', async () => {
  const appId = newAppId();
  const clock = new FixedClock(AT);
  await seedBlock(kit.db, appId, 'phone', phoneDigest(), clock, {
    expires: new Date(clock.now().getTime() + 10 * TTL_MS),
  });
  await status(appId, 'BLACKLIST_PHONE', 'disabled', clock);
  const service = blocklist(clock);
  const input = {
    app_id: appId,
    dimension: 'phone' as const,
    value: PHONE,
    related_phone: PHONE,
    request_type: 'register' as const,
  };
  expect(await service.check(input)).toBeNull();
  expect(await hits(kit.db, appId)).toEqual([]);

  await status(appId, 'BLACKLIST_PHONE', 'enabled', clock);
  clock.advanceMs(TTL_MS);
  expect(await service.check(input)).toMatchObject({ code: 44001 });
  expect(await hits(kit.db, appId)).toEqual([
    expect.objectContaining({ rule_id: 'BLACKLIST_PHONE', value_hmac: phoneDigest() }),
  ]);
});

it('[AC-B1-03zh#15][BR-ID-36][BR-ID-31] 建号前黑名单：停用的 BLACKLIST_PHONE 不进判定与命中，启用的 BLACKLIST_DEVICE 照常', async () => {
  const appId = newAppId();
  const clock = new FixedClock(AT);
  const expires = new Date(clock.now().getTime() + 10 * TTL_MS);
  await seedBlock(kit.db, appId, 'phone', phoneDigest(), clock, { expires });
  await seedBlock(kit.db, appId, 'device', DEVICE_DIGEST, clock, { expires });
  await status(appId, 'BLACKLIST_PHONE', 'disabled', clock);
  const service = blocklist(clock);
  const input = {
    app_id: appId,
    phone_hmac: phoneDigest(),
    device_hash: DEVICE_DIGEST,
    related_phone: PHONE,
  };
  const block = await kit.db.transaction().execute((trx) => service.matchRegistration(trx, input));
  expect(block).toMatchObject({ code: 44001 });
  expect(block?.hits).toEqual([
    { dimension: 'device', value_hmac: DEVICE_DIGEST, rule_id: 'BLACKLIST_DEVICE' },
  ]);
  const request = { app_id: appId, request_type: 'register' as const, related_phone: PHONE };
  await service.recordHits(request, block?.hits ?? []);
  // A stale target of the disabled rule handed to the writer is not written either.
  await service.recordHits(request, [
    { dimension: 'phone', value_hmac: phoneDigest(), rule_id: 'BLACKLIST_PHONE' },
  ]);
  expect(await hits(kit.db, appId)).toEqual([
    expect.objectContaining({ rule_id: 'BLACKLIST_DEVICE', value_hmac: DEVICE_DIGEST }),
  ]);

  // Both disabled: nothing is decided at all.
  await status(appId, 'BLACKLIST_DEVICE', 'disabled', clock);
  clock.advanceMs(TTL_MS);
  expect(
    await kit.db.transaction().execute((trx) => service.matchRegistration(trx, input)),
  ).toBeNull();
});

it('[AC-B1-03zh#16][BR-ID-36][BR-ATTR-26] order-blocklist.recordHit：BLACKLIST_HIT 停用不写命中，启用并过缓存周期后照常写', async () => {
  const appId = newAppId();
  const clock = new FixedClock(AT);
  await status(appId, 'BLACKLIST_HIT', 'disabled', clock);
  const ports = createOrderBlocklistPorts({ clock, crypto: kit.crypto });
  const input = {
    app_id: appId,
    user_id: null,
    order_id: randomUUID(),
    dimension: 'order_no_suffix' as const,
    value: '123456',
    risk_action: 'manual_review' as const,
  };
  await kit.db.transaction().execute((trx) => ports.recordHit(trx, input));
  expect(await hits(kit.db, appId)).toEqual([]);

  await status(appId, 'BLACKLIST_HIT', 'enabled', clock);
  clock.advanceMs(TTL_MS);
  await kit.db.transaction().execute((trx) => ports.recordHit(trx, input));
  expect(await hits(kit.db, appId)).toEqual([
    expect.objectContaining({
      rule_id: 'BLACKLIST_HIT',
      risk_action: 'manual_review',
      ref_type: 'order',
      ref_id: input.order_id,
      created_at: clock.now(),
    }),
  ]);
});

it('[AC-B1-03zh#17][BR-ID-36][BR-INV-09] invite-relation-hits：inv_09_same_device 停用不写命中，启用并过缓存周期后照常写', async () => {
  const appId = newAppId();
  const clock = new FixedClock(AT);
  const uid = await seedUser(kit.db, appId);
  await status(appId, 'inv_09_same_device', 'disabled', clock);
  const writer = createInviteRelationHitWriter({ clock });
  const input = {
    app_id: appId,
    user_id: uid,
    rule_id: 'inv_09_same_device' as const,
    dimension: 'device_id_hash' as const,
    value_hmac: DEVICE_DIGEST,
  };
  await kit.db.transaction().execute((trx) => writer.record(trx, input));
  expect(await hits(kit.db, appId)).toEqual([]);

  await status(appId, 'inv_09_same_device', 'enabled', clock);
  clock.advanceMs(TTL_MS);
  await kit.db.transaction().execute((trx) => writer.record(trx, input));
  expect(await hits(kit.db, appId)).toEqual([
    expect.objectContaining({
      user_id: uid,
      rule_id: 'inv_09_same_device',
      dimension: 'device_id_hash',
      value_hmac: DEVICE_DIGEST,
      ref_type: 'invite_relation',
      ref_id: uid,
      created_at: clock.now(),
    }),
  ]);
});

it('[AC-B1-03zh#18][BR-ID-36][BR-ID-37] same-device-accounts：SAME_DEVICE_MULTI_ACCOUNT 停用时不标记、不写命中；启用并过缓存周期后照常判定', async () => {
  const appId = newAppId();
  // The 720 h window of BR-ID-37 must hold the three first logins below.
  const clock = new FixedClock('2026-09-25T00:00:00.000Z');
  const a = await seedUser(kit.db, appId);
  const b = await seedUser(kit.db, appId);
  const c = await seedUser(kit.db, appId);
  await login(kit.db, appId, a, H, '2026-09-01T00:00:00Z');
  await login(kit.db, appId, b, H, '2026-09-10T00:00:00Z');
  await login(kit.db, appId, c, H, '2026-09-20T00:00:00Z');
  await status(appId, 'SAME_DEVICE_MULTI_ACCOUNT', 'disabled', clock);
  const identity = (await import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  )) as SameDeviceLogins;
  const check = createSameDeviceAccountsCheck({
    clock,
    logger: memoryLogger().logger,
    logins: identity.createSameDeviceLoginReader(),
    config: () => ({ configValue: async () => null }),
  });
  const judge = (ref: string) =>
    check.judge(kit.db, { app_id: appId, user_id: c, ref: { type: 'withdrawal', id: ref } });
  expect((await judge(randomUUID())).marked).toBe(false);
  expect(await hits(kit.db, appId)).toEqual([]);

  await status(appId, 'SAME_DEVICE_MULTI_ACCOUNT', 'enabled', clock);
  clock.advanceMs(TTL_MS);
  const ref = randomUUID();
  expect((await judge(ref)).marked).toBe(true);
  expect(await hits(kit.db, appId)).toEqual([
    expect.objectContaining({
      user_id: c,
      rule_id: 'SAME_DEVICE_MULTI_ACCOUNT',
      dimension: 'device',
      value_hmac: H,
      ref_type: 'withdrawal',
      ref_id: ref,
      created_at: clock.now(),
    }),
  ]);
});
