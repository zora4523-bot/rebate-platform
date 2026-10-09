import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRedisHandle,
  RedisUnavailableError,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { redisConnection } from '../../identity/sms-codes/kit.ts';
import { acquire, IP, phone, privateText, snapshot, withRisk, type Server } from './kit.ts';

let server: Server;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[AC-B1-03g#9] 真实 Redis 连接关闭后拒绝，存储失败不能变成放行', async () => {
  await withRisk(server, async (f) => {
    // TEST_REDIS_URL is shared in CI; its server.stop() is deliberately a no-op. Close only
    // this service's real connection, leaving signature storage and other test files intact.
    const redis = await createRedisHandle(redisConnection(server.url), {
      logger: f.options.logger,
    });
    try {
      const risk = f.service({ redis });
      expect(await risk.admit(f.request())).toEqual({ code: 0 });
      await redis?.close();
      for (let i = 0; i < 3; i++)
        expect(await risk.admit(f.request())).toEqual({ code: 42901, retryAfterSec: 1 });
    } finally {
      await redis?.close();
    }
  });
});

it.each(['connect_failed', 'command_timeout', 'command_failed'] as const)(
  '[AC-B1-03g#9] %s：首次 error、恢复 info 各一次，不占名额，不泄露号码/IP',
  async (reason) => {
    await withRisk(server, async (f) => {
      let broken = true;
      const redis: RedisHandle = {
        ...f.handles[0]!,
        namespace(name) {
          const ns = f.handles[0]!.namespace(name);
          return {
            async get(key) {
              if (broken) throw new RedisUnavailableError(reason);
              return ns.get(key);
            },
            async set(key, value, ttl) {
              if (broken) throw new RedisUnavailableError(reason);
              return ns.set(key, value, ttl);
            },
            async eval(script, options) {
              if (broken) throw new RedisUnavailableError(reason);
              return ns.eval(script, options);
            },
          };
        },
      };
      const risk = f.service({ redis });
      const request = f.request();
      const start = f.lines.length;
      const logs = () =>
        f.lines.slice(start).map((line) => JSON.parse(line) as Record<string, unknown>);
      for (let i = 0; i < 4; i++)
        expect(await risk.admit(request)).toEqual({ code: 42901, retryAfterSec: 1 });
      expect(logs().filter((line) => line['level'] === 50)).toHaveLength(1);
      broken = false;
      for (let i = 0; i < 3; i++)
        expect(await risk.admit({ ...request, phone: phone() })).toEqual({ code: 0 });
      expect(logs().filter((line) => line['level'] === 30)).toHaveLength(1);
      expect(await risk.admit(request)).toEqual({ code: 42901, retryAfterSec: 3601 });
      privateText(JSON.stringify(logs()), [IP, request.phone, `+86${request.phone}`]);
      for (const line of logs())
        expect(Object.values(line).every((v) => v === null || typeof v !== 'object')).toBe(true);
      broken = true;
      expect(await risk.admit(request)).toEqual({ code: 42901, retryAfterSec: 1 });
      expect(logs().filter((line) => line['level'] === 50)).toHaveLength(2);
    });
  },
);

it('[AC-B1-03g#9] 未配置 Redis 一律 42901 Retry-After 1', async () => {
  await withRisk(server, async (f) => {
    const risk = f.service({ redis: null });
    expect(await risk.admit(f.request())).toEqual({ code: 42901, retryAfterSec: 1 });
    expect(await f.keys()).toEqual([]);
  });
});

it('[AC-B1-03g#11] 拒绝号码也有带时刻的 HMAC 请求记录；所有 Redis 键值和日志没有号码/IP 明文', async () => {
  await withRisk(server, async (f) => {
    f.config('sms.device_distinct_phones_per_hour', 1);
    const risk = f.service();
    const request = f.request();
    expect(await risk.admit(request)).toEqual({ code: 0 });
    const denied = phone();
    f.clock.advanceMs(2000);
    expect(await risk.admit({ ...request, phone: denied })).toEqual({
      code: 42901,
      retryAfterSec: 3599,
    });
    await risk.recordAccepted({ appId: f.app, clientIp: IP });
    await f.registered(risk);
    const contents = await snapshot(f.raw, `*${f.app}*`);
    expect(contents.length).toBeGreaterThan(0);
    const hashes = f.digests.filter((d) => d.value === denied).map((d) => d.digest);
    expect(hashes.length).toBeGreaterThan(0);
    // Rejected number is not a member of the admission set, so its digest must occur in a
    // separate request record. No implementation key name or filename is assumed here.
    const records = contents.filter((entry) =>
      hashes.some((digest) => JSON.stringify(entry.value).includes(digest)),
    );
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).toContain(String(f.clock.now().getTime()));
    for (const record of records) {
      expect(record.ttl).toBeGreaterThan(0);
      expect(record.ttl).toBeLessThanOrEqual(3602);
    }
    for (const entry of contents) expect(entry.ttl).toBeGreaterThan(0);
    privateText(JSON.stringify(contents) + f.lines.join(''), [
      request.phone,
      denied,
      `+86${request.phone}`,
      `+86${denied}`,
      IP,
    ]);
    const contexts = f.digests.filter((d) => d.value === IP).map((d) => d.context);
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts).not.toContain('risk.device_register.ip');
    expect(contexts).not.toContain('users.phone');
    expect(contexts).not.toContain('identity.sms_codes');
  });
});
