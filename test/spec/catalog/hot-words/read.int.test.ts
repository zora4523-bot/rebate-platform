// B1-05m: GET /v1/search/hot-words on the api entry as assembled for production (app.module's
// configuration reader over config_items): the caller's app rows, in their stored order; an app
// without rows reads empty lists, and rows of another app are never returned. Anonymous, no
// device id (contracts getSearchHotWords).
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import { putRow } from '../../content/config-items/kit.ts';
import {
  HOT_WORDS,
  KEYWORD_ROUTES,
  PATH,
  expectContract,
  external,
  shortcut,
  validHotWords,
} from './kit.ts';

const h = useHarness();
const appId = () => `b105m_${randomBytes(6).toString('hex')}`;

async function read(app: Awaited<ReturnType<typeof fixture>>['app'], id: string) {
  const response = await app.inject({
    method: 'GET',
    url: PATH,
    headers: { 'x-app-id': id, 'x-platform': 'ios', 'x-app-version': '1.2.3' },
  });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  const body = response.json<{ code: number; data: unknown }>();
  expect(body.code).toBe(0);
  await expectContract(body, 'SearchHotWordsResponse');
  return body.data;
}

it('[AC-B1-05m#35] 生产装配的 api 入口按本 app 存的顺序返回两个键；没有行的 app 读到两个空列表', async () => {
  const f = await fixture(h, { entry: 'api' });
  const configured = appId();
  const words = [{ text: '洗衣液' }, ...validHotWords()];
  const routes = [
    shortcut('官网', external('https://brand.test/a')),
    shortcut('热销榜', { route: 'HotRankList', params: {} }),
  ];
  await putRow(h, configured, HOT_WORDS, words, 2);
  await putRow(h, configured, KEYWORD_ROUTES, routes, 5);
  const other = appId();
  expect(await read(f.app, configured)).toEqual({ hot_words: words, keyword_routes: routes });
  expect(await read(f.app, other)).toEqual({ hot_words: [], keyword_routes: [] });
});

it('[AC-B1-05m#36] 存的是空列表 [] 时读到空列表；只存了热词时直达为空列表', async () => {
  const f = await fixture(h, { entry: 'api' });
  const empty = appId();
  await putRow(h, empty, HOT_WORDS, []);
  await putRow(h, empty, KEYWORD_ROUTES, []);
  expect(await read(f.app, empty)).toEqual({ hot_words: [], keyword_routes: [] });
  const wordsOnly = appId();
  await putRow(h, wordsOnly, HOT_WORDS, validHotWords());
  expect(await read(f.app, wordsOnly)).toEqual({ hot_words: validHotWords(), keyword_routes: [] });
});
