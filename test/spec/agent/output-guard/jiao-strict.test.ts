// BR-AI-06「块 / 元」后角位从严，SPEC_REF ecacd641。
// 期望值来自规则原例与边界定义，不以当前过滤器的输出作为唯一判定依据。
import { expect, it } from 'vitest';
import {
  createSentenceBuffer,
  filterSegment,
} from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { runGuard } from './kit.ts';

const ruleExamples: readonly (readonly [string, string])[] = [
  ['三块五一斤', '见卡片一斤'],
  ['两块五一个', '见卡片一个'],
  ['九块九包邮', '见卡片包邮'],
  ['九元九包邮', '见卡片包邮'],
  ['29 块 9 包邮', '见卡片 包邮'],
  ['199元一年', '见卡片年'],
  ['9块9双十一价', '见卡片双十一价'],
  ['9块9半价', '见卡片半价'],
  ['9块9一口价', '见卡片一口价'],
  ['三块五一公斤', '见卡片一公斤'],
  ['9块1.5升装', '见卡片1.5升装'],
  ['9块15升装', '见卡片15升装'],
  ['29块9包税', '见卡片包税'],
  ['9块3件包邮', '见卡片件包邮'],
  // 角位扩展适用于所有以块 / 元结尾的金额命中，不限于整数或单字中文金额。
  ['十块五一斤', '见卡片一斤'],
  ['二十九块九包邮', '见卡片包邮'],
  ['一百二十块五', '见卡片'],
  ['两百元九', '见卡片'],
  ['一百二十元五一斤', '见卡片一斤'],
  ['29.9元5件', '见卡片件'],
  ['1.5块3件', '见卡片件'],
  ['¥29元9包邮', '见卡片包邮'],
  ['￥ 29块9', '见卡片'],
  ['到手29块9包邮', '见卡片包邮'],
  // 与 graderAmounts 的金额单位口径一致，也覆盖 NFKC 后的金额和角位。
  ['兩塊五一斤', '见卡片一斤'],
  ['29圓9包邮', '见卡片包邮'],
  ['29圆9包邮', '见卡片包邮'],
  ['￥ ２９．９元５件', '见卡片件'],
  // 换行优先作为句末定界符，下一句的数字不能并入上一句金额。
  ['29块\n9', '见卡片\n9'],
  // 旧评审中的量词、后文白名单不能再影响角位判定。
  ['两块五一两', '见卡片一两'],
  ['九块九一千克', '见卡片一千克'],
  ['9块9一整箱', '见卡片一整箱'],
  ['29块9次日达', '见卡片次日达'],
  ['9块9支持七天无理由退货', '见卡片支持七天无理由退货'],
  ['9块9套餐', '见卡片套餐'],
  ['3块3件', '见卡片件'],
  ['两块八折', '见卡片折'],
  ['9块3 件', '见卡片 件'],
  ['10块2瓶', '见卡片瓶'],
  ['5块3ml', '见卡片ml'],
  ['5块2kg装', '见卡片kg装'],
  ['9元3件包邮', '见卡片件包邮'],
  ['29元1年', '见卡片年'],
  ['9块9', '见卡片'],
  ['九元九', '见卡片'],
  ['29 块\t9 包邮', '见卡片 包邮'],
  ['29 元　９ 包邮', '见卡片 包邮'],
  ['三块 \t五一斤', '见卡片一斤'],
  ['九元　九包邮', '见卡片包邮'],
  // 恰好一位阿拉伯数字；中文数词紧随其后不构成第二位阿拉伯数字。
  ['9块9两件', '见卡片两件'],
  ['9块9十件', '见卡片十件'],
  ['9块9 5件', '见卡片 5件'],
  ['9块9.包邮', '见卡片.包邮'],
  ['9块9．包邮', '见卡片．包邮'],
  // 连续多位（含混合宽度）、小数均为完整规格，不能吞首位。
  ['9元15升装', '见卡片15升装'],
  ['9块150升装', '见卡片150升装'],
  ['9块01升装', '见卡片01升装'],
  ['9块１５升装', '见卡片１５升装'],
  ['9块1５升装', '见卡片1５升装'],
  ['9块１5升装', '见卡片１5升装'],
  ['9块 15升装', '见卡片 15升装'],
  ['9元1.5升装', '见卡片1.5升装'],
  ['9块0.5升装', '见卡片0.5升装'],
  ['9块１．５升装', '见卡片１．５升装'],
  ['9块１.５升装', '见卡片１.５升装'],
  ['9块1．5升装', '见卡片1．5升装'],
  ['9块1.５升装', '见卡片1.５升装'],
  ['9元\t１．５升装', '见卡片\t１．５升装'],
  ['２９块９双十一价', '见卡片双十一价'],
  ['２９元９包邮', '见卡片包邮'],
  // 中文只并入紧随的一字，不能把后续中文数词也吞掉；十不是角位数字。
  ['9块五一斤', '见卡片一斤'],
  ['9块五15升装', '见卡片15升装'],
  ['9块五.5升装', '见卡片.5升装'],
  ['9元九十九件', '见卡片十九件'],
  ['9块十一件', '见卡片十一件'],
  ['9元百件装', '见卡片百件装'],
  // 例外限于块 / 元且仅跨空白，数量保护在其他上下文仍成立。
  ['9块，3件', '见卡片，3件'],
  ['9元配3件', '见卡片配3件'],
  ['5毛3件', '见卡片3件'],
  ['2角3件', '见卡片3件'],
  ['3块，24盒、500ml、3件', '见卡片，24盒、500ml、3件'],
];

const chineseDigits = Array.from('〇零一二两三四五六七八九');
const arabicDigits = Array.from('0123456789０１２３４５６７８９');
const digitExamples: readonly (readonly [string, string])[] = ['块', '元'].flatMap((unit) => [
  // 即使后面还有中文数字「一」，也必须只并入第一字。
  ...chineseDigits.map((digit) => [`9${unit}${digit}一斤`, '见卡片一斤'] as const),
  ...arabicDigits.map((digit) => [`9${unit}${digit}件`, '见卡片件'] as const),
]);
const examples = [...ruleExamples, ...digitExamples];

it.each(examples)('[AC-B3-06a#25] 角位从严：%s → %s，并记录金额命中', (input, expected) => {
  expect(filterSegment(input)).toEqual({ text: expected, hits: ['amount'] });
});

it.each(examples)(
  '[AC-B3-06a#26] %s 的每个位置落在第 60 字，三种推入方式均得到 %s',
  async (input, expected) => {
    const points = Array.from(input);
    for (let at = 1; at <= points.length; at += 1) {
      // 同时用补充平面字符验证 60 的单位是 code point，而不是 UTF-16 code unit。
      for (const prefixChar of ['好', '😀']) {
        const prefix = prefixChar.repeat(60 - at);
        const text = prefix + input;
        const allPoints = Array.from(text);
        const ways = [
          { name: '整段', deltas: [text] },
          {
            name: '第60字后分两段',
            deltas: [allPoints.slice(0, 60).join(''), allPoints.slice(60).join('')],
          },
          { name: '逐字', deltas: allPoints },
        ];
        const expectedText = prefix + expected;
        for (const { name, deltas } of ways) {
          const context = `${input}；位置=${at}；前缀=${prefixChar}；${name}`;
          // 直接检查缓冲片段逐段过滤的拼接结果，防止只在 Guard 层补救。
          const buffer = createSentenceBuffer();
          const segments = [...deltas.flatMap((delta) => buffer.push(delta)), ...buffer.end()];
          expect(segments.join(''), context).toBe(text);
          expect(segments.map((segment) => filterSegment(segment).text).join(''), context).toBe(
            expectedText,
          );
          const result = await runGuard(deltas);
          expect(result.text, context).toBe(expectedText);
          expect(result.text, context).toBe(filterSegment(text).text);
          expect(result.calls.join(''), context).toBe(expectedText);
          expect(result.summary.outputFiltered, context).toBe(true);
          expect(result.summary.filterHits, context).toEqual(['amount']);
          expect(result.summary.outputTruncated, context).toBe(false);
        }
      }
    }
  },
);

it.each([
  ...chineseDigits,
  '块',
  '元',
  '三块',
  '九元',
  '三块五',
  '29 块 ',
  '９元　９',
  '元 块',
  '￥ ２９.9 元\t五',
  '零〇一二两三四五六七八九十百千万亿块元.． ９￥',
])('[AC-B3-06a#27] 第 60 字保留最长风险尾串 %j，push 不得提前发出', (tail) => {
  const prefix = '好'.repeat(60 - Array.from(tail).length);
  const buffer = createSentenceBuffer();
  expect(buffer.push(prefix + tail)).toEqual([prefix]);
  expect(buffer.push('余文')).toEqual([]);
  expect(buffer.end()).toEqual([tail + '余文']);
});

it.each(['三块', '九元', '元块', '五 元 '])(
  '[AC-B3-06a#27] 整个 60 字都是 %s 组成的风险尾串时不下发，结束时无损冲刷',
  (part) => {
    const text = Array.from(part.repeat(60)).slice(0, 60).join('');
    const buffer = createSentenceBuffer();
    expect(buffer.push(text)).toEqual([]);
    expect(buffer.push('九')).toEqual([]);
    expect(buffer.end()).toEqual([text + '九']);
  },
);

it.each([['29块\n9'], ['29块\n', '9'], Array.from('29块\n9')])(
  '[AC-B3-06a#28] 换行终结金额所在句，下一句的 9 保留：%j',
  async (...deltas) => {
    const buffer = createSentenceBuffer();
    expect(deltas.flatMap((delta) => buffer.push(delta))).toEqual(['29块\n']);
    expect(buffer.end()).toEqual(['9']);
    const result = await runGuard(deltas);
    expect(result.text).toBe('见卡片\n9');
    expect(result.calls).toEqual(['见卡片\n', '9']);
    expect(result.summary.filterHits).toEqual(['amount']);
    expect(result.summary.outputTruncated).toBe(false);
  },
);
