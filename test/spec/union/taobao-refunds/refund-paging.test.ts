import { expect, it } from 'vitest';
import type { TimeWindow } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  beijingMs,
  ctx,
  hourMs,
  iso,
  listed,
  ORDER_PATH,
  positionOf,
  REFUND_PATH,
  refundAnswer,
  refundData,
  refundOf,
  refundPage,
  refunds,
  rejection,
  reply,
  setup,
  win,
  type Answer,
} from './kit.ts';

// 切窗与翻页（任务书「目标口径 · listRefunds」，同 B1-04f）：窗口 > 3 小时按 3 小时顺序切窗；每窗首页不带
// positionIndex，续页原样带上一页的 position_index，直到 has_next 不为 true；has_next 为 true 而位点
// 缺失 / 空 / 与本次所带相同 → upstream_unavailable。一次 listRefunds 只发一个上游请求，nextCursor 是
// 不透明串（承载口径、窗口、当前窗与位点），可在新的适配器实例上续拉；别的口径、窗口或别的接口的游标
// → invalid_dto。

const threeHoursMs = 3 * hourMs;
const fromMs = Date.parse(win.from);
const sevenHours: TimeWindow = { from: win.from, to: iso(fromMs + 7 * hourMs) };
const W0 = '2026-10-30 10:00:00';
const W1 = '2026-10-30 13:00:00';
const W2 = '2026-10-30 16:00:00';

it('[AC-B1-04z#12] 恰好 3 小时不切窗；3 小时多 1 秒切成两窗', async () => {
  const exact = setup(refundPage([]));
  await refunds(exact.adapter, { from: win.from, to: iso(fromMs + threeHoursMs) });
  expect(exact.requests.map((q) => [q.startTime, q.endTime])).toEqual([[W0, W1]]);

  const over = setup(refundPage([]));
  await refunds(over.adapter, { from: win.from, to: iso(fromMs + threeHoursMs + 1000) });
  expect(over.requests.map((q) => [q.startTime, q.endTime])).toEqual([
    [W0, W1],
    [W1, '2026-10-30 13:00:01'],
  ]);
});

it.each([
  ['1 秒', 1000],
  ['6 小时', 2 * threeHoursMs],
  ['7 小时', 7 * hourMs],
  ['24 小时', 24 * hourMs],
])(
  '[AC-B1-04z#13] %s：各窗首尾相接、顺序递增、每窗 ≤ 3 小时，合起来恰好覆盖 [from, to]，口径不变',
  async (_name, spanMs) => {
    const s = setup(refundPage([]));
    await refunds(s.adapter, { from: win.from, to: iso(fromMs + spanMs) }, { timeBasis: 'settle' });
    const got = s.requests.map((q) => [beijingMs(q.startTime), beijingMs(q.endTime)] as const);
    expect(got).toHaveLength(Math.ceil(spanMs / threeHoursMs));
    expect(got[0]![0]).toBe(fromMs);
    expect(got[got.length - 1]![1]).toBe(fromMs + spanMs);
    for (const [index, [start, end]] of got.entries()) {
      expect(end).toBeGreaterThan(start);
      expect(end - start).toBeLessThanOrEqual(threeHoursMs);
      if (index > 0) expect(start).toBe(got[index - 1]![1]);
    }
    expect(new Set(s.requests.map((q) => q.queryType))).toEqual(new Set(['2']));
  },
);

it('[AC-B1-04z#14] 窗内按 position_index 续页直到 has_next=false；每次 listRefunds 只发一个上游请求', async () => {
  const pages = [[refundOf(1)], [refundOf(2), refundOf(3)], [refundOf(4)]];
  const s = setup(refundAnswer({ [W0]: pages }));
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let call = 1; call <= 3; call += 1) {
    const page = await listed(
      s.adapter.listRefunds(win, ctx, cursor === undefined ? {} : { cursor }),
    );
    expect(s.transport).toHaveBeenCalledTimes(call);
    seen.push(...page.items.map((refund) => refund.refund_id));
    if (call < 3) {
      expect(page.nextCursor).toBeTypeOf('string');
      cursor = page.nextCursor!;
    } else {
      expect(page.nextCursor).toBeNull();
    }
  }
  expect(seen).toEqual(pages.flat().map((input) => input.refund_suit_id));
  expect(s.requests.map((q) => q.positionIndex)).toEqual([
    undefined,
    positionOf(0, 0),
    positionOf(0, 1),
  ]);
  for (const q of s.requests) {
    expect(q).toMatchObject({ startTime: W0, endTime: '2026-10-30 11:00:00', queryType: '5' });
  }
});

it('[AC-B1-04z#15] 多窗：一窗翻完再进下一窗，空窗照样请求，维权按上游顺序', async () => {
  const s = setup(
    refundAnswer({
      [W0]: [[refundOf(1)], [refundOf(2)]],
      [W1]: [[]],
      [W2]: [[refundOf(3)]],
    }),
  );
  const { items } = await refunds(s.adapter, sevenHours);
  expect(s.requests.map((q) => [q.startTime, q.positionIndex])).toEqual([
    [W0, undefined],
    [W0, positionOf(0, 0)],
    [W1, undefined],
    [W2, undefined],
  ]);
  expect(items.map((refund) => refund.refund_id)).toEqual(
    [refundOf(1), refundOf(2), refundOf(3)].map((input) => input.refund_suit_id),
  );
});

it('[AC-B1-04z#16] 游标自带口径、窗起点与位点：换一个新的适配器实例也能从中断处续拉', async () => {
  const answer = refundAnswer({
    [W0]: [[refundOf(1)], [refundOf(2)]],
    [W1]: [[refundOf(3)]],
    [W2]: [[refundOf(4)]],
  });
  const first = setup(answer);
  const page1 = await listed(first.adapter.listRefunds(sevenHours, ctx, { timeBasis: 'settle' }));
  expect(page1.nextCursor).toBeTypeOf('string');

  const second = setup(answer);
  const page2 = await listed(
    second.adapter.listRefunds(sevenHours, ctx, {
      timeBasis: 'settle',
      cursor: page1.nextCursor!,
    }),
  );
  expect(second.requests).toHaveLength(1);
  expect(second.requests[0]).toMatchObject({
    startTime: W0,
    queryType: '2',
    positionIndex: positionOf(0, 0),
  });
  expect(page2.items.map((refund) => refund.refund_id)).toEqual([refundOf(2).refund_suit_id]);

  const third = setup(answer);
  const page3 = await listed(
    third.adapter.listRefunds(sevenHours, ctx, {
      timeBasis: 'settle',
      cursor: page2.nextCursor!,
    }),
  );
  expect(third.requests).toHaveLength(1);
  expect(third.requests[0]).toMatchObject({ startTime: W1, endTime: W2, queryType: '2' });
  expect(third.requests[0]).not.toHaveProperty('positionIndex');
  expect(page3.items.map((refund) => refund.refund_id)).toEqual([refundOf(3).refund_suit_id]);
});

it.each(['garbage', 'tbo1.5.0.0.0.', '%%%', ' '])(
  '[AC-B1-04z#17] 不认识的游标「%s」→ invalid_dto，不取凭据、不发请求',
  async (cursor) => {
    const s = setup(refundPage([]));
    await rejection(() => s.adapter.listRefunds(sevenHours, ctx, { cursor }), 'invalid_dto');
    expect(s.transport).not.toHaveBeenCalled();
    expect(s.dataokeCredentials).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04z#18] 游标属于别的口径或别的窗口 → invalid_dto，不按游标去查', async () => {
  const answer = refundAnswer({ [W0]: [[refundOf(1)], [refundOf(2)]] });
  const s = setup(answer);
  const page = await listed(s.adapter.listRefunds(sevenHours, ctx));
  const cursor = page.nextCursor!;
  expect(cursor).toBeTypeOf('string');
  const sent = s.transport.mock.calls.length;

  await rejection(
    () => s.adapter.listRefunds(sevenHours, ctx, { cursor, timeBasis: 'settle' }),
    'invalid_dto',
  );
  await rejection(
    () =>
      s.adapter.listRefunds({ from: sevenHours.from, to: iso(fromMs + 8 * hourMs) }, ctx, {
        cursor,
      }),
    'invalid_dto',
  );
  expect(s.transport).toHaveBeenCalledTimes(sent);
});

it('[AC-B1-04z#19] 订单（B1-04f）的游标拿来续拉同一窗口的维权 → invalid_dto，不发维权请求', async () => {
  const answer: Answer = (call) =>
    call.path.endsWith(ORDER_PATH)
      ? reply({
          has_next: false,
          has_pre: false,
          position_index: '',
          results: { publisher_order_dto: [] },
        })
      : reply(refundData([]));
  const s = setup(answer);
  const orders = await s.adapter.listOrders(sevenHours, {}, ctx);
  expect(orders.nextCursor).toBeTypeOf('string');
  await rejection(
    () => s.adapter.listRefunds(sevenHours, ctx, { cursor: orders.nextCursor! }),
    'invalid_dto',
  );
  expect(s.calls.filter((call) => call.path.endsWith(REFUND_PATH))).toEqual([]);
});

it.each([
  ['缺失', null],
  ['空串', ''],
] as const)(
  '[AC-B1-04z#20] has_next 为 true 而 position_index %s → upstream_unavailable（不重拉首页、不原地打转）',
  async (_name, position) => {
    const s = setup(() => reply(refundData([refundOf(1)], { hasNext: true, position })));
    await rejection(() => s.adapter.listRefunds(win, ctx), 'upstream_unavailable');
    expect(s.transport).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04z#21] has_next 为 true 而 position_index 与本次所带相同 → upstream_unavailable', async () => {
  const stuck = positionOf(0, 0);
  const s = setup(() => reply(refundData([refundOf(1)], { hasNext: true, position: stuck })));
  const first = await listed(s.adapter.listRefunds(win, ctx));
  expect(first.nextCursor).toBeTypeOf('string');
  await rejection(
    () => s.adapter.listRefunds(win, ctx, { cursor: first.nextCursor! }),
    'upstream_unavailable',
  );
  expect(s.requests.map((q) => q.positionIndex)).toEqual([undefined, stuck]);
});

it.each([
  ['对象', { refund: [] }],
  ['字符串', 'none'],
  ['数字', 0],
])('[AC-B1-04z#22] data.result 是%s（不是数组）→ upstream_unavailable', async (_name, result) => {
  const s = setup(() => reply(refundData(result)));
  await rejection(() => s.adapter.listRefunds(win, ctx), 'upstream_unavailable');
});

it.each([
  ['缺失', undefined],
  ['null', null],
  ['空数组', []],
])('[AC-B1-04z#23] data.result %s → 本页没有维权', async (_name, result) => {
  const s = setup(() => reply(refundData(result)));
  const page = await listed(s.adapter.listRefunds(win, ctx));
  expect(page).toEqual({ items: [], nextCursor: null });
});
