import { expect, it } from 'vitest';
import { validateArticleBody } from '../../../../apps/api/src/modules/content/domain/article-body/index.ts';

const opts = Object.freeze({
  mediaHosts: Object.freeze(['media.example.test', 'cdn.example.test']),
});

function imageBody(attrs: Record<string, unknown>): string {
  return JSON.stringify({ type: 'doc', content: [{ type: 'image', attrs }] });
}

it.each([
  'https://media.example.test/a.png',
  'https://cdn.example.test/a.png',
  'HTTPS://MEDIA.EXAMPLE.TEST/a.png',
  'https://media.example.test./a.png',
  'https://media.example.test:443/a.png?size=1#preview',
])('[AC-F1-02m#42] image host uses normalisedHttpsHost semantics: %s', (src) => {
  expect(validateArticleBody(imageBody({ src, alt: '', title: '配图' }), opts)).toEqual({
    ok: true,
  });
});

it.each([
  'http://media.example.test/a.png',
  'https://other.example.test/a.png',
  'https://media.example.test.evil.test/a.png',
  'https://sub.media.example.test/a.png',
  'https://notmedia.example.test/a.png',
  'data:image/png;base64,AAAA',
  'javascript:alert(1)',
  '//media.example.test/a.png',
  '/a.png',
  'not a URL',
  'https://name@media.example.test/a.png',
  'https://media.example.test@evil.test/a.png',
  '',
  null,
  1,
  {},
  [],
])('[AC-F1-02m#43] rejects image src outside the exact configured HTTPS hosts: %j', (src) => {
  expect(validateArticleBody(imageBody({ src }), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[0].attrs.src',
  });
});

it('[AC-F1-02m#44] requires image src even if alt is present', () => {
  expect(validateArticleBody(imageBody({ alt: '配图' }), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[0].attrs.src',
  });
});

it.each(['alt', 'title'])('[AC-F1-02m#45] rejects non-text image attribute %s', (field) => {
  for (const value of [1, true, {}, []]) {
    expect(
      validateArticleBody(
        imageBody({ src: 'https://media.example.test/a.png', [field]: value }),
        opts,
      ),
    ).toEqual({
      ok: false,
      fields: ['body'],
      path: `content[0].attrs.${field}`,
    });
  }
});

it('[AC-F1-02m#46] checks media hosts per call without retaining prior configuration', () => {
  const body = imageBody({ src: 'https://media.example.test/a.png' });
  expect(validateArticleBody(body, opts)).toEqual({ ok: true });
  expect(validateArticleBody(body, { mediaHosts: [] })).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[0].attrs.src',
  });
  expect(validateArticleBody(body, { mediaHosts: ['cdn.example.test'] })).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[0].attrs.src',
  });
  expect(validateArticleBody(body, opts)).toEqual({ ok: true });
});
