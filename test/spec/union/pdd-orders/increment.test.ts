import { expect, it } from 'vitest';
import type { OrderQueryOpt } from '../../../../apps/api/src/modules/union/index.ts';
import { collect, ctx, incrementReply, row, setup, win } from './kit.ts';

it.each([{}, { queryMode: 'increment' }] satisfies OrderQueryOpt[])(
  '[AC-B1-04i-INC#1] 默认与显式 increment 按更新时间查询，固定 50 条和 return_count=false：%j',
  async (options) => {
    const { adapter, requests } = setup(incrementReply([row()]));
    expect(await collect(adapter, win, options)).toHaveLength(1);
    expect(requests.length).toBeGreaterThan(0);
    for (const body of requests) {
      expect(body.start_update_time).toBe(Date.parse(win.from) / 1000);
      expect(body.end_update_time).toBe(Date.parse(win.to) / 1000);
      expect(body).not.toHaveProperty('start_time');
      expect(body).not.toHaveProperty('end_time');
      expect(body).not.toHaveProperty('last_order_id');
    }
  },
);

it.each([undefined, 0, 9999])(
  '[AC-B1-04i-INC#2] 不依赖 total_count=%s；输出从尾页回到首页，不漏单或重复',
  async (totalCount) => {
    const rows = Array.from({ length: 112 }, (_, i) => row({ order_sn: `synthetic-${i + 1}` }));
    const { adapter, requests } = setup(incrementReply(rows, totalCount));
    const items = await collect(adapter);
    // Upstream row order within a page is untouched; only the page traversal is reversed.
    const expected = [...rows.slice(100), ...rows.slice(50, 100), ...rows.slice(0, 50)];
    expect(items.map((item) => item.order_id)).toEqual(expected.map((item) => item.order_sn));
    expect(new Set(items.map((item) => item.order_id)).size).toBe(112);
    // Tail discovery may probe other pages, but the actual final traversal must fetch backwards.
    // Merely caching an ascending scan and reversing its output would still risk missing orders.
    expect(
      requests
        .map((body) => body.page)
        .filter((page) => (page as number) <= 3)
        .slice(-3),
    ).toEqual([3, 2, 1]);
  },
);

it.each([0, 50, 100])('[AC-B1-04i-INC#3] 空结果与刚好整页 %i 条均正常终止', async (count) => {
  const rows = Array.from({ length: count }, (_, i) => row({ order_sn: `boundary-${i}` }));
  const { adapter } = setup(incrementReply(rows));
  const items = await collect(adapter);
  expect(items.map((item) => item.order_id)).toEqual(
    [...rows.slice(50), ...rows.slice(0, 50)].map((item) => item.order_sn),
  );
});

it.each([
  { from: '2026-10-13T23:59:59Z', to: win.to },
  { from: '2026-07-16T23:59:59Z', to: '2026-07-17T00:00:00Z' },
  { from: win.to, to: win.from },
  { from: 'invalid-date', to: win.to },
])('[AC-B1-04i-INC#4] 非法窗口在取凭据和请求前拒绝：%j', async (window) => {
  const { adapter, transport, credentials } = setup(incrementReply([]));
  await expect(adapter.listOrders(window, {}, ctx)).rejects.toMatchObject({
    code: 'invalid_dto',
    platform: 'pdd',
  });
  expect(transport).not.toHaveBeenCalled();
  expect(credentials).not.toHaveBeenCalled();
});

it('[AC-B1-04i-INC#5] 恰好 90 天和恰好 24 小时可查；注入时钟前进一秒则过期', async () => {
  const { adapter, clock, requests } = setup(incrementReply([]));
  const oldest = { from: '2026-07-17T00:00:00Z', to: '2026-07-18T00:00:00Z' };
  expect(await collect(adapter, oldest)).toEqual([]);
  const before = requests.length;
  clock.advanceMs(1000);
  await expect(adapter.listOrders(oldest, {}, ctx)).rejects.toMatchObject({ code: 'invalid_dto' });
  expect(requests).toHaveLength(before);
});

it('[AC-B1-04i-INC#6] 等价时区表示得到相同的秒级 UTC 查询边界', async () => {
  const { adapter, requests } = setup(incrementReply([]));
  expect(
    await collect(adapter, { from: '2026-10-14T08:00:00+08:00', to: '2026-10-15T08:00:00+08:00' }),
  ).toEqual([]);
  for (const body of requests) {
    expect(body.start_update_time).toBe(Date.parse(win.from) / 1000);
    expect(body.end_update_time).toBe(Date.parse(win.to) / 1000);
  }
});
