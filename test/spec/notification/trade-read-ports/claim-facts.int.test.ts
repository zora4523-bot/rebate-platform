import { createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  AT,
  harness,
  newApp,
  orders,
  seedClaim,
  seedItem,
  seedOrder,
  seedUser,
  state,
} from './kit.ts';

const h = harness(createTestDatabase);

it('[AC-B1-12j#12] 返回申请人及全部条目决定，不把审核备注当驳回原因、不丢未决或无订单行的条目', async () => {
  const app_id = newApp();
  const claim = await seedClaim(h.db, app_id);
  const approved = await seedItem(h.db, claim, { decision: 'approved', decided_at: AT });
  const rejected = await seedItem(h.db, claim, {
    decision: 'rejected',
    reject_reason: 'NO_EVIDENCE',
    decided_at: AT,
  });
  const pending = await seedItem(h.db, claim);
  const cancelled = await seedItem(h.db, claim, { decision: 'cancelled', decided_at: AT });
  const before = await state(h.db, app_id);
  const result = await orders.readNotifyClaimFacts(h.db, { app_id, claim_id: claim.id });
  expect(result).toEqual({
    claim_id: claim.id,
    applicant_user_id: claim.user_id,
    status: 'manual_review',
    items: expect.arrayContaining([
      {
        item_id: approved.id,
        order_id: approved.order_id,
        decision: 'approved',
        reject_reason: null,
      },
      {
        item_id: rejected.id,
        order_id: rejected.order_id,
        decision: 'rejected',
        reject_reason: 'NO_EVIDENCE',
      },
      { item_id: pending.id, order_id: pending.order_id, decision: null, reject_reason: null },
      {
        item_id: cancelled.id,
        order_id: cancelled.order_id,
        decision: 'cancelled',
        reject_reason: null,
      },
    ]),
  });
  expect(result?.items).toHaveLength(4);
  expect(await state(h.db, app_id)).toEqual(before);
});

it('[AC-B1-12j#13] 申请人始终来自 claims.user_id，即使关联订单归属于其他用户', async () => {
  const app_id = newApp();
  const claim = await seedClaim(h.db, app_id, { status: 'rejected' });
  const owner = await seedUser(h.db, app_id);
  const order = await seedOrder(h.db, app_id, { user_id: owner, buy_type: 'self' });
  const item = await seedItem(h.db, claim, {
    order_id: order.order_id,
    sub_order_id: order.sub_order_id,
    decision: 'rejected',
    reject_reason: 'NOT_IN_POOL',
    decided_at: AT,
  });
  expect(await orders.readNotifyClaimFacts(h.db, { app_id, claim_id: claim.id })).toEqual({
    claim_id: claim.id,
    applicant_user_id: claim.user_id,
    status: 'rejected',
    items: [
      {
        item_id: item.id,
        order_id: order.order_id,
        decision: 'rejected',
        reject_reason: 'NOT_IN_POOL',
      },
    ],
  });
});

it('[AC-B1-12j#14] 无条目的找回单也返回申请人和原状态，支持全部找回状态', async () => {
  const app_id = newApp();
  for (const status of [
    'submitted',
    'auto_matched',
    'manual_review',
    'approved',
    'rejected',
    'cancelled',
  ]) {
    const claim = await seedClaim(h.db, app_id, {
      status,
      evidence_level: status === 'submitted' ? null : status === 'auto_matched' ? 'strong' : 'none',
    });
    expect(await orders.readNotifyClaimFacts(h.db, { app_id, claim_id: claim.id })).toEqual({
      claim_id: claim.id,
      applicant_user_id: claim.user_id,
      status,
      items: [],
    });
  }
});

it('[AC-B1-12j#15] 所有已存驳回原因码原样返回，不生成用户文案、不按找回单备注覆盖', async () => {
  const app_id = newApp();
  const claim = await seedClaim(h.db, app_id, { status: 'rejected' });
  const expected = [];
  for (const reason of [
    'NO_EVIDENCE',
    'EXPIRED_CLICK',
    'NOT_TRACKED',
    'OTHER_TLJ',
    'FRAUD',
    'OTHER',
    'NOT_IN_POOL',
    'ORDER_INVALID',
  ]) {
    const item = await seedItem(h.db, claim, {
      decision: 'rejected',
      reject_reason: reason,
      decided_at: AT,
    });
    expected.push({
      item_id: item.id,
      order_id: item.order_id,
      decision: 'rejected',
      reject_reason: reason,
    });
  }
  const result = await orders.readNotifyClaimFacts(h.db, { app_id, claim_id: claim.id });
  expect(result?.items).toEqual(expect.arrayContaining(expected));
  expect(result?.items).toHaveLength(expected.length);
});

it('[AC-B1-12j#16] 按 app_id 和 claim_id 双重隔离，同应用另一找回单的条目也不能混入', async () => {
  const app_id = newApp();
  const otherApp = newApp();
  const own = await seedClaim(h.db, app_id);
  const unrelated = await seedClaim(h.db, app_id, { user_id: own.user_id });
  const foreign = await seedClaim(h.db, otherApp);
  const item = await seedItem(h.db, own);
  await seedItem(h.db, unrelated, { decision: 'approved', decided_at: AT });
  const foreignItem = await seedItem(h.db, foreign, {
    decision: 'rejected',
    reject_reason: 'FRAUD',
    decided_at: AT,
  });
  expect(await orders.readNotifyClaimFacts(h.db, { app_id, claim_id: own.id })).toEqual({
    claim_id: own.id,
    applicant_user_id: own.user_id,
    status: 'manual_review',
    items: [{ item_id: item.id, order_id: item.order_id, decision: null, reject_reason: null }],
  });
  expect(await orders.readNotifyClaimFacts(h.db, { app_id, claim_id: foreign.id })).toBeNull();
  expect(
    await orders.readNotifyClaimFacts(h.db, { app_id: otherApp, claim_id: own.id }),
  ).toBeNull();
  expect(await orders.readNotifyClaimFacts(h.db, { app_id, claim_id: randomUUID() })).toBeNull();
  expect(
    await orders.readNotifyClaimFacts(h.db, { app_id: otherApp, claim_id: foreign.id }),
  ).toEqual({
    claim_id: foreign.id,
    applicant_user_id: foreign.user_id,
    status: 'manual_review',
    items: [
      {
        item_id: foreignItem.id,
        order_id: foreignItem.order_id,
        decision: 'rejected',
        reject_reason: 'FRAUD',
      },
    ],
  });
});

it('[AC-B1-12j#17] 只读事务中重复读取找回结果，不审核、不改归属、不生成金额', async () => {
  const app_id = newApp();
  const claim = await seedClaim(h.db, app_id);
  const item = await seedItem(h.db, claim);
  const before = await state(h.db, app_id);
  await h.db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      const input = { app_id, claim_id: claim.id };
      const first = await orders.readNotifyClaimFacts(trx, input);
      expect(first).toEqual({
        claim_id: claim.id,
        applicant_user_id: claim.user_id,
        status: 'manual_review',
        items: [{ item_id: item.id, order_id: item.order_id, decision: null, reject_reason: null }],
      });
      expect(await orders.readNotifyClaimFacts(trx, input)).toEqual(first);
      expect(await orders.readNotifyClaimFacts(trx, { app_id, claim_id: randomUUID() })).toBeNull();
    });
  expect(await state(h.db, app_id)).toEqual(before);
});
