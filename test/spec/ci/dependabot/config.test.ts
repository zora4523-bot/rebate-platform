import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  MAX_OPEN_PULL_REQUESTS,
  MINUTES_PER_DAY,
  RELEASE_AGE_DAYS,
  WEEKDAYS,
  dependabot,
  list,
  npmUpdate,
  record,
  rootUrl,
  yaml,
} from './kit.ts';

it('[CT-23#1] 配置为 version 2，updates 恰有一项 npm 生态、根目录（pnpm 工作区由根锁文件覆盖）', () => {
  const config = dependabot();
  expect(config['version']).toBe(2);
  const update = npmUpdate();
  expect(update['package-ecosystem']).toBe('npm');
  expect(update['directory']).toBe('/');
  expect(update['directories'], '只用根目录一项，不按子包拆').toBeUndefined();
  const second = rootUrl('.github/dependabot.yaml');
  expect(existsSync(second), '只保留一份 dependabot 配置').toBe(false);
});

it('[CT-23#2] 每周一批：schedule.interval 为 weekly，可带固定星期 / 时刻 / Asia/Shanghai 时区', () => {
  const schedule = record(npmUpdate()['schedule'], 'schedule');
  expect(schedule['interval']).toBe('weekly');
  const extra = Object.keys(schedule).filter(
    (key) => !['interval', 'day', 'time', 'timezone'].includes(key),
  );
  expect(extra).toEqual([]);
  if (schedule['day'] !== undefined) expect(WEEKDAYS).toContain(schedule['day']);
  if (schedule['time'] !== undefined) {
    expect(schedule['time']).toMatch(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
  }
  if (schedule['timezone'] !== undefined) expect(schedule['timezone']).toBe('Asia/Shanghai');
});

it('[CT-23#3] cooldown.default-days 为 7，对齐 ADR-0001 §2 与 pnpm-workspace.yaml 的 minimumReleaseAge', () => {
  const cooldown = record(npmUpdate()['cooldown'], 'cooldown');
  expect(cooldown['default-days']).toBe(RELEASE_AGE_DAYS);
  const workspace = record(yaml('pnpm-workspace.yaml'), 'pnpm-workspace.yaml');
  expect(workspace['minimumReleaseAge']).toBe(RELEASE_AGE_DAYS * MINUTES_PER_DAY);
});

it('[CT-23#4] semver-major / minor / patch 的 cooldown 不小于 7 天，且不给任何包开豁免', () => {
  const cooldown = record(npmUpdate()['cooldown'], 'cooldown');
  const allowed = [
    'default-days',
    'semver-major-days',
    'semver-minor-days',
    'semver-patch-days',
    'include',
  ];
  const extra = Object.keys(cooldown).filter((key) => !allowed.includes(key));
  expect(extra, 'cooldown 不得有 exclude 等豁免').toEqual([]);
  for (const key of ['semver-major-days', 'semver-minor-days', 'semver-patch-days']) {
    const days = cooldown[key];
    if (days === undefined) continue;
    expect(Number.isInteger(days), `${key} 应为整数`).toBe(true);
    expect(days as number, key).toBeGreaterThanOrEqual(RELEASE_AGE_DAYS);
  }
  if (cooldown['include'] !== undefined) {
    const include = list(cooldown['include'], 'cooldown.include');
    expect(include, 'cooldown 须覆盖全部依赖').toEqual(['*']);
  }
});

it('[CT-23#5] 小版本与补丁合并为一组（update-types 只含 minor、patch），主版本不进任何分组', () => {
  const groups = record(npmUpdate()['groups'], 'groups');
  const entries = Object.entries(groups).map(
    ([name, value]) => [name, record(value, `groups.${name}`)] as const,
  );
  expect(entries.length, '至少有一个分组').toBeGreaterThan(0);
  for (const [name, group] of entries) {
    const types = list(group['update-types'], `groups.${name}.update-types`);
    expect(types, `groups.${name} 不得收主版本`).not.toContain('major');
    if (group['applies-to'] !== undefined) expect(group['applies-to']).toBe('version-updates');
  }
  const minorPatch = entries.filter(([, group]) => {
    const types = group['update-types'];
    return Array.isArray(types) && [...types].sort().join(',') === 'minor,patch';
  });
  expect(
    minorPatch.map(([name]) => name),
    '恰有一个 minor + patch 分组',
  ).toHaveLength(1);
  const [name, group] = minorPatch[0]!;
  if (group['patterns'] !== undefined) {
    const patterns = list(group['patterns'], `groups.${name}.patterns`);
    expect(patterns, '该组覆盖全部依赖').toEqual(['*']);
  }
  expect(group['exclude-patterns'], '该组不得排除依赖').toBeUndefined();
});

it('[CT-23#6] open-pull-requests-limit 显式写出且有界（1 ≤ n ≤ 10）', () => {
  const limit = npmUpdate()['open-pull-requests-limit'];
  expect(Number.isInteger(limit), 'open-pull-requests-limit 应为整数').toBe(true);
  expect(limit as number).toBeGreaterThanOrEqual(1);
  expect(limit as number).toBeLessThanOrEqual(MAX_OPEN_PULL_REQUESTS);
});
