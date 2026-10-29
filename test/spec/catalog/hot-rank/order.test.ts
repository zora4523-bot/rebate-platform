// B1-28h: items keep the order the channel returned, never reordered (BR-TEXT-17 细则 「热销榜页的
// 名次按所选频道接口返回的顺序，本系统不重排」; 规划/01 F-PROD-13 ②); rank counts from 1 across
// pages; sales_text is the union's sales field unchanged, null without one; notice_key rank.notice;
// page size 20 (contract getHotRank).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { PAGE_SIZE, TB_CHANNEL, assertSchema, candidate, fixture, series } from './kit.ts';

it('[AC-B1-28h#10] 名次按频道返回顺序：到手价、返利、销量都不参与排序，rank 从 1 起连续；sales_text 原样、无则 null；notice_key=rank.notice', async () => {
  const f = fixture();
  const channelOrder = [
    candidate('cheap-low', { finalFen: 100n, salesText: '1件' }),
    candidate('dear-high', { finalFen: 99_000n, salesText: '10万+' }),
    candidate('middle', { finalFen: 5_000n, couponFen: 500n, salesText: null }),
    candidate('cheapest', { finalFen: 50n, salesText: '近30天销量 2.3万' }),
    candidate('spaced', { finalFen: 7_777n, salesText: ' 销量（以平台返回为准）1,024 ' }),
  ];
  f.quotes.set('synthetic-cheap-low', { min: 1n, max: 1n });
  f.quotes.set('synthetic-dear-high', { min: 900n, max: 900n });
  f.quotes.set('synthetic-cheapest', { min: 5n, max: 8n });
  f.setPage('taobao', TB_CHANNEL, null, 1, channelOrder);

  const data = await f.run();

  expect(data.channel).toBe(TB_CHANNEL);
  expect(data.notice_key).toBe('rank.notice');
  expect(data.items.map((item) => [item.rank, item.product_card.title, item.sales_text])).toEqual([
    [1, 'synthetic-cheap-low', '1件'],
    [2, 'synthetic-dear-high', '10万+'],
    [3, 'synthetic-middle', null],
    [4, 'synthetic-cheapest', '近30天销量 2.3万'],
    [5, 'synthetic-spaced', ' 销量（以平台返回为准）1,024 '],
  ]);
  expect(data.next_cursor).toBeNull();
  await assertSchema(data, 'HotRankData');
});

it('[AC-B1-28h#11] 每页向频道要 20 条；第 1 页有更多时给 next_cursor，用它取第 2 页，rank 接着 21 起；最后一页 next_cursor=null', async () => {
  const f = fixture();
  f.setPage('taobao', TB_CHANNEL, null, 1, series('p1', PAGE_SIZE, 1), true);
  f.setPage('taobao', TB_CHANNEL, null, 2, series('p2', PAGE_SIZE, 21), true);
  f.setPage('taobao', TB_CHANNEL, null, 3, series('p3', 3, 41), false);

  const first = await f.run();
  expect(first.items.map((item) => item.rank)).toEqual(
    Array.from({ length: PAGE_SIZE }, (_unused, index) => index + 1),
  );
  expect(typeof first.next_cursor).toBe('string');

  const second = await f.run({ cursor: first.next_cursor! });
  expect(second.items.map((item) => item.rank)).toEqual(
    Array.from({ length: PAGE_SIZE }, (_unused, index) => index + 21),
  );
  expect(second.items[0]?.product_card.title).toBe('synthetic-p2-21');
  expect(second.items[0]?.sales_text).toBe('21件');
  expect(typeof second.next_cursor).toBe('string');

  const third = await f.run({ cursor: second.next_cursor! });
  expect(third.items.map((item) => [item.rank, item.product_card.title])).toEqual([
    [41, 'synthetic-p3-41'],
    [42, 'synthetic-p3-42'],
    [43, 'synthetic-p3-43'],
  ]);
  expect(third.next_cursor).toBeNull();

  expect(f.page.mock.calls.map(([input]) => [input.pageNo, input.pageSize])).toEqual([
    [1, PAGE_SIZE],
    [2, PAGE_SIZE],
    [3, PAGE_SIZE],
  ]);
  for (const page of [first, second, third]) await assertSchema(page, 'HotRankData');
});

it('[AC-B1-28h#12] 类目榜翻页：带同一 category 与 next_cursor 取该类目第 2 页，rank 从 21 接着计', async () => {
  const f = fixture();
  f.setCategories('taobao', TB_CHANNEL, [{ categoryId: 'synthetic-digital', name: '合成数码' }]);
  f.setPage('taobao', TB_CHANNEL, 'synthetic-digital', 1, series('d1', PAGE_SIZE, 1), true);
  f.setPage('taobao', TB_CHANNEL, 'synthetic-digital', 2, series('d2', 2, 21), false);

  const first = await f.run({ category: 'synthetic-digital' });
  const second = await f.run({ category: 'synthetic-digital', cursor: first.next_cursor! });

  expect(second.items.map((item) => [item.rank, item.product_card.title])).toEqual([
    [21, 'synthetic-d2-21'],
    [22, 'synthetic-d2-22'],
  ]);
  expect(f.page.mock.calls.at(-1)?.[0]).toMatchObject({
    platform: 'taobao',
    channelId: TB_CHANNEL,
    categoryId: 'synthetic-digital',
    pageNo: 2,
  });
  expect(second.categories).toEqual([{ category_id: 'synthetic-digital', name: '合成数码' }]);
});

const rowArb = fc.record({
  finalFen: fc.bigInt({ min: 100n, max: 10_000_000n }),
  rebateFen: fc.bigInt({ min: 1n, max: 99n }),
  sales: fc.option(
    fc.string({ minLength: 1, maxLength: 24 }).filter((text) => text.trim().length > 0),
    { nil: null },
  ),
});

it('[AC-B1-28h#13] 属性：任意价格、返利与销量字段的一页，下发顺序与频道顺序一致、rank=1..n、sales_text 与频道字段逐字相同', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(fc.array(rowArb, { minLength: 1, maxLength: PAGE_SIZE }), async (rows) => {
      const f = fixture();
      const items = rows.map((row, index) =>
        candidate(`prop-${index}`, { finalFen: row.finalFen, salesText: row.sales }),
      );
      rows.forEach((row, index) =>
        f.quotes.set(`synthetic-prop-${index}`, { min: row.rebateFen, max: row.rebateFen }),
      );
      f.setPage('taobao', TB_CHANNEL, null, 1, items);

      const data = await f.run();

      expect(
        data.items.map((item) => [item.rank, item.product_card.title, item.sales_text]),
      ).toEqual(rows.map((row, index) => [index + 1, `synthetic-prop-${index}`, row.sales]));
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
