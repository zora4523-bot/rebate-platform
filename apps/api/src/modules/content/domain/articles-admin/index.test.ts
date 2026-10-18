import { describe, expect, it } from 'vitest';
import {
  nextNoticeContentVersion,
  validateArticleSave,
  type ArticleSaveContext,
  type ArticleSaveInput,
} from './index.ts';

function ctx(overrides: Partial<ArticleSaveContext> = {}): ArticleSaveContext {
  return {
    mediaHosts: ['media.example.test'],
    unionHostBlock: true,
    linkPatterns: {
      version: 'unit',
      rules: [
        {
          platform: 'demo',
          category: 'union_host',
          hosts: ['union.example.test'],
          path_patterns: [],
        },
      ],
    },
    bannedWords: [{ word: '全网最低', category: 'unit', scopes: ['user_visible'] }],
    articleConfigKeys: [],
    ...overrides,
  };
}

function doc(...content: unknown[]): string {
  return JSON.stringify({ type: 'doc', content });
}

function paragraph(...content: unknown[]): unknown {
  return { type: 'paragraph', content };
}

function text(value: string, marks: readonly unknown[] = []): unknown {
  return { type: 'text', text: value, marks };
}

function link(href: string): unknown {
  return text('链接', [{ type: 'link', attrs: { href } }]);
}

function input(overrides: Partial<ArticleSaveInput> = {}): ArticleSaveInput {
  return {
    category: 'help',
    title: '帮助',
    body: doc(paragraph(text('正文'))),
    notice_closable: true,
    notice_end_at: null,
    ...overrides,
  };
}

describe('validateArticleSave', () => {
  it('[AC-F1-02v] accepts an empty document body', () => {
    expect(validateArticleSave(input({ body: '{"type":"doc"}' }), ctx())).toEqual({ ok: true });
  });

  it('[AC-F1-02v] body banned-word paths point at each hit text block (followup 9.12)', () => {
    const body = doc(
      paragraph(text('无关')),
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph(text('全网最低'))] }],
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [text('全网'), text('最低', [{ type: 'bold' }])],
      },
    );
    expect(validateArticleSave(input({ body }), ctx())).toEqual({
      ok: false,
      fields: ['body', '全网最低'],
      paths: ['content[1].content[0].content[0]', 'content[2]'],
    });
  });

  it('[AC-F1-02v] link paths come before banned-word block paths', () => {
    const body = doc(paragraph(text('全网最低'), link('http://docs.example.test')));
    expect(validateArticleSave(input({ body }), ctx())).toEqual({
      ok: false,
      fields: ['body', '全网最低'],
      paths: ['content[0].content[1].marks[0].attrs.href', 'content[0]'],
    });
  });

  it('[AC-F1-02v] a hard break ends a text fragment', () => {
    const body = doc(paragraph(text('全网'), { type: 'hardBreak' }, text('最低')));
    expect(validateArticleSave(input({ body }), ctx())).toEqual({ ok: true });
  });

  it('[AC-F1-02v] banned title adds the title field but keeps paths for body locations only', () => {
    expect(validateArticleSave(input({ title: '全网最低' }), ctx())).toEqual({
      ok: false,
      fields: ['title', '全网最低'],
      paths: [],
    });
  });

  it('[AC-F1-02v] placeholder is checked even when the union switch is off and host is union', () => {
    const body = doc(paragraph(link('https://union.example.test/{uid}')));
    expect(validateArticleSave(input({ body }), ctx({ unionHostBlock: false }))).toEqual({
      ok: false,
      fields: ['body'],
      paths: ['content[0].content[0].marks[0].attrs.href'],
    });
  });

  it('[AC-F1-02v] every bad link in one text block is reported', () => {
    const body = doc(paragraph(link('/a'), text('中'), link('https://union.example.test')));
    expect(validateArticleSave(input({ body }), ctx())).toEqual({
      ok: false,
      fields: ['body'],
      paths: [
        'content[0].content[0].marks[0].attrs.href',
        'content[0].content[2].marks[0].attrs.href',
      ],
    });
  });

  it('[AC-F1-02v] notice end-at check applies to the notice category only', () => {
    const unclosable = { notice_closable: false, notice_end_at: null };
    expect(validateArticleSave(input({ category: 'notice', ...unclosable }), ctx())).toEqual({
      ok: false,
      fields: ['notice_end_at'],
      paths: [],
    });
    expect(validateArticleSave(input({ category: 'rule', ...unclosable }), ctx())).toEqual({
      ok: true,
    });
  });
});

describe('nextNoticeContentVersion', () => {
  it('[AC-F1-02v] starts at 1 and bumps by one at most', () => {
    expect(nextNoticeContentVersion(null, { title: 'a', notice_closable: false })).toBe(1);
    const prev = { title: 'a', notice_closable: true, notice_content_version: 5 };
    expect(nextNoticeContentVersion(prev, { title: 'b', notice_closable: false })).toBe(6);
    expect(nextNoticeContentVersion(prev, { title: 'a', notice_closable: true })).toBe(5);
    expect(
      nextNoticeContentVersion(
        { ...prev, notice_closable: false },
        { title: 'a', notice_closable: true },
      ),
    ).toBe(5);
  });
});
