import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

it('[AC-B1-01zzg-UNIT#1] COULI_DEPLOY_VERSION 接受镜像 tag 原样保留；未设时配置里没有该键', () => {
  for (const tag of ['20261023-a1b2c3d', 'v1.2.3', 'release_7', 'x'.repeat(128)]) {
    expect(loadConfig({ APP_ENV: 'test', COULI_DEPLOY_VERSION: tag }).deployVersion).toBe(tag);
  }
  expect(Object.hasOwn(loadConfig({ APP_ENV: 'test' }), 'deployVersion')).toBe(false);
});

it('[AC-B1-01zzg-UNIT#2] 不是镜像 tag 的取值拒绝启动，问题只报变量名不带取值', () => {
  for (const tag of ['-leading-dash', '.dot', 'has space', 'a/b', 'x'.repeat(129), 'tag\nnext']) {
    let caught: unknown;
    try {
      loadConfig({ APP_ENV: 'test', COULI_DEPLOY_VERSION: tag });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const problems = (caught as ConfigError).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^COULI_DEPLOY_VERSION: /);
    expect(problems[0]).not.toContain(tag);
  }
});
