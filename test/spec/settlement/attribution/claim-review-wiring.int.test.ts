// B2-04la rule tests: the real settlement port wired into orders' claim approval (B1-10k
// approveClaimItem; BR-ATTR-30, BR-FUND-01 R3). orders checks after the port that locked is true and
// rebate_status moved, then writes user_id, user_basis=claim and the one rebate history row itself;
// the port must leave exactly that to orders. Harness: the B1-10k kit (imported, not changed), with
// its fake settlement replaced by the real port.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, fixture, open, success, type Harness } from '../../orders/claims-review/kit.ts';
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
] as const)(
  '[AC-B2-04la#17] 找回通过接真实端口（R3）：平台 %s 的未归因订单审核通过，订单 locked=true、%s→%s，归属列由 orders 写，返利历史只有 orders 写的一行',
  async (platformStatus, received, status, period) => {
    const f = await fixture(h);
    const o = await f.order({
      platform_status: platformStatus,
      received_at: received === null ? null : at(received),
    });
    const c = await f.claim();
    const i = await f.item(c, o);
    const { port } = realPort();
    success(await f.review('approve', i, {}, { rebate: port }));

    expect(f.rebate.onClaimApproved).not.toHaveBeenCalled();
    const s = await f.state();
    expect(s.orders).toHaveLength(1);
    expect(s.orders[0]).toMatchObject({
      order_id: o.order_id,
      user_id: f.subject.user_id,
      user_basis: 'claim',
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
      event: 'CLAIM_APPROVED',
      to_status: status,
      source: 'claim',
    });
  },
);
