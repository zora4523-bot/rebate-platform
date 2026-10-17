import { expect, it } from 'vitest';
import { normalizeOrigin, safeHttpsUrl, safeImageUrl, sanitizeArticleBody } from './sanitize.ts';

const ORIGIN = 'https://media.example.invalid';

it('keeps only absolute https link addresses without credentials', () => {
  expect(safeHttpsUrl('https://a.example/x?q=1')).toBe('https://a.example/x?q=1');
  expect(safeHttpsUrl('HTTPS://a.example/x')).toBe('https://a.example/x');
  for (const bad of [
    'http://a.example',
    'https:a.example',
    ' https://a.example',
    'https://user:pw@a.example/',
    '//a.example',
    'javascript:alert(1)',
    42,
  ])
    expect(safeHttpsUrl(bad)).toBeNull();
});

it('accepts only an exact https origin as media origin and compares it exactly', () => {
  expect(normalizeOrigin(ORIGIN)).toBe(ORIGIN);
  expect(normalizeOrigin(`${ORIGIN}/`)).toBe(ORIGIN);
  for (const bad of [undefined, '', `${ORIGIN}/path`, 'http://media.example.invalid', 'x'])
    expect(normalizeOrigin(bad)).toBeNull();
  expect(safeImageUrl(`${ORIGIN}/a.png`, ORIGIN)).toBe(`${ORIGIN}/a.png`);
  expect(safeImageUrl(`${ORIGIN}:8443/a.png`, ORIGIN)).toBeNull();
  expect(safeImageUrl(`${ORIGIN}/a.png`, null)).toBeNull();
});

it('drops unknown subtrees, foreign attributes, empty text and stray list items', () => {
  const body = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { style: 'x' }, content: [{ type: 'text', text: '' }] },
      { type: 'listItem', content: [{ type: 'paragraph' }] },
      { type: 'bulletList', content: [{ type: 'paragraph' }] },
      { type: 'heading', attrs: { level: 5 }, content: [{ type: 'text', text: 'h5' }] },
      { type: 'table', content: [{ type: 'paragraph' }] },
      {
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'a', marks: [{ type: 'bold' }, { type: 'bold' }] },
              { type: 'image', attrs: { src: `${ORIGIN}/i.png`, alt: 1, onerror: 'x' } },
            ],
          },
        ],
      },
    ],
  });
  expect(sanitizeArticleBody(body, ORIGIN)).toEqual({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [] },
      {
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'a', marks: [{ type: 'bold' }] },
              { type: 'image', attrs: { src: `${ORIGIN}/i.png`, alt: '' } },
            ],
          },
        ],
      },
    ],
  });
});

it('rejects bodies that are not a document', () => {
  for (const body of ['{', 'null', '[]', '{}', '{"type":"doc","content":{}}'])
    expect(sanitizeArticleBody(body, null)).toBeNull();
  expect(sanitizeArticleBody('{"type":"doc"}', null)).toEqual({ type: 'doc', content: [] });
});
