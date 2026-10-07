import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createBlocklistService } from '../../../../apps/api/src/modules/risk/index.ts';
import { createSmsCodeService } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import type { SmsLoginOptions } from '../../../../apps/api/src/modules/identity/application/sms-login.ts';
import { createRegistrationService } from '../../../../apps/api/src/modules/identity/application/registration.ts';
import { context, anchorAfterRecords } from '../../identity/registration/kit.ts';
import { fixture as loginFixture, rows } from '../../identity/sms-login/kit.ts';
import {
  acquireRedis,
  fixture as smsFixture,
  type TestRedis,
} from '../../identity/sms-codes/kit.ts';
import {
  closeKit,
  expectRegistrationHit,
  openKit,
  PHONE,
  phoneHmac,
  seedBlock,
  seedUser,
  setup,
  type Kit,
} from './kit.ts';

let kit: Kit;
let redis: TestRedis | undefined;
beforeAll(async () => {
  kit = await openKit();
  redis = await acquireRedis();
}, 180_000);
afterAll(async () => {
  try {
    await closeKit(kit);
  } finally {
    await redis?.stop();
  }
});

it('[AC-B1-03d#14][BR-ID-05/36] 发码手机号端口返回 phone_blocklist，未发短信、不占额度且早于后续钩子', async () => {
  expect(redis).toBeDefined();
  const f = await setup(kit);
  const risk = createBlocklistService(f.options);
  const id = await seedBlock(kit.db, f.appId, 'phone', phoneHmac(kit.crypto), f.clock);
  const sms = await smsFixture(redis!, { clock: f.clock });
  try {
    const captcha = vi.fn(async () => null);
    const deviceQuota = vi.fn(async () => null);
    const service = createSmsCodeService({
      ...sms.options,
      hooks: {
        phoneBlocklist: async (request) => {
          const hit = await risk.check({
            app_id: request.app_id,
            dimension: 'phone',
            value: request.phone,
            related_phone: request.phone,
            request_type: 'register',
          });
          return hit === null ? null : { ...hit, kind: 'phone_blocklist' };
        },
        captcha,
        deviceQuota,
      },
    });
    const request = { app_id: f.appId, phone: `+86 ${PHONE}`, purpose: 'login' as const };
    expect(await service.send(request)).toMatchObject({
      code: 44001,
      kind: 'phone_blocklist',
      data: { risk_msg_code: 'blocklist.fraud_invite' },
    });
    expect(sms.sender.outbox()).toEqual([]);
    expect(captcha).not.toHaveBeenCalled();
    expect(deviceQuota).not.toHaveBeenCalled();
    await expectRegistrationHit(kit.db, {
      app: f.appId,
      crypto: kit.crypto,
      clock: f.clock,
      phone: PHONE,
      dimension: 'phone',
      value_hmac: phoneHmac(kit.crypto),
      rule: 'BLACKLIST_PHONE',
    });
    await sql`UPDATE app.blocklist SET status = 'inactive' WHERE id = ${id}`.execute(kit.db);
    // Same Clock and same Redis counters: a refused send must not consume even the 60s quota.
    expect(await service.send(request)).toMatchObject({ code: 0 });
    expect(sms.sender.outbox()).toHaveLength(1);
  } finally {
    await sms.close();
  }
});

it('[AC-B1-03d#15][BR-ID-31/36] 验证码登录的建号前端口拦截，业务事务回滚但 risk_hits 留存', async () => {
  const f = await loginFixture(kit);
  const risk = createBlocklistService({
    db: kit.db,
    clock: f.clock,
    crypto: kit.crypto,
    logger: f.options.logger,
  });
  const phone = f.command.body.phone;
  const digest = phoneHmac(kit.crypto, phone);
  await seedBlock(kit.db, f.appId, 'phone', digest, f.clock);
  const before = await rows(kit, f.appId);
  const legacyHook = vi.fn<NonNullable<SmsLoginOptions['phoneBlocklist']>>(async () => null);
  const hook = vi.fn<NonNullable<SmsLoginOptions['registrationBlocklist']>>(async (trx, input) =>
    risk.checkRegistration(trx, {
      ...input,
      related_phone: input.phone,
    }),
  );
  expect(
    await f.login({}, { registrationBlocklist: hook, phoneBlocklist: legacyHook }),
  ).toMatchObject({
    code: 44001,
    data: { risk_msg_code: 'blocklist.fraud_invite' },
  });
  expect(hook).toHaveBeenCalledTimes(1);
  expect(legacyHook).not.toHaveBeenCalled();
  expect(hook.mock.calls[0]?.[0].isTransaction).toBe(true);
  expect(hook.mock.calls[0]?.[1]).toEqual({
    app_id: f.appId,
    phone,
    phone_hmac: digest,
    device_hash: f.hash,
  });
  expect(f.register).not.toHaveBeenCalled();
  expect(await rows(kit, f.appId)).toEqual(before);
  await expectRegistrationHit(kit.db, {
    app: f.appId,
    crypto: kit.crypto,
    clock: f.clock,
    phone,
    dimension: 'phone',
    value_hmac: digest,
    rule: 'BLACKLIST_PHONE',
  });
});

it('[AC-B1-03d#16][BR-ID-05/36] 满设备调用一次性放行读取端口；无记录默认拒绝、不创建新号', async () => {
  const f = await context(kit);
  const outsideTransactionQuery = vi.fn(() => {
    throw new Error('Allowance reads must use the caller transaction');
  });
  const queryForbiddenDb = kit.db.withPlugin({
    transformQuery: outsideTransactionQuery,
    async transformResult(args) {
      return args.result;
    },
  });
  const risk = createBlocklistService({
    db: queryForbiddenDb,
    clock: f.clock,
    crypto: kit.crypto,
    logger: f.options.logger,
  });
  for (let i = 0; i < 3; i++) await seedUser(kit.db, f.appId, { hash: f.hash });
  await anchorAfterRecords(kit, f);
  const before = await rows(kit, f.appId);
  const allow = vi.fn(risk.allowBlockedRegistration.bind(risk));
  const registration = createRegistrationService({
    ...f.options,
    allowBlockedRegistration: (trx, input) => allow(trx, input),
  });
  await kit.db.transaction().execute(async (trx) => {
    expect(await registration.register(trx, f.command)).toMatchObject({
      code: 44001,
      kind: 'device_register_limit',
    });
    expect(allow).toHaveBeenCalledExactlyOnceWith(trx, {
      app_id: f.appId,
      device_hash: f.hash,
      count: 3,
      limit: 3,
      phone_hmac: phoneHmac(kit.crypto, f.command.phone!),
      third_party_digest: null,
    });
    // Preserve the exact caller transaction for future atomic release reads/consumption.
    expect(allow.mock.calls[0]?.[0]).toBe(trx);
    expect(trx.isTransaction).toBe(true);
    expect(await allow.mock.results[0]?.value).toBe(false);
  });
  expect(outsideTransactionQuery).not.toHaveBeenCalled();
  expect(await rows(kit, f.appId)).toEqual(before);
});
