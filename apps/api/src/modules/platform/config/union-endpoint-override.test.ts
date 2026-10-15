import { expect, it } from 'vitest';
import {
  UNION_ENDPOINT_OVERRIDE_DIR_ENV as NAME,
  readUnionEndpointOverrideConfig,
} from './union-endpoint-override.ts';

it('[AC-B1-04y-UNIT#1] 未设或空字符串在任何环境都是 null 且无问题项', () => {
  for (const appEnv of ['local', 'test', 'staging', 'prod'] as const) {
    for (const env of [{}, { [NAME]: '' }]) {
      expect(readUnionEndpointOverrideConfig(appEnv, env)).toEqual({
        unionEndpointOverrideDir: null,
        problems: [],
      });
    }
  }
});

it('[AC-B1-04y-UNIT#2] staging 原样保留绝对路径，不看目录是否存在', () => {
  const path = '/run/unit-absent/union-endpoints';
  expect(readUnionEndpointOverrideConfig('staging', { [NAME]: path })).toEqual({
    unionEndpointOverrideDir: path,
    problems: [],
  });
});

it('[AC-B1-04y-UNIT#3] staging 拒绝非绝对路径，其他环境设了即拒绝；问题只写变量名开头、不回显取值', () => {
  for (const value of ['relative/dir', './dir', '~/dir', ' ', 'C:\\unit-dir']) {
    const result = readUnionEndpointOverrideConfig('staging', { [NAME]: value });
    expect(result.unionEndpointOverrideDir).toBeNull();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.startsWith(`${NAME}:`)).toBe(true);
    if (value.trim() !== '') expect(result.problems[0]).not.toContain(value);
  }
  for (const appEnv of ['local', 'test', 'prod'] as const) {
    const value = '/run/unit-dir';
    const result = readUnionEndpointOverrideConfig(appEnv, { [NAME]: value });
    expect(result.unionEndpointOverrideDir).toBeNull();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.startsWith(`${NAME}:`)).toBe(true);
    expect(result.problems[0]).not.toContain(value);
  }
});
