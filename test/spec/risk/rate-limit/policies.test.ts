import { expect, it, vi } from 'vitest';
import {
  createRateLimitThresholdReader,
  type RateLimitConfigReader,
} from '../../../../apps/api/src/modules/risk/index.ts';

it('[AC-B1-03e#20] 默认映射及阈值精确来自 06 Q-B4，其他维度没有臆造默认值', async () => {
  const reader = createRateLimitThresholdReader({ configValue: async () => null });
  expect(await reader.groupFor('couli', 'openLink')).toBe('convert');
  expect(await reader.groupFor('couli', 'convertLink')).toBe('convert');
  expect(await reader.groupFor('couli', 'searchProducts')).toBe('search');
  expect(await reader.rules('couli', 'convert', 'user')).toEqual([
    { limit: 30, window_sec: 60 },
    { limit: 500, window_sec: 86400 },
  ]);
  expect(await reader.rules('couli', 'search', 'user')).toEqual([{ limit: 60, window_sec: 60 }]);
  expect(await reader.rules('couli', 'search', 'ip')).toEqual([{ limit: 120, window_sec: 60 }]);
  for (const [group, dimension] of [
    ['convert', 'device'],
    ['convert', 'ip'],
    ['search', 'device'],
  ] as const) {
    expect(await reader.rules('couli', group, dimension)).toEqual([]);
  }
});

for (const state of ['missing', 'invalid-json', 'read-failed'] as const) {
  it(`[AC-B1-03e#21] ${state} 的 ops/阈值读取回落默认，未知接口仍不分组`, async () => {
    const configValue = vi.fn<RateLimitConfigReader['configValue']>(async () => {
      if (state === 'read-failed') throw new Error('configuration database unavailable');
      return state === 'missing' ? null : { value: '{malformed', version: 1 };
    });
    const reader = createRateLimitThresholdReader({ configValue });
    expect(await reader.groupFor('couli', 'searchProducts')).toBe('search');
    expect(await reader.groupFor('couli', 'getArticle')).toBeNull();
    expect(await reader.rules('couli', 'search', 'user')).toEqual([{ limit: 60, window_sec: 60 }]);
    expect(await reader.rules('couli', 'unconfigured', 'user')).toEqual([]);
  });
}

it('[AC-B1-03e#22] 配置按 app 隔离并覆盖接口映射；规则列表三维分别读取', async () => {
  const configValue = vi.fn<RateLimitConfigReader['configValue']>(async (app, key) => {
    if (app !== 'couli') return null;
    if (key === 'rate_limit.ops')
      return { value: { searchProducts: 'custom', listArticles: 'custom' }, version: 3 };
    if (key === 'rate_limit.custom')
      return {
        value: {
          user: [
            { limit: 4, window_sec: 20 },
            { limit: 40, window_sec: 86400 },
          ],
          device: [{ limit: 5, window_sec: 30 }],
          ip: [{ limit: 6, window_sec: 40 }],
        },
        version: 7,
      };
    return null;
  });
  const reader = createRateLimitThresholdReader({ configValue });
  expect(await reader.groupFor('couli', 'searchProducts')).toBe('custom');
  expect(await reader.groupFor('couli', 'listArticles')).toBe('custom');
  expect(await reader.groupFor('second_app', 'searchProducts')).toBe('search');
  expect(await reader.groupFor('second_app', 'listArticles')).toBeNull();
  expect(await reader.rules('couli', 'custom', 'user')).toEqual([
    { limit: 4, window_sec: 20 },
    { limit: 40, window_sec: 86400 },
  ]);
  expect(await reader.rules('couli', 'custom', 'device')).toEqual([{ limit: 5, window_sec: 30 }]);
  expect(await reader.rules('couli', 'custom', 'ip')).toEqual([{ limit: 6, window_sec: 40 }]);
  expect(await reader.rules('second_app', 'custom', 'user')).toEqual([]);
  expect(configValue).toHaveBeenCalledWith('couli', 'rate_limit.custom');
  expect(configValue).toHaveBeenCalledWith('second_app', 'rate_limit.ops');
});
