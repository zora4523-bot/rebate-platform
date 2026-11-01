import { expect, it } from 'vitest';
import {
  TAOBAO_CONVERT_SOURCE_ENV as CONVERT,
  TAOBAO_SEARCH_SOURCE_ENV as SEARCH,
  readTaobaoSourceConfig,
} from './taobao-sources.ts';

it('[AC-B1-04zn-UNIT#1] 未设或空串时取缺省 baichuan / official，无问题项', () => {
  for (const env of [{}, { [CONVERT]: '', [SEARCH]: '' }]) {
    expect(readTaobaoSourceConfig(env)).toEqual({
      taobaoConvertSource: 'baichuan',
      taobaoSearchSource: 'official',
      problems: [],
    });
  }
});

it('[AC-B1-04zn-UNIT#2] 合法取值原样带出', () => {
  expect(readTaobaoSourceConfig({ [CONVERT]: 'dataoke', [SEARCH]: 'dataoke' })).toEqual({
    taobaoConvertSource: 'dataoke',
    taobaoSearchSource: 'dataoke',
    problems: [],
  });
});

it('[AC-B1-04zn-UNIT#3] 非法取值只报变量名，不回显取值', () => {
  const result = readTaobaoSourceConfig({ [CONVERT]: 'Dataoke', [SEARCH]: 'SECRET_LIKE_VALUE' });
  expect(result.problems).toEqual([CONVERT, SEARCH]);
  expect(JSON.stringify(result)).not.toContain('SECRET_LIKE_VALUE');
});
