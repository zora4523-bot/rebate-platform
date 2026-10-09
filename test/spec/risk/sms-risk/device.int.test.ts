import { afterAll, beforeAll, expect, it } from 'vitest';
import { acquire, hash, phone, withRisk, type Server } from './kit.ts';

let server: Server;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[AC-B1-03g#2][AC-B1-03g#3] A 刷新后最早变 B；被拒 D 的重复请求不加入也不刷新准入集合', async () => {
  await withRisk(server, async (f) => {
    const risk = f.service();
    const request = f.request();
    const [a, b, c, d] = [phone(), phone(), phone(), phone()];
    f.clock.set('2031-05-06T10:00:00Z');
    expect(await risk.admit({ ...request, phone: a! })).toEqual({ code: 0 });
    f.clock.advanceMs(300_000);
    expect(await risk.admit({ ...request, phone: b! })).toEqual({ code: 0 });
    f.clock.advanceMs(300_000);
    expect(await risk.admit({ ...request, phone: c! })).toEqual({ code: 0 });
    f.clock.set('2031-05-06T10:20:00Z');
    for (let i = 0; i < 4; i++) {
      expect(await risk.admit({ ...request, phone: d! })).toEqual({
        code: 42901,
        retryAfterSec: 2401,
      });
    }
    f.clock.set('2031-05-06T10:21:00Z');
    expect(await risk.admit({ ...request, phone: d! })).toEqual({
      code: 42901,
      retryAfterSec: 2341,
    });
    f.clock.set('2031-05-06T10:25:00Z');
    expect(await risk.admit({ ...request, phone: a! })).toEqual({ code: 0 });
    f.clock.set('2031-05-06T11:05:00Z');
    expect(await risk.admit({ ...request, phone: d! })).toEqual({ code: 42901, retryAfterSec: 1 });
    f.clock.advanceMs(1000);
    expect(await risk.admit({ ...request, phone: d! })).toEqual({ code: 0 });
    expect(await risk.admit({ ...request, phone: phone() })).toEqual({
      code: 42901,
      retryAfterSec: 300,
    });
  });
});

it.each([undefined, 0, -1, 1.5, '4', null, {}, 4])(
  '[AC-B1-03g#2] 设备阈值覆盖/坏值默认 3：%j',
  async (value) => {
    await withRisk(server, async (f) => {
      if (value !== undefined) f.config('sms.device_distinct_phones_per_hour', value);
      const risk = f.service();
      const request = f.request();
      const limit = value === 4 ? 4 : 3;
      for (let i = 0; i < limit; i++)
        expect(await risk.admit({ ...request, phone: phone() })).toEqual({ code: 0 });
      expect(await risk.admit({ ...request, phone: phone() })).toEqual({
        code: 42901,
        retryAfterSec: 3601,
      });
    });
  },
);

it('[AC-B1-03g#2] 配置读取失败回默认；应用和 device_hash 分别隔离', async () => {
  await withRisk(server, async (f) => {
    const risk = f.service({
      config: {
        configValue: async () => {
          throw new Error('offline');
        },
      },
    });
    const request = f.request();
    for (let i = 0; i < 3; i++)
      expect(await risk.admit({ ...request, phone: phone() })).toEqual({ code: 0 });
    expect(await risk.admit({ ...request, phone: phone() })).toEqual({
      code: 42901,
      retryAfterSec: 3601,
    });
    expect(await risk.admit({ ...request, deviceHash: hash() })).toEqual({ code: 0 });
    expect(await risk.admit({ ...request, appId: `${f.app}_b` })).toEqual({ code: 0 });
  });
});

it('[AC-B1-03g#5] 真实 Redis 两个客户端竞争最后一个名额，连续 20 轮恰一准入四拒绝', async () => {
  await withRisk(server, async (f) => {
    const first = f.service();
    const second = f.service({ redis: f.handles[1]! });
    for (let round = 0; round < 20; round++) {
      const request = f.request();
      for (let i = 0; i < 2; i++)
        expect(await first.admit({ ...request, phone: phone() })).toEqual({ code: 0 });
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          (i % 2 ? first : second).admit({ ...request, phone: phone() }),
        ),
      );
      expect(results.filter((r) => r.code === 0)).toHaveLength(1);
      expect(results.filter((r) => r.code === 42901)).toEqual(
        Array.from({ length: 4 }, () => ({ code: 42901, retryAfterSec: 3601 })),
      );
    }
  });
});

it('[AC-B1-03g#12] 毫秒时钟向上取整、左端闭区间，3600 秒仍拒、3601 秒放行', async () => {
  await withRisk(server, async (f) => {
    f.config('sms.device_distinct_phones_per_hour', 1);
    const risk = f.service();
    const request = f.request();
    expect(await risk.admit(request)).toEqual({ code: 0 });
    f.clock.advanceMs(500);
    const next = { ...request, phone: phone() };
    expect(await risk.admit(next)).toEqual({ code: 42901, retryAfterSec: 3601 });
    f.clock.advanceMs(3_599_500);
    expect(await risk.admit(next)).toEqual({ code: 42901, retryAfterSec: 1 });
    f.clock.advanceMs(1000);
    expect(await risk.admit(next)).toEqual({ code: 0 });
  });
});
