import { expect, it } from 'vitest';
import fc from 'fast-check';
import { propParams } from '@couli/testing';
import { createSentenceBuffer } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { cutText, riskParts, runGuard } from './kit.ts';

it.each(['。', '！', '？', '；', '!', '?', '\n', '\r'])(
  '[AC-B3-06a#8] %s 定界符随片段下发，余文留到 end',
  (delimiter) => {
    const buffer = createSentenceBuffer();
    expect(buffer.push(`第一句${delimiter}余文`)).toEqual([`第一句${delimiter}`]);
    expect(buffer.end()).toEqual(['余文']);
  },
);

it('[AC-B3-06a#8] ASCII 点等待后文判定；数字后的点不切开', () => {
  const buffer = createSentenceBuffer();
  expect(buffer.push('Hi.')).toEqual([]);
  expect(buffer.push(' Ok v1.2 29.')).toEqual(['Hi.']);
  expect(buffer.push('9 元')).toEqual([]);
  expect(buffer.end()).toEqual([' Ok v1.2 29.9 元']);
});

it('[AC-B3-06a#8] 文本末尾的非数字点在 end 确认为句末', () => {
  const buffer = createSentenceBuffer();
  expect(buffer.push('Hi.')).toEqual([]);
  expect(buffer.end()).toEqual(['Hi.']);
});

it('[AC-B3-06a#9] 分开的 29. 与 9 元 合成一个金额后过滤', async () => {
  const result = await runGuard(['只要 29.', '9 元']);
  expect(result.text).toBe('只要见卡片');
  expect(result.calls).toEqual(['只要见卡片']);
  expect(result.summary.filterHits).toEqual(['amount']);
});

it.each(['好', '😀', '𠀀'])('[AC-B3-06a#10] %s 以 code point 计数，满 60 立即下发', (char) => {
  const buffer = createSentenceBuffer();
  expect(buffer.push(char.repeat(59))).toEqual([]);
  expect(buffer.push(char)).toEqual([char.repeat(60)]);
  expect(buffer.push('余')).toEqual([]);
  expect(buffer.end()).toEqual(['余']);
});

it('[AC-B3-06a#10] 半个代理对不能当第 60 个完整字符提前下发', () => {
  const buffer = createSentenceBuffer();
  expect(buffer.push('好'.repeat(59) + '\uD83D')).toEqual([]);
  expect(buffer.push('\uDE00')).toEqual(['好'.repeat(59) + '😀']);
  expect(buffer.end()).toEqual([]);
});

it.each([
  ['二十九', '元'],
  ['返', '29元'],
  ['省', '29'],
  ['减', '29'],
  ['券', '29'],
  ['立减', '29'],
  ['到手', '29'],
  ['满100', '减20'],
  ['２９', '元'],
  ['29.', '9 元'],
  ['￥ 29', '.9'],
  ['85%', ''],
  ['８５％', ''],
  ['貳拾', '圓'],
])('[AC-B3-06a#10] 第 60 字处 %s | %s 的风险尾串保留再过滤', async (tail, suffix) => {
  const prefix = '好'.repeat(60 - Array.from(tail).length);
  const buffer = createSentenceBuffer();
  expect(buffer.push(prefix + tail)).toEqual([prefix]);
  expect([...buffer.push(suffix), ...buffer.end()].join('')).toBe(tail + suffix);
  const result = await runGuard([prefix + tail, suffix]);
  expect(result.text).toBe(prefix + '见卡片');
  expect(result.summary.filterHits).toEqual(['amount']);
});

it('[AC-B3-06a#10] 整个 60 字都是待续金额时不得泄漏数字，end 仍冲刷', async () => {
  const digits = '9'.repeat(60);
  const buffer = createSentenceBuffer();
  expect(buffer.push(digits)).toEqual([]);
  expect([...buffer.push('元'), ...buffer.end()].join('')).toBe(digits + '元');
  expect((await runGuard([digits, '元'])).text).toBe('见卡片');
});

it(
  '[AC-B3-06a#11] 任意 delta 切分不改变原文缓冲片段、过滤片段及摘要',
  { timeout: 60_000 },
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...riskParts), { minLength: 1, maxLength: 14 }),
        fc.array(fc.nat(), { maxLength: 50 }),
        async (parts, cuts) => {
          const text = parts.join('');
          const chunks = cutText(text, cuts);
          const whole = createSentenceBuffer();
          const split = createSentenceBuffer();
          expect([...chunks.flatMap((delta) => split.push(delta)), ...split.end()]).toEqual([
            ...whole.push(text),
            ...whole.end(),
          ]);
          const actual = await runGuard(chunks);
          const expected = await runGuard([text]);
          expect(actual).toEqual(expected);
        },
      ),
      propParams(),
    );
  },
);

it('[AC-B3-06a#11] 每个 UTF-16 切点都不改变小数、英文点、口令和代理对的输出', async () => {
  const input = '只要 29.9 元，😀点https://x.com/a看看。复制这段打开淘宝。';
  const expected = await runGuard([input]);
  for (let cut = 0; cut <= input.length; cut += 1) {
    expect(await runGuard([input.slice(0, cut), '', input.slice(cut)])).toEqual(expected);
  }
});
