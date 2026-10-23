import { expect, it, vi } from 'vitest';
import { loadConfig, ConfigError } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  looksLikeRealCredentialEnvName,
  readAgentReviewCredentials,
} from '../../../../apps/api/src/modules/platform/config/credential-env.ts';
import { credentials } from './kit.ts';

const names = ['AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID', 'AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET'];

it.each(names)('[AC-B3-03m#1] %s 是真实凭据名，本地及测试启动拒绝且不泄漏值', (name) => {
  expect(looksLikeRealCredentialEnvName(name)).toBe(true);
  expect(looksLikeRealCredentialEnvName(name.toLowerCase())).toBe(true);
  expect(looksLikeRealCredentialEnvName(`${name}_OTHER`)).toBe(false);
  for (const appEnv of ['local', 'test']) {
    let error: unknown;
    try {
      loadConfig({ APP_ENV: appEnv, [name]: 'synthetic-value-must-not-leak' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain(name);
    expect(String(error)).not.toContain('synthetic-value-must-not-leak');
  }
});

it.each(['local', 'test'] as const)('[AC-B3-03m#2] %s 凭据工厂连凭据值都不读取', (appEnv) => {
  const read = vi.fn(() => 'synthetic-forbidden');
  const env: Record<string, string | undefined> = {};
  for (const name of names) Object.defineProperty(env, name, { get: read, enumerable: true });
  expect(readAgentReviewCredentials(appEnv, env)).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it.each(['staging', 'prod'] as const)('[AC-B3-03m#3] %s 只接受完整非空凭据对', (appEnv) => {
  const env = {
    AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID: credentials.accessKeyId,
    AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET: credentials.accessKeySecret,
  };
  expect(readAgentReviewCredentials(appEnv, env)).toEqual(credentials);
  for (const name of names) {
    for (const value of [undefined, '', '   ']) {
      expect(readAgentReviewCredentials(appEnv, { ...env, [name]: value })).toBeUndefined();
    }
  }
  expect(readAgentReviewCredentials(appEnv, {})).toBeUndefined();
});
