import { expect, it } from 'vitest';
import { DATABASE_URLS, REDIS_URL, dependencyProbe } from './kit.ts';

// AC-B1-01zzj identifiers are task-local acceptance points (the task has no BR refs).
it('[AC-B1-01zzj-DEPS#1] worker 以自己的连接串完成 PG 查询和 Redis PING 才健康', async () => {
  const probe = dependencyProbe();
  expect(
    await probe.check('worker', { databaseUrl: DATABASE_URLS.worker, redisUrl: REDIS_URL }),
  ).toBe(true);
  expect(JSON.stringify(probe.pgOptions)).toContain(DATABASE_URLS.worker);
  expect(probe.queries.length).toBeGreaterThan(0);
  expect(JSON.stringify(probe.redisOptions)).toContain(REDIS_URL);
  expect(probe.pings).toEqual(['PING']);
});

it.each(['pg-connect', 'pg-query', 'redis-connect', 'redis-ping'] as const)(
  '[AC-B1-01zzj-DEPS#2] worker 的 %s 失败必须返回不健康',
  async (fault) => {
    const probe = dependencyProbe(fault);
    expect(
      await probe.check('worker', { databaseUrl: DATABASE_URLS.worker, redisUrl: REDIS_URL }),
    ).toBe(false);
  },
);

it('[AC-B1-01zzj-DEPS#3] worker 缺少 Redis 地址不能略过 Redis 并报健康', async () => {
  const probe = dependencyProbe();
  expect(await probe.check('worker', { databaseUrl: DATABASE_URLS.worker })).toBe(false);
});

it.each(['worker', 'payout'] as const)(
  '[AC-B1-01zzj-DEPS#4] %s 缺少 PG 地址不能回落到默认数据库',
  async (entry) => {
    const probe = dependencyProbe();
    expect(await probe.check(entry, { databaseUrl: '', redisUrl: REDIS_URL })).toBe(false);
    expect(probe.pgOptions).toEqual([]);
  },
);

it.each([undefined, REDIS_URL])(
  '[AC-B1-01zzj-DEPS#5] payout 只探自己的 PG，不连接 Redis（配置 %s）',
  async (redisUrl) => {
    const probe = dependencyProbe('redis-connect');
    expect(
      await probe.check('payout', {
        databaseUrl: DATABASE_URLS.payout,
        ...(redisUrl === undefined ? {} : { redisUrl }),
      }),
    ).toBe(true);
    expect(JSON.stringify(probe.pgOptions)).toContain(DATABASE_URLS.payout);
    expect(JSON.stringify(probe.pgOptions)).not.toContain(DATABASE_URLS.worker);
    expect(probe.queries.length).toBeGreaterThan(0);
    expect(probe.redisOptions).toEqual([]);
    expect(probe.pings).toEqual([]);
  },
);

it.each(['pg-connect', 'pg-query'] as const)(
  '[AC-B1-01zzj-DEPS#6] payout 的 %s 失败必须返回不健康',
  async (fault) => {
    const probe = dependencyProbe(fault);
    expect(await probe.check('payout', { databaseUrl: DATABASE_URLS.payout })).toBe(false);
    expect(probe.redisOptions).toEqual([]);
  },
);
