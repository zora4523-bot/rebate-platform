// B2-04lb rule tests ② (D10-463): a CREDITED order that already has a settlement record, whose rights
// success came without 应扣佣金 (BR-FUND-08 ③: no clawback, record WAIT_COMMISSION, order pending).
// With settle_commission_fen set, the union's new commission is only a new settlement record
// (BR-FUND-08 ①「结算佣金非空时只认新的结算记录（BR-FUND-09 的 seq 变化）」); an estimate-only change
// does not answer the record. The new record arrives through the CREDITED order's sync hook (the
// clawback's onUpdated; BR-FUND-09 ①「在写入该 settle_commission_fen 的同一事务内」) and, in that same
// transaction, brings the order to the new commission and closes the WAIT_COMMISSION record
// (BR-FUND-06「等联盟回传新佣金后按 R7/R9 处理并关闭」). Whether the money moves as an R9 CLAWBACK or an
// R10 SETTLE_ADJUST (BR-FUND-08「联盟新的结算记录带来的变化按 BR-FUND-09 与迁移 R10 处理」) is not
// pinned here (待编排裁定): only the resulting nets, receivable and booked pair are.
//
// Default order (credit kit), credited at N 1000: B 850 → 425 / 85 / 42, platform 448, receivable
// 1000. New record 600 → B 510 → nets 255 / 51 / 25, receivable 600, booked 510 / 600.
// New record 700 → B 595 → nets 297 / 59 / 29, receivable 700, booked 595 / 700.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { LATER, TIMEOUT, databaseFixture, harness, type Harness, type SeededOrder } from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** A credited default order whose rights success (no deduction) waits for the union commission. */
async function waitingCredited(h: Harness): Promise<{ o: SeededOrder; waitingId: string }> {
  const o = await h.credited();
  expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
  const waiting = await h.onlyRights(o);
  expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });
  expect(await h.pendingRows(o)).toEqual([
    expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'open' }),
  ]);
  await h.expectNets(o, { base: 850n, n: 1000n, self: 425n, direct: 85n, indirect: 42n });
  return { o, waitingId: waiting.id };
}

it(
  '[AC-B2-04lb#10] 已有结算记录的入账订单维权成功后 WAIT_COMMISSION：只变预估的同步不关闭记录、不动钱；联盟新结算记录 600（seq 3）经订单同步进来 → 同事务按新佣金调到 255 / 51 / 25、应收 600、booked 510 / 600（仍 CREDITED），记录关闭为 SUCCEEDED（id 不变）、rights_pending 回到 false、待处理行 resolved；同一同步重投不再记账；之后同一维权单号再报应扣 400 → duplicate，不二次扣回、什么都不变',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await waitingCredited(h);
    const keysAtCredit = await h.orderVoucherKeys(o);

    // Estimate only: not the union's new commission (settlement record unchanged).
    await h.syncCredited(o, { event: 'PLATFORM_SETTLED', estAfter: 3000n });
    expect(await h.onlyRights(o)).toMatchObject({ id: waitingId, status: 'WAIT_COMMISSION' });
    expect(await h.orderVoucherKeys(o)).toEqual(keysAtCredit);
    await h.expectNets(o, { base: 850n, n: 1000n, self: 425n, direct: 85n, indirect: 42n });

    h.clock.set(LATER);
    const arrival = await h.syncCredited(o, {
      event: 'PLATFORM_SETTLED',
      settleAfter: 600n,
      newSeq: 3,
    });
    await h.expectNets(o, { base: 510n, n: 600n, self: 255n, direct: 51n, indirect: 25n });
    expect(await h.onlyRights(o)).toMatchObject({
      id: waitingId,
      status: 'SUCCEEDED',
      updated_at: new Date(LATER),
    });
    expect((await h.read(o)).rights_pending).toBe(false);
    expect(await h.pendingRows(o)).toEqual([
      expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'resolved' }),
    ]);

    const settled = await h.moneyState(o);
    await h.deliver(arrival.change, arrival.source);
    expect(await h.moneyState(o)).toEqual(settled);

    const closed = await h.everything();
    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'duplicate' });
    expect(await h.everything()).toEqual(closed);
    await h.expectNets(o, { base: 510n, n: 600n, self: 255n, direct: 51n, indirect: 25n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#11] 联盟新结算记录的金额优先（BR-FUND-08 ①，BR-CALC-15）：入账后 WAIT_COMMISSION 期间联盟新结算记录 700（seq 3）→ 按 700 调到 297 / 59 / 29、应收 700、booked 595 / 700，记录关闭为 SUCCEEDED、rights_pending 回到 false',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await waitingCredited(h);

    h.clock.set(LATER);
    await h.syncCredited(o, { event: 'PLATFORM_SETTLED', settleAfter: 700n, newSeq: 3 });
    await h.expectNets(o, { base: 595n, n: 700n, self: 297n, direct: 59n, indirect: 29n });
    expect(await h.onlyRights(o)).toMatchObject({ id: waitingId, status: 'SUCCEEDED' });
    expect((await h.read(o)).rights_pending).toBe(false);
  },
  TIMEOUT,
);
