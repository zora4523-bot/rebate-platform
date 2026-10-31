// B1-05o: what each channel is asked for: the viewer's app, the whole channel (categoryId null), a
// page size of ⌊20 / channels⌋ and at least 1. A channel at page 0 is finished and not fetched; a
// page beyond HOT_RANK_MAX_PAGE_NO counts as finished too, so no channel is ever asked for one
// (编排补充说明 D10-452). A channel that reports more on the last allowed page is finished like one
// that reports no more: it gives page 0 and adds nothing to has_more, as the hot list's own cap.
import { expect, it } from 'vitest';
import { HOT_RANK_MAX_PAGE_NO } from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { APP, series } from '../hot-rank/kit.ts';
import {
  EMPTY,
  JD,
  TB,
  expectPages,
  names,
  pagesCursor,
  refsOf,
  sectionFixture,
  titlesOf,
} from './kit.ts';

const SIZES = [
  { channels: 1, pageSize: 20 },
  { channels: 2, pageSize: 10 },
  { channels: 3, pageSize: 6 },
  { channels: 4, pageSize: 5 },
  { channels: 7, pageSize: 2 },
  { channels: 20, pageSize: 1 },
  { channels: 21, pageSize: 1 },
  { channels: 25, pageSize: 1 },
];

it.each(SIZES)(
  '[AC-B1-05o#13] $channels 个频道：每个频道各取一次，pageSize=$pageSize、categoryId=null',
  async ({ channels, pageSize }) => {
    const refs = refsOf(channels);
    const f = sectionFixture({ channels: refs });

    await f.run();

    expect(f.calls).toHaveLength(channels);
    for (const ref of refs) {
      expect(f.calls).toContainEqual({
        appId: APP,
        platform: ref.platform,
        channelId: ref.channel_id,
        categoryId: null,
        pageNo: 1,
        pageSize,
      });
    }
  },
);

it('[AC-B1-05o#14] 翻页时各频道按游标里各自的页码取，pageSize 不变', async () => {
  const f = sectionFixture();

  await f.run({ cursor: pagesCursor([3, 7]) });

  expect(f.calls).toHaveLength(2);
  expect(f.calls).toContainEqual(
    expect.objectContaining({ channelId: TB.channel_id, pageNo: 3, pageSize: 10 }),
  );
  expect(f.calls).toContainEqual(
    expect.objectContaining({ channelId: JD.channel_id, pageNo: 7, pageSize: 10 }),
  );
});

it('[AC-B1-05o#15] 页码 0 的频道已到底、不再取；pageSize 仍按全部频道数算，游标里继续是 0', async () => {
  const f = sectionFixture();
  f.answer(JD, 2, series('jd', 10, 11, 'jd'), true);
  f.answer(JD, 3, series('jd', 10, 21, 'jd'), true);

  const data = await f.run({ cursor: pagesCursor([0, 2]) });

  expect(f.pageNos(TB)).toEqual([]);
  expect(f.calls.map((call) => call.pageSize)).toEqual([10, 10]);
  expect(titlesOf(data)).toEqual(names('jd', 20, 11));
  expectPages(data, [0, 4]);
});

it('[AC-B1-05o#16] 全部频道都是 0：不取数，空结果', async () => {
  const f = sectionFixture();

  const data = await f.run({ cursor: pagesCursor([0, 0]) });

  expect(data).toEqual(EMPTY);
  expect(f.calls).toEqual([]);
});

it('[AC-B1-05o#17] 页码超过 HOT_RANK_MAX_PAGE_NO 的频道按到底处理：不取、不报 20001，其余频道照常，游标里置 0', async () => {
  const f = sectionFixture();
  f.answer(JD, 1, series('jd', 10, 1, 'jd'), true);
  f.answer(JD, 2, series('jd', 10, 11, 'jd'), true);

  const data = await f.run({ cursor: pagesCursor([HOT_RANK_MAX_PAGE_NO + 1, 1]) });

  expect(f.pageNos(TB)).toEqual([]);
  expect(f.pageNos(JD)).toEqual([1, 2]);
  expect(data.items).toHaveLength(20);
  expectPages(data, [0, 3]);
});

it('[AC-B1-05o#18] 只有超限频道时：不取数，空结果', async () => {
  const f = sectionFixture({ channels: [TB] });

  const data = await f.run({ cursor: pagesCursor([HOT_RANK_MAX_PAGE_NO + 1]) });

  expect(data).toEqual(EMPTY);
  expect(f.calls).toEqual([]);
});

it('[AC-B1-05o#19] 最后一页 HOT_RANK_MAX_PAGE_NO 照常取；上游还报有更多也到此为止，不取下一页、不给游标', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, HOT_RANK_MAX_PAGE_NO, series('tb', 3), true);

  const data = await f.run({ cursor: pagesCursor([HOT_RANK_MAX_PAGE_NO]) });

  expect(f.pageNos(TB)).toEqual([HOT_RANK_MAX_PAGE_NO]);
  expect(titlesOf(data)).toEqual(names('tb', 3));
  expect(data.has_more).toBe(false);
  expect(data.next_cursor).toBeNull();
});

it('[AC-B1-05o#20] 补足轮也不越过上限：倒数第二页补到最后一页就停', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, HOT_RANK_MAX_PAGE_NO - 1, series('a', 2), true);
  f.answer(TB, HOT_RANK_MAX_PAGE_NO, series('b', 2), true);

  const data = await f.run({ cursor: pagesCursor([HOT_RANK_MAX_PAGE_NO - 1]) });

  expect(f.pageNos(TB)).toEqual([HOT_RANK_MAX_PAGE_NO - 1, HOT_RANK_MAX_PAGE_NO]);
  expect(data.items).toHaveLength(4);
  expect(data.has_more).toBe(false);
  expect(data.next_cursor).toBeNull();
});

it('[AC-B1-05o#21] 有频道到上限时另一个频道还有更多：到上限的置 0，游标接着走另一个', async () => {
  const f = sectionFixture();
  f.answer(TB, HOT_RANK_MAX_PAGE_NO, series('tb', 10), true);
  f.answer(JD, 1, series('jd', 10, 1, 'jd'), true);

  const data = await f.run({ cursor: pagesCursor([HOT_RANK_MAX_PAGE_NO, 1]) });

  expect(data.items).toHaveLength(20);
  expectPages(data, [0, 2]);
});
