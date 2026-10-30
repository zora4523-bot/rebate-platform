// B1-28l: `positions` goes through the hot list cache unchanged, under the same key in the page
// JSON, written only when the page has it. A hit and an old entry read on a union failure give the
// same ranks as the fresh answer. A stored `positions` that is not an array as long as the items of
// non-negative safe integers, strictly increasing, reads as unreadable: refetched, and never served
// on a union failure. A stored page without the key stays readable.
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { pageRequest } from '../hot-rank-upstream/kit.ts';
import { DEFAULT_TTL_SECONDS, dataOf, rejection, series } from '../hot-rank/kit.ts';
import { gapFixture, pageRows, positionsOf, ranks, storePositions } from './kit.ts';

it('[AC-B1-28l#11] positions 存进页 JSON 的同名键，命中时读回不变；没带 positions 的页不写这个键', async () => {
  const f = gapFixture({ cached: true });
  f.setGapPage(1, series('a', 3), [0, 2, 5]);
  f.setGapPage(2, series('b', 2, 4), null);

  const fresh = await f.gapUpstream.page(pageRequest());
  const hit = await f.gapUpstream.page(pageRequest());

  expect(f.page.mock.calls.length).toBe(1);
  expect(positionsOf(fresh)).toEqual([0, 2, 5]);
  expect(positionsOf(hit)).toEqual([0, 2, 5]);
  expect(pageRows(f.memory.rows).map((row) => row.entry.data['positions'])).toEqual([[0, 2, 5]]);

  await f.gapUpstream.page(pageRequest({ pageNo: 2 }));

  const carried = pageRows(f.memory.rows).map((row) => 'positions' in row.entry.data);
  expect(carried).toEqual([true, false]);
});

it('[AC-B1-28l#12] 不带 positions 的已存页照常可读：格式版本不变，命中不重新取，名次按下标', async () => {
  const f = gapFixture({ cached: true });
  f.setGapPage(1, series('a', 3), [0, 2, 5]);
  expect(ranks(await f.run())).toEqual([1, 3, 6]);
  expect(pageRows(f.memory.rows).map((row) => row.entry.v)).toEqual([1]);

  storePositions(f.memory.rows, undefined);

  expect(ranks(await f.run())).toEqual([1, 2, 3]);
  expect(f.page.mock.calls.length).toBe(1);
});

it('[AC-B1-28l#13] 缓存命中：名次与首次相同，不再取联盟', async () => {
  const f = gapFixture({ cached: true });
  f.setGapPage(1, series('a', 3), [0, 2, 5]);

  const first = await f.run();
  f.clock.advanceMs(60_000);
  const second = await f.run();

  expect(ranks(first)).toEqual([1, 3, 6]);
  expect(ranks(second)).toEqual([1, 3, 6]);
  expect(f.page.mock.calls.length).toBe(1);
});

it('[AC-B1-28l#14] 联盟故障读已过期的旧副本：名次与当初相同，空号还在', async () => {
  const f = gapFixture({ cached: true });
  f.setGapPage(1, series('a', 3), [0, 2, 5]);
  await f.run();

  f.clock.advanceMs((DEFAULT_TTL_SECONDS + 60) * 1000);
  f.fail(new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'));

  expect(ranks(await f.run())).toEqual([1, 3, 6]);
});

const BAD_POSITIONS: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: '比条目短', value: [0, 2] },
  { label: '比条目长', value: [0, 2, 5, 7] },
  { label: '空数组', value: [] },
  { label: '相等、不严格递增', value: [0, 2, 2] },
  { label: '递减', value: [5, 2, 0] },
  { label: '负数', value: [-1, 2, 5] },
  { label: '非整数', value: [0, 1.5, 5] },
  { label: '超出安全整数', value: [0, 2, 2 ** 53] },
  { label: '元素是字符串', value: [0, '2', 5] },
  { label: '元素是 null', value: [0, null, 5] },
  { label: '字符串', value: '0,2,5' },
  { label: '数字', value: 3 },
  { label: '对象', value: { 0: 0, 1: 2, 2: 5, length: 3 } },
  { label: 'null', value: null },
];

it.each(BAD_POSITIONS)(
  '[AC-B1-28l#15] 存储里 positions 坏（$label）→ 缓存期内也按读不出重新取数，名次取新答案',
  async ({ value }) => {
    const f = gapFixture({ cached: true });
    f.setGapPage(1, series('old', 3), [0, 2, 5]);
    await f.run();
    storePositions(f.memory.rows, value);
    f.setGapPage(1, series('new', 2), [1, 3]);

    const data = await f.run();

    expect(f.page.mock.calls.length).toBe(2);
    expect(ranks(data)).toEqual([2, 4]);
  },
);

it.each(BAD_POSITIONS)(
  '[AC-B1-28l#16] 存储里 positions 坏（$label）且联盟故障 → 不拿坏副本下发，50304 不带 reason',
  async ({ value }) => {
    const f = gapFixture({ cached: true });
    f.setGapPage(1, series('old', 3), [0, 2, 5]);
    await f.run();
    storePositions(f.memory.rows, value);
    f.fail(new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'));

    const error = await rejection(() => f.run());

    expect(error).toMatchObject({ code: 50304 });
    expect(dataOf(error)?.['reason']).toBeUndefined();
  },
);
