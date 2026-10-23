import { expect, it } from 'vitest';
import fc from 'fast-check';
import { propParams } from '@couli/testing';
import { scoreRule } from '../../../../apps/api/src/modules/agent/tools/rules/index.ts';

// 期望值手算，不能调用被测函数来构造打分 oracle。
it.each([
  // 问句 5 对、标题+正文 9 对，公共对为「提现」「现最」「最低」。
  {
    label: '中文固定样例',
    q: '提现最低多少',
    title: '提现',
    text: '最低金额为 10 元',
    score: 3 / 7,
  },
  { label: '完全相同', q: '提现最低多少', title: '提现', text: '最低多少', score: 1 },
  { label: '完全不相交', q: '提现', title: '客服', text: '入口', score: 0 },
  {
    label: 'NFKC、小写、空白和中英文标点',
    q: 'ＡＢ，Ｃ！Ｄ',
    title: 'a b',
    text: '\nＣ。d？',
    score: 1,
  },
  { label: '二元组按集合去重', q: 'ababa', title: 'a', text: 'b', score: 2 / 3 },
  { label: '问句单字', q: '提', title: '提现', text: '规则', score: 0 },
  { label: '块单字', q: '提现', title: '提', text: ' ！', score: 0 },
  { label: '双方单字', q: '提', title: '提', text: '', score: 0 },
  { label: '规范化后为空', q: '， \n！', title: '。', text: ' ', score: 0 },
  { label: '只有正文提供命中', q: 'abcd', title: 'xy', text: 'abcd', score: 3 / 4 },
  { label: '只有标题提供命中', q: 'abcd', title: 'abcd', text: 'xy', score: 3 / 4 },
  { label: '标题正文相接的二元组也计分', q: 'bc', title: 'ab', text: 'cd', score: 1 / 2 },
  { label: '汉字按 Unicode 字符计数', q: '𠮷野', title: '𠮷', text: '野', score: 1 },
])('[AC-B3-08b#2] $label', ({ q, title, text, score }) => {
  expect(scoreRule(q, { title, text })).toBeCloseTo(score, 12);
});

it('[AC-B3-08b#2] 任意合成文本的 Dice 得分对称且为 0–1 内有限数', () => {
  // 在 fast-check 外触达骨架，先红保留原始 NotImplemented 错误。
  scoreRule('提现', { title: '提现', text: '规则' });
  const text = fc
    .array(
      fc.constantFrom('提', '现', '规', '则', 'a', 'B', 'Ａ', '１', '𠮷', ' ', '\n', '！', '。'),
      {
        maxLength: 40,
      },
    )
    .map((chars) => chars.join(''));
  fc.assert(
    fc.property(text, text, (a, b) => {
      const forward = scoreRule(a, { title: b, text: '' });
      const reverse = scoreRule(b, { title: a, text: '' });
      expect(Number.isFinite(forward)).toBe(true);
      expect(forward).toBeGreaterThanOrEqual(0);
      expect(forward).toBeLessThanOrEqual(1);
      expect(forward).toBe(reverse);
    }),
    propParams(),
  );
});
