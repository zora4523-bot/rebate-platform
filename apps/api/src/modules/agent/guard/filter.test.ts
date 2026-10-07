import { describe, expect, it } from 'vitest';

import { createSentenceBuffer } from './buffer.ts';
import { filterSegment } from './filter.ts';
import { createOutputGuard } from './output-guard.ts';

describe('[BR-AI-06] amount hits cover the whole number (code review round 2)', () => {
  it.each([
    ['给你挑了1万5千元以内的。', '给你挑了见卡片以内的。'],
    ['大概3千5百元。', '大概见卡片。'],
    ['两万3千元就够。', '见卡片就够。'],
    ['1亿2千万元', '见卡片'],
    ['预算1万5千块左右', '预算见卡片左右'],
    ['1万两千元', '见卡片'],
  ])('replaces %s without leaving the numerals before a place-value word', (input, output) => {
    expect(filterSegment(input).text).toBe(output);
  });

  it.each([
    ['9块3件包邮。', '见卡片件包邮。'],
    ['9块3 件', '见卡片 件'],
    ['10块2瓶', '见卡片瓶'],
    ['5块3ml', '见卡片ml'],
    ['5块2kg装', '见卡片kg装'],
  ])('takes the single digit after 块 in %s even before a count (角位从严)', (input, output) => {
    expect(filterSegment(input).text).toBe(output);
  });

  it.each([
    ['9块15升装', '见卡片15升装'],
    ['9块1.5升装', '见卡片1.5升装'],
    ['9块１．５升装', '见卡片１．５升装'],
    ['29块\n9', '见卡片\n9'],
    ['9块，3件', '见卡片，3件'],
  ])('keeps the number after 块 in %s when it is not one 角 digit', (input, output) => {
    expect(filterSegment(input).text).toBe(output);
  });

  it.each([
    ['九块九包邮', '见卡片包邮'],
    ['29块9包邮。', '见卡片包邮。'],
    ['九块九', '见卡片'],
    ['29块9', '见卡片'],
  ])('still takes the digit after 块 in %s', (input, output) => {
    expect(filterSegment(input).text).toBe(output);
  });
});

describe('[BR-AI-06] sentence buffer on a long unbroken run', () => {
  it('holds a run of ASCII-like characters whole and delivers it at the end', () => {
    const buffer = createSentenceBuffer();
    const run = `{"a":${'1'.repeat(5000)}}`;
    const out: string[] = [];
    for (const ch of run) out.push(...buffer.push(ch));
    expect(out).toEqual([]);
    expect(buffer.end()).toEqual([run]);
  });

  it('still cuts prose before a link once the forced flush is reached', () => {
    const buffer = createSentenceBuffer();
    const prose = '好'.repeat(30);
    const link = `https://example.com/${'a'.repeat(40)}`;
    const out = buffer.push(prose + link);
    expect(out).toEqual([prose]);
    expect(buffer.end()).toEqual([link]);
  });
});

describe('[BR-AI-06] an amount inside a link or passcode is deleted with it (code review r2-1)', () => {
  it.each([
    ['前文 ￥1234AbCd￥ 后文', '前文 后文', true],
    ['前文 ¥1234AbCd¥ 后文', '前文 后文', true],
    ['前文 $1234AbCd$ 后文', '前文 后文', false],
    ['前文 €1234AbCd€ 后文', '前文 后文', false],
    ['前文 (1234AbCd) 后文', '前文 后文', false],
    ['前文 （1234AbCd） 后文', '前文 后文', false],
    ['点 https://s.click.taobao.com/t?q=%E5%95%86 看看', '点 看看', true],
    ['点 https://a.com/p?x=29%E5%85%83 看看', '点 看看', true],
  ])('deletes %s whole instead of leaving the placeholder', (input, output, amount) => {
    const result = filterSegment(input);
    expect(result.text).toBe(output);
    expect(result.hits.includes('amount')).toBe(amount);
  });

  it('still uses the placeholder when the amount runs past the link', () => {
    const result = filterSegment('看 https://a.com/p?x=29元 吧');
    expect(result.text).toBe('看见卡片 吧');
    expect(result.hits).toEqual(expect.arrayContaining(['amount', 'url']));
  });

  it('keeps a passcode whole across the forced flush and deletes it', () => {
    const buffer = createSentenceBuffer();
    const prose = '好'.repeat(55);
    const code = '￥1234AbCd￥';
    const segments = [...buffer.push(`${prose} ${code} 后文`), ...buffer.end()];
    expect(segments.some((segment) => segment.includes(code))).toBe(true);
    expect(segments.map((segment) => filterSegment(segment).text).join('')).not.toContain('见卡片');
  });
});

async function guardText(deltas: readonly string[]): Promise<string> {
  const guard = createOutputGuard({ review: { review: () => Promise.resolve('pass') } });
  const emits = [];
  for (const delta of deltas) emits.push(...(await guard.push(delta)));
  emits.push(...(await guard.end()));
  return emits.map((emit) => (emit.kind === 'text' ? emit.text : `[${emit.key}]`)).join('');
}

describe('[BR-AI-06] 复制…打开X is not split by the forced flush (code review r2 S1, case 5)', () => {
  const pad = '好'.repeat(70);
  it.each([
    [`复制${pad}AbCd1234Ef打开淘宝。`, ''],
    [`复制，${pad}AbCd1234Ef打开拼多多看看`, '看看'],
    [`前言。复制${pad}AbCd1234Ef打开京东。`, '前言。'],
  ])('deletes %s whole, pushed whole or one character at a time', async (input, output) => {
    expect(await guardText([input])).toBe(output);
    expect(await guardText([...input])).toBe(output);
  });

  it.each([['复制链接功能在右上角。'], [`复制${pad}在右上角`], [`复制${pad}在右上角。第二句。`]])(
    'delivers %s unchanged when no 打开X follows 复制',
    async (input) => {
      expect(await guardText([input])).toBe(input);
      expect(await guardText([...input])).toBe(input);
    },
  );

  it('holds at most 2000 code points before the forced flush applies again', () => {
    const buffer = createSentenceBuffer();
    const out = buffer.push(`复制${'好'.repeat(2100)}`);
    expect(out.length).toBeGreaterThan(0);
    expect(Array.from(out[0] ?? '').length).toBe(2000);
  });

  it.each(['好', '😀'])(
    '[AC-B3-06a#10] resumes flushing every 60 code points after the copy hold limit (%s)',
    (char) => {
      const input = `复制${char.repeat(5000)}`;
      for (const deltas of [[input], [...input]]) {
        const buffer = createSentenceBuffer();
        const out = deltas.flatMap((delta) => buffer.push(delta));
        expect(out).toEqual([
          `复制${char.repeat(1998)}`,
          ...Array.from({ length: 50 }, () => char.repeat(60)),
        ]);
        const tail = buffer.end();
        expect(tail).toEqual([char.repeat(2)]);
        expect([...out, ...tail].join('')).toBe(input);
      }
    },
  );
});
