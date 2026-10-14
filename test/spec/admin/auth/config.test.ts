import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';

function problems(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}
function cloud(appEnv: 'staging' | 'prod'): Record<string, string> {
  // loadConfig is pure: these paths are never opened, and there is no KMS/network request.
  return {
    APP_ENV: appEnv,
    FIELD_KEY_PROVIDER: 'kms',
    FIELD_KEYRING_FILE: '/not-opened/keyring.json',
    ADMIN_TOKEN_SIGNING_KEY: randomBytes(32).toString('base64url'),
    ADMIN_IP_ALLOWLIST: '192.0.2.0/24',
    ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
  };
}

it.each(['staging', 'prod'] as const)(
  '[AC-F1-06k#28] %s 缺后台签名密钥或白名单各自拒绝配置，错误指出具体配置名',
  (appEnv) => {
    const valid = cloud(appEnv);
    expect(() => loadConfig(valid)).not.toThrow();
    for (const field of ['ADMIN_TOKEN_SIGNING_KEY', 'ADMIN_IP_ALLOWLIST']) {
      for (const missing of ['', undefined]) {
        const env = { ...valid };
        if (missing === undefined) delete env[field];
        else env[field] = missing;
        const errors = problems(env);
        expect(errors.some((message) => message.includes(field))).toBe(true);
        expect(errors.join(' ')).not.toContain(valid['ADMIN_TOKEN_SIGNING_KEY']);
      }
    }
  },
);

it('[AC-F1-06k#29] 白名单允许五十条 IP/CIDR，五十一条拒绝启动', () => {
  const values = Array.from({ length: 51 }, (_, i) => `192.0.2.${String(i + 1)}`);
  expect(() =>
    loadConfig({ APP_ENV: 'test', ADMIN_IP_ALLOWLIST: values.slice(0, 50).join(',') }),
  ).not.toThrow();
  expect(
    problems({ APP_ENV: 'test', ADMIN_IP_ALLOWLIST: values.join(',') }).some((p) =>
      p.includes('ADMIN_IP_ALLOWLIST'),
    ),
  ).toBe(true);
});

it.each(['garbage', '192.0.2.256', '192.0.2.0/33', '2001:db8::/129', 'https://192.0.2.1'])(
  '[AC-F1-06k#30] 拒绝无效白名单 %s',
  (value) => {
    expect(
      problems({ APP_ENV: 'test', ADMIN_IP_ALLOWLIST: value }).some((p) =>
        p.includes('ADMIN_IP_ALLOWLIST'),
      ),
    ).toBe(true);
  },
);

it('[AC-F1-06k#31] 后台签名密钥必须是 base64url 且至少三十二字节，拒绝时不输出密钥', () => {
  for (const size of [32, 64])
    expect(() =>
      loadConfig({
        APP_ENV: 'test',
        ADMIN_TOKEN_SIGNING_KEY: randomBytes(size).toString('base64url'),
      }),
    ).not.toThrow();
  for (const value of [
    randomBytes(31).toString('base64url'),
    `${randomBytes(32).toString('base64url')}!`,
  ]) {
    const errors = problems({ APP_ENV: 'test', ADMIN_TOKEN_SIGNING_KEY: value });
    expect(errors.some((p) => p.includes('ADMIN_TOKEN_SIGNING_KEY'))).toBe(true);
    expect(errors.join(' ')).not.toContain(value);
  }
});

it.each([
  '*',
  'https://*.example.invalid',
  'https://admin.example.invalid/path',
  'https://admin.example.invalid?x=1',
])('[AC-F1-06k#32] CORS 必须是确切来源，拒绝 %s', (value) => {
  expect(
    problems({ APP_ENV: 'test', ADMIN_CORS_ORIGIN: value }).some((p) =>
      p.includes('ADMIN_CORS_ORIGIN'),
    ),
  ).toBe(true);
});
