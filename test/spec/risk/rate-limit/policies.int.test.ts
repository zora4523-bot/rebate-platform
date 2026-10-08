import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRateLimitThresholdReader } from '../../../../apps/api/src/modules/risk/index.ts';
import { acquire, allowed, denied, request, withRedis, type Server } from './kit.ts';

let server: Server;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

for (const state of ['missing', 'malformed', 'unreadable'] as const) {
  it(`[AC-B1-03e#7] ${state} 配置退回转链默认每用户 30/分钟，两种 operation 共用桶`, async () => {
    await withRedis(server, async (f) => {
      if (state === 'malformed') f.config('rate_limit.convert', '{bad json');
      const s = f.service(
        state === 'unreadable'
          ? {
              thresholds: createRateLimitThresholdReader({
                configValue: async () => {
                  throw new Error('config read failed');
                },
              }),
            }
          : {},
      );
      const req = request(f.app, 'openLink');
      for (let i = 0; i < 30; i++)
        allowed(await s.check({ ...req, operationId: i % 2 === 0 ? 'openLink' : 'convertLink' }));
      denied(await s.check(req), 2);
      expect(f.lines.join('')).not.toContain('rate_limit_store_unavailable');
    });
  });
}

it('[AC-B1-03e#8] 转链默认每日容量 500 确实生效，分钟桶补满不能绕过每日桶', async () => {
  await withRedis(server, async (f) => {
    const s = f.service();
    const req = request(f.app, 'convertLink');
    // Start with 30, then one every 2s: minute never blocks. At t=950s,
    // 950000*500/86400000 = 5.4977 daily tokens accrued: 505 calls can pass.
    for (let i = 0; i < 30; i++) allowed(await s.check(req));
    for (let i = 0; i < 475; i++) {
      f.clock.advanceMs(2000);
      allowed(await s.check(req));
    }
    f.clock.advanceMs(2000);
    denied(await s.check(req), 85); // next daily token at t=1036.8s, current t=952s
  });
}, 30_000);

it('[AC-B1-03e#9] 搜索默认每用户 60/分钟、每 IP 120/分钟；换用户不重置 IP 桶', async () => {
  await withRedis(server, async (f) => {
    const s = f.service();
    const first = request(f.app);
    for (let i = 0; i < 60; i++) allowed(await s.check(first));
    denied(await s.check(first), 1);
    // Separate IP to keep the IP-capacity assertion independent of partial deductions
    // on a request already rejected by the user bucket.
    const second = { ...request(f.app), client_ip: '192.0.2.55' };
    const third = { ...request(f.app), client_ip: second.client_ip };
    for (const req of [second, third]) for (let i = 0; i < 60; i++) allowed(await s.check(req));
    denied(await s.check({ ...request(f.app), client_ip: second.client_ip }), 1);
  });
});

it('[AC-B1-03e#10] 配置覆盖默认，ops 映射原不限流接口；无分组接口无 Redis 键', async () => {
  await withRedis(server, async (f) => {
    f.config('rate_limit.ops', { listArticles: 'reading' });
    f.config('rate_limit.reading', { user: [{ limit: 2, window_sec: 60 }] });
    f.config('rate_limit.search', { user: [{ limit: 1, window_sec: 60 }] });
    const s = f.service();
    const req = request(f.app);
    allowed(await s.check(req));
    denied(await s.check(req), 60);
    const reading = { ...req, operationId: 'listArticles' };
    allowed(await s.check(reading));
    allowed(await s.check(reading));
    denied(await s.check(reading), 30);
    const before = await f.keys();
    for (let i = 0; i < 150; i++) allowed(await s.check({ ...req, operationId: 'getArticle' }));
    expect(await f.keys()).toEqual(before);
    expect(f.reads).toContain(`${f.app}:rate_limit.reading`);
    expect(f.reads).toContain(`${f.app}:rate_limit.ops`);
  });
});

it('[AC-B1-03e#11] 默认不分组 Agent、发码、设备注册与 admin 入口', async () => {
  await withRedis(server, async (f) => {
    const s = f.service();
    const req = request(f.app);
    for (const operationId of [
      'sendSmsCode',
      'registerDevice',
      'createAgentSession',
      'sendAgentMessage',
    ]) {
      for (let i = 0; i < 130; i++) allowed(await s.check({ ...req, operationId }));
    }
    for (let i = 0; i < 130; i++) allowed(await s.check({ ...req, entry: 'admin' }));
    expect(await f.keys()).toEqual([]);
    for (let i = 0; i < 60; i++) allowed(await s.check(req));
    denied(await s.check(req), 1);
  });
});
