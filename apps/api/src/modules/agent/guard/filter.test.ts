import { describe, expect, it } from 'vitest';

import { createSentenceBuffer } from './buffer.ts';
import { filterSegment } from './filter.ts';

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
    ['9块3件包邮。', '见卡片3件包邮。'],
    ['9块3 件', '见卡片3 件'],
    ['10块2瓶', '见卡片2瓶'],
    ['5块3ml', '见卡片3ml'],
    ['5块2kg装', '见卡片2kg装'],
  ])('keeps the count after 块 in %s', (input, output) => {
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
