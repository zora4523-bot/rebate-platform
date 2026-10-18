import { expect, it } from 'vitest';
import { validateArticleBody } from '../../../../apps/api/src/modules/content/domain/article-body/index.ts';

const opts = { mediaHosts: [] };

function textDocument(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}

// Count node levels, not JSON objects/arrays: doc=1, paragraph=2, text=3.
// Wrapping the paragraph in blockquotes adds one level for each wrapper.
function nestedDocument(depth: number): string {
  let node: unknown = { type: 'paragraph', content: [{ type: 'text', text: '正文' }] };
  for (let level = 3; level < depth; level += 1) {
    node = { type: 'blockquote', content: [node] };
  }
  return JSON.stringify({ type: 'doc', content: [node] });
}

it.each(['', '{', '{"type":"doc",}', '<p>正文</p>', '{"type":"doc"} trailing'])(
  '[AC-F1-02m#47] malformed JSON %j returns a body error rather than throwing',
  (body) => {
    expect(validateArticleBody(body, opts)).toEqual({
      ok: false,
      fields: ['body'],
      path: expect.any(String),
    });
  },
);

it.each(['null', '[]', '1', 'true', '"doc"', '{}', '{"type":"paragraph"}'])(
  '[AC-F1-02m#48] root must be a doc object: %s',
  (body) => {
    expect(validateArticleBody(body, opts)).toEqual({
      ok: false,
      fields: ['body'],
      path: expect.any(String),
    });
  },
);

it('[AC-F1-02m#49] exactly 200000 JS code units are allowed even with multibyte UTF-8 text', () => {
  const overhead = textDocument('').length;
  const body = textDocument('中'.repeat(200_000 - overhead));
  expect(validateArticleBody(body, opts)).toEqual({ ok: true });
  expect(body.length).toBe(200_000);
  expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(200_000);
});

it('[AC-F1-02m#50] 200001 JS code units fail despite otherwise valid JSON', () => {
  const overhead = textDocument('').length;
  const body = textDocument('a'.repeat(200_001 - overhead));
  expect(validateArticleBody(body, opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: expect.any(String),
  });
  expect(body.length).toBe(200_001);
});

it('[AC-F1-02m#51] non-BMP characters count as two JS code units, not one code point', () => {
  const overhead = textDocument('').length;
  const count = Math.floor((200_000 - overhead) / 2);
  const text = '🙂'.repeat(count) + 'a'.repeat((200_000 - overhead) % 2);
  const atLimit = textDocument(text);
  const tooLong = textDocument(`${text}a`);
  expect(validateArticleBody(atLimit, opts)).toEqual({ ok: true });
  expect(validateArticleBody(tooLong, opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: expect.any(String),
  });
  expect(atLimit.length).toBe(200_000);
  expect(tooLong.length).toBe(200_001);
});

it('[AC-F1-02m#52] length limit counts whitespace in the stored string before parsing', () => {
  const compact = textDocument('正文');
  const atLimit = compact + ' '.repeat(200_000 - compact.length);
  expect(validateArticleBody(atLimit, opts)).toEqual({ ok: true });
  expect(validateArticleBody(`${atLimit} `, opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: expect.any(String),
  });
});

it('[AC-F1-02m#53] accepts exactly 20 node levels including the root doc', () => {
  expect(validateArticleBody(nestedDocument(20), opts)).toEqual({ ok: true });
});

it('[AC-F1-02m#54] rejects the node at level 21 with its path', () => {
  expect(validateArticleBody(nestedDocument(21), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: Array<string>(20).fill('content[0]').join('.'),
  });
});

it('[AC-F1-02m#55] deep JSON fails as a validation result rather than overflowing recursion', () => {
  expect(validateArticleBody(nestedDocument(200), opts)).toEqual({
    ok: false,
    fields: ['body'],
    path: expect.any(String),
  });
});

it('[AC-F1-02m#56] wide documents do not consume a cumulative nesting budget', () => {
  const body = JSON.stringify({
    type: 'doc',
    content: Array.from({ length: 30 }, () => ({
      type: 'paragraph',
      content: [{ type: 'text', text: '正文', marks: [{ type: 'bold' }] }],
    })),
  });
  expect(validateArticleBody(body, opts)).toEqual({ ok: true });
});
