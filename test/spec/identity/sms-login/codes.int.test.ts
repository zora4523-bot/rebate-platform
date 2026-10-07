import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SmsPurpose } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import { acquireRedis, fixture as smsFixture, wrong, type TestRedis } from '../sms-codes/kit.ts';
import { seedUser } from '../registration/kit.ts';
import { openKit, closeKit, fixture, rows, success, type Kit, type Fixture } from './kit.ts';

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

async function withCodes(
  run: (
    f: Fixture,
    codes: {
      send(purpose?: SmsPurpose): Promise<string>;
      login(code: string, phone?: string): ReturnType<Fixture['login']>;
      verify(code: string, purpose: SmsPurpose): Promise<{ readonly code: 0 | 20002 | 20003 }>;
    },
  ) => Promise<void>,
) {
  expect(redis).toBeDefined();
  const f = await fixture(kit);
  const sms = await smsFixture(redis!, { clock: f.clock });
  try {
    const number = f.command.body.phone;
    await run(f, {
      send: async (purpose = 'login') => {
        expect((await sms.service.send({ app_id: f.appId, phone: number, purpose })).code).toBe(0);
        return sms.lastCode();
      },
      login: (code, phone = number) =>
        f.login({ body: { ...f.command.body, code, phone } }, { sms: sms.service }),
      verify: (code, purpose) =>
        sms.service.verifyAndConsume({ app_id: f.appId, phone: number, code, purpose }),
    });
  } finally {
    await sms.close();
  }
}

it('[AC-S1-83#16][BR-ID-01/05] 受限新号拒绝也立即核销验证码，第二次是 20003', async () => {
  await withCodes(async (f, c) => {
    f.minimum.mockResolvedValue('3.0.0');
    const code = await c.send();
    const before = await rows(kit, f.appId);
    expect(await c.login(code)).toEqual({
      code: 10405,
      data: { reason: 'no_account', min_supported_version: '3.0.0' },
    });
    expect(await c.login(code)).toEqual({ code: 20003 });
    expect(await rows(kit, f.appId)).toEqual(before);
  });
});

it('[AC-B1-02j#23][BR-ID-05] 正确码只登录一次，重放不增加同意、日志与会话', async () => {
  await withCodes(async (f, c) => {
    const code = await c.send();
    expect(success(await c.login(code)).is_new_user).toBe(true);
    const committed = await rows(kit, f.appId);
    expect(await c.login(code)).toEqual({ code: 20003 });
    expect(await rows(kit, f.appId)).toEqual(committed);
  });
});

it('[AC-B1-02j#24][BR-ID-05] 累计五次错误后正确码也作废，全程不写登录数据', async () => {
  await withCodes(async (f, c) => {
    const code = await c.send();
    const before = await rows(kit, f.appId);
    for (let attempt = 0; attempt < 5; attempt++)
      expect(await c.login(wrong(code))).toEqual({ code: 20002 });
    expect(await c.login(code)).toEqual({ code: 20003 });
    expect(await rows(kit, f.appId)).toEqual(before);
  });
});

it.each([299_000, 300_000])(
  '[AC-B1-02j#25][BR-ID-05] 验证码有效期边界 %s 毫秒',
  async (elapsed) => {
    await withCodes(async (f, c) => {
      const code = await c.send();
      f.clock.advanceMs(elapsed);
      const result = await c.login(code);
      if (elapsed === 299_000) expect(success(result).is_new_user).toBe(true);
      else {
        expect(result).toEqual({ code: 20003 });
        expect((await rows(kit, f.appId)).users).toHaveLength(0);
      }
    });
  },
);

it('[AC-B1-02j#26][BR-ID-05] login C 作废 login A，但 bind B 保持可核销', async () => {
  await withCodes(async (f, c) => {
    const a = await c.send();
    f.clock.advanceMs(60_000);
    const b = await c.send('bind');
    f.clock.advanceMs(60_000);
    const latest = await c.send();
    expect(await c.login(a)).toEqual({ code: 20003 });
    expect(success(await c.login(latest)).is_new_user).toBe(true);
    expect(await c.verify(b, 'bind')).toEqual({ code: 0 });
  });
});

it('[AC-B1-02j#27][BR-ID-05] 发 bind 码不影响原 login 码，登录只核销 login purpose', async () => {
  await withCodes(async (f, c) => {
    const login = await c.send();
    f.clock.advanceMs(60_000);
    const bind = await c.send('bind');
    expect(success(await c.login(login)).is_new_user).toBe(true);
    expect(await c.verify(bind, 'bind')).toEqual({ code: 0 });
  });
});

it('[AC-S1-78#1][AC-S1-78#2][BR-ID-05] 四种手机号写法只对应一行 users，后续登录 is_new_user=false', async () => {
  await withCodes(async (f, c) => {
    let uid: string | undefined;
    for (const phone of [
      '13800138000',
      '+86 138 0013 8000',
      '0086-13800138000',
      '８６１３８００１３８０００',
    ]) {
      const code = await c.send();
      const data = success(await c.login(code, phone));
      expect(data.is_new_user).toBe(uid === undefined);
      if (uid !== undefined) expect(data.user_id).toBe(uid);
      uid = data.user_id;
      f.clock.advanceMs(60_000);
    }
    const state = await rows(kit, f.appId);
    expect(state.users).toHaveLength(1);
    expect(state.registrations).toHaveLength(1);
    expect(state.logs).toHaveLength(4);
  });
});

it('[AC-B1-02j#28][BR-ID-05] 44001 同设备上限拒绝后验证码仍已核销', async () => {
  await withCodes(async (f, c) => {
    for (let i = 0; i < 3; i++) await seedUser(kit.db, f.appId, { hash: f.hash });
    f.clock.advanceMs(60_000);
    const code = await c.send();
    const before = await rows(kit, f.appId);
    expect(await c.login(code)).toMatchObject({ code: 44001 });
    expect(await c.login(code)).toEqual({ code: 20003 });
    expect(await rows(kit, f.appId)).toEqual(before);
  });
});
