// B1-05o: has_more is true while any channel reports more, or one channel failed while another
// answered; it follows upstream, never our filters. next_cursor is null exactly when has_more is
// false, and an answered channel's page moves on (0 at its end) while a failed one's stays. Nothing
// from any channel is the empty answer, 200 and never 50304 (contract listPageSectionItems).
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { assertSchema, series } from '../hot-rank/kit.ts';
import { EMPTY, JD, TB, expectPages, sectionFixture } from './kit.ts';

it('[AC-B1-05o#53] 有频道报 hasMore：has_more=true，报完的频道置 0，另一个进一页', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, series('tb', 10));
  f.answer(JD, 1, series('jd', 10, 1, 'jd'), true);

  const data = await f.run();

  expect(data.items).toHaveLength(20);
  expectPages(data, [0, 2]);
  await assertSchema(data, 'PageSectionItemsData');
});

it('[AC-B1-05o#54] 都没报 hasMore 但一个失败一个答了：has_more=true，失败的页码不动', async () => {
  const f = sectionFixture();
  f.failChannel(TB, new UnionError('rate_limited', 'synthetic rate limited', 'taobao'));
  f.answer(JD, 1, series('jd', 10, 1, 'jd'));

  const data = await f.run();

  expect(data.items).toHaveLength(10);
  expectPages(data, [1, 0]);
});

it('[AC-B1-05o#55] 一个失败、另一个还有更多：两边都留下继续的页码', async () => {
  const f = sectionFixture();
  f.failChannel(TB, new UnionError('rate_limited', 'synthetic rate limited', 'taobao'));
  f.answer(JD, 1, series('jd', 10, 1, 'jd'), true);
  f.answer(JD, 2, series('jd', 10, 11, 'jd'), true);

  const data = await f.run();

  expect(data.items).toHaveLength(20);
  expectPages(data, [1, 3]);
});

it('[AC-B1-05o#56] 都没报 hasMore 也没有失败：has_more=false、next_cursor=null', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, series('tb', 10));
  f.answer(JD, 1, series('jd', 10, 1, 'jd'));

  const data = await f.run();

  expect(data.items).toHaveLength(20);
  expect(data.has_more).toBe(false);
  expect(data.next_cursor).toBeNull();
});

it('[AC-B1-05o#57] 所有频道都没有数据：空结果，过契约', async () => {
  const f = sectionFixture();

  const data = await f.run();

  expect(data).toEqual(EMPTY);
  await assertSchema(data, 'PageSectionItemsData');
});

it('[AC-B1-05o#58] has_more 跟上游走，不被过滤改写：全被过滤且上游说没了就是结束', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, series('tb', 2));
  f.noRebate('tb-1', 'tb-2');

  const data = await f.run();

  expect(data).toEqual(EMPTY);
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-05o#59] 从头翻到尾：每个频道的上游页各取一次，顺着 next_cursor 走到 null', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, series('tb', 10), true);
  f.answer(TB, 2, series('tb', 10, 11));
  f.answer(JD, 1, series('jd', 10, 1, 'jd'), true);
  f.answer(JD, 2, series('jd', 10, 11, 'jd'), true);
  f.answer(JD, 3, series('jd', 4, 21, 'jd'));

  const first = await f.run();
  expectPages(first, [2, 2]);
  const second = await f.run({ cursor: first.next_cursor! });
  expectPages(second, [0, 3]);
  const third = await f.run({ cursor: second.next_cursor! });

  expect(third.items).toHaveLength(4);
  expect(third.has_more).toBe(false);
  expect(third.next_cursor).toBeNull();
  expect(f.pageNos(TB)).toEqual([1, 2]);
  expect(f.pageNos(JD)).toEqual([1, 2, 3]);
});
