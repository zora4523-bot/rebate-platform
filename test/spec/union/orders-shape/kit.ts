import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  UnionOrder,
  UnionTransport,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/index.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import { ctx, detailRow, endpoint, row, win } from '../pdd-orders/kit.ts';

// B1-08e / D10-20 的任务内 AC；信封和值全部合成，不是平台录制。
export type Source = 'increment' | 'pay_time' | 'detail';
export const sources: readonly Source[] = ['increment', 'pay_time', 'detail'];

export function pdd(transport: UnionTransport): PddUnionAdapter {
  return new PddUnionAdapter({
    clock: new FixedClock(win.to),
    credentials: async () => ({ clientId: 'synthetic-client', clientSecret: 'fake-secret' }),
    transport,
    endpoint,
  });
}

export function reply(body: unknown, rawPayloadId?: string): UnionTransportResponse {
  // 结构扩展留在测试里；本阶段不改已有接口或实现。
  const result: UnionTransportResponse & { raw_payload_id?: string } = {
    status: 200,
    headers: { 'x-synthetic': 'orders-shape' },
    body: JSON.stringify(body),
    ...(rawPayloadId === undefined ? {} : { raw_payload_id: rawPayloadId }),
  };
  return result;
}

export function envelope(source: Source, input: Record<string, unknown>): unknown {
  return source === 'detail'
    ? { order_detail_response: input }
    : { order_list_get_response: { order_list: [input], last_order_id: '' } };
}

export function sourceRow(source: Source, overrides: Record<string, unknown> = {}) {
  return source === 'detail' ? detailRow(overrides) : row(overrides);
}

export async function one(
  source: Source,
  input: Record<string, unknown> = sourceRow(source),
  rawPayloadId?: string,
): Promise<UnionOrder> {
  const adapter = pdd(async () => reply(envelope(source, input), rawPayloadId));
  if (source === 'detail') return adapter.getPddOrderDetail(input.order_sn as string, ctx);
  const page = await adapter.listOrders(win, { queryMode: source }, ctx);
  expect(page.items).toHaveLength(1);
  return page.items[0]!;
}

/** 缺字段保留 undefined 给断言，不把旧实现包装成新形状，也不访问缺失的嵌套对象。 */
export function value(object: object, key: string): unknown {
  return Reflect.get(object, key);
}
