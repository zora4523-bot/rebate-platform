// B1-04zm: the row comparison of a finished window (D10-524: an order first inserted by a rescan
// is one the increment missed).
import { expect, it } from 'vitest';
import type { OrderPipelineResult } from '../../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import { handleOrderRescanWindow } from '../../../../apps/api/src/modules/orders/jobs/order-rescan.ts';
import { ACCOUNT, fixture, job, logged, order, window } from './kit.ts';

const DONE = 'order_sync_rescan_window_done';
const MISSING = 'order_sync_rescan_found_missing';

function fields(pages: number, count: number, inserted: number) {
  return {
    platform: 'jd',
    account: ACCOUNT,
    window_start: window.window_start,
    window_end: window.window_end,
    pages,
    count,
    inserted,
  };
}

it('[AC-B1-04zm#43] 全部已有：记窗口完成的页数、行数、0 入库，不告警', async () => {
  const f = fixture();
  f.listOrders
    .mockResolvedValueOnce({ items: [order('a'), order('b')], nextCursor: 'next' })
    .mockResolvedValueOnce({ items: [order('c', '102')], nextCursor: null });
  f.process.mockResolvedValue({ kind: 'unchanged' });
  await handleOrderRescanWindow(job(), f.handler);
  expect(logged(f.logger.info, DONE)).toEqual([expect.objectContaining(fields(2, 3, 0))]);
  expect(logged(f.logger.warn, MISSING)).toEqual([]);
});

it('[AC-B1-04zm#44] 有首次入库：warn 一次，只含这些计数字段', async () => {
  const f = fixture();
  f.listOrders.mockResolvedValue({
    items: [order('a'), order('b'), order('c')],
    nextCursor: null,
  });
  f.process
    .mockResolvedValueOnce({ kind: 'inserted', order_id: 'synthetic-internal-a' })
    .mockResolvedValueOnce({ kind: 'unchanged' })
    .mockResolvedValueOnce({ kind: 'inserted', order_id: 'synthetic-internal-c' });
  await handleOrderRescanWindow(job(), f.handler);
  expect(logged(f.logger.info, DONE)).toEqual([expect.objectContaining(fields(1, 3, 2))]);
  expect(logged(f.logger.warn, MISSING)).toEqual([fields(1, 3, 2)]);
});

it('[AC-B1-04zm#45] 只有 inserted 算首次入库，其余结果和无返回值都只算行数', async () => {
  const f = fixture();
  const results: (OrderPipelineResult | undefined)[] = [
    { kind: 'inserted' },
    { kind: 'updated' },
    { kind: 'dropped', reason: 'PID_NOT_OURS' },
    { kind: 'pending', reason: 'UNMAPPED_STATUS' },
    { kind: 'unchanged' },
    { kind: 'stale' },
    { kind: 'app_conflict' },
    undefined,
  ];
  f.listOrders.mockResolvedValue({
    items: results.map((_, index) => order(`row-${index}`)),
    nextCursor: null,
  });
  for (const result of results) f.process.mockResolvedValueOnce(result);
  await handleOrderRescanWindow(job(), f.handler);
  expect(logged(f.logger.info, DONE)).toEqual([expect.objectContaining(fields(1, 8, 1))]);
  expect(logged(f.logger.warn, MISSING)).toEqual([fields(1, 8, 1)]);
});

it('[AC-B1-04zm#46] 空窗口也记完成：1 页 0 行', async () => {
  const f = fixture();
  await handleOrderRescanWindow(job(), f.handler);
  expect(logged(f.logger.info, DONE)).toEqual([expect.objectContaining(fields(1, 0, 0))]);
  expect(logged(f.logger.warn, MISSING)).toEqual([]);
});

it('[AC-B1-04zm#47] 失败或暂停的窗口不记完成', async () => {
  const f = fixture();
  f.listOrders.mockRejectedValueOnce(new Error('synthetic union failure'));
  await expect(handleOrderRescanWindow(job(), f.handler)).rejects.toThrow(
    'synthetic union failure',
  );
  f.siteAuthAvailable.mockResolvedValueOnce(false);
  await handleOrderRescanWindow(job(window, 2), f.handler);
  expect(logged(f.logger.info, DONE)).toEqual([]);
});

it('[AC-B1-04zm#48] 日志不含订单号与用户参数', async () => {
  const f = fixture();
  f.listOrders.mockResolvedValue({
    items: [
      {
        ...order('secret-order-no'),
        parent_order_id: 'secret-parent-no',
        attr_params: {
          relation_id: 'secret-relation',
          custom_parameters: 'secret-buyer-param',
          sub_union_id: 'secret-sub-union',
        },
      },
    ],
    nextCursor: null,
  });
  f.process.mockResolvedValue({ kind: 'inserted', order_id: 'secret-internal-id' });
  await handleOrderRescanWindow(job(), f.handler);
  expect(logged(f.logger.warn, MISSING)).toHaveLength(1);
  const written = JSON.stringify([
    f.logger.info.mock.calls,
    f.logger.warn.mock.calls,
    f.logger.error.mock.calls,
  ]);
  expect(written).not.toContain('secret');
});
