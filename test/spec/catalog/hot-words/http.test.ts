// B1-05m GET /v1/search/hot-words (contracts getSearchHotWords: x-auth none, OptionalDeviceId,
// SearchHotWordsResponse; 编排裁定 D10-419 (a) 1 / 3): the two configuration items of the caller's
// app, returned in their configured order as stored; no row or an empty list gives empty lists, no
// hot word is made up; readable anonymously in basic mode without a device id; the operation is no
// longer planned. The api entry is real; only catalog's configuration port is replaced (kit).
import { afterEach, expect, it, vi } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import {
  APP_ID,
  HOT_WORDS,
  KEYWORD_ROUTES,
  OPERATION_ID,
  PATH,
  TRACE_ID,
  anonymous,
  askedKeys,
  expectContract,
  external,
  fixture,
  shortcut,
  validHotWords,
  type Response,
} from './kit.ts';

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  try {
    await close?.();
  } finally {
    close = undefined;
    vi.restoreAllMocks();
  }
});

async function start(values: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(values);
  close = () => f.app.close();
  return f;
}

async function ok(response: Response) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  const body = response.json<{ code: number; msg: string; data: unknown; trace_id: string }>();
  expect(body).toMatchObject({ code: 0, msg: '', trace_id: TRACE_ID });
  await expectContract(body, 'SearchHotWordsResponse');
  return body.data;
}

const EMPTY = { hot_words: [], keyword_routes: [] };

const ROUTES = [
  shortcut('热销榜', { route: 'HotRankList', params: {} }),
  shortcut('官网', external('https://brand.test/a')),
  shortcut('耳机', { route: 'Search', params: { q: '蓝牙耳机' } }),
];

it('[AC-B1-05m#22] getSearchHotWords 不再是 planned，GET /v1/search/hot-words 已注册', async () => {
  const f = await start();
  expect(plannedOperations.has(OPERATION_ID)).toBe(false);
  expect(f.routes).toContain(`GET ${PATH}`);
});

it('[AC-B1-05m#23] 两个键都没有配置行 → 两个空列表，不编造热词', async () => {
  const f = await start();
  expect(await ok(await f.request())).toEqual(EMPTY);
  expect(askedKeys(f.configValue.mock.calls)).toEqual(
    expect.arrayContaining([`${APP_ID} ${HOT_WORDS}`, `${APP_ID} ${KEYWORD_ROUTES}`]),
  );
});

it('[AC-B1-05m#24] 两个键都配置为空列表 [] → 两个空列表', async () => {
  const f = await start({
    [HOT_WORDS]: { value: [], version: 1 },
    [KEYWORD_ROUTES]: { value: [], version: 1 },
  });
  expect(await ok(await f.request())).toEqual(EMPTY);
});

it('[AC-B1-05m#25] 按配置顺序原样返回热词与直达，读的是请求所属 app 的两个键', async () => {
  const words = [{ text: '洗衣液' }, ...validHotWords()];
  const f = await start({
    [HOT_WORDS]: { value: words, version: 3 },
    [KEYWORD_ROUTES]: { value: ROUTES, version: 2 },
  });
  expect(await ok(await f.request())).toEqual({ hot_words: words, keyword_routes: ROUTES });
  const asked = askedKeys(f.configValue.mock.calls);
  expect(asked).toEqual(
    expect.arrayContaining([`${APP_ID} ${HOT_WORDS}`, `${APP_ID} ${KEYWORD_ROUTES}`]),
  );
  expect(asked.every((entry) => entry.startsWith(`${APP_ID} `))).toBe(true);
});

it('[AC-B1-05m#26] 只配置了一个键：配置的照返回，另一个为空列表', async () => {
  const onlyWords = await start({ [HOT_WORDS]: { value: validHotWords(), version: 1 } });
  expect(await ok(await onlyWords.request())).toEqual({
    hot_words: validHotWords(),
    keyword_routes: [],
  });
  await onlyWords.app.close();
  vi.restoreAllMocks();
  const onlyRoutes = await start({ [KEYWORD_ROUTES]: { value: ROUTES, version: 1 } });
  expect(await ok(await onlyRoutes.request())).toEqual({ hot_words: [], keyword_routes: ROUTES });
});

it('[AC-B1-05m#27] 匿名可读：不带设备号、不带登录凭证（基础模式）照常 200', async () => {
  const f = await start({ [HOT_WORDS]: { value: validHotWords(), version: 1 } });
  expect(anonymous).not.toHaveProperty('x-device-id');
  expect(anonymous).not.toHaveProperty('authorization');
  expect(await ok(await f.request(anonymous))).toEqual({
    hot_words: validHotWords(),
    keyword_routes: [],
  });
  const withDevice = { ...anonymous, 'x-device-id': '01920000-0000-7000-8000-00000000d105' };
  expect(await ok(await f.request(withDevice))).toEqual({
    hot_words: validHotWords(),
    keyword_routes: [],
  });
});
