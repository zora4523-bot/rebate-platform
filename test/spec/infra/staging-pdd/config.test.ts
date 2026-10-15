import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import { VARIABLE, environment, outcome, withDirectory, type OverrideConfig } from './kit.ts';

it('[AC-B1-04y-CONFIG#1] staging 保留绝对路径，不检查目录或端点文件是否存在', async () => {
  await withDirectory(async (directory) => {
    const regularFile = join(directory, 'ordinary-file');
    await writeFile(regularFile, 'synthetic non-directory');
    // stream/admin share staging.env but have no mount; only the union factory opens files.
    for (const path of [join(directory, 'missing', '端点 目录'), directory, regularFile]) {
      const result = await outcome(() =>
        loadConfig({ ...environment('staging'), [VARIABLE]: path }),
      );
      expect(result).not.toBeInstanceOf(Error);
      expect((result as OverrideConfig).unionEndpointOverrideDir).toBe(path);
    }
  });
});

it.each(['local', 'test', 'prod'] as const)(
  '[AC-B1-04y-CONFIG#2] %s 设置覆盖目录即拒绝，未设置或空字符串保持可选',
  async (appEnv) => {
    for (const absent of [undefined, '']) {
      const result = await outcome(() =>
        loadConfig({ ...environment(appEnv), [VARIABLE]: absent }),
      );
      expect(result).not.toBeInstanceOf(Error);
      expect((result as OverrideConfig).unionEndpointOverrideDir ?? null).toBeNull();
    }
    const result = await outcome(() =>
      loadConfig({ ...environment(appEnv), [VARIABLE]: '/run/couli-pdd/union-endpoints' }),
    );
    expect(result).toBeInstanceOf(ConfigError);
    expect((result as ConfigError).problems.length).toBeGreaterThan(0);
    expect((result as ConfigError).problems.every((problem) => problem.startsWith(VARIABLE))).toBe(
      true,
    );
  },
);

it.each(['relative/endpoints', './endpoints', '../endpoints', '~/endpoints', '   '])(
  '[AC-B1-04y-CONFIG#3] staging 拒绝非绝对路径 %j',
  async (path) => {
    const result = await outcome(() => loadConfig({ ...environment('staging'), [VARIABLE]: path }));
    expect(result).toBeInstanceOf(ConfigError);
    expect((result as ConfigError).problems.length).toBeGreaterThan(0);
    expect((result as ConfigError).problems.every((problem) => problem.startsWith(VARIABLE))).toBe(
      true,
    );
  },
);

it('[AC-B1-04y-CONFIG#4] 其他字段出错仍汇总覆盖目录问题；未设值不增添问题项', async () => {
  const base = { ...environment('staging'), API_PORT: 'invalid' };
  const baseline = await outcome(() => loadConfig(base));
  expect(baseline).toBeInstanceOf(ConfigError);
  for (const absent of [undefined, '']) {
    const result = await outcome(() => loadConfig({ ...base, [VARIABLE]: absent }));
    expect(result).toBeInstanceOf(ConfigError);
    expect((result as ConfigError).problems).toEqual((baseline as ConfigError).problems);
  }
  const invalid = await outcome(() => loadConfig({ ...base, [VARIABLE]: 'relative/endpoints' }));
  expect(invalid).toBeInstanceOf(ConfigError);
  const problems = (invalid as ConfigError).problems;
  expect(problems.filter((problem) => !problem.startsWith(VARIABLE))).toEqual(
    (baseline as ConfigError).problems,
  );
  expect(problems.some((problem) => problem.startsWith(VARIABLE))).toBe(true);
});
