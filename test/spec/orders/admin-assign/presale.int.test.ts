// BR-FUND-01 R3、BR-CALC-10、BR-ATTR-31：预售定金阶段（platform_status=DEPOSIT_PAID、paid_at 为空）的
// 未归因订单后台指派照常走 R3，但快照推迟到 P2（尾款付清）：runCommissionSnapshot 的计划为 skip，不调快照
// 端口、不写待处理，交给返利端口的快照入参为 none。路由不挂载（J-1），只测应用服务。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assigned, at, fixture, open, reassignedEvents, type Harness } from './db-kit.ts';
import { REASON, conforms } from './kit.ts';

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

it('[AC-B1-10f#28] DEPOSIT_PAID 且 paid_at 为空的未归因预售订单按 R3 指派：不生成分佣快照、不写待处理，返利端口收到 snapshot=none，归属照常写', async () => {
  const f = await fixture(h);
  const o = await f.order({
    platform_status: 'DEPOSIT_PAID',
    is_presale: true,
    paid_at: null,
    deposit_paid_at: at('2027-12-10T02:00:00.000Z'),
    received_at: null,
  });
  f.rebateTarget.status = 'ESTIMATED';
  f.rebateTarget.period = null;
  const target = await f.user();
  const before = await f.state();
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
  expect(s.orders).toHaveLength(1);
  expect(s.orders[0]).toMatchObject({
    user_id: target,
    user_basis: 'admin',
    locked: true,
    rebate_status: 'ESTIMATED',
    platform_status: 'DEPOSIT_PAID',
    paid_at: null,
    paid_at_source: o.paid_at_source,
  });
  expect(s.pending).toEqual(before.pending);
  expect(s.history).toHaveLength(1);
  expect(s.history[0]).toMatchObject({
    order_id: o.order_id,
    field: 'rebate',
    source: 'admin',
    from_status: 'UNATTRIBUTED',
    to_status: 'ESTIMATED',
  });
  expect(s.assignments).toHaveLength(1);
  expect(s.assignments[0]).toMatchObject({
    order_id: o.order_id,
    to_user_id: target,
    source: 'admin',
    reason: REASON,
  });
  expect(reassignedEvents(s)).toHaveLength(1);
  expect(d).toMatchObject({
    order_id: o.order_id,
    user: { user_id: target },
    user_basis: 'admin',
    platform_status: 'DEPOSIT_PAID',
    rebate_status: 'ESTIMATED',
    flags: { locked: true },
  });
  await conforms(d, 'AdminOrderDetail');
});
