// B2-04lb rule tests ① (D10-463, overpayment): a partial rights success before credit lowers the
// amount the later monthly credit (R5) books. BR-FUND-06「部分成功 → 按 BR-FUND-08 的新基数取值顺序确定
// B_new（入账前改预估…）」; BR-FUND-08 ① the union's new commission first, ② effective commission −
// 应扣佣金 (below 0 → 0); BR-CALC-15 (the union's updated commission wins, never our own estimate).
//
// Default order (credit kit): WAITING, platform SETTLED, settle_commission_fen 1000 on seqs 1 / 2
// (est 3222 a decoy), reserve 1500, self 5000 / direct 1000 / indirect 500 bp, all normal.
//   N 1000 → B 850, reserve 150 → 425 / 85 / 42, platform 298 + 150 = 448 (the overpayment).
//   N  600 → B 510, reserve  90 → 255 / 51 / 25, platform 179 +  90 = 269; receivable 600.
//   N  700 → B 595, reserve 105 → 297 / 59 / 29, platform 210 + 105 = 315; receivable 700.
// Reserve 0, N 1 → B 1 → 0 / 0 / 0, platform 1; receivable 1.
// commission's valuation port is the kit's test double: each call is given the bases a real
// valuation would return, so R7 (not BASE_ZERO) runs as in production.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { LATER, TIMEOUT, databaseFixture, harness, receivable } from './kit.ts';

const p = databaseFixture(createTestDatabase);

const AT_600 = { base: 510n, n: 600n, self: 255n, direct: 51n, indirect: 25n, platform: 269n };
const AT_700 = { base: 595n, n: 700n, self: 297n, direct: 59n, indirect: 29n, platform: 315n };

it(
  '[AC-B2-04lb#1] 反例「结算佣金 1000、维权扣 400 不得按 1000 入账」：入账前维权部分成功（应扣佣金 400，SUCCEEDED）后月结入账按 N = 1000 − 400 = 600：B 510，三人 255 / 51 / 25、平台 269，应收 600，booked 510 / 600，order.credited 带 510；不是 850 / 425 / 85 / 42 / 448',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    h.estimateBases.mockResolvedValueOnce({ before: 850n, after: 510n });
    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({
      status: 'SUCCEEDED',
      deduction_commission_fen: 400n,
    });
    expect(await h.read(o)).toMatchObject({ rebate_status: 'WAITING', rights_pending: false });

    expect(await h.creditAt(o)).toMatchObject({
      outcome: 'credited',
      orderKey: o.orderKey,
      bCreditFen: 510n,
      bookedNFen: 600n,
      platformCreditFen: 269n,
    });
    await h.expectCredited(o, AT_600);
    expect(h.publish).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: 'order.credited',
        payload: expect.objectContaining({ order_id: o.orderId, booked_base_fen: '510' }),
      }),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#2] 应扣数只扣在它所对的联盟佣金上（BR-FUND-08 ① 先于 ②，BR-CALC-15）：A 单维权扣 400 后无新结算记录 → 按 600 入账；B 单维权扣 400 后联盟回传新结算记录 700（seq 3，晚于维权）→ 按联盟的 700 入账（B 595，297 / 59 / 29、平台 315，应收 700），不再扣 400、也不按 1000',
  async () => {
    const h = await harness(p.db);
    const a = await h.order();
    const b = await h.order();
    h.estimateBases
      .mockResolvedValueOnce({ before: 850n, after: 510n })
      .mockResolvedValueOnce({ before: 850n, after: 510n })
      .mockResolvedValueOnce({ before: 510n, after: 595n });
    expect(await h.record(a, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    expect(await h.record(b, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    h.clock.set(LATER);
    await h.syncBeforeCredit(b, { event: 'PLATFORM_SETTLED', settleAfter: 700n, newSeq: 3 });
    expect(await h.read(b)).toMatchObject({
      rebate_status: 'WAITING',
      settle_commission_fen: 700n,
      rights_pending: false,
    });

    expect(await h.creditAt(a)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 510n,
      bookedNFen: 600n,
    });
    await h.expectCredited(a, AT_600);
    expect(await h.creditAt(b, 3)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 595n,
      bookedNFen: 700n,
      platformCreditFen: 315n,
    });
    await h.expectCredited(b, AT_700);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#3] 入账前 WAIT_COMMISSION 后平台用同一维权单号给出应扣佣金 400：记录关闭为 SUCCEEDED、rights_pending 回到 false，之后月结入账按 600（255 / 51 / 25、平台 269、booked 510 / 600），不按 1000',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const waiting = await h.onlyRights(o);
    expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });
    expect(await h.creditAt(o)).toEqual({ outcome: 'skipped', reason: 'rights_pending' });

    h.estimateBases.mockResolvedValueOnce({ before: 850n, after: 510n });
    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({
      id: waiting.id,
      status: 'SUCCEEDED',
      deduction_commission_fen: 400n,
    });
    expect((await h.read(o)).rights_pending).toBe(false);

    expect(await h.creditAt(o)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 510n,
      bookedNFen: 600n,
      platformCreditFen: 269n,
    });
    await h.expectCredited(o, AT_600);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#4] 全额 / 部分分界的部分一侧（预留 0，结算佣金 1000，应扣 999）：入账按 N 1 → B 1，三人份额 floor 后都为 0（不写受益人凭证），只有平台 1；应收 1，booked 1 / 1',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ reserveBp: 0 });
    h.estimateBases.mockResolvedValueOnce({ before: 1000n, after: 1n });
    expect(await h.record(o, { deductionFen: 999n })).toEqual({ kind: 'applied' });
    expect(await h.read(o)).toMatchObject({ rebate_status: 'WAITING', rights_pending: false });

    expect(await h.creditAt(o)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 1n,
      bookedNFen: 1n,
      platformCreditFen: 1n,
    });
    await h.expectCredited(o, {
      base: 1n,
      n: 1n,
      self: 0n,
      direct: 0n,
      indirect: 0n,
      platform: 1n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#5] 只扣成功的维权：同一订单先有一条失败（FAILED，平台报过应扣 300）的维权、再有一条成功的部分维权（应扣 400）→ 入账按 1000 − 400 = 600（不是 1000，也不是 1000 − 700 = 300）',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(
      await h.record(o, { status: 'FAILED', deductionFen: 300n, rightsNo: 'rights-f1' }),
    ).toEqual({ kind: 'applied' });
    h.estimateBases.mockResolvedValueOnce({ before: 850n, after: 510n });
    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    expect((await h.rightsRows(o)).map((r) => r.status).sort()).toEqual(['FAILED', 'SUCCEEDED']);

    expect(await h.creditAt(o)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 510n,
      bookedNFen: 600n,
    });
    await h.expectCredited(o, AT_600);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#6] 入账前两次部分维权（不同单号，应扣 400、100）都成功：入账不得多于任何一次单独扣减后的数（只钉上限：booked_n ≤ 600、B ≤ 510、三人各 ≤ 255 / 51 / 25、应收 ≤ 600；累计口径 08 未写明，待编排裁定）',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    h.estimateBases
      .mockResolvedValueOnce({ before: 850n, after: 510n })
      .mockResolvedValueOnce({ before: 510n, after: 425n });
    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    expect(await h.record(o, { deductionFen: 100n, rightsNo: 'rights-n2' })).toEqual({
      kind: 'applied',
    });
    expect(await h.read(o)).toMatchObject({ rebate_status: 'WAITING', rights_pending: false });

    expect(await h.creditAt(o)).toMatchObject({ outcome: 'credited' });
    const row = await h.read(o);
    expect(row.rebate_status).toBe('CREDITED');
    const bookedN = row.booked_n_fen;
    const bookedBase = row.booked_base_fen;
    expect(bookedN !== null && bookedN <= 600n, String(bookedN)).toBe(true);
    expect(bookedBase !== null && bookedBase <= 510n, String(bookedBase)).toBe(true);
    const caps = { self: 255n, direct: 51n, indirect: 25n } as const;
    for (const role of ['self', 'direct', 'indirect'] as const) {
      const balance = await h.balance(o.user(role));
      expect(balance <= caps[role], `${role} ${String(balance)}`).toBe(true);
    }
    const net = await h.orderSubjectNet(o, receivable(o));
    expect(net <= 600n, `receivable ${String(net)}`).toBe(true);
  },
  TIMEOUT,
);
