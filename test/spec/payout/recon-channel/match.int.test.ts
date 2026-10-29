// B2-07c (规划/08 BR-WDR-23 and its 细则; BR-FUND-24): matching and ③. Interface payouts are matched by
// out_biz_no, manual successes (PAID_MANUAL) by channel_order_id; the bill amount is compared with
// net_fen. ③ — the bill shows a success and ours is APPROVED / FAILED / REJECTED or missing, ours is
// PAID_* and the bill has no line, or the amounts differ — gives an R2 channel_mismatch recon diff,
// an alert and, for the member, a withdraw hold recon_diff that never expires by itself; an APPROVED
// withdrawal returned by W9 after a payer-side failure gets the bill line on its diff (W11 is not
// this task). Terminal withdrawals are read only: no status, amount, voucher or balance changes
// (corrections only by diff + adjustment). Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BILL_DATE,
  IN_DAY,
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
  '[AC-B2-07c#6] 接口打款单按 out_biz_no 一致：明细 matched（本方 PAID_API / net_fen，账单的 channel_order_id / 状态 / 金额），无差错单、无冻结、无告警',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const w = await f.seedPaid(IN_DAY, { net: 1_234n });
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
    const w = await f.seedWithdrawal({ status, net: 10_000n, userId: owner });
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
