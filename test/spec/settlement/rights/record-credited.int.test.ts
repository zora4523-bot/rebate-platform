// B2-04l rule tests: rights.record on a CREDITED order — the clawback's rights success entry
// (BR-FUND-06 维权结果; BR-FUND-08 ② / ③; BR-FUND-01 R8 / R9). Default order (credit kit): N 1000,
// reserve 1500 → B 850; self 425 / direct 85 / indirect 42; platform 448 (retain 298 + reserve
// 150); UNION_RECEIVABLE 1000. Deduction 400 → N_new 600 → B 510 → 255 / 51 / 25, platform 269:
// clawback 170 / 34 / 17, platform 179. A second deduction 100 on top → N_new 500 → B 425 →
// 212 / 42 / 21, platform 225: clawback 43 / 9 / 4, platform 44.
// Boundary order (#40 / #41), reserve 0: N 1000 → B 1000 → 500 / 100 / 50, platform 350.
// Deduction 1000 → N_new 0 → R8, clawback 500 / 100 / 50, platform 350. Deduction 999 → N_new 1 →
// B 1 → shares 0 / 0 / 0, platform 1: R9, clawback 500 / 100 / 50, platform 349.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  clawbackKey,
  databaseFixture,
  harness,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
  type Harness,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** The four CLAWBACK keys of one rights event on the default order. */
function keysOf(o: SeededOrder, id: string): string[] {
  return [
    clawbackKey(o, 'self', id),
    clawbackKey(o, 'direct', id),
    clawbackKey(o, 'indirect', id),
    platformClawbackKey(o, id),
  ].sort();
}

/** The default order after the deduction-400 R9 (N_new 600) of rights event `id`. */
async function expectPartial400(h: Harness, o: SeededOrder, id: string): Promise<void> {
  expect(await h.clawbackKeys(o)).toEqual(keysOf(o, id));
  expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
    userClawbackLines(o, 'self', 170n),
  );
  expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
    userClawbackLines(o, 'direct', 34n),
  );
  expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
    userClawbackLines(o, 'indirect', 17n),
  );
  expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(platformDecreaseLines(o, 179n));
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
  expect(await h.rebateColumns(o)).toEqual({
    rebate_status: 'CREDITED',
    booked_base_fen: 510n,
    booked_n_fen: 600n,
    reason: null,
    diff_reason_code: 'PART_REFUND',
    rights_pending: false,
    hold: false,
  });
}

it(
  '[AC-B2-04l#1] 入账后维权部分成功（应扣佣金 400）：applied；记一条 SUCCEEDED 记录，按 R9 部分扣回，键带 R{order_rights.id}，sub_type RIGHTS，booked 510 / 600，rights_pending=false',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();

    expect(await h.record(o, { deductionFen: 400n, amountFen: 2990n })).toEqual({
      kind: 'applied',
    });
    const row = await h.onlyRights(o);
    expect(row).toMatchObject({
      source: 'IMPORT',
      type: 'RIGHTS',
      status: 'SUCCEEDED',
      amount_fen: 2990n,
      deduction_commission_fen: 400n,
      platform_rights_no: 'rights-n1',
    });
    const id = `R${row.id}`;
    await expectPartial400(h, o, id);
    for (const key of keysOf(o, id)) {
      expect(await h.voucherTypes(key)).toEqual(['CLAWBACK|RIGHTS']);
    }
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CREDITED',
        event: 'RIGHTS_PARTIAL',
      }),
    ]);
    expect(await h.balance(o.user('self'))).toBe(255n);
    expect(await h.balance(o.user('direct'))).toBe(51n);
    expect(await h.balance(o.user('indirect'))).toBe(25n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#2] 入账后维权全额成功（应扣佣金 1200 ≥ booked_n 1000，N_new 按 0）：按 R8 全额扣回 425 / 85 / 42、平台 448，CLAWED_BACK，原因码 RIGHTS，同事务发 order.clawed_back',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const publishedBefore = h.publish.mock.calls.length;

    expect(await h.record(o, { deductionFen: 1200n })).toEqual({ kind: 'applied' });
    const id = `R${(await h.onlyRights(o)).id}`;
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, id));
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 85n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 42n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    expect(await h.voucherTypes(platformClawbackKey(o, id))).toEqual(['CLAWBACK|RIGHTS']);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      reason: 'RIGHTS',
      rights_pending: false,
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CLAWED_BACK',
        event: 'RIGHTS_FULL',
      }),
    ]);
    expect(h.publishedSince(publishedBefore)).toEqual(['order.clawed_back']);
    expect(h.publish).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: 'order.clawed_back',
        payload: expect.objectContaining({ order_id: o.orderId, rights_event_id: id }),
      }),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#3] 入账后处罚（type PUNISH，SUCCEEDED）：按 R8 全额扣回，sub_type PUNISH，原因码 PUNISH，键带 R{id}',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();

    expect(await h.record(o, { type: 'PUNISH', rightsNo: 'punish-n1' })).toEqual({
      kind: 'applied',
    });
    const row = await h.onlyRights(o);
    expect(row).toMatchObject({ type: 'PUNISH', status: 'SUCCEEDED' });
    const id = `R${row.id}`;
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, id));
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
    expect(await h.voucherTypes(clawbackKey(o, 'self', id))).toEqual(['CLAWBACK|PUNISH']);
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      reason: 'PUNISH',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({ from_status: 'CREDITED', event: 'PUNISH' }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#4] 入账后结算后退款（type REFUND_AFTER_SETTLE）：按 R8 全额扣回，sub_type FULL，原因码 REFUND，历史事件 REFUND_AFTER_SETTLE',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();

    expect(await h.record(o, { type: 'REFUND_AFTER_SETTLE' })).toEqual({ kind: 'applied' });
    const id = `R${(await h.onlyRights(o)).id}`;
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, id));
    expect(await h.voucherTypes(clawbackKey(o, 'direct', id))).toEqual(['CLAWBACK|FULL']);
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 85n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      reason: 'REFUND',
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({ from_status: 'CREDITED', event: 'REFUND_AFTER_SETTLE' }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#5] 入账后维权成功而既无联盟新佣金也无应扣佣金（BR-FUND-08 ③）：不写扣回，记录置 WAIT_COMMISSION，rights_pending=true，订单进待处理表（CLAWBACK_NO_COMMISSION）并告警（warn 日志带 alert 与 app_id），booked 与余额不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();

    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({ type: 'RIGHTS', status: 'WAIT_COMMISSION' });
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect(await h.rebateColumns(o)).toEqual({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      reason: null,
      diff_reason_code: null,
      rights_pending: true,
      hold: false,
    });
    expect(await h.pendingRows(o)).toEqual([
      expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'open' }),
    ]);
    expect(
      [...h.logs, ...h.rightsLogs].some(
        (line) =>
          line['level'] === 40 && typeof line['alert'] === 'string' && line['app_id'] === h.appId,
      ),
    ).toBe(true);
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([]);
    expect(await h.balance(o.user('self'))).toBe(425n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#6] 入账后维权处理中（PROCESSING）：只记录，rights_pending=true（row_version+1、updated_at=now），不扣回、不迁移、不写历史',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const before = await h.read(o);

    expect(await h.record(o, { status: 'PROCESSING', deductionFen: null })).toEqual({
      kind: 'applied',
    });
    expect(await h.onlyRights(o)).toMatchObject({ status: 'PROCESSING' });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      rights_pending: true,
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      row_version: before.row_version + 1,
      updated_at: h.clock.now(),
    });
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#7] 入账后维权失败（新记录 FAILED）：只记录、关闭，金额不变；订单行（含 rights_pending=false、row_version）与账务都不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const before = await h.everything();

    expect(await h.record(o, { status: 'FAILED', deductionFen: 400n })).toEqual({
      kind: 'applied',
    });
    expect(await h.onlyRights(o)).toMatchObject({
      status: 'FAILED',
      deduction_commission_fen: 400n,
    });
    const after = await h.everything();
    expect(after.orders).toEqual(before.orders);
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.balances).toEqual(before.balances);
    expect(after.history).toEqual(before.history);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#8] 同一条维权结果重放（同键同状态 SUCCEEDED）：duplicate，不再扣回——凭证、余额、booked、记录都与第一次后相同',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    const first = await h.everything();

    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'duplicate' });
    expect(await h.everything()).toEqual(first);
    await expectPartial400(h, o, `R${(await h.onlyRights(o)).id}`);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#9] 另一条维权单号（新键）再扣 100：以当前 booked_n 600 为准，N_new 500 → 再扣 43 / 9 / 4、平台 44，键带第二条记录的 R{id}；booked 425 / 500',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    const [first] = await h.rightsRows(o);

    expect(await h.record(o, { deductionFen: 100n, rightsNo: 'rights-n2' })).toEqual({
      kind: 'applied',
    });
    const rows = await h.rightsRows(o);
    expect(rows).toHaveLength(2);
    const second = rows.find((r) => r.id !== first?.id);
    expect(second).toMatchObject({ platform_rights_no: 'rights-n2', status: 'SUCCEEDED' });
    const id = `R${String(second?.id)}`;
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 43n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 9n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 4n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(platformDecreaseLines(o, 44n));
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(500n);
    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 425n,
      booked_n_fen: 500n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#10] 先处理中、后成功（同一维权单号）：同一条记录原地改为 SUCCEEDED（id 不变），按其应扣佣金 400 部分扣回，键带该 R{id}，rights_pending 回到 false',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    expect(await h.record(o, { status: 'PROCESSING', deductionFen: null })).toEqual({
      kind: 'applied',
    });
    const processing = await h.onlyRights(o);

    expect(await h.record(o, { status: 'SUCCEEDED', deductionFen: 400n })).toEqual({
      kind: 'applied',
    });
    const row = await h.onlyRights(o);
    expect(row).toMatchObject({
      id: processing.id,
      status: 'SUCCEEDED',
      deduction_commission_fen: 400n,
      row_version: processing.row_version + 1,
    });
    await expectPartial400(h, o, `R${row.id}`);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#11] 等待应扣佣金（WAIT_COMMISSION）后平台给出应扣佣金 400（同一维权单号）：同一条记录改为 SUCCEEDED，按 ② 部分扣回，rights_pending 回到 false',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const waiting = await h.onlyRights(o);
    expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });

    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    const row = await h.onlyRights(o);
    expect(row).toMatchObject({
      id: waiting.id,
      status: 'SUCCEEDED',
      deduction_commission_fen: 400n,
    });
    await expectPartial400(h, o, `R${row.id}`);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#12] WAIT_COMMISSION 期间同一结果重放（仍无应扣佣金）：duplicate，不另开待处理记录、不写凭证、什么都不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const first = await h.everything();

    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'duplicate' });
    expect(await h.everything()).toEqual(first);
    expect(await h.pendingRows(o)).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#13] 加锁顺序照 B2-04m / s：调用方已持订单键锁，扣回时先锁 users 行（identity）再 ledger.lockBalances',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    h.lockUsers.mockClear();
    h.lockBalances.mockClear();

    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    expect(h.lockUsers).toHaveBeenCalled();
    expect(h.lockBalances).toHaveBeenCalled();
    const usersAt = Math.min(...h.lockUsers.mock.invocationCallOrder);
    const balancesAt = Math.min(...h.lockBalances.mock.invocationCallOrder);
    expect(usersAt).toBeLessThan(balancesAt);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#14] 只用调用方的事务：record 部分扣回后调用方事务失败 → 维权记录、凭证、余额、booked、rights_pending 全部回滚',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const before = await h.everything();

    await expect(
      h.record(
        o,
        { deductionFen: 400n },
        {
          after: async () => {
            throw new Error('caller rolls back');
          },
        },
      ),
    ).rejects.toThrow('caller rolls back');
    expect(await h.everything()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#39] 入账后 WAIT_COMMISSION 之后联盟回传新佣金 600（扣回编排的维权成功入口，① 新佣金，ref 该维权记录）：按 R9 部分扣回 170 / 34 / 17、平台 179，键带 R{id}；同事务把该记录关闭为 SUCCEEDED（id 不变）、rights_pending 回到 false；之后平台用同一维权单号再给应扣佣金 400 → duplicate，凭证只有一套、什么都不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const waiting = await h.onlyRights(o);
    expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });
    const id = `R${waiting.id}`;

    expect(
      await h.apply(o, {
        cause: 'RIGHTS',
        ref: { kind: 'rights', orderRightsId: waiting.id },
        newCommissionFen: 600n,
      }),
    ).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      rightsEventId: id,
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    expect(await h.onlyRights(o)).toMatchObject({
      id: waiting.id,
      status: 'SUCCEEDED',
      row_version: waiting.row_version + 1,
      updated_at: h.clock.now(),
    });
    await expectPartial400(h, o, id);
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CREDITED',
        event: 'RIGHTS_PARTIAL',
      }),
    ]);
    const closed = await h.everything();

    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'duplicate' });
    expect(await h.everything()).toEqual(closed);
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, id));
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#40] 全额 / 部分分界（入账后，预留 0，booked_n 1000）：应扣佣金恰为 1000 → N_new 0 → 全额，按 R8 RIGHTS_FULL 扣回 500 / 100 / 50、平台 350，CLAWED_BACK（原因码 RIGHTS），booked 0 / 0，发 order.clawed_back',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({ reserveBp: 0 });
    expect(await h.balance(o.user('self'))).toBe(500n);
    const published = h.publish.mock.calls.length;

    expect(await h.record(o, { deductionFen: 1000n })).toEqual({ kind: 'applied' });
    const id = `R${(await h.onlyRights(o)).id}`;
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, id));
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 500n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 100n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 50n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 350n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      reason: 'RIGHTS',
      rights_pending: false,
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CLAWED_BACK',
        event: 'RIGHTS_FULL',
      }),
    ]);
    expect(h.publishedSince(published)).toEqual(['order.clawed_back']);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#41] 全额 / 部分分界的另一侧（入账后，预留 0，booked_n 1000）：应扣佣金 999 → N_new 1、B_new 1 > 0 → 部分，按 R9 RIGHTS_PARTIAL 扣回 500 / 100 / 50、平台 349，保持 CREDITED，booked 1 / 1，差额原因 PART_REFUND，发 order.clawed_back（D10-474 ③）',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({ reserveBp: 0 });
    const published = h.publish.mock.calls.length;
    let recordTrx: unknown;

    expect(
      await h.record(
        o,
        { deductionFen: 999n },
        {
          after: (t) => {
            recordTrx = t;
            return Promise.resolve();
          },
        },
      ),
    ).toEqual({ kind: 'applied' });
    const id = `R${(await h.onlyRights(o)).id}`;
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, id));
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 500n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 100n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 50n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 349n),
    );
    for (const key of keysOf(o, id)) {
      expect(await h.voucherTypes(key)).toEqual(['CLAWBACK|RIGHTS']);
    }
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(1n);
    expect(await h.rebateColumns(o)).toEqual({
      rebate_status: 'CREDITED',
      booked_base_fen: 1n,
      booked_n_fen: 1n,
      reason: null,
      diff_reason_code: 'PART_REFUND',
      rights_pending: false,
      hold: false,
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CREDITED',
        event: 'RIGHTS_PARTIAL',
      }),
    ]);
    const calls = h.publish.mock.calls.slice(published);
    const clawedBack = calls.filter(([, e]) => e.name === 'order.clawed_back');
    expect(clawedBack).toHaveLength(1);
    const [trx, event] = clawedBack[0]!;
    expect(recordTrx).toBeDefined();
    expect(trx).toBe(recordTrx);
    expect(event).toMatchObject({ appId: h.appId, name: 'order.clawed_back' });
    expect(event.payload).toMatchObject({
      order_key: o.orderKey,
      beneficiaries: expect.arrayContaining([
        expect.objectContaining({ user_id: o.user('self'), role: 'self', clawback_fen: '500' }),
        expect.objectContaining({ user_id: o.user('direct'), role: 'direct', clawback_fen: '100' }),
        expect.objectContaining({
          user_id: o.user('indirect'),
          role: 'indirect',
          clawback_fen: '50',
        }),
      ]),
    });
    expect(event.payload).toHaveProperty(['beneficiaries', 'length'], 3);
    expect(await h.balance(o.user('self'))).toBe(0n);
  },
  TIMEOUT,
);

/**
 * Fixture step of #42: the credited order's settlement commission column emptied, so the effective
 * union commission is the estimate (BR-FUND-08 ①「结算佣金为空时是预估佣金的新值」).
 * order_settlements is append-only, so its credit-time rows stay; only the orders column changes.
 */
async function withoutSettleCommission(h: Harness, o: SeededOrder): Promise<void> {
  await p.db
    .updateTable('orders')
    .set({ settle_commission_fen: null })
    .where('app_id', '=', h.appId)
    .where('order_id', '=', o.orderId)
    .execute();
}

it(
  '[AC-B2-04l#42] 入账后 WAIT_COMMISSION 期间联盟新佣金经订单同步回调进来（无结算佣金、预估改为 600，不带维权记录引用）：按 R9 部分扣回 170 / 34 / 17、平台 179，键带 C{commission_version}；同事务把该维权记录关闭为 SUCCEEDED（id 不变）、rights_pending 回到 false、待处理行关闭（resolved）；之后平台用同一维权单号再给应扣佣金 400 → duplicate，凭证只有一套、什么都不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    await withoutSettleCommission(h, o);
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const waiting = await h.onlyRights(o);
    expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });
    expect(await h.pendingRows(o)).toEqual([
      expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'open' }),
    ]);

    const { result, commissionVersion } = await h.sync(o, {
      event: 'PLATFORM_SETTLED',
      estAfter: 600n,
    });
    const id = `C${String(commissionVersion)}`;
    expect(result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      rightsEventId: id,
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    await expectPartial400(h, o, id);
    expect(await h.onlyRights(o)).toMatchObject({
      id: waiting.id,
      status: 'SUCCEEDED',
      row_version: waiting.row_version + 1,
      updated_at: h.clock.now(),
    });
    expect(await h.pendingRows(o)).toEqual([
      expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'resolved' }),
    ]);
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({ from_status: 'CREDITED', to_status: 'CREDITED' }),
    ]);
    expect(await h.balance(o.user('self'))).toBe(255n);
    expect(await h.balance(o.user('direct'))).toBe(51n);
    expect(await h.balance(o.user('indirect'))).toBe(25n);
    const closed = await h.everything();

    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'duplicate' });
    expect(await h.everything()).toEqual(closed);
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, id));
  },
  TIMEOUT,
);
