// B1-28l: the whole union side at once, fake adapter → wiring → cache → getHotRank: what the wiring
// drops leaves a gap in the delivered ranks, and a repeated request served by the cache, or by an
// old entry on a union failure, delivers the same ones.
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { fixture, hotRank, memoryRedis } from '../hot-rank-upstream/kit.ts';
import { DEFAULT_TTL_SECONDS } from '../hot-rank/kit.ts';
import { channelEntries, ranks, rows, type SlotKind } from './kit.ts';

it('[AC-B1-28l#17][BR-TEXT-17] 有丢弃时名次为频道原始名次；重复请求走缓存，名次相同、不再调 adapter', async () => {
  const f = fixture();
  f.fake('taobao').setPage({
    items: channelEntries(['keep', 'underivable', 'keep', 'foreign', 'underivable', 'keep']),
    hasMore: false,
  });
  const run = hotRank(f, { redis: memoryRedis().redis });

  const first = await run();
  const calls = f.fake('taobao').rankingCalls.length;
  const second = await run();

  expect(rows(first)).toEqual([
    [1, 'synthetic-good-1', '1件'],
    [3, 'synthetic-good-3', '3件'],
    [6, 'synthetic-good-6', '6件'],
  ]);
  expect(rows(second)).toEqual(rows(first));
  expect(f.fake('taobao').rankingCalls.length).toBe(calls);
});

it('[AC-B1-28l#18] 跨页：两页都有丢弃时名次按频道位置连续、不重叠，第 2 页走缓存后不变', async () => {
  const f = fixture();
  const pageOne = new Array<SlotKind>(20).fill('keep');
  pageOne[2] = 'underivable';
  pageOne[7] = 'underivable';
  f.fake('taobao').setPage({ items: channelEntries(pageOne), hasMore: true });
  const run = hotRank(f, { redis: memoryRedis().redis });

  const first = await run();
  f.fake('taobao').setPage({
    items: channelEntries(['underivable', 'keep', 'foreign', 'keep'], 21),
    hasMore: false,
  });
  const cursor = first.next_cursor!;
  const second = await run({ cursor });
  const again = await run({ cursor });

  expect(ranks(first)).toEqual([1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  expect(rows(second)).toEqual([
    [22, 'synthetic-good-22', '22件'],
    [24, 'synthetic-good-24', '24件'],
  ]);
  expect(rows(again)).toEqual(rows(second));
});

it('[AC-B1-28l#19] 联盟故障读旧副本：经 wiring 存下的空号原样保留', async () => {
  const f = fixture();
  f.fake('taobao').setPage({
    items: channelEntries(['foreign', 'keep', 'underivable', 'keep']),
    hasMore: false,
  });
  const run = hotRank(f, { redis: memoryRedis().redis });
  await run();

  f.clock.advanceMs((DEFAULT_TTL_SECONDS + 60) * 1000);
  f.fake('taobao').fail(new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'));

  expect(ranks(await run())).toEqual([2, 4]);
});

it('[AC-B1-28l#20] wiring 丢弃与出卡跳过同页：经缓存后两种空号都在', async () => {
  const f = fixture();
  f.fake('taobao').setPage({
    items: channelEntries(['keep', 'underivable', 'anomaly', 'keep', 'foreign', 'anomaly', 'keep']),
    hasMore: false,
  });
  const run = hotRank(f, { redis: memoryRedis().redis });

  expect(ranks(await run())).toEqual([1, 4, 7]);
  expect(ranks(await run())).toEqual([1, 4, 7]);
});
