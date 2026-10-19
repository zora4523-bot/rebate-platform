import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { readExportStoreConfig } from '../../../../apps/api/src/modules/platform/config/export-store.ts';
import { BASE_URL, SIGNING_KEY, configEnv } from './kit.ts';

it.each(['local', 'test', 'staging', 'prod'] as const)(
  '[AC-B1-34d#12] %s 通过 loadConfig 下发导出地址与签名密钥',
  (appEnv) => {
    const env = {
      ...configEnv(appEnv),
      EXPORT_STORE_BASE_URL: BASE_URL,
      EXPORT_STORE_SIGNING_KEY: SIGNING_KEY,
    };
    expect(readExportStoreConfig(appEnv, env)).toEqual({
      exportStoreBaseUrl: BASE_URL,
      exportStoreSigningKey: SIGNING_KEY,
      problems: [],
    });
    expect(loadConfig(env)).toHaveProperty('exportStoreBaseUrl', BASE_URL);
    expect(loadConfig(env)).toHaveProperty('exportStoreSigningKey', SIGNING_KEY);
  },
);

it.each(['local', 'test'] as const)(
  '[AC-B1-34d#13] %s 缺省或空配置使用保留域名和本地签名密钥',
  (appEnv) => {
    for (const missing of [undefined, '']) {
      const env = {
        ...configEnv(appEnv),
        EXPORT_STORE_BASE_URL: missing,
        EXPORT_STORE_SIGNING_KEY: missing,
      };
      const parsed = readExportStoreConfig(appEnv, env);
      expect(parsed.problems).toEqual([]);
      expect(parsed.exportStoreBaseUrl).toBe('https://exports.local.invalid');
      expect(parsed.exportStoreSigningKey).toEqual(expect.any(String));
      expect(parsed.exportStoreSigningKey?.length).toBeGreaterThan(0);
      expect(loadConfig(env)).toHaveProperty('exportStoreBaseUrl', parsed.exportStoreBaseUrl);
      expect(loadConfig(env)).toHaveProperty('exportStoreSigningKey', parsed.exportStoreSigningKey);
    }
  },
);

it.each(['staging', 'prod'] as const)(
  '[AC-B1-34d#14] %s 缺省或空配置不阻断启动且不带入本地替身默认值',
  (appEnv) => {
    for (const missing of [undefined, '']) {
      const env = {
        ...configEnv(appEnv),
        EXPORT_STORE_BASE_URL: missing,
        EXPORT_STORE_SIGNING_KEY: missing,
      };
      expect(readExportStoreConfig(appEnv, env)).toEqual({
        exportStoreBaseUrl: undefined,
        exportStoreSigningKey: undefined,
        problems: [],
      });
      expect(loadConfig(env)).toHaveProperty('exportStoreBaseUrl', undefined);
      expect(loadConfig(env)).toHaveProperty('exportStoreSigningKey', undefined);
    }
  },
);

it.each([
  'http://exports.invalid',
  '/exports',
  '//exports.invalid',
  'not a URL',
  'https://',
  'https://user:private-config-marker@exports.invalid',
  `${BASE_URL}?secret=private-config-marker`,
  `${BASE_URL}#private-config-marker`,
  `${BASE_URL}?`,
  `${BASE_URL}#`,
  `${BASE_URL}\n`,
  'https://exports.invalid\\private',
])('[AC-B1-34d#15] 拒绝非法导出地址 %j，配置错误不包含原始值或密钥', (baseUrl) => {
  const env = {
    ...configEnv('test'),
    EXPORT_STORE_BASE_URL: baseUrl,
    EXPORT_STORE_SIGNING_KEY: SIGNING_KEY,
  };
  const parsed = readExportStoreConfig('test', env);
  expect(parsed.problems).toEqual(
    expect.arrayContaining([expect.stringContaining('EXPORT_STORE_BASE_URL')]),
  );
  expect(parsed.problems.join(' ')).not.toContain('private-config-marker');
  expect(parsed.problems.join(' ')).not.toContain(SIGNING_KEY);
  expect(() => loadConfig(env)).toThrow(ConfigError);
});
