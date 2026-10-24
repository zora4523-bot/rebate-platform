// B2-04s rule tests: no new commission → WAIT_COMMISSION and the pending table (BR-FUND-08 ③,
// 决-03 A; S12 transitional handling), and the same-transaction voiding of the order's unapproved
// positive-difference candidates (BR-FUND-09 ②, 决-10 A). Default order: N 1000, reserve 1500 →
// 425 / 85 / 42, platform 448; N 600 → −170 / −34 / −17, platform −179.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  NOW,
  TIMEOUT,
  clawbackKey,
  databaseFixture,
  harness,
  platformClawbackKey,
  platformDecreaseLines,
  userClawbackLines,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04s#28] 部分维权既无联盟新佣金也无应扣佣金：不写扣回、不按估算先扣；order_rights 置 WAIT_COMMISSION、rights_pending 重算为 true，订单进待处理表（CLAWBACK_NO_COMMISSION）并告警；返利状态、booked 与余额不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const rightsId = await h.rights(o, { status: 'PROCESSING' });

    const result = await h.apply(o, {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: rightsId },
    });

    expect(result).toEqual({
      outcome: 'wait_commission',
      orderKey: o.orderKey,
      rightsEventId: `R${rightsId}`,
    });
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect(await h.rightsRow(rightsId)).toMatchObject({ status: 'WAIT_COMMISSION' });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      rights_pending: true,
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      reason: null,
    });
    expect(h.openPending).toHaveBeenCalledTimes(1);
    expect(h.openPending).toHaveBeenCalledWith(
      h.transactions.at(-1),
      expect.objectContaining({
        appId: h.appId,
        orderId: o.orderId,
        platform: o.platform,
        subOrderId: o.subOrderId,
        reason: 'CLAWBACK_NO_COMMISSION',
      }),
    );
    expect(await h.pendingRows(o)).toEqual([
      expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'open' }),
    ]);
    expect(
      h.logs.some(
        (line) =>
          line['level'] === 40 && typeof line['alert'] === 'string' && line['app_id'] === h.appId,
      ),
    ).toBe(true);
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#29] WAIT_COMMISSION 之后联盟给出新佣金：同一 rights_event_id 照常扣回（R9，键 R{id}，170 / 34 / 17 / 平台 179）',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const rightsId = await h.rights(o, { status: 'PROCESSING' });
    const ref = { kind: 'rights', orderRightsId: rightsId } as const;
    expect(await h.apply(o, { cause: 'RIGHTS', ref })).toMatchObject({
      outcome: 'wait_commission',
    });
    const id = `R${rightsId}`;

    expect(await h.apply(o, { cause: 'RIGHTS', ref, newCommissionFen: 600n })).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      rightsEventId: id,
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 170n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 34n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 17n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 179n),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#30] R9 同一事务作废该子订单未批准的正差候选（pending → voided_by_clawback、decided_at = 扣回时刻、无审批人）；已作废的旧候选与别的订单的候选不动',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const other = await h.credited();
    const mineUser = await h.candidate(o, { role: 'self', diffFen: 7n });
    const minePlatform = await h.candidate(o, { role: null, diffFen: -5n });
    const stale = await h.candidate(o, { role: 'direct', status: 'voided_stale_seq' });
    const foreign = await h.candidate(other, { role: 'self' });
    const staleBefore = (await h.candidates(o)).find((r) => r.id === stale);
    const rightsId = await h.rights(o);

    expect(
      await h.apply(o, {
        cause: 'RIGHTS',
        ref: { kind: 'rights', orderRightsId: rightsId },
        newCommissionFen: 600n,
      }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });

    const rows = await h.candidates(o);
    for (const id of [mineUser, minePlatform]) {
      expect(rows.find((r) => r.id === id)).toMatchObject({
        status: 'voided_by_clawback',
        decided_at: new Date(NOW),
        approver: null,
      });
    }
    expect(rows.find((r) => r.id === stale)).toEqual(staleBefore);
    expect((await h.candidates(other)).find((r) => r.id === foreign)).toMatchObject({
      status: 'pending',
      decided_at: null,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#31] R8（onUpdated 结算后失效）同样在同一事务作废该子订单未批准的正差候选',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const id = await h.candidate(o, { role: 'self', diffFen: 9n });

    expect((await h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' })).result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R8',
    });
    expect((await h.candidates(o)).find((r) => r.id === id)).toMatchObject({
      status: 'voided_by_clawback',
      decided_at: new Date(NOW),
    });
  },
  TIMEOUT,
);
