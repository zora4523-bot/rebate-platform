// B1-05o: several channels are always interleaved in the order of the data source's `channels`, one
// item per channel per round, with or without `mix`; the order inside a channel is kept and nothing
// on the item (price, rebate, commission) has a say (BR-TEXT-17 细则「本系统在物料的合并与混排层不加
// 佣金或返利权重」).
import { expect, it } from 'vitest';
import { candidate, series } from '../hot-rank/kit.ts';
import {
  JD,
  PDD,
  TB,
  entryOf,
  interleave,
  names,
  pagesCursor,
  sectionFixture,
  title,
  titlesOf,
  withCommission,
} from './kit.ts';

it('[AC-B1-05o#29] 两个频道按 channels 顺序一轮一条交错，频道内顺序不变', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, series('tb', 3));
  f.answer(JD, 1, series('jd', 3, 1, 'jd'));

  const data = await f.run();

  expect(titlesOf(data)).toEqual([
    title('tb-1'),
    title('jd-1'),
    title('tb-2'),
    title('jd-2'),
    title('tb-3'),
    title('jd-3'),
  ]);
});

it('[AC-B1-05o#30] 频道条数不等：短的取完后，长的按原顺序接着排', async () => {
  const f = sectionFixture({ channels: [TB, JD, PDD] });
  f.answer(TB, 1, series('tb', 1));
  f.answer(JD, 1, series('jd', 4, 1, 'jd'));
  f.answer(PDD, 1, series('pdd', 2, 1, 'pdd'));

  const data = await f.run();

  expect(titlesOf(data)).toEqual([
    title('tb-1'),
    title('jd-1'),
    title('pdd-1'),
    title('jd-2'),
    title('pdd-2'),
    title('jd-3'),
    title('jd-4'),
  ]);
});

it('[AC-B1-05o#31] 交错顺序看数据源的 channels，不看白名单里的登记顺序', async () => {
  const f = sectionFixture({ channels: [JD, TB] });
  f.setChannels([entryOf(TB), entryOf(JD)]);
  f.answer(TB, 1, series('tb', 2));
  f.answer(JD, 1, series('jd', 2, 1, 'jd'));

  const data = await f.run();

  expect(titlesOf(data)).toEqual(interleave([names('jd', 2), names('tb', 2)]));
});

it('[AC-B1-05o#32] 有 mix=interleave 与没有 mix 下发一样', async () => {
  const load = async (mix?: 'interleave') => {
    const f = sectionFixture(mix === undefined ? {} : { mix });
    f.answer(TB, 1, series('tb', 3));
    f.answer(JD, 1, series('jd', 2, 1, 'jd'));
    return f.run();
  };

  const without = await load();
  const withMix = await load('interleave');

  expect(titlesOf(withMix)).toEqual(titlesOf(without));
  expect(titlesOf(without)).toEqual(interleave([names('tb', 3), names('jd', 2)]));
});

it('[AC-B1-05o#33] 到底的频道不占位：其余频道之间照常交错', async () => {
  const f = sectionFixture({ channels: [TB, JD, PDD] });
  f.answer(TB, 2, series('tb', 2));
  f.answer(PDD, 2, series('pdd', 2, 1, 'pdd'));

  const data = await f.run({ cursor: pagesCursor([2, 0, 2]) });

  expect(titlesOf(data)).toEqual(interleave([names('tb', 2), names('pdd', 2)]));
});

it('[AC-B1-05o#34] 价格、返利、佣金都不影响顺序：便宜高返的频道排在后面也不提前', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, [
    withCommission(candidate('dear-low', { finalFen: 99_000n }), 1n),
    withCommission(candidate('dear-lower', { finalFen: 88_000n }), 2n),
  ]);
  f.answer(JD, 1, [
    withCommission(candidate('cheap-high', { platform: 'jd', finalFen: 100n }), 9_000n),
    withCommission(candidate('cheap-higher', { platform: 'jd', finalFen: 90n }), 9_500n),
  ]);
  f.quotes.set(title('dear-low'), { min: 1n, max: 1n });
  f.quotes.set(title('dear-lower'), { min: 2n, max: 2n });
  f.quotes.set(title('cheap-high'), { min: 900n, max: 900n });
  f.quotes.set(title('cheap-higher'), { min: 950n, max: 950n });

  const data = await f.run();

  expect(titlesOf(data)).toEqual([
    title('dear-low'),
    title('cheap-high'),
    title('dear-lower'),
    title('cheap-higher'),
  ]);
});
