import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  loadConfig,
  startupViolations,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  findCredentialLikeEnvNames,
  looksLikeRealCredentialEnvName,
} from '../../../../apps/api/src/modules/platform/config/credential-env.ts';
import {
  APP_KEY,
  SECRET,
  configFailure,
  configured,
  environment,
  removeDirectory,
  root,
  temporaryDirectory,
  visible,
} from './kit.ts';

// B3-09j: loadConfig requires AGENT_USER_HASH_KEY when APP_ENV=prod; synthetic test-only value.
const PROD_AGENT_KEY = {
  AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-taobao-live-wiring-config',
};

const names = ['TAOBAO_APP_KEY', 'TAOBAO_APP_SECRET_FILE'] as const;
const FAKE_PATH = '/FAKE_TAOBAO_PATH/secret.txt';

it.each(names)('[AC-B1-04k#1] %s 登记为真实凭据变量并进入 local/test 启动检查', (name) => {
  expect(looksLikeRealCredentialEnvName(name)).toBe(true);
  expect(findCredentialLikeEnvNames({ [name]: 'FAKE_VALUE' })).toContain(name);
  for (const appEnv of ['local', 'test'] as const) {
    expect(startupViolations(appEnv, { [name]: 'FAKE_VALUE' }).join('\n')).toContain(name);
  }
});

it.each([
  { TAOBAO_APP_KEY: APP_KEY },
  { TAOBAO_APP_SECRET_FILE: FAKE_PATH },
  { TAOBAO_APP_KEY: APP_KEY, TAOBAO_APP_SECRET_FILE: FAKE_PATH },
])('[AC-B1-04k#2] local/test 任一或两个变量设置即拒绝启动，问题文本只写变量名：%j', (variables) => {
  for (const appEnv of ['local', 'test'] as const) {
    const error = configFailure({ ...environment(appEnv), ...variables });
    for (const [name, value] of Object.entries(variables)) {
      expect(error.problems.join('\n')).toContain(name);
      expect(visible(error)).not.toContain(value);
    }
  }
});

it.each(names)('[AC-B1-04k#3] staging 只设置 %s 时拒绝，问题文本只写变量名', (name) => {
  const value = name === 'TAOBAO_APP_KEY' ? APP_KEY : FAKE_PATH;
  const error = configFailure({ ...environment('staging'), [name]: value });
  expect(error.problems.join('\n')).toContain('TAOBAO_APP');
  expect(visible(error)).not.toContain(value);
});

it.each([undefined, 'kms', 'local'] as const)(
  '[AC-B1-04k#4] prod 拒绝文件来源（只认 KMS），与 FIELD_KEY_PROVIDER=%s 无关',
  (provider) => {
    const file = '/FAKE_TAOBAO_PROD_PATH/secret.txt';
    const error = configFailure({
      ...environment('prod'),
      FIELD_KEY_PROVIDER: provider,
      TAOBAO_APP_KEY: APP_KEY,
      TAOBAO_APP_SECRET_FILE: file,
    });
    expect(error.problems.join('\n')).toContain('TAOBAO_APP_SECRET_FILE');
    expect(visible(error)).not.toContain(APP_KEY);
    expect(visible(error)).not.toContain(file);
  },
);

it('[AC-B1-04k#4] prod 其他配置有效、只设置密钥文件变量也拒绝且不泄漏路径', () => {
  const env = { ...environment('prod'), ...PROD_AGENT_KEY };
  expect(() => loadConfig(env)).not.toThrow();
  const file = '/FAKE_TAOBAO_PROD_ONLY_FILE_PATH/secret.txt';
  const error = configFailure({ ...env, TAOBAO_APP_SECRET_FILE: file });
  expect(error.problems.join('\n')).toContain('TAOBAO_APP_SECRET_FILE');
  expect(visible(error)).not.toContain(file);
});

it('[AC-B1-04k#5] loadConfig 纯校验：staging 保留 app key 与文件路径，不读文件、不保存 secret', async () => {
  const directory = await temporaryDirectory();
  try {
    const file = join(directory, 'fake-taobao-secret.txt');
    // A missing file must pass config parsing; opening belongs to the async startup factory.
    const before = configured(file);
    expect(JSON.stringify(before)).toContain(file);
    expect(JSON.stringify(before)).toContain(APP_KEY);
    await writeFile(file, `${SECRET}\n`, 'utf8');
    expect(configured(file)).toEqual(before);
    expect(visible(configured(file))).not.toContain(SECRET);
    for (const appEnv of ['local', 'test', 'staging', 'prod'] as const) {
      expect(() =>
        loadConfig({ ...environment(appEnv), ...(appEnv === 'prod' ? PROD_AGENT_KEY : {}) }),
      ).not.toThrow();
    }
  } finally {
    await removeDirectory(directory);
  }
});

it('[AC-B1-04k#6] 其他配置无效时仍汇总淘宝变量的启动限制，且不泄漏原值', () => {
  for (const appEnv of ['local', 'test', 'staging', 'prod'] as const) {
    const error = configFailure({
      ...environment(appEnv),
      API_PORT: 'FAKE_INVALID_PORT',
      TAOBAO_APP_SECRET_FILE: FAKE_PATH,
    });
    expect(error.problems.join('\n')).toContain('API_PORT');
    expect(error.problems.join('\n')).toContain('TAOBAO_APP');
    expect(visible(error)).not.toContain(FAKE_PATH);
    expect(visible(error)).not.toContain('FAKE_INVALID_PORT');
  }
});

it('[AC-B1-04k#7] 环境示例只列注释掉的变量名，不提供凭据或路径值', async () => {
  const example = await readFile(join(root, '.env.example'), 'utf8');
  for (const name of names) {
    const declarations = example
      .split('\n')
      .filter((line) => new RegExp(`^\\s*#?\\s*${name}(?:\\s|=|$)`).test(line));
    expect(declarations.length).toBeGreaterThan(0);
    for (const line of declarations) {
      expect(line).toMatch(/^\s*#/);
      expect(line).not.toMatch(new RegExp(`${name}\\s*=\\s*[^\\s#]`));
    }
  }
});
