import { expect, it, vi } from 'vitest';
import { readClaimEvidenceWindow } from '../../../../apps/api/src/modules/orders/index.ts';
import type { ContentReader, ConfigValue } from '../../../../apps/api/src/modules/content/index.ts';
import { check, log, at, value } from './kit.ts';

it.each([
  ['2027-10-05T12:00:00.000Z', 'strong'],
  ['2027-10-05T11:59:59.000Z', 'none'],
  ['2027-10-20T12:00:00.000Z', 'strong'],
  ['2027-10-20T12:00:01.000Z', 'none'],
  ['2027-10-05T11:59:59.999Z', 'none'],
  ['2027-10-20T12:00:00.001Z', 'none'],
] as const)('[AC-B1-10c#11] 360小时闭区间、绝对毫秒时长：%s → %s', async (instant, level) => {
  await check({ logs: [log({ created_at: at(instant) })] }, level, level === 'none' ? [] : ['101']);
});
it.each([
  ['2027-10-19T12:00:00.000Z', 'strong'],
  ['2027-10-19T11:59:59.999Z', 'none'],
] as const)('[AC-B1-10c#12] 配置24小时改变窗口：%s → %s', async (instant, level) => {
  await check(
    { windowHours: 24, logs: [log({ created_at: at(instant) })] },
    level,
    level === 'none' ? [] : ['101'],
  );
});
it.each<[ConfigValue | undefined, number]>([
  [24, 24],
  [1, 1],
  [360, 360],
  ['24', 360],
  [0, 360],
  [1.5, 360],
  [-1, 360],
  [Number.MAX_SAFE_INTEGER + 1, 360],
  [undefined, 360],
  [null, 360],
  [true, 360],
])('[AC-B1-10c#13] 配置正安全整数或缺省：%s → %s', async (setting, expected) => {
  const config: ContentReader = {
    appVersion: async () => null,
    minSupportedVersion: async () => null,
    configValue: vi.fn(async () => (setting === undefined ? null : { value: setting, version: 1 })),
  };
  expect(await value(() => readClaimEvidenceWindow(config, 'app-1'))).toBe(expected);
  expect(config.configValue).toHaveBeenCalledWith('app-1', 'attr.backfill_window_hours');
});
it('[AC-B1-10c#14] 配置读取失败使用360小时', async () => {
  const config: ContentReader = {
    appVersion: async () => null,
    minSupportedVersion: async () => null,
    configValue: async () => {
      throw new Error('synthetic config outage');
    },
  };
  expect(await value(() => readClaimEvidenceWindow(config, 'app-1'))).toBe(360);
});
