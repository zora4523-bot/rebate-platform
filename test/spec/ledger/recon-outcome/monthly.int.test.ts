// B2-09h monthly check rule tests (claude-independent, SPEC_REF 9ab94dc0): 08 BR-FUND-04 ④ (差错结论
// 为「以联盟为准」的视为一致), 校验结果表 (WAITING，差额超出容差 → 差错单「账单金额不一致」，保持 WAITING；
// 差错单结论「以联盟为准」后进补充批次), 例 2 (base_fen 1234, B_settle 1100 → 差错单，不入账；结论以联盟
// 为准 → 补充批次按 1100); contracts/openapi.yaml closeAdminReconDiff (`ours`, no outcome and the
// closed status alone do not count as matched).
// Real pieces: the close over the admin entry (kit.ts), the bill job and the supplement command
// (../../settlement/supplement/kit.ts) over the production source reader on the real orders and
// order_settlements rows, or the whole launch over the admin entry
// (../../settlement/admin-settle-commands/kit.ts). Synthetic: orders, settlements, snapshots, bills.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { createBillSourceReader } from '../../../../apps/api/src/modules/settlement/bill/index.ts';
import * as commands from '../../settlement/admin-settle-commands/kit.ts';
import { validations as billValidations, type Order } from '../../settlement/bill/kit.ts';
import {
  BEFORE,
  MONTH,
  fixture as billingFixture,
  itemsOf,
  main,
  order,
  settlement,
  state,
  supplements,
  validations,
  type Fixture as Billing,
} from '../../settlement/supplement/kit.ts';
import { allDiffs, closed, ledger, r1Diff, suite, withCloseAdmin, type Fixture } from './kit.ts';

const s = suite();
/** A launch after the conclusion: a later nominal moment than LAUNCH (settle_jobs' key). */
const RELAUNCH = '2032-07-26T11:00:00+08:00';
const TAOBAO = { platform: 'taobao' };

/** The production readSource on the job's and the command's transaction. */
function productionSource(h: Billing): void {
  h.readSource.mockImplementation(
    createBillSourceReader({ readUnionAuthoritative: ledger.readUnionAuthoritativeOrderKeys }),
  );
}

/** The close's view of the billing fixture's app: same database and clock. */
function reconOf(h: Billing): Fixture {
  return { s, db: h.db, clock: h.clock, appId: h.appId };
}

/** The orders row of a bill-kit order (that kit keeps its facts in memory). */
async function storeOrder(h: Billing, o: Order): Promise<void> {
  const fact = o.fact.order;
  await h.db
    .insertInto('orders')
    .values({
      app_id: h.appId,
      order_id: o.id,
      platform: o.fact.platform,
      sub_order_id: `synthetic-${o.id}`,
      raw_item_id: 'synthetic-item',
      platform_status: 'RECEIVED',
      rebate_status: fact.rebateStatus,
      hold: fact.hold,
      hold_reason: fact.hold ? 'RISK' : null,
      rights_pending: fact.rightsPending,
      commission_version: fact.commissionVersion,
      attr_at: new Date(BEFORE),
      settle_period: fact.settlePeriod,
      created_at: new Date(BEFORE),
      updated_at: new Date(BEFORE),
    })
    .execute();
}

/** A WAITING order (snapshot base 850, reserve 15%) with one settlement of `fen`. */
async function settled(
  h: Billing,
  fen: bigint,
  patch: Parameters<typeof order>[1] = {},
): Promise<Order> {
  const o = await order(h, patch);
  await storeOrder(h, o);
  await settlement(h, o, { settle_commission_fen: fen });
  return o;
}

it('[AC-B2-09h#17] BR-FUND-04 例 2 全链路：快照基数 1234、B_settle 1100、容差 0 → 账单日与未下结论时的补充都是差错单、不入批；财务结案 outcome=union 后补充批次按 B_settle 1100 入批，差错单不重复登记，不记账', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const o = await order(h, {}, 'taobao', {
    tlj: 0n,
    base: 1234n,
    amounts: [617n, 123n, 61n],
    userTotal: 801n,
    retain: 433n,
  });
  await storeOrder(h, o);
  // floor(1295 × 8500 / 10000) = 1100.
  await settlement(h, o, { settle_commission_fen: 1295n });

  await main(h);
  const billed = await state(h);
  expect(billed.batches).toEqual([]);
  expect(billed.diffs).toEqual([
    expect.objectContaining({
      type: 'settle_amount_mismatch',
      source: 'R1',
      ref_type: 'order',
      ref_id: o.key,
      period: MONTH,
      status: 'open',
      expected_fen: 1234n,
      actual_fen: 1100n,
      diff_fen: -134n,
    }),
  ]);

  expect((await h.launch()).batchIds).toEqual([]);
  expect((await state(h)).batches).toEqual([]);
  expect(await validations(h)).toEqual([
    expect.objectContaining({ orderKey: o.key, result: 'amount_mismatch' }),
  ]);

  const diff = billed.diffs[0]!;
  await withCloseAdmin(reconOf(h), async (a) => {
    await closed(await a.close(diff.id, { reason: '财务核实以联盟为准', outcome: 'union' }));
  });
  const concluded = (await state(h)).diffs;

  h.clock.set(RELAUNCH);
  expect((await h.launch({ requestedAt: new Date(RELAUNCH) })).batchIds).toHaveLength(1);
  const after = await state(h);
  expect(supplements(after)).toEqual([
    expect.objectContaining({ bill_id: MONTH, platform: 'taobao', status: 'DRAFT' }),
  ]);
  expect(itemsOf(after, supplements(after))).toEqual([
    expect.objectContaining({
      item_type: 'order',
      order_id: o.id,
      settle_seq: 1,
      b_settle_fen: 1100n,
    }),
  ]);
  expect(after.diffs).toEqual(concluded);
  expect(after.vouchers).toEqual([]);
  expect(after.balances).toEqual([]);
});

it('[AC-B2-09h#18] 账单日任务（真实 createBillJob 与来源读口）：账单日前已结案 outcome=union 的金额不一致单算相符，进主批次、按联盟结算额；ours、不传 outcome、未结案、没有差错单的仍是差错不入批；union 单 hold 中仍暂缓；账单差错数与暂缓数按此计', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const f = reconOf(h);
  const union = await settled(h, 2000n);
  const ours = await settled(h, 2000n);
  const bare = await settled(h, 2000n);
  const open = await settled(h, 2000n);
  const unseen = await settled(h, 2000n);
  const held = await settled(h, 2000n, { hold: true });
  const matching = await settled(h, 1000n);
  const diffOf = (o: Order) =>
    r1Diff(f, {
      period: MONTH,
      ref_id: o.key,
      expected_fen: 850n,
      actual_fen: 1700n,
      diff_fen: 850n,
    });
  const diffs = {
    union: await diffOf(union),
    ours: await diffOf(ours),
    bare: await diffOf(bare),
    held: await diffOf(held),
  };
  await diffOf(open);
  await withCloseAdmin(f, async (a) => {
    const reason = '财务核实';
    await closed(await a.close(diffs.union.id, { reason, outcome: 'union' }));
    await closed(await a.close(diffs.ours.id, { reason, outcome: 'ours' }));
    await closed(await a.close(diffs.bare.id, { reason }));
    await closed(await a.close(diffs.held.id, { reason, outcome: 'union' }));
  });
  const before = await allDiffs(f);

  await main(h);
  const after = await state(h);
  expect(after.batches).toEqual([
    expect.objectContaining({
      bill_id: MONTH,
      platform: 'taobao',
      kind: 'main',
      status: 'DRAFT',
      order_count: 2,
    }),
  ]);
  expect(after.items).toHaveLength(2);
  expect(after.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ order_id: union.id, b_settle_fen: 1700n }),
      expect.objectContaining({ order_id: matching.id, b_settle_fen: 850n }),
    ]),
  );
  const results = (await billValidations(h)).map((v) => [v.orderKey, v.result]).sort();
  expect(results).toEqual(
    [
      [union.key, 'candidate'],
      [matching.key, 'candidate'],
      [held.key, 'deferred'],
      [ours.key, 'amount_mismatch'],
      [bare.key, 'amount_mismatch'],
      [open.key, 'amount_mismatch'],
      [unseen.key, 'amount_mismatch'],
    ].sort(),
  );
  expect(after.bills).toEqual([expect.objectContaining({ error_count: 4, held_count: 1 })]);
  expect(after.diffs).toHaveLength(before.length + 1);
  expect(after.diffs).toEqual(expect.arrayContaining(before));
  expect(after.diffs).toContainEqual(
    expect.objectContaining({
      type: 'settle_amount_mismatch',
      ref_id: unseen.key,
      status: 'open',
      expected_fen: 850n,
      actual_fen: 1700n,
    }),
  );
  expect(after.vouchers).toEqual([]);
  expect(after.balances).toEqual([]);
});

it('[AC-B2-09h#19] 后台入口全程（生产装配）：发起补充查出 R1 金额不一致差错单，POST close 下结论后再发起：只有 outcome=union 的单进 kind=supplement 的批次、按联盟结算额（1100 → B_settle 935），ours、不传 outcome、未结案的单不入批，差错单不重复登记', async () => {
  const f = commands.fixture(s);
  await commands.setSwitch(f, commands.creditSwitch('taobao'), true);
  const bill = await commands.seedBill(f, '2026-09');
  const orders = {
    union: await commands.seedOrder(f, { commissionFen: 1100n }),
    ours: await commands.seedOrder(f, { commissionFen: 1100n }),
    bare: await commands.seedOrder(f, { commissionFen: 1100n }),
    open: await commands.seedOrder(f, { commissionFen: 1100n }),
  };
  const diffFor = async (o: commands.SeededOrder) => {
    const rows = await commands.allDiffs(f);
    const row = rows.find((one) => one.ref_id === `${o.platform}:${o.subOrderId}`);
    expect(row, o.subOrderId).toMatchObject({
      source: 'R1',
      type: 'settle_amount_mismatch',
      period: bill.bill_id,
      ref_type: 'order',
      status: 'open',
      expected_fen: 850n,
      actual_fen: 935n,
    });
    return row!;
  };
  await commands.withCommandsAdmin(f, async (biller) => {
    const first = await commands.launched(await biller.supplement(bill.bill_id, TAOBAO));
    expect(first.batch_ids).toEqual([]);
    expect(await commands.allBatches(f)).toEqual([]);
    expect(await commands.allDiffs(f)).toHaveLength(4);

    const union = await diffFor(orders.union);
    const ours = await diffFor(orders.ours);
    const bare = await diffFor(orders.bare);
    await diffFor(orders.open);
    await withCloseAdmin(f, async (a) => {
      const reason = '财务核实';
      await closed(await a.close(union.id, { reason, outcome: 'union' }));
      await closed(await a.close(ours.id, { reason, outcome: 'ours' }));
      await closed(await a.close(bare.id, { reason }));
    });
    const concluded = await commands.allDiffs(f);

    f.clock.set(commands.later(f, 1));
    const second = await commands.launched(await biller.supplement(bill.bill_id, TAOBAO));
    expect(second.outcome).toBe('generated');
    expect(second.batch_ids).toHaveLength(1);
    expect(await commands.allBatches(f)).toEqual([
      expect.objectContaining({
        batch_id: second.batch_ids[0],
        kind: 'supplement',
        status: 'DRAFT',
        order_count: 1,
      }),
    ]);
    expect(await commands.itemsOf(f, second.batch_ids)).toEqual([
      expect.objectContaining({
        item_type: 'order',
        order_id: orders.union.orderId,
        settle_seq: 1,
        b_settle_fen: 935n,
      }),
    ]);
    expect(await commands.allDiffs(f)).toEqual(concluded);
  });
});
