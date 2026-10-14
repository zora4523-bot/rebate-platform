import { expect, it } from 'vitest';
import { ctx, detail, detailRow, setup } from './kit.ts';

it('[AC-B1-04i-DETAIL#1] 详情按 order_sn 请求并从 order_detail_response 直接解包，pid 与列表统一', async () => {
  const source = detailRow();
  const { adapter, requests, transport } = setup((body) => {
    expect(body.type).toBe(detail);
    expect(body.order_sn).toBe(source.order_sn);
    expect(body).not.toHaveProperty('order_id');
    expect(body).not.toHaveProperty('page');
    return { order_detail_response: source };
  });
  const signal = new AbortController().signal;
  const dto = await adapter.getPddOrderDetail(source.order_sn as string, { ...ctx, signal });
  expect(dto).toMatchObject({
    platform: 'pdd',
    order_id: source.order_sn,
    platform_order_id: null,
    goods_id: '8123456789012345',
    goods_sign: source.goods_sign,
    pid: source.pid,
    custom_parameters: source.custom_parameters,
    paid_fen: 8765432n,
    commission_fen: 76543n,
    service_fee_fen: 4321n,
    promotion_rate: 127n,
    sep_rate: 19n,
    order_status: 4,
    return_status: null,
    fail_reason: null,
    order_receive_time: null,
    order_verify_time: null,
    order_settle_time: null,
    url_last_generate_time: 1791936008,
    subsidy_duo_amount_level: 54321n,
  });
  expect(requests).toHaveLength(1);
  expect(transport.mock.calls[0]?.[0].signal).toBe(signal);
});

it.each([0, 1, 2])(
  '[AC-B1-04i-DETAIL#2] 详情售后状态 %i 单独透传，不覆盖订单状态与金额',
  async (returnStatus) => {
    // Explicit task exception: return_status is optional although absent in this probe run.
    const { adapter } = setup(() => ({
      order_detail_response: detailRow({ return_status: returnStatus }),
    }));
    const dto = await adapter.getPddOrderDetail('synthetic-detail', ctx);
    expect(dto.return_status).toBe(returnStatus);
    expect(dto.order_status).toBe(4);
    expect(dto.commission_fen).toBe(76543n);
    expect(dto.paid_fen).toBe(8765432n);
  },
);

it.each(['', '   '])('[AC-B1-04i-DETAIL#3] 空白订单号 %j 不发起请求', async (orderSn) => {
  const { adapter, credentials, transport } = setup(() => ({ order_detail_response: detailRow() }));
  await expect(adapter.getPddOrderDetail(orderSn, ctx)).rejects.toMatchObject({
    code: 'invalid_dto',
    platform: 'pdd',
  });
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
