// B1-17c (round 2, review r1 S1 on search.test.ts): the search hook covers every fresh union
// candidate, not only the cards delivered to the viewer. Candidates dropped by the price filter,
// by no_rebate, by the limit slice, by session deduplication, and those of the refill page are
// all fresh union returns of the same query (BR-WATCH-19 (1): 搜索的联盟返回在响应后异步写入).
import { expect, it } from 'vitest';
import { searchProducts } from '../../../../apps/api/src/modules/catalog/search.ts';
import { QUERY, candidate, fixture } from '../search/kit.ts';
import { byKey, hookRecorder } from './kit.ts';

it('[AC-B1-17c#18] 搜索：被价格上限、无返利、limit 截断滤掉的新鲜候选与补页候选同样交出并写入，响应只含交付的卡片', async () => {
  const f = fixture();
  const hook = hookRecorder(f.clock);
  const options = { ...f.options, priceHistory: hook.recorder };
  f.quotes.set('synthetic-z', { min: 0n, max: 0n });
  f.pages.set(1, {
    items: [candidate('a', 1000n), candidate('b', 1500n), candidate('z', 1100n)],
    hasMore: true,
    fresh: true,
  });
  f.pages.set(2, {
    items: [candidate('c', 900n), candidate('d', 1100n), candidate('e', 800n)],
    hasMore: false,
    fresh: true,
  });
  const data = await searchProducts({ ...QUERY, limit: 2, price_max_fen: 1200 }, options);
  expect(data.items.map((card) => card.title)).toEqual(['synthetic-a', 'synthetic-c']);
  expect(f.search.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 2]);
  await hook.recorder.drain();
  expect(
    byKey(hook.observations).map((row) => [
      row.productKey,
      row.finalPriceFen,
      row.sourceKind,
      row.fresh,
    ]),
  ).toEqual([
    ['tb:synthetic-a', 1000n, 'search', true],
    ['tb:synthetic-b', 1500n, 'search', true],
    ['tb:synthetic-c', 900n, 'search', true],
    ['tb:synthetic-d', 1100n, 'search', true],
    ['tb:synthetic-e', 800n, 'search', true],
    ['tb:synthetic-z', 1100n, 'search', true],
  ]);
  expect(byKey(hook.writes).map((row) => row.productKey)).toEqual([
    'tb:synthetic-a',
    'tb:synthetic-b',
    'tb:synthetic-c',
    'tb:synthetic-d',
    'tb:synthetic-e',
    'tb:synthetic-z',
  ]);
});

it('[AC-B1-17c#19] 搜索：续页里被会话去重排除的新鲜候选同样交出并写入，响应只含未下发过的卡片', async () => {
  const f = fixture();
  const hook = hookRecorder(f.clock);
  const options = { ...f.options, priceHistory: hook.recorder };
  f.pages.set(1, { items: [candidate('a', 1000n)], hasMore: true, fresh: true });
  f.pages.set(2, {
    items: [candidate('a', 1000n), candidate('f', 700n)],
    hasMore: false,
    fresh: true,
  });
  const first = await searchProducts({ ...QUERY, limit: 1 }, options);
  expect(first.items.map((card) => card.title)).toEqual(['synthetic-a']);
  expect(first.next_cursor).toEqual(expect.any(String));
  const second = await searchProducts({ ...QUERY, limit: 1, cursor: first.next_cursor! }, options);
  expect(second.items.map((card) => card.title)).toEqual(['synthetic-f']);
  expect(f.search.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 2]);
  await hook.recorder.drain();
  expect(
    byKey(hook.observations).map((row) => [row.productKey, row.sourceKind, row.fresh]),
  ).toEqual([
    ['tb:synthetic-a', 'search', true],
    ['tb:synthetic-a', 'search', true],
    ['tb:synthetic-f', 'search', true],
  ]);
  expect([...new Set(hook.writes.map((row) => row.productKey))].sort()).toEqual([
    'tb:synthetic-a',
    'tb:synthetic-f',
  ]);
});
