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
  PROD_AGENT_KEY,
  SECRET,
  configFailure,
  configured,
  environment,
  removeDirectory,
  root,
  temporaryDirectory,
  visible,
} from './kit.ts';

const names = ['JD_APP_KEY', 'JD_APP_SECRET_FILE'] as const;
const environments = ['local', 'test', 'staging', 'prod'] as const;
const FAKE_PATH = '/FAKE_JD_PATH/secret.txt';
const SITE = 'JD_SITE_ID';

function valid(appEnv: (typeof environments)[number]): Record<string, string> {
  return { ...environment(appEnv), ...(appEnv === 'prod' ? PROD_AGENT_KEY : {}) };
}

it.each(names)('[AC-B1-04ze#1] %s 登记为真实凭据变量并进入 local/test 启动检查', (name) => {
  expect(looksLikeRealCredentialEnvName(name)).toBe(true);
  expect(findCredentialLikeEnvNames({ [name]: 'FAKE_VALUE' })).toContain(name);
  for (const appEnv of ['local', 'test'] as const) {
    expect(startupViolations(appEnv, { [name]: 'FAKE_VALUE' }).join('\n')).toContain(name);
  }
});

it.each([
  { JD_APP_KEY: APP_KEY },
  { JD_APP_SECRET_FILE: FAKE_PATH },
  { JD_APP_KEY: APP_KEY, JD_APP_SECRET_FILE: FAKE_PATH },
])('[AC-B1-04ze#2] local/test 任一或两个变量设置即拒绝，问题文本只写变量名：%j', (variables) => {
  for (const appEnv of ['local', 'test'] as const) {
    const error = configFailure({ ...environment(appEnv), ...variables });
    for (const [name, value] of Object.entries(variables)) {
      expect(error.problems.join('\n')).toContain(name);
      expect(visible(error)).not.toContain(value);
    }
  }
});

it.each(names)('[AC-B1-04ze#3] staging 只设置 %s 时拒绝，问题文本只写变量名', (name) => {
  const value = name === 'JD_APP_KEY' ? APP_KEY : FAKE_PATH;
  const error = configFailure({ ...environment('staging'), [name]: value });
  expect(error.problems.join('\n')).toContain('JD_APP');
  expect(visible(error)).not.toContain(value);
});

it.each([undefined, 'kms', 'local'] as const)(
  '[AC-B1-04ze#4] prod 拒绝文件来源（只认 KMS），与 FIELD_KEY_PROVIDER=%s 无关',
  (provider) => {
    const file = '/FAKE_JD_PROD_PATH/secret.txt';
    const error = configFailure({
      ...environment('prod'),
      FIELD_KEY_PROVIDER: provider,
      JD_APP_KEY: APP_KEY,
      JD_APP_SECRET_FILE: file,
    });
    expect(error.problems.join('\n')).toContain('JD_APP_SECRET_FILE');
    expect(visible(error)).not.toContain(APP_KEY);
    expect(visible(error)).not.toContain(file);
  },
);

it('[AC-B1-04ze#5] prod 其他配置有效：只设文件变量也拒绝且不泄漏路径，只设 app key 不保留', () => {
  const env = valid('prod');
  expect(() => loadConfig(env)).not.toThrow();
  const file = '/FAKE_JD_PROD_ONLY_FILE_PATH/secret.txt';
  const error = configFailure({ ...env, JD_APP_SECRET_FILE: file });
  expect(error.problems.join('\n')).toContain('JD_APP_SECRET_FILE');
  expect(visible(error)).not.toContain(file);
  expect(JSON.stringify(loadConfig({ ...env, JD_APP_KEY: APP_KEY }))).not.toContain(APP_KEY);
});

it('[AC-B1-04ze#6] loadConfig 纯校验：staging 保留 app key 与文件路径，不读文件、不保存 secret', async () => {
  const directory = await temporaryDirectory();
  try {
    const file = join(directory, 'fake-jd-secret.txt');
    // A missing file must pass config parsing; opening belongs to the async startup factory.
    const before = configured(file);
    expect(before.jd).toEqual({ appKey: APP_KEY, secretFile: file });
    await writeFile(file, `${SECRET}\n`, 'utf8');
    expect(configured(file)).toEqual(before);
    expect(visible(configured(file))).not.toContain(SECRET);
    for (const appEnv of environments) {
      expect(() => loadConfig(valid(appEnv))).not.toThrow();
    }
  } finally {
    await removeDirectory(directory);
  }
});

it('[AC-B1-04ze#7] 其他配置无效时仍汇总京东变量的启动限制，且不泄漏原值', () => {
  for (const appEnv of environments) {
    const error = configFailure({
      ...environment(appEnv),
      API_PORT: 'FAKE_INVALID_PORT',
      JD_APP_SECRET_FILE: FAKE_PATH,
    });
    expect(error.problems.join('\n')).toContain('API_PORT');
    expect(error.problems.join('\n')).toContain('JD_APP');
    expect(visible(error)).not.toContain(FAKE_PATH);
    expect(visible(error)).not.toContain('FAKE_INVALID_PORT');
  }
});

it.each([...names, SITE])(
  '[AC-B1-04ze#8] 环境示例只列注释掉的变量名 %s，不提供凭据或路径值',
  async (name) => {
    const example = await readFile(join(root, '.env.example'), 'utf8');
    const declarations = example
      .split('\n')
      .filter((line) => new RegExp(`^\\s*#?\\s*${name}(?:\\s|=|$)`).test(line));
    expect(declarations.length).toBeGreaterThan(0);
    for (const line of declarations) {
      expect(line).toMatch(/^\s*#/);
      expect(line).not.toMatch(new RegExp(`${name}\\s*=\\s*[^\\s#]`));
    }
  },
);

it.each(['1', '4000123', '9007199254740993'])(
  '[AC-B1-04ze#9] JD_SITE_ID=%s 是非密钥可选项：任何环境原文保留，未设或为空不拒绝启动',
  (value) => {
    expect(looksLikeRealCredentialEnvName(SITE)).toBe(false);
    expect(findCredentialLikeEnvNames({ [SITE]: value })).toEqual([]);
    for (const appEnv of environments) {
      const env = valid(appEnv);
      expect(startupViolations(appEnv, { [SITE]: value })).toEqual([]);
      const config = loadConfig({ ...env, [SITE]: value });
      expect(config.jdSiteId).toBe(value);
      // Not half of the credential pair: staging with only the site id has no jd credentials.
      expect(config.jd ?? null).toBeNull();
      expect(loadConfig(env).jdSiteId ?? null).toBeNull();
      expect(loadConfig({ ...env, [SITE]: '' }).jdSiteId ?? null).toBeNull();
    }
  },
);

it.each([
  '0',
  '00',
  '-1',
  '+1',
  '1.5',
  '1e3',
  '0x10',
  'abc',
  ' 123',
  '123 ',
  '123\n',
  '12 3',
  '１２３',
])('[AC-B1-04ze#10] JD_SITE_ID 设了但不是十进制正整数文本即 ConfigError：%j', (value) => {
  for (const appEnv of environments) {
    const error = configFailure({ ...environment(appEnv), [SITE]: value });
    expect(error.problems.join('\n')).toContain(SITE);
  }
});

it('[AC-B1-04ze#11] JD_SITE_ID 非法时问题文本只写变量名，其他配置无效时也一并汇总', () => {
  const value = 'FAKE_SITE_ID_TEXT';
  for (const appEnv of environments) {
    const alone = configFailure({ ...valid(appEnv), [SITE]: value });
    expect(alone.problems.join('\n')).toContain(SITE);
    expect(visible(alone)).not.toContain(value);
    const both = configFailure({
      ...environment(appEnv),
      API_PORT: 'FAKE_INVALID_PORT',
      [SITE]: value,
    });
    expect(both.problems.join('\n')).toContain('API_PORT');
    expect(both.problems.join('\n')).toContain(SITE);
    expect(visible(both)).not.toContain(value);
  }
});

it('[AC-B1-04ze#12] 注册表与模块删掉 jd 凭据的待办，jd-startup 保留 KMS 的待办', async () => {
  const source = (path: string) => readFile(join(root, path), 'utf8');
  const unionRoot = 'apps/api/src/modules/union';
  for (const path of [`${unionRoot}/infra/registry.ts`, `${unionRoot}/union.module.ts`]) {
    expect(await source(path)).not.toMatch(/jd 凭据读取/);
  }
  expect(await source('apps/api/src/modules/platform/config/jd-startup.ts')).toMatch(
    /TODO\(规划\/11 §4\.5\)[^\n]*KMS/,
  );
});
