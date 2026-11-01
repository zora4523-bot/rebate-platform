import { readFile } from 'node:fs/promises';
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
  CONVERT_VARIABLE,
  SEARCH_VARIABLE,
  configFailure,
  configured,
  environment,
  root,
  visible,
} from './kit.ts';

// D10-530: TAOBAO_CONVERT_SOURCE ∈ {baichuan, dataoke} (default baichuan) and TAOBAO_SEARCH_SOURCE
// ∈ {official, dataoke} (default official). Server settings, not credentials: any APP_ENV may set
// them; an invalid value is a ConfigError whose problem text names only the variable.

const APP_ENVS = ['local', 'test', 'staging', 'prod'] as const;
const FAKE_VALUE = 'FAKE_SWITCH_VALUE_MUST_NOT_ECHO';

it('[AC-B1-04zn#1] 两个开关缺省（不设或空串）时 AppConfig 带出 baichuan / official，任何 APP_ENV 都一样', () => {
  for (const appEnv of APP_ENVS) {
    for (const extra of [{}, { [CONVERT_VARIABLE]: '', [SEARCH_VARIABLE]: '' }]) {
      const config = loadConfig({ ...environment(appEnv), ...extra });
      expect(config.taobaoConvertSource).toBe('baichuan');
      expect(config.taobaoSearchSource).toBe('official');
    }
  }
});

it.each([
  ['baichuan', 'official'],
  ['baichuan', 'dataoke'],
  ['dataoke', 'official'],
  ['dataoke', 'dataoke'],
] as const)(
  '[AC-B1-04zn#2] 合法取值 convert=%s search=%s 原样带出；任何 APP_ENV 都可设，不是凭据、不触发 local/test 启动限制',
  (convert, search) => {
    const variables = { [CONVERT_VARIABLE]: convert, [SEARCH_VARIABLE]: search };
    for (const appEnv of APP_ENVS) {
      const config = loadConfig({ ...environment(appEnv), ...variables });
      expect(config.taobaoConvertSource).toBe(convert);
      expect(config.taobaoSearchSource).toBe(search);
      expect(startupViolations(appEnv, variables)).toEqual([]);
    }
    for (const name of [CONVERT_VARIABLE, SEARCH_VARIABLE]) {
      expect(looksLikeRealCredentialEnvName(name)).toBe(false);
    }
    expect(findCredentialLikeEnvNames(variables)).toEqual([]);
    // Independent of the taobao / 大淘客 credential variables: same values with them set.
    const withCredentials = configured(variables);
    expect(withCredentials.taobaoConvertSource).toBe(convert);
    expect(withCredentials.taobaoSearchSource).toBe(search);
  },
);

it.each([
  [CONVERT_VARIABLE, FAKE_VALUE],
  [CONVERT_VARIABLE, 'official'],
  [CONVERT_VARIABLE, 'DATAOKE'],
  [CONVERT_VARIABLE, 'Baichuan'],
  [CONVERT_VARIABLE, '1'],
  [SEARCH_VARIABLE, FAKE_VALUE],
  [SEARCH_VARIABLE, 'baichuan'],
  [SEARCH_VARIABLE, 'Dataoke'],
  [SEARCH_VARIABLE, 'OFFICIAL'],
  [SEARCH_VARIABLE, 'true'],
] as const)(
  '[AC-B1-04zn#3] %s=%j 非法取值：任何 APP_ENV 都 ConfigError，问题文本只写变量名',
  (name, value) => {
    const other = name === CONVERT_VARIABLE ? SEARCH_VARIABLE : CONVERT_VARIABLE;
    for (const appEnv of APP_ENVS) {
      const error = configFailure({ ...environment(appEnv), [name]: value });
      const problems = error.problems.join('\n');
      expect(problems).toContain(name);
      // Only the invalid one is reported.
      expect(problems).not.toContain(other);
      if (value === FAKE_VALUE) expect(visible(error)).not.toContain(FAKE_VALUE);
    }
  },
);

it('[AC-B1-04zn#4] 其他配置无效时仍汇总开关的问题，且不回显取值', () => {
  for (const appEnv of APP_ENVS) {
    for (const name of [CONVERT_VARIABLE, SEARCH_VARIABLE]) {
      const error = configFailure({
        ...environment(appEnv),
        API_PORT: 'FAKE_INVALID_PORT',
        [name]: FAKE_VALUE,
      });
      const problems = error.problems.join('\n');
      expect(problems).toContain('API_PORT');
      expect(problems).toContain(name);
      expect(visible(error)).not.toContain(FAKE_VALUE);
      expect(visible(error)).not.toContain('FAKE_INVALID_PORT');
    }
  }
});

it('[AC-B1-04zn#5] 环境示例列出注释掉的两个开关变量名（不启用）', async () => {
  const example = await readFile(join(root, '.env.example'), 'utf8');
  for (const name of [CONVERT_VARIABLE, SEARCH_VARIABLE]) {
    const declarations = example
      .split('\n')
      .filter((line) => new RegExp(`^\\s*#?\\s*${name}(?:\\s|=|$)`).test(line));
    expect(declarations.length).toBeGreaterThan(0);
    for (const line of declarations) expect(line).toMatch(/^\s*#/);
  }
});
