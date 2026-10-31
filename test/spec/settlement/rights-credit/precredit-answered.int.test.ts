// B2-04lb rule tests, money r1 S0 (编排裁定 D10-483: order_rights.answered_at). Before credit, a
// successful partial rights deduction counts once: when the union sends its updated commission (a
// new estimate on the order sync, or a new settlement record) that already carries the deduction,
// the record is answered (answered_at set on the sync transaction, the clock's now) and is never
// subtracted again; only the deductions with answered_at empty are subtracted (D10-474 ①,
// BR-CALC-15 the union's commission wins, BR-FUND-08 ② N_new = effective − 应扣佣金).
//   S0 counterexample: est 1000; A (应扣 500) → R7, N_new 500; the union's new estimate 500 answers
//   A; B (应扣 100) → N_new = 500 − 100 = 400, R7, still ESTIMATED. Counting A again gives
//   500 − 600 < 0 → R6 VOID (order.invalidated): the wrong answer.
// Each record and union sync is on a strictly later clock instant (and occurred_at).
//
// ESTIMATED order (rights-credit kit), est_commission_fen 1000, reserve 1500, self 5000 / direct
// 1000 / indirect 500 bp, all normal; commission's valuation port is the kit's test double, given
// the bases a real valuation returns (B = floor(N × 8500 / 10000)): 1000 → 850, 500 → 425,
// 400 → 340, 450 → 382. Its input carries the N_new of the R7 (estAfter before a settlement
// record, settleCommissionFen after one), which is how N_new is observed before credit.
//   Credit at N 400 → B 340, reserve 60 → 170 / 34 / 17, platform 119 + 60 = 179; receivable 400.
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  lockOrderKey,
  type OrderStatusSource,
  type OrderUpdateChange,
} from '../../../../apps/api/src/modules/orders/index.ts';
import {
  ESTIMATED,
  LATER,
  NOW,
  TIMEOUT,
  databaseFixture,
  harness,
  type Harness,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** Instants after LATER, in order. */
const T3 = '2032-07-27T10:00:00+08:00';
const T4 = '2032-07-28T10:00:00+08:00';
const T5 = '2032-07-29T10:00:00+08:00';
const T6 = '2032-07-30T10:00:00+08:00';

const AT_400 = { base: 340n, n: 400n, self: 170n, direct: 34n, indirect: 17n, platform: 179n };

interface Answered {
  readonly id: string;
  readonly answered_at: Date | null;
}

/**
 * answered_at of the order's rights rows, by id. The column is checked first (an assertion), so
 * the case fails on an assertion, not on SQL naming a missing column.
 */
async function answeredOf(
  db: Kysely<DB>,
  h: Harness,
  o: SeededOrder,
): Promise<Map<string, Date | null>> {
  const column = await sql<{ name: string }>`
    SELECT a.attname::text AS name FROM pg_attribute a
    WHERE a.attrelid = to_regclass('app.order_rights') AND a.attname = 'answered_at'
      AND NOT a.attisdropped`.execute(db);
  expect(column.rows, 'app.order_rights.answered_at').toEqual([{ name: 'answered_at' }]);
  const rows = await sql<Answered>`
    SELECT id, answered_at FROM app.order_rights
    WHERE app_id = ${h.appId} AND order_id = ${o.orderId}`.execute(db);
  return new Map(rows.rows.map((r): [string, Date | null] => [r.id, r.answered_at]));
}

/** The id of the order's rights row with platform_rights_no `rightsNo`. */
async function rightsId(h: Harness, o: SeededOrder, rightsNo: string): Promise<string> {
  const row = (await h.rightsRows(o)).find((r) => r.platform_rights_no === rightsNo);
  expect(row, rightsNo).toBeDefined();
  return row?.id ?? '';
}

/** A rights success with `deductionFen` recorded at `at` (clock and occurred_at). */
async function deductAt(
  h: Harness,
  o: SeededOrder,
  at: string,
  deductionFen: bigint,
  rightsNo: string,
): Promise<void> {
  h.clock.set(at);
  const result = await h.record(o, { deductionFen, rightsNo, occurredAt: new Date(at) });
  expect(result).toEqual({ kind: 'applied' });
}

/**
 * The order sync of the platform's「确认收货」(PAID → RECEIVED, received_at within the seeded
 * period) at `at`: orders' column update and rebate.onUpdated on one transaction (R4 → WAITING).
 */
async function receiveAt(db: Kysely<DB>, h: Harness, o: SeededOrder, at: string): Promise<void> {
  h.clock.set(at);
  await db.transaction().execute(async (trx) => {
    await lockOrderKey(trx, o.platform, o.subOrderId);
    const before = await trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .where('attr_at', '=', o.attrAt)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('orders')
      .set({
        platform_status: 'RECEIVED',
        received_at: o.attrAt,
        row_version: before.row_version + 1,
        updated_at: h.clock.now(),
      })
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .where('attr_at', '=', o.attrAt)
      .execute();
    const change: OrderUpdateChange = {
      app_id: h.appId,
      order_id: o.orderId,
      attr_at: before.attr_at,
      from_status: before.platform_status,
      to_status: 'RECEIVED',
      rule: null,
      received_at: o.attrAt,
      est_before: before.est_commission_fen,
      est_after: before.est_commission_fen,
      settle_commission_fen: before.settle_commission_fen,
      attributed_now: false,
    };
    const source: OrderStatusSource = { event: 'PLATFORM_RECEIVED', raw_status: 'synthetic' };
    await h.rebate.onUpdated(trx, change, source);
  });
}

/**
 * The S0 counterexample up to B: est 1000, A (应扣 500) at NOW, the union's new estimate 500 at
 * LATER (answers A), B (应扣 100) at T3. Returns the ids of A and B.
 */
async function absorbedThenB(
  h: Harness,
  o: SeededOrder,
): Promise<{ a: string; b: string; published: number }> {
  h.estimateBases.mockResolvedValueOnce({ before: 850n, after: 425n });
  await deductAt(h, o, NOW, 500n, 'rights-n1');
  expect(h.estimateBases).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ estBefore: 1000n, estAfter: 500n }),
  );
  expect(await h.read(o)).toMatchObject({
    rebate_status: 'ESTIMATED',
    reason: null,
    rights_pending: false,
  });

  h.clock.set(LATER);
  h.estimateBases.mockResolvedValueOnce({ before: 850n, after: 425n });
  await h.syncBeforeCredit(o, { event: 'PLATFORM_PAID', estAfter: 500n });
  expect(await h.read(o)).toMatchObject({
    rebate_status: 'ESTIMATED',
    reason: null,
    est_commission_fen: 500n,
    settle_commission_fen: null,
  });

  const published = h.publish.mock.calls.length;
  h.estimateBases.mockResolvedValueOnce({ before: 425n, after: 340n });
  await deductAt(h, o, T3, 100n, 'rights-n2');
  const a = await rightsId(h, o, 'rights-n1');
  const b = await rightsId(h, o, 'rights-n2');
  return { a, b, published };
}

/** The ESTIMATED order of these cases: no settlement record, est_commission_fen 1000. */
function estimatedOrder(h: Harness): Promise<SeededOrder> {
  return h.order({ ...ESTIMATED, patch: { ...ESTIMATED.patch, est_commission_fen: 1000n } });
}

it(
  '[AC-B2-04lb#25] money r1 S0 / D10-483：预估单 est 1000，维权 A（SUCCEEDED、应扣 500）→ R7、N_new 500；联盟同步把 est 改为 500（吸收 A，同一同步事务 A.answered_at 置为当时时刻）；维权 B（应扣 100）→ N_new = 500 − 100 = 400（估值端口收到 estAfter 400）、R7、仍 ESTIMATED、原因码为空、不置 VOID、不发 order.invalidated、不写凭证；B.answered_at 为空；不是把 A 再扣一次的 500 − 600 → 作废',
  async () => {
    const h = await harness(p.db);
    const o = await estimatedOrder(h);
    const { a, b, published } = await absorbedThenB(h, o);

    expect(await h.read(o)).toMatchObject({
      rebate_status: 'ESTIMATED',
      reason: null,
      rights_pending: false,
      est_commission_fen: 500n,
      booked_base_fen: null,
    });
    expect(h.estimateBases).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ estBefore: 500n, estAfter: 400n }),
    );
    expect(h.publishedSince(published)).not.toContain('order.invalidated');
    const voided = (await h.history(o)).filter(
      (r) => r.field === 'rebate' && r.to_status === 'VOID',
    );
    expect(voided).toEqual([]);
    expect(await h.orderVoucherKeys(o)).toEqual([]);
    expect((await h.rightsRows(o)).map((r) => r.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);

    const answered = await answeredOf(p.db, h, o);
    expect(answered.get(a), 'A answered by the new estimate').toEqual(new Date(LATER));
    expect(answered.get(b), 'B not answered yet').toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#26] money r1 S0 / D10-483 续：同上 A 被新预估 500 回应、B（应扣 100）未回应；确认收货 R4 → WAITING；确认收货不置位 B；联盟新结算记录 450（seq 1）到来的同步事务把 B.answered_at 置为当时时刻（A 仍已回应）；之后维权 C（应扣 50）→ N_new = 450 − 50 = 400（估值端口收到 settleCommissionFen 400），C.answered_at 为空；月结入账只扣 answered_at 为空的 C：N 400 → B 340，三人 170 / 34 / 17、平台 179，应收 400，booked 340 / 400；不是 450、不是 450 − 150 = 300、也不是 450 − 650 → 作废',
  async () => {
    const h = await harness(p.db);
    const o = await estimatedOrder(h);
    const { a, b } = await absorbedThenB(h, o);
    expect(await h.read(o)).toMatchObject({ rebate_status: 'ESTIMATED', reason: null });

    await receiveAt(p.db, h, o, T4);
    expect(await h.read(o)).toMatchObject({ rebate_status: 'WAITING', reason: null });
    // 确认收货 carries no union commission: B is still not answered.
    expect((await answeredOf(p.db, h, o)).get(b), 'B after receipt').toBeNull();

    h.clock.set(T5);
    h.estimateBases.mockResolvedValueOnce({ before: 340n, after: 382n });
    await h.syncBeforeCredit(o, { event: 'PLATFORM_SETTLED', settleAfter: 450n, newSeq: 1 });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      reason: null,
      rights_pending: false,
      settle_commission_fen: 450n,
    });
    const settled = await answeredOf(p.db, h, o);
    expect(settled.get(a), 'A stays answered').not.toBeNull();
    expect(settled.get(b), 'B answered by the settlement record').toEqual(new Date(T5));

    h.estimateBases.mockResolvedValueOnce({ before: 382n, after: 340n });
    await deductAt(h, o, T6, 50n, 'rights-n3');
    expect(h.estimateBases).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ settleCommissionFen: 400n }),
    );
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      reason: null,
      rights_pending: false,
    });
    const c = await rightsId(h, o, 'rights-n3');
    const open = await answeredOf(p.db, h, o);
    expect(open.get(c), 'C not answered').toBeNull();
    expect(open.get(b)).toEqual(new Date(T5));

    expect(await h.creditAt(o, 1)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 340n,
      bookedNFen: 400n,
      platformCreditFen: 179n,
    });
    await h.expectCredited(o, AT_400);
  },
  TIMEOUT,
);
