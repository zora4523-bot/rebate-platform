import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { acquire, alerts, IP, OTHER_IP, phone, withRisk, type Server } from './kit.ts';

let server: Server;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[AC-B1-03g#6][AC-B1-03g#8] 同 IP 成功 20 条后等 1741 秒；captcha 配置无效且不读取', async () => {
  await withRisk(server, async (f) => {
    f.config('sms.captcha_mode', 'always');
    const risk = f.service();
    for (let i = 0; i < 20; i++) {
      f.clock.set(new Date(Date.parse('2031-05-06T09:00:00Z') + i * 90_000));
      await risk.recordAccepted({ appId: f.app, clientIp: IP });
    }
    f.clock.set('2031-05-06T09:31:00Z');
    const request = f.request();
    expect(await risk.admit(request)).toEqual({ code: 42901, retryAfterSec: 1741 });
    // An IP refusal must not reserve the request's phone on its device.
    for (let i = 0; i < 3; i++) {
      expect(await risk.admit({ ...request, clientIp: OTHER_IP, phone: phone() })).toEqual({
        code: 0,
      });
    }
    expect(await risk.admit({ ...request, clientIp: OTHER_IP })).toEqual({
      code: 42901,
      retryAfterSec: 3601,
    });
    expect(f.reads).not.toContain('sms.captcha_mode');
    expect(await risk.admit({ ...request, appId: `${f.app}_b` })).toEqual({ code: 0 });
  });
});

it('[AC-B1-03g#6][AC-B1-03g#12] 阈值从 20 调成 10，15 条记录等待第六条；边界不提前放行', async () => {
  await withRisk(server, async (f) => {
    const risk = f.service();
    for (let i = 0; i < 15; i++) {
      f.clock.set(new Date(Date.parse('2031-05-06T09:00:00Z') + i * 60_000));
      await risk.recordAccepted({ appId: f.app, clientIp: IP });
    }
    f.config('sms.ip_sends_per_hour', 10);
    f.clock.set('2031-05-06T09:30:00Z');
    const request = f.request();
    expect(await risk.admit(request)).toEqual({ code: 42901, retryAfterSec: 2101 });
    f.clock.set('2031-05-06T10:05:00Z');
    expect(await risk.admit(request)).toEqual({ code: 42901, retryAfterSec: 1 });
    f.clock.advanceMs(1000);
    expect(await risk.admit(request)).toEqual({ code: 0 });
  });
});

it.each([0, -1, 2.5, '1', null])('[AC-B1-03g#6] IP 阈值坏值回默认 20：%j', async (value) => {
  await withRisk(server, async (f) => {
    f.config('sms.ip_sends_per_hour', value);
    const risk = f.service();
    for (let i = 0; i < 19; i++) await risk.recordAccepted({ appId: f.app, clientIp: IP });
    expect(await risk.admit(f.request())).toEqual({ code: 0 });
    await risk.recordAccepted({ appId: f.app, clientIp: IP });
    expect(await risk.admit(f.request())).toEqual({ code: 42901, retryAfterSec: 3601 });
  });
});

it.each([5, 6])(
  '[AC-B1-03g#7][AC-B1-03g#12] 新注册 %i 个按第 N−5+1 条解除，601/1201 秒',
  async (count) => {
    await withRisk(server, async (f) => {
      const risk = f.service();
      for (let i = 0; i < count; i++) {
        f.clock.set(new Date(Date.parse('2031-05-06T09:00:00Z') + Math.min(i * 10, 45) * 60_000));
        await f.registered(risk);
      }
      f.clock.set('2031-05-06T09:50:00Z');
      const request = f.request();
      expect(await risk.admit(request)).toEqual({
        code: 42901,
        retryAfterSec: count === 5 ? 601 : 1201,
      });
      // Failed IP admission does not fill the device; the other IP gets all three slots.
      for (let i = 0; i < 3; i++)
        expect(await risk.admit({ ...request, clientIp: OTHER_IP, phone: phone() })).toEqual({
          code: 0,
        });
      const boundary = count === 5 ? '2031-05-06T10:00:00Z' : '2031-05-06T10:10:00Z';
      f.clock.set(boundary);
      expect(await risk.admit(f.request())).toEqual({ code: 42901, retryAfterSec: 1 });
      f.clock.advanceMs(1000);
      expect(await risk.admit(f.request())).toEqual({ code: 0 });
    });
  },
);

it.each(['registrations', 'sends'])(
  '[AC-B1-03g#7] 两项同时成立取较晚解除，较晚项为 %s',
  async (later) => {
    await withRisk(server, async (f) => {
      f.config('sms.ip_sends_per_hour', 1);
      const risk = f.service();
      const record = async (kind: string) => {
        if (kind === 'sends') await risk.recordAccepted({ appId: f.app, clientIp: IP });
        else for (let i = 0; i < 5; i++) await f.registered(risk);
      };
      await record(later === 'sends' ? 'registrations' : 'sends');
      f.clock.advanceMs(600_000);
      await record(later);
      f.clock.advanceMs(2_400_000);
      expect(await risk.admit(f.request())).toEqual({ code: 42901, retryAfterSec: 1201 });
    });
  },
);

it('[AC-B1-03g#10] 预算 10：第 8/10 条各一次，11 条不停发；+08 日界重置且按 app_id 隔离', async () => {
  await withRisk(server, async (f) => {
    f.config('sms.daily_budget_count', 10);
    const warn = vi.spyOn(f.options.logger, 'warn');
    const risk = f.service();
    f.clock.set('2031-05-06T15:59:00Z');
    for (let i = 1; i <= 11; i++) {
      expect(await risk.admit(f.request())).toEqual({ code: 0 });
      await risk.recordAccepted({ appId: f.app, clientIp: IP });
      expect(alerts(f.lines, f.app)).toHaveLength(i < 8 ? 0 : i < 10 ? 1 : 2);
    }
    const firstDay = alerts(f.lines, f.app);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(firstDay.map((line) => line['count'])).toEqual([8, 10]);
    expect(firstDay.map((line) => line['budget_level'])).toEqual(['ratio', 'full']);
    expect(firstDay.every((line) => line['level'] === 40)).toBe(true);
    for (const line of firstDay) {
      expect(line).toMatchObject({ app_id: f.app, day: '2031-05-06', budget: 10 });
      expect(Object.values(line).every((v) => v === null || typeof v !== 'object')).toBe(true);
    }
    f.config('sms.daily_budget_count', 10, `${f.app}_b`);
    await risk.recordAccepted({ appId: `${f.app}_b`, clientIp: IP });
    expect(alerts(f.lines, `${f.app}_b`)).toHaveLength(0);
    f.clock.set('2031-05-06T16:00:00Z');
    for (let i = 1; i <= 10; i++) {
      await risk.recordAccepted({ appId: f.app, clientIp: OTHER_IP });
      expect(alerts(f.lines, f.app)).toHaveLength(2 + (i < 8 ? 0 : i < 10 ? 1 : 2));
    }
    expect(
      alerts(f.lines, f.app)
        .slice(2)
        .map((line) => line['day']),
    ).toEqual(['2031-05-07', '2031-05-07']);
    expect((await f.keys()).length).toBeGreaterThan(0);
    for (const key of await f.keys())
      expect(Number(await f.raw.call('TTL', key))).toBeGreaterThan(0);
  });
});

it.each([undefined, 0, -1, 2.5, '10'])(
  '[AC-B1-03g#10] 预算缺失/坏值 %j 回到 5000，合法 1bp 比例仍生效',
  async (value) => {
    await withRisk(server, async (f) => {
      if (value !== undefined) f.config('sms.daily_budget_count', value);
      f.config('sms.daily_budget_alert_ratio_bp', 1);
      const risk = f.service();
      await risk.recordAccepted({ appId: f.app, clientIp: IP });
      expect(alerts(f.lines, f.app)).toEqual([expect.objectContaining({ budget: 5000, count: 1 })]);
    });
  },
);

it.each([3333, 10000, 0, 10001, 1.5, '8000'])(
  '[AC-B1-03g#10] 预算比例用整数交叉乘；配置 %j',
  async (bp) => {
    await withRisk(server, async (f) => {
      f.config('sms.daily_budget_count', 3);
      f.config('sms.daily_budget_alert_ratio_bp', bp);
      const risk = f.service();
      const threshold = bp === 3333 ? 1 : 3;
      for (let i = 1; i <= 4; i++) {
        await risk.recordAccepted({ appId: f.app, clientIp: IP });
        expect(alerts(f.lines, f.app)).toHaveLength((i >= threshold ? 1 : 0) + (i >= 3 ? 1 : 0));
      }
      expect(alerts(f.lines, f.app).map((line) => line['count'])).toEqual([threshold, 3]);
    });
  },
);

it('[AC-B1-03g#10] 两个进程并发跨预算门槛也仅两档各告警一次', async () => {
  await withRisk(server, async (f) => {
    f.config('sms.daily_budget_count', 10);
    const services = [f.service(), f.service({ redis: f.handles[1]! })];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        services[i % 2]!.recordAccepted({ appId: f.app, clientIp: IP }),
      ),
    );
    expect(alerts(f.lines, f.app)).toHaveLength(2);
    expect(
      alerts(f.lines, f.app)
        .map((line) => line['count'])
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([8, 10]);
  });
});
