// B2-07c (规划/08 BR-WDR-23 细则：「内部 PAID_*、支付宝无记录」——paid_at 靠近日界时，要 paid_at 当日和次日两份
// 账单都没有记录，才算差异): a withdrawal paid at 2026-10-18 23:59:30 +08:00 and absent from the
// 2026-10-18 bill is not a diff on that day's run; the next day's run settles it — found in the
// 2026-10-19 bill: matched, never a diff; absent from both: a diff and a recon_diff hold then. (Far
// from the boundary, absent from its day's bill is a diff on the first run: match.int.test.ts.)
// Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BILL_DATE,
  IN_DAY,
  NEAR_DAY_END,
  NEXT_BILL_DATE,
  NEXT_RUN,
  TIMEOUT,
  close,
  diffsOf,
  expectDiff,
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
  '[AC-B2-07c#18] 近日界（23:59:30 付出）当日账单没有：当日运行不算差异；次日账单里有（00:00:20 入账）→ 次日运行 matched，始终没有差错单与冻结',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser();
    const w = await f.seedPaid(NEAR_DAY_END, { net: 3_300n, userId: owner });
    const other = await f.seedPaid(IN_DAY, { net: 100n });
    f.setBill(BILL_DATE, [lineOf(other, { channelOrderId: other.channelOrderId })]);
    f.setBill(NEXT_BILL_DATE, [
      lineOf(w, { channelOrderId: w.channelOrderId, bookedAt: '2026-10-19T00:00:20+08:00' }),
    ]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(await diffsOf(f, [w.id])).toEqual([]);
    expect(await holdsOf(f, owner)).toEqual([]);
    expect((await rowsOf(f, { outBizNo: w.outBizNo })).map((row) => row.result)).not.toContain(
      'diff',
    );

    f.clock.set(NEXT_RUN);
    await expect(f.reconJob()(f.reconJobOf(NEXT_BILL_DATE))).resolves.toBeUndefined();
    expect(await diffsOf(f, [w.id])).toEqual([]);
    expect(await holdsOf(f, owner)).toEqual([]);
    const rows = await rowsOf(f, { outBizNo: w.outBizNo });
    expect(rows.map((row) => row.result)).toContain('matched');
    expect(rows.map((row) => row.result)).not.toContain('diff');
    expect(rows.find((row) => row.result === 'matched')).toMatchObject({
      bill_date: NEXT_BILL_DATE,
      channel_order_id: w.channelOrderId,
      our_status: 'PAID_API',
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#18] 近日界（23:59:30 付出）当日与次日两份账单都没有：当日运行不算差异，次日运行才生成差错单（本方 net、账单 0）与 recon_diff 冻结',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser();
    const w = await f.seedPaid(NEAR_DAY_END, { net: 3_300n, userId: owner });
    const other = await f.seedPaid(IN_DAY, { net: 100n });
    f.setBill(BILL_DATE, [lineOf(other, { channelOrderId: other.channelOrderId })]);
    f.setBill(NEXT_BILL_DATE, []);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    expect(await diffsOf(f, [w.id])).toEqual([]);
    expect(await holdsOf(f, owner)).toEqual([]);

    f.clock.set(NEXT_RUN);
    await expect(f.reconJob()(f.reconJobOf(NEXT_BILL_DATE))).resolves.toBeUndefined();
    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 3_300n,
      actualFen: 0n,
      periods: [BILL_DATE, NEXT_BILL_DATE],
    });
    await expectReconHold(f, owner, found[0]);
  },
  TIMEOUT,
);
