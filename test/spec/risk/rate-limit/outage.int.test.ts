import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  RedisUnavailableError,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { acquire, allowed, denied, request, withRedis, type Server } from './kit.ts';

let server: Server;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

for (const reason of ['connect_failed', 'command_timeout', 'command_failed'] as const) {
  it(`[AC-B1-03e#12] Redis ${reason} 拒绝并告警，配置读取失败与存储失败不混淆`, async () => {
    await withRedis(server, async (f) => {
      let broken = true;
      const redis: RedisHandle = {
        ...f.handles[0]!,
        namespace(name) {
          const ns = f.handles[0]!.namespace(name);
          return {
            get: async (key) => {
              if (broken) throw new RedisUnavailableError(reason);
              return ns.get(key);
            },
            set: async (key, value, ttl) => {
              if (broken) throw new RedisUnavailableError(reason);
              return ns.set(key, value, ttl);
            },
            eval: async (script, options) => {
              if (broken) throw new RedisUnavailableError(reason);
              return ns.eval(script, options);
            },
          };
        },
      };
      const s = f.service({ redis });
      const req = request(f.app);
      const alerts = () =>
        f.lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => String(line['msg']).startsWith('rate_limit_store_'));
      denied(await s.check(req), 1);
      expect(
        alerts().filter((line) => line['msg'] === 'rate_limit_store_unavailable'),
      ).toHaveLength(1);
      expect(alerts()[0]!['level']).toBe(50);
      for (let i = 0; i < 4; i++) denied(await s.check({ ...req, operationId: 'openLink' }), 1);
      f.clock.advanceMs(59_999);
      expect(
        alerts().filter((line) => line['msg'] === 'rate_limit_store_unavailable_summary'),
      ).toHaveLength(0);
      f.clock.advanceMs(1);
      denied(await s.check(req), 1);
      const summaries = alerts().filter(
        (line) => line['msg'] === 'rate_limit_store_unavailable_summary',
      );
      expect(summaries).toHaveLength(1);
      expect(JSON.stringify(summaries)).toContain('searchProducts');
      expect(JSON.stringify(summaries)).toContain('openLink');
      // A boundary request can belong to either reporting interval. Both are valid;
      // the completed interval must report its five refusals, optionally the sixth.
      expect(Object.values(summaries[0]!).some((value) => value === 5 || value === 6)).toBe(true);
      for (let i = 0; i < 3; i++) denied(await s.check(req), 1);
      expect(
        alerts().filter((line) => line['msg'] === 'rate_limit_store_unavailable_summary'),
      ).toHaveLength(1);
      expect(
        alerts().filter((line) => line['msg'] === 'rate_limit_store_unavailable'),
      ).toHaveLength(1);
      broken = false;
      allowed(await s.check(req));
      allowed(await s.check(req));
      const recovered = alerts().filter((line) => line['msg'] === 'rate_limit_store_recovered');
      expect(recovered).toHaveLength(1);
      expect(recovered[0]!['level']).toBe(30);
      for (const line of alerts()) {
        expect(
          Object.values(line).every((value) => value === null || typeof value !== 'object'),
        ).toBe(true);
      }
      const text = JSON.stringify(alerts());
      for (const secret of [
        req.principal!.uid,
        req.principal!.device_id,
        req.client_ip!,
        ...(await f.keys()),
      ])
        expect(text).not.toContain(secret);
      broken = true;
      denied(await s.check(req), 1);
      expect(
        alerts().filter((line) => line['msg'] === 'rate_limit_store_unavailable'),
      ).toHaveLength(2);
    });
  });
}
