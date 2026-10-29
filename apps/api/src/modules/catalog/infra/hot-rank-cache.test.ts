import { expect, it, vi } from 'vitest';
import { FixedClock, RedisUnavailableError, type RedisNamespace } from '../../platform/index.ts';
import { UnionError } from '../../union/index.ts';
import type { HotRankUpstream } from '../hot-rank.ts';
import { cacheHotRankUpstream } from './hot-rank-cache.ts';

const NOW = '2026-10-29T12:00:00+08:00';
const request = { appId: 'synthetic', platform: 'taobao', channelId: 'synthetic_ch' } as const;

function upstream(): HotRankUpstream & { categories: ReturnType<typeof vi.fn> } {
  return {
    categories: vi.fn(async () => [{ categoryId: 'synthetic-a', name: '合成' }]),
    page: vi.fn(async () => ({ items: [], hasMore: false })),
  };
}

const noConfig = { configValue: vi.fn(async () => null) };

it('[AC-B1-28h] Redis 不可用时直接读联盟，不报错', async () => {
  const redis: RedisNamespace = {
    get: async () => {
      throw new RedisUnavailableError('connect_failed');
    },
    set: async () => {
      throw new RedisUnavailableError('connect_failed');
    },
    eval: async () => {
      throw new Error('no Lua');
    },
  };
  const union = upstream();
  const cached = cacheHotRankUpstream(union, {
    redis,
    clock: new FixedClock(NOW),
    config: noConfig,
  });
  await expect(cached.categories(request)).resolves.toEqual([
    { categoryId: 'synthetic-a', name: '合成' },
  ]);
  expect(union.categories).toHaveBeenCalledTimes(1);
});

it('[AC-B1-28h] 读不懂的缓存条目按未命中处理；联盟故障时也不拿它冒充', async () => {
  const rows = new Map<string, string>();
  const redis: RedisNamespace = {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, value) => {
      rows.set(key, value);
    },
    eval: async () => {
      throw new Error('no Lua');
    },
  };
  const union = upstream();
  const clock = new FixedClock(NOW);
  const cached = cacheHotRankUpstream(union, { redis, clock, config: noConfig });
  await cached.categories(request);
  const [key] = [...rows.keys()];
  rows.set(key!, JSON.stringify({ v: 1, fetched_at_ms: clock.now().getTime(), data: 'bad' }));

  await cached.categories(request);
  expect(union.categories).toHaveBeenCalledTimes(2);

  rows.set(key!, '{not json');
  union.categories.mockRejectedValueOnce(
    new UnionError('upstream_unavailable', 'synthetic', 'taobao'),
  );
  await expect(cached.categories(request)).rejects.toBeInstanceOf(UnionError);
});
