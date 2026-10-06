import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createSmsCodeService,
  type SmsMessage,
  type SmsPurpose,
} from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import {
  acquireRedis,
  fullWidthPhone,
  limited,
  phone,
  success,
  withFixture,
  wrong,
  type TestRedis,
} from './kit.ts';

let server: TestRedis | undefined;
beforeAll(async () => {
  server = await acquireRedis();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[AC-S1-78 ②][BR-ID-05] 三种 purpose 共用规范化手机号的 60 秒额度，59 秒等待 1 秒，60 秒可发', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    expect(await f.send()).toEqual({
      code: 0,
      data: { resend_after_sec: 60, expires_in_sec: 300 },
    });
    expect(f.sender.outbox()[0]?.phone).toBe(f.number);
    f.clock.advanceMs(59_000);
    limited(await f.send('bind', `+86 ${f.number}`), 1);
    limited(await f.send('step_up', fullWidthPhone(f.number)), 1);
    f.clock.advanceMs(1000);
    success(await f.send('step_up', `86${f.number}`));
    expect(f.sender.outbox()).toHaveLength(2);
  });
});

it('[BR-ID-05] 10:05/10/20/30/40 五条后 10:50 等待 600 秒，11 点恢复', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    for (const minute of ['05', '10', '20', '30', '40']) {
      f.clock.set(`2026-10-06T10:${minute}:00+08:00`);
      success(await f.send());
    }
    f.clock.set('2026-10-06T10:50:00+08:00');
    limited(await f.send(), 600);
    f.clock.set('2026-10-06T11:00:00+08:00');
    success(await f.send());
    expect(f.sender.outbox()).toHaveLength(6);
  });
});

it('[BR-ID-05] 10:59:50 第五条，10:59:55 同时限流取较晚解除点，Retry-After=55', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    for (const time of ['10:05:00', '10:10:00', '10:20:00', '10:30:00', '10:59:50']) {
      f.clock.set(`2026-10-06T${time}+08:00`);
      success(await f.send());
    }
    f.clock.set('2026-10-06T10:59:55+08:00');
    limited(await f.send(), 55);
    f.clock.set('2026-10-06T11:00:00+08:00');
    limited(await f.send(), 50);
    f.clock.set('2026-10-06T11:00:50+08:00');
    success(await f.send());
  });
});

it('[BR-ID-05] 自然日第 11 条受限；自然日与滑动 24 小时保护在次日零点同时解除', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    // First send at midnight: natural-day and rolling-day release coincide at next midnight.
    for (const hour of ['00', '01'])
      for (const minute of ['00', '10', '20', '30', '40']) {
        f.clock.set(`2026-10-06T${hour}:${minute}:00+08:00`);
        success(await f.send());
      }
    f.clock.set('2026-10-06T12:00:00+08:00');
    limited(await f.send(), 43_200);
    f.clock.set('2026-10-07T00:00:00+08:00');
    success(await f.send());
    expect(f.sender.outbox()).toHaveLength(11);
  });
});

it('[BR-ID-05] 22:10–23:50 十条后次日 00:10 仍限流，到次日 22:10 才释放一条', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    for (const hour of ['22', '23'])
      for (const minute of ['10', '20', '30', '40', '50']) {
        f.clock.set(`2026-10-06T${hour}:${minute}:00+08:00`);
        success(await f.send());
      }
    f.clock.set('2026-10-06T23:59:59+08:00');
    limited(await f.send(), 79_801);
    f.clock.set('2026-10-07T00:10:00+08:00');
    limited(await f.send(), 79_200);
    f.clock.set('2026-10-07T22:09:59+08:00');
    limited(await f.send(), 1);
    f.clock.advanceMs(1000);
    success(await f.send());
    f.clock.advanceMs(60_000);
    limited(await f.send(), 540);
  });
});

it('[BR-ID-05] 验证码六位数字，299 秒仍可核销，满 300 秒过期；从未发过返回 20003', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    expect(await f.verify('123456')).toEqual({ code: 20003 });
    success(await f.send());
    const first = f.lastCode();
    f.clock.advanceMs(299_000);
    expect(await f.verify(first)).toEqual({ code: 0 });
    expect(await f.verify(first)).toEqual({ code: 20003 });
    success(await f.send());
    const second = f.lastCode();
    f.clock.advanceMs(300_000);
    expect(await f.verify(second)).toEqual({ code: 20003 });
    expect(await f.verify(wrong(second))).toEqual({ code: 20003 });
  });
});

it('[BR-ID-05] login A、bind B 互不影响；login C 作废 A；规范化别名可以核销', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    success(await f.send());
    const a = f.lastCode();
    f.clock.advanceMs(60_000);
    success(await f.send('bind'));
    const b = f.lastCode();
    f.clock.advanceMs(60_000);
    success(await f.send());
    const c = f.lastCode();
    expect(await f.verify(a)).toEqual({ code: 20003 });
    expect(await f.verify(b, 'bind')).toEqual({ code: 0 });
    expect(await f.verify(c, 'login', `+86 ${f.number}`)).toEqual({ code: 0 });
  });
});

it('[BR-ID-05] 发 bind 码后 login 原码仍有效；不同手机号可在同一秒独立发码和核销', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    success(await f.send());
    const a = f.lastCode();
    const other = phone();
    success(await f.send('login', other));
    const otherCode = f.lastCode();
    f.clock.advanceMs(60_000);
    success(await f.send('bind'));
    const b = f.lastCode();
    expect(await f.verify(a)).toEqual({ code: 0 });
    expect(await f.verify(b, 'bind')).toEqual({ code: 0 });
    expect(await f.verify(otherCode, 'login', other)).toEqual({ code: 0 });
  });
});

it('[BR-ID-05] 首次发送明确拒绝的码不能核销，立刻重试可成功；结果未知累计小时和日额度', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    let rejected: SmsMessage | undefined;
    const service = createSmsCodeService({
      ...f.options,
      sender: {
        send: async (message) => {
          rejected = message;
          return 'rejected';
        },
      },
    });
    expect((await service.send({ app_id: 'couli', phone: f.number, purpose: 'login' })).code).toBe(
      50001,
    );
    expect(rejected).toBeDefined();
    expect(await f.verify(rejected!.code)).toEqual({ code: 20003 });
    for (const hour of ['10', '11'])
      for (const minute of ['00', '10', '20', '30', '40']) {
        f.clock.set(`2026-10-06T${hour}:${minute}:00+08:00`);
        f.sender.enqueueResult('unknown');
        success(await f.send());
        if (hour === '10' && minute === '40') {
          f.clock.set('2026-10-06T10:50:00+08:00');
          limited(await f.send(), 600);
        }
      }
    f.clock.set('2026-10-06T12:00:00+08:00');
    limited(await f.send(), 79_200);
    expect(f.sender.outbox()).toHaveLength(10);
  });
});

it.each(['login', 'bind', 'step_up'] as const)(
  '[BR-ID-05] %s 错误四次仍可核销；错满五次后正确码也返回 20003',
  async (purpose) => {
    expect(server).toBeDefined();
    await withFixture(server!, async (f) => {
      success(await f.send(purpose));
      const first = f.lastCode();
      for (let n = 0; n < 4; n++)
        expect(await f.verify(wrong(first), purpose)).toEqual({ code: 20002 });
      expect(await f.verify(first, purpose)).toEqual({ code: 0 });
      f.clock.advanceMs(60_000);
      success(await f.send(purpose));
      const second = f.lastCode();
      for (let n = 0; n < 4; n++)
        expect(await f.verify(wrong(second), purpose)).toEqual({ code: 20002 });
      expect(await f.verify(wrong(second), purpose)).toEqual({ code: 20002 });
      expect(await f.verify(second, purpose)).toEqual({ code: 20003 });
      expect(await f.verify(wrong(second), purpose)).toEqual({ code: 20003 });
    });
  },
);

it('[BR-ID-05] App 与 purpose 隔离验证码，手机号额度跨 App 共用；独立服务实例共享核销状态', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    success(await f.send());
    const a = f.lastCode();
    expect(await f.verify(a, 'login', f.number, 'other-app')).toEqual({ code: 20003 });
    expect(await f.verify(a, 'step_up')).toEqual({ code: 20003 });
    expect(await f.verify(a, 'login', phone())).toEqual({ code: 20003 });
    limited(await f.send('bind', f.number, 'other-app'), 60);
    const another = createSmsCodeService(f.options);
    expect(
      await another.verifyAndConsume({
        app_id: 'couli',
        phone: f.number,
        purpose: 'login',
        code: a,
      }),
    ).toEqual({ code: 0 });
    expect(await f.verify(a)).toEqual({ code: 20003 });
    f.clock.advanceMs(60_000);
    success(await f.send('login', f.number, 'other-app'));
    expect(await f.verify(f.lastCode())).toEqual({ code: 20003 });
    expect(await f.verify(f.lastCode(), 'login', f.number, 'other-app')).toEqual({ code: 0 });
  });
});

it('[BR-ID-05] 同码并发校验并核销只有一个成功，错误计数也不能被并发丢失', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    success(await f.send());
    const code = f.lastCode();
    const results = await Promise.all(Array.from({ length: 12 }, () => f.verify(code)));
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.code === 20003)).toHaveLength(11);
    f.clock.advanceMs(60_000);
    success(await f.send());
    const next = f.lastCode();
    const failures = await Promise.all(Array.from({ length: 5 }, () => f.verify(wrong(next))));
    expect(failures).toEqual(Array.from({ length: 5 }, () => ({ code: 20002 })));
    expect(await f.verify(next)).toEqual({ code: 20003 });
  });
});

it('[BR-ID-05] 两个 App 可各有同号同用途的有效码，发新码与错误计数不得跨 App 或用途污染', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    success(await f.send());
    const a = f.lastCode();
    for (let i = 0; i < 4; i++) expect(await f.verify(wrong(a))).toEqual({ code: 20002 });
    f.clock.advanceMs(60_000);
    success(await f.send('login', f.number, 'other-app'));
    const b = f.lastCode();
    expect(await f.verify(wrong(b), 'login', f.number, 'other-app')).toEqual({ code: 20002 });
    f.clock.advanceMs(60_000);
    success(await f.send('bind'));
    const bind = f.lastCode();
    expect(await f.verify(wrong(bind), 'bind')).toEqual({ code: 20002 });
    expect(await f.verify(a)).toEqual({ code: 0 });
    expect(await f.verify(b, 'login', f.number, 'other-app')).toEqual({ code: 0 });
    expect(await f.verify(bind, 'bind')).toEqual({ code: 0 });
  });
});

it('[BR-ID-05] 60 秒从供应商受理时刻起算，不能从慢请求开始时提前放行', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    const service = createSmsCodeService({
      ...f.options,
      sender: {
        send: async (message) => {
          f.clock.advanceMs(30_000);
          return f.sender.send(message);
        },
      },
    });
    success(await service.send({ app_id: 'couli', phone: f.number, purpose: 'login' }));
    f.clock.advanceMs(59_000);
    limited(await f.send(), 1);
    f.clock.advanceMs(1000);
    success(await f.send());
  });
});

it('[BR-ID-05] 明确拒绝释放所有额度且不替换旧码，重试无需等待；未知结果计费并作废旧码', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    success(await f.send());
    const old = f.lastCode();
    f.clock.advanceMs(60_000);
    let rejected: SmsMessage | undefined;
    const rejecting = createSmsCodeService({
      ...f.options,
      sender: {
        send: async (message) => {
          rejected = message;
          return 'rejected';
        },
      },
    });
    for (let i = 0; i < 11; i++)
      expect(await rejecting.send({ app_id: 'couli', phone: f.number, purpose: 'login' })).toEqual({
        code: 50001,
      });
    expect(rejected).toBeDefined();
    expect((await f.verify(rejected!.code)).code).not.toBe(0);
    expect(await f.verify(old)).toEqual({ code: 0 });
    success(await f.send());
    const replaced = f.lastCode();
    f.clock.advanceMs(60_000);
    f.sender.enqueueResult('unknown');
    success(await f.send());
    expect(await f.verify(replaced)).toEqual({ code: 20003 });
    expect(await f.verify(f.lastCode())).toEqual({ code: 0 });
    limited(await f.send('bind'), 60);
    expect(f.sender.outbox()).toHaveLength(3);
  });
});

it('[BR-ID-05] 同号跨服务并发十二次含不同 purpose/App，供应商只收到一条，预占中均限流', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const sender = {
      send: async (message: SmsMessage) => {
        entered.resolve();
        await gate.promise;
        return f.sender.send(message);
      },
    };
    const one = createSmsCodeService({ ...f.options, sender });
    const two = createSmsCodeService({ ...f.options, sender });
    const first = one.send({ app_id: 'couli', phone: f.number, purpose: 'login' });
    try {
      await Promise.race([
        entered.promise,
        first.then(() => {
          expect.fail('first send returned before reaching sender');
        }),
      ]);
      const purposes: SmsPurpose[] = ['login', 'bind', 'step_up'];
      const rest = await Promise.all(
        Array.from({ length: 11 }, (_, i) =>
          two.send({
            app_id: i % 2 ? 'other-app' : 'couli',
            phone: `+86 ${f.number}`,
            purpose: purposes[i % 3]!,
          }),
        ),
      );
      for (const result of rest) limited(result);
    } finally {
      gate.resolve();
    }
    success(await first);
    expect(f.sender.outbox()).toHaveLength(1);
  });
});

it('[AC-S1-78 ③][BR-ID-05] 非法号码先于号段和后续检查，不发短信、不占有效号码额度', async () => {
  expect(server).toBeDefined();
  const hook = vi.fn(async () => null);
  await withFixture(
    server!,
    async (f) => {
      for (const input of [
        '',
        '+852 5123 4567',
        '12345678901',
        f.number.slice(0, 10),
        `170${f.number}`,
      ]) {
        expect(await f.send('login', input)).toEqual({
          code: 20001,
          data: { fields: ['phone'], reason: 'phone_invalid' },
        });
      }
      expect(hook).not.toHaveBeenCalled();
      expect(f.sender.outbox()).toEqual([]);
      success(await f.send());
    },
    { hooks: { phoneBlocklist: hook } },
  );
});

it.each(['170', '171', '162', '165', '167'])(
  '[BR-ID-05] 默认号段 %s 按规范化值拦截，结构化结果不含自由文本且早于后续检查',
  async (prefix) => {
    expect(server).toBeDefined();
    const hook = vi.fn(async () => null);
    await withFixture(
      server!,
      async (f) => {
        const result = await f.send('login', `+86 ${phone(prefix)}`);
        expect(result).toMatchObject({ code: 44001, kind: 'blocked_prefix' });
        if (result.code === 44001 && result.data !== undefined) {
          expect(Object.keys(result.data)).toEqual(['risk_msg_code']);
          expect(result.data.risk_msg_code).toMatch(/^[A-Za-z0-9_.-]+$/);
        }
        expect(hook).not.toHaveBeenCalled();
        expect(f.sender.outbox()).toEqual([]);
      },
      { hooks: { phoneBlocklist: hook } },
    );
  },
);

it('[BR-ID-05] 按 App 读取 sms.blocked_prefixes 的 E.164 前缀；空配置可解除默认号段', async () => {
  expect(server).toBeDefined();
  const configValue = vi.fn(async (appId: string) => ({
    value: appId === 'couli' ? ['+86139'] : [],
    version: 1,
  }));
  await withFixture(
    server!,
    async (f) => {
      expect(await f.send()).toMatchObject({ code: 44001, kind: 'blocked_prefix' });
      success(await f.send('login', phone('170'), 'other-app'));
      expect(configValue.mock.calls.map((call) => call[0])).toContain('other-app');
      expect(configValue).toHaveBeenCalledWith('couli', 'sms.blocked_prefixes');
    },
    { config: { configValue } },
  );
});

it('[BR-ID-05] 插入点有序短路，手机号频控最后判定；只有受理及未知结果触发发送后计数', async () => {
  expect(server).toBeDefined();
  const order: string[] = [];
  let blockCaptcha = false;
  const accepted = vi.fn(async () => undefined);
  await withFixture(
    server!,
    async (f) => {
      success(await f.send());
      expect(order).toEqual(['blocklist', 'captcha', 'device']);
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(accepted).toHaveBeenCalledWith(
        expect.objectContaining({ app_id: 'couli', phone: f.number, purpose: 'login' }),
      );
      order.length = 0;
      blockCaptcha = true;
      expect(await f.send()).toEqual({ code: 44003 });
      expect(order).toEqual(['blocklist', 'captcha']);
      blockCaptcha = false;
      order.length = 0;
      limited(await f.send(), 60);
      expect(order).toEqual(['blocklist', 'captcha', 'device']);
      f.clock.advanceMs(60_000);
      f.sender.enqueueResult('rejected');
      expect((await f.send()).code).toBe(50001);
      expect(accepted).toHaveBeenCalledTimes(1);
      f.sender.enqueueResult('unknown');
      success(await f.send());
      expect(accepted).toHaveBeenCalledTimes(2);
    },
    {
      hooks: {
        phoneBlocklist: async (request) => {
          expect(request).toEqual(
            expect.objectContaining({
              app_id: 'couli',
              phone: expect.stringMatching(/^1[3-9]\d{9}$/),
              purpose: 'login',
            }),
          );
          order.push('blocklist');
          return null;
        },
        captcha: async () => {
          order.push('captcha');
          return blockCaptcha ? { code: 44003 } : null;
        },
        deviceQuota: async () => {
          order.push('device');
          return null;
        },
        afterAccepted: accepted,
      },
    },
  );
});

it('[BR-ID-05] 发码、失败核销、成功核销、限流的日志均不泄漏验证码、captcha_token 或手机号写法', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    const input = `+86 ${f.number}`;
    const captcha = `captcha-${randomUUID()}`;
    success(
      await f.service.send({
        app_id: 'couli',
        phone: input,
        purpose: 'login',
        captcha_token: captcha,
      }),
    );
    const code = f.lastCode();
    expect(await f.verify(wrong(code))).toEqual({ code: 20002 });
    expect(await f.verify(code)).toEqual({ code: 0 });
    limited(await f.send());
    const logs = f.lines.join('');
    expect(logs).not.toContain(input);
    expect(logs).not.toContain(f.number);
    expect(logs).not.toContain(captcha);
    expect(logs).not.toMatch(new RegExp(`(?<!\\d)${code}(?!\\d)`));
  });
});
