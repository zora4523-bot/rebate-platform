// B1-28h: categories come from the channel used (规划/01 F-PROD-13 ⑤, not aligned across platforms);
// the query's category takes only a category_id of that list (04 §6.3; contract getHotRank).
import { expect, it } from 'vitest';
import { TB_CHANNEL, candidate, channel, fixture, rejection } from './kit.ts';

const TB_CATEGORIES = [
  { categoryId: 'synthetic-digital', name: '合成数码' },
  { categoryId: 'synthetic-home', name: '合成家居' },
];

it('[AC-B1-28h#7] categories 取所用频道给的类目，按频道给的顺序原样下发 category_id 与 name；带 category 时同样下发整份列表', async () => {
  const f = fixture();
  f.setCategories('taobao', TB_CHANNEL, TB_CATEGORIES);
  f.setCategories('jd', 'synthetic_jd_sales', [
    { categoryId: 'synthetic-jd-only', name: '京东合成' },
  ]);
  f.setChannels([channel('taobao', TB_CHANNEL), channel('jd', 'synthetic_jd_sales')]);
  const expected = [
    { category_id: 'synthetic-digital', name: '合成数码' },
    { category_id: 'synthetic-home', name: '合成家居' },
  ];

  expect((await f.run()).categories).toEqual(expected);
  expect((await f.run({ category: 'synthetic-home' })).categories).toEqual(expected);
  expect((await f.run({ platform: 'jd' })).categories).toEqual([
    { category_id: 'synthetic-jd-only', name: '京东合成' },
  ]);
  for (const [input] of f.categories.mock.calls) {
    expect(input.channelId).toBe(input.platform === 'jd' ? 'synthetic_jd_sales' : TB_CHANNEL);
  }
});

it('[AC-B1-28h#8] category 取列表内的 id 时按该类目取频道第 1 页；不带 category 时取整榜（categoryId=null）', async () => {
  const f = fixture();
  f.setCategories('taobao', TB_CHANNEL, TB_CATEGORIES);
  f.setPage('taobao', TB_CHANNEL, null, 1, [candidate('whole-1')]);
  f.setPage('taobao', TB_CHANNEL, 'synthetic-digital', 1, [candidate('digital-1')]);

  const whole = await f.run();
  const digital = await f.run({ category: 'synthetic-digital' });

  expect(whole.items.map((item) => item.product_card.title)).toEqual(['synthetic-whole-1']);
  expect(digital.items.map((item) => item.product_card.title)).toEqual(['synthetic-digital-1']);
  expect(f.page.mock.calls.map(([input]) => [input.categoryId, input.pageNo])).toEqual([
    [null, 1],
    ['synthetic-digital', 1],
  ]);
});

it('[AC-B1-28h#9] category 不在该频道的列表里（别的平台的类目、大小写不同、未知 id）→ 20001，不按它取数', async () => {
  const f = fixture();
  f.setCategories('taobao', TB_CHANNEL, TB_CATEGORIES);
  f.setCategories('jd', 'synthetic_jd_sales', [
    { categoryId: 'synthetic-jd-only', name: '京东合成' },
  ]);
  f.setChannels([channel('taobao', TB_CHANNEL), channel('jd', 'synthetic_jd_sales')]);

  for (const category of ['synthetic-jd-only', 'SYNTHETIC-DIGITAL', 'synthetic-unknown']) {
    const error = await rejection(() => f.run({ category }));
    expect(error, category).toMatchObject({ code: 20001 });
  }
  expect(
    f.page.mock.calls.filter(([input]) => input.categoryId !== null).map(([input]) => input),
  ).toEqual([]);
  expect(f.register).not.toHaveBeenCalled();
});
