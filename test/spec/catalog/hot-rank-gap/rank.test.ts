// B1-28l: the use case numbers items by their channel position, not by their index in `items`
// (D10-422 ②; BR-TEXT-17 细则「联盟物料频道」: 热销榜页的名次按所选频道接口返回的顺序，本系统不重排):
// rank = (pageNo − 1) × 20 + position + 1 across pages. A dropped position leaves its number unused,
// beside the numbers the card entry already leaves unused (B1-28h); nothing is renumbered.
import { expect, it } from 'vitest';
import { PAGE_SIZE, TB_CHANNEL, assertSchema, candidate, series } from '../hot-rank/kit.ts';
import { anomalous, gapFixture, ranks, rows } from './kit.ts';

it('[AC-B1-28l#5][BR-TEXT-17] 上游带 positions [0, 2, 5]：第 1 页名次 1、3、6，顺序与 sales_text 不变，不按价格重排', async () => {
  const f = gapFixture();
  f.setGapPage(
    1,
    [
      candidate('a', { finalFen: 99_000n, salesText: '10万+' }),
      candidate('b', { finalFen: 100n, salesText: null }),
      candidate('c', { finalFen: 5_000n, salesText: '3件' }),
    ],
    [0, 2, 5],
  );

  const data = await f.run();

  expect(rows(data)).toEqual([
    [1, 'synthetic-a', '10万+'],
    [3, 'synthetic-b', null],
    [6, 'synthetic-c', '3件'],
  ]);
  await assertSchema(data, 'HotRankData');
});

it('[AC-B1-28l#6] 后续条目的名次不因前面丢弃而变：与频道没丢条目时各自的名次相同', async () => {
  const channelOrder = series('c', 8);
  const whole = gapFixture();
  whole.setGapPage(1, channelOrder, null);
  const undropped = rows(await whole.run());

  const kept = [0, 3, 4, 7];
  const f = gapFixture();
  f.setGapPage(
    1,
    kept.map((index) => channelOrder[index]!),
    kept,
  );

  expect(rows(await f.run())).toEqual(kept.map((index) => undropped[index]));
});

it('[AC-B1-28l#7] 第 2 页丢条目：名次为 20 + 位置 + 1，与第 1 页连续、不重叠', async () => {
  const f = gapFixture();
  f.setGapPage(1, series('p1', PAGE_SIZE, 1), null, true);
  f.setGapPage(2, series('p2', 3, 21), [1, 4, 19]);

  const first = await f.run();
  const second = await f.run({ cursor: first.next_cursor! });

  expect(ranks(first)).toEqual(Array.from({ length: PAGE_SIZE }, (_unused, index) => index + 1));
  expect(rows(second)).toEqual([
    [22, 'synthetic-p2-21', '21件'],
    [25, 'synthetic-p2-22', '22件'],
    [40, 'synthetic-p2-23', '23件'],
  ]);
});

it('[AC-B1-28l#8] 第 1 页丢条目不影响第 2 页的起点：第 1 页不足 20 条仍给 next_cursor，第 2 页首条仍是 21', async () => {
  const kept = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 19];
  const f = gapFixture();
  f.setGapPage(1, series('p1', kept.length, 1), kept, true);
  f.setGapPage(2, series('p2', 3, 21), null);

  const first = await f.run();
  expect(typeof first.next_cursor).toBe('string');
  const second = await f.run({ cursor: first.next_cursor! });

  expect(ranks(first)).toEqual(kept.map((index) => index + 1));
  expect(ranks(second)).toEqual([21, 22, 23]);
});

it('[AC-B1-28l#9] 类目榜连翻三页、每页都丢条目：名次按各页 first + 位置 + 1 接着算，严格递增', async () => {
  const f = gapFixture();
  const category = 'synthetic-digital';
  f.setCategories('taobao', TB_CHANNEL, [{ categoryId: category, name: '合成数码' }]);
  f.setGapPage(1, series('d1', 2, 1), [0, 19], true, category);
  f.setGapPage(2, series('d2', 2, 21), [0, 19], true, category);
  f.setGapPage(3, series('d3', 1, 41), [7], false, category);

  const first = await f.run({ category });
  const second = await f.run({ category, cursor: first.next_cursor! });
  const third = await f.run({ category, cursor: second.next_cursor! });

  expect([...ranks(first), ...ranks(second), ...ranks(third)]).toEqual([1, 20, 21, 40, 48]);
});

it('[AC-B1-28l#10] 丢弃与出卡跳过同页：两种空号并存，其余名次都是原始名次', async () => {
  const f = gapFixture();
  f.setGapPage(
    1,
    [
      candidate('a', { salesText: '1件' }),
      candidate('b', { salesText: '2件' }),
      anomalous(candidate('skipped-1')),
      candidate('c', { salesText: '3件' }),
      anomalous(candidate('skipped-2')),
      candidate('d', { salesText: '4件' }),
    ],
    [0, 2, 3, 5, 7, 8],
  );

  expect(rows(await f.run())).toEqual([
    [1, 'synthetic-a', '1件'],
    [3, 'synthetic-b', '2件'],
    [6, 'synthetic-c', '3件'],
    [9, 'synthetic-d', '4件'],
  ]);
});
