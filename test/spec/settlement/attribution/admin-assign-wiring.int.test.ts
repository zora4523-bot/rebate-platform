// B2-04la rule tests: the real settlement port wired into orders' admin assignment (B1-10f
// assignOrder; BR-ATTR-31, BR-FUND-01 R3 / R3b). orders checks after the port that locked is true
// and rebate_status moved (R3) or stayed (R3b), then writes user_id, user_basis=admin and the one
// rebate history row itself; the port must leave exactly that to orders. Harness: the B1-10f kit
// (imported, not changed), with its fake settlement replaced by the real port.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assigned, at, fixture, open, type Harness } from '../../orders/admin-assign/db-kit.ts';
import { realPort } from './kit.ts';

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

/** Beijing 2028-01-01 00:01 → settle_period 2028-01 (BR-FUND-04 ②). */
const RECEIVED = '2027-12-31T16:01:00.000Z';

it.each([
  ['PAID', null, 'ESTIMATED', null],
  ['RECEIVED', RECEIVED, 'WAITING', '2028-01'],
  ['SETTLED', RECEIVED, 'WAITING', '2028-01'],
] as const)(
  '[AC-B2-04la#15] 后台指派接真实端口（R3）：平台 %s 的未归因订单指派成功，订单 locked=true、%s→%s，归属列由 orders 写，返利历史只有 orders 写的一行',
  async (platformStatus, received, status, period) => {
    const f = await fixture(h);
    const o = await f.order({
      platform_status: platformStatus,
      received_at: received === null ? null : at(received),
    });
    const target = await f.user();
    const { port } = realPort();
    assigned(await f.assign(o, { user_id: target }, { deps: { rebate: port } }));

    expect(f.rebate.onAdminAssigned).not.toHaveBeenCalled();
    const s = await f.state();
    expect(s.orders).toHaveLength(1);
    expect(s.orders[0]).toMatchObject({
      order_id: o.order_id,
      user_id: target,
      user_basis: 'admin',
      locked: true,
      rebate_status: status,
      settle_period: period,
      received_synced_at: received === null ? null : f.clock.now(),
      platform_status: platformStatus,
      booked_base_fen: null,
    });
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toMatchObject({
      order_id: o.order_id,
      field: 'rebate',
      from_status: 'UNATTRIBUTED',
      event: 'ADMIN_REASSIGN',
      to_status: status,
      source: 'admin',
    });
    expect(s.assignments).toHaveLength(1);
  },
);

it('[AC-B2-04la#16] 后台指派接真实端口（R3b）：VOID 的未归因订单指派成功，rebate_status 与原因不变、locked=true，不生成快照，返利历史只有 orders 写的 VOID→VOID 一行', async () => {
  const f = await fixture(h);
  const o = await f.order({ platform_status: 'INVALID', rebate_status: 'VOID', reason: 'REFUND' });
  const target = await f.user();
  const { port } = realPort();
  assigned(await f.assign(o, { user_id: target }, { deps: { rebate: port } }));

  expect(f.snapshots.create).not.toHaveBeenCalled();
  const s = await f.state();
  expect(s.orders[0]).toMatchObject({
    user_id: target,
    user_basis: 'admin',
    locked: true,
    rebate_status: 'VOID',
    reason: 'REFUND',
    platform_status: 'INVALID',
  });
  expect(s.history).toHaveLength(1);
  expect(s.history[0]).toMatchObject({
    from_status: 'VOID',
    event: 'ADMIN_REASSIGN',
    to_status: 'VOID',
    source: 'admin',
  });
});
