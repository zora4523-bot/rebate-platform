import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createOauthAttemptService,
  type OauthAttemptBinding,
} from '../../../../apps/api/src/modules/identity/application/oauth-attempts.ts';
import { createRedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection } from '../sms-codes/kit.ts';
import {
  ATTEMPTS,
  accepted,
  rejected,
  fixture,
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

function service(f: Fixture, ttl?: number) {
  return createOauthAttemptService({
    db: f.db,
    redis: f.redis,
    clock: kit.clock,
    config: {
      configValue: async (app, key) => {
        return app === f.appId && ttl !== undefined && key === 'auth.oauth_attempt_ttl_sec'
          ? { value: ttl, version: 1 }
          : null;
      },
    },
  });
}
function binding(f: Fixture): OauthAttemptBinding {
  return {
    app_id: f.appId,
    provider: 'wechat',
    purpose: 'step_up',
    uid: f.uid,
    device_id: f.device.deviceId,
    action: 'account_deletion',
  };
}
async function issued(
  f: Fixture,
  purpose: Schema<'OauthAttemptPurpose'> = 'step_up',
  ttl?: number,
) {
  const store = service(f, ttl);
  const result = await store.issue({
    body: {
      provider: 'wechat',
      purpose,
      ...(purpose === 'step_up' ? { action: 'account_deletion' } : {}),
    },
    principal: f.principal,
    verifiedDevice: { appId: f.appId, deviceId: f.device.deviceId },
  });
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('unreachable after assertion');
  return { store, data: result.data };
}

it.each(['wechat', 'apple', 'huawei'] as const)(
  '[AC-B1-02f#01][BR-ID-04] %s login 无令牌签发，响应合契约，nonce 与 attempt_id 不复用',
  async (provider) => {
    const f = await fixture(kit);
    const values = [];
    for (let i = 0; i < 2; i++) {
      const data = accepted<Schema<'OauthAttemptData'>>(
        kit,
        ATTEMPTS,
        await f.device.post(ATTEMPTS, { provider, purpose: 'login' }),
      );
      expect(data.nonce).toMatch(/^[0-9a-f]{64}$/);
      expect(Date.parse(data.expire_at)).toBe(kit.clock.now().getTime() + 600_000);
      values.push(data);
    }
    expect(values[0]!.attempt_id).not.toBe(values[1]!.attempt_id);
    expect(values[0]!.nonce).not.toBe(values[1]!.nonce);
  },
);

it.each(['step_up', 'payout_bind'] as const)(
  '[AC-B1-02f#02][BR-ID-04/08] %s 无登录身份拒绝 10001',
  async (purpose) => {
    const f = await fixture(kit);
    rejected(
      kit,
      ATTEMPTS,
      await f.device.post(ATTEMPTS, {
        provider: 'wechat',
        purpose,
        ...(purpose === 'step_up' ? { action: 'account_deletion' } : {}),
      }),
      10001,
    );
  },
);

it('[AC-B1-02f#03][BR-ID-08] 已绑手机不能取得第三方 step_up 尝试', async () => {
  const f = await fixture(kit, true);
  rejected(
    kit,
    ATTEMPTS,
    await f.post(ATTEMPTS, {
      provider: 'wechat',
      purpose: 'step_up',
      action: 'account_deletion',
    }),
    20001,
    { fields: ['provider'] },
  );
});

it.each([
  { provider: 'wechat', purpose: 'step_up' },
  { provider: 'wechat', purpose: 'step_up', action: 'unknown' },
  { provider: 'apple', purpose: 'payout_bind' },
  { provider: 'huawei', purpose: 'payout_bind' },
  { provider: 'wechat', purpose: 'payout_bind', action: 'withdraw' },
])('[AC-B1-02f#04][BR-ID-04/08] 非法用途参数 %j 不签发', async (body) => {
  const f = await fixture(kit);
  const response = await f.post(ATTEMPTS, body);
  rejected(kit, ATTEMPTS, response, 20001);
  expect(response.json<{ data: { fields: string[] } }>().data.fields.length).toBeGreaterThan(0);
});

it('[AC-B1-02f#05][BR-ID-04] payout_bind 已登录可签，绑定用户和设备，不能挪作 step_up', async () => {
  const f = await fixture(kit, true);
  const data = accepted<Schema<'OauthAttemptData'>>(
    kit,
    ATTEMPTS,
    await f.post(ATTEMPTS, { provider: 'wechat', purpose: 'payout_bind' }),
  );
  const store = service(f);
  expect(await store.consume({ ...binding(f), attempt_id: data.attempt_id })).toEqual({
    code: 20004,
  });
  expect(
    await store.consume({
      app_id: f.appId,
      provider: 'wechat',
      purpose: 'payout_bind',
      uid: f.uid,
      device_id: f.device.deviceId,
      attempt_id: data.attempt_id,
    }),
  ).toEqual({ code: 0, data: { nonce: data.nonce } });
});

it.each(['app_id', 'provider', 'purpose', 'device_id', 'uid', 'action'] as const)(
  '[AC-B1-02f#06][BR-ID-04/08] %s 不符不消费；原持有人仍可消费且仅一次',
  async (field) => {
    const f = await fixture(kit);
    const { store, data } = await issued(f);
    const values = {
      app_id: 'another_app',
      provider: 'apple',
      purpose: 'login',
      device_id: randomUUID(),
      uid: randomUUID(),
      action: 'phone_change',
    };
    const correct = { ...binding(f), attempt_id: data.attempt_id };
    expect(await store.consume({ ...correct, [field]: values[field] })).toEqual({ code: 20004 });
    expect(await store.consume(correct)).toEqual({ code: 0, data: { nonce: data.nonce } });
    expect(await store.consume(correct)).toEqual({ code: 20004 });
  },
);

it('[AC-B1-02f#07][BR-ID-04] login 尝试不能用于 step_up，拒绝后 login 持有人仍能消费', async () => {
  const f = await fixture(kit);
  const { store, data } = await issued(f, 'login');
  expect(await store.consume({ ...binding(f), attempt_id: data.attempt_id })).toEqual({
    code: 20004,
  });
  expect(
    await store.consume({
      app_id: f.appId,
      device_id: f.device.deviceId,
      provider: 'wechat',
      purpose: 'login',
      attempt_id: data.attempt_id,
    }),
  ).toEqual({ code: 0, data: { nonce: data.nonce } });
});

it('[AC-B1-02f#08][BR-ID-04] 两个独立服务实例并发消费只成功一个，不能靠进程内锁', async () => {
  const f = await fixture(kit);
  const { store, data } = await issued(f);
  const redis = await createRedisHandle(redisConnection(kit.suite.server.url), {
    logger: memoryLogger().logger,
  });
  expect(redis).not.toBeNull();
  try {
    const other = createOauthAttemptService({
      db: f.db,
      redis: redis!,
      clock: kit.clock,
      config: { configValue: async () => null },
    });
    const input = { ...binding(f), attempt_id: data.attempt_id };
    const outcomes = await Promise.all([store.consume(input), other.consume(input)]);
    expect(outcomes.map((result) => result.code).sort((a, b) => a - b)).toEqual([0, 20004]);
    expect(outcomes.find((result) => result.code === 0)).toEqual({
      code: 0,
      data: { nonce: data.nonce },
    });
  } finally {
    await redis?.close();
  }
});

it.each([599_999, 600_000])(
  '[AC-B1-02f#09][BR-ID-04] 有效期边界 %i 毫秒，恰好到期拒绝',
  async (elapsed) => {
    const f = await fixture(kit);
    const { store, data } = await issued(f);
    kit.clock.advanceMs(elapsed);
    expect((await store.consume({ ...binding(f), attempt_id: data.attempt_id })).code).toBe(
      elapsed < 600_000 ? 0 : 20004,
    );
  },
);

it('[AC-B1-02f#10][BR-ID-04] 配置 TTL 按 app 读取并影响实际消费有效期', async () => {
  const f = await fixture(kit);
  const { store, data } = await issued(f, 'step_up', 37);
  expect(Date.parse(data.expire_at)).toBe(kit.clock.now().getTime() + 37_000);
  kit.clock.advanceMs(37_000);
  expect(await store.consume({ ...binding(f), attempt_id: data.attempt_id })).toEqual({
    code: 20004,
  });
});

it('[AC-B1-02f#11][BR-ID-04] 未知尝试拒绝且不创建身份或会话', async () => {
  const f = await fixture(kit);
  const store = service(f);
  expect(await store.consume({ ...binding(f), attempt_id: randomUUID() })).toEqual({ code: 20004 });
  expect(
    await f.db.selectFrom('sessions').select('sid').where('app_id', '=', f.appId).execute(),
  ).toEqual([{ sid: f.session.sid }]);
});

it('[AC-B1-02f#12][BR-ID-04] 尝试存储关闭后签发与消费均 50001，不能回退内存', async () => {
  const f = await fixture(kit);
  const { data } = await issued(f);
  const redis = await createRedisHandle(redisConnection(kit.suite.server.url), {
    logger: memoryLogger().logger,
  });
  expect(redis).not.toBeNull();
  await redis!.close();
  const store = createOauthAttemptService({
    db: f.db,
    redis: redis!,
    clock: kit.clock,
    config: { configValue: async () => null },
  });
  expect(
    await store.issue({
      body: { provider: 'wechat', purpose: 'login' },
      verifiedDevice: { appId: f.appId, deviceId: f.device.deviceId },
    }),
  ).toEqual({ code: 50001 });
  expect(await store.consume({ ...binding(f), attempt_id: data.attempt_id })).toEqual({
    code: 50001,
  });
});
