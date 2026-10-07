import { expect, it } from 'vitest';
import fc from 'fast-check';
import { propParams, propRuns } from '@couli/testing';
import { gradeCase } from '../../../../packages/evals/src/index.ts';
import type { EvalCase, TurnOutput } from '../../../../packages/evals/src/index.ts';
import type { GuardEmit } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import {
  amounts,
  cutText,
  folded,
  graderAmounts,
  links,
  passcodes,
  quantities,
  riskParts,
  runGuard,
} from './kit.ts';

const sample: EvalCase = {
  id: 'synthetic-output-guard',
  set: 'smoke',
  category: 'boundary_normal',
  split: 'holdout',
  group: 'output-guard',
  provenance: 'synthetic',
  subject: 'guest',
  turns: [{ text: '看看商品' }],
  expect: { intent: 'search' },
};

function leaks(emits: readonly GuardEmit[]): string[] {
  const frames: TurnOutput['frames'] = emits.flatMap((emit, index) =>
    emit.kind === 'text'
      ? [{ event: 'text.delta', id: index + 1, data: { delta: emit.text } }]
      : [],
  );
  frames.push({ event: 'done', id: frames.length + 1, data: { finish_reason: 'stop' } });
  const result = gradeCase(sample, [{ frames, trace: { intent: 'search', tool_calls: [] } }], []);
  return result.problems
    .filter(
      (problem) =>
        problem.layer === 'L1' &&
        ['amount_in_text', 'url_in_text', 'too_many_sentences'].includes(problem.code),
    )
    .map((problem) => problem.code);
}

const examples = [
  ...amounts,
  ...links,
  ...passcodes,
  ...folded,
  ...graderAmounts,
  ...quantities,
  '这款券后 29.9 元，点 https://s.click.taobao.com/x',
  '只要 29.9 元',
  '¥29.9元',
  '39元29元',
  '满 100 减 20',
  '29元 \t39元',
  '点https://x.com/a购买更划算。',
  '甲。乙！丙？',
  '甲；乙!丙?',
  '甲\n乙\n丙',
  'Hi. Ok. Third.',
  '$AbCd1234$。甲。乙。',
  '好'.repeat(121) + '。第二句。第三句。',
  '好'.repeat(57) + '二十九元',
  '好'.repeat(59) + '返29',
  '好'.repeat(56) + '满100减20',
  '复制。然后打开淘宝。',
  '复制。然后打开京东。',
  '复制。然后打开拼多多。',
  '£AbCd1234£',
  '¢AbCd1234¢',
  '₳AbCd1234₳',
  'HTTPS://EXAMPLE.COM/a',
  'WWW.EXAMPLE.COM',
  '例子.NET',
  'HTTPS：／／Ｘ．ＣＯＭ',
];

it.each(examples)('[AC-B3-06a#23] 规则样例 %s 经过 Guard 后通过独立 L1 判分', async (input) => {
  const result = await runGuard(input.split(''));
  expect(leaks(result.emits)).toEqual([]);
});

it.each([
  ...amounts.map((text) => [text, 'amount_in_text'] as const),
  ...graderAmounts.map((text) => [text, 'amount_in_text'] as const),
  ...links.map((text) => [text, 'url_in_text'] as const),
  ...passcodes.map((text) => [text, 'url_in_text'] as const),
  ['甲。乙。丙。', 'too_many_sentences'] as const,
])('[AC-B3-06a#23] 单项向量 %s 原文被判泄漏，Guard 消除泄漏', async (input, code) => {
  expect(leaks([{ kind: 'text', text: input }])).toContain(code);
  const result = await runGuard([input]);
  expect(leaks(result.emits)).toEqual([]);
});

it(
  '[AC-B3-06a#23] 风险片段随机拼接并切分后无金额、URL、口令或超句数泄漏',
  { timeout: Math.max(60_000, propRuns() * 10) },
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...riskParts), { minLength: 1, maxLength: 16 }),
        fc.array(fc.nat(), { maxLength: 60 }),
        async (parts, cuts) => {
          const result = await runGuard(cutText(parts.join(''), cuts));
          expect(leaks(result.emits)).toEqual([]);
        },
      ),
      propParams(),
    );
  },
);
