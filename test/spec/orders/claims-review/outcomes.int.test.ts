// BR-ATTR-30 / 20 / 32. Application service only; neither planned HTTP route is mounted.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NOTE,
  REVIEWER_CODES,
  at,
  decided,
  fixture,
  noAttribution,
  open,
  resolved,
  success,
  type Harness,
} from './kit.ts';

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

it.each(['self', 'other'] as const)(
  '[AC-B1-10k#1] 通过时已归属 %s：自动结案，不改订单或快照',
  async (owner) => {
    const f = await fixture(h);
    const user = owner === 'self' ? f.subject.user_id : await f.user();
    const o = await f.order({
      user_id: user,
      user_basis: 'param',
      locked: true,
      rebate_status: 'ESTIMATED',
    });
    const c = await f.claim();
    const i = await f.item(c, o);
    const before = await f.state();
    const d = success(await f.review('approve', i));
    const status = owner === 'self' ? 'cancelled' : 'rejected';
    const reason = owner === 'self' ? null : 'NOT_IN_POOL';
    expect(d).toMatchObject({ claim_id: c.id, status, reason: NOTE });
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({
      item_id: i.id,
      decision: status,
      reject_reason: reason,
      decided_by: null,
      decided_at: f.clock.now().toISOString(),
      row_version: i.row_version + 1,
    });
    await decided(f, i, status, reason, null);
    const after = await f.state();
    expect(after.orders).toEqual(before.orders);
    expect(after.history).toEqual(before.history);
    noAttribution(f);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      action: 'claim_item_approve',
      admin_id: f.actor.adminId,
      target: `claim_items:${i.id}`,
      after: { reason: NOTE, decision: status, reject_reason: reason },
    });
    await resolved(f, [{ claim_id: c.id, user_id: c.user_id, status }]);
  },
);

it.each(['approve', 'reject'] as const)(
  '[AC-B1-10k#2] %s 遇 VOID：ORDER_INVALID，系统处理人为空，保留客服审计',
  async (mode) => {
    const f = await fixture(h);
    const o = await f.order({ rebate_status: 'VOID', platform_status: 'INVALID' });
    const c = await f.claim();
    const i = await f.item(c, o, { row_version: 7 });
    const before = await f.state();
    const d = success(await f.review(mode, i, { reason: `  ${NOTE}  `, reject_reason: 'FRAUD' }));
    expect(d).toMatchObject({ status: 'rejected', reason: NOTE });
    await decided(f, i, 'rejected', 'ORDER_INVALID', null);
    const s = await f.state();
    expect(s.orders).toEqual(before.orders);
    expect(s.history).toEqual(before.history);
    noAttribution(f);
    expect(s.claims[0]?.reason).toBe(NOTE);
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]).toMatchObject({
      app_id: f.appId,
      admin_id: f.actor.adminId,
      action: `claim_item_${mode}`,
      target: `claim_items:${i.id}`,
      at: f.clock.now(),
      after: { reason: NOTE, decision: 'rejected', reject_reason: 'ORDER_INVALID' },
    });
    if (mode === 'reject')
      expect(s.audits[0]?.after).toMatchObject({ requested_reject_reason: 'FRAUD' });
    await resolved(f, [{ claim_id: c.id, user_id: c.user_id, status: 'rejected' }]);
  },
);

it('[AC-B1-10k#3] 通过复查先看已归属，再看 VOID；同申请人仍 cancelled', async () => {
  const f = await fixture(h);
  const o = await f.order({ user_id: f.subject.user_id, rebate_status: 'VOID' });
  const c = await f.claim();
  const i = await f.item(c, o);
  expect(success(await f.review('approve', i)).status).toBe('cancelled');
  await decided(f, i, 'cancelled', null, null);
  noAttribution(f);
});

it.each(REVIEWER_CODES)(
  '[AC-B1-10k#4] 客服驳回接受 %s，保持订单原样，响应为完整 claim',
  async (code) => {
    const f = await fixture(h);
    const o = await f.order();
    const c = await f.claim();
    const i = await f.item(c, o);
    const before = await f.state();
    const d = success(await f.review('reject', i, { reject_reason: code }));
    expect(d).toMatchObject({
      claim_id: c.id,
      order_no: c.order_no,
      platform: 'jd',
      user: { user_id: c.user_id, phone_masked: '138****0001' },
      paid_date: '2027-12-12',
      submitted_at: c.created_at.toISOString(),
      evidence_level: 'none',
      status: 'rejected',
      reason: NOTE,
    });
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({
      item_id: i.id,
      sub_order_id: i.sub_order_id,
      evidence: 'none',
      decision: 'rejected',
      reject_reason: code,
      decided_by: f.actor.adminId,
      decided_by_name: '测试客服',
      row_version: 1,
      matches: expect.any(Array),
      evidence_links: [],
    });
    await decided(f, i, 'rejected', code, f.actor.adminId);
    const s = await f.state();
    expect(s.orders).toEqual(before.orders);
    expect(s.history).toEqual(before.history);
    expect(s.audits[0]).toMatchObject({
      action: 'claim_item_reject',
      target: `claim_items:${i.id}`,
      after: {
        reason: NOTE,
        requested_reject_reason: code,
        decision: 'rejected',
        reject_reason: code,
      },
    });
    noAttribution(f);
    await resolved(f, [{ claim_id: c.id, user_id: c.user_id, status: 'rejected' }]);
  },
);

it.each(['PAID', 'RECEIVED', 'SETTLED'])(
  '[AC-B1-10k#5] %s 通过写归属，返利端口收到完整写前快照，平台状态不变',
  async (platformStatus) => {
    const f = await fixture(h);
    const received = platformStatus === 'PAID' ? null : at('2027-12-31T16:01:00.000Z');
    const o = await f.order({ platform_status: platformStatus, received_at: received });
    const c = await f.claim();
    const i = await f.item(c, o);
    f.rebateTarget.status = platformStatus === 'PAID' ? 'ESTIMATED' : 'WAITING';
    f.rebateTarget.period = platformStatus === 'PAID' ? null : '2028-01';
    h.trace.length = 0;
    const d = success(await f.review('approve', i));
    expect(d).toMatchObject({ status: 'approved', reason: NOTE });
    await decided(f, i, 'approved', null, f.actor.adminId);
    expect(f.rebate.onClaimApproved).toHaveBeenCalledTimes(1);
    const [trx, input] = f.rebate.onClaimApproved.mock.calls[0]!;
    expect(input).toEqual({
      before: o,
      userId: c.user_id,
      now: f.clock.now(),
      snapshot: 'created',
    });
    expect(f.snapshots.create).toHaveBeenCalledTimes(1);
    expect(f.snapshots.create.mock.calls[0]).toEqual([
      trx,
      expect.objectContaining({
        appId: f.appId,
        orderId: o.order_id,
        ownerUserId: c.user_id,
        platform: 'jd',
        nBaseFen: 1200n,
      }),
    ]);
    expect(new Set(f.transactions).size).toBe(1);
    const s = await f.state();
    expect(s.orders[0]).toMatchObject({
      user_id: c.user_id,
      user_basis: 'claim',
      locked: true,
      rebate_status: f.rebateTarget.status,
      platform_status: platformStatus,
      received_at: received,
      settle_period: f.rebateTarget.period,
    });
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toMatchObject({
      order_id: o.order_id,
      field: 'rebate',
      source: 'claim',
      from_status: 'UNATTRIBUTED',
      to_status: f.rebateTarget.status,
    });
    const ownWrites = h.trace.filter((q) => /^update .*"orders"/i.test(q.sql) && !q.settlement);
    expect(ownWrites.length).toBeGreaterThan(0);
    for (const q of ownWrites)
      expect(q.sql.split(' where ')[0]).not.toMatch(
        /"(?:locked|rebate_status|platform_status)"\s*=/,
      );
    expect(s.audits[0]).toMatchObject({
      admin_id: f.actor.adminId,
      action: 'claim_item_approve',
      target: `claim_items:${i.id}`,
      after: { reason: NOTE, decision: 'approved', user_id: c.user_id },
    });
    await resolved(f, [{ claim_id: c.id, user_id: c.user_id, status: 'approved' }]);
  },
);

it('[AC-B1-10k#6] 一项通过使同子单其他申请人待审项 NOT_IN_POOL，各自汇总发事件，已决与其他子单不变', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const a = await f.claim();
  const win = await f.item(a, o);
  const b = await f.claim({ user_id: await f.user() });
  const lose = await f.item(b, o);
  const c = await f.claim({ user_id: await f.user() });
  const pending = await f.item(c, o);
  const unrelated = await f.item(c, await f.order());
  const d = await f.claim({ user_id: await f.user(), status: 'rejected' });
  const old = await f.item(d, o, {
    decision: 'rejected',
    reject_reason: 'OTHER',
    decided_at: f.clock.now(),
    row_version: 9,
  });
  const e = await f.claim({ user_id: await f.user() });
  const mixed = await f.item(e, o);
  await f.item(e, await f.order({ user_id: e.user_id }), {
    decision: 'approved',
    decided_at: f.clock.now(),
    decided_by: f.actor.adminId,
  });
  success(await f.review('approve', win));
  await decided(f, lose, 'rejected', 'NOT_IN_POOL', null);
  await decided(f, pending, 'rejected', 'NOT_IN_POOL', null);
  await decided(f, mixed, 'rejected', 'NOT_IN_POOL', null);
  const s = await f.state();
  expect(s.items.find((r) => r.id === old.id)).toEqual(old);
  expect(s.items.find((r) => r.id === unrelated.id)).toEqual(unrelated);
  expect(s.claims.find((r) => r.id === b.id)?.status).toBe('rejected');
  expect(s.claims.find((r) => r.id === c.id)?.status).toBe('manual_review');
  expect(s.claims.find((r) => r.id === c.id)?.reason).toBe(c.reason);
  expect(s.claims.find((r) => r.id === e.id)?.status).toBe('approved');
  await resolved(f, [
    { claim_id: a.id, user_id: a.user_id, status: 'approved' },
    { claim_id: b.id, user_id: b.user_id, status: 'rejected' },
    { claim_id: e.id, user_id: e.user_id, status: 'approved' },
  ]);
});

it.each([
  ['approved', 'reject', 'approved'],
  ['rejected', 'reject', 'rejected'],
  ['cancelled', 'reject', 'rejected'],
  ['cancelled', 'approve', 'cancelled'],
] as const)(
  '[AC-B1-10k#7] 汇总：已有 %s，最后一项 %s 后为 %s',
  async (previous, mode, expected) => {
    const f = await fixture(h);
    const c = await f.claim();
    await f.item(c, await f.order(), {
      decision: previous,
      decided_at: f.clock.now(),
      reject_reason: previous === 'rejected' ? 'OTHER' : null,
    });
    const o = await f.order(mode === 'approve' ? { user_id: c.user_id } : {});
    const i = await f.item(c, o);
    expect(success(await f.review(mode, i)).status).toBe(expected);
    expect((await f.state()).claims[0]?.status).toBe(expected);
    await resolved(f, [{ claim_id: c.id, user_id: c.user_id, status: expected }]);
  },
);

it.each(['manual_review', 'auto_matched'])(
  '[AC-B1-10k#8] 尚有未决项保持 %s；全部已决才发 claim.resolved',
  async (status) => {
    const f = await fixture(h);
    const c = await f.claim({
      status,
      evidence_level: status === 'auto_matched' ? 'strong' : 'none',
    });
    const a = await f.item(c, await f.order());
    const b = await f.item(c, await f.order());
    const d = success(await f.review('reject', a));
    expect(d.status).toBe(status);
    expect(d.items).toHaveLength(2);
    expect((await f.state()).items.find((r) => r.id === b.id)).toEqual(b);
    await resolved(f, []);
    expect(success(await f.review('approve', b)).status).toBe('approved');
    await resolved(f, [{ claim_id: c.id, user_id: c.user_id, status: 'approved' }]);
  },
);

it.each(['self', 'other'] as const)(
  '[AC-B1-10k#26] 驳回已归属 %s 的订单：VOID 才替换系统码，否则保留客服决定',
  async (owner) => {
    for (const rebateStatus of ['ESTIMATED', 'VOID']) {
      const f = await fixture(h);
      const c = await f.claim();
      const userId = owner === 'self' ? c.user_id : await f.user();
      const o = await f.order({ user_id: userId, rebate_status: rebateStatus });
      const i = await f.item(c, o);
      const before = await f.state();
      expect(success(await f.review('reject', i, { reject_reason: 'OTHER' })).status).toBe(
        'rejected',
      );
      await decided(
        f,
        i,
        'rejected',
        rebateStatus === 'VOID' ? 'ORDER_INVALID' : 'OTHER',
        rebateStatus === 'VOID' ? null : f.actor.adminId,
      );
      expect((await f.state()).orders).toEqual(before.orders);
      noAttribution(f);
    }
  },
);

it('[AC-B1-10k#27] 审核时间取注入时钟，第二次说明覆盖父申请且两次审计保留各自说明', async () => {
  const f = await fixture(h);
  const c = await f.claim();
  const a = await f.item(c, await f.order());
  const b = await f.item(c, await f.order());
  f.clock.advanceMs(12_345);
  const firstAt = f.clock.now();
  const firstNote = '第一项核实后驳回';
  expect(success(await f.review('reject', a, { reason: firstNote })).reason).toBe(firstNote);
  await decided(f, a, 'rejected', 'NO_EVIDENCE', f.actor.adminId);
  f.clock.advanceMs(54_321);
  const secondAt = f.clock.now();
  const secondNote = '第二项核实后通过';
  expect(success(await f.review('approve', b, { reason: secondNote })).reason).toBe(secondNote);
  await decided(f, b, 'approved', null, f.actor.adminId);
  const state = await f.state();
  expect(state.claims[0]).toMatchObject({
    status: 'approved',
    reason: secondNote,
    updated_at: secondAt,
  });
  expect(state.items.find((i) => i.id === a.id)?.decided_at).toEqual(firstAt);
  expect(state.audits).toHaveLength(2);
  expect(state.audits[0]).toMatchObject({ at: firstAt, after: { reason: firstNote } });
  expect(state.audits[1]).toMatchObject({ at: secondAt, after: { reason: secondNote } });
  await resolved(f, [{ claim_id: c.id, user_id: c.user_id, status: 'approved' }]);
});
