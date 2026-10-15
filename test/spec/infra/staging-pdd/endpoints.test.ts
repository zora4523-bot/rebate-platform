import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  UnionError,
  type UnionEndpoint,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  PLATFORMS,
  VARIABLE,
  configured,
  demoEndpoints,
  endpointFactory,
  environment,
  outcome,
  root,
  withDirectory,
  writeEndpoints,
} from './kit.ts';

it('[AC-B1-04y-ENDPOINTS#1] 覆盖目录的三个 demo 端点被实际读取，缺省仍读镜像目录且注册表注入不变', async () => {
  await withDirectory(async (directory) => {
    await writeEndpoints(directory);
    const start = await endpointFactory();
    const expected = demoEndpoints();
    const loaded = await outcome(() => start(configured(directory)));
    expect(loaded).toEqual(expected);
    const packaged = await Promise.all(
      PLATFORMS.map(async (platform) =>
        JSON.parse(await readFile(join(root, `config/union-endpoints/${platform}.json`), 'utf8')),
      ),
    );
    expect(packaged).toEqual(
      PLATFORMS.map((platform) => ({
        platform,
        mode: 'demo',
        baseUrl: null,
        quotaKey: expect.any(String),
      })),
    );
    for (const absent of [undefined, '']) {
      const fallback = await outcome(() =>
        start(loadConfig({ ...environment('staging'), [VARIABLE]: absent })),
      );
      expect(fallback).toEqual(packaged);
    }
  });
});

it('[AC-B1-04y-ENDPOINTS#2] 两个配置各读自己的目录，不缓存首个目录或合并镜像端点', async () => {
  await withDirectory(async (directory) => {
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    const other = demoEndpoints().map((endpoint) => ({
      ...endpoint,
      quotaKey: `synthetic-other:${endpoint.platform}`,
    }));
    await writeEndpoints(first);
    await writeEndpoints(second, other);
    const start = await endpointFactory();
    const a = await outcome(() => start(configured(first)));
    const b = await outcome(() => start(configured(second)));
    expect(a).toEqual(demoEndpoints());
    expect(b).toEqual(other);
  });
});

it('[AC-B1-04y-ENDPOINTS#3] loadConfig 接受缺目录，但联盟启动必须失败，不能静默退回镜像 demo', async () => {
  await withDirectory(async (directory) => {
    const start = await endpointFactory();
    const config = await outcome(() => configured(join(directory, 'absent')));
    expect(config).not.toBeInstanceOf(Error);
    const result = await start(config as ReturnType<typeof loadConfig>);
    expect(result).toBeInstanceOf(UnionError);
    expect(result).toMatchObject({ code: 'invalid_endpoint' });
  });
});

const invalidCases = [
  'missing',
  'bad-json',
  'wrong-platform',
  'bad-mode',
  'bad-url',
  'extra-key',
] as const;

it.each(PLATFORMS.flatMap((platform) => invalidCases.map((kind) => ({ platform, kind }))))(
  '[AC-B1-04y-ENDPOINTS#4] 覆盖目录 $platform 的 $kind 必须通过同样的端点校验',
  async ({ platform, kind }) => {
    await withDirectory(async (directory) => {
      await writeEndpoints(directory);
      const path = join(directory, `${platform}.json`);
      const valid = demoEndpoints().find((endpoint) => endpoint.platform === platform)!;
      if (kind === 'missing') await rm(path);
      else if (kind === 'bad-json') await writeFile(path, '{synthetic-broken');
      else {
        const changes = {
          'wrong-platform': { platform: platform === 'jd' ? 'pdd' : 'jd' },
          'bad-mode': { mode: 'unknown' },
          'bad-url': { mode: 'live', baseUrl: 'http://synthetic.invalid/router' },
          'extra-key': { unsupported: 'synthetic-extra' },
        };
        await writeFile(path, JSON.stringify({ ...valid, ...changes[kind] }));
      }
      const start = await endpointFactory();
      const result = await outcome(() => start(configured(directory)));
      expect(result).toBeInstanceOf(UnionError);
      expect(result).toMatchObject({ code: 'invalid_endpoint' });
    });
  },
);

it.each(['demo', 'replay'] as const)(
  '[AC-B1-04y-ENDPOINTS#5] staging 覆盖读取 %s 不绕过校验，prod 原目录入口仍拒绝该模式',
  async (mode) => {
    await withDirectory(async (directory) => {
      const endpoints: readonly UnionEndpoint[] = demoEndpoints().map((endpoint) => ({
        ...endpoint,
        mode,
        baseUrl: mode === 'demo' ? null : 'https://synthetic.invalid/replay',
      }));
      await writeEndpoints(directory, endpoints);
      const staging = await endpointFactory();
      const loaded = await outcome(() => staging(configured(directory)));
      expect(loaded).toEqual(endpoints);
      // No override env in prod: keep the existing explicit-directory factory seam.
      const prod = await endpointFactory(directory);
      const rejected = await outcome(() => prod(loadConfig(environment('prod'))));
      expect(rejected).toBeInstanceOf(UnionError);
      expect(rejected).toMatchObject({ code: 'unsafe_mode' });
    });
  },
);
