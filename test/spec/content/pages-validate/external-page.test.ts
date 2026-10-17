import { expect, it } from 'vitest';
import { validatePageSections } from '../../../../apps/api/src/modules/content/domain/pages/validate/index.ts';
import { context, URL_PATH, withAction, withUrl } from './kit.ts';

// BR-ATTR-29 ①：注册域及子域，端口、大小写、末尾点不改变命中。
const UNION_URLS = [
  'https://union-a.test/x',
  'https://m.union-a.test/',
  'https://a.b.union-a.test/',
  'https://UNION-A.TEST./',
  'https://union-a.test:8443/',
  'https://m.UNION-A.TEST.:8443/item/1?x=1#detail',
  'https://union-b.test/',
  'https://union-c.test/',
];

it.each(UNION_URLS)('[AC-F1-09c#1] 开启时拦截联盟主机 %s', (url) => {
  expect(validatePageSections(withUrl(url), context())).toStrictEqual([URL_PATH]);
});

it.each(UNION_URLS)('[AC-F1-09c#2] 关闭时放行联盟主机 %s', (url) => {
  expect(validatePageSections(withUrl(url), context({ unionHostBlock: false }))).toStrictEqual([]);
});

it.each([
  'https://notunion-a.test/',
  'https://xunion-a.test/',
  'https://union-a.test.evil.test/',
  'https://brand.test/union-a.test?next=https://union-a.test/#union-a.test',
  'https://brand.test/about',
])('[AC-F1-09c#3] 开启时仍放行非联盟主机 %s', (url) => {
  expect(validatePageSections(withUrl(url), context())).toStrictEqual([]);
});

it.each(['product', 'promo'] as const)(
  '[AC-F1-09c#4] 仅命中 %s 类别不按 union_host 拦截',
  (category) => {
    const ctx = context({
      linkPatterns: {
        version: 't',
        rules: [{ platform: 'taobao', category, hosts: ['shape.test'], path_patterns: ['/**'] }],
      },
    });
    expect(validatePageSections(withUrl('https://shape.test/item/1'), ctx)).toStrictEqual([]);
  },
);

it.each(['product', 'promo'] as const)(
  '[AC-F1-09c#5] 同域先命中 %s 仍须命中后面的 union_host',
  (category) => {
    const ctx = context();
    const linkPatterns = {
      version: 'overlap',
      rules: [
        { platform: 'taobao', category, hosts: ['union-a.test'], path_patterns: ['/**'] },
        ...ctx.linkPatterns.rules,
      ],
    };
    expect(
      validatePageSections(withUrl('https://union-a.test/item/1'), { ...ctx, linkPatterns }),
    ).toStrictEqual([URL_PATH]);
  },
);

it('[AC-F1-09c#6] 空规则表允许普通 https 外链', () => {
  expect(
    validatePageSections(
      withUrl('https://union-a.test/'),
      context({ linkPatterns: { version: 'empty', rules: [] } }),
    ),
  ).toStrictEqual([]);
});

const INVALID_URLS = [
  'http://brand.test/',
  'ftp://brand.test/',
  '//brand.test/',
  'https://u@union-a.test/',
  'https://u:password@brand.test/',
  'https://:password@brand.test/',
  'not a url',
  'https://',
  '',
  42,
  null,
  {},
];

it.each(
  [true, false].flatMap((unionHostBlock) => INVALID_URLS.map((url) => ({ unionHostBlock, url }))),
)('[AC-F1-09c#7] 开关=$unionHostBlock 仍拒绝非法 url=$url', ({ unionHostBlock, url }) => {
  expect(validatePageSections(withUrl(url), context({ unionHostBlock }))).toStrictEqual([URL_PATH]);
});

it.each([true, false])(
  '[AC-F1-09c#8] 开关=%s 时缺少 url 或 params 均定位 url',
  (unionHostBlock) => {
    const ctx = context({ unionHostBlock });
    expect(
      validatePageSections(withAction({ route: 'ExternalPage', params: {} }), ctx),
    ).toStrictEqual([URL_PATH]);
    expect(validatePageSections(withAction({ route: 'ExternalPage' }), ctx)).toStrictEqual([
      URL_PATH,
    ]);
  },
);

// BR-ID-33 细则及 §9.2：原串和一次百分号解码结果都要查；不依赖联盟主机开关。
const PLACEHOLDER_URLS = [
  'https://brand.test/?id={uid}',
  'https://brand.test/${token}',
  'https://brand.test/#{{phone}}',
  'https://brand.test/?id=%UID%',
  'https://brand.test/?id=%user_12%',
  'https://brand.test/?id=%_ID%',
  'https://brand.test/?id=%ABG%',
  'https://brand.test/?id=%7Buid%7D',
  'https://brand.test/?id=%7buid%7d',
  'https://brand.test/?id=%25UID%25',
  'https://brand.test/{',
  'https://brand.test/}',
];

it.each(
  [true, false].flatMap((unionHostBlock) =>
    PLACEHOLDER_URLS.map((url) => ({ unionHostBlock, url })),
  ),
)('[AC-F1-09c#9] 开关=$unionHostBlock 仍拦截个人占位 $url', ({ unionHostBlock, url }) => {
  expect(validatePageSections(withUrl(url), context({ unionHostBlock }))).toStrictEqual([URL_PATH]);
});

it.each([
  'https://brand.test/?q=%E4%B8%AD',
  'https://brand.test/?q=%e4%b8%ad',
  'https://brand.test/?q=%20space',
  'https://brand.test/?q=uid&campaign=summer',
  'https://brand.test/?q=%257Buid%257D',
])('[AC-F1-09c#10] 普通编码与仅二次解码才出现的花括号放行 %s', (url) => {
  expect(validatePageSections(withUrl(url), context())).toStrictEqual([]);
});
