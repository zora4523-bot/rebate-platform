import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { UnionError, type CallCtx } from '../../domain/types.ts';
import type { UnionTransport, UnionTransportRequest } from '../replay.ts';
import { JdUnionAdapter } from './jd-adapter.ts';
import { JD_ORDER_KEYS } from './orders.ts';

// 规则测试没钉住的行为。报文全部合成，不是任何京东接口的录制。
const win = { from: '2026-10-30T02:00:00Z', to: '2026-10-30T03:00:00Z' };
const ctx: CallCtx = { appId: 'app-synthetic', requestId: 'req-synthetic', purpose: 'order_sync' };

function orderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '2026103012345678901',
    orderId: 3123456789012345,
    parentId: 0,
    skuId: 100012345678,
    itemId: 'synthAseg-Bseg',
    positionId: 3100000001,
    subUnionId: 'n_synthetic',
    validCode: 16,
    orderTime: '2026-10-30 10:00:01',
    modifyTime: '2026-10-30 10:30:02',
    finishTime: '',
    estimateFee: 1.23,
    actualFee: 0.0,
    estimateCosPrice: 45.6,
    actualCosPrice: 0.0,
    ...overrides,
  };
}

function setup(innerOf: (orderReq: Record<string, unknown>) => unknown) {
  const transport = vi.fn<UnionTransport>(async (request: UnionTransportRequest) => {
    const parameters = new URLSearchParams(request.body ?? '').get('360buy_param_json') ?? '{}';
    const { orderReq } = JSON.parse(parameters) as { orderReq: Record<string, unknown> };
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        [JD_ORDER_KEYS.envelope]: {
          code: '0',
          [JD_ORDER_KEYS.resultKey]: JSON.stringify(innerOf(orderReq)),
        },
      }),
    };
  });
  const adapter = new JdUnionAdapter({
    clock: new FixedClock('2026-10-30T15:55:42.000Z'),
    credentials: async () => ({ appKey: 'k', appSecret: 's' }),
    transport,
    endpoint: {
      platform: 'jd',
      mode: 'live',
      baseUrl: 'https://jd-gateway.invalid/routerjson',
      quotaKey: 'jd-example',
    },
  });
  return { adapter, transport };
}

function single(row: Record<string, unknown>) {
  return setup(() => ({ code: 200, hasMore: false, data: [row] })).adapter.listOrders(win, {}, ctx);
}

it('[AC-B1-04zb#82] 上一页说还有、下一页 data 与 hasMore 都缺：报 UnionError，不算结束', async () => {
  const { adapter, transport } = setup((orderReq) =>
    orderReq.pageIndex === 1
      ? { code: 200, hasMore: true, data: [orderRow()] }
      : { code: 200, message: 'success' },
  );
  const first = await adapter.listOrders(win, {}, ctx);
  expect(first.nextCursor).not.toBeNull();
  const next = { cursor: first.nextCursor! };
  await expect(adapter.listOrders(win, next, ctx)).rejects.toBeInstanceOf(UnionError);
  expect(transport).toHaveBeenCalledTimes(2);
});

it.each([
  ['非数字', 'not-a-number'],
  ['负数', -1],
  ['null', null],
] as const)('[AC-B1-04zb#83] 未完成单的 actualFee、actualCosPrice 是%s：不读', async (_n, bad) => {
  const page = await single(orderRow({ actualFee: bad, actualCosPrice: bad }));
  expect(page.items[0]).toMatchObject({ settle_commission_fen: null, paid_fen: 4560n });
});

it('[AC-B1-04zb#84] 请求不带 positionId，别的推广位与无效单照常返回', async () => {
  const seen: Record<string, unknown>[] = [];
  const { adapter } = setup((orderReq) => {
    seen.push(orderReq);
    return {
      code: 200,
      hasMore: false,
      data: [orderRow({ positionId: 3199999999, validCode: 3 })],
    };
  });
  const page = await adapter.listOrders(win, {}, ctx);
  expect(Object.keys(seen[0]!)).not.toContain('positionId');
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.raw_status).toBe('3');
});

it('[AC-B1-04zb#85] 待付款单不读 orderTime，空值不影响该行', async () => {
  const page = await single(orderRow({ validCode: 15, orderTime: '' }));
  expect(page.items[0]).toMatchObject({ paid_at: null, deposit_paid_at: null });
});

it.each(['2026-02-30 10:00:00', '2026-10-30 24:00:00', '2026-13-01 10:00:00'])(
  '[AC-B1-04zb#86] 不存在的时刻 %s → invalid_dto，不滚到别的日期',
  async (modifyTime) => {
    await expect(single(orderRow({ modifyTime }))).rejects.toMatchObject({
      code: 'invalid_dto',
      platform: 'jd',
    });
  },
);

it.each([
  ['别的查询的游标', { cursor: 'inc:2' }],
  ['第 1 页的游标', { cursor: 'jd-order:1' }],
  ['不支持的查询方式', { queryMode: 'pay_time' }],
] as const)('[AC-B1-04zb#87] %s → invalid_dto，不发请求', async (_name, options) => {
  const { adapter, transport } = setup(() => ({ code: 200, hasMore: false, data: [] }));
  await expect(adapter.listOrders(win, options, ctx)).rejects.toMatchObject({
    code: 'invalid_dto',
  });
  expect(transport).not.toHaveBeenCalled();
});

it('[AC-B1-04zb#88] 缺 itemId 时 item 模式给 null，不用 skuId 顶替', async () => {
  const page = await single(orderRow({ itemId: '' }));
  expect(page.items[0]?.item_id).toBeNull();
});
