import { expect, it } from 'vitest';
import { validateArticleSave } from '../../../../apps/api/src/modules/content/domain/articles-admin/index.ts';
import { article, context, documentBody, paragraph, textNode } from './fixtures.ts';

it('[AC-F1-02v#12] 标题命中禁用词时字段在前、命中词在后', () => {
  expect(validateArticleSave(article({ title: '这是全网最低' }), context())).toMatchObject({
    ok: false,
    fields: ['title', '全网最低'],
  });
});

it.each(['paragraph', 'heading'])(
  '[AC-F1-02v#13] 同一 %s 内的相邻文本跨加粗与斜体仍命中',
  (type) => {
    const body = documentBody({
      type,
      ...(type === 'heading' ? { attrs: { level: 2 } } : {}),
      content: [
        textNode('全网'),
        textNode('最', [{ type: 'bold' }]),
        textNode('低', [{ type: 'italic' }]),
      ],
    });
    expect(validateArticleSave(article({ body }), context())).toMatchObject({
      ok: false,
      fields: ['body', '全网最低'],
    });
  },
);

it('[AC-F1-02v#14] 不跨段落、标题或文章标题拼接禁用词', () => {
  const body = documentBody(
    paragraph(textNode('最低')),
    paragraph(textNode('全网')),
    { type: 'heading', attrs: { level: 1 }, content: [textNode('最低')] },
    paragraph(textNode('全网')),
    paragraph(textNode('最低')),
  );
  expect(validateArticleSave(article({ title: '全网', body }), context())).toEqual({ ok: true });
});

it.each(['bulletList', 'orderedList', 'blockquote'])(
  '[AC-F1-02v#15] 嵌套 %s 中的文本块同样检查禁用词',
  (type) => {
    const block = paragraph(textNode('全网'), textNode('最低', [{ type: 'bold' }]));
    const body = documentBody({
      type,
      content: type === 'blockquote' ? [block] : [{ type: 'listItem', content: [block] }],
    });
    expect(validateArticleSave(article({ body }), context())).toMatchObject({
      ok: false,
      fields: ['body', '全网最低'],
    });
  },
);

it('[AC-F1-02v#16] 标题和正文命中词按词表顺序合并去重，不按字段发现顺序', () => {
  const ctx = context();
  const result = validateArticleSave(
    article({
      title: '比价比价',
      body: documentBody(paragraph(textNode('全网最低 比价 全网最低'))),
    }),
    { ...ctx, bannedWords: [...ctx.bannedWords, ...ctx.bannedWords] },
  );
  expect(result).toMatchObject({ ok: false, fields: ['title', 'body', '全网最低', '比价'] });
});

it('[AC-F1-02v#17] 文本检查使用 user_visible 范围', () => {
  expect(
    validateArticleSave(
      article({ title: '后台专词', body: documentBody(paragraph(textNode('后台专词'))) }),
      context(),
    ),
  ).toEqual({ ok: true });
});

it('[AC-F1-02v#18] 标题与正文都沿用禁用词归一化，测试数据用显式 Unicode 转义', () => {
  expect(
    validateArticleSave(
      article({
        title: '全\u200b网★最低',
        body: documentBody(paragraph(textNode('全网 最\u2060低'))),
      }),
      context(),
    ),
  ).toMatchObject({ ok: false, fields: ['title', 'body', '全网最低'] });
});

it('[AC-F1-02v#19] allow_articles 只豁免指定配置键的指定字段', () => {
  expect(
    validateArticleSave(
      article({ title: '比价', body: documentBody(paragraph(textNode('比价'))) }),
      context({ articleConfigKeys: ['other.key', 'help_links.price_compare'] }),
    ),
  ).toMatchObject({ ok: false, fields: ['title', '比价'] });
});

it('[AC-F1-02v#20] allow_articles 命中正文配置键时可保存', () => {
  expect(
    validateArticleSave(
      article({ body: documentBody(paragraph(textNode('比价'))) }),
      context({ articleConfigKeys: ['help_links.price_compare'] }),
    ),
  ).toEqual({ ok: true });
});

it.each([
  { name: '无配置键', articleConfigKeys: [] },
  { name: '其他配置键', articleConfigKeys: ['other.key'] },
  { name: '配置键只匹配前缀', articleConfigKeys: ['help_links.price_compare.extra'] },
])('[AC-F1-02v#21] 未精确匹配配置键不享受正文豁免：$name', ({ articleConfigKeys }) => {
  expect(
    validateArticleSave(
      article({ body: documentBody(paragraph(textNode('比价'))) }),
      context({ articleConfigKeys }),
    ),
  ).toMatchObject({ ok: false, fields: ['body', '比价'] });
});

it('[AC-F1-02v#22] 标题豁免同样传递配置键与 title 字段，不能扩散到正文或其他词', () => {
  const ctx = context({ articleConfigKeys: ['help_links.price_compare'] });
  const bannedWords = ctx.bannedWords.map((word) =>
    word.word === '比价'
      ? { ...word, allow_articles: [{ config_key: 'help_links.price_compare', fields: ['title'] }] }
      : word,
  );
  expect(
    validateArticleSave(
      article({ title: '比价', body: documentBody(paragraph(textNode('比价 全网最低'))) }),
      { ...ctx, bannedWords },
    ),
  ).toMatchObject({ ok: false, fields: ['body', '全网最低', '比价'] });
});

it('[AC-F1-02v#23] 词表由调用方传入，空表不命中', () => {
  expect(
    validateArticleSave(
      article({ title: '全网最低', body: documentBody(paragraph(textNode('比价'))) }),
      context({ bannedWords: [] }),
    ),
  ).toEqual({ ok: true });
});

it.each([
  { name: '空串', title: '' },
  { name: '空格', title: '  ' },
  { name: '制表符与换行', title: '\t\n' },
])('[AC-F1-02v#24] 去空白后为空的标题不可保存：$name', ({ title }) => {
  expect(validateArticleSave(article({ title }), context())).toEqual({
    ok: false,
    fields: ['title'],
    paths: [],
  });
});

it('[AC-F1-02v#25] 非空标题前后空白不构成保存错误', () => {
  expect(validateArticleSave(article({ title: '  帮助  ' }), context())).toEqual({ ok: true });
});
