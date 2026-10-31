import { expect, it } from 'vitest';
import { articleListSummary, firstCodePoints } from './article-summary.ts';

function doc(...content: unknown[]): string {
  return JSON.stringify({ type: 'doc', content });
}
function p(...texts: string[]): unknown {
  return { type: 'paragraph', content: texts.map((text) => ({ type: 'text', text })) };
}

it('[AC-F1-02zzp#1] headings are skipped; paragraphs nested in lists and quotes count in order', () => {
  const heading = {
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text: '标题' }],
  };
  const list = { type: 'bulletList', content: [{ type: 'listItem', content: [p('列表项')] }] };
  expect(articleListSummary(doc(heading, list, p('正文')))).toBe('列表项');
  const quote = { type: 'blockquote', content: [p('  '), p('引用')] };
  expect(articleListSummary(doc(heading, quote))).toBe('引用');
  expect(articleListSummary(doc(heading))).toBeUndefined();
});

it('[AC-F1-02zzp#5] hardBreak and whitespace runs become one space; ends trimmed', () => {
  const body = doc({
    type: 'paragraph',
    content: [
      { type: 'text', text: ' 第一行\n' },
      { type: 'hardBreak' },
      { type: 'text', text: '第二行 ' },
    ],
  });
  expect(articleListSummary(body)).toBe('第一行 第二行');
  expect(articleListSummary(doc(p(`${'a'.repeat(79)} b`)))).toBe('a'.repeat(79));
});

it('[AC-F1-02zzp#3] cuts by code point and repairs lone surrogates', () => {
  expect(firstCodePoints('😀😀😀', 2)).toBe('😀😀');
  expect(firstCodePoints('ab', 5)).toBe('ab');
  expect(articleListSummary(doc(p('a\uD800b')))).toBe('a�b');
});

it('[AC-F1-02zzp#4] non-doc roots and odd nodes give no summary without throwing', () => {
  expect(articleListSummary('{"type":"paragraph","content":[]}')).toBeUndefined();
  expect(articleListSummary(doc({ type: 'paragraph', content: [{ type: 'text', text: 3 }] }))).toBe(
    undefined,
  );
  let deep: unknown = p('深');
  for (let i = 0; i < 200; i += 1) deep = { type: 'blockquote', content: [deep] };
  expect(articleListSummary(doc(deep))).toBeUndefined();
});
