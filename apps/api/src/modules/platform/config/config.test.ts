import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('[AC-B1-01f] applies the documented defaults when only APP_ENV is set', () => {
    expect(loadConfig({ APP_ENV: 'local' })).toEqual({
      appEnv: 'local',
      logLevel: 'info',
      clockNow: undefined,
      exitAfterInit: false,
      apiHost: '127.0.0.1',
      apiPort: 3100,
      streamPort: 3101,
      adminPort: 3102,
      keyring: null,
    });
  });

  it('[AC-B1-01f] reads every variable and ignores unrelated ones', () => {
    expect(
      loadConfig({
        APP_ENV: 'staging',
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: '/srv/couli/keyring.json',
        LOG_LEVEL: 'debug',
        CLOCK_NOW: '2026-10-31T23:59:59.999+08:00',
        COULI_EXIT_AFTER_INIT: '1',
        API_HOST: '0.0.0.0',
        API_PORT: '8080',
        STREAM_PORT: '8081',
        ADMIN_PORT: '8082',
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:54329/couli',
        REDIS_URL: 'redis://127.0.0.1:63790',
        PATH: '/usr/bin',
      }),
    ).toEqual({
      appEnv: 'staging',
      logLevel: 'debug',
      clockNow: '2026-10-31T23:59:59.999+08:00',
      exitAfterInit: true,
      apiHost: '0.0.0.0',
      apiPort: 8080,
      streamPort: 8081,
      adminPort: 8082,
      keyring: { provider: 'kms', keyringFile: '/srv/couli/keyring.json' },
    });
  });

  it('[AC-B1-01f] treats empty strings as unset', () => {
    const config = loadConfig({ APP_ENV: 'test', LOG_LEVEL: '', CLOCK_NOW: '', API_PORT: '' });
    expect(config).toMatchObject({ logLevel: 'info', clockNow: undefined, apiPort: 3100 });
  });

  it('[AC-B1-01f] requires APP_ENV', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(problemsOf({})).toHaveLength(1);
    expect(problemsOf({})[0]).toMatch(/^APP_ENV: /);
    expect(problemsOf({ APP_ENV: 'production' })[0]).toMatch(/^APP_ENV: /);
  });

  it('[AC-B1-01f] aggregates every problem into one readable error without echoing values', () => {
    const env = {
      APP_ENV: 'test',
      LOG_LEVEL: 'loud',
      API_PORT: '70000',
      STREAM_PORT: 'http',
      CLOCK_NOW: '2026-10-01 12:00:00',
      DATABASE_URL: 'mysql://user:hunter2@db/couli',
    };
    const problems = problemsOf(env);
    expect(problems.map((problem) => problem.split(':')[0]).sort()).toEqual([
      'API_PORT',
      'CLOCK_NOW',
      'LOG_LEVEL',
      'STREAM_PORT',
    ]);
    let message = '';
    try {
      loadConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Invalid environment configuration:\n- /);
    expect(message).not.toContain('hunter2');
  });

  it.each(['2026-10-01T12:00:00Z', '2026-10-01T12:00:00.123+08:00', '2026-10-01T04:00:00-05:00'])(
    '[AC-B1-01f] accepts CLOCK_NOW=%s outside prod',
    (clockNow) => {
      for (const appEnv of ['local', 'test', 'staging']) {
        expect(
          loadConfig({
            APP_ENV: appEnv,
            CLOCK_NOW: clockNow,
            ...(appEnv === 'staging'
              ? { FIELD_KEY_PROVIDER: 'kms', FIELD_KEYRING_FILE: '/srv/couli/keyring.json' }
              : {}),
          }).clockNow,
        ).toBe(clockNow);
      }
    },
  );

  it.each(['2026-10-01T12:00:00', '2026-10-01', '1790000000000', 'now'])(
    '[AC-B1-01f] rejects CLOCK_NOW=%s (no explicit offset or not ISO-8601)',
    (clockNow) => {
      expect(problemsOf({ APP_ENV: 'test', CLOCK_NOW: clockNow })[0]).toMatch(/^CLOCK_NOW: /);
    },
  );

  it('[AC-B1-01f] refuses to start in prod when CLOCK_NOW is set (ADR-0001 §4.2 #10)', () => {
    expect(problemsOf({ APP_ENV: 'prod', CLOCK_NOW: '2026-10-01T12:00:00Z' })).toEqual([
      'CLOCK_NOW: must not be set when APP_ENV=prod (the production clock is real time)',
      'FIELD_KEY_PROVIDER: must be set when APP_ENV=prod',
    ]);
    // Refused even when the value is malformed: both findings are reported.
    expect(problemsOf({ APP_ENV: 'prod', CLOCK_NOW: 'tomorrow' })).toHaveLength(3);
    expect(
      loadConfig({
        APP_ENV: 'prod',
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: '/srv/couli/keyring.json',
      }).clockNow,
    ).toBeUndefined();
  });

  it.each(['local', 'test'])(
    '[AC-B1-01f] refuses to start in %s when a credential-looking variable is set (规划/11 §8)',
    (appEnv) => {
      const problems = problemsOf({
        APP_ENV: appEnv,
        UNION_TAOBAO_APP_SECRET: 'real-secret-value',
        SMS_ALIYUN_ACCESS_KEY_SECRET: 'another-real-value',
      });
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(
        /^SMS_ALIYUN_ACCESS_KEY_SECRET: looks like a real third-party credential/,
      );
      expect(problems[1]).toMatch(/^UNION_TAOBAO_APP_SECRET: /);
      expect(problems.join('\n')).not.toMatch(/real-secret-value|another-real-value/);
    },
  );

  it.each(['staging', 'prod'])('[AC-B1-01f] allows credential variables in %s', (appEnv) => {
    expect(
      loadConfig({
        APP_ENV: appEnv,
        ALIPAY_PRIVATE_KEY: 'k',
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: '/srv/couli/keyring.json',
      }).appEnv,
    ).toBe(appEnv);
  });

  it('[AC-B1-01f] ignores credential-looking variables that are empty', () => {
    expect(loadConfig({ APP_ENV: 'local', UNION_SECRET: '' }).appEnv).toBe('local');
  });
});
