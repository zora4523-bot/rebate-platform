// BR-ATTR-31 / BR-ATTR-20 ③ / BR-FUND-01 R3、R3b：未归因订单的后台指派写入。只测应用服务；契约的
// POST /admin/v1/orders/{order_id}/reassign 仍为 planned、不挂载（J-1）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { assigned, at, fixture, open, reassignedEvents, type Harness } from './db-kit.ts';
import { AUDIT_ACTION, IP, REASON, conforms } from './kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

it.each(['PAID', 'RECEIVED', 'SETTLED'])(
  '[AC-B1-10f#1] %s 的未归因订单按 R3 指派：返利端口收到写前快照与快照结果，同事务写归属、历史、order_assignments、审计与 order.reassigned，平台状态不变',
  async (platformStatus) => {
    const f = await fixture(h);
    const received = platformStatus === 'PAID' ? null : at('2027-12-31T16:01:00.000Z');
    const o = await f.order({ platform_status: platformStatus, received_at: received });
    f.rebateTarget.status = platformStatus === 'PAID' ? 'ESTIMATED' : 'WAITING';
    f.rebateTarget.period = platformStatus === 'PAID' ? null : '2028-01';
    const target = await f.user();
    h.trace.length = 0;
    const d = assigned(await f.assign(o, { user_id: target }));

    expect(f.rebate.onAdminAssigned).toHaveBeenCalledTimes(1);
    const [trx, input] = f.rebate.onAdminAssigned.mock.calls[0]!;
    expect(input).toEqual({ before: o, userId: target, now: f.clock.now(), snapshot: 'created' });
    expect(f.snapshots.create).toHaveBeenCalledTimes(1);
    expect(f.snapshots.create.mock.calls[0]).toEqual([
      trx,
      expect.objectContaining({
        appId: f.appId,
        orderId: o.order_id,
        ownerUserId: target,
        platform: 'jd',
      }),
    ]);
    expect(new Set(f.transactions).size).toBe(1);

    const s = await f.state();
    expect(s.orders).toHaveLength(1);
    expect(s.orders[0]).toMatchObject({
      user_id: target,
      user_basis: 'admin',
      locked: true,
      rebate_status: f.rebateTarget.status,
      settle_period: f.rebateTarget.period,
      platform_status: platformStatus,
      received_at: received,
      buy_type: o.buy_type,
      scene_basis: o.scene_basis,
      attr_at: o.attr_at,
    });
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toMatchObject({
      order_id: o.order_id,
      field: 'rebate',
      source: 'admin',
      from_status: 'UNATTRIBUTED',
      to_status: f.rebateTarget.status,
      at: f.clock.now(),
    });
    expect(s.assignments).toHaveLength(1);
    expect(s.assignments[0]).toMatchObject({
      app_id: f.appId,
      order_id: o.order_id,
      to_user_id: target,
      source: 'admin',
      reason: REASON,
      admin_id: f.adminId,
    });
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]).toMatchObject({
      app_id: f.appId,
      admin_id: f.adminId,
      action: AUDIT_ACTION,
      target: `orders:${o.order_id}`,
      ip: IP,
      at: f.clock.now(),
      after: { user_id: target, reason: REASON },
    });
    const events = reassignedEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      app_id: f.appId,
      name: 'order.reassigned',
      occurred_at: f.clock.now(),
      payload: { v: 1, data: expect.objectContaining({ order_id: o.order_id }) },
    });
    expect(s.jobs).toHaveLength(1);
    expect(s.jobs[0]).toMatchObject({
      id: events[0]!.event_id,
      state: 'created',
      data: { name: 'order.reassigned' },
    });

    // locked / rebate_status belong to settlement; orders writes neither, nor platform_status.
    const ownWrites = h.trace.filter((q) => /^update .*"orders"/i.test(q.sql) && !q.settlement);
    expect(ownWrites.length).toBeGreaterThan(0);
    for (const q of ownWrites)
      expect(q.sql.split(' where ')[0]).not.toMatch(
        /"(?:locked|rebate_status|platform_status)"\s*=/,
      );

    expect(d).toMatchObject({
      order_id: o.order_id,
      user: { user_id: target, phone_masked: '138****0001' },
      user_basis: 'admin',
      platform_status: platformStatus,
      rebate_status: f.rebateTarget.status,
      flags: { locked: true },
    });
    await conforms(d, 'AdminOrderDetail');
  },
);

it('[AC-B1-10f#2] VOID 且未归因的订单按 R3b 指派：不生成快照（端口入参 snapshot=none），rebate_status 保持 VOID，只写归属与锁定', async () => {
  const f = await fixture(h);
  const o = await f.order({ rebate_status: 'VOID', platform_status: 'INVALID' });
  const target = await f.user();
  const d = assigned(await f.assign(o, { user_id: target }));
  expect(f.snapshots.create).not.toHaveBeenCalled();
  expect(f.rebate.onAdminAssigned).toHaveBeenCalledTimes(1);
  expect(f.rebate.onAdminAssigned.mock.calls[0]?.[1]).toEqual({
    before: o,
    userId: target,
    now: f.clock.now(),
    snapshot: 'none',
  });
  const s = await f.state();
  expect(s.orders[0]).toMatchObject({
    user_id: target,
    user_basis: 'admin',
    locked: true,
    rebate_status: 'VOID',
    platform_status: 'INVALID',
  });
  expect(s.assignments).toHaveLength(1);
  expect(s.assignments[0]).toMatchObject({
    order_id: o.order_id,
    to_user_id: target,
    source: 'admin',
    reason: REASON,
    admin_id: f.adminId,
  });
  expect(s.audits).toHaveLength(1);
  expect(s.audits[0]).toMatchObject({
    admin_id: f.adminId,
    action: AUDIT_ACTION,
    target: `orders:${o.order_id}`,
    after: { user_id: target, reason: REASON },
  });
  expect(reassignedEvents(s)).toHaveLength(1);
  expect(d).toMatchObject({
    order_id: o.order_id,
    user: { user_id: target },
    user_basis: 'admin',
    rebate_status: 'VOID',
    flags: { locked: true },
  });
  await conforms(d, 'AdminOrderDetail');
});

it.each(['frozen', 'appealing'] as const)(
  '[AC-B1-10f#3] 目标用户为 %s（冻结 / 申诉中）照常指派：写归属并生成快照',
  async (riskState) => {
    const f = await fixture(h);
    const o = await f.order();
    const target = await f.user();
    await f.risk(target, riskState);
    const d = assigned(await f.assign(o, { user_id: target }));
    expect(d).toMatchObject({ user: { user_id: target }, user_basis: 'admin' });
    expect(f.snapshots.create).toHaveBeenCalledTimes(1);
    const s = await f.state();
    expect(s.orders[0]).toMatchObject({ user_id: target, user_basis: 'admin', locked: true });
    expect(s.assignments.map((a) => a.to_user_id)).toEqual([target]);
  },
);

it('[AC-B1-10f#4] 指派执行来源回填（BR-ATTR-15）写匹配来源；回填读取失败时归属、指派记录、审计与来源全部回滚，重试照常', async () => {
  const f = await fixture(h);
  const target = f.subject.user_id;
  const link = await f.link('jd:i_12345');
  const o = await f.order();
  const before = await f.state();
  const outage = new Error('synthetic source read outage');
  let fail = true;
  const sources = {
    productKey: vi.fn(async () => o.product_key),
    linkLogs: vi.fn(async () => {
      if (fail) throw outage;
      return [
        {
          id: 7n,
          link_id: link,
          user_id: target,
          platform: o.platform,
          event: 'open',
          result_code: 0,
          pid_scene: 'detail',
          scene: 'detail',
          product_key: o.product_key,
          shop_id: null,
          created_at: o.attr_at,
          agent_session_id: null,
        },
      ];
    }),
  };
  const options = { deps: { sources, pidScene: async () => 'detail' } };
  await expect(f.assign(o, { user_id: target }, options)).rejects.toBe(outage);
  expect(await f.state()).toEqual(before);
  fail = false;
  assigned(await f.assign(o, { user_id: target }, options));
  expect(sources.linkLogs).toHaveBeenLastCalledWith(
    expect.objectContaining({ appId: f.appId, userId: target, platform: 'jd', to: o.attr_at }),
  );
  const s = await f.state();
  expect(s.orders[0]).toMatchObject({
    user_id: target,
    user_basis: 'admin',
    source_match: 'product',
    source_scene: 'detail',
    link_id: link,
    agent_session_id: null,
  });
  expect(s.assignments).toHaveLength(1);
});

it('[AC-B1-10f#5] 时间只取注入时钟：历史、审计与事件的时刻都是指派时的 Clock', async () => {
  const f = await fixture(h);
  const o = await f.order();
  f.clock.advanceMs(98_765);
  const now = f.clock.now();
  assigned(await f.assign(o));
  const s = await f.state();
  expect(f.rebate.onAdminAssigned.mock.calls[0]?.[1].now).toEqual(now);
  expect(s.history[0]?.at).toEqual(now);
  expect(s.audits[0]?.at).toEqual(now);
  expect(reassignedEvents(s)[0]?.occurred_at).toEqual(now);
});
