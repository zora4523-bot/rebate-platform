// B1-01zzh brief B.1: METRICS_PORT (optional, integer 1024–65535; unset = no /metrics) and
// METRICS_HOST (optional, default 127.0.0.1) are read only through loadConfig, from the object it
// is given, into `metrics: { port, host } | undefined`. Invalid values refuse startup like the other
// port variables: one ConfigError naming the variable.
import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';

type Env = Readonly<Record<string, string | undefined>>;

function metricsOf(env: Env): unknown {
  return (loadConfig(env) as { metrics?: unknown }).metrics;
}

function problemsOf(env: Env): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  expect.unreachable(`loadConfig accepted ${JSON.stringify(env)}`);
}

it('[AC-B1-01zzh#1] METRICS_PORT 设了才有 metrics：host 缺省 127.0.0.1、可由 METRICS_HOST 改；未设或空串没有 metrics', () => {
  expect(metricsOf({ APP_ENV: 'test', METRICS_PORT: '9464' })).toEqual({
    port: 9464,
    host: '127.0.0.1',
  });
  expect(metricsOf({ APP_ENV: 'test', METRICS_PORT: '9464', METRICS_HOST: '' })).toEqual({
    port: 9464,
    host: '127.0.0.1',
  });
  expect(metricsOf({ APP_ENV: 'local', METRICS_PORT: '1024', METRICS_HOST: '10.0.3.7' })).toEqual({
    port: 1024,
    host: '10.0.3.7',
  });
  expect(metricsOf({ APP_ENV: 'local', METRICS_PORT: '65535' })).toEqual({
    port: 65535,
    host: '127.0.0.1',
  });
  for (const env of [
    { APP_ENV: 'test' },
    { APP_ENV: 'test', METRICS_PORT: '' },
    // A host alone opens nothing: the port is the switch.
    { APP_ENV: 'test', METRICS_HOST: '10.0.3.7' },
  ]) {
    expect(metricsOf(env), JSON.stringify(env)).toBeUndefined();
  }
});

it('[AC-B1-01zzh#2] 非法 METRICS_PORT 启动即拒：ConfigError 点名该变量，其他配置问题照常一并列出', () => {
  for (const value of ['0', '80', '1023', '65536', '99999', 'abc', '9464.5', '-9464', '9464 ']) {
    const problems = problemsOf({ APP_ENV: 'test', METRICS_PORT: value });
    expect(
      problems.some((problem) => problem.startsWith('METRICS_PORT')),
      `METRICS_PORT=${JSON.stringify(value)}: ${JSON.stringify(problems)}`,
    ).toBe(true);
  }
  // Same as API_PORT: listed together with the problems of an invalid environment name.
  const problems = problemsOf({ APP_ENV: 'bogus', METRICS_PORT: '80' });
  expect(problems.some((problem) => problem.startsWith('APP_ENV'))).toBe(true);
  expect(problems.some((problem) => problem.startsWith('METRICS_PORT'))).toBe(true);
});
