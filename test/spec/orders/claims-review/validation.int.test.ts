import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, noAttribution, open, success, type Harness } from './kit.ts';

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

it.each(['approve', 'reject'] as const)(
  '[AC-B1-10k#9] %s 版本不符及已决的三种终态均 20902 claim_item，完全无副作用',
  async (mode) => {
    for (const decision of [null, 'approved', 'rejected', 'cancelled']) {
      const f = await fixture(h);
      const c = await f.claim();
      const o = await f.order();
      const i = await f.item(c, o, {
        decision,
        row_version: 7,
        decided_at: decision === null ? null : f.clock.now(),
        reject_reason: decision === 'rejected' ? 'NOT_IN_POOL' : null,
      });
      const before = await f.state();
      expect(await f.review(mode, i, { expected_row_version: decision === null ? 6 : 7 })).toEqual({
        code: 20902,
        data: { resource: 'claim_item' },
      });
      expect(await f.state()).toEqual(before);
      noAttribution(f);
      expect(f.events.publish).not.toHaveBeenCalled();
      expect(f.auditOn).not.toHaveBeenCalled();
    }
  },
);

it.each(['approve', 'reject'] as const)(
  '[AC-B1-10k#10] %s 说明 trim 后少于 5 或超过 200 字被拒绝且不写库',
  async (mode) => {
    for (const reason of ['', '   ', '四个汉字', '  四个汉字  ', '字'.repeat(201)]) {
      const f = await fixture(h);
      const c = await f.claim();
      const i = await f.item(c, await f.order());
      const before = await f.state();
      expect(await f.review(mode, i, { reason })).toEqual({
        code: 20001,
        data: { fields: ['reason'] },
      });
      expect(await f.state()).toEqual(before);
      noAttribution(f);
    }
  },
);

it.each(['approve', 'reject'] as const)(
  '[AC-B1-10k#11] %s 说明 5 / 200 字边界合法，trim 后写入最新 claims.reason 和审计',
  async (mode) => {
    for (const length of [5, 200]) {
      const f = await fixture(h);
      const c = await f.claim();
      const i = await f.item(c, await f.order());
      const reason = '字'.repeat(length);
      expect(
        success(await f.review(mode, i, { reason: length === 5 ? ` ${reason}\n` : reason })).reason,
      ).toBe(reason);
      const s = await f.state();
      expect(s.claims[0]?.reason).toBe(reason);
      expect(s.audits).toHaveLength(1);
      expect(s.audits[0]).toMatchObject({
        admin_id: f.actor.adminId,
        target: `claim_items:${i.id}`,
        after: { reason },
        at: f.clock.now(),
      });
    }
  },
);

it.each(['NOT_IN_POOL', 'ORDER_INVALID', 'UNKNOWN', '', 'fraud', ' NO_EVIDENCE '])(
  '[AC-B1-10k#12] 驳回原因 %s 不是六个客服码之一，连 VOID 订单也拒绝输入',
  async (reject_reason) => {
    for (const rebate_status of ['UNATTRIBUTED', 'VOID']) {
      const f = await fixture(h);
      const c = await f.claim();
      const i = await f.item(c, await f.order({ rebate_status }));
      const before = await f.state();
      expect(await f.review('reject', i, { reject_reason })).toEqual({
        code: 20001,
        data: { fields: ['reject_reason'] },
      });
      expect(await f.state()).toEqual(before);
      noAttribution(f);
    }
  },
);

it.each(['approve', 'reject'] as const)(
  '[AC-B1-10k#13] %s 未知、跨 app claim 或不属于 claim 的 item 返回对应字段错误',
  async (mode) => {
    const f = await fixture(h);
    const c = await f.claim();
    const i = await f.item(c, await f.order());
    const other = await f.claim();
    const otherItem = await f.item(other, await f.order());
    const foreign = await fixture(h);
    const fc = await foreign.claim();
    const fi = await foreign.item(fc, await foreign.order());
    const before = await f.state();
    const foreignBefore = await foreign.state();
    for (const [patch, field] of [
      [{ claimId: randomUUID() }, 'claim_id'],
      [{ claimId: fc.id, itemId: fi.id }, 'claim_id'],
      [{ itemId: randomUUID() }, 'item_id'],
      [{ itemId: otherItem.id }, 'item_id'],
      [{ itemId: fi.id }, 'item_id'],
    ] as const) {
      expect(await f.review(mode, i, patch)).toEqual({ code: 20001, data: { fields: [field] } });
      expect(await f.state()).toEqual(before);
      expect(await foreign.state()).toEqual(foreignBefore);
    }
    noAttribution(f);
  },
);

it('[AC-B1-10k#14] app 与平台隔离：同文本子单号的其他平台或其他 app 数据不被连带结案', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const c = await f.claim();
  const i = await f.item(c, o);
  const foreign = await fixture(h);
  // order_keys is globally unique on (platform, sub_order_id), so the other app uses another
  // platform; the same-app other-platform row exercises the sub-order-only predicate mutation.
  const foreignOrder = await foreign.order({ platform: 'pdd', sub_order_id: o.sub_order_id });
  const fc = await foreign.claim({ platform: 'pdd' });
  await foreign.item(fc, foreignOrder);
  const otherOrder = await f.order({ platform: 'taobao', sub_order_id: o.sub_order_id });
  const otherClaim = await f.claim({ platform: 'taobao', user_id: await f.user() });
  const otherItem = await f.item(otherClaim, otherOrder);
  const before = await foreign.state();
  expect(success(await f.review('approve', i)).status).toBe('approved');
  expect(await foreign.state()).toEqual(before);
  const s = await f.state();
  expect(s.items.find((r) => r.id === otherItem.id)).toEqual(otherItem);
  expect(s.orders.find((r) => r.order_id === otherOrder.order_id)).toEqual(otherOrder);
  expect(s.claims.find((r) => r.id === otherClaim.id)).toEqual(otherClaim);
});
