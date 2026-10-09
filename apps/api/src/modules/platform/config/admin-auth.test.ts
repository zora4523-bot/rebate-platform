import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

it('[AC-F1-06k] no ADMIN_* variable: adminAuth is null in every environment and nothing is refused here', () => {
  expect(loadConfig({ APP_ENV: 'test' }).adminAuth).toBeNull();
  expect(
    loadConfig({ APP_ENV: 'staging', FIELD_KEY_PROVIDER: 'kms', FIELD_KEYRING_FILE: '/k.json' })
      .adminAuth,
  ).toBeNull();
});

it('[AC-F1-06k] parses the key, the whitelist and the origin', () => {
  const key = randomBytes(40);
  const config = loadConfig({
    APP_ENV: 'local',
    ADMIN_TOKEN_SIGNING_KEY: key.toString('base64url'),
    ADMIN_IP_ALLOWLIST: ' 192.0.2.0/24 , 2001:db8::1 ',
    ADMIN_CORS_ORIGIN: 'http://localhost:5173',
  });
  expect(config.adminAuth).toEqual({
    tokenSigningKey: new Uint8Array(key),
    ipAllowlist: ['192.0.2.0/24', '2001:db8::1'],
    corsOrigin: 'http://localhost:5173',
  });
});

it('[AC-F1-06k] staging with one ADMIN_* variable set names the missing key and whitelist', () => {
  const problems = problemsOf({
    APP_ENV: 'staging',
    FIELD_KEY_PROVIDER: 'kms',
    FIELD_KEYRING_FILE: '/k.json',
    ADMIN_CORS_ORIGIN: 'https://console.example.invalid',
  });
  expect(problems).toEqual([
    'ADMIN_TOKEN_SIGNING_KEY: must be set when APP_ENV=staging',
    'ADMIN_IP_ALLOWLIST: must be set when APP_ENV=staging',
  ]);
});

it('[AC-F1-06k] rejects catch-all ranges, zone ids, empty items and bad origins without echoing them', () => {
  for (const value of ['0.0.0.0/0', '::/0', 'fe80::1%eth0', '192.0.2.1,,192.0.2.2']) {
    const problems = problemsOf({ APP_ENV: 'test', ADMIN_IP_ALLOWLIST: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.startsWith('ADMIN_IP_ALLOWLIST:')).toBe(true);
    expect(problems.join(' ')).not.toContain(value);
  }
  for (const value of ['https://console.example.invalid/', 'ftp://console.example.invalid']) {
    expect(problemsOf({ APP_ENV: 'test', ADMIN_CORS_ORIGIN: value })).toEqual([
      expect.stringMatching(/^ADMIN_CORS_ORIGIN: /),
    ]);
  }
});
