import { expect, it } from 'vitest';
import type { TimeWindow } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  beijingMs,
  collect,
  ctx,
  hourMs,
  listed,
  onePage,
  positionOf,
  rejection,
  rowOf,
  setup,
  win,
  windowAnswer,
} from './kit.ts';

// 切窗与翻页（任务书「目标口径 · 请求」）：窗口 > 3 小时按 3 小时顺序切窗；每窗首页不带 positionIndex，
// 续页原样带上一页的 position_index，直到 has_next 为 false。一次 listOrders 取一个上游页，游标承载
// 「当前窗起点 + position_index」，可在新的适配器实例上续拉（照拼多多 cursor 的做法）。

const threeHoursMs = 3 * hourMs;
const iso = (ms: number): string => new Date(ms).toISOString();
const fromMs = Date.parse(win.from);
const sevenHours: TimeWindow = { from: win.from, to: iso(fromMs + 7 * hourMs) };
const W0 = '2026-10-30 10:00:00';
const W1 = '2026-10-30 13:00:00';
const W2 = '2026-10-30 16:00:00';

function spans(requests: readonly Record<string, string>[]): [number, number][] {
  return requests.map((q) => [beijingMs(q.startTime), beijingMs(q.endTime)]);
}

it('[AC-B1-04f#10] 恰好 3 小时不切窗：一次请求覆盖整个窗口', async () => {
  const s = setup(onePage([]));
  await collect(s.adapter, { from: win.from, to: iso(fromMs + threeHoursMs) });
  expect(s.requests).toHaveLength(1);
  expect(s.requests[0]).toMatchObject({ startTime: W0, endTime: W1 });
});

it('[AC-B1-04f#11] 3 小时多 1 秒切成两窗：[起点, 起点+3h]、[起点+3h, 终点]', async () => {
  const s = setup(onePage([]));
  await collect(s.adapter, { from: win.from, to: iso(fromMs + threeHoursMs + 1000) });
  expect(s.requests.map((q) => [q.startTime, q.endTime])).toEqual([
    [W0, W1],
    [W1, '2026-10-30 13:00:01'],
  ]);
});

it('[AC-B1-04f#12] 7 小时按 3 小时顺序切三窗，每窗用同一 queryType', async () => {
  const s = setup(onePage([]));
  await collect(s.adapter, sevenHours, { timeBasis: 'pay' });
  expect(s.requests.map((q) => [q.startTime, q.endTime])).toEqual([
    [W0, W1],
    [W1, W2],
    [W2, '2026-10-30 17:00:00'],
  ]);
  expect(s.requests.map((q) => q.queryType)).toEqual(['2', '2', '2']);
  expect(s.requests.every((q) => q.positionIndex === undefined)).toBe(true);
});

it.each([
  ['1 秒', 1000],
  ['2 小时 59 分 59 秒', threeHoursMs - 1000],
  ['6 小时', 2 * threeHoursMs],
  ['9 小时 1 秒', 3 * threeHoursMs + 1000],
  ['24 小时', 24 * hourMs],
])(
  '[AC-B1-04f#13] %s：各窗首尾相接、顺序递增、每窗 ≤ 3 小时，合起来恰好覆盖 [from, to]',
  async (_name, spanMs) => {
    const s = setup(onePage([]));
    await collect(s.adapter, { from: win.from, to: iso(fromMs + spanMs) });
    const got = spans(s.requests);
    expect(got).toHaveLength(Math.ceil(spanMs / threeHoursMs));
    expect(got[0]![0]).toBe(fromMs);
    expect(got[got.length - 1]![1]).toBe(fromMs + spanMs);
    for (const [index, [start, end]] of got.entries()) {
      expect(end).toBeGreaterThan(start);
      expect(end - start).toBeLessThanOrEqual(threeHoursMs);
      if (index > 0) expect(start).toBe(got[index - 1]![1]);
    }
  },
);

it('[AC-B1-04f#14] 窗内按 position_index 续页直到 has_next=false；每次 listOrders 只发一个上游请求', async () => {
  const pages = [[rowOf(1)], [rowOf(2), rowOf(3)], [rowOf(4)]];
  const s = setup(windowAnswer({ [W0]: pages }));
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let call = 1; call <= 3; call += 1) {
    const page = await listed(
      s.adapter.listOrders(win, cursor === undefined ? {} : { cursor }, ctx),
    );
    expect(s.transport).toHaveBeenCalledTimes(call);
    seen.push(...page.items.map((order) => order.order_id));
    if (call < 3) {
      expect(page.nextCursor).toBeTypeOf('string');
      cursor = page.nextCursor!;
    } else {
      expect(page.nextCursor).toBeNull();
    }
  }
  expect(seen).toEqual(pages.flat().map((input) => input.trade_id));
  expect(s.requests.map((q) => q.positionIndex)).toEqual([
    undefined,
    positionOf(0, 0),
    positionOf(0, 1),
  ]);
  // 续页仍是同一窗口、同一口径。
  for (const q of s.requests) {
    expect(q).toMatchObject({ startTime: W0, endTime: '2026-10-30 11:00:00', queryType: '4' });
  }
});

it('[AC-B1-04f#15] 多窗：一窗翻完（has_next=false）再进下一窗，空窗照样请求，订单按上游顺序', async () => {
  const s = setup(
    windowAnswer({
      [W0]: [[rowOf(1)], [rowOf(2)]],
      [W1]: [[]],
      [W2]: [[rowOf(3)]],
    }),
  );
  const { orders } = await collect(s.adapter, sevenHours);
  expect(s.requests.map((q) => [q.startTime, q.positionIndex])).toEqual([
    [W0, undefined],
    [W0, positionOf(0, 0)],
    [W1, undefined],
    [W2, undefined],
  ]);
  expect(orders.map((order) => order.order_id)).toEqual(
    [rowOf(1), rowOf(2), rowOf(3)].map((input) => input.trade_id),
  );
});

it('[AC-B1-04f#16] 游标自带「窗起点 + position_index」：换一个新的适配器实例也能从中断处续拉', async () => {
  const answer = windowAnswer({
    [W0]: [[rowOf(1)], [rowOf(2)]],
    [W1]: [[rowOf(3)]],
    [W2]: [[rowOf(4)]],
  });
  const first = setup(answer);
  const page1 = await listed(first.adapter.listOrders(sevenHours, {}, ctx));
  expect(page1.nextCursor).toBeTypeOf('string');

  const second = setup(answer);
  const page2 = await listed(
    second.adapter.listOrders(sevenHours, { cursor: page1.nextCursor! }, ctx),
  );
  expect(second.requests).toEqual([expect.objectContaining({ startTime: W0 })]);
  expect(second.requests[0]!.positionIndex).toBe(positionOf(0, 0));
  expect(page2.items.map((order) => order.order_id)).toEqual([rowOf(2).trade_id]);
  expect(page2.nextCursor).toBeTypeOf('string');

  // 一窗翻完后的游标指向下一窗首页（不带 positionIndex）。
  const third = setup(answer);
  const page3 = await listed(
    third.adapter.listOrders(sevenHours, { cursor: page2.nextCursor! }, ctx),
  );
  expect(third.requests).toHaveLength(1);
  expect(third.requests[0]).toMatchObject({ startTime: W1, endTime: W2 });
  expect(third.requests[0]).not.toHaveProperty('positionIndex');
  expect(page3.items.map((order) => order.order_id)).toEqual([rowOf(3).trade_id]);
});

it.each(['garbage', 'inc:2', 'range:2900000000000001001', '%%%'])(
  '[AC-B1-04f#17] 不认识的游标「%s」→ invalid_dto，不取凭据、不发请求',
  async (cursor) => {
    const s = setup(onePage([]));
    await rejection(() => s.adapter.listOrders(sevenHours, { cursor }, ctx), 'invalid_dto');
    expect(s.transport).not.toHaveBeenCalled();
    expect(s.dataokeCredentials).not.toHaveBeenCalled();
  },
);
