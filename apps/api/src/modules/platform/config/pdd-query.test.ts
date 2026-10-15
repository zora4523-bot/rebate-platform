import { expect, it } from 'vitest';
import { PDD_QUERY_CUSTOM_PARAMETERS_ENV as NAME, readPddQueryConfig } from './pdd-query.ts';

it('[AC-B1-04x-UNIT#1] 未设或空字符串为 null 且无问题；合法 JSON 对象原样保留', () => {
  expect(readPddQueryConfig({})).toEqual({ pddQueryCustomParameters: null, problems: [] });
  expect(readPddQueryConfig({ [NAME]: '' })).toEqual({
    pddQueryCustomParameters: null,
    problems: [],
  });
  const text = '{ "uid" : "unit-query-user" }';
  expect(readPddQueryConfig({ [NAME]: text })).toEqual({
    pddQueryCustomParameters: text,
    problems: [],
  });
});

it('[AC-B1-04x-UNIT#2] 非对象、坏 JSON、超 64 字节只报变量名', () => {
  for (const text of ['[]', 'null', '1', '{bad', ' ', JSON.stringify({ uid: 'b'.repeat(55) })]) {
    expect(readPddQueryConfig({ [NAME]: text })).toEqual({
      pddQueryCustomParameters: null,
      problems: [NAME],
    });
  }
});
