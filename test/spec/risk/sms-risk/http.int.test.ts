import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedBlock, phoneHmac } from '../blocklist/kit.ts';
import { validate as validateLogin } from '../../identity/sms-login/http-kit.ts';
import { alerts, hash, IP, OTHER_IP, phone } from './kit.ts';
import { closeSuite, openSuite, result, withHttp } from './http-kit.ts';

let suite: Awaited<ReturnType<typeof openSuite>>;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});

it('[AC-B1-03g#1] 真签名 AppModule：签名、20001、44001 在频控前且不占设备/IP 名额', async () => {
  await withHttp(suite, { 'sms.ip_sends_per_hour': 3 }, async (f) => {
    const client = await f.client();
    const blocked = phone();
    await seedBlock(suite.kit.db, f.id, 'phone', phoneHmac(f.crypto, blocked), f.clock);
    await result(await client.send('12812345678', IP, {}, { 'x-sign': '0'.repeat(64) }), 10401);
    await result(await client.send('12812345678'), 20001);
    await result(await client.send('17012345678'), 44001);
    await result(await client.send(blocked), 44001);
    expect(f.sender.outbox()).toHaveLength(0);
    for (let i = 0; i < 3; i++) await result(await client.send(phone()), 0);
    expect(f.sender.outbox()).toHaveLength(3);
    // Both caps are now full: earlier errors still win and must not send.
    await result(await client.send('12812345678'), 20001);
    await result(await client.send(blocked), 44001);
    await result(await client.send(phone()), 42901, 3601);
    expect(f.sender.outbox()).toHaveLength(3);
  });
});

it('[AC-B1-03g#2][AC-B1-03g#4][AC-B1-03g#12] device_hash 共享准入；重发刷新，D 重试不发送，B 滑出后准入', async () => {
  await withHttp(suite, {}, async (f) => {
    const h = hash();
    const first = await f.client(h);
    const [a, b, c, d] = [phone(), phone(), phone(), phone()];
    f.clock.set('2031-05-06T10:00:00Z');
    await result(await first.send(a!), 0);
    f.clock.advanceMs(300_000);
    await result(await first.send(b!), 0);
    f.clock.advanceMs(300_000);
    await result(await first.send(c!), 0);
    const second = await f.client(h);
    expect(second.deviceId).not.toBe(first.deviceId);
    f.clock.set('2031-05-06T10:20:00Z');
    for (let i = 0; i < 4; i++) await result(await second.send(d!), 42901, 2401);
    expect(f.sender.outbox()).toHaveLength(3);
    f.clock.set('2031-05-06T10:25:00Z');
    await result(await second.send(`+86${a!}`), 0);
    f.clock.set('2031-05-06T11:05:00Z');
    await result(await first.send(d!), 42901, 1);
    f.clock.advanceMs(1000);
    await result(await second.send(d!), 0);
    expect(f.sender.outbox()).toHaveLength(5);
  });
});

it('[AC-B1-03g#3] 供应商拒绝和后续手机号频控都不退设备名额，集合内重发仍允许', async () => {
  await withHttp(suite, {}, async (f) => {
    const target = await f.client();
    const donor = await f.client();
    const [a, b, c, d] = [phone(), phone(), phone(), phone()];
    f.sender.enqueueResult('rejected');
    await result(await target.send(a!), 50001);
    await result(await target.send(b!), 0);
    await result(await donor.send(c!, OTHER_IP), 0);
    await result(await target.send(c!), 42901, 60);
    await result(await target.send(d!), 42901, 3601);
    expect(f.sender.outbox()).toHaveLength(2);
    f.clock.advanceMs(60_000);
    await result(await target.send(a!), 0);
    await result(await target.send(b!), 0);
    await result(await target.send(c!), 0);
    await result(await target.send(d!), 42901, 3601);
    expect(f.sender.outbox()).toHaveLength(5);
  });
});

it.each([false, true])(
  '[AC-B1-03g#5] 真签名并发 20 轮，混合同哈希两个 device_id=%s，每轮恰 1 成功 4 拒绝',
  async (mixed) => {
    await withHttp(suite, {}, async (f) => {
      for (let round = 0; round < 20; round++) {
        const h = hash();
        const first = await f.client(h);
        const second = mixed ? await f.client(h) : first;
        const ip = `203.0.113.${round + 1}`;
        for (let i = 0; i < 2; i++) await result(await first.send(phone(), ip), 0);
        const before = f.sender.outbox().length;
        const responses = await Promise.all(
          Array.from({ length: 5 }, (_, i) => (i % 2 ? second : first).send(phone(), ip)),
        );
        expect(responses.filter((r) => r.json<{ code: number }>().code === 0)).toHaveLength(1);
        expect(responses.filter((r) => r.json<{ code: number }>().code === 42901)).toHaveLength(4);
        for (const response of responses)
          await result(response, response.statusCode === 200 ? 0 : 42901, 3601);
        expect(f.sender.outbox()).toHaveLength(before + 1);
      }
    });
  },
  180_000,
);

it('[AC-B1-03g#6][AC-B1-03g#8] 20 条后同 IP 等 1741 秒，captcha 无效，IP 拒绝不进设备准入', async () => {
  await withHttp(suite, { 'sms.captcha_mode': 'always' }, async (f) => {
    const clients = await Promise.all(Array.from({ length: 7 }, () => f.client()));
    for (let i = 0; i < 20; i++) {
      f.clock.set(new Date(Date.parse('2031-05-06T09:00:00Z') + i * 90_000));
      await result(await clients[Math.floor(i / 3)]!.send(phone()), 0);
    }
    f.clock.set('2031-05-06T09:31:00Z');
    const blocked = await f.client();
    const rejectedPhone = phone();
    await result(await blocked.send(rejectedPhone), 42901, 1741);
    await result(
      await blocked.send(rejectedPhone, IP, { captcha_token: 'x'.repeat(2048) }),
      42901,
      1741,
    );
    expect(f.sender.outbox()).toHaveLength(20);
    for (let i = 0; i < 3; i++) await result(await blocked.send(phone(), OTHER_IP), 0);
    await result(await blocked.send(rejectedPhone, OTHER_IP), 42901, 3601);
    expect(f.sender.outbox()).toHaveLength(23);
    const clean = await f.client();
    f.clock.set('2031-05-06T10:00:00Z');
    await result(await clean.send(phone()), 42901, 1);
    f.clock.advanceMs(1000);
    await result(await clean.send(phone()), 0);
  });
});

it('[AC-B1-03g#6][AC-B1-03g#10] 明确拒绝不计，未知算受理；IP 和预算均由真实 afterAccepted 接入', async () => {
  await withHttp(suite, { 'sms.ip_sends_per_hour': 2, 'sms.daily_budget_count': 2 }, async (f) => {
    const client = await f.client();
    f.sender.enqueueResult('rejected');
    await result(await client.send(phone()), 50001);
    expect(alerts(f.lines, f.id)).toHaveLength(0);
    f.sender.enqueueResult('unknown');
    await result(await client.send(phone()), 0);
    await result(await client.send(phone()), 0);
    const fresh = await f.client();
    await result(await fresh.send(phone()), 42901, 3601);
    expect(f.sender.outbox()).toHaveLength(2);
    expect(alerts(f.lines, f.id).map((line) => line['count'])).toEqual([2, 2]);
  });
});

it('[AC-B1-03g#7] 五个真实短信注册触发 601 秒；已有号登录不计新注册；10:00:01 恢复', async () => {
  await withHttp(suite, {}, async (f) => {
    for (let i = 0; i < 5; i++) {
      f.clock.set(new Date(Date.parse('2031-05-06T09:00:00Z') + i * 600_000));
      const client = await f.client();
      const number = phone();
      // SMS source IP is separate: this test isolates the new-account counter.
      await result(await client.send(number, OTHER_IP), 0);
      const code = f.sender.outbox().findLast((m) => m.phone === number)!.code;
      const login = await client.post(
        '/v1/auth/login/sms',
        {
          phone: number,
          code,
          legal_versions: { privacy: 1, agreement: 1 },
          consent_at: f.clock.now().toISOString(),
        },
        IP,
      );
      expect(login.json()).toMatchObject({ code: 0, data: { is_new_user: true } });
      await validateLogin(login, true);
      if (i === 0) {
        f.clock.advanceMs(60_000);
        await result(await client.send(number, OTHER_IP), 0);
        const again = await client.post(
          '/v1/auth/login/sms',
          {
            phone: number,
            code: f.sender.outbox().findLast((m) => m.phone === number)!.code,
            legal_versions: { privacy: 1, agreement: 1 },
            consent_at: f.clock.now().toISOString(),
          },
          IP,
        );
        expect(again.json()).toMatchObject({ code: 0, data: { is_new_user: false } });
      }
    }
    f.clock.set('2031-05-06T09:50:00Z');
    const target = await f.client();
    const before = f.sender.outbox().length;
    await result(await target.send(phone()), 42901, 601);
    expect(f.sender.outbox()).toHaveLength(before);
    f.clock.set('2031-05-06T10:00:00Z');
    await result(await target.send(phone()), 42901, 1);
    f.clock.advanceMs(1000);
    await result(await target.send(phone()), 0);
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM app.users WHERE app_id = ${f.id}`.execute(suite.kit.db);
    expect(rows[0]?.n).toBe(5);
  });
});

it('[AC-B1-03g#10] 真 AppModule 预算告警到 8、10 各一次，第 11 条不停发，+08 次日重置', async () => {
  await withHttp(suite, { 'sms.daily_budget_count': 10 }, async (f) => {
    const clients = await Promise.all(Array.from({ length: 4 }, () => f.client()));
    f.clock.set('2031-05-06T15:59:00Z');
    for (let i = 1; i <= 11; i++) {
      await result(await clients[Math.floor((i - 1) / 3)]!.send(phone()), 0);
      expect(alerts(f.lines, f.id)).toHaveLength(i < 8 ? 0 : i < 10 ? 1 : 2);
    }
    expect(f.sender.outbox()).toHaveLength(11);
    f.clock.set('2031-05-06T16:00:00Z');
    const next = await Promise.all(Array.from({ length: 3 }, () => f.client()));
    for (let i = 0; i < 8; i++)
      await result(await next[Math.floor(i / 3)]!.send(phone(), OTHER_IP), 0);
    expect(alerts(f.lines, f.id).map((line) => [line['day'], line['count']])).toEqual([
      ['2031-05-06', 8],
      ['2031-05-06', 10],
      ['2031-05-07', 8],
    ]);
  });
});
