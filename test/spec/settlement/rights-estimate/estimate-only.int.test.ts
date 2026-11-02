// B2-03r · 只有预估的单（无结算记录）入账前部分维权（R7，FU-R7-RIGHTS-ESTIMATE；BR-FUND-01 R7、BR-FUND-03、BR-CALC-15、
// BR-CALC-27、BR-FUND-18；编排方案 C）：N_new = 有效佣金 − 未关闭应扣，下限 0；钱包与订单页同数，
// commission_version + 1 与状态写同一条 CAS，新版本金额行按 N_new，订单佣金列不动，不写分录。
// 累计口径 D10-474 ①，联盟回传后不重复扣 D10-483。金额全部手写，见 kit.ts 头部。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  T1,
  T2,
  T3,
  TIMEOUT,
  amountsAt,
  databaseFixture,
  harness,
  moneyRows,
  storedVersions,
  totalsAt,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each([
  { state: 'ESTIMATED', bucket: 'estimated_fen' },
  { state: 'WAITING', bucket: 'pending_credit_fen' },
] as const)(
  '[AC-B2-03r#1] 只有预估的 $state 单 R7（est 1000，应扣 400）：三位受益人钱包与订单页同数且下降到 255 / 51 / 25，全 App 预估 331；版本 1 → 2，v2 金额行与四段金额按 N_new 600，v1 不动；状态不变、佣金列不变、row_version 只 +1、无分录',
  async ({ state, bucket }) => {
    const h = await harness(p.db);
    const o = state === 'ESTIMATED' ? await h.estimated() : await h.waiting();
    const before = await h.read(o);

    await h.deduct(o, 400n);

    const self = await h.walletOf(o.user('self'));
    expect(self[bucket]).toBe(255n);
    expect(self.estimated_total_fen).toBe(255n);
    expect((await h.walletOf(o.user('direct')))[bucket]).toBe(51n);
    expect((await h.walletOf(o.user('indirect')))[bucket]).toBe(25n);
    const totals = await h.appTotals();
    expect(state === 'ESTIMATED' ? totals.total_estimated_fen : totals.total_waiting_fen).toBe(
      331n,
    );
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({
      b_est: 510n,
      est_rebate_fen: 255n,
    });

    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 510n, 255n],
      ['direct', 510n, 51n],
      ['indirect', 510n, 25n],
    ]);
    expect(await totalsAt(p.db, o, 2)).toEqual({
      n_total_fen: 600n,
      pre_base_deduct_fen: 90n,
      base_fen: 510n,
      user_share_total_fen: 331n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 269n,
    });
    expect(await amountsAt(p.db, o, 1)).toEqual([
      ['self', 850n, 425n],
      ['direct', 850n, 85n],
      ['indirect', 850n, 42n],
    ]);
    expect(await h.read(o)).toMatchObject({
      rebate_status: state,
      reason: null,
      est_commission_fen: 1000n,
      settle_commission_fen: null,
      booked_base_fen: null,
      booked_n_fen: null,
      commission_version: 2,
      row_version: before.row_version + 1,
    });
    expect(await h.rebateHistory(o)).toEqual([
      { event: 'RIGHTS_PARTIAL', from_status: state, to_status: state },
    ]);
    const money = await moneyRows(p.db, h.appId);
    expect(money.vouchers).toEqual([]);
    expect(money.entries).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#2] R7 的 refresh 在同一事务带 { commissionFen: N_new }：写的是新版本一次；同一维权单号重放是 duplicate，版本与金额行不再动',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated();

    await h.deduct(o, 400n);

    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.refresh.mock.calls[0]?.[1]).toEqual(h.ref(o));
    expect(h.refreshValues()).toEqual([{ commissionFen: 600n }]);

    expect(await h.record(o, { deductionFen: 400n, at: T2 })).toEqual({ kind: 'duplicate' });
    expect((await h.read(o)).commission_version).toBe(2);
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
    expect(await h.rightsRows(o)).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#3] D10-474 ① 多次 R7 累计：应扣 400 再 100，N_new 1000 − 500 = 500（不是只扣最后一次的 900、也不是 600 − 500）：v3 金额行 212 / 42 / 21，钱包与订单页同数，佣金列仍 1000',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated();

    await h.deduct(o, 400n, 'rights-1', T1);
    await h.deduct(o, 100n, 'rights-2', T2);

    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
    expect(await amountsAt(p.db, o, 3)).toEqual([
      ['self', 425n, 212n],
      ['direct', 425n, 42n],
      ['indirect', 425n, 21n],
    ]);
    expect(await totalsAt(p.db, o, 3)).toMatchObject({ n_total_fen: 500n, base_fen: 425n });
    expect((await h.walletOf(o.user('self'))).estimated_fen).toBe(212n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({
      b_est: 425n,
      est_rebate_fen: 212n,
    });
    expect(await h.read(o)).toMatchObject({ commission_version: 3, est_commission_fen: 1000n });
    expect(h.refreshValues()).toEqual([{ commissionFen: 600n }, { commissionFen: 500n }]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#4] 累计到下限 0 走 R6 不走 R7：应扣 600（R7，钱包 170）后再扣 500，1000 − 1100 按 0 → RIGHTS_FULL 置 VOID（原因码 RIGHTS），发 order.invalidated，版本停在 2、没有 v3，无分录，钱包与订单页不再有金额',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated();

    await h.deduct(o, 600n, 'rights-1', T1);
    expect((await h.walletOf(o.user('self'))).estimated_fen).toBe(170n);
    expect((await h.read(o)).commission_version).toBe(2);

    await h.deduct(o, 500n, 'rights-2', T2);

    expect(await h.read(o)).toMatchObject({
      rebate_status: 'VOID',
      reason: 'RIGHTS',
      commission_version: 2,
      est_commission_fen: 1000n,
    });
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
    expect(await h.rebateHistory(o)).toEqual([
      { event: 'RIGHTS_PARTIAL', from_status: 'ESTIMATED', to_status: 'ESTIMATED' },
      { event: 'RIGHTS_FULL', from_status: 'ESTIMATED', to_status: 'VOID' },
    ]);
    expect(await h.eventNames()).toEqual(['order.invalidated']);
    expect((await moneyRows(p.db, h.appId)).vouchers).toEqual([]);
    expect((await h.walletOf(o.user('self'))).estimated_total_fen).toBe(0n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({ est_rebate_fen: null });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#5] N_new 还是正数、新基数已为 0（累计应扣 999，N 1，预留 15% 后 B 0）：走 R6 BASE_ZERO（原因码 COMMISSION_ZERO），不走 R7，不推版本',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated();

    await h.deduct(o, 400n, 'rights-1', T1);
    expect((await h.read(o)).commission_version).toBe(2);

    await h.deduct(o, 599n, 'rights-2', T2);

    expect(await h.read(o)).toMatchObject({
      rebate_status: 'VOID',
      reason: 'COMMISSION_ZERO',
      commission_version: 2,
    });
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#6] D10-483 联盟回传新预估后不重复扣：R7（应扣 400，v2）后联盟把预估改成 600 → 版本到 3，v3 按 600 写（refresh 不传第三参，不再减 400），维权记录 answered_at 置为当时时刻，钱包 255 不变成 85；之后再来应扣 100 → N_new 600 − 100 = 500，版本继续到 4，钱包 212',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated();

    await h.deduct(o, 400n, 'rights-1', T1);
    expect((await h.read(o)).commission_version).toBe(2);

    await h.unionSync(o, { estAfter: 600n, at: T2 });

    expect(await h.read(o)).toMatchObject({
      rebate_status: 'ESTIMATED',
      est_commission_fen: 600n,
      commission_version: 3,
    });
    expect(await amountsAt(p.db, o, 3)).toEqual([
      ['self', 510n, 255n],
      ['direct', 510n, 51n],
      ['indirect', 510n, 25n],
    ]);
    expect((await h.rightsRows(o))[0]?.answered_at).toEqual(new Date(T2));
    expect((await h.walletOf(o.user('self'))).estimated_fen).toBe(255n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({
      b_est: 510n,
      est_rebate_fen: 255n,
    });

    await h.deduct(o, 100n, 'rights-2', T3);

    expect(await storedVersions(p.db, o)).toEqual({
      amounts: [1, 2, 3, 4],
      totals: [1, 2, 3, 4],
    });
    expect(await amountsAt(p.db, o, 4)).toEqual([
      ['self', 425n, 212n],
      ['direct', 425n, 42n],
      ['indirect', 425n, 21n],
    ]);
    expect((await h.walletOf(o.user('self'))).estimated_fen).toBe(212n);
    expect(await h.read(o)).toMatchObject({ commission_version: 4, est_commission_fen: 600n });
    expect(h.refreshValues()).toEqual([
      { commissionFen: 600n },
      undefined,
      { commissionFen: 500n },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#7] 预估没变的同步不算联盟回传（D10-483）：R7 后同步报同一个预估 1000，版本不动，记录不回应，钱包与订单页仍按 600',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated();

    await h.deduct(o, 400n);
    await h.unionSync(o, { at: T2 });

    expect((await h.rightsRows(o))[0]?.answered_at).toBeNull();
    expect((await h.read(o)).commission_version).toBe(2);
    expect((await h.walletOf(o.user('self'))).estimated_fen).toBe(255n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({ est_rebate_fen: 255n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#8] 版本与金额行同事务：refresh 抛错时 R7 整个回滚（版本、维权记录、历史都不留）；重投一次才落 v2，钱包 255',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated();
    const before = await h.read(o);

    h.refresh.mockRejectedValueOnce(new Error('injected refresh failure'));
    await expect(h.record(o, { deductionFen: 400n })).rejects.toThrow('injected refresh failure');

    expect(await h.read(o)).toEqual(before);
    expect(await h.rightsRows(o)).toEqual([]);
    expect(await h.rebateHistory(o)).toEqual([]);

    await h.deduct(o, 400n);

    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
    expect((await h.walletOf(o.user('self'))).estimated_fen).toBe(255n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#9] 暂停中的 WAITING 单（hold）R7：BR-FUND-18 的 pending_credit_paused_fen 与 pending_credit_fen 同样下降，hold 保留',
  async () => {
    const h = await harness(p.db);
    const o = await h.waiting({ patch: { hold: true, hold_reason: 'CS' } });

    await h.deduct(o, 400n);

    const wallet = await h.walletOf(o.user('self'));
    expect(wallet.pending_credit_fen).toBe(255n);
    expect(wallet.pending_credit_paused_fen).toBe(255n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      hold: true,
      hold_reason: 'CS',
      commission_version: 2,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#10] 淘礼金单（tlj 100）：N_new 600 → 510 − 100 = 410，v2 金额行 205 / 41 / 20，钱包与订单页同数；淘礼金不被算两次',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated({ tljDeductFen: 100n, rebateMode: 'normal' });

    await h.deduct(o, 400n);

    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 410n, 205n],
      ['direct', 410n, 41n],
      ['indirect', 410n, 20n],
    ]);
    expect((await h.walletOf(o.user('self'))).estimated_fen).toBe(205n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({
      b_est: 410n,
      est_rebate_fen: 205n,
    });
  },
  TIMEOUT,
);
