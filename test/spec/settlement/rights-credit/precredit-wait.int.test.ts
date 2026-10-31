// B2-04lb rule tests ③ (D10-463, underpayment by an order left hanging): before credit, a rights
// success without 应扣佣金 leaves the record WAIT_COMMISSION (BR-FUND-06「仍阻止入账」); once the union
// sends its new commission the record is closed and rights_pending goes back to false in the same
// sync transaction (BR-FUND-06「等联盟回传新佣金后按 R7/R9 处理并关闭」), so the order can be credited.
// The union's new commission is the effective one (BR-CALC-02: settlement first, else estimate):
// with a settlement record only a new settlement record counts (BR-FUND-08 ①); without one, a new
// estimate. A PROCESSING record still waits for the platform's result and stays open.
//
// Default order (credit kit): WAITING, platform SETTLED, settle_commission_fen 1000 on seqs 1 / 2
// (est 3222 a decoy), reserve 1500, self 5000 / direct 1000 / indirect 500 bp, all normal.
//   The union's new record 600 (seq 3) → B 510, reserve 90 → 255 / 51 / 25, platform 269.
// ESTIMATED order (no settlement record): est 3222 → B 2738; new estimate 1800 → B 1530.
// commission's valuation port is the kit's test double (bases as a real valuation would return).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { ESTIMATED, LATER, TIMEOUT, databaseFixture, harness } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04lb#7] 入账前 WAIT_COMMISSION（已有结算记录）：只变预估的同步不算联盟新佣金，记录仍 WAIT_COMMISSION、不能入账；联盟回传新结算记录 600（seq 3）的同步事务内记录关闭为 SUCCEEDED（id 不变）、rights_pending 回到 false、仍 WAITING 不写凭证；之后同一维权单号再报应扣 400 → duplicate；月结入账按 600（255 / 51 / 25、平台 269、booked 510 / 600），不再扣 400',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const waiting = await h.onlyRights(o);
    expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });

    // Estimate only (settlement unchanged, effective base unchanged): not the union's new commission.
    h.estimateBases.mockResolvedValueOnce({ before: 850n, after: 850n });
    await h.syncBeforeCredit(o, { event: 'PLATFORM_SETTLED', estAfter: 3000n });
    expect(await h.onlyRights(o)).toMatchObject({ id: waiting.id, status: 'WAIT_COMMISSION' });
    expect((await h.read(o)).rights_pending).toBe(true);
    expect(await h.creditAt(o)).toEqual({ outcome: 'skipped', reason: 'rights_pending' });

    h.clock.set(LATER);
    h.estimateBases.mockResolvedValueOnce({ before: 850n, after: 510n });
    await h.syncBeforeCredit(o, { event: 'PLATFORM_SETTLED', settleAfter: 600n, newSeq: 3 });
    expect(await h.onlyRights(o)).toMatchObject({
      id: waiting.id,
      status: 'SUCCEEDED',
      updated_at: new Date(LATER),
    });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      reason: null,
      rights_pending: false,
      settle_commission_fen: 600n,
    });
    expect(await h.orderVoucherKeys(o)).toEqual([]);

    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'duplicate' });
    expect(await h.creditAt(o, 3)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 510n,
      bookedNFen: 600n,
      platformCreditFen: 269n,
    });
    await h.expectCredited(o, {
      base: 510n,
      n: 600n,
      self: 255n,
      direct: 51n,
      indirect: 25n,
      platform: 269n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#8] 联盟新佣金只关闭 WAIT_COMMISSION：同一订单另有一条处理中（PROCESSING）的维权，新结算记录 600 到达后 WAIT_COMMISSION 那条关闭为 SUCCEEDED，处理中那条不动，rights_pending 仍为 true，月结入账继续跳过',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    expect(await h.record(o, { status: 'PROCESSING', rightsNo: 'rights-p1' })).toEqual({
      kind: 'applied',
    });
    const before = await h.rightsRows(o);
    const waiting = before.find((r) => r.status === 'WAIT_COMMISSION');
    const processing = before.find((r) => r.status === 'PROCESSING');
    expect(waiting).toBeDefined();
    expect(processing).toBeDefined();

    h.clock.set(LATER);
    h.estimateBases.mockResolvedValueOnce({ before: 850n, after: 510n });
    await h.syncBeforeCredit(o, { event: 'PLATFORM_SETTLED', settleAfter: 600n, newSeq: 3 });
    const after = await h.rightsRows(o);
    expect(after.find((r) => r.id === waiting?.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect(after.find((r) => r.id === processing?.id)).toEqual(processing);
    expect(await h.read(o)).toMatchObject({ rebate_status: 'WAITING', rights_pending: true });
    expect(await h.creditAt(o, 3)).toEqual({ outcome: 'skipped', reason: 'rights_pending' });
    expect(await h.orderVoucherKeys(o)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#9] 入账前 WAIT_COMMISSION（ESTIMATED，无结算记录）：联盟回传新预估 1800（有效联盟佣金 3222 → 1800）的同步事务内记录关闭为 SUCCEEDED（id 不变）、rights_pending 回到 false；仍 ESTIMATED、不作废、不写凭证',
  async () => {
    const h = await harness(p.db);
    const o = await h.order(ESTIMATED);
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const waiting = await h.onlyRights(o);
    expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });
    expect((await h.read(o)).rights_pending).toBe(true);

    h.clock.set(LATER);
    h.estimateBases.mockResolvedValueOnce({ before: 2738n, after: 1530n });
    await h.syncBeforeCredit(o, { event: 'PLATFORM_PAID', estAfter: 1800n });
    expect(await h.onlyRights(o)).toMatchObject({
      id: waiting.id,
      status: 'SUCCEEDED',
      updated_at: new Date(LATER),
    });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'ESTIMATED',
      reason: null,
      rights_pending: false,
      est_commission_fen: 1800n,
    });
    expect(await h.orderVoucherKeys(o)).toEqual([]);
  },
  TIMEOUT,
);
