import { expect, it } from 'vitest';
import { checkTextVariables } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import { defaults } from './fixtures.ts';

it.each(Object.entries(defaults))('[AC-F1-02r#23] 包内默认文案自身变量合法：%s', (key, text) => {
  expect(checkTextVariables(key, text, defaults)).toEqual({ ok: true });
});

it('[AC-F1-02r#24] 与真实默认文案比较变量集合，允许改顺序与重复', () => {
  expect(
    checkTextVariables('withdraw.estimate', '{tax} / {net} / {fee} / {net}', defaults),
  ).toEqual({ ok: true });
  expect(checkTextVariables('withdraw.estimate', '{net}{fee}{tax}', defaults)).toEqual({
    ok: true,
  });
});

it.each([
  ['{net}{fee}', ['tax'], []],
  ['{net}{fee}{tax}{amount}{amount}', [], ['amount']],
  ['{amount}{fee}{tax}', ['net'], ['amount']],
  ['', ['net', 'fee', 'tax'], []],
] as const)('[AC-F1-02r#25] 缺少、多出、改名变量报告准确差集：%s', (text, missing, extra) => {
  const result = checkTextVariables('withdraw.estimate', text, defaults);
  expect(result.ok).toBe(false);
  if (!result.ok && result.reason === 'variables_mismatch') {
    expect([...result.missing].sort()).toEqual([...missing].sort());
    expect([...result.extra].sort()).toEqual([...extra].sort());
  }
  expect(result).toMatchObject({ ok: false, reason: 'variables_mismatch' });
});

it.each(['unlisted.key', 'toString', 'constructor', '__proto__'])(
  '[AC-F1-02r#26] 默认文案不存在的键拒绝，不能把继承属性当文案：%s',
  (key) => {
    expect(checkTextVariables(key, '普通文案', defaults)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  },
);

it.each([
  '{',
  '}',
  '{Amount}',
  '{}',
  '{ amount}',
  '{amount }',
  '{1amount}',
  '{_amount}',
  '{amount-name}',
  '{中文}',
  '{{amount}}',
  '{amount',
  'amount}',
  '{amount}{',
  '{amount}}',
])('[AC-F1-02r#27] 合法占位剔除后残留花括号拒绝：%s', (text) => {
  expect(checkTextVariables('sample', text, { sample: '{amount}' })).toMatchObject({
    ok: false,
    reason: 'variables_mismatch',
  });
});

it.each(['{', '}', '{Amount}', '{}', '{{}}'])(
  '[AC-F1-02r#28] 默认无变量时仍拒绝非法花括号：%s',
  (text) => {
    expect(checkTextVariables('favorite.add', text, defaults)).toEqual({
      ok: false,
      reason: 'variables_mismatch',
      missing: [],
      extra: [],
    });
  },
);

it('[AC-F1-02r#29] 默认无变量可改普通文案，加入合法变量则拒绝', () => {
  expect(checkTextVariables('favorite.add', '新的收藏文案', defaults)).toEqual({ ok: true });
  expect(checkTextVariables('favorite.add', '', defaults)).toEqual({ ok: true });
  expect(checkTextVariables('favorite.add', '{amount}', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: [],
    extra: ['amount'],
  });
});

it('[AC-F1-02r#30] 变量允许后续数字与下划线，默认重复次数不影响集合', () => {
  const custom = Object.freeze({ sample: '{a}{a}{item_2}{trace6}' });
  expect(checkTextVariables('sample', '{trace6}{item_2}{a}', custom)).toEqual({ ok: true });
  expect(checkTextVariables('sample', '{a}{a}{a}{item_2}{trace6}', custom)).toEqual({ ok: true });
  expect(custom).toEqual({ sample: '{a}{a}{item_2}{trace6}' });
});

it('[AC-F1-02r#31] 变量差集按名字去重，默认原文保持不变', () => {
  const custom = { sample: '{a}{a}{b}' };
  expect(checkTextVariables('sample', '{b}{c}{c}', custom)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: ['a'],
    extra: ['c'],
  });
  expect(custom).toEqual({ sample: '{a}{a}{b}' });
});
