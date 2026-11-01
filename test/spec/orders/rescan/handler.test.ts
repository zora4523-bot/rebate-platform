// B1-04zm: the 'rescan-window' job. Shape follows test/spec/orders/sync/handler.test.ts.
import { expect, it } from 'vitest';
import type { JobPayload } from '../../../../apps/api/src/modules/platform/index.ts';
import { handleOrderRescanWindow } from '../../../../apps/api/src/modules/orders/jobs/order-rescan.ts';
import { OrderSyncPayloadError } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import {
  ACCOUNT,
  OTHER_ACCOUNT,
  fixture,
  job,
  order,
  pddStream,
  rescanWindow,
  window,
} from './kit.ts';

it('[AC-B1-04zm#28] 取完全部页、逐行交流水线，全部处理完才推进 rescan 游标一次', async () => {
  const f = fixture();
  const a = order('synthetic-a', '101');
  const b = order('synthetic-b', '101');
  const c = order('synthetic-c', '102');
  const events: string[] = [];
  f.listOrders.mockImplementation(async (_win, opt) => {
    events.push(opt.cursor === undefined ? 'page:1' : 'page:2');
    return opt.cursor === undefined
      ? { items: [a, b], nextCursor: 'opaque-next-page' }
      : { items: [c], nextCursor: null };
  });
  f.process.mockImplementation(async (item) => {
    events.push(`process:${item.order_id}`);
  });
  await handleOrderRescanWindow(job(), f.handler);
  expect(events).toEqual([
    'page:1',
    'process:synthetic-a',
    'process:synthetic-b',
    'page:2',
    'process:synthetic-c',
  ]);
  expect(f.get).toHaveBeenCalledWith('jd');
  expect(f.process.mock.calls.map(([item]) => item)).toEqual([a, b, c]);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
  expect(f.advance.mock.invocationCallOrder[0]).toBeGreaterThan(
    f.process.mock.invocationCallOrder.at(-1)!,
  );
  expect(f.cursor()).toBe(window.window_end);
});

it('[AC-B1-04zm#29] 走离线配额的 order_sync 用途，窗口取自任务，流水线上下文带本窗口', async () => {
  const f = fixture();
  f.listOrders
    .mockResolvedValueOnce({ items: [order('synthetic-a')], nextCursor: 'next' })
    .mockResolvedValueOnce({ items: [order('synthetic-b', '102')], nextCursor: null });
  f.clock.advanceMs(7_200_000);
  await handleOrderRescanWindow(job(), f.handler);
  expect(
    f.listOrders.mock.calls.map(([win, opt, ctx]) => ({
      win,
      cursor: opt.cursor ?? null,
      // The adapters' update-time query; jd refuses any other mode.
      mode: opt.queryMode ?? 'increment',
      appId: ctx.appId,
      purpose: ctx.purpose,
    })),
  ).toEqual(
    [null, 'next'].map((cursor) => ({
      win: { from: window.window_start, to: window.window_end },
      cursor,
      mode: 'increment',
      appId: window.app_id,
      purpose: 'order_sync',
    })),
  );
  for (const [, ctx] of f.process.mock.calls) {
    expect(ctx).toMatchObject({
      app_id: window.app_id,
      platform: 'jd',
      union_account_id: ACCOUNT,
      window_start: window.window_start,
      window_end: window.window_end,
      requestId: expect.any(String),
    });
  }
});

it('[AC-B1-04zm#30] 最后一单仍在处理中时游标不得推进', async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.listOrders.mockResolvedValue({ items: [order('held')], nextCursor: null });
  f.process.mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
  });
  const running = handleOrderRescanWindow(job(), f.handler);
  try {
    // Race lets NotImplemented fail immediately instead of turning a red test into a timeout.
    await Promise.race([entered.promise, running]);
    expect(f.advance).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    await running;
  }
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
});

it('[AC-B1-04zm#31] 上游报错原样抛出交队列重试，不处理、不推进', async () => {
  const f = fixture();
  const failure = new Error('synthetic union failure');
  f.listOrders.mockRejectedValue(failure);
  await expect(handleOrderRescanWindow(job(), f.handler)).rejects.toBe(failure);
  expect(f.process).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#32] 前页处理完而后页取页失败，整窗不推进', async () => {
  const f = fixture();
  const failure = new Error('synthetic later page failure');
  f.listOrders
    .mockResolvedValueOnce({ items: [order('already-processed')], nextCursor: 'next' })
    .mockRejectedValue(failure);
  await expect(handleOrderRescanWindow(job(), f.handler)).rejects.toBe(failure);
  expect(f.process.mock.calls.map(([item]) => item.order_id)).toEqual(['already-processed']);
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#33] 流水线失败原样抛出：不处理后面的行，不取下一页，不推进', async () => {
  const f = fixture();
  const failure = new Error('synthetic pipeline failure');
  f.listOrders.mockResolvedValue({
    items: [order('bad'), order('never-reached')],
    nextCursor: 'must-not-fetch',
  });
  f.process.mockRejectedValue(failure);
  await expect(handleOrderRescanWindow(job(), f.handler)).rejects.toBe(failure);
  expect(f.process).toHaveBeenCalledTimes(1);
  expect(f.listOrders).toHaveBeenCalledTimes(1);
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#34] 重试沿用原窗口，已处理的行再交一遍幂等端口，成功后才推进', async () => {
  const f = fixture({ cursor: window.window_start });
  const failure = new Error('synthetic transient failure');
  f.listOrders.mockResolvedValue({ items: [order('first')], nextCursor: null });
  f.process.mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  await expect(handleOrderRescanWindow(job(window, 1), f.handler)).rejects.toBe(failure);
  expect(f.cursor()).toBe(window.window_start);
  f.clock.advanceMs(7_200_000);
  await handleOrderRescanWindow(job(window, 2), f.handler);
  expect(f.listOrders.mock.calls.map(([win]) => win)).toEqual(
    Array.from({ length: 2 }, () => ({ from: window.window_start, to: window.window_end })),
  );
  expect(f.cursor()).toBe(window.window_end);
});

it.each([
  { label: '账号不是可查询账号', owner: OTHER_ACCOUNT },
  { label: '平台没有可查询账号', owner: null },
])('[AC-B1-04zm#35] $label：不拉取、不推进，正常结束', async ({ owner }) => {
  const f = fixture();
  f.queryableAccount.mockResolvedValue(owner);
  await handleOrderRescanWindow(job(), f.handler);
  expect(f.queryableAccount).toHaveBeenCalledWith('jd');
  expect(f.listOrders).not.toHaveBeenCalled();
  expect(f.process).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#36] 站长授权不可用：不拉取、不推进，恢复后同一窗口照常处理', async () => {
  const f = fixture();
  f.siteAuthAvailable.mockResolvedValueOnce(false).mockResolvedValue(true);
  await handleOrderRescanWindow(job(), f.handler);
  expect(f.siteAuthAvailable).toHaveBeenCalledWith(
    expect.objectContaining({
      app_id: window.app_id,
      platform: 'jd',
      union_account_id: ACCOUNT,
    }),
  );
  expect(f.listOrders).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
  await handleOrderRescanWindow(job(window, 2), f.handler);
  expect(f.listOrders).toHaveBeenCalledTimes(1);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
});

it('[AC-B1-04zm#37] 空中间页的 nextCursor 仍继续，空窗口也推进', async () => {
  const f = fixture();
  f.listOrders
    .mockResolvedValueOnce({ items: [], nextCursor: 'has-next' })
    .mockResolvedValueOnce({ items: [], nextCursor: null });
  await handleOrderRescanWindow(job(), f.handler);
  expect(f.listOrders.mock.calls.map(([, opt]) => opt.cursor ?? null)).toEqual([null, 'has-next']);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
});

it('[AC-B1-04zm#38] 翻页游标重复就让窗口失败，不死循环、不推进', async () => {
  const f = fixture();
  f.listOrders.mockResolvedValue({ items: [], nextCursor: 'same-page' });
  await expect(handleOrderRescanWindow(job(), f.handler)).rejects.toThrow(
    'order_sync_cursor_repeated',
  );
  expect(f.listOrders).toHaveBeenCalledTimes(2);
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#39] 游标存储异常必须交队列重试', async () => {
  const f = fixture();
  const failure = new Error('synthetic cursor failure');
  f.advance.mockRejectedValue(failure);
  await expect(handleOrderRescanWindow(job(), f.handler)).rejects.toBe(failure);
});

it('[AC-B1-04zm#40] CAS 未命中是乱序或重复窗口，正常结束，不强写游标', async () => {
  const f = fixture({ cursor: window.window_end });
  await handleOrderRescanWindow(job(), f.handler);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
  expect(f.rewind).not.toHaveBeenCalled();
  expect(f.cursor()).toBe(window.window_end);
});

const INVALID: readonly { readonly label: string; readonly patch: JobPayload }[] = [
  { label: 'query_kind 是 increment', patch: { query_kind: 'increment' } },
  { label: 'query_kind 是别的值', patch: { query_kind: 'pay_time' } },
  { label: 'scene 不是 -', patch: { scene: 'synthetic-scene' } },
  { label: 'app_id 为空', patch: { app_id: '' } },
  { label: '账号为空', patch: { union_account_id: '' } },
  { label: '起点不是时间', patch: { window_start: 'not-an-instant' } },
  { label: '终点不是时间', patch: { window_end: 'not-an-instant' } },
  { label: '空窗口', patch: { window_end: window.window_start } },
  {
    label: '窗口倒置',
    patch: { window_start: window.window_end, window_end: window.window_start },
  },
  { label: '平台是 taobao', patch: { platform: 'taobao' } },
  { label: '平台不认识', patch: { platform: 'synthetic-unlisted' } },
];

it.each(INVALID)('[AC-B1-04zm#41] $label：任务校验失败，不拉取', async ({ patch }) => {
  const f = fixture();
  await expect(
    handleOrderRescanWindow(job({ ...window, ...patch }), f.handler),
  ).rejects.toBeInstanceOf(OrderSyncPayloadError);
  expect(f.listOrders).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#42] 平台不在注入的 platforms 里同样校验失败', async () => {
  const f = fixture();
  const pdd = rescanWindow(window.window_start, 1_800_000, pddStream);
  await expect(
    handleOrderRescanWindow(job(pdd), { ...f.handler, platforms: ['jd'] }),
  ).rejects.toBeInstanceOf(OrderSyncPayloadError);
  expect(f.listOrders).not.toHaveBeenCalled();
});
