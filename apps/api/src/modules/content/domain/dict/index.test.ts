import { expect, it } from 'vitest';
import { dictItems, parseDictVersion, splitDictKey } from './index.ts';

it('[AC-F1-02s#1] 键只按第一个点拆分，无点号 code 为空串', () => {
  expect(splitDictKey('order_status.CREDITED.summary')).toEqual({
    dict: 'order_status',
    code: 'CREDITED.summary',
  });
  expect(splitDictKey('ai_label')).toEqual({ dict: 'ai_label', code: '' });
});

it('[AC-F1-02s#2] 合法版本给出数值上限，int32 之外与非规范写法不读字典行', () => {
  expect(parseDictVersion('2147483647')).toEqual({ version: '2147483647', limit: 2_147_483_647 });
  expect(parseDictVersion('2147483648')).toEqual({ version: '2147483648', limit: null });
  expect(parseDictVersion('0')).toEqual({ version: '0', limit: null });
  expect(parseDictVersion('7\n')).toEqual({ version: '7\n', limit: null });
  expect(parseDictVersion(12)).toEqual({ version: '0', limit: null });
  expect(parseDictVersion(undefined)).toEqual({ version: '0', limit: null });
});

it('[AC-F1-02s#10] text 为 null 的键不出现，空串保留，__proto__ 作普通键', () => {
  const items = dictItems([
    { dict: 'ai_label', code: '', text: '助手' },
    { dict: 'ai_label', code: 'gone', text: null },
    { dict: 'ai_label', code: 'empty', text: '' },
    { dict: 'only_null', code: 'x', text: null },
    { dict: 'order_status', code: '__proto__', text: '原型' },
  ]);
  expect(JSON.parse(JSON.stringify(items))).toEqual({
    ai_label: { '': '助手', empty: '' },
    order_status: JSON.parse('{"__proto__":"原型"}') as object,
  });
  expect(Object.getPrototypeOf(items['order_status'])).toBe(Object.prototype);
  expect(Object.keys(items['order_status']!)).toEqual(['__proto__']);
});
