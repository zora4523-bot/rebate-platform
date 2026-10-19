// F1-02s §9.2–9.4: reusable pure domain boundary for this reader and F1-02t's publisher.
import { expect, it } from 'vitest';
import {
  parseDictVersion,
  splitDictKey,
} from '../../../../apps/api/src/modules/content/domain/dict/index.ts';

it.each([
  ['order_status.CREDITED.summary', { dict: 'order_status', code: 'CREDITED.summary' }],
  ['order_status.CREDITED', { dict: 'order_status', code: 'CREDITED' }],
  ['ai_label', { dict: 'ai_label', code: '' }],
  ['ai_label.', { dict: 'ai_label', code: '' }],
] as const)('[AC-F1-02s#1] 字典键只按第一个点拆分：%s', (key, expected) => {
  expect(splitDictKey(key)).toEqual(expected);
});

it.each([
  ['1', 1],
  ['3', 3],
  ['10', 10],
  ['2147483647', 2_147_483_647],
] as const)('[AC-F1-02s#2] 合法十进制正整数版本 %s 给出 int32 上限', (version, limit) => {
  expect(parseDictVersion(version)).toEqual({ version, limit });
});

it.each([
  '0',
  'dict-42',
  '01',
  '-1',
  '+1',
  '1.0',
  '1e2',
  ' 1',
  '1 ',
  '1\n',
  '2147483648',
  '9999999999',
  '10000000000',
])('[AC-F1-02s#3] 哨兵或非法数字字符串 %j 保留原值但不读字典行', (version) => {
  expect(parseDictVersion(version)).toEqual({ version, limit: null });
});

it.each([undefined, null, 12, true, {}, []].map((value) => ({ value })))(
  '[AC-F1-02s#4] 缺省或非字符串 %j 与 config 一致使用 0 哨兵',
  ({ value }) => {
    expect(parseDictVersion(value)).toEqual({ version: '0', limit: null });
  },
);
