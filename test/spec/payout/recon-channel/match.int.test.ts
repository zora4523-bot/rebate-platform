// B2-07c (规划/08 BR-WDR-23 and its 细则; BR-FUND-24): matching and ③. Interface payouts are matched by
// out_biz_no, manual successes (PAID_MANUAL) by channel_order_id; the bill amount is compared with
// net_fen. ③ — the bill shows a success and ours is APPROVED / FAILED / REJECTED or missing, ours is
// PAID_* and the bill has no line, or the amounts differ — gives an R2 channel_mismatch recon diff,
// an alert and, for the member, a withdraw hold recon_diff that never expires by itself; an APPROVED
// withdrawal returned by W9 after a payer-side failure gets the bill line on its diff (W11 is not
// this task). Terminal withdrawals are read only: no status, amount, voucher or balance changes
// (corrections only by diff + adjustment). The withdrawals carry fee and tax (amount_fen ≠ net_fen);
// only a line whose status payout.query_status_map maps to success is "支付宝成功". Top-level it()
// only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BILL_DATE,
  FEE,
  IN_DAY,
  LINE_FAIL,
  LINE_UNKNOWN,
  QUERY_LISTS,
  TAX,
  TIMEOUT,
  alertsAbout,
  allHolds,
  books,
  close,
  diffs,
  diffsOf,
  expectBillLineOn,
  expectDiff,
  expectNoPayeeInLogs,
  expectReconHold,
  holdsOf,
  lineOf,
  open,
  rowsOf,
  setup,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it(
  '[AC-B2-07c#6] 接口打款单按 out_biz_no 一致（有手续费与税，账单金额 = net_fen ≠ amount_fen）：明细 matched（本方 PAID_API / net_fen，账单的 channel_order_id / 状态 / 金额），无差错单、无冻结、无告警',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const w = await f.seedPaid(IN_DAY, { net: 1_234n });
    expect(w.amount).toBe(1_234n + FEE + TAX);
    const line = lineOf(w, { channelOrderId: w.channelOrderId });
    f.setBill(BILL_DATE, [line]);
    const before = await books(f);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(await rowsOf(f, { outBizNo: w.outBizNo })).toEqual([
      {
        app_id: f.appId,
        date: BILL_DATE,
        bill_date: BILL_DATE,
        out_biz_no: w.outBizNo,
        channel_order_id: line.channelOrderId,
        our_status: 'PAID_API',
        channel_status: 'SUCCESS',
        our_amount_fen: 1_234n,
        channel_amount_fen: 1_234n,
        result: 'matched',
      },
    ]);
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
    expect(alertsAbout(f, [w.id, w.outBizNo, line.channelOrderId])).toEqual([]);
    expect(await books(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#6] 手动成功单（PAID_MANUAL，账单行没有我方单号）按 channel_order_id 一致：明细 matched，无差错单、无冻结',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const w = await f.seedManual(IN_DAY, { net: 5_000n });
    const line = lineOf(w, { outBizNo: null, channelOrderId: w.channelOrderId });
    f.setBill(BILL_DATE, [line]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    const rows = await rowsOf(f, { channelOrderId: w.channelOrderId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: BILL_DATE,
      bill_date: BILL_DATE,
      channel_order_id: w.channelOrderId,
      our_status: 'PAID_MANUAL',
      our_amount_fen: 5_000n,
      channel_amount_fen: 5_000n,
      result: 'matched',
    });
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
  },
  TIMEOUT,
);

it.each([['FAILED'], ['REJECTED']] as const)(
  '[AC-B2-07c#7] ③ 重复打款：内部 %s（已退回），账单显示成功 → R2 channel_mismatch 差错单（本方 0、账单 net），告警，为该会员新增 recon_diff 冻结（不自动到期）；终态单状态、金额、分录、余额都不变',
  async (status) => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser();
    const w = await f.seedWithdrawal({ status, net: 10_000n, fee: FEE, tax: TAX, userId: owner });
    const line = lineOf(w);
    f.setBill(BILL_DATE, [line]);
    const before = await books(f);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    const found = await diffs(f);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 0n,
      actualFen: 10_000n,
    });
    await expectReconHold(f, owner, found[0]);
    expect(alertsAbout(f, [w.id, w.outBizNo]).length).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(f, { outBizNo: w.outBizNo })).toEqual([
      expect.objectContaining({
        bill_date: BILL_DATE,
        channel_order_id: line.channelOrderId,
        our_status: status,
        channel_status: 'SUCCESS',
        channel_amount_fen: 10_000n,
        result: 'diff',
      }),
    ]);
    expect(await books(f)).toEqual(before);
    expectNoPayeeInLogs(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#8] ③ 付款方侧失败经 W9 退回的 APPROVED 单，账单显示成功：差错单附账单行、告警、recon_diff 冻结；提现单仍是 APPROVED（W11 核销不在本作业）',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser();
    const w = await f.seedReturned({ net: 8_800n, userId: owner });
    const line = lineOf(w);
    f.setBill(BILL_DATE, [line]);
    const before = await books(f);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 0n,
      actualFen: 8_800n,
    });
    expectBillLineOn(found[0], line);
    await expectReconHold(f, owner, found[0]);
    expect(alertsAbout(f, [w.id, w.outBizNo]).length).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(f, { outBizNo: w.outBizNo })).toEqual([
      expect.objectContaining({ our_status: 'APPROVED', result: 'diff' }),
    ]);
    expect(await books(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#9] ③ 账单显示成功而内部没有对应单（不认识的 out_biz_no、没有单号且 channel_order_id 不认识）：各一张差错单（本方 0、账单金额）并告警；没有会员可冻结',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const stranger = lineOf({ outBizNo: 'W20261018UNKNOWN0001', net: 600n });
    const manual = lineOf({ outBizNo: 'unused', net: 700n }, { outBizNo: null });
    f.setBill(BILL_DATE, [stranger, manual]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    const strangerDiffs = await diffsOf(f, [stranger.channelOrderId, 'W20261018UNKNOWN0001']);
    expect(strangerDiffs).toHaveLength(1);
    expectDiff(f, strangerDiffs[0], {
      refType: null,
      refIds: [stranger.channelOrderId, 'W20261018UNKNOWN0001'],
      expectedFen: 0n,
      actualFen: 600n,
    });
    const manualDiffs = await diffsOf(f, [manual.channelOrderId]);
    expect(manualDiffs).toHaveLength(1);
    expectDiff(f, manualDiffs[0], {
      refType: null,
      refIds: [manual.channelOrderId],
      expectedFen: 0n,
      actualFen: 700n,
    });
    expect(
      alertsAbout(f, [stranger.channelOrderId, 'W20261018UNKNOWN0001']).length,
    ).toBeGreaterThan(0);
    expect(alertsAbout(f, [manual.channelOrderId]).length).toBeGreaterThan(0);
    expect(await allHolds(f)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#10] ③ 漏单：内部 PAID_API（当日 10:00 付出，远离日界），账单没有记录 → 差错单（本方 net、账单 0）、告警、recon_diff 冻结，明细 diff（账单侧为空）；提现单与账务不变',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser();
    const w = await f.seedPaid(IN_DAY, { net: 2_000n, userId: owner });
    const other = await f.seedPaid(IN_DAY, { net: 300n });
    f.setBill(BILL_DATE, [lineOf(other)]);
    const before = await books(f);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 2_000n,
      actualFen: 0n,
    });
    await expectReconHold(f, owner, found[0]);
    expect(alertsAbout(f, [w.id, w.outBizNo]).length).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(f, { outBizNo: w.outBizNo })).toEqual([
      expect.objectContaining({
        date: BILL_DATE,
        our_status: 'PAID_API',
        our_amount_fen: 2_000n,
        channel_status: null,
        channel_amount_fen: null,
        result: 'diff',
      }),
    ]);
    expect(await books(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#10] ③ 手动成功单（PAID_MANUAL）按 channel_order_id 在账单里找不到 → 差错单（本方 net、账单 0）与 recon_diff 冻结',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser();
    const w = await f.seedManual(IN_DAY, { net: 4_500n, userId: owner });
    // The bill carries an unrelated manual line only.
    const listed = await f.seedManual(IN_DAY, { net: 100n });
    f.setBill(BILL_DATE, [
      lineOf(listed, { outBizNo: null, channelOrderId: listed.channelOrderId }),
    ]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 4_500n,
      actualFen: 0n,
    });
    await expectReconHold(f, owner, found[0]);
    expect(await diffsOf(f, [listed.id])).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#11] ③ 金额不一致：PAID_API net 10000，账单 9999 → 差错单（本方 10000、账单 9999、差 1）、告警、recon_diff 冻结，明细 diff；提现单金额不改',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser();
    const w = await f.seedPaid(IN_DAY, { net: 10_000n, userId: owner });
    const line = lineOf(w, { channelOrderId: w.channelOrderId, amountFen: 9_999n });
    f.setBill(BILL_DATE, [line]);
    const before = await books(f);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 10_000n,
      actualFen: 9_999n,
    });
    await expectReconHold(f, owner, found[0]);
    expect(alertsAbout(f, [w.id, w.outBizNo]).length).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(f, { outBizNo: w.outBizNo })).toEqual([
      expect.objectContaining({
        our_amount_fen: 10_000n,
        channel_amount_fen: 9_999n,
        result: 'diff',
      }),
    ]);
    expect(await books(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#11] 金额对 net_fen 而不是 amount_fen：amount 10000、手续费 300、net 9700，账单 9700 的单 matched；账单 10000（多付 300）的单 → 差错单（本方 9700、账单 10000、差 −300）、recon_diff 冻结，明细本方金额记 9700',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const agreedOwner = await f.newUser();
    const overpaidOwner = await f.newUser();
    const agreed = await f.seedPaid(IN_DAY, {
      net: 9_700n,
      fee: 300n,
      tax: 0n,
      userId: agreedOwner,
    });
    const overpaid = await f.seedPaid(IN_DAY, {
      net: 9_700n,
      fee: 300n,
      tax: 0n,
      userId: overpaidOwner,
    });
    expect([agreed.amount, overpaid.amount]).toEqual([10_000n, 10_000n]);
    const agreedLine = lineOf(agreed, { channelOrderId: agreed.channelOrderId });
    const overpaidLine = lineOf(overpaid, {
      channelOrderId: overpaid.channelOrderId,
      amountFen: 10_000n,
    });
    f.setBill(BILL_DATE, [agreedLine, overpaidLine]);
    const before = await books(f);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(await rowsOf(f, { outBizNo: agreed.outBizNo })).toEqual([
      expect.objectContaining({
        our_status: 'PAID_API',
        our_amount_fen: 9_700n,
        channel_amount_fen: 9_700n,
        result: 'matched',
      }),
    ]);
    expect(await diffsOf(f, [agreed.id])).toEqual([]);
    expect(await holdsOf(f, agreedOwner)).toEqual([]);

    const found = await diffsOf(f, [overpaid.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [overpaid.id],
      expectedFen: 9_700n,
      actualFen: 10_000n,
    });
    await expectReconHold(f, overpaidOwner, found[0]);
    expect(alertsAbout(f, [overpaid.id, overpaid.outBizNo]).length).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(f, { outBizNo: overpaid.outBizNo })).toEqual([
      expect.objectContaining({
        our_amount_fen: 9_700n,
        channel_amount_fen: 10_000n,
        result: 'diff',
      }),
    ]);
    expect(await books(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#11] 手动成功单（PAID_MANUAL，有手续费与税）按 channel_order_id 对 net_fen：账单金额 = amount_fen 时 → 差错单（本方 net、账单 amount）与 recon_diff 冻结',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser();
    const w = await f.seedManual(IN_DAY, { net: 4_000n, userId: owner });
    f.setBill(BILL_DATE, [
      lineOf(w, { outBizNo: null, channelOrderId: w.channelOrderId, amountFen: w.amount }),
    ]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 4_000n,
      actualFen: 4_000n + FEE + TAX,
    });
    await expectReconHold(f, owner, found[0]);
    expect(await rowsOf(f, { channelOrderId: w.channelOrderId })).toEqual([
      expect.objectContaining({
        our_status: 'PAID_MANUAL',
        our_amount_fen: 4_000n,
        channel_amount_fen: 4_000n + FEE + TAX,
        result: 'diff',
      }),
    ]);
  },
  TIMEOUT,
);

it.each([
  ['FAILED', LINE_FAIL],
  ['FAILED', LINE_UNKNOWN],
  ['REJECTED', LINE_FAIL],
  ['REJECTED', LINE_UNKNOWN],
  ['APPROVED（W9 付款方侧退回）', LINE_FAIL],
  ['APPROVED（W9 付款方侧退回）', LINE_UNKNOWN],
] as const)(
  '[AC-B2-07c#7] 账单行不是成功：内部 %s，账单行状态 %s（payout.query_status_map 映射为 fail / unknown）→ 不算「支付宝成功」：无差错单、无冻结；提现单与账务不变',
  async (ours, status) => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser();
    const w =
      ours === 'FAILED' || ours === 'REJECTED'
        ? await f.seedWithdrawal({
            status: ours,
            net: 10_000n,
            fee: FEE,
            tax: TAX,
            userId: owner,
          })
        : await f.seedReturned({ net: 10_000n, userId: owner });
    f.setBill(BILL_DATE, [lineOf(w, { status })]);
    const before = await books(f);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
    expect(await books(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#9] 账单行不是成功、内部没有对应单（不认识的 out_biz_no 映射为 fail；没有单号、映射为 unknown）→ 无差错单、无冻结',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const closed = lineOf({ outBizNo: 'W20261018UNKNOWN0002', net: 600n }, { status: LINE_FAIL });
    const dealing = lineOf(
      { outBizNo: 'unused', net: 700n },
      { outBizNo: null, status: LINE_UNKNOWN },
    );
    f.setBill(BILL_DATE, [closed, dealing]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#7] 成功按 payout.query_status_map 判：配置另一状态 TEST_PAID 映射为 success，内部 FAILED 单的 TEST_PAID 行 → 差错单与 recon_diff 冻结',
  async () => {
    const f = await setup(h);
    await f.set('payout.query_status_map', {
      ...QUERY_LISTS.queryStatusMap,
      TEST_PAID: 'success',
    });
    const handler = f.reconJob();
    const owner = await f.newUser();
    const w = await f.seedWithdrawal({
      status: 'FAILED',
      net: 3_000n,
      fee: FEE,
      tax: TAX,
      userId: owner,
    });
    f.setBill(BILL_DATE, [lineOf(w, { status: 'TEST_PAID' })]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 0n,
      actualFen: 3_000n,
    });
    await expectReconHold(f, owner, found[0]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#12] 冻结只落在差错单的会员身上：同一天另一位会员的一致单不冻结；已有的人工冻结不受影响、不被释放',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const flagged = await f.newUser();
    const clean = await f.newUser();
    await f.seedWithdrawHold(flagged, {});
    const dup = await f.seedWithdrawal({ status: 'FAILED', net: 900n, userId: flagged });
    const ok = await f.seedPaid(IN_DAY, { net: 900n, userId: clean });
    f.setBill(BILL_DATE, [lineOf(dup), lineOf(ok, { channelOrderId: ok.channelOrderId })]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(await holdsOf(f, clean)).toEqual([]);
    const holds = await holdsOf(f, flagged);
    expect(holds.map((row) => [row.reason, row.released_at])).toEqual([
      ['manual', null],
      ['recon_diff', null],
    ]);
    expect(holds.find((row) => row.reason === 'recon_diff')?.hold_until).toBeNull();
    const found = await diffsOf(f, [dup.id]);
    expect(found).toHaveLength(1);
    expect(holds.find((row) => row.reason === 'recon_diff')?.source_ref ?? '').toContain(
      found[0]?.id ?? 'no diff',
    );
  },
  TIMEOUT,
);
