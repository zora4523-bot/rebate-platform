// B2-07c acceptance (规划/05 B2-07; 规划/08 BR-WDR-23 细则「验收：注入 1 笔重复打款和 1 笔漏单，次日对账全部
// 发现」): on 2026-10-18 one withdrawal FAILED and returned while Alipay paid it (重复打款), one PAID_API
// that Alipay never booked (漏单), one that agrees; the T+1 run on 2026-10-19 finds both — one diff
// each, both members held — and still records the day as succeeded. Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BILL_DATE,
  IN_DAY,
  TIMEOUT,
  books,
  close,
  diffs,
  diffsOf,
  expectDiff,
  expectReconHold,
  holdsOf,
  lineOf,
  open,
  runs,
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
  '[AC-B2-07c#19] 注入 1 笔重复打款（内部 FAILED 已退回 ¥100、账单成功 ¥100）和 1 笔漏单（内部 PAID_API、账单无记录），次日对账全部发现：两张差错单、两位会员各一条 recon_diff 冻结，运行 succeeded（bill_rows 2、matched 1、diffs 2），提现单与账务不变',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const duplicateOwner = await f.newUser();
    const missingOwner = await f.newUser();
    const cleanOwner = await f.newUser();
    const duplicate = await f.seedWithdrawal({
      status: 'FAILED',
      net: 10_000n,
      userId: duplicateOwner,
    });
    const missing = await f.seedPaid(IN_DAY, { net: 6_600n, userId: missingOwner });
    const agreed = await f.seedPaid(IN_DAY, { net: 2_000n, userId: cleanOwner });
    f.setBill(BILL_DATE, [
      lineOf(duplicate),
      lineOf(agreed, { channelOrderId: agreed.channelOrderId }),
    ]);
    const before = await books(f);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(await diffs(f)).toHaveLength(2);
    const dup = await diffsOf(f, [duplicate.id]);
    expect(dup).toHaveLength(1);
    expectDiff(f, dup[0], {
      refType: 'withdrawal',
      refIds: [duplicate.id],
      expectedFen: 0n,
      actualFen: 10_000n,
    });
    const lost = await diffsOf(f, [missing.id]);
    expect(lost).toHaveLength(1);
    expectDiff(f, lost[0], {
      refType: 'withdrawal',
      refIds: [missing.id],
      expectedFen: 6_600n,
      actualFen: 0n,
    });
    await expectReconHold(f, duplicateOwner, dup[0]);
    await expectReconHold(f, missingOwner, lost[0]);
    expect(await holdsOf(f, cleanOwner)).toEqual([]);
    expect(await runs(f)).toEqual([
      expect.objectContaining({
        bill_date: BILL_DATE,
        status: 'succeeded',
        bill_rows: 2,
        matched: 1,
        diffs: 2,
      }),
    ]);
    expect(await books(f)).toEqual(before);
  },
  TIMEOUT,
);
