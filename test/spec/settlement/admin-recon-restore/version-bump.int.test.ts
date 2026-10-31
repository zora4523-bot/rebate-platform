// B2-09g restore rule test, an estimate restated after the credit (claude-independent, SPEC_REF
// 81273415): 08 BR-FUND-22 ③ reckons the restore from booked_base_fen and the snapshot's ratios, and
// BR-FUND-01 R9b / BR-FUND-03 let a union sync move est_commission_fen and commission_version on a
// CREDITED order. commission_split_totals and commission_split_amounts only ever hold version 1
// (commission/infra/snapshot-store.ts), so orders.commission_version runs ahead of them; the
// attribution (who and which ratio) stays in the immutable commission_splits row and no amount
// version of it is needed. Such a difference is restored like any other, it does not answer 5xx.
// Expected amounts are written by hand. Requests go through the real admin entry (kit.ts).
// Synthetic: kit.ts's seeds and the one UPDATE that order-sync would commit. Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  available,
  detailView,
  expectRestored,
  fixture,
  netOf,
  netsOf,
  restoreKey,
  restoreLines,
  restoreVouchers,
  restored,
  seedCase,
  shareEvents,
  suite,
  voucherLines,
  withRestoreAdmin,
  type RestoreFixture,
} from './kit.ts';

const s = suite();

/** The estimate of the union sync: neither N, the snapshot's estimate nor any booked amount. */
const RESTATED_EST_FEN = 5000n;

/**
 * What order-sync commits on a CREDITED order when the estimate changes: the new estimate and
 * commission_version + 1 (orders/domain/update-plan.ts planOrderSyncColumns); the rebate state
 * machine leaves CREDITED alone, so no snapshot row of the new version is written.
 */
async function restateEstimate(f: RestoreFixture, orderId: string): Promise<void> {
  await f.db
    .updateTable('orders')
    .set((eb) => ({
      est_commission_fen: RESTATED_EST_FEN,
      commission_version: eb('commission_version', '+', 1),
      row_version: eb('row_version', '+', 1),
      updated_at: f.clock.now(),
    }))
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .execute();
}

function orderRow(f: RestoreFixture, orderId: string) {
  return f.db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

/** The amount versions stored for the order, in the two snapshot tables. */
async function storedVersions(f: RestoreFixture, orderId: string) {
  const totals = await f.db
    .selectFrom('commission_split_totals')
    .select('commission_version')
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .execute();
  const amounts = await f.db
    .selectFrom('commission_split_amounts')
    .select('commission_version')
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .execute();
  return {
    totals: [...new Set(totals.map((row) => row.commission_version))],
    amounts: [...new Set(amounts.map((row) => row.commission_version))],
  };
}

it('[AC-B2-09g#39] BR-FUND-22 ③ 与 BR-FUND-01 R9b：入账后联盟同步改预估，orders.commission_version=2、est_commission_fen 5000，分佣快照只有版本 1 → 恢复照常成功、不是 5xx：按 booked_base_fen 850 与快照比例 1000 bp 实发 85（不按新预估的 425，也不按快照金额 368）；一条 ADMIN_ADJUST(RESTORE)，受益人净额 85、余额 85、平台净额 533 → 448、应收净额 1000 不变；差错单 adjusted，active 事件照追加，订单行一字不改', async () => {
  const f = await fixture(s);
  const { order, diff, userId } = await seedCase(f);
  await restateEstimate(f, order.orderId);

  const orderBefore = await orderRow(f, order.orderId);
  expect(orderBefore).toMatchObject({
    rebate_status: 'CREDITED',
    commission_version: 2,
    est_commission_fen: RESTATED_EST_FEN,
    booked_base_fen: 850n,
  });
  expect(await storedVersions(f, order.orderId)).toEqual({ totals: [1], amounts: [1] });
  const netsBefore = await netsOf(f, order.orderKey);
  expect(netsBefore.platform_net_fen).toBe(533n);
  expect(netsBefore.union_receivable_net_fen).toBe(1000n);
  const eventsBefore = await shareEvents(f, order.orderId);

  await withRestoreAdmin(f, async (h) => {
    const data = await restored(await h.restore(diff.id));

    expect(data.restored_fen).toBe(85);
    const after = await expectRestored(f, diff, {
      adminId: h.operator.id,
      paid: { direct: 85n },
    });
    expect(after.status).toBe('adjusted');
    expect(data.recon_diff).toEqual(detailView(after));

    const key = restoreKey(order.orderKey, userId, 'direct', diff.id);
    expect((await restoreVouchers(f)).map((v) => v.uniq_key)).toEqual([key]);
    expect(await voucherLines(f, key)).toEqual(restoreLines(userId, 85n));
    expect(await available(f, userId)).toBe(85n);

    const nets = await netsOf(f, order.orderKey);
    expect(netOf(nets, userId, 'direct')).toBe(85n);
    expect(nets.platform_net_fen).toBe(448n);
    expect(nets.union_receivable_net_fen).toBe(1000n);

    const added = (await shareEvents(f, order.orderId)).slice(eventsBefore.length);
    expect(added.map((e) => [e.user_id, e.role, e.status])).toEqual([[userId, 'direct', 'active']]);
    expect(await orderRow(f, order.orderId)).toEqual(orderBefore);
    expect(await storedVersions(f, order.orderId)).toEqual({ totals: [1], amounts: [1] });
  });
});
