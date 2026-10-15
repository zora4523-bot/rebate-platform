import { expect, it } from 'vitest';
import {
  extractCandidates,
  findCandidateSpans,
} from '../../../../apps/api/src/modules/parsing/index.ts';

it.each([
  '',
  '合成耳机，无链接',
  '合成 https://example.invalid/90000000001',
  '￥Ab123456￥ 和 https://example.invalid/90000000001',
  'https://example.invalid/90000000001 ￥Ab123456￥ http://example.invalid/90000000002',
])('[AC-B3-05a#27][BR-AI-14] 三个以内的候选与既有解析结果逐项相同：%s', (text) => {
  const spans = findCandidateSpans(text);
  expect(spans).toEqual(extractCandidates(text));
  for (const span of spans) {
    expect(text.slice(span.index, span.index + span.raw.length)).toBe(span.raw);
  }
});

it('[AC-B3-05a#28][BR-AI-14] 五个候选混排返回全部位置，旧接口仍只取前三个', () => {
  const text =
    '合成 https://example.invalid/90000000001 ￥Ab123456￥ http://example.invalid/90000000002 ' +
    '$Cd123456$ https://example.invalid/90000000003';
  const expected = [
    { kind: 'url', raw: 'https://example.invalid/90000000001', index: 3 },
    { kind: 'tpwd', raw: '￥Ab123456￥', index: text.indexOf('￥Ab123456￥') },
    {
      kind: 'url',
      raw: 'http://example.invalid/90000000002',
      index: text.indexOf('http://'),
    },
    { kind: 'tpwd', raw: '$Cd123456$', index: text.indexOf('$Cd123456$') },
    {
      kind: 'url',
      raw: 'https://example.invalid/90000000003',
      index: text.lastIndexOf('https://'),
    },
  ];
  expect(findCandidateSpans(text)).toEqual(expected);
  expect(extractCandidates(text)).toEqual(expected.slice(0, 3));
});

it('[AC-B3-05a#29][BR-AI-14] 重复候选也保留各自的位置，不去重或截断', () => {
  const raw = 'https://example.invalid/90000000001';
  const text = [raw, raw, raw, raw, raw].join(' ');
  expect(findCandidateSpans(text)).toEqual([
    { kind: 'url', raw, index: 0 },
    { kind: 'url', raw, index: raw.length + 1 },
    { kind: 'url', raw, index: (raw.length + 1) * 2 },
    { kind: 'url', raw, index: (raw.length + 1) * 3 },
    { kind: 'url', raw, index: (raw.length + 1) * 4 },
  ]);
  expect(extractCandidates(text)).toHaveLength(3);
});

it('[AC-B3-05a#30][BR-AI-14] 候选位置按 JS 字符串偏移，尾标点排除但查询串不改', () => {
  const raw = 'HTTPS://example.invalid/90000000001?q=synthetic&x=1&x=2';
  const text = `🧪合成【${raw}】\n$Ab123456$。`;
  const expected = [
    { kind: 'url', raw, index: 5 },
    { kind: 'tpwd', raw: '$Ab123456$', index: text.indexOf('$Ab123456$') },
  ];
  expect(findCandidateSpans(text)).toEqual(expected);
  expect(extractCandidates(text)).toEqual(expected);
  expect(findCandidateSpans(`${raw}.,;:!?`)).toEqual([{ kind: 'url', raw, index: 0 }]);
});

it('[AC-B3-05a#31][BR-AI-14] URL 内嵌 URL 与 ASCII 口令不重复计候选', () => {
  const raw =
    'https://example.invalid/90000000001?next=https://example.invalid/90000000002&code=$Ab123456$';
  const text = `${raw} ￥Cd123456￥`;
  const expected = [
    { kind: 'url', raw, index: 0 },
    { kind: 'tpwd', raw: '￥Cd123456￥', index: raw.length + 1 },
  ];
  expect(findCandidateSpans(text)).toEqual(expected);
  expect(extractCandidates(text)).toEqual(expected);
});

it('[AC-B3-05a#32][BR-AI-14] 口令沿用六至三十二位含字母的识别范围', () => {
  const long = '$Ab123456789012345678901234567890$';
  const text = `￥Ab1234￥ ${long} ￥123456￥ ￥Ab123￥ $Ab1234567890123456789012345678901$`;
  const expected = [
    { kind: 'tpwd', raw: '￥Ab1234￥', index: 0 },
    { kind: 'tpwd', raw: long, index: 9 },
  ];
  expect(findCandidateSpans(text)).toEqual(expected);
  expect(extractCandidates(text)).toEqual(expected);
});
