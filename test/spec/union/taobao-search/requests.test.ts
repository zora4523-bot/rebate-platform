import { expect, it } from 'vitest';
import type { CallCtx } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  convertAll,
  ctx,
  DATAOKE_APP_KEY,
  DATAOKE_BASE,
  dtkRow,
  expectNothingSent,
  expectTrueIdentities,
  goodsNumber,
  KEYWORD,
  query,
  queryFields,
  search,
  searchData,
  searchFields,
  SEARCH_PATH,
  SEARCH_VERSION,
  sent,
  setup,
  topIdLists,
  unionFailure,
} from './kit.ts';

// 搜索请求、游标与数据源开关（D10-503 ②）：经大淘客客户端 GET get-dtk-search-goods v2.1.2，
// 业务参数 keyWords / pageId / pageSize 20 / sort 0，归档 kind = query；开关默认关。

/** n-th row of page `page` when every page holds 20 rows (rows numbered from 1). */
function pageRows(page: number, count: number) {
  return Array.from({ length: count }, (_unused, i) => dtkRow((page - 1) * 20 + i + 1));
}

it('[AC-B1-04zh#1] 首页：GET 网关 + get-dtk-search-goods，version v2.1.2，业务参数只有 keyWords 原样 / pageId 1 / pageSize 20 / sort 0；归档 kind = query', async () => {
  const h = setup();
  await search(h);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  const request = sent(h.dataokeTransport);
  expect(request.platform).toBe('taobao');
  expect(request.method).toBe('GET');
  expect(request.body).toBeUndefined();
  const url = new URL(request.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${DATAOKE_BASE}${SEARCH_PATH}`);
  const fields = queryFields(request);
  expect(fields['version']).toBe(SEARCH_VERSION);
  expect(fields['appKey']).toBe(DATAOKE_APP_KEY);
  expect(searchFields(h)).toEqual({ keyWords: KEYWORD, pageId: '1', pageSize: '20', sort: '0' });
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'query' });
});

it('[AC-B1-04zh#2] 调用方 AbortSignal 原样挂在搜索请求与换算请求上', async () => {
  const controller = new AbortController();
  const withSignal: CallCtx = { ...ctx, signal: controller.signal };
  const h = setup();
  await search(h, query, withSignal);
  expect(sent(h.dataokeTransport).signal).toBe(controller.signal);
  expect(h.taobaoTransport).toHaveBeenCalled();
  for (const [request] of h.taobaoTransport.mock.calls) {
    expect(request.signal).toBe(controller.signal);
  }
});

it('[AC-B1-04zh#3] 游标续页：满页且未到 totalNum 给 nextCursor，续传后 pageId 递增、关键词照旧；最后一页 nextCursor = null', async () => {
  // totalNum 165：第 1–8 页各 20 条，第 9 页 5 条。
  const h = setup({
    data: (pageId) => {
      const page = Number(pageId ?? '1');
      return searchData(pageRows(page, page < 9 ? 20 : 5), 165, page);
    },
  });
  const seen: number[] = [];
  let cursor: string | undefined;
  for (let round = 0; round < 12; round += 1) {
    const page = await search(h, cursor === undefined ? query : { keyword: KEYWORD, cursor });
    seen.push(...expectTrueIdentities(page));
    if (page.nextCursor === null) break;
    expect(typeof page.nextCursor).toBe('string');
    cursor = page.nextCursor;
  }
  expect(h.dataokeTransport).toHaveBeenCalledTimes(9);
  const pageIds = h.dataokeTransport.mock.calls.map((_call, i) => searchFields(h, i)['pageId']);
  expect(pageIds).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  for (let i = 0; i < 9; i += 1) expect(searchFields(h, i)['keyWords']).toBe(KEYWORD);
  expect(seen).toEqual(Array.from({ length: 165 }, (_unused, i) => i + 1));
});

it('[AC-B1-04zh#4] 满页但 pageId × 20 已达 totalNum → nextCursor = null', async () => {
  const h = setup({ data: () => searchData(pageRows(1, 20), 20, 1) });
  const page = await search(h);
  expect(page.items).toHaveLength(20);
  expect(page.nextCursor).toBeNull();
});

it('[AC-B1-04zh#5] 有条目被跳过或换不到时，下一页仍按原始条数判断（满页照给 nextCursor）', async () => {
  const rows = pageRows(1, 20);
  rows[3] = dtkRow(4, { title: null, dtitle: null }); // 缺标题 → 跳过
  const h = setup({
    data: () => searchData(rows, 165, 1),
    // 第 7 条换不到（详情无该商品）。
    available: (goodsId) => (goodsNumber(goodsId) === 7 ? undefined : convertAll(goodsId)),
  });
  const page = await search(h);
  const numbers = expectTrueIdentities(page);
  expect(numbers).not.toContain(4);
  expect(numbers).not.toContain(7);
  expect(page.nextCursor).not.toBeNull();
});

it.each(['garbage', '', 'pdd-search:2:', 'pdd-feed:20', '2'])(
  '[AC-B1-04zh#6] 非法游标 %j → invalid_dto，不取凭据、不发请求',
  async (cursor) => {
    const h = setup();
    await unionFailure(
      () => h.adapter.searchItems({ keyword: KEYWORD, cursor }, ctx),
      'invalid_dto',
    );
    expectNothingSent(h);
  },
);

it('[AC-B1-04zh#7] 结果为空 → 空页（items 空、nextCursor null），不调换算', async () => {
  const h = setup({ data: () => searchData([], 0, 1) });
  const page = await search(h);
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toBeNull();
  expect(h.taobaoTransport).not.toHaveBeenCalled();
});

it.each(['absent', 'official'] as const)(
  '[AC-B1-04zh#8] 有大淘客客户端但开关 %s → searchItems 行为不变（adapter_unimplemented，不取不发）；开关 dataoke 才搜索',
  async (searchSource) => {
    const off = setup({ searchSource });
    await unionFailure(() => off.adapter.searchItems(query, ctx), 'adapter_unimplemented');
    expectNothingSent(off);

    const on = setup({ searchSource: 'dataoke' });
    const page = await search(on);
    expect(expectTrueIdentities(page)).toEqual([1, 2, 3]);
    expect(on.dataokeTransport).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04zh#9] 开关 dataoke 但没有注入大淘客客户端 → adapter_unimplemented，不取不发；注入后才搜索', async () => {
  const bare = setup({ withSource: false, searchSource: 'dataoke' });
  await unionFailure(() => bare.adapter.searchItems(query, ctx), 'adapter_unimplemented');
  expectNothingSent(bare);

  const wired = setup({ withSource: true, searchSource: 'dataoke' });
  await search(wired);
  expect(wired.dataokeTransport).toHaveBeenCalledTimes(1);
  expect(topIdLists(wired).flat()).toHaveLength(3);
});
