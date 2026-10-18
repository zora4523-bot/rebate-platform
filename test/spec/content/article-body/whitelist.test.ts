import { expect, it } from 'vitest';
import { validateArticleBody } from '../../../../apps/api/src/modules/content/domain/article-body/index.ts';

const opts = Object.freeze({ mediaHosts: Object.freeze(['media.example.test']) });

function documentWith(node: unknown): string {
  return JSON.stringify({ type: 'doc', content: [node] });
}

function markedText(mark: unknown): string {
  return documentWith({
    type: 'paragraph',
    content: [{ type: 'text', text: '条款', marks: [mark] }],
  });
}

it('[AC-F1-02m#20] accepts all whitelisted node and mark types in one article or agreement', () => {
  const body = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '协议' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '正文', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { type: 'hardBreak' },
          {
            type: 'text',
            text: '链接',
            marks: [
              {
                type: 'link',
                attrs: {
                  href: 'https://example.test/terms',
                  target: '_blank',
                  rel: 'noopener',
                  class: 'terms',
                },
              },
            ],
          },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '一' }] }],
          },
        ],
      },
      {
        type: 'orderedList',
        attrs: { start: 2 },
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '二' }] }],
          },
        ],
      },
      {
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '引用' }] }],
      },
      { type: 'horizontalRule' },
      {
        type: 'image',
        attrs: { src: 'https://media.example.test/a.png', alt: '配图', title: '说明' },
      },
    ],
  });
  expect(validateArticleBody(body, opts)).toEqual({ ok: true });
});

it.each([1, 2, 3])('[AC-F1-02m#21] accepts heading level %s', (level) => {
  expect(
    validateArticleBody(
      documentWith({
        type: 'heading',
        attrs: { level },
        content: [{ type: 'text', text: '标题' }],
      }),
      opts,
    ),
  ).toEqual({ ok: true });
});

it.each([0, 4, -1, 1.5, '1', null, true])('[AC-F1-02m#22] rejects heading level %j', (level) => {
  expect(validateArticleBody(documentWith({ type: 'heading', attrs: { level } }), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[0].attrs.level',
  });
});

it.each([1, 7])('[AC-F1-02m#23] accepts positive ordered list start %s', (start) => {
  expect(
    validateArticleBody(
      documentWith({
        type: 'orderedList',
        attrs: { start },
        content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
      }),
      opts,
    ),
  ).toEqual({ ok: true });
});

it.each([0, -1, 1.5, '1', null, true])('[AC-F1-02m#24] rejects ordered list start %j', (start) => {
  expect(
    validateArticleBody(documentWith({ type: 'orderedList', attrs: { start } }), opts),
  ).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[0].attrs.start',
  });
});

it.each(['iframe', 'codeBlock', 'html', 'script', 'Paragraph', 'image ', 'unknown'])(
  '[AC-F1-02m#25] node type %s is outside the exact whitelist',
  (type) => {
    expect(validateArticleBody(documentWith({ type }), opts)).toEqual({
      ok: false,
      fields: ['body'],
      path: 'content[0].type',
    });
  },
);

it('[AC-F1-02m#26] doc is allowed only at the root', () => {
  expect(validateArticleBody(documentWith({ type: 'doc', content: [] }), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[0].type',
  });
});

it.each(['underline', 'code', 'strike', 'Bold', 'link '])(
  '[AC-F1-02m#27] rejects unknown or case-mismatched mark %s',
  (type) => {
    expect(validateArticleBody(markedText({ type }), opts)).toEqual({
      ok: false,
      fields: ['body'],
      path: 'content[0].content[0].marks[0].type',
    });
  },
);

it.each(['html', 'onload', 'extra', '__proto__', 'constructor'])(
  '[AC-F1-02m#28] rejects unknown node key %s including prototype-like names',
  (key) => {
    expect(
      validateArticleBody(documentWith({ type: 'paragraph', [key]: 'unexpected' }), opts),
    ).toEqual({
      ok: false,
      fields: ['body'],
      path: `content[0].${key}`,
    });
  },
);

it.each([
  { type: 'paragraph', attrs: { style: 'color:red' }, field: 'style' },
  { type: 'heading', attrs: { level: 2, id: 'custom' }, field: 'id' },
  { type: 'orderedList', attrs: { start: 1, reversed: true }, field: 'reversed' },
  {
    type: 'image',
    attrs: { src: 'https://media.example.test/a.png', onerror: 'unexpected' },
    field: 'onerror',
  },
])('[AC-F1-02m#29] rejects unknown $type attribute $field', ({ type, attrs, field }) => {
  expect(validateArticleBody(documentWith({ type, attrs }), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: `content[0].attrs.${field}`,
  });
});

it('[AC-F1-02m#30] rejects an unknown root key', () => {
  expect(validateArticleBody('{"type":"doc","html":"<p>raw</p>"}', opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: 'html',
  });
});

it.each([
  { mark: { type: 'bold', attrs: { style: 'color:red' } }, suffix: 'attrs.style' },
  { mark: { type: 'italic', attrs: { onclick: 'unexpected' } }, suffix: 'attrs.onclick' },
  {
    mark: { type: 'link', attrs: { href: '/terms', onclick: 'unexpected' } },
    suffix: 'attrs.onclick',
  },
  { mark: { type: 'bold', extra: true }, suffix: 'extra' },
])('[AC-F1-02m#31] rejects unknown mark key $suffix', ({ mark, suffix }) => {
  expect(validateArticleBody(markedText(mark), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: `content[0].content[0].marks[0].${suffix}`,
  });
});

it.each(['', 1, null, false, {}, []])(
  '[AC-F1-02m#32] rejects empty or non-string text %j',
  (text) => {
    expect(
      validateArticleBody(
        documentWith({ type: 'paragraph', content: [{ type: 'text', text }] }),
        opts,
      ),
    ).toEqual({
      ok: false,
      fields: ['body'],
      path: 'content[0].content[0].text',
    });
  },
);

it('[AC-F1-02m#33] text nodes require text', () => {
  expect(
    validateArticleBody(documentWith({ type: 'paragraph', content: [{ type: 'text' }] }), opts),
  ).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[0].content[0].text',
  });
});

it.each([' ', '<script>alert(1)</script>', '中文🙂'])(
  '[AC-F1-02m#34] nonempty literal text %s stays text',
  (text) => {
    expect(
      validateArticleBody(
        documentWith({ type: 'paragraph', content: [{ type: 'text', text }] }),
        opts,
      ),
    ).toEqual({ ok: true });
  },
);

it.each([
  { node: { type: 1 }, path: 'type' },
  { node: {}, path: 'type' },
  { node: { type: 'paragraph', content: {} }, path: 'content' },
  { node: { type: 'paragraph', content: null }, path: 'content' },
  { node: { type: 'paragraph', content: 'text' }, path: 'content' },
  { node: { type: 'heading', attrs: [] }, path: 'attrs' },
  { node: { type: 'heading', attrs: null }, path: 'attrs' },
  { node: { type: 'heading', attrs: 'level=1' }, path: 'attrs' },
  { node: { type: 'text', text: 'x', marks: {} }, path: 'marks' },
  { node: { type: 'text', text: 'x', marks: null }, path: 'marks' },
])('[AC-F1-02m#35] rejects invalid node property type at $path', ({ node, path }) => {
  expect(validateArticleBody(documentWith(node), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: `content[0].${path}`,
  });
});

it.each([null, [], 'paragraph', 1, false])('[AC-F1-02m#36] rejects non-object node %j', (node) => {
  expect(validateArticleBody(documentWith(node), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[0]',
  });
});

it.each([null, [], 'bold', 1, false])('[AC-F1-02m#37] rejects non-object mark %j', (mark) => {
  expect(validateArticleBody(markedText(mark), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[0].content[0].marks[0]',
  });
});

it.each(['', null, 1, false, {}, []])(
  '[AC-F1-02m#38] link href must be a nonempty string: %j',
  (href) => {
    expect(validateArticleBody(markedText({ type: 'link', attrs: { href } }), opts)).toEqual({
      ok: false,
      fields: ['body'],
      path: 'content[0].content[0].marks[0].attrs.href',
    });
  },
);

it.each(['target', 'rel', 'class'])(
  '[AC-F1-02m#39] link %s accepts strings/null but rejects other types',
  (field) => {
    for (const value of [null, '', 'custom']) {
      expect(
        validateArticleBody(
          markedText({ type: 'link', attrs: { href: '/terms', [field]: value } }),
          opts,
        ),
      ).toEqual({ ok: true });
    }
    for (const value of [1, true, {}, []]) {
      expect(
        validateArticleBody(
          markedText({ type: 'link', attrs: { href: '/terms', [field]: value } }),
          opts,
        ),
      ).toEqual({
        ok: false,
        fields: ['body'],
        path: `content[0].content[0].marks[0].attrs.${field}`,
      });
    }
  },
);

// Link protocol, union-host and placeholder policy belongs to F1-02v, not this whitelist.
it.each([
  'http://example.test',
  '/terms',
  'https://u.jd.com/example',
  'https://example.test/{user_id}',
])('[AC-F1-02m#40] leaves link href business policy to F1-02v: %s', (href) => {
  expect(validateArticleBody(markedText({ type: 'link', attrs: { href } }), opts)).toEqual({
    ok: true,
  });
});

it('[AC-F1-02m#41] walks later siblings and nested list descendants with an indexed path', () => {
  const body = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph' },
      { type: 'horizontalRule' },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'valid' }, { type: 'iframe' }],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(validateArticleBody(body, opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: 'content[2].content[0].content[0].content[1].type',
  });
});
