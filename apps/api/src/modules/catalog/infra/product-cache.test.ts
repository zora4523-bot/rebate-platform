import { expect, it, vi } from 'vitest';
import { FixedClock, GovernanceError, type RedisNamespace } from '../../platform/index.ts';
import type { UnionItemDetail } from '../../union/index.ts';
import type { ProductDetailUpstream } from '../detail.ts';
import { cacheDetailUpstream, normalizeKeyword } from './product-cache.ts';

const NOW = '2026-10-08T12:00:00+08:00';

function memory(): RedisNamespace {
  const rows = new Map<string, string>();
  return {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, value) => {
      rows.set(key, value);
    },
    eval: async () => {
      throw new Error('no Lua on the product cache');
    },
  };
}

function item(): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: 'synthetic-raw',
    title: 'synthetic',
    price_fen: 100n,
    coupon_fen: 0n,
    final_price_fen: 100n,
    commission_rate_bp: 1000n,
    quoted_at: NOW,
  };
}

it('[AC-B1-05g] stale_max_age_s 配置超过 3600 时按 3600 计', async () => {
  const clock = new FixedClock(NOW);
  const detail = vi.fn<ProductDetailUpstream['detail']>(async () => item());
  const values = new Map<string, number>([
    ['search.cache_ttl_sec', 1],
    ['search.cache.stale_max_age_s', 7200],
  ]);
  const upstream = cacheDetailUpstream(
    { detail },
    {
      redis: memory(),
      clock,
      config: {
        configValue: async (_app, key) =>
          values.has(key) ? { value: values.get(key)!, version: 1 } : null,
      },
    },
  );
  const request = {
    appId: 'synthetic_app',
    productKey: 'tb:synthetic',
    platform: 'taobao' as const,
    rawItemId: 'synthetic-raw',
  };
  await upstream.detail(request);
  detail.mockRejectedValue(new GovernanceError('circuit_open', 'union.detail', 'synthetic'));
  clock.advanceMs(3_600_000);
  await expect(upstream.detail(request)).resolves.toMatchObject({ title: 'synthetic' });
  clock.advanceMs(1);
  await expect(upstream.detail(request)).rejects.toMatchObject({ code: 'circuit_open' });
});

it('[AC-B1-05g] norm(q)：NFKC、去首尾空白、合并空白、转小写', () => {
  expect(normalizeKeyword('  ＭＩＬＫ\t  Tea  ')).toBe('milk tea');
  expect(normalizeKeyword('合成　纸巾')).toBe('合成 纸巾');
});
