import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { capture, unknownFigures } from './kit.ts';
import { detail, fakeQueries, sampleId, summary, traceId, withHttp } from './http-kit.ts';
import { contract } from './schema-kit.ts';
import * as orders from '../../../../apps/api/src/modules/orders/index.ts';

const subject = { app_id: 'token_owned_app', user_id: randomUUID() };
it('[AC-B1-08l#31] listOrders 与 getOrder 去 planned（其他 operation 不在本任务范围）', async () => {
  const paths = (await contract()).paths;
  expect(paths['/v1/orders']?.get).toMatchObject({ operationId: 'listOrders' });
  expect(paths['/v1/orders']?.get?.['x-implementation']).not.toBe('planned');
  expect(paths['/v1/orders/{order_id}']?.get).toMatchObject({ operationId: 'getOrder' });
  expect(paths['/v1/orders/{order_id}']?.get?.['x-implementation']).not.toBe('planned');
});

it('[AC-B1-08l#32] HTTP 薄封装调用共享 list/get，身份只来自 token', async () => {
  const q = fakeQueries();
  await withHttp(q, subject, async (send) => {
    q.list.mockClear();
    q.get.mockClear();
    const response = await send(
      '/v1/orders?scope=self&status_group=estimating&display_status=PAID&platform=jd&q=phone&paid_month=2027-12&limit=7',
      { 'x-user-id': randomUUID(), 'x-uid': randomUUID() },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      code: 0,
      trace_id: traceId,
      data: { items: [summary] },
    });
    expect(q.list).toHaveBeenCalledExactlyOnceWith(
      subject,
      expect.objectContaining({
        scope: 'self',
        status_group: 'estimating',
        display_status: 'PAID',
        platform: 'jd',
        q: 'phone',
        paid_month: '2027-12',
        limit: 7,
      }),
    );
    const found = await send(`/v1/orders/${sampleId}`);
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ code: 0, data: detail });
    expect(q.get).toHaveBeenCalledExactlyOnceWith(subject, sampleId);
  });
}, 30_000);

it.each(['/v1/orders?scope=self', `/v1/orders/${sampleId}`])(
  '[AC-B1-08l#33] 未登录 %s → 10001',
  async (path) => {
    const q = fakeQueries();
    await withHttp(q, subject, async (send) => {
      q.list.mockClear();
      q.get.mockClear();
      const response = await send(path, { authorization: undefined });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 10001 });
      expect(q.list).not.toHaveBeenCalled();
      expect(q.get).not.toHaveBeenCalled();
    });
  },
  30_000,
);

it.each([
  '/v1/orders',
  '/v1/orders?scope=other',
  `/v1/orders?scope=self&q=${'x'.repeat(41)}`,
  '/v1/orders?scope=self&q=',
  '/v1/orders?scope=self&paid_month=2026-13',
  '/v1/orders?scope=self&limit=0',
  '/v1/orders?scope=self&limit=51',
  '/v1/orders?scope=self&platform=unknown',
  '/v1/orders?scope=self&status_group=unknown',
  '/v1/orders?scope=self&display_status=unknown',
  '/v1/orders/not-a-uuid',
  `/v1/orders?scope=self&cursor=${'x'.repeat(513)}`,
])(
  '[AC-B1-08l#34] 非法参数 %s → 20001，不调用查询',
  async (path) => {
    const q = fakeQueries();
    await withHttp(q, subject, async (send) => {
      q.list.mockClear();
      q.get.mockClear();
      const response = await send(path);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 20001 });
      expect(q.list).not.toHaveBeenCalled();
      expect(q.get).not.toHaveBeenCalled();
    });
  },
  30_000,
);

it('[AC-B1-08l#35] 未接线 figures 的公开端口所有字段未知', async () => {
  const result = await capture(() => orders.createUnknownOrderFigures());
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  const secondId = randomUUID();
  expect(await result.value.forOrders(subject, [sampleId, secondId])).toEqual(
    new Map([
      [sampleId, unknownFigures],
      [secondId, unknownFigures],
    ]),
  );
});

it('[AC-B1-08l#39] 查询日志不包含 q、标题或完整订单号', async () => {
  const q = fakeQueries();
  await withHttp(q, subject, async (send, logs) => {
    const response = await send(`/v1/orders?scope=self&q=${summary.order_no}`);
    expect(response.statusCode).toBe(200);
    const serialized = logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(summary.order_no);
    expect(serialized).not.toContain(summary.title);
    expect(serialized).not.toContain('q=');
  });
}, 30_000);
