import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { textSha256 } from '../../../../apps/api/src/modules/content/domain/article-body/index.ts';

it.each(['', '劳务协议：签署后生效。', '中文🙂\r\n第二行', '\uFEFF正文', 'a\u0000b'])(
  '[AC-F1-02m#57] hashes the exact UTF-8 bytes of %j as lowercase SHA-256',
  (body) => {
    const result = textSha256(body);
    expect(result).toBe(createHash('sha256').update(body, 'utf8').digest('hex'));
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    expect(textSha256(body)).toBe(result);
  },
);

it('[AC-F1-02m#58] JSON whitespace changes the digest rather than being canonicalised', () => {
  const compact = '{"type":"doc","content":[]}';
  const spaced = '{ "type": "doc", "content": [] }';
  const compactDigest = textSha256(compact);
  const spacedDigest = textSha256(spaced);
  expect(compactDigest).toBe(createHash('sha256').update(compact, 'utf8').digest('hex'));
  expect(spacedDigest).toBe(createHash('sha256').update(spaced, 'utf8').digest('hex'));
  expect(compactDigest).not.toBe(spacedDigest);
  expect(JSON.parse(compact)).toEqual(JSON.parse(spaced));
});

it.each([
  ['{"type":"doc","content":[]}', '{"content":[],"type":"doc"}'],
  ['{"text":"中文"}', '{"text":"\\u4e2d\\u6587"}'],
  ['正文\r\n下一行', '正文\n下一行'],
  ['é', 'e\u0301'],
  ['正文', '正文 '],
])(
  '[AC-F1-02m#59] preserves raw key order, escapes, line endings and Unicode: %j / %j',
  (left, right) => {
    const leftDigest = textSha256(left);
    const rightDigest = textSha256(right);
    expect(leftDigest).toBe(createHash('sha256').update(left, 'utf8').digest('hex'));
    expect(rightDigest).toBe(createHash('sha256').update(right, 'utf8').digest('hex'));
    expect(leftDigest).not.toBe(rightDigest);
  },
);
