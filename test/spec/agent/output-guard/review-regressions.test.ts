// Additive regressions for the first B3-06a review; the original rule assets stay frozen.
import { isDeepStrictEqual } from 'node:util';
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  createSentenceBuffer,
  filterSegment,
} from '../../../../apps/api/src/modules/agent/guard/index.ts';
import type { GuardEmit } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { gradeCase } from '../../../../packages/evals/src/index.ts';
import type { EvalCase, TurnOutput } from '../../../../packages/evals/src/index.ts';
import { cutText, riskParts, runGuard } from './kit.ts';

const bareComLinks = ['jd.com', 'jd.com/x', '例子.com'];
const spacedDiscounts = ['8 折', '8.5 折', '15 %', '15 ％', '8\t折', '15\t%'];
const simplifiedAmounts = ['三百块', '一千元', '两万元', '一亿元', '一千零五十元', '一千〇五十元'];
const addedAmounts = [...spacedDiscounts, ...simplifiedAmounts];
const addedRiskParts = [...bareComLinks, ...addedAmounts];

it.each(bareComLinks)('[AC-B3-06a#5] 裸 .com 域名 %s 不依赖 scheme 或 www 也会删除', (link) => {
  expect(filterSegment(`去 \t${link} 搜一下`)).toEqual({
    text: '去 搜一下',
    hits: ['url'],
  });
});

it.each(spacedDiscounts)(
  '[AC-B3-06a#2] 数字与折扣单位间有空白：%s 整段替换，不残留数字',
  (input) => {
    expect(filterSegment(input)).toEqual({ text: '见卡片', hits: ['amount'] });
    expect(filterSegment(`这款打 ${input}，看看`)).toEqual({
      text: '这款打见卡片，看看',
      hits: ['amount'],
    });
  },
);

it.each(simplifiedAmounts)(
  '[AC-B3-06a#2] 简体百千万亿零〇金额 %s 全部替换，不只替换尾部数词',
  (input) => {
    expect(filterSegment(input)).toEqual({ text: '见卡片', hits: ['amount'] });
    expect(filterSegment(`预算${input}以内`)).toEqual({
      text: '预算见卡片以内',
      hits: ['amount'],
    });
  },
);

it.each([' ', '\t'])('[AC-B3-06a#8] 数字后的 ASCII 点即使后接空白 %j 也不产生句界', (space) => {
  const buffer = createSentenceBuffer();
  const input = `共 3.${space}第二点`;
  expect(buffer.push(input)).toEqual([]);
  expect(buffer.end()).toEqual([input]);
});

it('[AC-B3-06a#8] 数字后的点跨 delta 等到空白时仍不能断句', () => {
  const buffer = createSentenceBuffer();
  expect(buffer.push('共 3.')).toEqual([]);
  expect(buffer.push(' 第二点')).toEqual([]);
  expect(buffer.end()).toEqual(['共 3. 第二点']);
});

it('[AC-B3-06a#12] 第1. 不占句数，后续第二句正常送审下发且不记截断', async () => {
  const result = await runGuard(['第1. 甲。', '乙。']);
  expect(result.text).toBe('第1. 甲。乙。');
  expect(result.emits).toEqual([
    { kind: 'text', text: '第1. 甲。' },
    { kind: 'text', text: '乙。' },
  ]);
  expect(result.calls).toEqual(['第1. 甲。', '乙。']);
  expect(result.summary.outputTruncated).toBe(false);
});

it.each([
  ['三百', '块'],
  ['一千', '元'],
  ['两万', '元'],
  ['一亿', '元'],
  ['一千零五十', '元'],
  ['一千〇五十', '元'],
])('[AC-B3-06a#10] 简体金额尾串 %s | %s 在第 60 字边界完整保留', async (tail, unit) => {
  const prefix = '好'.repeat(60 - Array.from(tail).length);
  const buffer = createSentenceBuffer();
  expect(buffer.push(prefix + tail)).toEqual([prefix]);
  expect(buffer.push(unit)).toEqual([]);
  expect(buffer.end()).toEqual([tail + unit]);
  const result = await runGuard([prefix + tail, unit]);
  expect(result.text).toBe(prefix + '见卡片');
  expect(result.calls).toEqual([prefix, '见卡片']);
  expect(result.summary.filterHits).toEqual(['amount']);
  expect(result.summary.outputTruncated).toBe(false);
});

const sample: EvalCase = {
  id: 'synthetic-output-guard-review-regressions',
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
  return gradeCase(sample, [{ frames, trace: { intent: 'search', tool_calls: [] } }], [])
    .problems.filter(
      (problem) =>
        problem.layer === 'L1' &&
        ['amount_in_text', 'url_in_text', 'too_many_sentences'].includes(problem.code),
    )
    .map((problem) => problem.code);
}

it.each([
  ...bareComLinks.map((text) => [text, 'url_in_text'] as const),
  ...addedAmounts.map((text) => [text, 'amount_in_text'] as const),
])('[AC-B3-06a#23] 补充单项向量 %s 原文泄漏，整段与逐字符输入都消除泄漏', async (input, code) => {
  expect(leaks([{ kind: 'text', text: input }])).toContain(code);
  const expectedText = code === 'amount_in_text' ? '见卡片' : '';
  for (const deltas of [[input], input.split('')]) {
    const result = await runGuard(deltas);
    expect(result.text).toBe(expectedText);
    expect(leaks(result.emits)).toEqual([]);
    expect(result.summary.outputFiltered).toBe(true);
    expect(result.summary.filterHits).toEqual([code === 'amount_in_text' ? 'amount' : 'url']);
  }
});

// Each generated input includes a new review vector, rather than relying on a rare selection.
// The async guard and independent grader need a timeout that scales with CI's PROP_RUNS.
const propertyTimeoutMs = Math.max(60_000, propRuns() * 10);

it(
  '[AC-B3-06a#11] 新增风险向量任意切分不改变缓冲片段、审核文本、输出或摘要',
  { timeout: propertyTimeoutMs },
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...addedRiskParts),
        fc.array(fc.constantFrom(...riskParts, ...addedRiskParts), { maxLength: 14 }),
        fc.array(fc.nat(), { maxLength: 50 }),
        async (required, parts, cuts) => {
          const input = required + '，' + parts.join('');
          const deltas = cutText(input, cuts);
          const whole = createSentenceBuffer();
          const split = createSentenceBuffer();
          const expectedSegments = [...whole.push(input), ...whole.end()];
          const actualSegments = [...deltas.flatMap((delta) => split.push(delta)), ...split.end()];
          const expected = await runGuard([input]);
          const actual = await runGuard(deltas);
          return (
            isDeepStrictEqual(actualSegments, expectedSegments) &&
            isDeepStrictEqual(actual, expected)
          );
        },
      ),
      propParams(),
    );
    expect((await runGuard(['只要 8.', '5 折'])).text).toBe('只要见卡片');
  },
);

it(
  '[AC-B3-06a#23] 新增与原有风险向量随机拼接切分后通过独立 L1 判分',
  { timeout: propertyTimeoutMs },
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...addedRiskParts),
        fc.array(fc.constantFrom(...riskParts, ...addedRiskParts), { maxLength: 16 }),
        fc.array(fc.nat(), { maxLength: 60 }),
        async (required, parts, cuts) => {
          const result = await runGuard(cutText(required + '，' + parts.join(''), cuts));
          return leaks(result.emits).length === 0;
        },
      ),
      propParams(),
    );
    expect(leaks((await runGuard(['三百块，jd.com/x。', '第二句。第三句。'])).emits)).toEqual([]);
  },
);
