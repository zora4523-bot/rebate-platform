import { expect, it } from 'vitest';
import { checkNearDuplicates, checkSplitLeak } from '../../../packages/evals/src/index.ts';
import type { Split } from '../../../packages/evals/src/index.ts';
import { sample } from './fixtures.ts';

it('[B3-01a] 空集、同组同 split、异组异 split 均不泄题', () => {
  expect(checkSplitLeak([])).toEqual([]);
  expect(
    checkSplitLeak([
      sample({ id: 'syn-1', group: 'g-a', split: 'tune' }),
      sample({ id: 'syn-2', group: 'g-a', split: 'tune' }),
      sample({ id: 'syn-3', group: 'g-b', split: 'holdout' }),
      sample({ id: 'syn-4', group: 'g-c', split: 'validate' }),
    ]),
  ).toEqual([]);
});

it.each<[Split, Split]>([
  ['tune', 'validate'],
  ['tune', 'holdout'],
  ['validate', 'holdout'],
])('[B3-01a] 同组跨 %s / %s 必须报 split_leak，即使文本完全不同', (left, right) => {
  const problems = checkSplitLeak([
    sample({ id: 'syn-1', split: left, turns: [{ text: '合成找文具' }] }),
    sample({ id: 'syn-2', split: right, turns: [{ text: '合成问规则' }] }),
  ]);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.every((problem) => problem.code === 'split_leak')).toBe(true);
});

it('[B3-01a] 退役题不参与切分泄漏判定，未退役题仍受保护', () => {
  const active = sample();
  const retired = sample({
    id: 'syn-2',
    split: 'holdout',
    retired: { at: '2026-10-05', reason: '合成退役' },
  });
  expect(checkSplitLeak([active, retired])).toEqual([]);
  expect(checkSplitLeak([retired, active])).toEqual([]);
  expect(checkSplitLeak([retired, active, sample({ id: 'syn-3', split: 'validate' })])).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'split_leak' })]),
  );
});

it('[B3-01a] 同一场景跨集合仍不得跨 split', () => {
  expect(
    checkSplitLeak([
      sample({ id: 'syn-1', set: 'smoke', split: 'tune' }),
      sample({ id: 'syn-2', set: 'find', split: 'holdout' }),
    ]),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'split_leak' })]));
});

it('[B3-01a] 空集、单题和规范化后不同的文本不报近似重复', () => {
  expect(checkNearDuplicates([])).toEqual([]);
  expect(checkNearDuplicates([sample()])).toEqual([]);
  expect(
    checkNearDuplicates([
      sample({ id: 'syn-1', turns: [{ text: '合成蓝色文具' }] }),
      sample({ id: 'syn-2', turns: [{ text: '合成红色文具' }] }),
    ]),
  ).toEqual([]);
});

it.each([
  ['完全相同', '合成例 ABC', '合成例 ABC'],
  ['NFKC 全角', '合成例 ＡＢＣ１２３', '合成例 ABC123'],
  ['NFKC 兼容字符', '合成例 ① ﬁ', '合成例 1 fi'],
  ['NFKC 组合字符', '合成例 cafe\u0301', '合成例 café'],
  ['大小写', '合成例 AbC', '合成例 abc'],
  ['Unicode 空白', '合成例\tA\nB\u00a0C\u3000', '合成例ABC'],
  ['Unicode 标点', '【合成例】“A”—B，C。！', '合成例ABC'],
  ['组合规范化', '【合成例】Ａ\tＢＣ！', '合成例 abc'],
])('[B3-01a] %s 后相同的不同 id 报 near_duplicate', (_label, left, right) => {
  const problems = checkNearDuplicates([
    sample({ id: 'syn-1', group: 'g-a', split: 'tune', turns: [{ text: left }] }),
    sample({ id: 'syn-2', group: 'g-b', split: 'holdout', turns: [{ text: right }] }),
  ]);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.every((problem) => problem.code === 'near_duplicate')).toBe(true);
});

it('[B3-01a] 近似重复使用全部轮次拼接，轮次边界与 untrusted 标记不掩盖重复', () => {
  expect(
    checkNearDuplicates([
      sample({ id: 'syn-1', turns: [{ text: '合成：' }, { text: '蓝色文具', untrusted: true }] }),
      sample({ id: 'syn-2', turns: [{ text: '合成蓝色' }, { text: '文具', untrusted: false }] }),
    ]),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'near_duplicate' })]));
});

it('[B3-01a] 相同首轮而追问不同，或轮次顺序不同，都不是重复', () => {
  expect(
    checkNearDuplicates([
      sample({ id: 'syn-1', turns: [{ text: '合成文具' }, { text: '蓝色' }] }),
      sample({ id: 'syn-2', turns: [{ text: '合成文具' }, { text: '红色' }] }),
      sample({ id: 'syn-3', turns: [{ text: '蓝色' }, { text: '合成文具' }] }),
    ]),
  ).toEqual([]);
});

it('[B3-01a] 去标点不等于删除所有非字母字符：符号差异必须保留', () => {
  expect(
    checkNearDuplicates([
      sample({ id: 'syn-1', turns: [{ text: '合成 A+B' }] }),
      sample({ id: 'syn-2', turns: [{ text: '合成 AB' }] }),
    ]),
  ).toEqual([]);
});

it('[B3-01a] 相同 id 由加载器判重；近似重复只检查不同 id', () => {
  expect(checkNearDuplicates([sample(), sample()])).toEqual([]);
});

it('[B3-01a] 退役题不参与近似重复，不能遮蔽另外两道活跃重复题', () => {
  const active = sample();
  const retired = sample({ id: 'syn-2', retired: { at: '2026-10-05', reason: '合成退役' } });
  expect(checkNearDuplicates([active, retired])).toEqual([]);
  expect(checkNearDuplicates([retired, active])).toEqual([]);
  expect(checkNearDuplicates([retired, active, sample({ id: 'syn-3' })])).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'near_duplicate' })]),
  );
});
