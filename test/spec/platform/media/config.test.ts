import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  createMediaStore,
  mediaUrlOf,
} from '../../../../apps/api/src/modules/platform/media/index.ts';
import { expectRequestFailure } from './error-response.ts';
import { BASE_URL, SVG, configEnv, digest, memoryLogger } from './kit.ts';

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
      const config = loadConfig({ ...configEnv(appEnv), MEDIA_PUBLIC_BASE_URL: url });
      expect(config.mediaPublicBaseUrl?.replace(/\/+$/, '')).toBe(url.replace(/\/+$/, ''));
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
  '[AC-F1-06z#5] %s 缺少媒体地址仍可加载配置，写入与取地址按请求失败（空串同未设置）',
  async (appEnv) => {
    for (const missing of [undefined, '']) {
      const env = { ...configEnv(appEnv), MEDIA_PUBLIC_BASE_URL: missing };
      expect(problems(env)).toEqual([]);
      const config = loadConfig(env);
      const { logger } = memoryLogger(appEnv);
      const store = createMediaStore(config.appEnv, config.mediaPublicBaseUrl, logger);
      const sha256 = digest(SVG);
      await expectRequestFailure(
        () => store.put({ sha256, bytes: SVG, contentType: 'image/svg+xml' }),
        logger,
      );
      for (const format of ['svg', 'png'] as const) {
        await expectRequestFailure(
          () => mediaUrlOf(config.mediaPublicBaseUrl, sha256, format),
          logger,
        );
      }
    }
  },
);
