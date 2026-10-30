// B1-05o: fewer than 20 deliverable cards after filtering, with a channel that has a next page, fetch
// one more round of upstream pages, at most once a request. The round tops the page up: its cards
// follow those of the first round. Over 20 is cut, what is cut registers nothing and is never shown,
// because the cursor records upstream pages, not offsets (BR-PRICE-08; 编排补充说明 D10-452).
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { candidate, series } from '../hot-rank/kit.ts';
import {
  JD,
  PDD,
  SECTION_PAGE_SIZE,
  TB,
  anomalous,
  expectPages,
  interleave,
  names,
  sectionFixture,
  title,
  titlesOf,
} from './kit.ts';

it('[AC-B1-05o#43] 不足 20 条且还有下一页：再取一页补在后面，游标记到取过的下一页', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, series('tb', 3), true);
  f.answer(TB, 2, series('tb', 4, 4), true);

  const data = await f.run();

  expect(f.pageNos(TB)).toEqual([1, 2]);
  expect(titlesOf(data)).toEqual(names('tb', 7));
  expectPages(data, [3]);
});

it('[AC-B1-05o#44] 补足只发生一轮：补完还不够也不再取，下一页由游标继续', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, series('tb', 1), true);
  f.answer(TB, 2, series('tb', 1, 2), true);
  f.answer(TB, 3, series('tb', 1, 3), true);
  f.answer(TB, 4, series('tb', 1, 4), true);
  f.answer(TB, 5, series('tb', 1, 5));

  const first = await f.run();

  expect(f.pageNos(TB)).toEqual([1, 2]);
  expect(titlesOf(first)).toEqual(names('tb', 2));
  expectPages(first, [3]);

  const second = await f.run({ cursor: first.next_cursor! });

  expect(f.pageNos(TB)).toEqual([1, 2, 3, 4]);
  expect(titlesOf(second)).toEqual(names('tb', 2, 3));
  expectPages(second, [5]);
});

it('[AC-B1-05o#45] 第一轮够 20 条：不补，有更多时游标只进一页', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, series('tb', SECTION_PAGE_SIZE), true);

  const data = await f.run();

  expect(f.pageNos(TB)).toEqual([1]);
  expect(data.items).toHaveLength(SECTION_PAGE_SIZE);
  expectPages(data, [2]);
});

it('[AC-B1-05o#46] 不足 20 条但没有频道还有下一页：不补，按现有的返回', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, series('tb', 2));
  f.answer(JD, 1, series('jd', 2, 1, 'jd'));

  const data = await f.run();

  expect(f.pageNos(TB)).toEqual([1]);
  expect(f.pageNos(JD)).toEqual([1]);
  expect(data.items).toHaveLength(4);
  expect(data.next_cursor).toBeNull();
});

it('[AC-B1-05o#47] 补足轮只取还有下一页的频道，已到底的不再取；补的这一轮自己交错、排在第一轮后面', async () => {
  const f = sectionFixture({ channels: [TB, JD, PDD] });
  f.answer(TB, 1, series('tb', 2), true);
  f.answer(JD, 1, series('jd', 2, 1, 'jd'));
  f.answer(PDD, 1, series('pdd', 2, 1, 'pdd'), true);
  f.answer(TB, 2, series('tb', 2, 3), true);
  f.answer(PDD, 2, series('pdd', 2, 3, 'pdd'));

  const data = await f.run();

  expect(f.pageNos(TB)).toEqual([1, 2]);
  expect(f.pageNos(JD)).toEqual([1]);
  expect(f.pageNos(PDD)).toEqual([1, 2]);
  expect(titlesOf(data)).toEqual([
    ...interleave([names('tb', 2), names('jd', 2), names('pdd', 2)]),
    ...interleave([names('tb', 2, 3), names('pdd', 2, 3)]),
  ]);
  expectPages(data, [3, 0, 0]);
});

it('[AC-B1-05o#48] 总数截到 20：多的丢弃，不登记链接，游标照样记上游页码', async () => {
  const refs = [TB, JD, PDD];
  const f = sectionFixture({ channels: refs });
  for (const [index, ref] of refs.entries()) {
    f.answer(ref, 1, series(`r1-${index}`, 6, 1, ref.platform), true);
    f.answer(ref, 2, series(`r2-${index}`, 6, 1, ref.platform), true);
  }

  const data = await f.run();

  const expected = [
    ...interleave(refs.map((_ref, index) => names(`r1-${index}`, 6))),
    ...interleave(refs.map((_ref, index) => names(`r2-${index}`, 6))),
  ].slice(0, SECTION_PAGE_SIZE);
  expect(titlesOf(data)).toEqual(expected);
  expect(f.registered()).toEqual(expected);
  expectPages(data, [3, 3, 3]);
});

it('[AC-B1-05o#49] 够不够 20 条按过滤后算：第一轮 20 条里有 no_rebate 和异常价就要补', async () => {
  const f = sectionFixture({ channels: [TB] });
  const first = series('tb', SECTION_PAGE_SIZE);
  first[5] = anomalous(first[5]!);
  f.answer(TB, 1, first, true);
  f.noRebate('tb-3');
  f.answer(TB, 2, series('tb', 3, 21));

  const data = await f.run();

  expect(f.pageNos(TB)).toEqual([1, 2]);
  expect(data.items).toHaveLength(SECTION_PAGE_SIZE);
  expect(titlesOf(data)).not.toContain(title('tb-3'));
  expect(titlesOf(data)).not.toContain(title('tb-6'));
  expect(titlesOf(data).slice(-2)).toEqual(names('tb', 2, 21));
  expect(f.registered()).toEqual(titlesOf(data));
  expect(data.has_more).toBe(false);
});

it('[AC-B1-05o#50] 够不够 20 条按去重后算，补足轮里的重复也去掉', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, [...series('tb', 19), candidate('tb-1')], true);
  f.answer(TB, 2, [candidate('tb-2'), candidate('new')]);

  const data = await f.run();

  expect(f.pageNos(TB)).toEqual([1, 2]);
  expect(titlesOf(data)).toEqual([...names('tb', 19), title('new')]);
  expect(f.registered()).toEqual(titlesOf(data));
});

it('[AC-B1-05o#51] 补足轮的页失败：第一轮的卡照发，告警一条，页码停在没取到的那页，下一请求重取', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, series('tb', 2), true);
  f.failChannel(TB, new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'), 2);

  const first = await f.run();

  expect(titlesOf(first)).toEqual(names('tb', 2));
  expectPages(first, [2]);
  expect(f.warnings()).toHaveLength(1);

  f.recover(TB);
  f.answer(TB, 2, series('tb', 1, 3));
  const second = await f.run({ cursor: first.next_cursor! });

  expect(f.pageNos(TB)).toEqual([1, 2, 2]);
  expect(titlesOf(second)).toEqual(names('tb', 1, 3));
  expect(second.next_cursor).toBeNull();
});

it('[AC-B1-05o#52] 两轮全被过滤但还有下一页：items 为空而游标非 null（继续取），带游标接着出卡', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, series('tb', 2), true);
  f.answer(TB, 2, series('tb', 2, 3), true);
  f.noRebate('tb-1', 'tb-2', 'tb-3', 'tb-4');
  f.answer(TB, 3, series('tb', 1, 5));

  const first = await f.run();

  expect(first.items).toEqual([]);
  expectPages(first, [3]);

  const second = await f.run({ cursor: first.next_cursor! });

  expect(titlesOf(second)).toEqual(names('tb', 1, 5));
  expect(second.has_more).toBe(false);
  expect(second.next_cursor).toBeNull();
});
