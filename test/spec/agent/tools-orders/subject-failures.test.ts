import { expect, it } from 'vitest';
import { context, EXPLAIN, item, LIST, selfDetail, setup, toolFailed } from './kit.ts';

const DATES = { date_from: '2026-10-01', date_to: '2026-10-23' };

it.each([
  { appId: 'synthetic-app-a', userId: 'synthetic-user-a' },
  { appId: 'synthetic-app-b', userId: 'synthetic-user-b' },
])(
  '[AC-B3-08a#3][BR-AI-03] orders 各方法收到的主体恒为 {app_id,user_id}=($appId,$userId)',
  async ({ appId, userId }) => {
    const f = setup();
    const detail = selfDetail();
    f.searchForAgent.mockResolvedValue({ orders: [item()], total: 1 });
    f.resolve.mockResolvedValue({ kind: 'order', orderId: detail.order_id });
    f.get.mockResolvedValue(detail);
    const ctx = context({ appId, userId });
    await f.execute(LIST, { ...DATES, keyword: '合成' }, ctx);
    await f.execute(EXPLAIN, { card_id: 'c1' }, ctx);
    await f.execute(EXPLAIN, { order_no: '990000000001', platform: 'jd' }, ctx);
    const expected = { app_id: appId, user_id: userId };
    expect(f.searchForAgent).toHaveBeenCalledTimes(1);
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.findOwnByNumber).toHaveBeenCalledTimes(1);
    for (const call of [
      ...f.searchForAgent.mock.calls,
      ...f.get.mock.calls,
      ...f.findOwnByNumber.mock.calls,
    ]) {
      expect(call[0]).toEqual(expected);
    }
    expect(f.take).toHaveBeenCalledWith(appId, userId);
  },
);

it('[AC-B3-08a#3][BR-AI-03] handler 直接收到伪造身份或单号字段也不改变主体与查询参数', async () => {
  const f = setup();
  const detail = selfDetail();
  f.resolve.mockResolvedValue({ kind: 'order', orderId: detail.order_id });
  f.get.mockResolvedValue(detail);
  const ctx = context();
  const forged = {
    user_id: 'synthetic-forged-user',
    app_id: 'synthetic-forged-app',
    order_id: '0192f3a1-7c00-7000-8000-00000000ffff',
  };
  // 绕过注册表直接调用：handler 要么拒绝，要么只用 ctx 的主体，绝不采用参数里的身份。
  await f.list.run({ ...DATES, ...forged }, ctx);
  await f.explain.run({ card_id: 'c1', ...forged }, ctx);
  await f.explain.run({ order_no: '990000000001', platform: 'jd', ...forged }, ctx);
  const expected = { app_id: ctx.appId, user_id: ctx.userId };
  for (const call of [
    ...f.searchForAgent.mock.calls,
    ...f.get.mock.calls,
    ...f.findOwnByNumber.mock.calls,
  ]) {
    expect(call[0]).toEqual(expected);
  }
  for (const call of f.get.mock.calls) expect(call[1]).toBe(detail.order_id);
  for (const call of f.take.mock.calls) expect(call).toEqual([ctx.appId, ctx.userId]);
  expect(JSON.stringify(f.searchForAgent.mock.calls)).not.toContain('synthetic-forged');
  expect(JSON.stringify(f.findOwnByNumber.mock.calls)).not.toContain('synthetic-forged');
});

it.each([
  { label: 'searchForAgent 抛错', tool: LIST, args: DATES, port: 'search' },
  { label: 'refs.resolve 抛错', tool: EXPLAIN, args: { card_id: 'c1' }, port: 'resolve' },
  { label: 'orders.get 抛错', tool: EXPLAIN, args: { card_id: 'c1' }, port: 'get' },
  {
    label: 'findOwnByNumber 抛错',
    tool: EXPLAIN,
    args: { order_no: '990000000001', platform: 'jd' },
    port: 'number',
  },
] as const)(
  '[AC-B3-08a#12] $label → failed tool_failed，不出卡、不降级成 claim_draft 或 handoff',
  async ({ tool, args, port }) => {
    const f = setup();
    const secret = new Error('synthetic-private-port-error 990000000001');
    f.searchForAgent.mockRejectedValue(secret);
    f.resolve.mockResolvedValue({ kind: 'order', orderId: selfDetail().order_id });
    if (port === 'resolve') f.resolve.mockRejectedValue(secret);
    f.get.mockResolvedValue(selfDetail());
    if (port === 'get') f.get.mockRejectedValue(secret);
    f.findOwnByNumber.mockRejectedValue(secret);
    const outcome = await f.execute(tool, args);
    expect(outcome).toEqual(toolFailed);
    expect(outcome).not.toHaveProperty('cards');
    expect(JSON.stringify(outcome)).not.toContain('synthetic-private-port-error');
    // 不读点击记录（claim_draft）、不申请任何卡引用。
    expect(f.read).not.toHaveBeenCalled();
    expect(f.cardReference).not.toHaveBeenCalled();
  },
);
