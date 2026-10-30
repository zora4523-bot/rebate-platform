import { afterAll, beforeAll, expect, it } from 'vitest';
import { acquire, allowed, denied, request, withRedis, type Server } from '../rate-limit/kit.ts';

let server: Server;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[AC-B1-15x#2] createShare 与 convertLink 交替调用共用同一用户 convert 桶，合计第 31 次 42901', async () => {
  await withRedis(server, async (f) => {
    const s = f.service();
    const req = request(f.app, 'createShare');
    allowed(await s.check(req));
    const keys = await f.keys();
    expect(keys).toHaveLength(2);
    for (const key of keys)
      expect(key).toMatch(new RegExp(`^rl:${f.app}:convert:user:[0-9a-f]{32}:(60|86400)$`));
    for (let i = 1; i < 30; i++)
      allowed(await s.check({ ...req, operationId: i % 2 === 0 ? 'createShare' : 'convertLink' }));
    denied(await s.check(req), 2);
    denied(await s.check({ ...req, operationId: 'convertLink' }), 2);
    denied(await s.check({ ...req, operationId: 'openLink' }), 2);
    expect(await f.keys()).toEqual(keys);
    // Another user keeps a full bucket of its own.
    allowed(await s.check(request(f.app, 'createShare')));
  });
});

it('[AC-B1-15x#2] 每日 500 对 createShare 同样生效，分钟桶补满不能绕过每日桶', async () => {
  await withRedis(server, async (f) => {
    const s = f.service();
    const req = request(f.app, 'createShare');
    const op = (i: number) => (i % 2 === 0 ? 'createShare' : 'convertLink');
    // Same arithmetic as AC-B1-03e#8: 505 calls pass by t=950s, the next daily token at t=1036.8s.
    for (let i = 0; i < 30; i++) allowed(await s.check({ ...req, operationId: op(i) }));
    for (let i = 0; i < 475; i++) {
      f.clock.advanceMs(2000);
      allowed(await s.check({ ...req, operationId: op(i) }));
    }
    f.clock.advanceMs(2000);
    denied(await s.check(req), 85);
  });
}, 30_000);

it('[AC-B1-15x#3] 运行中改 ops 把 createShare 映射到别的组：改后按新组计数，convert 桶不再被扣', async () => {
  await withRedis(server, async (f) => {
    const s = f.service();
    const req = request(f.app, 'createShare');
    for (let i = 0; i < 30; i++) allowed(await s.check(req));
    denied(await s.check(req), 2);
    f.config('rate_limit.ops', { createShare: 'share' });
    f.config('rate_limit.share', { user: [{ limit: 2, window_sec: 60 }] });
    allowed(await s.check(req));
    allowed(await s.check(req));
    denied(await s.check(req), 30);
    // The convert bucket the default mapping emptied still refuses convertLink.
    denied(await s.check({ ...req, operationId: 'convertLink' }), 2);
    f.clock.advanceMs(60_000);
    // A full minute refills convert to 30: createShare spends none of it any more.
    for (let i = 0; i < 30; i++) allowed(await s.check({ ...req, operationId: 'convertLink' }));
    denied(await s.check({ ...req, operationId: 'convertLink' }), 2);
    expect(f.reads).toContain(`${f.app}:rate_limit.share`);
  });
});

it('[AC-B1-15x#3] 运行中改 ops 把 createShare 置 null：改后不限流也不写键，convertLink 照常受限', async () => {
  await withRedis(server, async (f) => {
    const s = f.service();
    const req = request(f.app, 'createShare');
    for (let i = 0; i < 30; i++) allowed(await s.check(req));
    denied(await s.check(req), 2);
    f.config('rate_limit.ops', { createShare: null });
    const before = await f.keys();
    for (let i = 0; i < 40; i++) allowed(await s.check(req));
    expect(await f.keys()).toEqual(before);
    denied(await s.check({ ...req, operationId: 'convertLink' }), 2);
  });
});
