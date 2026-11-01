// B2-04lb rule tests, D10-474 ① (编排裁定): several partial rights successes before credit.
//   - Before the union sends its updated commission: the deductions of the rights records not yet
//     answered by the union add up (conservative), floor 0 (BR-FUND-08 ②「小于 0 按 0」); a total
//     that reaches the effective commission is the full side (BR-CALC-15「N_new = 0 按整单失效处理
//     （入账前 R6 → VOID）」, BR-FUND-07 RIGHTS).
//   - Once the union sends an updated commission N_new (a new settlement record), N_new replaces the
//     deductions it answers and closes those records (BR-CALC-15: the union's commission wins); only
//     the latest N_new counts, earlier deductions are not subtracted again (不累减).
//   - A deduction recorded after the union's latest N_new is still open and is taken off that N_new.
// Each later record and union record is on a strictly later clock instant (and occurred_at), so
// "before / after the union's record" is unambiguous.
//
// Default order (credit kit): WAITING, platform SETTLED, settle_commission_fen 1000 on seqs 1 / 2
// (est 3222 a decoy), reserve 1500, self 5000 / direct 1000 / indirect 500 bp, all normal.
//   N 500 → B 425, reserve 75 → 212 / 42 / 21, platform 150 + 75 = 225; receivable 500.
//   N 600 → B 510, reserve 90 → 255 / 51 / 25, platform 179 + 90 = 269; receivable 600.
// Reserve 0, N 1 → B 1 → 0 / 0 / 0, platform 1; receivable 1.
// commission's valuation port is the kit's test double (positive bases, so R7 runs, not BASE_ZERO).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { LATER, TIMEOUT, databaseFixture, harness, type Harness, type SeededOrder } from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** Instants after LATER, in order (each later record / union record on its own instant). */
const T3 = '2032-07-27T10:00:00+08:00';
const T4 = '2032-07-28T10:00:00+08:00';
const T5 = '2032-07-29T10:00:00+08:00';

const AT_500 = { base: 425n, n: 500n, self: 212n, direct: 42n, indirect: 21n, platform: 225n };
const AT_600 = { base: 510n, n: 600n, self: 255n, direct: 51n, indirect: 25n, platform: 269n };

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

/** The union's new settlement record `seq` of `amount`, through the order sync, at `at`. */
async function unionRecordAt(
  h: Harness,
  o: SeededOrder,
  at: string,
  seq: number,
  amount: bigint,
): Promise<void> {
  h.clock.set(at);
  await h.syncBeforeCredit(o, { event: 'PLATFORM_SETTLED', settleAfter: amount, newSeq: seq });
}

it(
  '[AC-B2-04lb#15] D10-474 ① 联盟未回传前累计保守扣减：入账前两次部分维权（不同单号，应扣 400、100）都成功、联盟没回传新佣金 → 月结入账按 1000 − 400 − 100 = 500：B 425，三人 212 / 42 / 21、平台 225，应收 500，booked 425 / 500；不是 1000、也不是只扣一次的 600 / 900',
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

    expect(await h.creditAt(o)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 425n,
      bookedNFen: 500n,
      platformCreditFen: 225n,
    });
    await h.expectCredited(o, AT_500);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#16] D10-474 ① 累计扣减下限 0（预留 0，结算佣金 1000）：A 单应扣 600 + 400 = 1000、B 单应扣 600 + 500 = 1100（按 0）→ 第二次维权使有效佣金为 0，按 R6 RIGHTS_FULL 置 VOID（原因码 RIGHTS），发 order.invalidated，不写分录，月结入账跳过（not_waiting）',
  async () => {
    const h = await harness(p.db);
    for (const second of [400n, 500n]) {
      const o = await h.order({ reserveBp: 0 });
      h.estimateBases.mockResolvedValueOnce({ before: 1000n, after: 400n });
      expect(await h.record(o, { deductionFen: 600n })).toEqual({ kind: 'applied' });
      expect((await h.read(o)).rebate_status).toBe('WAITING');
      const published = h.publish.mock.calls.length;

      expect(await h.record(o, { deductionFen: second, rightsNo: 'rights-n2' })).toEqual({
        kind: 'applied',
      });
      expect(await h.read(o), String(second)).toMatchObject({
        rebate_status: 'VOID',
        reason: 'RIGHTS',
        rights_pending: false,
        booked_base_fen: null,
      });
      const voided = (await h.history(o)).filter(
        (r) => r.field === 'rebate' && r.to_status === 'VOID',
      );
      expect(voided).toEqual([
        expect.objectContaining({
          from_status: 'WAITING',
          event: 'RIGHTS_FULL',
          to_status: 'VOID',
        }),
      ]);
      expect(h.publishedSince(published)).toEqual(['order.invalidated']);
      expect(await h.orderVoucherKeys(o)).toEqual([]);
      expect(await h.creditAt(o)).toEqual({ outcome: 'skipped', reason: 'not_waiting' });
      expect(await h.orderVoucherKeys(o)).toEqual([]);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#17] D10-474 ① 累计扣减的部分一侧（预留 0，结算佣金 1000，应扣 600 + 399）：有效佣金 1 > 0 → 不作废，月结入账按 N 1 → B 1，三人 0 / 0 / 0（不写受益人凭证）、平台 1，应收 1，booked 1 / 1；不按 1000 或 400',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ reserveBp: 0 });
    h.estimateBases
      .mockResolvedValueOnce({ before: 1000n, after: 400n })
      .mockResolvedValueOnce({ before: 400n, after: 1n });
    expect(await h.record(o, { deductionFen: 600n })).toEqual({ kind: 'applied' });
    expect(await h.record(o, { deductionFen: 399n, rightsNo: 'rights-n2' })).toEqual({
      kind: 'applied',
    });
    expect(await h.read(o)).toMatchObject({ rebate_status: 'WAITING', reason: null });

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
  '[AC-B2-04lb#18] D10-474 ① 联盟回传后以 N_new 覆盖并关闭相应记录：应扣 400、100 两条之后联盟新结算记录 550（seq 3）→ 两条都被 550 回应；之后再来一条应扣 50 的维权 → 月结入账按 550 − 50 = 500（B 425，212 / 42 / 21、平台 225，应收 500，booked 425 / 500）；不是 550 − 550 = 0（作废）、不是 1000 − 550 = 450、也不是 550',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    h.estimateBases
      .mockResolvedValueOnce({ before: 850n, after: 510n })
      .mockResolvedValueOnce({ before: 510n, after: 425n })
      .mockResolvedValueOnce({ before: 425n, after: 467n })
      .mockResolvedValueOnce({ before: 467n, after: 425n });
    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    expect(await h.record(o, { deductionFen: 100n, rightsNo: 'rights-n2' })).toEqual({
      kind: 'applied',
    });
    await unionRecordAt(h, o, LATER, 3, 550n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      settle_commission_fen: 550n,
      rights_pending: false,
    });

    await deductAt(h, o, T3, 50n, 'rights-n3');
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      reason: null,
      rights_pending: false,
    });
    expect((await h.rightsRows(o)).map((r) => r.status)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
    ]);

    expect(await h.creditAt(o, 3)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 425n,
      bookedNFen: 500n,
      platformCreditFen: 225n,
    });
    await h.expectCredited(o, AT_500);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#19] D10-474 ① 只取最新一次 N_new（不累减）：应扣 400 → 联盟新结算记录 700（seq 3）→ 应扣 100 → 联盟新结算记录 650（seq 4）→ 应扣 50；月结入账按 650 − 50 = 600（B 510，255 / 51 / 25、平台 269，应收 600，booked 510 / 600）；不是 650、不是 650 − 150 = 500、不是 700 − 150 = 550、不是 1000 − 550 = 450',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    h.estimateBases
      .mockResolvedValueOnce({ before: 850n, after: 510n })
      .mockResolvedValueOnce({ before: 510n, after: 595n })
      .mockResolvedValueOnce({ before: 595n, after: 510n })
      .mockResolvedValueOnce({ before: 510n, after: 552n })
      .mockResolvedValueOnce({ before: 552n, after: 510n });
    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    await unionRecordAt(h, o, LATER, 3, 700n);
    await deductAt(h, o, T3, 100n, 'rights-n2');
    await unionRecordAt(h, o, T4, 4, 650n);
    await deductAt(h, o, T5, 50n, 'rights-n3');
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      reason: null,
      settle_commission_fen: 650n,
      rights_pending: false,
    });

    expect(await h.creditAt(o, 4)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 510n,
      bookedNFen: 600n,
      platformCreditFen: 269n,
    });
    await h.expectCredited(o, AT_600);
  },
  TIMEOUT,
);
