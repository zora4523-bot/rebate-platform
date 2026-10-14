import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  CallCtx,
  OrderQueryOpt,
  TimeWindow,
  UnionAdapter,
  UnionEndpoint,
  UnionOrder,
  UnionTransport,
} from '../../../../apps/api/src/modules/union/index.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';

// B1-04i task-local AC labels. All payload values are synthetic, not private recordings.
// Field names come from the task's probe allowlist; no recorded/masked values are reused.
export const ctx: CallCtx = {
  appId: 'synthetic-orders-app',
  requestId: 'synthetic-orders-request',
  purpose: 'order_sync',
};
export const endpoint: UnionEndpoint = {
  platform: 'pdd',
  mode: 'live',
  baseUrl: 'https://orders-gateway.invalid/router',
  quotaKey: 'synthetic-orders-account',
};
export const win: TimeWindow = {
  from: '2026-10-14T00:00:00Z',
  to: '2026-10-15T00:00:00Z',
};
export const increment = 'pdd.ddk.order.list.increment.get';
export const range = 'pdd.ddk.order.list.range.get';
export const detail = 'pdd.ddk.order.detail.get';

export function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_sn: '000000000000000000000000012345-SYN',
    order_id: '000000000000000000000000099999-SYN',
    p_id: 'synthetic-list-pid',
    goods_id: 8123456789012345,
    goods_sign: 'synthetic-goods-sign',
    goods_name: '合成订单商品',
    custom_parameters: ' { "app": "synthetic-orders-app", "uid": "fake-attr", "sc": 9 } ',
    goods_price: 9876543,
    order_amount: 8765432,
    promotion_amount: 76543,
    duo_id_service_fee: 4321,
    promotion_rate: 127,
    sep_rate: 19,
    platform_discount: 6543,
    sep_market_fee: 2345,
    order_status: 4,
    order_status_desc: '合成审核失败说明',
    fail_reason: '合成失败原因',
    order_create_time: 1791936001,
    order_pay_time: 1791936002,
    order_group_success_time: 1791936003,
    order_receive_time: 1791936004,
    order_verify_time: 1791936005,
    order_settle_time: 1791936006,
    order_modify_at: 1791936007,
    subsidy_duo_amount_level: 54321,
    subsidy_type: 3,
    subsidy_list: [],
    ...overrides,
  };
}

export function detailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = row();
  for (const field of [
    'order_id',
    'p_id',
    'order_receive_time',
    'order_verify_time',
    'order_settle_time',
    'fail_reason',
  ])
    delete value[field];
  return {
    ...value,
    pid: 'synthetic-detail-pid',
    cps_sign: 'synthetic-cps-sign',
    url_last_generate_time: 1791936008,
    ...overrides,
  };
}

export function setup(reply: (body: Record<string, unknown>) => unknown) {
  const clock = new FixedClock('2026-10-15T00:00:00Z');
  const requests: Record<string, unknown>[] = [];
  const credentials = vi.fn(async () => ({
    clientId: 'synthetic-client',
    clientSecret: 'fake-secret',
  }));
  const transport = vi.fn<UnionTransport>(async (request) => {
    expect(request.body).toBeTypeOf('string');
    const body = JSON.parse(request.body!) as Record<string, unknown>;
    requests.push(body);
    return { status: 200, headers: {}, body: JSON.stringify(reply(body)) };
  });
  const adapter = new PddUnionAdapter({ clock, credentials, transport, endpoint });
  return { adapter, clock, credentials, transport, requests };
}

/** A stable tiny upstream dataset; ignores total_count exactly as the task requires. */
export function incrementReply(rows: readonly unknown[], totalCount?: number) {
  return (body: Record<string, unknown>) => {
    expect(body.type).toBe(increment);
    expect(body.page_size).toBe(50);
    expect(body.return_count).toBe(false);
    expect(Number.isInteger(body.page)).toBe(true);
    const page = body.page as number;
    expect(page).toBeGreaterThanOrEqual(1);
    expect(page).toBeLessThanOrEqual(10000);
    return {
      order_list_get_response: {
        order_list: rows.slice((page - 1) * 50, page * 50),
        ...(totalCount === undefined ? {} : { total_count: totalCount }),
      },
    };
  };
}

/** Cursor is deliberately opaque: neither its encoding nor tail-discovery strategy is fixed. */
export async function collect(
  adapter: UnionAdapter,
  window: TimeWindow = win,
  options: OrderQueryOpt = {},
): Promise<UnionOrder[]> {
  const result: UnionOrder[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 10; i += 1) {
    const page = await adapter.listOrders(
      window,
      { ...options, ...(cursor === undefined ? {} : { cursor }) },
      ctx,
    );
    result.push(...page.items);
    if (page.nextCursor === null) return result;
    expect(page.nextCursor).toBeTypeOf('string');
    expect(page.nextCursor.length).toBeGreaterThan(0);
    expect(cursors.has(page.nextCursor)).toBe(false);
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  expect.fail('synthetic pagination must terminate');
}

export async function oneIncrement(input: Record<string, unknown>): Promise<UnionOrder> {
  const { adapter } = setup(incrementReply([input]));
  const items = await collect(adapter);
  expect(items).toHaveLength(1);
  return items[0]!;
}
