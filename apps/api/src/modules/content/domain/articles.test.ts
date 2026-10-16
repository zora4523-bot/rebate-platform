import { expect, it } from 'vitest';
import {
  ArticleCursorError,
  articleSummary,
  decodeArticleCursor,
  encodeArticleCursor,
  isArticleId,
  type PublishedArticleSummary,
} from './articles.ts';

const ID = '0199f102-f000-7000-8000-000000000001';
const AT = '2031-03-04T05:06:06.000001Z';

it('[AC-F1-02f#4] cursor round trips microseconds and rejects impossible dates before SQL', () => {
  const cursor = encodeArticleCursor('help', { at: AT, id: ID });
  expect(decodeArticleCursor(cursor, 'help')).toEqual({ at: AT, id: ID });
  expect(() => decodeArticleCursor(cursor, 'rule')).toThrow(ArticleCursorError);
  for (const at of [
    '2031-02-29T05:06:06.000001Z',
    '2032-04-31T05:06:06.000001Z',
    '0000-01-01T05:06:06.000001Z',
    '2031-13-01T05:06:06.000001Z',
    '2031-01-00T05:06:06.000001Z',
    '2031-01-01T24:00:00.000001Z',
    '2031-03-04T05:06:06.001Z',
  ]) {
    const bad = encodeArticleCursor('help', { at, id: ID });
    expect(() => decodeArticleCursor(bad, 'help'), at).toThrow(ArticleCursorError);
  }
  const leap = { at: '2032-02-29T00:00:00.000000Z', id: ID };
  expect(decodeArticleCursor(encodeArticleCursor('notice', leap), 'notice')).toEqual(leap);
});

it('[AC-F1-02f#4] cursor refuses malformed payloads and noncanonical base64url', () => {
  const valid = encodeArticleCursor('help', { at: AT, id: ID });
  for (const cursor of ['', '!bad', `${valid}=`, `${valid}\n`, 'a'.repeat(513)]) {
    expect(() => decodeArticleCursor(cursor, 'help')).toThrow(ArticleCursorError);
  }
  for (const value of [null, {}, ['help'], ['help', AT, ID, 'extra'], ['help', AT, 1]]) {
    const cursor = Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(() => decodeArticleCursor(cursor, 'help')).toThrow(ArticleCursorError);
  }
});

it('[AC-F1-02f#7] article ids accept only lowercase canonical UUID text', () => {
  expect(isArticleId(ID)).toBe(true);
  for (const id of [ID.toUpperCase(), `{${ID}}`, ID.replaceAll('-', ''), 'abc', `${ID}\n`]) {
    expect(isArticleId(id), id).toBe(false);
  }
});

it('[AC-F1-02f#5] summaries expose independent notice versions without leaking storage columns', () => {
  const row: PublishedArticleSummary = {
    id: ID,
    category: 'notice',
    title: '发布通知',
    version: 3,
    published_at: AT,
    notice_closable: true,
    notice_content_version: 7,
    notice_end_at: null,
  };
  expect(articleSummary(row)).toEqual({
    article_id: ID,
    category: 'notice',
    title: row.title,
    version: 3,
    published_at: AT,
    notice: {
      item_id: ID,
      content_version: 7,
      text: row.title,
      target: { route: 'Help', params: { article_id: ID } },
      closable: true,
      start_at: AT,
      end_at: null,
    },
  });
  expect(articleSummary({ ...row, category: 'help' })).toEqual({
    article_id: ID,
    category: 'help',
    title: row.title,
    version: 3,
    published_at: AT,
  });
});
