import { expect, it } from 'vitest';
import { DATABASE_URLS, REDIS_URL, dependencyProbe } from './kit.ts';
import type { Probe } from './kit.ts';
import { TLS_DATABASE_URLS, expectVerifyCa, tlsDependencyProbe } from './review-kit.ts';

it.each(['worker', 'payout'] as const)(
  '[AC-B1-01zzj-DEPS#7] %s 使用 staging verify-ca 连接，不误校验主机名且不关闭 CA 校验',
  async (entry) => {
    const probe = tlsDependencyProbe();
    expect(
      await probe.check(entry, {
        databaseUrl: TLS_DATABASE_URLS[entry],
        redisUrl: REDIS_URL,
      }),
    ).toBe(true);
    expect(probe.pgOptions).toHaveLength(1);
    expectVerifyCa(probe.pgOptions[0], entry);
    expect(probe.queries.length).toBeGreaterThan(0);
    if (entry === 'worker') {
      expect(JSON.stringify(probe.redisOptions)).toContain(REDIS_URL);
      expect(probe.pings).toEqual(['PING']);
    } else {
      expect(probe.redisOptions).toEqual([]);
      expect(probe.pings).toEqual([]);
    }
  },
);

it.each(['worker', 'payout'] as const)(
  '[AC-B1-01zzj-DEPS#8] %s 的 DATABASE_URL 未定义时拒绝 PG 默认连接',
  async (entry) => {
    const probe = dependencyProbe();
    // Compose reads process.env directly: runtime undefined is possible despite the TS type.
    const config = {
      databaseUrl: undefined,
      redisUrl: REDIS_URL,
    } as unknown as Parameters<Probe>[1];
    expect(await probe.check(entry, config)).toBe(false);
    expect(probe.pgOptions).toEqual([]);
    expect(probe.queries).toEqual([]);
  },
);

it.each(['', undefined])(
  '[AC-B1-01zzj-DEPS#9] worker 的 REDIS_URL 为 %s 时拒绝 Redis 默认连接',
  async (redisUrl) => {
    const probe = dependencyProbe();
    expect(
      await probe.check('worker', {
        databaseUrl: DATABASE_URLS.worker,
        ...(redisUrl === undefined ? {} : { redisUrl }),
      }),
    ).toBe(false);
    expect(probe.redisOptions).toEqual([]);
    expect(probe.pings).toEqual([]);
  },
);
