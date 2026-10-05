import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  loadUnionEndpoints,
  parseUnionEndpoints,
} from '../../../../apps/api/src/modules/union/index.ts';
import { endpoint, errorCode, platforms } from './kit.ts';

it('[AC-B1-04b-CONFIG#1] 读取按平台拆分的三个仓库配置，初始 demo 且无真实端点', async () => {
  const directory = fileURLToPath(new URL('../../../../config/union-endpoints/', import.meta.url));
  const configs = await loadUnionEndpoints(directory, 'test');
  expect(configs.map((value) => value.platform).sort()).toEqual(['jd', 'pdd', 'taobao']);
  for (const value of configs) {
    expect(value).toMatchObject({ mode: 'demo', baseUrl: null });
    expect(value.quotaKey.trim().length).toBeGreaterThan(0);
  }
});

it('[AC-B1-04b-CONFIG#2] 每个平台独立读取文件中的 mode、baseUrl 与配额键', async () => {
  const scratch = fileURLToPath(new URL('../../../../.tmp/union-skeleton/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'endpoints-'));
  const configs = platforms.map((platform) => ({
    ...endpoint(platform),
    quotaKey: `appkey:${platform}`,
  }));
  try {
    await Promise.all(
      configs.map((value) =>
        writeFile(join(directory, `${value.platform}.json`), JSON.stringify(value)),
      ),
    );
    expect(await loadUnionEndpoints(directory, 'test')).toEqual(expect.arrayContaining(configs));
    // A valid JSON object in the wrong platform file must not silently change the registry.
    await writeFile(join(directory, 'jd.json'), JSON.stringify(endpoint('pdd')));
    await expect(loadUnionEndpoints(directory, 'test')).rejects.toMatchObject({
      code: 'invalid_endpoint',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['demo', 'replay'] as const)(
  '[AC-B1-04b-CONFIG#3] prod 中任意平台为 %s 即拒绝整组启动',
  (mode) => {
    for (const platform of platforms) {
      const configs = platforms.map((p) => ({
        ...endpoint(p),
        mode: p === platform ? mode : 'live',
        baseUrl: mode === 'demo' && p === platform ? null : 'https://example.invalid/union',
      }));
      expect(errorCode(() => parseUnionEndpoints(configs, 'prod'))).toBe('unsafe_mode');
    }
  },
);

it('[AC-B1-04b-CONFIG#4] prod 允许完整 live 配置；校验本身不发起平台调用', () => {
  const configs = platforms.map((p) => ({
    ...endpoint(p),
    mode: 'live',
    baseUrl: `https://example.invalid/${p}`,
  }));
  expect(parseUnionEndpoints(configs, 'prod')).toEqual(configs);
});

it.each(['local', 'test', 'staging'] as const)(
  '[AC-B1-04b-CONFIG#5] %s 允许 demo 与显式 WireMock replay',
  (environment) => {
    for (const mode of ['demo', 'replay'] as const) {
      const configs = platforms.map((p) => ({
        ...endpoint(p),
        mode,
        baseUrl: mode === 'demo' ? null : endpoint(p).baseUrl,
      }));
      expect(parseUnionEndpoints(configs, environment)).toEqual(configs);
    }
  },
);

it.each([
  { mode: 'unknown' },
  { quotaKey: '' },
  { quotaKey: '  ' },
  { mode: 'replay', baseUrl: null },
  { mode: 'live', baseUrl: null },
  { baseUrl: 'not-a-url' },
  { baseUrl: 'file:///private/endpoint' },
  { platform: 'unknown' },
])('[AC-B1-04b-CONFIG#6] 非法配置 %j 明确拒绝', (override) => {
  expect(
    errorCode(() =>
      parseUnionEndpoints(
        [{ ...endpoint('jd'), ...override }, endpoint('pdd'), endpoint('taobao')],
        'test',
      ),
    ),
  ).toBe('invalid_endpoint');
});

it.each([null, {}, [], [endpoint('jd')], [endpoint('jd'), endpoint('jd'), endpoint('taobao')]])(
  '[AC-B1-04b-CONFIG#7] 拒绝配置缺失、类型错误或平台重复',
  (configs) => {
    expect(errorCode(() => parseUnionEndpoints(configs, 'test'))).toBe('invalid_endpoint');
  },
);
