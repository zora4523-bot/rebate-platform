import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { textSha256, validateArticleBody } from './index.ts';

const opts = { mediaHosts: ['Media.Example.Test.'] };

function doc(...content: unknown[]): string {
  return JSON.stringify({ type: 'doc', content });
}

function paragraph(...content: unknown[]): unknown {
  return { type: 'paragraph', content };
}

function linkText(attrs: unknown): string {
  return doc(paragraph({ type: 'text', text: '链接', marks: [{ type: 'link', attrs }] }));
}

function rejected(path: string): unknown {
  return { ok: false, fields: ['body'], path };
}

describe('validateArticleBody', () => {
  it('[AC-F1-02m] accepts an empty document and normalises configured media hosts', () => {
    expect(validateArticleBody('{"type":"doc"}', opts)).toEqual({ ok: true });
    expect(
      validateArticleBody(
        doc({ type: 'image', attrs: { src: 'https://media.example.test/x.png', alt: null } }),
        opts,
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    { node: { type: 'text', text: 'x', content: [] }, path: 'content[0].content[0].content' },
    { node: { type: 'hardBreak', content: [] }, path: 'content[0].content[0].content' },
  ])('[AC-F1-02m] inline leaf nodes cannot carry content: $path', ({ node, path }) => {
    expect(validateArticleBody(doc(paragraph(node)), opts)).toEqual(rejected(path));
  });

  it.each([
    { type: 'horizontalRule', content: [paragraph()] },
    {
      type: 'image',
      attrs: { src: 'https://media.example.test/x.png' },
      content: [paragraph()],
    },
  ])('[AC-F1-02m] block leaf $type cannot carry content', (node) => {
    expect(validateArticleBody(doc(node), opts)).toEqual(rejected('content[0].content'));
  });

  it.each(['paragraph', 'heading', 'hardBreak', 'horizontalRule', 'image'])(
    '[AC-F1-02m] non-text node %s cannot carry marks',
    (type) => {
      const node = { type, marks: [{ type: 'bold' }] };
      expect(validateArticleBody(doc(node), opts)).toEqual(rejected('content[0].marks'));
    },
  );

  it('[AC-F1-02m] non-text nodes cannot carry a text key', () => {
    expect(validateArticleBody(doc({ type: 'paragraph', text: 'x' }), opts)).toEqual(
      rejected('content[0].text'),
    );
  });

  it.each([
    { attrs: {}, label: 'missing href' },
    { attrs: { href: '' }, label: 'empty href' },
    { attrs: { href: 42 }, label: 'numeric href' },
    { attrs: { href: null }, label: 'null href' },
  ])('[AC-F1-02m] link mark rejects $label', ({ attrs }) => {
    expect(validateArticleBody(linkText(attrs), opts)).toEqual(
      rejected('content[0].content[0].marks[0].attrs.href'),
    );
  });

  it('[AC-F1-02m] link mark without attrs is missing href', () => {
    const body = doc(paragraph({ type: 'text', text: '链接', marks: [{ type: 'link' }] }));
    expect(validateArticleBody(body, opts)).toEqual(
      rejected('content[0].content[0].marks[0].attrs.href'),
    );
  });

  it('[AC-F1-02m] heading without a level is rejected at attrs.level', () => {
    expect(validateArticleBody(doc({ type: 'heading' }), opts)).toEqual(
      rejected('content[0].attrs.level'),
    );
  });

  it('[AC-F1-02m] over-long and malformed bodies report the root path', () => {
    expect(validateArticleBody(' '.repeat(200_001), opts)).toEqual(rejected(''));
    expect(validateArticleBody('not json', opts)).toEqual(rejected(''));
    expect(validateArticleBody('[]', opts)).toEqual(rejected(''));
  });
});

describe('textSha256', () => {
  it('[AC-F1-02m] hashes the raw UTF-8 string as lowercase hex', () => {
    const body = '{"type":"doc","content":[]}\n劳务';
    expect(textSha256(body)).toBe(createHash('sha256').update(body, 'utf8').digest('hex'));
  });
});
