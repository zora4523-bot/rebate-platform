import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  RedisUnavailableError,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { acquire, admitted, flatPrivate, IP, refused, withRisk, type Server } from './kit.ts';

let server: Server;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[AC-B1-03f#1] 默认 30 台、闭区间两端、按注入时钟恢复；IP 与 app 隔离且键有 TTL', async () => {
  await withRisk(server, async (f) => {
    const service = f.service();
    const input = { appId: f.app, clientIp: IP };
    for (let i = 0; i < 30; i++) admitted(await service.reserve(input));
    refused(await service.reserve(input), 3601);
    f.clock.advanceMs(3_600_000);
    refused(await service.reserve(input), 1);
    admitted(await service.reserve({ ...input, clientIp: '192.0.2.72' }));
    admitted(await service.reserve({ ...input, appId: `${f.app}_b` }));
    f.clock.advanceMs(1000);
    admitted(await service.reserve(input));
    const keys = await f.keys();
    expect(keys.filter((key) => key.startsWith(`ip_reg:${f.app}:`))).toHaveLength(2);
    expect(keys.some((key) => key.startsWith(`ip_reg:${f.app}_b:`))).toBe(true);
    expect(keys.join('')).not.toContain(IP);
    for (const key of keys) expect(await f.raw.call('PTTL', key)).toBeGreaterThan(0);
    expect(f.reads).toContain(`${f.app}:device.ip_register_per_hour`);
  });
});

it('[AC-B1-03f#2] 动态下调到 5 时有 6 条，等待第 N−L+1 条：1201 秒而非 601 秒', async () => {
  await withRisk(server, async (f) => {
    f.config('device.ip_register_per_hour', 6);
    const service = f.service();
    const input = { appId: f.app, clientIp: IP };
    for (const minute of [0, 10, 20, 30, 40, 45]) {
      f.clock.set(`2031-05-06T09:${String(minute).padStart(2, '0')}:00Z`);
      admitted(await service.reserve(input));
    }
    f.config('device.ip_register_per_hour', 5);
    f.clock.set('2031-05-06T09:50:00Z');
    refused(await service.reserve(input), 1201);
    f.clock.set('2031-05-06T10:00:01Z');
    refused(await service.reserve(input), 600);
    f.clock.set('2031-05-06T10:10:00Z');
    refused(await service.reserve(input), 1);
    f.clock.advanceMs(1000);
    admitted(await service.reserve(input));
    refused(await service.reserve(input), 600);
  });
});

it('[AC-B1-03f#3] 已有 29 台，独立 Redis 连接并发抢最后一个名额只有一次成功', async () => {
  await withRisk(server, async (f) => {
    const services = f.handles.map((redis) => f.service({ redis }));
    const input = { appId: f.app, clientIp: IP };
    for (let i = 0; i < 29; i++) admitted(await services[0]!.reserve(input));
    const results = await Promise.all(services.map((s) => s.reserve(input)));
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code === 42901)).toEqual([
      { code: 42901, retryAfterSec: 3601 },
    ]);
    refused(await services[0]!.reserve(input), 3601);
  });
});

for (const value of [null, 0, -1, 1.5, 'bad', {}, [], true]) {
  it(`[AC-B1-03f#4] 上限坏值 ${JSON.stringify(value)} 回默认 30`, async () => {
    await withRisk(server, async (f) => {
      f.config('device.ip_register_per_hour', value);
      const service = f.service();
      const input = { appId: f.app, clientIp: IP };
      for (let i = 0; i < 30; i++) admitted(await service.reserve(input));
      refused(await service.reserve(input), 3601);
      expect(f.reads).toContain(`${f.app}:device.ip_register_per_hour`);
    });
  });
}

it('[AC-B1-03f#5] 配置读取抛错采用默认，不报 Redis 不可用', async () => {
  await withRisk(server, async (f) => {
    const service = f.service({
      config: {
        configValue: async () => {
          throw new Error('config unavailable');
        },
      },
    });
    for (let i = 0; i < 30; i++) admitted(await service.reserve({ appId: f.app, clientIp: IP }));
    refused(await service.reserve({ appId: f.app, clientIp: IP }), 3601);
    expect(
      f.lines
        .map((line) => JSON.parse(line) as { level: number })
        .filter((line) => line.level >= 40),
    ).toEqual([]);
  });
});

it('[AC-B1-03f#6] 撤销只释放本次占位且可重复，不能清空同 IP 的其他成功注册', async () => {
  await withRisk(server, async (f) => {
    f.config('device.ip_register_per_hour', 2);
    const service = f.service();
    const input = { appId: f.app, clientIp: IP };
    admitted(await service.reserve(input));
    const failed = admitted(await service.reserve(input));
    refused(await service.reserve(input), 3601);
    await service.release(failed);
    await service.release(failed);
    admitted(await service.reserve(input));
    refused(await service.reserve(input), 3601);
  });
});

for (const present of [true, false]) {
  it(`[AC-B1-03f#7] 结果未知：核实期间保留，查库结果 ${present} 后才决定释放`, async () => {
    await withRisk(server, async (f) => {
      f.config('device.ip_register_per_hour', 1);
      const service = f.service();
      const input = { appId: f.app, clientIp: IP };
      const reservation = admitted(await service.reserve(input));
      const deviceId = randomUUID();
      const result = Promise.withResolvers<boolean>();
      const entered = Promise.withResolvers<void>();
      const exists = vi.fn(async () => {
        entered.resolve();
        return result.promise;
      });
      const pending = service.reconcile(reservation, deviceId, exists);
      await entered.promise;
      try {
        refused(await service.reserve(input), 3601);
      } finally {
        result.resolve(present);
        await pending;
      }
      expect(exists).toHaveBeenCalledExactlyOnceWith(deviceId);
      if (present) refused(await service.reserve(input), 3601);
      else admitted(await service.reserve(input));
    });
  });
}

it('[AC-B1-03f#8] 核实查询也失败仍保留，后续查到未写入才能释放', async () => {
  await withRisk(server, async (f) => {
    f.config('device.ip_register_per_hour', 1);
    const service = f.service();
    const input = { appId: f.app, clientIp: IP };
    const reservation = admitted(await service.reserve(input));
    const id = randomUUID();
    const lookup = vi.fn(async () => {
      throw new Error('lookup disconnected');
    });
    // Returning or propagating a lookup failure are both valid; freeing capacity is not.
    await Promise.allSettled([service.reconcile(reservation, id, lookup)]);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(id);
    refused(await service.reserve(input), 3601);
    await service.reconcile(reservation, id, async () => false);
    admitted(await service.reserve(input));
  });
});

for (const reason of ['connect_failed', 'command_timeout', 'command_failed'] as const) {
  it(`[AC-B1-03f#9] Redis ${reason} 拒绝，首次 error 与恢复 info 各一次且无 IP 明文`, async () => {
    await withRisk(server, async (f) => {
      let broken = true;
      const redis: RedisHandle = {
        ...f.handles[0]!,
        namespace(name) {
          const ns = f.handles[0]!.namespace(name);
          return {
            ...ns,
            eval: async (script, options) => {
              if (broken) throw new RedisUnavailableError(reason);
              return ns.eval(script, options);
            },
          };
        },
      };
      const service = f.service({ redis });
      const start = f.lines.length;
      for (let i = 0; i < 4; i++) refused(await service.reserve({ appId: f.app, clientIp: IP }), 1);
      const logs = () =>
        f.lines.slice(start).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(logs().filter((line) => line['level'] === 50)).toHaveLength(1);
      broken = false;
      admitted(await service.reserve({ appId: f.app, clientIp: IP }));
      admitted(await service.reserve({ appId: f.app, clientIp: IP }));
      expect(logs().filter((line) => line['level'] === 30)).toHaveLength(1);
      flatPrivate(logs(), [IP]);
      broken = true;
      refused(await service.reserve({ appId: f.app, clientIp: IP }), 1);
      expect(logs().filter((line) => line['level'] === 50)).toHaveLength(2);
    });
  });
}

it('[AC-B1-03f#10] 无 Redis 入口拒绝占位，热点端口为空实现', async () => {
  await withRisk(server, async (f) => {
    const service = f.service({ redis: null });
    refused(await service.reserve({ appId: f.app, clientIp: IP }), 1);
    await expect(
      service.recordSuccess({ appId: f.app, deviceHash: 'ab'.repeat(32), deviceId: randomUUID() }),
    ).resolves.toBeUndefined();
  });
});
