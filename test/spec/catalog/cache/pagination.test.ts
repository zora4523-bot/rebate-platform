import { expect, it } from 'vitest';
import { candidate } from '../search/kit.ts';
import { searchCache } from './kit.ts';

it('[AC-B1-05g#17] 联盟页号进入缓存键，我方会话不进入；去重后不能覆盖原始缓存页', async () => {
  const f = searchCache();
  const a = candidate('page-a').item;
  const b = candidate('page-b').item;
  f.searchItems.mockImplementation(async (query) =>
    query.cursor === undefined
      ? { items: [a], nextCursor: 'synthetic-union-page-two' }
      : { items: [a, b], nextCursor: null },
  );
  const first = await f.run();
  expect(first.next_cursor).toEqual(expect.any(String));
  const second = await f.run({ cursor: first.next_cursor! });
  expect(second.items.map((card) => card.title)).toEqual([b.title]);
  const calls = f.searchItems.mock.calls.length;
  f.setViewer({ userId: 'synthetic-other-user' });
  const fresh = await f.run();
  const freshSecond = await f.run({ cursor: fresh.next_cursor! });
  expect(f.searchItems).toHaveBeenCalledTimes(calls);
  expect(fresh.items.map((card) => card.title)).toEqual([a.title]);
  expect(freshSecond.items.map((card) => card.title)).toEqual([b.title]);
  expect(fresh.next_cursor).not.toBe(first.next_cursor);
  // Direct upstream read proves the cached page retains a, which session filtering removed.
  const rawPage = await f.upstream.search({
    appId: 'synthetic_cache',
    platform: 'taobao',
    keyword: 'synthetic milk',
    pageNo: 2,
    pageSize: 1,
    sort: 'relevance',
    promotionSlot: 'synthetic-query-pid',
  });
  expect(rawPage.items.map(({ item }) => item.title)).toEqual([a.title, b.title]);
  expect(f.searchItems).toHaveBeenCalledTimes(calls);
});
