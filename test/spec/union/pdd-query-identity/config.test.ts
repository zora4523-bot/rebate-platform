import { expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import { findCredentialLikeEnvNames } from '../../../../apps/api/src/modules/platform/config/credential-env.ts';
import { environment, visible } from '../pdd-live-wiring/kit.ts';
import { CUSTOM, VARIABLE, outcome } from './kit.ts';

type QueryConfig = AppConfig & { readonly pddQueryCustomParameters?: string | null };

it.each(['local', 'test', 'staging', 'prod'] as const)(
  '[AC-B1-04x-CONFIG#1] %s 查询身份是独立的可选非密钥配置，缺失与空字符串不阻止启动',
  async (appEnv) => {
    const value = await outcome(() => loadConfig({ ...environment(appEnv), [VARIABLE]: CUSTOM }));
    expect(value).not.toBeInstanceOf(Error);
    expect((value as QueryConfig).pddQueryCustomParameters).toBe(CUSTOM);
    expect((value as AppConfig).pdd).toBeNull();
    expect(findCredentialLikeEnvNames({ [VARIABLE]: CUSTOM })).toEqual([]);
    for (const absent of [undefined, '']) {
      const missing = await outcome(() =>
        loadConfig({ ...environment(appEnv), [VARIABLE]: absent }),
      );
      expect(missing).not.toBeInstanceOf(Error);
      expect((missing as QueryConfig).pddQueryCustomParameters ?? null).toBeNull();
    }
  },
);

it.each([
  ['空对象', '{}'],
  ['原始空格', CUSTOM],
  ['ASCII 恰好 64 字节', JSON.stringify({ uid: 'a'.repeat(54) })],
  ['UTF-8 恰好 64 字节', JSON.stringify({ uid: '中'.repeat(18) })],
])('[AC-B1-04x-CONFIG#2] 接受 %s 并原样保留 JSON 文本', async (_label, text) => {
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(64);
  const value = await outcome(() => loadConfig({ APP_ENV: 'test', [VARIABLE]: text }));
  expect(value).not.toBeInstanceOf(Error);
  expect((value as QueryConfig).pddQueryCustomParameters).toBe(text);
});

it.each([
  ['坏 JSON', '{synthetic-broken'],
  ['空白', '   '],
  ['数组', '[]'],
  ['null', 'null'],
  ['字符串', '"synthetic-scalar"'],
  ['数字', '7'],
  ['布尔', 'true'],
  ['ASCII 65 字节', JSON.stringify({ uid: 'a'.repeat(55) })],
  ['UTF-8 65 字节', JSON.stringify({ uid: `${'中'.repeat(18)}a` })],
])('[AC-B1-04x-CONFIG#3] 拒绝 %s，问题只含变量名且不回显输入', async (_label, text) => {
  for (const appEnv of ['local', 'test', 'staging', 'prod'] as const) {
    const value = await outcome(() => loadConfig({ ...environment(appEnv), [VARIABLE]: text }));
    expect(value).toBeInstanceOf(ConfigError);
    expect((value as ConfigError).problems).toEqual([VARIABLE]);
    expect((value as Error).cause).toBeUndefined();
    // Short JSON scalars can coincide with generic diagnostic words; use full problem equality above.
    if (text.length > 8) expect(visible(value)).not.toContain(text);
  }
});

it('[AC-B1-04x-CONFIG#4] 其他字段无效时仍汇总查询身份问题且不回显内容', async () => {
  const value = await outcome(() =>
    loadConfig({
      APP_ENV: 'test',
      API_PORT: 'invalid',
      [VARIABLE]: '{synthetic-broken',
    }),
  );
  expect(value).toBeInstanceOf(ConfigError);
  expect((value as ConfigError).problems).toContain(VARIABLE);
  expect((value as ConfigError).problems.some((problem) => problem.startsWith('API_PORT'))).toBe(
    true,
  );
  expect(visible(value)).not.toContain('{synthetic-broken');
});
