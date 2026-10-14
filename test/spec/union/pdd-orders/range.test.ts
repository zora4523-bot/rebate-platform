import { expect, it } from 'vitest';
import { collect, range, row, setup } from './kit.ts';

it('[AC-B1-04i-RANGE#1] 支付时间转北京时间跨日格式；无 total_count 时逐次传回 last_order_id', async () => {
  const tokens = ['000000000000000000000000009991', '000000000000000000000000009992'];
  const { adapter, requests } = setup((body) => {
    expect(body.type).toBe(range);
    expect(body.start_time).toBe('2026-09-30 23:59:59');
    expect(body.end_time).toBe('2026-10-03 00:00:01');
    expect(body).not.toHaveProperty('page');
    expect(body).not.toHaveProperty('start_update_time');
    expect(body).not.toHaveProperty('end_update_time');
    expect(body).not.toHaveProperty('return_count');
    if (body.last_order_id === undefined) {
      return {
        order_list_get_response: {
          order_list: [row({ order_sn: 'range-a', order_id: undefined })],
          last_order_id: tokens[0],
        },
      };
    }
    if (body.last_order_id === tokens[0]) {
      return {
        order_list_get_response: {
          order_list: [row({ order_sn: 'range-b', order_id: undefined })],
          last_order_id: tokens[1],
        },
      };
    }
    expect(body.last_order_id).toBe(tokens[1]);
    return { order_list_get_response: { order_list: [], last_order_id: '' } };
  });
  const items = await collect(
    adapter,
    {
      from: '2026-09-30T15:59:59Z',
      to: '2026-10-02T16:00:01Z',
    },
    { queryMode: 'pay_time' },
  );
  expect(items.map((item) => item.order_id)).toEqual(['range-a', 'range-b']);
  expect(items.map((item) => item.platform_order_id)).toEqual([null, null]);
  expect(requests.map((body) => body.last_order_id)).toEqual([undefined, ...tokens]);
});

it('[AC-B1-04i-RANGE#2] 无订单、无迭代器时 nextCursor=null，不补成数字页码', async () => {
  const { adapter, requests } = setup((body) => {
    expect(body.type).toBe(range);
    expect(body).not.toHaveProperty('last_order_id');
    return { order_list_get_response: { order_list: [] } };
  });
  expect(await collect(adapter, undefined, { queryMode: 'pay_time' })).toEqual([]);
  expect(requests).toHaveLength(1);
});

it('[AC-B1-04i-RANGE#3] 末次空页即使回传原 last_order_id 也必须结束', async () => {
  const token = '000000000000000000000000008888';
  const { adapter, requests } = setup((body) => {
    expect(body.type).toBe(range);
    if (body.last_order_id === undefined) {
      return {
        order_list_get_response: {
          order_list: [row({ order_sn: 'range-final' })],
          last_order_id: token,
        },
      };
    }
    expect(body.last_order_id).toBe(token);
    return { order_list_get_response: { order_list: [], last_order_id: token } };
  });
  expect(
    (await collect(adapter, undefined, { queryMode: 'pay_time' })).map((item) => item.order_id),
  ).toEqual(['range-final']);
  expect(requests).toHaveLength(2);
});
