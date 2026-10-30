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

function memoryRedis() {
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
  return { rows, redis };
}

const pageInput = { ...request, categoryId: null, pageNo: 1, pageSize: 20 };

it('[AC-B1-28l] 空页不带 positions：不写这个键，命中后也没有', async () => {
  const { rows, redis } = memoryRedis();
  const union = upstream();
  const cached = cacheHotRankUpstream(union, {
    redis,
    clock: new FixedClock(NOW),
    config: noConfig,
  });

  await cached.page(pageInput);
  const hit = await cached.page(pageInput);

  expect(union.page).toHaveBeenCalledTimes(1);
  expect('positions' in hit).toBe(false);
  const [text] = [...rows.values()];
  expect(JSON.parse(text!)).toMatchObject({ data: { items: [], has_more: false } });
  expect(text).not.toContain('positions');
});

it('[AC-B1-28l] 存储里 positions 第一个元素就是负数：按读不出重新取数', async () => {
  const { rows, redis } = memoryRedis();
  const union = upstream();
  const clock = new FixedClock(NOW);
  const cached = cacheHotRankUpstream(union, { redis, clock, config: noConfig });
  await cached.page(pageInput);
  const [key] = [...rows.keys()];
  const stored = (positions: readonly number[]) =>
    JSON.stringify({
      v: 1,
      fetched_at_ms: clock.now().getTime(),
      data: {
        has_more: false,
        items: [
          {
            item: {
              platform: 'taobao',
              item_id: 'synthetic-a-1',
              title: '合成',
              quoted_at: '2026-10-29T03:00:00.000Z',
              price_fen: '1000',
              coupon_fen: '0',
              final_price_fen: '1000',
              commission_rate_bp: '1000',
            },
            ref: {
              appId: 'synthetic',
              platform: 'taobao',
              productKey: 'tb:synthetic-a-1',
              rawItemId: 'synthetic-a-1',
              rawFetchedAt: '2026-10-29T03:00:00.000Z',
              receivedAt: '2026-10-29T04:00:00.000Z',
              title: '合成',
              shopId: null,
              shopType: null,
              source: 'search',
            },
            sales_text: null,
          },
        ],
        positions,
      },
    });

  // Same entry with a good position is a hit, so only the negative number below makes it unreadable.
  rows.set(key!, stored([0]));
  await expect(cached.page(pageInput)).resolves.toMatchObject({ positions: [0] });
  expect(union.page).toHaveBeenCalledTimes(1);

  rows.set(key!, stored([-1]));
  await cached.page(pageInput);

  expect(union.page).toHaveBeenCalledTimes(2);
});
