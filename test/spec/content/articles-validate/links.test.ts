import { expect, it } from 'vitest';
import { validateArticleSave } from '../../../../apps/api/src/modules/content/domain/articles-admin/index.ts';
import { article, context, documentBody, linkedText, paragraph, textNode } from './fixtures.ts';

const hrefPath = 'content[0].content[0].marks[0].attrs.href';

it('[AC-F1-02v#1] 合法帮助文章支持标题、https 链接、媒体域图片和富文本', () => {
  const body = documentBody(
    { type: 'heading', attrs: { level: 2 }, content: [textNode('使用指南')] },
    paragraph(
      textNode('说明', [{ type: 'bold' }, { type: 'italic' }]),
      linkedText('https://docs.example.test/help'),
    ),
    { type: 'image', attrs: { src: 'https://media.example.test/help.png' } },
    { type: 'blockquote', content: [paragraph(textNode('补充说明'))] },
    { type: 'horizontalRule' },
  );
  expect(validateArticleSave(article({ body }), context())).toEqual({ ok: true });
});

it.each([
  'http://docs.example.test/help',
  'javascript:alert(1)',
  '/orders',
  '/orders?id=example',
  'taobao://item',
  '',
  '//docs.example.test/help',
  'https://',
  'https://user:pass@docs.example.test/help',
])('[AC-F1-02v#2] 拒绝非 https 外链或无效链接：%s', (href) => {
  expect(
    validateArticleSave(article({ body: documentBody(paragraph(linkedText(href))) }), context()),
  ).toEqual({ ok: false, fields: ['body'], paths: [hrefPath] });
});

it.each([
  'https://union.example.test/any-path',
  'https://sub.union.example.test/any-path',
  'https://SUB.UNION.EXAMPLE.TEST/any-path',
  'https://union.example.test./any-path',
])('[AC-F1-02v#3] 联盟主机及其子域在拦截开启时拒绝：%s', (href) => {
  expect(
    validateArticleSave(article({ body: documentBody(paragraph(linkedText(href))) }), context()),
  ).toEqual({ ok: false, fields: ['body'], paths: [hrefPath] });
});

it.each(['https://union.example.test/path', 'https://SUB.UNION.EXAMPLE.TEST/path'])(
  '[AC-F1-02v#4] 关闭联盟拦截允许联盟主机：%s',
  (href) => {
    expect(
      validateArticleSave(
        article({ body: documentBody(paragraph(linkedText(href))) }),
        context({ unionHostBlock: false }),
      ),
    ).toEqual({ ok: true });
  },
);

it.each([
  'https://notunion.example.test/path',
  'https://union.example.test.other.test/path',
  'https://docs.example.test/?next=https://union.example.test/path',
  'https://shop.example.test/path',
])('[AC-F1-02v#5] 只按 union_host 域名边界判断，不误伤普通链接：%s', (href) => {
  expect(
    validateArticleSave(article({ body: documentBody(paragraph(linkedText(href))) }), context()),
  ).toEqual({ ok: true });
});

it.each([
  { name: 'uid 花括号', suffix: '/{uid}' },
  { name: '美元占位', suffix: '?id=${x}' },
  { name: '双花括号', suffix: '#{{uid}}' },
  { name: '百分号占位', suffix: '?id=%UID%' },
  { name: '编码花括号', suffix: '/%7Buid%7D' },
  { name: '编码百分号', suffix: '?id=%25UID%25' },
])('[AC-F1-02v#6] 个人数据占位在开关两种状态下均拒绝：$name', ({ suffix }) => {
  for (const unionHostBlock of [true, false]) {
    expect(
      validateArticleSave(
        article({
          body: documentBody(paragraph(linkedText(`https://docs.example.test${suffix}`))),
        }),
        context({ unionHostBlock }),
      ),
    ).toEqual({ ok: false, fields: ['body'], paths: [hrefPath] });
  }
});

it('[AC-F1-02v#7] 联盟拦截关闭也不放行非 https 协议', () => {
  expect(
    validateArticleSave(
      article({ body: documentBody(paragraph(linkedText('http://union.example.test/path'))) }),
      context({ unionHostBlock: false }),
    ),
  ).toEqual({ ok: false, fields: ['body'], paths: [hrefPath] });
});

it('[AC-F1-02v#8] 链接表和媒体域来自本次调用的上下文', () => {
  const ctx = context();
  const input = article({ body: documentBody(paragraph(linkedText('https://docs.example.test'))) });
  expect(
    validateArticleSave(input, {
      ...ctx,
      linkPatterns: {
        version: 'custom',
        rules: [
          {
            platform: 'demo',
            category: 'union_host',
            hosts: ['docs.example.test'],
            path_patterns: [],
          },
        ],
      },
    }),
  ).toEqual({ ok: false, fields: ['body'], paths: [hrefPath] });
  expect(validateArticleSave(input, ctx)).toEqual({ ok: true });
  const image = article({
    body: documentBody({ type: 'image', attrs: { src: 'https://other-media.example.test/a.png' } }),
  });
  expect(validateArticleSave(image, ctx)).toEqual({
    ok: false,
    fields: ['body'],
    paths: ['content[0].attrs.src'],
  });
  expect(validateArticleSave(image, context({ mediaHosts: ['other-media.example.test'] }))).toEqual(
    { ok: true },
  );
});

it('[AC-F1-02v#9] 遍历列表与引用内的链接，收集每个错误路径并去重 body 字段', () => {
  const body = documentBody(
    paragraph(linkedText('https://docs.example.test')),
    {
      type: 'orderedList',
      content: [{ type: 'listItem', content: [paragraph(linkedText('/orders'))] }],
    },
    {
      type: 'blockquote',
      content: [
        paragraph(
          textNode('说明'),
          textNode('联盟', [
            { type: 'bold' },
            { type: 'link', attrs: { href: 'https://union.example.test' } },
          ]),
        ),
      ],
    },
    paragraph(linkedText('https://docs.example.test/{uid}')),
  );
  const result = validateArticleSave(article({ body }), context());
  expect(result).toMatchObject({ ok: false, fields: ['body'] });
  if (result.ok) throw new Error('expected link validation errors');
  expect(result.paths.toSorted()).toEqual([
    'content[1].content[0].content[0].content[0].marks[0].attrs.href',
    'content[2].content[0].content[1].marks[1].attrs.href',
    'content[3].content[0].marks[0].attrs.href',
  ]);
});

it('[AC-F1-02v#10] 正文结构不合法时不继续检查其中的链接或禁用词', () => {
  const body = documentBody(paragraph(linkedText('/orders'), textNode('全网最低')), {
    type: 'iframe',
  });
  expect(validateArticleSave(article({ body }), context())).toEqual({
    ok: false,
    fields: ['body'],
    paths: ['content[1].type'],
  });
});

it('[AC-F1-02v#11] 无法解析的正文返回正文根路径', () => {
  expect(validateArticleSave(article({ body: '{' }), context())).toEqual({
    ok: false,
    fields: ['body'],
    paths: [''],
  });
});
