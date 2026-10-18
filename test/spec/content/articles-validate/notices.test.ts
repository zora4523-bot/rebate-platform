import { expect, it } from 'vitest';
import {
  nextNoticeContentVersion,
  validateArticleSave,
} from '../../../../apps/api/src/modules/content/domain/articles-admin/index.ts';
import { article, context, documentBody, linkedText, paragraph, textNode } from './fixtures.ts';

it('[AC-F1-02v#26] 不可关闭公告必须有失效时刻', () => {
  expect(
    validateArticleSave(
      article({ category: 'notice', notice_closable: false, notice_end_at: null }),
      context(),
    ),
  ).toEqual({ ok: false, fields: ['notice_end_at'], paths: [] });
});

it.each([
  { notice_closable: false, notice_end_at: new Date('2026-10-20T00:00:00Z') },
  { notice_closable: true, notice_end_at: null },
  { notice_closable: true, notice_end_at: new Date('2026-10-20T00:00:00Z') },
])('[AC-F1-02v#27] 公告满足可关闭或具有失效时刻即可保存：%j', (notice) => {
  expect(validateArticleSave(article({ category: 'notice', ...notice }), context())).toEqual({
    ok: true,
  });
});

it.each(['help', 'rule', 'agreement'] as const)(
  '[AC-F1-02v#28] %s 分类不检查公告失效时刻',
  (category) => {
    expect(
      validateArticleSave(
        article({ category, notice_closable: false, notice_end_at: null }),
        context(),
      ),
    ).toEqual({ ok: true });
  },
);

it('[AC-F1-02v#29] 标题、正文链接和文字、公告字段错误一次返回并按约定排序', () => {
  const result = validateArticleSave(
    article({
      category: 'notice',
      title: '比价',
      body: documentBody(paragraph(linkedText('/orders'), textNode('全网最低 比价'))),
      notice_closable: false,
    }),
    context(),
  );
  expect(result).toMatchObject({
    ok: false,
    fields: ['title', 'body', 'notice_end_at', '全网最低', '比价'],
  });
  if (result.ok) throw new Error('expected save validation errors');
  expect(result.paths).toContain('content[0].content[0].marks[0].attrs.href');
});

it('[AC-F1-02v#30] 正文结构失败仍检查标题和公告字段，但不检查正文禁用词', () => {
  expect(
    validateArticleSave(
      article({
        category: 'notice',
        title: '比价',
        body: documentBody(paragraph(textNode('全网最低')), { type: 'iframe' }),
        notice_closable: false,
      }),
      context(),
    ),
  ).toEqual({
    ok: false,
    fields: ['title', 'body', 'notice_end_at', '比价'],
    paths: ['content[1].type'],
  });
});

it('[AC-F1-02v#31] 空标题、正文链接和缺失公告失效时刻一起报错', () => {
  expect(
    validateArticleSave(
      article({
        category: 'notice',
        title: ' ',
        body: documentBody(paragraph(linkedText('/orders'))),
        notice_closable: false,
      }),
      context(),
    ),
  ).toEqual({
    ok: false,
    fields: ['title', 'body', 'notice_end_at'],
    paths: ['content[0].content[0].marks[0].attrs.href'],
  });
});

it.each([true, false])(
  '[AC-F1-02v#32] 首个公告内容版本从 1 开始，closable=%s',
  (notice_closable) => {
    expect(nextNoticeContentVersion(null, { title: '公告', notice_closable })).toBe(1);
  },
);

it.each([
  { name: '标题改变', before: '公告', after: '新公告', from: true, to: true, expected: 4 },
  { name: '仅增加空格', before: '公告', after: '公告 ', from: true, to: true, expected: 4 },
  { name: '可关闭改为不可关闭', before: '公告', after: '公告', from: true, to: false, expected: 4 },
  { name: '不可关闭改为可关闭', before: '公告', after: '公告', from: false, to: true, expected: 3 },
  {
    name: '标题和可关闭同时改变',
    before: '公告',
    after: '新公告',
    from: true,
    to: false,
    expected: 4,
  },
  {
    name: '标题改变同时允许关闭',
    before: '公告',
    after: '新公告',
    from: false,
    to: true,
    expected: 4,
  },
  { name: '可关闭公告内容不变', before: '公告', after: '公告', from: true, to: true, expected: 3 },
  {
    name: '不可关闭公告内容不变',
    before: '公告',
    after: '公告',
    from: false,
    to: false,
    expected: 3,
  },
])('[AC-F1-02v#33] 内容版本按最新版本推导：$name', ({ before, after, from, to, expected }) => {
  expect(
    nextNoticeContentVersion(
      { title: before, notice_closable: from, notice_content_version: 3 },
      { title: after, notice_closable: to },
    ),
  ).toBe(expected);
});

it('[AC-F1-02v#34] 内容版本比较原始标题，不进行禁用词归一化', () => {
  expect(
    nextNoticeContentVersion(
      { title: '公告A', notice_closable: true, notice_content_version: 8 },
      { title: '公告Ａ', notice_closable: true },
    ),
  ).toBe(9);
});

it.each([1, 8, 99])('[AC-F1-02v#35] 基于传入的最新内容版本 %s 保持或递增', (version) => {
  const prev = { title: '公告', notice_closable: false, notice_content_version: version };
  expect(nextNoticeContentVersion(prev, { title: '公告', notice_closable: false })).toBe(version);
  expect(nextNoticeContentVersion(prev, { title: '新公告', notice_closable: false })).toBe(
    version + 1,
  );
});

it('[AC-F1-02v#36] 两个纯函数均不修改调用方输入', () => {
  const input = article({ category: 'notice', notice_end_at: new Date('2026-10-20T00:00:00Z') });
  const ctx = context();
  const originalInput = structuredClone(input);
  const originalContext = structuredClone(ctx);
  expect(validateArticleSave(input, ctx)).toEqual({ ok: true });
  expect(input).toEqual(originalInput);
  expect(ctx).toEqual(originalContext);
  const prev = { title: '旧公告', notice_closable: true, notice_content_version: 7 };
  const next = { title: '新公告', notice_closable: false };
  const originalPrev = structuredClone(prev);
  const originalNext = structuredClone(next);
  expect(nextNoticeContentVersion(prev, next)).toBe(8);
  expect(prev).toEqual(originalPrev);
  expect(next).toEqual(originalNext);
});
