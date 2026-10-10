import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { BASE_URL, configEnv } from './kit.ts';

function problems(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}

it.each(['local', 'test'] as const)(
  '[AC-F1-06z#2] %s 未设置媒体地址时使用保留域名默认值',
  (appEnv) => {
    for (const missing of [undefined, '']) {
      expect(loadConfig({ ...configEnv(appEnv), MEDIA_PUBLIC_BASE_URL: missing })).toHaveProperty(
        'mediaPublicBaseUrl',
        'https://media.local.invalid',
      );
    }
  },
);

it.each(['local', 'test', 'staging', 'prod'] as const)(
  '[AC-F1-06z#3] %s 通过 loadConfig 下发合法 https 媒体地址',
  (appEnv) => {
    for (const url of [BASE_URL, `${BASE_URL}/`, 'https://media.example.invalid:8443/assets']) {
      expect(loadConfig({ ...configEnv(appEnv), MEDIA_PUBLIC_BASE_URL: url })).toHaveProperty(
        'mediaPublicBaseUrl',
        url,
      );
    }
  },
);

it.each(['local', 'test', 'staging', 'prod'] as const)(
  '[AC-F1-06z#4] %s 拒绝非 https、相对地址、查询和片段',
  (appEnv) => {
    for (const invalid of [
      'http://media.example.invalid',
      '/media',
      '//media.example.invalid/media',
      'not-a-url',
      'https://',
      `${BASE_URL}?version=1`,
      `${BASE_URL}#icon`,
      `${BASE_URL}?`,
      `${BASE_URL}#`,
    ]) {
      expect(problems({ ...configEnv(appEnv), MEDIA_PUBLIC_BASE_URL: invalid }), invalid).toEqual(
        expect.arrayContaining([expect.stringContaining('MEDIA_PUBLIC_BASE_URL')]),
      );
    }
  },
);

it.each(['staging', 'prod'] as const)(
  '[AC-F1-06z#5] %s 缺少媒体地址时配置拒绝启动（空串同未设置）',
  (appEnv) => {
    for (const missing of [undefined, '']) {
      expect(problems({ ...configEnv(appEnv), MEDIA_PUBLIC_BASE_URL: missing })).toEqual(
        expect.arrayContaining([expect.stringContaining('MEDIA_PUBLIC_BASE_URL')]),
      );
    }
  },
);
