// B2-09h monthly check rule tests (claude-independent, SPEC_REF 9ab94dc0): 08 BR-FUND-04 ④ (差错结论
// 为「以联盟为准」的视为一致), 校验结果表 (WAITING，差额超出容差 → 差错单「账单金额不一致」，保持 WAITING；
// 差错单结论「以联盟为准」后进补充批次), 例 2 (base_fen 1234, B_settle 1100 → 差错单，不入账；结论以联盟
// 为准 → 补充批次按 1100); contracts/openapi.yaml closeAdminReconDiff (`ours`, no outcome and the
// closed status alone do not count as matched); 编排裁定 D10-506: ② the conclusion is bound to the
// amounts of its difference: it counts only while the current base and B_settle both equal them,
// otherwise the amounts are compared as usual; ③ a mismatch after a close opens a new 账单金额不一致
// difference, at most one for the same amount state, the old one stays closed, the order stays WAITING.
// CT-24zf contract r3: that difference has ref_id {order_key}#AMT#{base_fen}:{b_settle_fen}, and the
// bill's first one stays the bare {order_key}. A new one opens only when no difference of this bill and
// order, bare or #AMT#, has the current amounts (A→B→A does not re-open); order_keys that are prefixes
// of each other are not mixed up. Several differences on the current amounts: the last one closed with
// an outcome speaks (closed_at, id descending), across bills too.
// Real pieces: the close over the admin entry (kit.ts), the bill job and the supplement command
// (../../settlement/supplement/kit.ts) over the production source reader on the real orders and
// order_settlements rows, the whole launch over the admin entry
// (../../settlement/admin-settle-commands/kit.ts), and the real credit of a batch item
// (../../settlement/credit/kit.ts). Synthetic: orders, settlements, snapshots, bills. The tests of ②
// keep an unchanged concluded order next to the changed one, so they cannot pass by paying nothing.
// Top-level it() only (规划/11 §4.3).
import { subFen } from '@couli/money';
import { expect, it } from 'vitest';
import { createBillSourceReader } from '../../../../apps/api/src/modules/settlement/bill/index.ts';
import { createSupplementCommand } from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import { appendVersion, commission } from '../../commission/snapshot-read/fixtures.ts';
import * as commands from '../../settlement/admin-settle-commands/kit.ts';
import {
  ledger as billLedger,
  validations as billValidations,
  type Order,
} from '../../settlement/bill/kit.ts';
import {
  creditKey,
  harness,
  platformKey,
  platformLines,
  userCreditLines,
  type Harness,
} from '../../settlement/credit/kit.ts';
import {
  BEFORE,
  LATER,
  MONTH,
  NOW,
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
import {
  ago,
  allDiffs,
  amountDiff,
  amountRef,
  closed,
  ledger,
  ofOrder,
  r1Diff,
  suite,
  unionConclusions,
  unionDiff,
  withCloseAdmin,
  type DiffSeed,
  type Fixture,
  type Resolution,
} from './kit.ts';

const s = suite();
const TAOBAO = { platform: 'taobao' };
const UNION = { reason: '财务核实以联盟为准', outcome: 'union' };
const OURS = { reason: '财务核实以我方为准', outcome: 'ours' };
const NO_OUTCOME = { reason: '不下结论' };
/** After the closes of a supplement test (LAUNCH) and before its launch at 11:00. */
const AFTER_CLOSE = new Date('2032-07-26T10:30:00+08:00');
/** The bill month before MONTH, for the differences of another bill. */
const OTHER_BILL = '2032-05';
/** BR-FUND-04 例 2: snapshot base 1234 (the shares of 5000 / 1000 / 500 bp). */
const EXAMPLE = { tlj: 0n, base: 1234n, amounts: [617n, 123n, 61n], userTotal: 801n, retain: 433n };

interface SnapshotVersion {
  readonly base: bigint;
  readonly n: bigint;
  readonly amounts: readonly bigint[];
  readonly userTotal: bigint;
}

/** The base after a partial refund, 1234 → 600. */
const REFUNDED: SnapshotVersion = {
  base: 600n,
  n: 706n,
  amounts: [300n, 60n, 30n],
  userTotal: 390n,
};
/** Back on 例 2's base. */
const RESTORED: SnapshotVersion = {
  base: 1234n,
  n: 1340n,
  amounts: [617n, 123n, 61n],
  userTotal: 801n,
};

/** The production readSource. */
function productionReader() {
  return createBillSourceReader({
    readUnionAuthoritative: ledger.readUnionAuthoritativeOrderKeys,
  });
}

/** The production readSource on the job's and the command's transaction. */
function productionSource(h: Billing): void {
  h.readSource.mockImplementation(productionReader());
}

/** The close's view of an app on the suite's database: same database and clock. */
function reconOf(h: Pick<Billing, 'db' | 'clock' | 'appId'>): Fixture {
  return { s, db: h.db, clock: h.clock, appId: h.appId };
}

/** The instant `hour`:00 of the launch day, a nominal moment of its own (settle_jobs' key). */
function launchMoment(hour: number): Date {
  return new Date(`2032-07-26T${String(hour)}:00:00+08:00`);
}

/** A supplement launch at `hour`:00 of the launch day. */
function launchAt(h: Billing, hour: number) {
  const at = launchMoment(hour);
  h.clock.set(at);
  return h.launch({ requestedAt: at });
}

/** The recheck of the current bill at `hour`:00 of the launch day. */
function recheckAt(h: Billing, hour: number) {
  const at = launchMoment(hour);
  h.clock.set(at);
  return h.recheck({ requestedAt: at });
}

/** Closes the open difference of each order with `body`, through the admin entry. */
async function closeOpen(h: Billing, orders: readonly Order[], body: object): Promise<void> {
  const { diffs } = await state(h);
  await withCloseAdmin(reconOf(h), async (a) => {
    for (const o of orders) {
      const diff = diffs.find((row) => ofOrder(row, o.key) && row.status === 'open');
      expect(diff, o.key).toBeDefined();
      await closed(await a.close(diff!.id, body));
    }
  });
}

/** The current snapshot version of `o` becomes `to` (BR-CALC-10: the greatest version). */
async function newVersion(
  h: Billing,
  o: Order,
  version: number,
  to: SnapshotVersion,
): Promise<void> {
  await appendVersion(h.db, o, version, to.base, to.n, to.amounts, to.userTotal, new Date(BEFORE));
  await h.db
    .updateTable('orders')
    .set({ commission_version: version })
    .where('app_id', '=', h.appId)
    .where('order_id', '=', o.id)
    .execute();
}

/** The union settles `o` again after the bill: seq 2, taken before the next launch. */
function resettle(h: Billing, o: Order, fen: bigint): Promise<void> {
  return settlement(h, o, { seq: 2, settle_commission_fen: fen, created_at: new Date(LATER) });
}

async function rebateStatus(h: Billing, o: Order): Promise<string> {
  const row = await h.db
    .selectFrom('orders')
    .select('rebate_status')
    .where('app_id', '=', h.appId)
    .where('order_id', '=', o.id)
    .executeTakeFirstOrThrow();
  return row.rebate_status;
}

/** The difference ③ opens on `o` for these amounts: 账单金额不一致 of the same bill, its #AMT# ref_id. */
function openedFor(
  o: Order,
  expectedFen: bigint,
  actualFen: bigint,
  refId = amountRef(o.key, expectedFen, actualFen),
) {
  return expect.objectContaining({
    type: 'settle_amount_mismatch',
    source: 'R1',
    ref_type: 'order',
    ref_id: refId,
    period: MONTH,
    status: 'open',
    handler_id: null,
    closed_at: null,
    resolution: null,
    expected_fen: expectedFen,
    actual_fen: actualFen,
    diff_fen: subFen(expectedFen, actualFen),
  });
}

/** The first difference of `o` in this bill: the bare {order_key} is still free. */
function firstFor(o: Order, expectedFen: bigint, actualFen: bigint) {
  return openedFor(o, expectedFen, actualFen, o.key);
}

/** The supplement command on the harness's app, over the production source reader. */
function supplementOf(c: Harness) {
  return createSupplementCommand({
    clock: c.clock,
    config: { get: async (_appId, key) => (key === 'credit.enabled.taobao' ? 'on' : undefined) },
    readSource: productionReader(),
    readSnapshot: commission.readCommissionSnapshot,
    readTljDeductFen: async () => 0n,
    registerDiff: billLedger.registerReconDiff,
    saveValidations: async () => undefined,
  });
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

/** A WAITING order of 例 2: snapshot base 1234, floor(1295 × 8500 / 10000) = B_settle 1100. */
async function example(h: Billing): Promise<Order> {
  const o = await order(h, {}, 'taobao', EXAMPLE);
  await storeOrder(h, o);
  await settlement(h, o, { settle_commission_fen: 1295n });
  return o;
}

/** The bill day of `orders`, then each difference closed with `body`. */
async function billAndClose(h: Billing, orders: readonly Order[], body: object): Promise<void> {
  await main(h);
  await closeOpen(h, orders, body);
}

it('[AC-B2-09h#17] BR-FUND-04 例 2 全链路：快照基数 1234、B_settle 1100、容差 0 → 账单日与未下结论时的补充都是差错单、不入批；财务结案 outcome=union 后补充批次按 B_settle 1100 入批，差错单不重复登记，不记账', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const o = await example(h);

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
      diff_fen: 134n,
    }),
  ]);

  expect((await h.launch()).batchIds).toEqual([]);
  expect((await state(h)).batches).toEqual([]);
  expect(await validations(h)).toEqual([
    expect.objectContaining({ orderKey: o.key, result: 'amount_mismatch' }),
  ]);

  await closeOpen(h, [o], UNION);
  const concluded = (await state(h)).diffs;

  expect((await launchAt(h, 11)).batchIds).toHaveLength(1);
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
      diff_fen: -850n,
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

it('[AC-B2-09h#21] D10-506 ② 结案后部分退款：基数 1234 → 600 的单结论不适用，不入批、校验仍是差错、保持 WAITING；基数没变的 union 单照常按联盟结算额入批；不记账', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const intact = await example(h);
  const refunded = await example(h);
  await billAndClose(h, [intact, refunded], UNION);
  await newVersion(h, refunded, 2, REFUNDED);

  expect((await launchAt(h, 11)).batchIds).toHaveLength(1);
  const after = await state(h);
  expect(itemsOf(after, supplements(after))).toEqual([
    expect.objectContaining({
      item_type: 'order',
      order_id: intact.id,
      settle_seq: 1,
      b_settle_fen: 1100n,
    }),
  ]);
  const results = (await validations(h)).map((v) => [v.orderKey, v.result]).sort();
  expect(results).toEqual(
    [
      [intact.key, 'candidate'],
      [refunded.key, 'amount_mismatch'],
    ].sort(),
  );
  expect(await rebateStatus(h, refunded)).toBe('WAITING');
  expect(after.vouchers).toEqual([]);
  expect(after.balances).toEqual([]);
});

it('[AC-B2-09h#22] D10-506 ② 联盟再结算：seq 2 的 B_settle 变成 1200 的单结论不适用、不入批；seq 2 换算后仍是 1100 的单按 seq 2 入批；没有再结算的 union 单照常入批', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const intact = await example(h);
  const resent = await example(h);
  const changed = await example(h);
  await billAndClose(h, [intact, resent, changed], UNION);
  await resettle(h, resent, 1295n);
  // floor(1412 × 8500 / 10000) = 1200.
  await resettle(h, changed, 1412n);

  expect((await launchAt(h, 11)).batchIds).toHaveLength(1);
  const after = await state(h);
  const items = itemsOf(after, supplements(after));
  expect(items).toHaveLength(2);
  expect(items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ order_id: intact.id, settle_seq: 1, b_settle_fen: 1100n }),
      expect.objectContaining({ order_id: resent.id, settle_seq: 2, b_settle_fen: 1100n }),
    ]),
  );
  expect(await rebateStatus(h, changed)).toBe('WAITING');
  expect(after.vouchers).toEqual([]);
});

it('[AC-B2-09h#23] D10-506 ② 结论要两个金额都精确相等，容差不放宽：基数差 1 分、B_settle 差 1 分的单在容差 5 分下仍不入批；结论不适用时照常比较：基数变成 1103，与 B_settle 差 3 分在容差内，算相符入批', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  h.values.set('settle.batch.match_tolerance_fen', '5');
  const intact = await example(h);
  const nearBase = await example(h);
  const nearSettle = await example(h);
  const ordinary = await example(h);
  await billAndClose(h, [intact, nearBase, nearSettle, ordinary], UNION);
  await newVersion(h, nearBase, 2, {
    base: 1233n,
    n: 1339n,
    amounts: [616n, 123n, 61n],
    userTotal: 800n,
  });
  // floor(1296 × 8500 / 10000) = 1101.
  await resettle(h, nearSettle, 1296n);
  await newVersion(h, ordinary, 2, {
    base: 1103n,
    n: 1209n,
    amounts: [551n, 110n, 55n],
    userTotal: 716n,
  });

  expect((await launchAt(h, 11)).batchIds).toHaveLength(1);
  const after = await state(h);
  const items = itemsOf(after, supplements(after));
  expect(items).toHaveLength(2);
  expect(items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ order_id: intact.id, b_settle_fen: 1100n }),
      expect.objectContaining({ order_id: ordinary.id, b_settle_fen: 1100n }),
    ]),
  );
  const results = (await validations(h)).map((v) => [v.orderKey, v.result]).sort();
  expect(results).toEqual(
    [
      [intact.key, 'candidate'],
      [ordinary.key, 'candidate'],
      [nearBase.key, 'amount_mismatch'],
      [nearSettle.key, 'amount_mismatch'],
    ].sort(),
  );
});

it('[AC-B2-09h#24] D10-506 ② 账单日任务同样绑金额：结论的基数、B_settle、两者都和当前不同的单不入批、计入差错；同一单有两张 union 结论（别的账单月）时，当前金额等于其中任一张就算相符，不论先后', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const f = reconOf(h);
  const current = await settled(h, 2000n);
  const otherBase = await settled(h, 2000n);
  const otherSettle = await settled(h, 2000n);
  const otherBoth = await settled(h, 2000n);
  const older = await settled(h, 2000n);
  const newer = await settled(h, 2000n);
  const conclude = (o: Order, period: string, expected: bigint, actual: bigint) =>
    unionDiff(f, {
      period,
      ref_id: o.key,
      expected_fen: expected,
      actual_fen: actual,
      diff_fen: subFen(expected, actual),
    });
  await conclude(current, MONTH, 850n, 1700n);
  await conclude(otherBase, MONTH, 851n, 1700n);
  await conclude(otherSettle, MONTH, 850n, 1699n);
  await conclude(otherBoth, MONTH, 900n, 1600n);
  await conclude(older, '2032-04', 850n, 1700n);
  await conclude(older, '2032-05', 850n, 1500n);
  await conclude(newer, '2032-04', 850n, 1500n);
  await conclude(newer, '2032-05', 850n, 1700n);

  await main(h);
  const after = await state(h);
  expect(after.batches).toEqual([
    expect.objectContaining({ kind: 'main', status: 'DRAFT', order_count: 3 }),
  ]);
  expect(after.items.map((item) => item.order_id).sort()).toEqual(
    [current.id, older.id, newer.id].sort(),
  );
  for (const item of after.items) expect(item.b_settle_fen).toBe(1700n);
  const results = (await billValidations(h)).map((v) => [v.orderKey, v.result]).sort();
  expect(results).toEqual(
    [
      [current.key, 'candidate'],
      [older.key, 'candidate'],
      [newer.key, 'candidate'],
      [otherBase.key, 'amount_mismatch'],
      [otherSettle.key, 'amount_mismatch'],
      [otherBoth.key, 'amount_mismatch'],
    ].sort(),
  );
  expect(after.bills).toEqual([expect.objectContaining({ error_count: 3, held_count: 0 })]);
});

it('[AC-B2-09h#25] BR-FUND-04 例 2 入账（D10-506 ②）：基数与 B_settle 都等于结论金额时，补充批次按 B_settle 1100 入批，真实入账 550 / 110 / 440（自购 5000bp、直推 1000bp、预留 0，B_credit = N），不按快照基数', async () => {
  const c = await harness(s.db());
  // The harness's snapshot is taken on the estimate: base 4433 instead of 例 2's 1234. Only the
  // mismatch with B_settle matters here.
  const o = await c.order({
    settleFen: 1100n,
    reserveBp: 0,
    seqs: [1],
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000 },
    ],
  });
  const f = reconOf(c);
  await commands.seedBill(f, MONTH, { platform_order_counts: { taobao: 0 } });
  const command = supplementOf(c);
  const launch = (hour: number) => {
    const at = launchMoment(hour);
    c.clock.set(at);
    return command.launch(c.db, {
      appId: c.appId,
      billId: MONTH,
      platform: 'taobao',
      requestedAt: at,
    });
  };

  expect((await launch(10)).batchIds).toEqual([]);
  const diffs = await allDiffs(f);
  expect(diffs).toEqual([
    expect.objectContaining({
      type: 'settle_amount_mismatch',
      ref_id: o.orderKey,
      expected_fen: 4433n,
      actual_fen: 1100n,
    }),
  ]);
  await withCloseAdmin(f, async (a) => {
    await closed(await a.close(diffs[0]!.id, UNION));
  });

  const { batchIds } = await launch(11);
  expect(batchIds).toHaveLength(1);
  expect(await commands.itemsOf(f, batchIds)).toEqual([
    expect.objectContaining({
      item_type: 'order',
      order_id: o.orderId,
      settle_seq: 1,
      b_settle_fen: 1100n,
    }),
  ]);

  await c.credit(o);
  expect(await c.voucherLines(creditKey(o, 'self'))).toEqual(userCreditLines(o, 'self', 550n));
  expect(await c.voucherLines(creditKey(o, 'direct'))).toEqual(userCreditLines(o, 'direct', 110n));
  expect(await c.voucherLines(platformKey(o))).toEqual(platformLines(o, 440n));
});

it('[AC-B2-09h#26] D10-506 ③ 结案后又不一致：部分退款或联盟再结算让金额变了，补充发起时新开一张账单金额不一致差错单（本账单、open、当时的金额，ref_id 是 {order_key}#AMT#{base}:{b_settle}；同一金额状态的两单各开各的），旧单保持已结案、一个字不变，订单保持 WAITING，不入批不记账；同一金额状态重新发起、重新核对都不再开', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const refunded = await example(h);
  const twin = await example(h);
  const resettled = await example(h);
  await billAndClose(h, [refunded, twin, resettled], UNION);
  const concluded = (await state(h)).diffs;
  await newVersion(h, refunded, 2, REFUNDED);
  await newVersion(h, twin, 2, REFUNDED);
  await resettle(h, resettled, 1412n);

  expect((await launchAt(h, 11)).batchIds).toEqual([]);
  const after = await state(h);
  expect(after.diffs).toHaveLength(6);
  expect(after.diffs).toEqual(
    expect.arrayContaining([
      ...concluded,
      openedFor(refunded, 600n, 1100n),
      openedFor(twin, 600n, 1100n),
      openedFor(resettled, 1234n, 1200n),
    ]),
  );
  expect(after.batches).toEqual([]);
  for (const o of [refunded, twin, resettled]) expect(await rebateStatus(h, o)).toBe('WAITING');
  expect(after.vouchers).toEqual([]);
  expect(after.balances).toEqual([]);

  expect((await launchAt(h, 12)).batchIds).toEqual([]);
  expect((await recheckAt(h, 13)).batchIds).toEqual([]);
  expect((await state(h)).diffs).toEqual(after.diffs);
});

it('[AC-B2-09h#27] D10-506 ③ 新单照常可再结案：union 后结论绑新金额 (600, 1100)，当前金额相等即进补充批次、按联盟结算额 1100；新单 ours 的仍不入批；读口两张结论都给，差错单不再增加', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const accepted = await example(h);
  const refused = await example(h);
  await billAndClose(h, [accepted, refused], UNION);
  await newVersion(h, accepted, 2, REFUNDED);
  await newVersion(h, refused, 2, REFUNDED);
  await launchAt(h, 11);
  await closeOpen(h, [accepted], UNION);
  await closeOpen(h, [refused], OURS);
  const concluded = (await state(h)).diffs;

  expect((await launchAt(h, 12)).batchIds).toHaveLength(1);
  const after = await state(h);
  expect(itemsOf(after, supplements(after))).toEqual([
    expect.objectContaining({ order_id: accepted.id, settle_seq: 1, b_settle_fen: 1100n }),
  ]);
  expect(after.diffs).toEqual(concluded);
  const read = await unionConclusions(h.db, h.appId, [accepted.key, refused.key]);
  expect(read.get(accepted.key)).toHaveLength(2);
  expect(read.get(accepted.key)).toEqual(
    expect.arrayContaining([
      { expectedFen: 1234n, actualFen: 1100n },
      { expectedFen: 600n, actualFen: 1100n },
    ]),
  );
  expect(read.get(refused.key)).toEqual([{ expectedFen: 1234n, actualFen: 1100n }]);
});

it('[AC-B2-09h#28] D10-506 ③ 同一金额状态至多一张：以 ours 或不下结论结案后金额变了同样新开；新单结案后重跑不再开；金额回到裸 {order_key} 行的状态也不再开；到新状态才开第三张，各单 ref_id 互不相同', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const ours = await example(h);
  const bare = await example(h);
  await main(h);
  await closeOpen(h, [ours], OURS);
  await closeOpen(h, [bare], NO_OUTCOME);
  await newVersion(h, ours, 2, REFUNDED);
  await newVersion(h, bare, 2, REFUNDED);

  await launchAt(h, 11);
  const opened = (await state(h)).diffs;
  expect(opened).toHaveLength(4);
  expect(opened).toContainEqual(openedFor(ours, 600n, 1100n));
  expect(opened).toContainEqual(openedFor(bare, 600n, 1100n));

  await closeOpen(h, [ours], OURS);
  const reclosed = (await state(h)).diffs;
  await launchAt(h, 12);
  expect((await state(h)).diffs).toEqual(reclosed);

  await newVersion(h, ours, 3, RESTORED);
  await launchAt(h, 13);
  expect((await state(h)).diffs).toEqual(reclosed);

  await newVersion(h, ours, 4, {
    base: 500n,
    n: 588n,
    amounts: [250n, 50n, 25n],
    userTotal: 325n,
  });
  expect((await launchAt(h, 14)).batchIds).toEqual([]);
  const third = (await state(h)).diffs.filter((row) => ofOrder(row, ours.key));
  expect(third).toHaveLength(3);
  expect(third).toContainEqual(openedFor(ours, 500n, 1100n));
  expect(third.map((row) => row.ref_id).sort()).toEqual(
    [ours.key, amountRef(ours.key, 600n, 1100n), amountRef(ours.key, 500n, 1100n)].sort(),
  );
});

it('[AC-B2-09h#29] D10-506 ③ 账单日任务同样：账单日前已结案、金额已变的单新开一张差错单并计入差错、不入批，旧单不变；金额没变的已结案 union 单入批，不重复开', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const f = reconOf(h);
  const stale = await settled(h, 2000n);
  const same = await settled(h, 2000n);
  const seeded = [
    await unionDiff(f, {
      period: MONTH,
      ref_id: stale.key,
      expected_fen: 850n,
      actual_fen: 1500n,
      diff_fen: -650n,
    }),
    await unionDiff(f, {
      period: MONTH,
      ref_id: same.key,
      expected_fen: 850n,
      actual_fen: 1700n,
      diff_fen: -850n,
    }),
  ];

  await main(h);
  const after = await state(h);
  expect(after.items.map((item) => item.order_id)).toEqual([same.id]);
  expect(after.diffs).toHaveLength(3);
  expect(after.diffs).toEqual(expect.arrayContaining([...seeded, openedFor(stale, 850n, 1700n)]));
  expect(after.bills).toEqual([expect.objectContaining({ error_count: 1, held_count: 0 })]);
  expect(await rebateStatus(h, stale)).toBe('WAITING');

  // Back on the bill day, for the job's asset snapshot of the day before.
  h.clock.set(NOW);
  expect((await h.run()).outcome).toBe('duplicate');
  expect((await h.run('taobao', new Date('2032-07-24T02:00:00+08:00'))).outcome).toBe('duplicate');
  expect((await state(h)).diffs).toEqual(after.diffs);
});

it('[AC-B2-09h#34] 金额 A→B→A 不重开：回到开过单的金额时差错单不再增加，该金额的 union 结论重新适用、按联盟结算额入批（中间状态的单以 ours 结案或还开着都一样，原样不动）；停在 B、B 上 ours 的单不入批', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const back = await example(h);
  const pending = await example(h);
  const stays = await example(h);
  await billAndClose(h, [back, pending, stays], UNION);
  for (const o of [back, pending, stays]) await newVersion(h, o, 2, REFUNDED);
  await launchAt(h, 11);
  await closeOpen(h, [back, stays], OURS);
  const middle = (await state(h)).diffs;
  expect(middle).toHaveLength(6);
  expect(middle).toContainEqual(openedFor(pending, 600n, 1100n));
  await newVersion(h, back, 3, RESTORED);
  await newVersion(h, pending, 3, RESTORED);

  expect((await launchAt(h, 12)).batchIds).toHaveLength(1);
  const after = await state(h);
  const items = itemsOf(after, supplements(after));
  expect(items).toHaveLength(2);
  expect(items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ order_id: back.id, settle_seq: 1, b_settle_fen: 1100n }),
      expect.objectContaining({ order_id: pending.id, settle_seq: 1, b_settle_fen: 1100n }),
    ]),
  );
  expect(after.diffs).toEqual(middle);
  expect(await rebateStatus(h, stays)).toBe('WAITING');
});

it('[AC-B2-09h#35] 账单日任务：多张差错单都匹配当前金额时取最近结案、有 outcome 的那张（closed_at 倒序，不看账单月先后；跨账单、#AMT# 行同理）：后结案的 ours 取消、后结案的 union 生效、后结案无 outcome 的不算数；取消后本账单开首张裸行', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const f = reconOf(h);
  const conclude = (
    o: Order,
    period: string,
    minutes: number,
    resolution: Resolution,
    refId = o.key,
  ) =>
    unionDiff(f, {
      period,
      ref_id: refId,
      expected_fen: 850n,
      actual_fen: 1700n,
      diff_fen: -850n,
      closed_at: ago(f, minutes),
      resolution,
    });
  const overruled = await settled(h, 2000n);
  await conclude(overruled, '2032-04', 30, UNION);
  await conclude(overruled, OTHER_BILL, 20, OURS);
  const upheld = await settled(h, 2000n);
  await conclude(upheld, '2032-04', 30, OURS);
  await conclude(upheld, OTHER_BILL, 20, UNION);
  const silent = await settled(h, 2000n);
  await conclude(silent, '2032-04', 30, UNION);
  await conclude(silent, OTHER_BILL, 20, NO_OUTCOME);
  const earlierBill = await settled(h, 2000n);
  await conclude(earlierBill, OTHER_BILL, 30, OURS);
  await conclude(earlierBill, '2032-04', 20, UNION);
  const onAmountRow = await settled(h, 2000n);
  await conclude(onAmountRow, '2032-04', 30, OURS);
  await conclude(onAmountRow, OTHER_BILL, 20, UNION, amountRef(onAmountRow.key, 850n, 1700n));
  const offAmountRow = await settled(h, 2000n);
  await conclude(offAmountRow, '2032-04', 30, UNION);
  await conclude(offAmountRow, OTHER_BILL, 20, OURS, amountRef(offAmountRow.key, 850n, 1700n));
  const before = await allDiffs(f);

  await main(h);
  const after = await state(h);
  expect(after.items.map((item) => item.order_id).sort()).toEqual(
    [upheld.id, silent.id, earlierBill.id, onAmountRow.id].sort(),
  );
  for (const item of after.items) expect(item.b_settle_fen).toBe(1700n);
  const results = (await billValidations(h)).map((v) => [v.orderKey, v.result]).sort();
  expect(results).toEqual(
    [
      [upheld.key, 'candidate'],
      [silent.key, 'candidate'],
      [earlierBill.key, 'candidate'],
      [onAmountRow.key, 'candidate'],
      [overruled.key, 'amount_mismatch'],
      [offAmountRow.key, 'amount_mismatch'],
    ].sort(),
  );
  expect(after.bills).toEqual([expect.objectContaining({ error_count: 2, held_count: 0 })]);
  expect(after.diffs).toHaveLength(before.length + 2);
  expect(after.diffs).toEqual(
    expect.arrayContaining([
      ...before,
      firstFor(overruled, 850n, 1700n),
      firstFor(offAmountRow, 850n, 1700n),
    ]),
  );
});

it('[AC-B2-09h#36] 账单日任务的新开条件只看本账单本单：别的账单月金额相等的单不算已有，本账单首张是裸 {order_key} 行、裸行被占才带金额指纹；order_key 互为前缀的别单不算已有，它的 union 结论也不算本单的', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const f = reconOf(h);
  const concluded = (refId: string, period: string, actualFen: bigint, resolution: Resolution) =>
    unionDiff(f, {
      period,
      ref_id: refId,
      expected_fen: 850n,
      actual_fen: actualFen,
      diff_fen: subFen(850n, actualFen),
      resolution,
    });
  const elsewhere = await settled(h, 2000n);
  await concluded(elsewhere.key, OTHER_BILL, 1700n, OURS);
  const taken = await settled(h, 2000n);
  await concluded(taken.key, MONTH, 1500n, OURS);
  await concluded(amountRef(taken.key, 850n, 1700n), OTHER_BILL, 1700n, OURS);
  const cousin = await settled(h, 2000n);
  const cousinKey = `${cousin.key}0`;
  await concluded(cousinKey, MONTH, 1700n, UNION);
  await concluded(amountRef(cousinKey, 850n, 1700n), OTHER_BILL, 1700n, UNION);
  const crowded = await settled(h, 2000n);
  await concluded(crowded.key, MONTH, 1500n, OURS);
  await concluded(amountRef(`${crowded.key}0`, 850n, 1700n), MONTH, 1700n, OURS);
  const before = await allDiffs(f);

  await main(h);
  const after = await state(h);
  expect(after.batches).toEqual([]);
  expect(after.bills).toEqual([expect.objectContaining({ error_count: 4, held_count: 0 })]);
  expect(after.diffs).toHaveLength(before.length + 4);
  expect(after.diffs).toEqual(
    expect.arrayContaining([
      ...before,
      firstFor(elsewhere, 850n, 1700n),
      openedFor(taken, 850n, 1700n),
      firstFor(cousin, 850n, 1700n),
      openedFor(crowded, 850n, 1700n),
    ]),
  );
});

it('[AC-B2-09h#37] 账单日任务的新开条件看本账单该单的任何差错单：open / processing / written_off 的单金额等于当前不开，裸行或 #AMT# 行任一张等于当前不开（A→B→A 同样）；全都不等才开，裸行还开着也一样，旧单不动', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const f = reconOf(h);
  const diffOf = (refId: string, actualFen: bigint, patch: DiffSeed = {}) =>
    r1Diff(f, {
      period: MONTH,
      ref_id: refId,
      expected_fen: 850n,
      actual_fen: actualFen,
      diff_fen: subFen(850n, actualFen),
      ...patch,
    });
  const closedOurs = { status: 'closed', closed_at: ago(f, 5), resolution: OURS };
  const stale = await settled(h, 2000n);
  await diffOf(stale.key, 1500n);
  const processing = await settled(h, 2000n);
  await diffOf(processing.key, 1700n, { status: 'processing' });
  const written = await settled(h, 2000n);
  await diffOf(written.key, 1700n, { status: 'written_off', closed_at: ago(f, 5) });
  const onAmountRow = await settled(h, 2000n);
  await diffOf(onAmountRow.key, 1500n, closedOurs);
  await diffOf(amountRef(onAmountRow.key, 850n, 1700n), 1700n, closedOurs);
  const returned = await settled(h, 2000n);
  await diffOf(returned.key, 1700n, closedOurs);
  await diffOf(amountRef(returned.key, 850n, 1500n), 1500n, closedOurs);
  const before = await allDiffs(f);

  await main(h);
  const after = await state(h);
  expect(after.batches).toEqual([]);
  expect(after.bills).toEqual([expect.objectContaining({ error_count: 5, held_count: 0 })]);
  expect(after.diffs).toHaveLength(before.length + 1);
  expect(after.diffs).toEqual(expect.arrayContaining([...before, openedFor(stale, 850n, 1700n)]));
});

it('[AC-B2-09h#38] 补充发起同样取最近结案、有 outcome 的那张：本账单结案后别的账单又结案同金额的单时听后者（ours 取消、union 生效），后结案无 outcome 的不算数；本账单已有该金额的单，差错单不增加', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const f = reconOf(h);
  const overruled = await example(h);
  const upheld = await example(h);
  const silent = await example(h);
  await main(h);
  await closeOpen(h, [overruled, silent], UNION);
  await closeOpen(h, [upheld], OURS);
  const later = (o: Order, resolution: Resolution) =>
    unionDiff(f, { period: OTHER_BILL, ref_id: o.key, closed_at: AFTER_CLOSE, resolution });
  await later(overruled, OURS);
  await later(upheld, UNION);
  await later(silent, NO_OUTCOME);
  const concluded = (await state(h)).diffs;

  expect((await launchAt(h, 11)).batchIds).toHaveLength(1);
  const after = await state(h);
  const items = itemsOf(after, supplements(after));
  expect(items).toHaveLength(2);
  expect(items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ order_id: upheld.id, settle_seq: 1, b_settle_fen: 1100n }),
      expect.objectContaining({ order_id: silent.id, settle_seq: 1, b_settle_fen: 1100n }),
    ]),
  );
  const results = (await validations(h)).map((v) => [v.orderKey, v.result]).sort();
  expect(results).toEqual(
    [
      [upheld.key, 'candidate'],
      [silent.key, 'candidate'],
      [overruled.key, 'amount_mismatch'],
    ].sort(),
  );
  expect(after.diffs).toEqual(concluded);
});

it('[AC-B2-09h#39] 补充发起的新开条件：裸行还开着也按当前金额新开，旧单不动；order_key 互为前缀的别单、别的账单月的同金额单都不算已有；本账单已有该金额的 #AMT# 行不开', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  const f = reconOf(h);
  const stale = await example(h);
  const cousin = await example(h);
  const elsewhere = await example(h);
  const same = await example(h);
  await main(h);
  await closeOpen(h, [cousin, elsewhere, same], OURS);
  await unionDiff(f, {
    ...amountDiff(`${cousin.key}0`, 600n, 1100n),
    period: MONTH,
    resolution: OURS,
  });
  await unionDiff(f, {
    ...amountDiff(elsewhere.key, 600n, 1100n),
    period: OTHER_BILL,
    resolution: OURS,
  });
  await unionDiff(f, { ...amountDiff(same.key, 600n, 1100n), period: MONTH, resolution: OURS });
  for (const o of [stale, cousin, elsewhere, same]) await newVersion(h, o, 2, REFUNDED);
  const before = (await state(h)).diffs;

  expect((await launchAt(h, 11)).batchIds).toEqual([]);
  const after = (await state(h)).diffs;
  expect(after).toHaveLength(before.length + 3);
  expect(after).toEqual(
    expect.arrayContaining([
      ...before,
      openedFor(stale, 600n, 1100n),
      openedFor(cousin, 600n, 1100n),
      openedFor(elsewhere, 600n, 1100n),
    ]),
  );
});

it('[AC-B2-09h#40] D10-507 ② 差错单 diff_fen = expected_fen − actual_fen：账单日任务与补充发起登记的账单金额不一致，联盟少结（expected 1234、actual 1100）diff_fen 为 134，联盟多结（expected 850、actual 1700）为 -850', async () => {
  const h = billingFixture(s.db());
  productionSource(h);
  /** `o` with a settlement that arrives after the bill: the supplement finds its mismatch. */
  const late = async (o: Order, fen: bigint): Promise<Order> => {
    await storeOrder(h, o);
    await settlement(h, o, { settle_commission_fen: fen, created_at: new Date(LATER) });
    return o;
  };
  const mismatches = async () =>
    (await state(h)).diffs.filter((row) => row.type === 'settle_amount_mismatch');
  const under = await example(h);
  const over = await settled(h, 2000n);
  const lateUnder = await late(await order(h, {}, 'taobao', EXAMPLE), 1295n);
  const lateOver = await late(await order(h), 2000n);
  const billDay = [
    expect.objectContaining({
      ref_id: under.key,
      expected_fen: 1234n,
      actual_fen: 1100n,
      diff_fen: 134n,
    }),
    expect.objectContaining({
      ref_id: over.key,
      expected_fen: 850n,
      actual_fen: 1700n,
      diff_fen: -850n,
    }),
  ];

  await main(h);
  const billed = await mismatches();
  expect(billed).toHaveLength(2);
  expect(billed).toEqual(expect.arrayContaining(billDay));

  expect((await h.launch()).batchIds).toEqual([]);
  const launched = await mismatches();
  expect(launched).toHaveLength(4);
  expect(launched).toEqual(
    expect.arrayContaining([
      ...billDay,
      expect.objectContaining({
        ref_id: lateUnder.key,
        expected_fen: 1234n,
        actual_fen: 1100n,
        diff_fen: 134n,
      }),
      expect.objectContaining({
        ref_id: lateOver.key,
        expected_fen: 850n,
        actual_fen: 1700n,
        diff_fen: -850n,
      }),
    ]),
  );
});
