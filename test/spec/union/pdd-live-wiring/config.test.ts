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
  CLIENT_ID,
  SECRET,
  configFailure,
  configured,
  environment,
  removeDirectory,
  root,
  temporaryDirectory,
  visible,
} from './kit.ts';

const names = ['PDD_CLIENT_ID', 'PDD_CLIENT_SECRET_FILE'] as const;

it.each(names)('[AC-B1-04t-CONFIG#1] %s 登记为真实凭据变量并进入启动检查', (name) => {
  expect(looksLikeRealCredentialEnvName(name)).toBe(true);
  expect(findCredentialLikeEnvNames({ [name]: 'FAKE_VALUE' })).toContain(name);
  for (const appEnv of ['local', 'test'] as const) {
    expect(startupViolations(appEnv, { [name]: 'FAKE_VALUE' }).join('\n')).toContain(name);
  }
});

it.each([
  { PDD_CLIENT_ID: CLIENT_ID },
  { PDD_CLIENT_SECRET_FILE: '/FAKE_PDD_PATH/secret.txt' },
  { PDD_CLIENT_ID: CLIENT_ID, PDD_CLIENT_SECRET_FILE: '/FAKE_PDD_PATH/secret.txt' },
])('[AC-B1-04t-CONFIG#2] local/test 任一或两个凭据变量设置即拒绝且不泄漏值：%j', (variables) => {
  for (const appEnv of ['local', 'test'] as const) {
    const error = configFailure({ ...environment(appEnv), ...variables });
    for (const [name, value] of Object.entries(variables)) {
      expect(error.problems.join('\n')).toContain(name);
      expect(visible(error)).not.toContain(value);
    }
  }
});

it.each(names)('[AC-B1-04t-CONFIG#3] staging 只设置 %s 时拒绝，问题文本只提变量名', (name) => {
  const value = name === 'PDD_CLIENT_ID' ? CLIENT_ID : '/FAKE_PDD_PATH/secret.txt';
  const error = configFailure({ ...environment('staging'), [name]: value });
  expect(error.problems.join('\n')).toContain('PDD_CLIENT');
  expect(visible(error)).not.toContain(value);
});

it.each([undefined, 'kms', 'local'] as const)(
  '[AC-B1-04t-CONFIG#4] prod 拒绝文件来源，与 FIELD_KEY_PROVIDER=%s 无关',
  (provider) => {
    const error = configFailure({
      ...environment('prod'),
      FIELD_KEY_PROVIDER: provider,
      PDD_CLIENT_ID: CLIENT_ID,
      PDD_CLIENT_SECRET_FILE: '/FAKE_PDD_PROD_PATH/secret.txt',
    });
    expect(error.problems.join('\n')).toContain('PDD_CLIENT_SECRET_FILE');
    expect(visible(error)).not.toContain(CLIENT_ID);
    expect(visible(error)).not.toContain('/FAKE_PDD_PROD_PATH/secret.txt');
  },
);

it('[AC-B1-04t-CONFIG#4] prod 其他配置有效、只设置密钥文件变量也拒绝且不泄漏路径', () => {
  const env = environment('prod');
  expect(() => loadConfig(env)).not.toThrow();
  const file = '/FAKE_PDD_PROD_ONLY_FILE_PATH/secret.txt';
  const error = configFailure({ ...env, PDD_CLIENT_SECRET_FILE: file });
  expect(error.problems.join('\n')).toContain('PDD_CLIENT_SECRET_FILE');
  expect(visible(error)).not.toContain(file);
});

it('[AC-B1-04t-CONFIG#5] loadConfig 纯校验：保留标识与文件路径，不读取文件或保存 secret', async () => {
  const directory = await temporaryDirectory();
  try {
    const file = join(directory, 'fake-secret.txt');
    // Missing files must pass config parsing; opening belongs to the async startup factory.
    const before = configured(file);
    expect(JSON.stringify(before)).toContain(file);
    expect(JSON.stringify(before)).toContain(CLIENT_ID);
    await writeFile(file, `${SECRET}\n`, 'utf8');
    expect(configured(file)).toEqual(before);
    expect(visible(configured(file))).not.toContain(SECRET);
    for (const appEnv of ['local', 'test', 'staging', 'prod'] as const) {
      expect(() => loadConfig(environment(appEnv))).not.toThrow();
    }
  } finally {
    await removeDirectory(directory);
  }
});

it('[AC-B1-04t-CONFIG#6] 其他配置无效时仍汇总 PDD 启动限制，且不泄漏原值', () => {
  for (const appEnv of ['local', 'test', 'staging', 'prod'] as const) {
    const error = configFailure({
      ...environment(appEnv),
      API_PORT: 'FAKE_INVALID_PORT',
      PDD_CLIENT_SECRET_FILE: '/FAKE_PDD_PATH/secret.txt',
    });
    expect(error.problems.join('\n')).toContain('API_PORT');
    expect(error.problems.join('\n')).toContain('PDD_CLIENT');
    expect(visible(error)).not.toContain('/FAKE_PDD_PATH/secret.txt');
    expect(visible(error)).not.toContain('FAKE_INVALID_PORT');
  }
});

it('[AC-B1-04t-CONFIG#7] 环境示例仅列注释变量名，不提供凭据或路径值', async () => {
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
