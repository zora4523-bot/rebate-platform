// B1-28l: the wiring keeps where each item sat in the channel page (D10-422 ②): when it drops a
// position without a product key or of another platform, the page carries `positions`, one per
// item, from 0 and strictly increasing, within that page. A page without drops stays exactly
// { items, hasMore } (frozen, B1-28j).
import { expect, it } from 'vitest';
import {
  JD_CHANNEL,
  JD_MODE_KEY,
  PDD_CHANNEL,
  fixture,
  jdItem,
  pageRequest,
  pddItem,
  position,
  tbItem,
} from '../hot-rank-upstream/kit.ts';
import { channelEntries, positionsOf, type SlotKind } from './kit.ts';

it('[AC-B1-28l#1][BR-TEXT-17] 频道页 [好, 丢, 好, 丢, 丢, 好]：items 3 条、positions 为 [0, 2, 5]，位置在页面级，条目仍只有 item、ref、salesText', async () => {
  const f = fixture();
  f.fake('taobao').setPage({
    items: channelEntries(['keep', 'underivable', 'keep', 'foreign', 'underivable', 'keep']),
    hasMore: true,
  });

  const page = await f.upstream().page(pageRequest());

  expect(page.items.map((entry) => entry.item.title)).toEqual([
    'synthetic-good-1',
    'synthetic-good-3',
    'synthetic-good-6',
  ]);
  expect(positionsOf(page)).toEqual([0, 2, 5]);
  expect(Object.keys(page).sort()).toEqual(['hasMore', 'items', 'positions']);
  for (const entry of page.items) {
    expect(Object.keys(entry).sort()).toEqual(['item', 'ref', 'salesText']);
  }
  expect(page.hasMore).toBe(true);
});

it('[AC-B1-28l#2] 丢在页首时 positions 不从 0 起；丢在页尾时 positions 与下标相同也照带（有条目被丢才带，看的是丢没丢）', async () => {
  const cases: readonly { kinds: readonly SlotKind[]; expected: readonly number[] }[] = [
    { kinds: ['foreign', 'keep', 'keep'], expected: [1, 2] },
    { kinds: ['underivable', 'foreign', 'keep'], expected: [2] },
    { kinds: ['keep', 'keep', 'underivable'], expected: [0, 1] },
  ];
  for (const { kinds, expected } of cases) {
    const f = fixture();
    f.fake('taobao').setPage({ items: channelEntries(kinds), hasMore: false });

    const page = await f.upstream().page(pageRequest());

    expect(positionsOf(page), kinds.join()).toEqual(expected);
  }
});

it('[AC-B1-28l#3] 各种丢法都留位置：京东 sku 口径缺 skuId、拼多多频道里混进别的平台', async () => {
  const f = fixture();
  f.settings.set(JD_MODE_KEY, 'sku');
  f.fake('jd').setPage({
    items: [
      position(jdItem('a', 1), '1'),
      position({ ...jdItem('no-sku', 2), skuId: null }, '2'),
      position(jdItem('b', 3), '3'),
    ],
    hasMore: false,
  });
  f.fake('pdd').setPage({
    items: [
      position(tbItem('foreign', 1), '1'),
      position(pddItem('a', 2), '2'),
      position(pddItem('b', 3), '3'),
    ],
    hasMore: false,
  });
  const upstream = f.upstream();

  const jd = await upstream.page(pageRequest({ platform: 'jd', channelId: JD_CHANNEL }));
  const pdd = await upstream.page(pageRequest({ platform: 'pdd', channelId: PDD_CHANNEL }));

  expect(positionsOf(jd)).toEqual([0, 2]);
  expect(positionsOf(pdd)).toEqual([1, 2]);
});

it('[AC-B1-28l#4] positions 是这一页里的位置：第 2 页的位置仍从 0 算，不带前面页的偏移', async () => {
  const f = fixture();
  f.fake('taobao').setPage({
    items: channelEntries(['underivable', 'keep', 'foreign', 'keep'], 21),
    hasMore: false,
  });

  const page = await f.upstream().page(pageRequest({ pageNo: 2 }));

  expect(positionsOf(page)).toEqual([1, 3]);
});
