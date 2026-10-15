import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { UnionError, type UnionEndpoint } from '../../domain/types.ts';
import type { UnionTransport } from '../replay.ts';
import { PddUnionAdapter } from './pdd-adapter.ts';
import { incrementWindow, mapPddOrder, parseIncrementCursor, rangeWindow } from './orders.ts';

const endpoint: UnionEndpoint = {
  platform: 'pdd',
  mode: 'live',
  baseUrl: 'https://pdd-gateway.invalid/api/router',
  quotaKey: 'unit',
};
const ctx = { appId: 'unit-app', requestId: 'unit-req', purpose: 'order_sync' } as const;
const base = { order_sn: 'unit-sn', order_amount: 100, promotion_amount: 10 };

function setup(reply: (body: Record<string, unknown>) => unknown) {
  const bodies: Record<string, unknown>[] = [];
  const transport = vi.fn<UnionTransport>(async (request) => {
    const body = JSON.parse(request.body!) as Record<string, unknown>;
    bodies.push(body);
    return { status: 200, headers: {}, body: JSON.stringify(reply(body)) };
  });
  const adapter = new PddUnionAdapter({
    clock: new FixedClock('2026-10-15T00:00:00Z'),
    credentials: async () => ({ clientId: 'unit-client', clientSecret: 'unitValue' }),
    transport,
    endpoint,
  });
  return { adapter, bodies };
}

it('[AC-B1-04i-UNIT#2] 北京时间换算跨年、闰日正确；亚秒边界向外取整', () => {
  expect(rangeWindow({ from: '2027-12-31T16:00:00Z', to: '2028-02-29T15:59:59Z' })).toEqual({
    start_time: '2028-01-01 00:00:00',
    end_time: '2028-02-29 23:59:59',
  });
  expect(
    incrementWindow(
      { from: '2026-10-14T00:00:00.400Z', to: '2026-10-14T01:00:00.400Z' },
      Date.parse('2026-10-15T00:00:00Z'),
    ),
  ).toEqual({
    start_update_time: Date.parse('2026-10-14T00:00:00Z') / 1000,
    end_update_time: Date.parse('2026-10-14T01:00:01Z') / 1000,
  });
});

it('[AC-B1-04i-UNIT#3] 游标格式不对或与查询方式不符报 invalid_dto，且不发请求', async () => {
  expect(parseIncrementCursor('inc:7')).toBe(7);
  const { adapter, bodies } = setup(() => ({}));
  const win = { from: '2026-10-14T00:00:00Z', to: '2026-10-14T12:00:00Z' };
  for (const [cursor, queryMode] of [
    ['inc:0', 'increment'],
    ['inc:10001', 'increment'],
    ['range:abc', 'increment'],
    ['inc:3', 'pay_time'],
    ['range:', 'pay_time'],
  ] as const) {
    await expect(adapter.listOrders(win, { cursor, queryMode }, ctx)).rejects.toMatchObject({
      code: 'invalid_dto',
    });
  }
  expect(bodies).toHaveLength(0);
});

it('[AC-B1-04i-UNIT#4] subsidy_list 成员不进 DTO，只保留长度', () => {
  const dto = mapPddOrder({ ...base, subsidy_list: [{ subsidy_amount: 5 }, {}] }, 'increment');
  expect(dto.subsidy_list).toEqual([null, null]);
  expect(JSON.stringify(dto.subsidy_list)).not.toContain('subsidy_amount');
  expect(() => mapPddOrder({ ...base, subsidy_list: {} }, 'increment')).toThrow(UnionError);
});

it('[AC-B1-04i-UNIT#5] 按接口取字段：range 不读 order_id，详情不读列表专有字段', () => {
  const range = mapPddOrder({ ...base, order_id: 'unit-id', p_id: 'unit-pid' }, 'range');
  expect(range.platform_order_id).toBeNull();
  expect(range.pid).toBe('unit-pid');
  const detail = mapPddOrder(
    { ...base, p_id: 'list-pid', fail_reason: 'x', order_receive_time: 1, return_status: 1 },
    'detail',
  );
  expect(detail).toMatchObject({
    pid: null,
    fail_reason: null,
    order_receive_time: null,
    return_status: 1,
  });
});

it('[AC-B1-04i-UNIT#6] range 迭代器原样不变但仍有数据时也结束，避免死循环', async () => {
  const { adapter } = setup(() => ({
    order_list_get_response: { order_list: [base], last_order_id: 'same' },
  }));
  const page = await adapter.listOrders(
    { from: '2026-10-14T00:00:00Z', to: '2026-10-14T12:00:00Z' },
    { queryMode: 'pay_time', cursor: 'range:same' },
    ctx,
  );
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).toBeNull();
});

it('[AC-B1-04w-UNIT#3] 整个窗口落在 90 天界所在那一秒时，收回后的起点不追上终点', () => {
  const nowMs = Date.parse('2026-10-15T00:00:00.500Z');
  const oldestMs = nowMs - 90 * 86_400_000;
  const window = incrementWindow(
    { from: new Date(oldestMs).toISOString(), to: new Date(oldestMs + 1).toISOString() },
    nowMs,
  );
  expect(window.start_update_time).toBe(Math.ceil(oldestMs / 1000));
  expect(window.end_update_time).toBe(window.start_update_time + 1);
});

it('[AC-B1-04w-UNIT#4] 直接映射时普通数值商品号只接受非负安全整数', () => {
  expect(mapPddOrder({ ...base, goods_id: 42 }, 'increment').goods_id).toBe('42');
  for (const goods_id of [2 ** 53, -1, 1.5]) {
    expect(() => mapPddOrder({ ...base, goods_id }, 'increment')).toThrow(UnionError);
  }
});
