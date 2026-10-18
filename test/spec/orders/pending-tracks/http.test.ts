import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fakeQueries, sample, traceId, withHttp } from './http-kit.ts';
import { contract } from './schema-kit.ts';

const subject = { app_id: 'pending_token_app', user_id: randomUUID() };
const base = '/v1/orders/pending-tracks';
const dismiss = `${base}/${sample.link_id}/dismiss`;

it('[AC-B1-08m#18] 两个 operation 去 planned，保留原 operationId', async () => {
  const paths = (await contract()).paths;
  expect(paths[base]?.get).toMatchObject({ operationId: 'listPendingTracks' });
  expect(paths[base]?.get?.['x-implementation']).not.toBe('planned');
  expect(paths[`${base}/{link_id}/dismiss`]?.post).toMatchObject({
    operationId: 'dismissPendingTrack',
  });
  expect(paths[`${base}/{link_id}/dismiss`]?.post?.['x-implementation']).not.toBe('planned');
});

it('[AC-B1-08m#19] 真实 HTTP 调用共享端口，身份取 token，响应形状符合契约', async () => {
  const q = fakeQueries();
  await withHttp(q, subject, async (send) => {
    q.list.mockClear();
    const headers = { 'x-user-id': randomUUID(), 'x-uid': randomUUID() };
    const result = await send(base, undefined, headers);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      code: 0,
      msg: '',
      data: { items: [sample] },
      trace_id: traceId,
    });
    expect(q.list).toHaveBeenCalledExactlyOnceWith(subject);
    const closed = await send(dismiss, { attempt_id: sample.attempt_id }, headers);
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ code: 0, msg: '', data: {}, trace_id: traceId });
    expect(q.dismiss).toHaveBeenCalledExactlyOnceWith(subject, sample.link_id, sample.attempt_id);
  });
}, 30_000);

it.each(['GET', 'POST'])(
  '[AC-B1-08m#20] 未登录 %s → 10001，不调用端口',
  async (method) => {
    const q = fakeQueries();
    await withHttp(q, subject, async (send) => {
      q.list.mockClear();
      q.dismiss.mockClear();
      const result = await send(
        method === 'GET' ? base : dismiss,
        method === 'GET' ? undefined : { attempt_id: sample.attempt_id },
        { authorization: undefined },
      );
      expect(result.statusCode).toBe(401);
      expect(result.json()).toMatchObject({ code: 10001 });
      expect(q.list).not.toHaveBeenCalled();
      expect(q.dismiss).not.toHaveBeenCalled();
    });
  },
  30_000,
);

it('[AC-B1-08m#21] 缺 attempt_id → 20001 fields=[attempt_id]，不调用关闭端口', async () => {
  const q = fakeQueries();
  await withHttp(q, subject, async (send) => {
    const result = await send(dismiss, {});
    expect(result.statusCode).toBe(400);
    expect(result.json()).toMatchObject({ code: 20001, data: { fields: ['attempt_id'] } });
    expect(q.dismiss).not.toHaveBeenCalled();
  });
}, 30_000);

it('[AC-B1-08m#22] 更换查看设备不改变本人卡片与关闭主体', async () => {
  const q = fakeQueries();
  await withHttp(q, subject, async (send) => {
    q.list.mockClear();
    const headers = { 'x-device-id': randomUUID() };
    const response = await send(base, undefined, headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { items: [sample] } });
    expect(q.list).toHaveBeenCalledExactlyOnceWith(subject);
  });
}, 30_000);
