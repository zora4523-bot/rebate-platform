// B1-28n (D10-508, BR-PRICE-11 细则): during a union failure the hot list reads an old page only while
// age = now − fetched_at_ms ≤ pool.max_age_sec, default 7200 seconds; exactly the limit is usable.
// Beyond it the page counts as absent: 50304 without reason, the platform unavailable. A served
// page keeps the card fields of today's assembly: stale=true, the stored quoted_at, age_sec.
import { expect, it } from 'vitest';
import { NOW, TB_CHANNEL, assertSchema, candidate, dataOf, rejection } from '../hot-rank/kit.ts';
import { TB } from '../section-items/kit.ts';
import {
  DEFAULT_MAX_AGE_SECONDS as LIMIT,
  OUTAGES,
  maxAgeFixture,
  rankRows,
  unavailable,
} from './kit.ts';

it.each(OUTAGES)(
  '[AC-B1-28n#1] pool.max_age_sec 未配置时上限 7200 秒：$label 时 age 恰好 7200 秒仍按原名次读旧页并标 stale，7201 秒 50304 不带 reason、不下发卡片',
  async ({ outage }) => {
    const f = maxAgeFixture();
    f.answer(TB, [candidate('kept', { salesText: '5000+' }), candidate('next')]);
    const first = await f.run();
    f.fail(outage);

    f.ageTo(LIMIT);
    const served = await f.run();

    expect(rankRows(served)).toEqual(rankRows(first));
    for (const item of served.items) expect(item.product_card.stale).toBe(true);

    const registered = f.registered().length;
    f.ageTo(LIMIT + 1);
    const error = await rejection(() => f.run());

    expect(error).toMatchObject({ code: 50304 });
    expect(dataOf(error)?.['reason']).toBeUndefined();
    expect(dataOf(error)?.['platform']).toBe('taobao');
    expect(f.registered()).toHaveLength(registered);
  },
);

it('[AC-B1-28n#2] 年龄按毫秒比较：7200.000 秒可用，再过 1 毫秒就超过上限', async () => {
  const f = maxAgeFixture();
  f.answer(TB, [candidate('kept')]);
  await f.run();
  f.fail(unavailable());

  f.ageTo(LIMIT);
  expect((await f.run()).items).toHaveLength(1);

  f.clock.advanceMs(1);
  expect(await rejection(() => f.run())).toMatchObject({ code: 50304 });
});

it('[AC-B1-28n#3] 上限内的旧页沿用现有组装：stale=true、quoted_at 是存下来的原值、age_sec 按响应时刻算，响应过契约；超过上限不再出卡', async () => {
  const f = maxAgeFixture();
  f.setCategories('taobao', TB_CHANNEL, [{ categoryId: 'synthetic-digital', name: '合成数码' }]);
  f.answer(TB, [candidate('kept', { salesText: '1.2万' }), candidate('next')]);
  const first = await f.run();
  expect(first.items[0]?.product_card).toMatchObject({ stale: false, quoted_at: NOW, age_sec: 0 });
  f.fail(unavailable());

  f.ageTo(LIMIT);
  const served = await f.run();

  expect(served.items).toHaveLength(2);
  for (const item of served.items) {
    expect(item.product_card).toMatchObject({ stale: true, quoted_at: NOW, age_sec: LIMIT });
  }
  expect(served.categories).toEqual(first.categories);
  expect(served.channel).toBe(TB_CHANNEL);
  await assertSchema(served, 'HotRankData');

  f.ageTo(LIMIT + 1);
  expect(await rejection(() => f.run())).toMatchObject({ code: 50304 });
});

it('[AC-B1-28n#4] 上限判的是条目的 fetched_at_ms，不是商品的 quoted_at：quoted_at 早三小时的页照样读到 7200 秒，卡片 quoted_at 不改写', async () => {
  const quotedAt = '2026-10-06T07:00:00+08:00';
  const entry = candidate('early-quote');
  const f = maxAgeFixture();
  f.answer(TB, [{ ...entry, item: { ...entry.item, quoted_at: quotedAt } }]);
  await f.run();
  f.fail(unavailable());

  f.ageTo(LIMIT);
  const served = await f.run();

  expect(served.items[0]?.product_card).toMatchObject({
    stale: true,
    quoted_at: quotedAt,
    age_sec: LIMIT + 3 * 3600,
  });

  f.ageTo(LIMIT + 1);
  expect(await rejection(() => f.run())).toMatchObject({ code: 50304 });
});

it('[AC-B1-28n#5] 超限后联盟恢复：取新数据、不标 stale，年龄从新的 fetched_at 重新算', async () => {
  const f = maxAgeFixture();
  f.answer(TB, [candidate('old')]);
  await f.run();
  f.fail(unavailable());

  const refreshedAt = LIMIT + 1;
  f.ageTo(refreshedAt);
  expect(await rejection(() => f.run())).toMatchObject({ code: 50304 });

  f.fail(null);
  f.answer(TB, [candidate('new')]);
  const fresh = await f.run();

  expect(fresh.items[0]?.product_card).toMatchObject({ title: 'synthetic-new', stale: false });

  f.fail(unavailable());
  f.ageTo(refreshedAt + LIMIT);
  const served = await f.run();

  expect(served.items[0]?.product_card).toMatchObject({ title: 'synthetic-new', stale: true });

  f.ageTo(refreshedAt + LIMIT + 1);
  expect(await rejection(() => f.run())).toMatchObject({ code: 50304 });
});
