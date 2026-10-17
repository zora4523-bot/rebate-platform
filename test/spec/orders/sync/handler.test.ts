import { expect, it } from 'vitest';
import { handleOrderSyncWindow } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import { END, START, fixture, job, order, window } from './kit.ts';

it('[AC-B1-08g#10] 每页归档已完成后交流水线，全部子订单结束后才推进一次水位', async () => {
  const f = fixture();
  const a = order('synthetic-a', '101');
  const b = order('synthetic-b', '101');
  const c = order('synthetic-c', '102');
  const events: string[] = [];
  f.listOrders.mockImplementation(async (_win, opt) => {
    // B1-08e owns the committed archive. The fake adapter exposes normalized pages only
    // after that boundary; orders must preserve these IDs and await each page's pipeline.
    events.push(opt.cursor === undefined ? 'archived:101' : 'archived:102');
    return opt.cursor === undefined
      ? { items: [a, b], nextCursor: 'opaque-next-page' }
      : { items: [c], nextCursor: null };
  });
  f.process.mockImplementation(async (item) => {
    events.push(`process:${item.order_id}`);
  });
  f.advance.mockImplementation(async () => {
    events.push('advance');
    return true;
  });
  await handleOrderSyncWindow(job(), f.handler);
  expect(events).toEqual([
    'archived:101',
    'process:synthetic-a',
    'process:synthetic-b',
    'archived:102',
    'process:synthetic-c',
    'advance',
  ]);
  expect(f.get).toHaveBeenCalledWith('pdd');
  expect(
    f.listOrders.mock.calls.map(([win, opt, ctx]) => ({
      win,
      cursor: opt.cursor ?? null,
      mode: opt.queryMode,
      appId: ctx.appId,
      purpose: ctx.purpose,
    })),
  ).toEqual([
    {
      win: { from: START, to: END },
      cursor: null,
      mode: 'increment',
      appId: window.app_id,
      purpose: 'order_sync',
    },
    {
      win: { from: START, to: END },
      cursor: 'opaque-next-page',
      mode: 'increment',
      appId: window.app_id,
      purpose: 'order_sync',
    },
  ]);
  expect(f.process.mock.calls.map(([item]) => item)).toEqual([a, b, c]);
  for (const [, ctx] of f.process.mock.calls) {
    expect(ctx).toMatchObject({ ...window, requestId: expect.any(String) });
  }
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
});

it('[AC-B1-08g#11] 最后一单仍在处理中时水位不得提前推进', async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.listOrders.mockResolvedValue({ items: [order('held')], nextCursor: null });
  f.process.mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
  });
  const running = handleOrderSyncWindow(job(), f.handler);
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

it('[AC-B1-08g#12] 末页有一单失败就抛原异常，不推进水位，不在 handler 内重试', async () => {
  const f = fixture();
  const failure = new Error('synthetic pipeline database failure');
  f.listOrders
    .mockResolvedValueOnce({ items: [order('ok')], nextCursor: 'page-2' })
    .mockResolvedValueOnce({ items: [order('bad', '102')], nextCursor: null });
  f.process.mockImplementation(async (item) => {
    if (item.order_id === 'bad') throw failure;
  });
  await expect(handleOrderSyncWindow(job(), f.handler)).rejects.toBe(failure);
  expect(f.process.mock.calls.map(([item]) => item.order_id)).toEqual(['ok', 'bad']);
  expect(f.listOrders).toHaveBeenCalledTimes(2);
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-08g#13] 取出任务时授权不可用，正常结束且不拉取、不处理、不推进', async () => {
  const f = fixture();
  f.siteAuthAvailable.mockResolvedValue(false);
  await handleOrderSyncWindow(job(), f.handler);
  expect(f.siteAuthAvailable).toHaveBeenCalledWith(
    expect.objectContaining({
      app_id: window.app_id,
      platform: 'pdd',
      union_account_id: window.union_account_id,
    }),
  );
  expect(f.listOrders).not.toHaveBeenCalled();
  expect(f.process).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-08g#14] 首次暂停后同一窗口恢复可处理，空末页也推进', async () => {
  const f = fixture();
  f.siteAuthAvailable.mockResolvedValueOnce(false).mockResolvedValue(true);
  await handleOrderSyncWindow(job(), f.handler);
  expect(f.advance).not.toHaveBeenCalled();
  await handleOrderSyncWindow(job(window, 2), f.handler);
  expect(f.listOrders).toHaveBeenCalledTimes(1);
  expect(f.process).not.toHaveBeenCalled();
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
});

it('[AC-B1-08g#15] 空中间页的 nextCursor 仍继续，直至真正末页', async () => {
  const f = fixture();
  f.listOrders
    .mockResolvedValueOnce({ items: [], nextCursor: 'has-next' })
    .mockResolvedValueOnce({ items: [order('after-empty')], nextCursor: null });
  await handleOrderSyncWindow(job(), f.handler);
  expect(f.listOrders.mock.calls.map(([, opt]) => opt.cursor ?? null)).toEqual([null, 'has-next']);
  expect(f.process).toHaveBeenCalledTimes(1);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
});

it('[AC-B1-08g#16] 联盟归档或取页失败透传异常，不调用流水线和推进水位', async () => {
  const f = fixture();
  const failure = new Error('synthetic union archive failure');
  f.listOrders.mockRejectedValue(failure);
  await expect(handleOrderSyncWindow(job(), f.handler)).rejects.toBe(failure);
  expect(f.listOrders).toHaveBeenCalledTimes(1);
  expect(f.process).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-08g#17] 水位存储异常必须交队列重试，不能吞掉当作成功', async () => {
  const f = fixture();
  const failure = new Error('synthetic cursor commit failure');
  f.advance.mockRejectedValue(failure);
  await expect(handleOrderSyncWindow(job(), f.handler)).rejects.toBe(failure);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
});

it('[AC-B1-08g#18] CAS 未命中是乱序或重复窗口，不能强制重写水位', async () => {
  const f = fixture();
  f.advance.mockResolvedValue(false);
  await handleOrderSyncWindow(job(), f.handler);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
});

it('[AC-B1-08g#33] 首页面内失败不得取下一页，已归档引用仍保留', async () => {
  const f = fixture();
  const failure = new Error('synthetic first page pipeline failure');
  const archived = order('first-page-failed', '103');
  f.listOrders.mockResolvedValue({ items: [archived], nextCursor: 'must-not-fetch' });
  f.process.mockRejectedValue(failure);
  await expect(handleOrderSyncWindow(job(), f.handler)).rejects.toBe(failure);
  expect(f.listOrders).toHaveBeenCalledTimes(1);
  expect(f.process).toHaveBeenCalledTimes(1);
  expect(f.process.mock.calls[0]?.[0]).toEqual(archived);
  expect(archived.raw_payload_id).toBe('103');
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-08g#34] 前页处理完但后页取页失败，整个窗口仍不推进', async () => {
  const f = fixture();
  const failure = new Error('synthetic later page fetch failure');
  f.listOrders
    .mockResolvedValueOnce({ items: [order('already-processed')], nextCursor: 'next' })
    .mockRejectedValue(failure);
  await expect(handleOrderSyncWindow(job(), f.handler)).rejects.toBe(failure);
  expect(f.listOrders).toHaveBeenCalledTimes(2);
  expect(f.process.mock.calls.map(([item]) => item.order_id)).toEqual(['already-processed']);
  expect(f.advance).not.toHaveBeenCalled();
});
