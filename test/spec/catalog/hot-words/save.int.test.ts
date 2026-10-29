// B1-05m: the console's configuration center (PUT /admin/v1/config-items/{key}, POST /batch,
// POST /{key}/rollback; admin entry as assembled for production) runs the search.hot_words /
// search.keyword_routes checks (编排裁定 D10-419 (a) 2): a refused write is 20001 with nothing
// written, fields [value] for a single update, the refused keys for a batch, [to_version] for a
// rollback (the convention these routes already follow, F1-02zn / B2-11d); other keys keep their
// behaviour. external_page.union_host_block is read from the caller's app (no row = on, BR-ATTR-29).
// Only the link pattern table, which has no real domains yet, is replaced by synthetic domains
// (the same as kit LINK_PATTERNS); the rule values themselves are check.test.ts's.
import { expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  batch,
  current,
  putRow,
  rejected,
  rollback,
  setup,
  stepUp,
  success,
  update,
  written,
  type Item,
  type Setup,
} from '../../content/config-items/kit.ts';
import {
  HOT_WORDS,
  KEYWORD_ROUTES,
  UNION_HOST_BLOCK,
  external,
  shortcut,
  validHotWords,
  validRoutes,
} from './kit.ts';

vi.mock('../../../../apps/api/src/modules/platform/specs/link-patterns.ts', () => ({
  getLinkPatterns: () => ({
    version: 'b105m-synthetic',
    rules: [
      {
        platform: 'taobao',
        category: 'union_host',
        hosts: ['union-a.test', 'union-tm.test'],
        path_patterns: [],
      },
      { platform: 'jd', category: 'union_host', hosts: ['union-b.test'], path_patterns: [] },
      {
        platform: 'taobao',
        category: 'product',
        hosts: ['item.union-a.test'],
        path_patterns: ['/item/**'],
      },
      { platform: 'pdd', category: 'promo', hosts: ['promo.test'], path_patterns: ['/**'] },
    ],
  }),
}));

const h = useHarness();
const OTHER_OBJECT_KEY = 'payout.definite_fail_codes';
const UNION_ROUTE = shortcut('大促', external('https://m.union-a.test/act/1111'));

/** PUT `key` = `value` with a fresh totp step-up (config.business). */
async function put(f: Setup, key: string, value: unknown, expectedVersion: number) {
  return update(f, key, { value, expected_version: expectedVersion }, { stepUp: await stepUp(f) });
}

async function refusedValue(f: Setup, key: string, value: unknown, expectedVersion: number) {
  await rejected(await put(f, key, value, expectedVersion), 'update', 20001, { fields: ['value'] });
}

async function saved(f: Setup, key: string, value: unknown, expectedVersion: number) {
  const item = await success<Item>(await put(f, key, value, expectedVersion), 'update');
  expect(item).toMatchObject({ key, value, version: expectedVersion + 1 });
}

it('[AC-B1-05m#28] 单条保存热词：合法可存；混一项空白 text、text 超 20 字、多余字段 → 20001 [value]，旧值不变', async () => {
  const f = await setup(h);
  await refusedValue(f, HOT_WORDS, [...validHotWords(), { text: ' ' }], 0);
  expect(await current(h, f.appId, HOT_WORDS)).toBeUndefined();
  await saved(f, HOT_WORDS, validHotWords(), 0);
  await refusedValue(f, HOT_WORDS, [{ text: '洗衣液' }, { text: '' }], 1);
  await refusedValue(f, HOT_WORDS, [{ text: '热'.repeat(21) }], 1);
  await refusedValue(f, HOT_WORDS, [{ text: '洗衣液', weight: 1 }], 1);
  expect(await current(h, f.appId, HOT_WORDS)).toMatchObject({
    value: validHotWords(),
    version: 1,
  });
  await saved(f, HOT_WORDS, [], 1);
});

it('[AC-B1-05m#29] BR-ATTR-29 ①：没有开关行时按开启，直达的 ExternalPage 指向联盟域名 → 20001 [value]、不写；非联盟域外链可存', async () => {
  const f = await setup(h);
  await refusedValue(f, KEYWORD_ROUTES, [UNION_ROUTE], 0);
  await refusedValue(f, KEYWORD_ROUTES, [...validRoutes(), UNION_ROUTE], 0);
  expect(await current(h, f.appId, KEYWORD_ROUTES)).toBeUndefined();
  await saved(f, KEYWORD_ROUTES, validRoutes(), 0);
  await refusedValue(f, KEYWORD_ROUTES, [UNION_ROUTE, ...validRoutes()], 1);
  expect(await current(h, f.appId, KEYWORD_ROUTES)).toMatchObject({
    value: validRoutes(),
    version: 1,
  });
});

it('[AC-B1-05m#30] 本 app 的 external_page.union_host_block=false 时联盟域外链可存；=true 时拒绝', async () => {
  const off = await setup(h);
  await putRow(h, off.appId, UNION_HOST_BLOCK, false);
  await saved(off, KEYWORD_ROUTES, [UNION_ROUTE], 0);
  const on = await setup(h);
  await putRow(h, on.appId, UNION_HOST_BLOCK, true);
  await refusedValue(on, KEYWORD_ROUTES, [UNION_ROUTE], 0);
  expect(await current(h, on.appId, KEYWORD_ROUTES)).toBeUndefined();
});

it('[AC-B1-05m#31] 单条保存直达：keyword 为空、路由不在表里、缺必填参数、类型错、多余参数、非 https 外链 → 20001 [value]、不写', async () => {
  const f = await setup(h);
  const bad = [
    shortcut('', { route: 'HotRankList' }),
    shortcut('热销榜', { route: 'HotRank' }),
    shortcut('爆款', { route: 'ProductDetail', params: { platform: 'taobao' } }),
    shortcut('爆款', { route: 'ProductDetail', params: { platform: 'taobao', product_key: 1 } }),
    shortcut('耳机', { route: 'Search', params: { keyword: '耳机' } }),
    shortcut('官网', external('http://brand.test/a')),
  ];
  for (const item of bad) await refusedValue(f, KEYWORD_ROUTES, [...validRoutes(), item], 0);
  expect(await current(h, f.appId, KEYWORD_ROUTES)).toBeUndefined();
});

it('[AC-B1-05m#32] 批量保存：任一键的值非法整批拒绝，fields 为被拒的键、两键都不写；都合法时一起写入', async () => {
  const f = await setup(h);
  const routesBad = await batch(
    f,
    {
      items: [
        { key: HOT_WORDS, value: validHotWords(), expected_version: 0 },
        { key: KEYWORD_ROUTES, value: [...validRoutes(), UNION_ROUTE], expected_version: 0 },
      ],
    },
    { stepUp: await stepUp(f) },
  );
  await rejected(routesBad, 'batch', 20001, { fields: [KEYWORD_ROUTES] });
  const wordsBad = await batch(
    f,
    {
      items: [
        { key: HOT_WORDS, value: [{ text: '\t' }], expected_version: 0 },
        { key: KEYWORD_ROUTES, value: validRoutes(), expected_version: 0 },
      ],
    },
    { stepUp: await stepUp(f) },
  );
  await rejected(wordsBad, 'batch', 20001, { fields: [HOT_WORDS] });
  expect(await current(h, f.appId, HOT_WORDS)).toBeUndefined();
  expect(await current(h, f.appId, KEYWORD_ROUTES)).toBeUndefined();
  await success(
    await batch(
      f,
      {
        items: [
          { key: HOT_WORDS, value: validHotWords(), expected_version: 0 },
          { key: KEYWORD_ROUTES, value: validRoutes(), expected_version: 0 },
        ],
      },
      { stepUp: await stepUp(f) },
    ),
    'batch',
  );
  expect(await current(h, f.appId, HOT_WORDS)).toMatchObject({
    value: validHotWords(),
    version: 1,
  });
  expect(await current(h, f.appId, KEYWORD_ROUTES)).toMatchObject({
    value: validRoutes(),
    version: 1,
  });
});

it('[AC-B1-05m#33] 回滚到非法的历史值同样拒绝 → 20001 [to_version]、不写；回滚到合法历史值可存', async () => {
  const f = await setup(h);
  const words = [[{ text: ' ' }], [{ text: '洗衣液' }], validHotWords()];
  await written(h, f.appId, HOT_WORDS, words, f.actor);
  await written(h, f.appId, KEYWORD_ROUTES, [[UNION_ROUTE], validRoutes()], f.actor);
  for (const [key, expected] of [
    [HOT_WORDS, 3],
    [KEYWORD_ROUTES, 2],
  ] as const) {
    await rejected(
      await rollback(
        f,
        key,
        { to_version: 1, expected_version: expected },
        { stepUp: await stepUp(f) },
      ),
      'rollback',
      20001,
      { fields: ['to_version'] },
    );
    expect(await current(h, f.appId, key)).toMatchObject({ version: expected });
  }
  expect(await current(h, f.appId, HOT_WORDS)).toMatchObject({ value: validHotWords() });
  expect(await current(h, f.appId, KEYWORD_ROUTES)).toMatchObject({ value: validRoutes() });
  const item = await success<Item>(
    await rollback(
      f,
      HOT_WORDS,
      { to_version: 2, expected_version: 3 },
      { stepUp: await stepUp(f) },
    ),
    'rollback',
  );
  expect(item).toMatchObject({ key: HOT_WORDS, value: [{ text: '洗衣液' }], version: 4 });
});

it('[AC-B1-05m#34] 只对这两个键生效：同一个值存别的对象配置项照常成功，存热词拒绝', async () => {
  const f = await setup(h);
  const value = [{ text: '' }];
  await refusedValue(f, HOT_WORDS, value, 0);
  await saved(f, OTHER_OBJECT_KEY, value, 0);
  expect(await current(h, f.appId, OTHER_OBJECT_KEY)).toMatchObject({ value, version: 1 });
  await saved(f, OTHER_OBJECT_KEY, [UNION_ROUTE], 1);
  await refusedValue(f, KEYWORD_ROUTES, [UNION_ROUTE], 0);
});
