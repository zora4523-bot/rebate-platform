import { expect, it, vi } from 'vitest';
import {
  createRateLimitThresholdReader,
  type RateLimitConfigReader,
} from '../../../../apps/api/src/modules/risk/index.ts';

const CONVERT_USER = [
  { limit: 30, window_sec: 60 },
  { limit: 500, window_sec: 86400 },
];

function values(byApp: Record<string, Record<string, unknown>>): RateLimitConfigReader {
  return {
    configValue: async (app, key) =>
      Object.hasOwn(byApp, app) && Object.hasOwn(byApp[app]!, key)
        ? { value: byApp[app]![key], version: 1 }
        : null,
  };
}

it('[AC-B1-15x#1] 缺省 createShare 与 convertLink / openLink 同归 convert 组，convert 阈值不变', async () => {
  const reader = createRateLimitThresholdReader({ configValue: async () => null });
  expect(await reader.groupFor('couli', 'createShare')).toBe('convert');
  expect(await reader.groupFor('couli', 'convertLink')).toBe('convert');
  expect(await reader.groupFor('couli', 'openLink')).toBe('convert');
  expect(await reader.rules('couli', 'convert', 'user')).toEqual(CONVERT_USER);
  expect(await reader.rules('couli', 'convert', 'device')).toEqual([]);
  expect(await reader.rules('couli', 'convert', 'ip')).toEqual([]);
});

it('[AC-B1-15x#1] 其他接口的分组与阈值不变：search 仍是 60/分钟与 IP 120/分钟，分享页等不分组', async () => {
  const reader = createRateLimitThresholdReader({ configValue: async () => null });
  expect(await reader.groupFor('couli', 'createShare')).toBe('convert');
  expect(await reader.groupFor('couli', 'searchProducts')).toBe('search');
  expect(await reader.rules('couli', 'search', 'user')).toEqual([{ limit: 60, window_sec: 60 }]);
  expect(await reader.rules('couli', 'search', 'ip')).toEqual([{ limit: 120, window_sec: 60 }]);
  expect(await reader.rules('couli', 'search', 'device')).toEqual([]);
  for (const operationId of [
    'getSharePage',
    'getShareTpwd',
    'getArticle',
    'sendSmsCode',
    'registerDevice',
    'createAgentSession',
    'sendAgentMessage',
  ]) {
    expect(await reader.groupFor('couli', operationId)).toBeNull();
  }
  // No new group or configuration key: there is no `share` group by default.
  expect(await reader.rules('couli', 'share', 'user')).toEqual([]);
});

for (const state of ['missing', 'invalid-json', 'read-failed'] as const) {
  it(`[AC-B1-15x#1] ${state} 的 ops 读取回落缺省映射，createShare 仍归 convert`, async () => {
    const configValue = vi.fn<RateLimitConfigReader['configValue']>(async () => {
      if (state === 'read-failed') throw new Error('configuration database unavailable');
      return state === 'missing' ? null : { value: '{malformed', version: 1 };
    });
    const reader = createRateLimitThresholdReader({ configValue });
    expect(await reader.groupFor('couli', 'createShare')).toBe('convert');
    expect(await reader.rules('couli', 'convert', 'user')).toEqual(CONVERT_USER);
    expect(configValue).toHaveBeenCalledWith('couli', 'rate_limit.ops');
  });
}

it('[AC-B1-15x#3] ops 只映射别的接口时按缺省合并，createShare 仍归 convert', async () => {
  const reader = createRateLimitThresholdReader(
    values({ couli: { 'rate_limit.ops': { listArticles: 'reading', openLink: null } } }),
  );
  expect(await reader.groupFor('couli', 'listArticles')).toBe('reading');
  expect(await reader.groupFor('couli', 'openLink')).toBeNull();
  expect(await reader.groupFor('couli', 'createShare')).toBe('convert');
  expect(await reader.groupFor('couli', 'convertLink')).toBe('convert');
});

it('[AC-B1-15x#3] ops 把 createShare 映射到别的组时按配置生效，只影响配置的 app', async () => {
  const reader = createRateLimitThresholdReader(
    values({
      couli: {
        'rate_limit.ops': { createShare: 'share' },
        'rate_limit.share': { user: [{ limit: 2, window_sec: 60 }] },
      },
    }),
  );
  expect(await reader.groupFor('couli', 'createShare')).toBe('share');
  expect(await reader.rules('couli', 'share', 'user')).toEqual([{ limit: 2, window_sec: 60 }]);
  expect(await reader.groupFor('couli', 'convertLink')).toBe('convert');
  expect(await reader.groupFor('couli', 'openLink')).toBe('convert');
  expect(await reader.rules('couli', 'convert', 'user')).toEqual(CONVERT_USER);
  expect(await reader.groupFor('second_app', 'createShare')).toBe('convert');
});

it('[AC-B1-15x#3] ops 把 createShare 置 null 时去掉分组，convertLink / openLink 不受影响', async () => {
  const reader = createRateLimitThresholdReader(
    values({ couli: { 'rate_limit.ops': { createShare: null } } }),
  );
  expect(await reader.groupFor('couli', 'createShare')).toBeNull();
  expect(await reader.groupFor('couli', 'convertLink')).toBe('convert');
  expect(await reader.groupFor('couli', 'openLink')).toBe('convert');
  expect(await reader.groupFor('second_app', 'createShare')).toBe('convert');
});

it('[AC-B1-15x#3] 不合规的 ops 整体作废，createShare 退回缺省 convert 而不是去掉', async () => {
  const reader = createRateLimitThresholdReader(
    values({ couli: { 'rate_limit.ops': { createShare: null, listArticles: 'Bad Group' } } }),
  );
  expect(await reader.groupFor('couli', 'listArticles')).toBeNull();
  expect(await reader.groupFor('couli', 'createShare')).toBe('convert');
});
