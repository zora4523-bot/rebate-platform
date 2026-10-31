import { expect, it } from 'vitest';
import { UnionError, type OrderQueryOpt } from '../../../../apps/api/src/modules/union/index.ts';
import { formFields, sent } from '../jd-core/kit.ts';
import {
  collect,
  ctx,
  inner,
  jsonText,
  method,
  num,
  one,
  orderReq,
  pageAnswer,
  reply,
  row,
  rows,
  singleRowPages,
  win,
  wire,
} from './kit.ts';

const ORDER_REQ_FIELDS = ['pageIndex', 'pageSize', 'type', 'startTime', 'endTime', 'fields'];
/** order-sync passes queryMode increment; the update-time query is the only one either way. */
const QUERY_OPTIONS: readonly OrderQueryOpt[] = [{}, { queryMode: 'increment' }];

it.each(QUERY_OPTIONS)(
  '[AC-B1-04zb#8] 按更新时间查询：方法名、orderReq 一个对象、pageSize 200、type 3，选项 %j',
  async (options) => {
    const { adapter, transport } = wire(pageAnswer([[]]));
    await expect(adapter.listOrders(win, options, ctx)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    const request = sent(transport);
    expect(formFields(request).method).toBe(method);
    const parameters = JSON.parse(formFields(request)['360buy_param_json']!) as object;
    expect(Object.keys(parameters)).toEqual(['orderReq']);
    const body = orderReq(request);
    expect(body).toMatchObject({
      pageIndex: 1,
      pageSize: 200,
      type: 3,
      startTime: '2026-10-30 10:00:00',
      endTime: '2026-10-30 11:00:00',
    });
    expect(ORDER_REQ_FIELDS).toEqual(expect.arrayContaining(Object.keys(body)));
    if (Object.hasOwn(body, 'fields')) expect(body.fields).toBeTypeOf('string');
  },
);

it('[AC-B1-04zb#9] hasMore 为 true 就取下一页，页码从 1 递增，直到 false，订单按页序不丢不重', async () => {
  const { pages, ids } = singleRowPages(3);
  const { adapter, requests } = wire(pageAnswer(pages));
  const { orders } = await collect(adapter);
  expect(orders.map((order) => order.sub_order_id)).toEqual(ids);
  expect(requests.map((body) => body.pageIndex)).toEqual([1, 2, 3]);
  const [first, ...rest] = requests;
  const { pageIndex: _page, ...shared } = first!;
  void _page;
  for (const body of rest) expect(body).toMatchObject(shared);
});

it('[AC-B1-04zb#10] 只看 hasMore：满 200 条但 false 就停，不满页但 true 就继续', async () => {
  const full = rows(1, 200);
  const stop = wire(pageAnswer([full]));
  const { orders } = await collect(stop.adapter);
  expect(orders).toHaveLength(200);
  expect(stop.transport).toHaveBeenCalledTimes(1);

  const short = wire(pageAnswer([rows(2, 1), rows(3, 1)]));
  expect((await collect(short.adapter)).orders).toHaveLength(2);
  expect(short.transport).toHaveBeenCalledTimes(2);
});

it('[AC-B1-04zb#11] 任意一页 hasMore 为 true 而 data 为空数组 → UnionError，不再翻页', async () => {
  const [a, b] = rows(1, 2);
  const { adapter, requests } = wire(pageAnswer([[a], [], [b]]));
  await expect(collect(adapter)).rejects.toBeInstanceOf(UnionError);
  expect(requests.map((body) => body.pageIndex)).toEqual([1, 2]);
});

it.each([
  ['字符串', 'not-a-list'],
  ['对象', { orderId: num('1') }],
] as const)('[AC-B1-04zb#12] data 是%s时不当作空页', async (_name, data) => {
  const { adapter } = wire(() => reply(inner(data, false)));
  await expect(adapter.listOrders(win, {}, ctx)).rejects.toBeInstanceOf(UnionError);
});

it('[AC-B1-04zb#13] 每页请求都带归档上下文（kind=order）和调用方的取消信号', async () => {
  const { pages } = singleRowPages(2);
  const { adapter, transport } = wire(pageAnswer(pages));
  const { signal } = new AbortController();
  await collect(adapter, win, {}, { ...ctx, signal });
  expect(transport).toHaveBeenCalledTimes(2);
  for (const index of [0, 1]) {
    expect(sent(transport, index).archive).toEqual({ appId: ctx.appId, kind: 'order' });
    expect(sent(transport, index).signal).toBe(signal);
  }
});

it('[AC-B1-04zb#14] raw_payload_id 取实际取回该行那页的归档行 id；未归档的页是 null，不沿用前页', async () => {
  const ids = ['9007199254741001', undefined, '9007199254741003'] as const;
  const { adapter } = wire((body) => {
    const index = Number(body.pageIndex) - 1;
    return reply(inner(rows(index, 2), index < 2), ids[index]);
  });
  const { orders } = await collect(adapter);
  expect(orders.map((order) => order.raw_payload_id)).toEqual([
    '9007199254741001',
    '9007199254741001',
    null,
    null,
    '9007199254741003',
    '9007199254741003',
  ]);
});

it('[AC-B1-04zb#15] 报文里同名的 raw_payload_id 不能冒充归档行 id', async () => {
  const forged = row({ raw_payload_id: '123' });
  expect((await one(forged)).raw_payload_id).toBeNull();
  const body = jsonText({
    code: num('200'),
    hasMore: false,
    data: [forged],
    raw_payload_id: '456',
  });
  const { adapter } = wire(() => reply(body, '789'));
  const { orders } = await collect(adapter);
  expect(orders[0]?.raw_payload_id).toBe('789');
});
