// B1-28n (D10-508): the section feed reads the hot list's cache, under the same limit. A channel
// over it counts as failed: only its page is dropped, one alert, its page number stays; every
// channel failed is the empty answer, never 50304. Reading feed.fallback_pool_id is B1-05r's, so
// nothing here says what fills an empty answer later.
import { expect, it } from 'vitest';
import { NOW, assertSchema, dataOf, rejection, series } from '../hot-rank/kit.ts';
import { EMPTY, JD, TB, expectPages, interleave, names, titlesOf } from '../section-items/kit.ts';
import {
  DEFAULT_MAX_AGE_SECONDS as LIMIT,
  MAX_AGE_KEY,
  OUTAGES,
  maxAgeFixture,
  unavailable,
} from './kit.ts';

interface SharedCase {
  readonly label: string;
  /** pool.max_age_sec to configure; absent leaves it unset. */
  readonly maxAge?: number;
  /** The limit in effect. */
  readonly limit: number;
}

const SHARED: readonly SharedCase[] = [
  { label: '默认上限', limit: LIMIT },
  { label: 'pool.max_age_sec=3600', maxAge: 3600, limit: 3600 },
];

it.each(OUTAGES)(
  '[AC-B1-28n#15] $label：两个频道的旧页 7200 秒都下发，7201 秒全部超限 → 空结果不报 50304，每个频道各告警一条',
  async ({ outage }) => {
    const f = maxAgeFixture({ channels: [TB, JD] });
    f.answer(TB, series('tb', 2));
    f.answer(JD, series('jd', 2, 1, 'jd'));
    await f.feed();
    f.fail(outage);

    f.ageTo(LIMIT);
    const served = await f.feed();

    expect(titlesOf(served)).toEqual(interleave([names('tb', 2), names('jd', 2)]));

    f.ageTo(LIMIT + 1);
    const data = await f.feed();

    expect(data).toEqual(EMPTY);
    expect(f.droppedChannels()).toHaveLength(2);
    expect(f.droppedChannels()).toEqual(expect.arrayContaining([TB.channel_id, JD.channel_id]));
  },
);

it('[AC-B1-28n#16] 上限内的旧页沿用现有组装：stale=true、quoted_at 是存下来的原值、age_sec 按响应时刻算，响应过契约；超过上限不再出卡、不登记链接', async () => {
  const f = maxAgeFixture();
  f.answer(TB, series('tb', 2));
  const first = await f.feed();
  expect(first.items[0]).toMatchObject({ stale: false, quoted_at: NOW, age_sec: 0 });
  f.fail(unavailable());

  f.ageTo(LIMIT);
  const served = await f.feed();

  expect(served.items).toHaveLength(2);
  for (const card of served.items) {
    expect(card).toMatchObject({ stale: true, quoted_at: NOW, age_sec: LIMIT });
  }
  await assertSchema(served, 'PageSectionItemsData');

  const registered = f.registered().length;
  f.ageTo(LIMIT + 1);

  expect(await f.feed()).toEqual(EMPTY);
  expect(f.registered()).toHaveLength(registered);
});

/** JD's page stored at the start, TB's 3000 seconds later; both down, JD one second over. */
async function oneChannelOver() {
  const f = maxAgeFixture({ channels: [TB, JD] });
  f.failChannel(TB, unavailable());
  f.answer(JD, series('jd', 2, 1, 'jd'));
  await f.feed();

  f.ageTo(3000);
  f.recover(TB);
  f.answer(TB, series('tb', 2));
  f.failChannel(JD, unavailable());
  await f.feed();

  f.failChannel(TB, unavailable());
  f.ageTo(LIMIT + 1);
  return f;
}

it('[AC-B1-28n#17] 只有一个频道超限：只丢这一路，另一路的旧页照常下发并登记链接，告警点名超限频道，它的页码不前进', async () => {
  const f = await oneChannelOver();
  const alerts = f.droppedChannels().length;
  const registered = f.registered().length;

  const data = await f.feed();

  expect(titlesOf(data)).toEqual(names('tb', 2));
  for (const card of data.items) expect(card.stale).toBe(true);
  expectPages(data, [0, 1]);
  expect(f.droppedChannels().slice(alerts)).toEqual([JD.channel_id]);
  expect(f.registered().slice(registered)).toEqual(names('tb', 2));
});

it('[AC-B1-28n#18] 超限频道在下一请求重取同一页：联盟恢复后下发新数据，不标 stale', async () => {
  const f = await oneChannelOver();
  const data = await f.feed();
  expectPages(data, [0, 1]);

  f.recover(JD);
  f.answer(JD, series('jd-new', 1, 1, 'jd'));
  const next = await f.feed({ cursor: data.next_cursor! });

  expect(titlesOf(next)).toEqual(names('jd-new', 1));
  expect(next.items[0]?.stale).toBe(false);
  expect(next.has_more).toBe(false);
});

it.each(SHARED)(
  '[AC-B1-28n#19] 热销榜与信息流读同一份缓存、同一个上限（$label）：恰好上限都标 stale，多 1 秒热销榜 50304、信息流空结果',
  async ({ maxAge, limit }) => {
    const f = maxAgeFixture();
    if (maxAge !== undefined) f.configure(MAX_AGE_KEY, maxAge);
    f.answer(TB, series('tb', 2));
    await f.run();
    f.fail(unavailable());

    f.ageTo(limit);
    const rank = await f.run();
    const feed = await f.feed();

    expect(rank.items.map((item) => item.product_card.stale)).toEqual([true, true]);
    expect(feed.items.map((card) => card.stale)).toEqual([true, true]);

    f.ageTo(limit + 1);
    const error = await rejection(() => f.run());

    expect(error).toMatchObject({ code: 50304 });
    expect(dataOf(error)?.['reason']).toBeUndefined();
    expect(await f.feed()).toEqual(EMPTY);
  },
);
