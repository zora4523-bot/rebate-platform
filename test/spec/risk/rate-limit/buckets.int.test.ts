import { afterAll, beforeAll, expect, it } from 'vitest';
import { acquire, allowed, denied, request, withRedis, type Server } from './kit.ts';

let server: Server;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[AC-B1-03e#1] 两个进程句柄并发只放行 N 次，第 N+1 次限流，键有 app/group/dim 与 TTL', async () => {
  await withRedis(server, async (f) => {
    f.config('rate_limit.search', { user: [{ limit: 7, window_sec: 60 }] });
    const services = f.handles.map((redis) => f.service({ redis }));
    const req = request(f.app);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => services[i % 2]!.check(req)),
    );
    expect(results.filter((r) => r.code === 0)).toHaveLength(7);
    const refused = results.filter((r) => r.code !== 0);
    expect(refused).toHaveLength(33);
    refused.forEach((r) => denied(r, 9));
    const keys = await f.keys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith(`rl:${f.app}:search:user:`))).toBe(true);
    for (const key of keys) {
      const ttl = await f.raw.call('PTTL', key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120_000);
    }
  });
});

it('[AC-B1-03e#2] 按注入时钟连续补充而非整分钟清零；不足一枚时 Retry-After 向上取整', async () => {
  await withRedis(server, async (f) => {
    f.config('rate_limit.search', { user: [{ limit: 3, window_sec: 60 }] });
    const service = f.service();
    const req = request(f.app);
    for (let i = 0; i < 3; i++) allowed(await service.check(req));
    denied(await service.check(req), 20);
    f.clock.advanceMs(500);
    denied(await service.check(req), 20);
    f.clock.advanceMs(19_499);
    denied(await service.check(req), 1);
    f.clock.advanceMs(1);
    allowed(await service.check(req));
    denied(await service.check(req), 20);
    f.clock.advanceMs(600_000);
    for (let i = 0; i < 3; i++) allowed(await service.check(req));
    denied(await service.check(req), 20);
  });
});

it('[AC-B1-03e#3] 同组分钟与每日规则各自保存余额，分钟已补满仍被每日桶拒绝', async () => {
  await withRedis(server, async (f) => {
    f.config('rate_limit.convert', {
      user: [
        { limit: 2, window_sec: 60 },
        { limit: 3, window_sec: 86400 },
      ],
    });
    const s = f.service();
    const req = request(f.app, 'openLink');
    allowed(await s.check(req));
    allowed(await s.check(req));
    f.clock.advanceMs(60_000);
    allowed(await s.check({ ...req, operationId: 'convertLink' }));
    denied(await s.check(req), 28_740);
    f.clock.advanceMs(28_740_000);
    allowed(await s.check(req));
    const keys = await f.keys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(await f.raw.call('PTTL', key)).toBeGreaterThan(0);
      expect(await f.raw.call('PTTL', key)).toBeLessThanOrEqual(172_800_000);
    }
  });
});

for (const dimension of ['user', 'device', 'ip'] as const) {
  it(`[AC-B1-03e#4] ${dimension} 独立成桶：其他维度全换仍拒绝，只换本维度才能放行`, async () => {
    await withRedis(server, async (f) => {
      f.config('rate_limit.search', {
        user: [{ limit: dimension === 'user' ? 1 : 100, window_sec: 60 }],
        device: [{ limit: dimension === 'device' ? 1 : 100, window_sec: 60 }],
        ip: [{ limit: dimension === 'ip' ? 1 : 100, window_sec: 60 }],
      });
      const s = f.service();
      const first = request(f.app);
      const other = request(f.app);
      allowed(await s.check(first));
      const shared = {
        ...other,
        client_ip: dimension === 'ip' ? first.client_ip! : '192.0.2.20',
        principal: {
          ...other.principal!,
          uid: dimension === 'user' ? first.principal!.uid : other.principal!.uid,
          device_id:
            dimension === 'device' ? first.principal!.device_id : other.principal!.device_id,
        },
      };
      denied(await s.check(shared), 60);
      allowed(await s.check({ ...other, client_ip: '192.0.2.30' }));
    });
  });
}

it('[AC-B1-03e#5] 三维同时启用，任一维度耗尽就拒绝；匿名无设备仅计 IP', async () => {
  await withRedis(server, async (f) => {
    f.config('rate_limit.search', {
      user: [{ limit: 1, window_sec: 60 }],
      device: [{ limit: 1, window_sec: 60 }],
      ip: [{ limit: 3, window_sec: 60 }],
    });
    const s = f.service();
    const anonymous = {
      entry: 'api' as const,
      app_id: f.app,
      operationId: 'searchProducts',
      client_ip: '192.0.2.44',
    };
    for (let i = 0; i < 3; i++) allowed(await s.check(anonymous));
    denied(await s.check(anonymous), 20);
    expect((await f.keys()).every((key) => key.includes(':ip:'))).toBe(true);
    const req = request(f.app);
    allowed(await s.check(req));
    denied(await s.check({ ...req, client_ip: '192.0.2.45' }), 60);
    const all = await f.keys();
    for (const dim of ['user', 'device', 'ip'])
      expect(all.some((key) => key.includes(`:${dim}:`))).toBe(true);
    for (const key of all) {
      expect(await f.raw.call('PTTL', key)).toBeGreaterThan(0);
      expect(await f.raw.call('PTTL', key)).toBeLessThanOrEqual(120_000);
    }
  });
});

it('[AC-B1-03e#6] 设备取 principal 优先，无令牌时取 verifiedDevice；app 和 group 隔离', async () => {
  await withRedis(server, async (f) => {
    f.config('rate_limit.search', { device: [{ limit: 1, window_sec: 60 }] });
    f.config('rate_limit.convert', { device: [{ limit: 1, window_sec: 60 }] });
    const s = f.service();
    const req = request(f.app);
    allowed(await s.check({ ...req, verifiedDevice: { deviceId: 'unused', appId: f.app } }));
    denied(
      await s.check({
        entry: 'api',
        app_id: f.app,
        operationId: 'searchProducts',
        verifiedDevice: { deviceId: req.principal!.device_id, appId: f.app },
      }),
      60,
    );
    allowed(await s.check({ ...req, operationId: 'openLink' }));
    const app = `${f.app}_b`;
    f.config('rate_limit.search', { device: [{ limit: 1, window_sec: 60 }] }, app);
    allowed(await s.check({ ...req, app_id: app, principal: { ...req.principal!, app_id: app } }));
    denied(await s.check(req), 60);
  });
});
