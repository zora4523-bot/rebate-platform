import { expect, it } from 'vitest';
import { collect, ctx, incrementReply, row, win } from '../pdd-orders/kit.ts';
import { envelope, one, pdd, reply, sourceRow, sources, value } from './kit.ts';

it.each(sources)(
  '[AC-B1-08e-PAYLOAD#1] %s 只用传输元数据的十进制归档 ID，不能取订单或信封里的同名值',
  async (source) => {
    const id = '9007199254740993';
    const dto = await one(source, sourceRow(source, { raw_payload_id: '123' }), id);
    expect(value(dto, 'raw_payload_id')).toBe(id);
    expect(value(dto, 'sub_order_id')).toBe('000000000000000000000000012345-SYN');
  },
);

it('[AC-B1-08e-PAYLOAD#2] increment 探尾、缓存、倒序翻页后每个订单仍对应实际取回它的那页归档', async () => {
  const dataset = Array.from({ length: 112 }, (_, i) => row({ order_sn: `synthetic-order-${i}` }));
  const expected = new Map<string, string>();
  const ids = new Set<string>();
  let calls = 0;
  const adapter = pdd(async (request) => {
    const parameters = JSON.parse(request.body!) as Record<string, unknown>;
    const body = incrementReply(dataset)(parameters);
    const id = (9007199254740993n + BigInt(calls++)).toString();
    ids.add(id);
    const items = body.order_list_get_response.order_list.map((input) => {
      const item = input as Record<string, unknown>;
      // 每次实际响应的标记不同，同页重取也可区分；不用游标内部编码推导 ID。
      const marker = `synthetic-response-${id}-${String(item.order_sn)}`;
      expected.set(marker, id);
      return { ...item, custom_parameters: marker };
    });
    return reply({ order_list_get_response: { order_list: items } }, id);
  });
  const orders = await collect(adapter);
  expect(orders).toHaveLength(112);
  expect(new Set(orders.map((order) => order.order_id)).size).toBe(112);
  for (const order of orders) {
    const id = expected.get(order.custom_parameters!);
    expect(id).toBeTypeOf('string');
    expect(value(order, 'raw_payload_id')).toBe(id);
  }
  expect(new Set(orders.map((order) => value(order, 'raw_payload_id'))).size).toBe(3);
  expect(ids.size).toBeGreaterThanOrEqual(3);
});

it('[AC-B1-08e-PAYLOAD#3] pay_time 每页分别带 ID，缺归档的中间页为 null 且不沿用前页', async () => {
  const ids = ['9007199254741001', undefined, '9007199254741003'] as const;
  let calls = 0;
  const adapter = pdd(async () => {
    const index = calls++;
    expect(index).toBeLessThan(ids.length);
    return reply(
      {
        order_list_get_response: {
          order_list: [
            row({ order_sn: `synthetic-range-${index}-a` }),
            row({ order_sn: `synthetic-range-${index}-b` }),
          ],
          last_order_id: index === 2 ? '' : `synthetic-next-${index}`,
        },
      },
      ids[index],
    );
  });
  const orders = await collect(adapter, undefined, { queryMode: 'pay_time' });
  expect(orders.map((order) => value(order, 'raw_payload_id'))).toEqual([
    '9007199254741001',
    '9007199254741001',
    null,
    null,
    '9007199254741003',
    '9007199254741003',
  ]);
  expect(calls).toBe(3);
});

it.each(sources)(
  '[AC-B1-08e-PAYLOAD#4] %s 无归档元数据时显式为 null，报文不能冒充归档 ID',
  async (source) => {
    const body = envelope(source, sourceRow(source, { raw_payload_id: '456' }));
    const adapter = pdd(async () => reply({ ...(body as object), raw_payload_id: '789' }));
    const order =
      source === 'detail'
        ? await adapter.getPddOrderDetail('synthetic-detail', ctx)
        : (await adapter.listOrders(win, { queryMode: source }, ctx)).items[0]!;
    expect(value(order, 'raw_payload_id')).toBeNull();
  },
);
