// B1-05o: every card goes through the single card entry (entry source feed, scene retrieval, link
// deferred). Only a prepared card that has a rebate is committed, so an item with an abnormal price,
// a no_rebate item or a repeated product_key registers no link. ad_label stays null: this source
// only uses channels that are not sorted by commission (BR-TEXT-17 细则「联盟物料频道」); the card
// entry leaves the key out today, which the contract's optional field reads as null.
import { expect, it } from 'vitest';
import { assertSchema, candidate, series } from '../hot-rank/kit.ts';
import { JD, TB, anomalous, names, refsOf, sectionFixture, title, titlesOf } from './kit.ts';

it('[AC-B1-05o#35] 每张卡走唯一出卡入口：entrySource=feed、scene=retrieval、deferLink=true', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, series('tb', 2));
  f.answer(JD, 1, series('jd', 1, 1, 'jd'));

  await f.run();

  expect(f.assemble.mock.calls).toHaveLength(3);
  for (const [input] of f.assemble.mock.calls) {
    expect(input).toMatchObject({ entrySource: 'feed', scene: 'retrieval', deferLink: true });
  }
});

it('[AC-B1-05o#36] 下发的卡都已登记链接：链接只为下发的卡登记，顺序与下发一致', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, series('tb', 2));
  f.answer(JD, 1, series('jd', 2, 1, 'jd'));

  const data = await f.run();

  expect(f.registered()).toEqual(titlesOf(data));
  expect(new Set(data.items.map((card) => card.link_id)).size).toBe(4);
});

it('[AC-B1-05o#37] no_rebate 的商品不下发、不登记链接，不影响其余顺序', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, series('tb', 3));
  f.noRebate('tb-2');

  const data = await f.run();

  expect(titlesOf(data)).toEqual([title('tb-1'), title('tb-3')]);
  expect(f.registered()).toEqual(titlesOf(data));
});

it('[AC-B1-05o#38] 异常价由出卡入口跳过：记 PRICE_ANOMALY，不下发、不登记链接', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, [candidate('good-1'), anomalous(candidate('bad')), candidate('good-2')]);

  const data = await f.run();

  expect(titlesOf(data)).toEqual([title('good-1'), title('good-2')]);
  expect(f.registered()).toEqual(titlesOf(data));
  expect(f.anomalies()).toHaveLength(1);
});

it('[AC-B1-05o#39] 同一响应内按 product_key 去重：留交错后先出现的那张，不比价，后者不登记链接', async () => {
  const [first, second] = refsOf(2);
  const f = sectionFixture({ channels: [first!, second!] });
  f.answer(first!, 1, [candidate('same', { finalFen: 5_000n })]);
  f.answer(second!, 1, [candidate('other'), candidate('same', { finalFen: 100n })]);

  const data = await f.run();

  expect(titlesOf(data)).toEqual([title('same'), title('other')]);
  expect(data.items[0]?.final_price_fen).toBe(5_000);
  expect(f.registered()).toEqual(titlesOf(data));
});

it('[AC-B1-05o#40] 被跳过的那次不占去重名额：异常价之后同一商品的正常价照常下发', async () => {
  const [first, second] = refsOf(2);
  const f = sectionFixture({ channels: [first!, second!] });
  f.answer(first!, 1, [anomalous(candidate('same'))]);
  f.answer(second!, 1, [candidate('same')]);

  const data = await f.run();

  expect(titlesOf(data)).toEqual([title('same')]);
  expect(f.registered()).toEqual(titlesOf(data));
});

it('[AC-B1-05o#41] ad_label 不是推广：每张卡都为 null，响应过契约 PageSectionItemsData', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, series('tb', 2));
  f.answer(JD, 1, series('jd', 2, 1, 'jd'));

  const data = await f.run();

  expect(data.items).toHaveLength(4);
  for (const card of data.items) expect(card.ad_label ?? null).toBeNull();
  await assertSchema(data, 'PageSectionItemsData');
});

it('[AC-B1-05o#42] 去重只管本次响应：下一页再出现同一商品照常下发', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, series('tb', 20), true);
  f.answer(TB, 2, series('tb', 2));

  const first = await f.run();
  const second = await f.run({ cursor: first.next_cursor! });

  expect(titlesOf(first)).toEqual(names('tb', 20));
  expect(titlesOf(second)).toEqual(names('tb', 2));
});
