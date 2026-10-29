// B1-05m save checks (编排裁定 D10-419 (a) 2; 规划/01 F-PROD-03; contracts SearchHotWord,
// SearchKeywordRoute, RouteTarget; BR-ATTR-29 ①): search.hot_words is a list of items that only
// have a non-blank `text`; search.keyword_routes a list of `{keyword, target}` with a non-empty
// keyword and a RouteTarget of contracts/routes.json whose params follow that route's definition
// (required, types, no extra keys); an ExternalPage url on a union domain is refused while
// external_page.union_host_block is on. One bad item refuses the whole value. The stored lists are
// returned as configured, so they keep the response's limits (≤ 10 words, ≤ 50 shortcuts, 1–20
// characters each). The generic route-table cases: route-target.test.ts; the console wiring:
// save.int.test.ts.
import { expect, it } from 'vitest';
import {
  searchHotWordsFit,
  searchKeywordRoutesFit,
} from '../../../../apps/api/src/modules/catalog/hot-words/index.ts';
import {
  BLOCK_OFF,
  BLOCK_ON,
  OTHER_URLS,
  UNION_URLS,
  chars,
  external,
  manyRoutes,
  manyWords,
  shortcut,
  validHotWords,
  validRoutes,
} from './kit.ts';

const routesFit = (value: unknown) => searchKeywordRoutesFit(value, BLOCK_ON);

// ---- search.hot_words ---------------------------------------------------------------------------

it('[AC-B1-05m#1] 热词：空列表与只含非空 text 的列表可存（顺序不限、1 字与 20 字、正好 10 条）', () => {
  expect(searchHotWordsFit([])).toBe(true);
  expect(searchHotWordsFit(validHotWords())).toBe(true);
  expect(searchHotWordsFit([...validHotWords()].reverse())).toBe(true);
  expect(searchHotWordsFit([{ text: '热' }, { text: chars(20) }])).toBe(true);
  expect(searchHotWordsFit(manyWords(10))).toBe(true);
});

it.each([
  ['对象', {}],
  ['单个热词对象', { text: '蓝牙耳机' }],
  ['包了一层的列表', { hot_words: [{ text: '蓝牙耳机' }] }],
  ['字符串', '蓝牙耳机'],
  ['数字', 1],
  ['null', null],
])('[AC-B1-05m#2] 热词：值不是列表（%s）拒绝', (_label, value) => {
  expect(searchHotWordsFit(value)).toBe(false);
});

it.each([
  ['缺 text', {}],
  ['text 为空串', { text: '' }],
  ['text 只有空格', { text: '   ' }],
  ['text 只有制表与换行', { text: '\t \n' }],
  ['text 只有全角空格', { text: '　' }],
  ['text 是数字', { text: 1 }],
  ['text 是 null', { text: null }],
  ['text 是列表', { text: ['蓝牙耳机'] }],
  ['多余字段', { text: '蓝牙耳机', weight: 1 }],
  ['多余字段 route', { text: '蓝牙耳机', route: 'Search' }],
  ['项是字符串', '蓝牙耳机'],
  ['项是 null', null],
  ['项是列表', ['蓝牙耳机']],
])('[AC-B1-05m#3] 热词：一项%s → 拒绝', (_label, item) => {
  expect(searchHotWordsFit([item])).toBe(false);
});

it.each([0, 1, 3])(
  '[AC-B1-05m#4] 热词：合法项中混一项空白 text（位置 %i）→ 整条拒绝，不做部分保存',
  (at) => {
    const value: unknown[] = [...validHotWords()];
    value.splice(at, 0, { text: ' ' });
    expect(searchHotWordsFit(value)).toBe(false);
  },
);

it('[AC-B1-05m#5] 热词：超出契约（text 21 字、11 条）拒绝——读接口按配置原样返回', () => {
  expect(searchHotWordsFit([{ text: chars(21) }])).toBe(false);
  expect(searchHotWordsFit(manyWords(11))).toBe(false);
});

// ---- search.keyword_routes ----------------------------------------------------------------------

it('[AC-B1-05m#6] 直达：空列表与合法直达可存（无参路由、可选参数、必填参数、非联盟域 ExternalPage）', () => {
  expect(routesFit([])).toBe(true);
  expect(routesFit(validRoutes())).toBe(true);
  for (const item of validRoutes()) expect(routesFit([item]), JSON.stringify(item)).toBe(true);
  expect(routesFit([shortcut(chars(20), { route: 'HotRankList' })])).toBe(true);
  expect(routesFit(manyRoutes(50))).toBe(true);
});

it.each([
  ['对象', {}],
  ['单个直达对象', shortcut('热销榜', { route: 'HotRankList' })],
  ['字符串', '热销榜'],
  ['null', null],
])('[AC-B1-05m#7] 直达：值不是列表（%s）拒绝', (_label, value) => {
  expect(routesFit(value)).toBe(false);
});

it.each([
  ['keyword 为空串', { keyword: '', target: { route: 'HotRankList' } }],
  ['缺 keyword', { target: { route: 'HotRankList' } }],
  ['keyword 是数字', { keyword: 1, target: { route: 'HotRankList' } }],
  ['keyword 是 null', { keyword: null, target: { route: 'HotRankList' } }],
  ['缺 target', { keyword: '热销榜' }],
  ['target 是 null', { keyword: '热销榜', target: null }],
  ['target 是字符串', { keyword: '热销榜', target: 'HotRankList' }],
  ['target 是列表', { keyword: '热销榜', target: [{ route: 'HotRankList' }] }],
  ['项多余字段', { keyword: '热销榜', target: { route: 'HotRankList' }, sort: 1 }],
  ['项是字符串', '热销榜'],
  ['项是 null', null],
])('[AC-B1-05m#8] 直达：一项%s → 拒绝', (_label, item) => {
  expect(routesFit([item])).toBe(false);
});

it.each([
  ['不在路由表的名字', { route: 'HotRank' }],
  ['大小写不同', { route: 'hotranklist' }],
  ['空路由名', { route: '' }],
  ['路由名是数字', { route: 1 }],
  ['缺 route', { params: {} }],
  ['只给外链字段', { url: 'https://brand.test/a' }],
  ['target 多余字段', { route: 'HotRankList', params: {}, title: '热销榜' }],
])('[AC-B1-05m#9] 直达：target %s → 拒绝（route 只能是 routes.json 的路由）', (_label, target) => {
  expect(routesFit([shortcut('热销榜', target)])).toBe(false);
});

it.each([
  ['ProductDetail 没有 params', { route: 'ProductDetail' }],
  ['ProductDetail 缺必填 product_key', { route: 'ProductDetail', params: { platform: 'taobao' } }],
  ['ProductDetail 缺必填 platform', { route: 'ProductDetail', params: { product_key: 'tb:abc' } }],
  [
    'ProductDetail platform 不在枚举',
    { route: 'ProductDetail', params: { platform: 'amazon', product_key: 'tb:abc' } },
  ],
  [
    'ProductDetail product_key 类型错',
    { route: 'ProductDetail', params: { platform: 'taobao', product_key: 12345 } },
  ],
  [
    'ProductDetail product_key 短于 3',
    { route: 'ProductDetail', params: { platform: 'taobao', product_key: 'tb' } },
  ],
  [
    'ProductDetail 多余参数',
    { route: 'ProductDetail', params: { platform: 'taobao', product_key: 'tb:abc', coupon: 1 } },
  ],
  ['Search q 类型错', { route: 'Search', params: { q: 1 } }],
  ['Search q 超过 100', { route: 'Search', params: { q: 'q'.repeat(101) } }],
  ['Search 多余参数', { route: 'Search', params: { keyword: '耳机' } }],
  ['HotRankList 多余参数', { route: 'HotRankList', params: { url: 'https://brand.test/' } }],
  ['OrderDetail order_id 为空串', { route: 'OrderDetail', params: { order_id: '' } }],
  ['params 是列表', { route: 'HotRankList', params: [] }],
  ['params 是字符串', { route: 'HotRankList', params: 'platform=jd' }],
  ['params 是 null', { route: 'HotRankList', params: null }],
])(
  '[AC-B1-05m#10] 直达：%s → 拒绝（params 照 routes.json：必填、类型、无多余键）',
  (_label, target) => {
    expect(routesFit([shortcut('直达', target)])).toBe(false);
  },
);

it.each([
  ['缺 url', { route: 'ExternalPage', params: {} }],
  ['没有 params', { route: 'ExternalPage' }],
  ['http 地址', external('http://brand.test/a')],
  ['url 是数字', { route: 'ExternalPage', params: { url: 1 } }],
  ['nav_style 不在枚举', external('https://brand.test/a', { nav_style: 'blue' })],
  ['title 超过 20', external('https://brand.test/a', { title: chars(21) })],
  ['多余参数', external('https://brand.test/a', { hide_nav: true })],
])('[AC-B1-05m#11] 直达：ExternalPage %s → 拒绝', (_label, target) => {
  expect(routesFit([shortcut('官网', target)])).toBe(false);
});

it.each(UNION_URLS)(
  '[AC-B1-05m#12] BR-ATTR-29 ①：开关开着时 ExternalPage 指向联盟平台网页域名 %s → 拒绝',
  (url) => {
    expect(searchKeywordRoutesFit([shortcut('大促', external(url))], BLOCK_ON)).toBe(false);
  },
);

it.each(OTHER_URLS)(
  '[AC-B1-05m#13] BR-ATTR-29 ①：不在联盟域名的 ExternalPage %s 可存（只看主机，promo 形态不用于 ①）',
  (url) => {
    expect(searchKeywordRoutesFit([shortcut('官网', external(url))], BLOCK_ON)).toBe(true);
  },
);

it('[AC-B1-05m#14] 开关 external_page.union_host_block 关闭时联盟域外链可存，其余校验照旧', () => {
  const off = (item: unknown) => searchKeywordRoutesFit([item], BLOCK_OFF);
  for (const url of UNION_URLS) expect(off(shortcut('大促', external(url))), url).toBe(true);
  expect(off(shortcut('大促', { route: 'HotRank' }))).toBe(false);
  expect(off(shortcut('大促', external('http://brand.test/')))).toBe(false);
  expect(off(shortcut('', { route: 'HotRankList' }))).toBe(false);
});

it.each([
  ['联盟域外链', shortcut('大促', external('https://union-a.test/promo'))],
  ['路由不在表里', shortcut('大促', { route: 'Promo' })],
  ['缺必填参数', shortcut('爆款', { route: 'ProductDetail', params: { platform: 'jd' } })],
  ['keyword 为空', shortcut('', { route: 'HotRankList' })],
])('[AC-B1-05m#15] 直达：合法项中混一项%s → 整条拒绝，不做部分保存', (_label, bad) => {
  for (const at of [0, 2, validRoutes().length]) {
    const value: unknown[] = validRoutes();
    value.splice(at, 0, bad);
    expect(routesFit(value), `at ${at}`).toBe(false);
  }
});

it('[AC-B1-05m#16] 直达：超出契约（keyword 21 字、51 条）拒绝——读接口按配置原样返回', () => {
  expect(routesFit([shortcut(chars(21), { route: 'HotRankList' })])).toBe(false);
  expect(routesFit(manyRoutes(51))).toBe(false);
});

it('[AC-B1-05m#17] 两个键各按各的形状：热词的值不能当直达存，直达的值不能当热词存', () => {
  expect(searchHotWordsFit(validRoutes())).toBe(false);
  expect(routesFit(validHotWords())).toBe(false);
});
