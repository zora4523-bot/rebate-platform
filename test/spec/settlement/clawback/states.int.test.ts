// B2-04s rule tests: beneficiary states at clawback time (BR-CALC-09 受益人状态规则; BR-FUND-08
// 注销后扣回记坏账; BR-FUND-04 ⑫ 未完成义务; BR-FUND-10 负余额). Default order: N 1000,
// reserve 1500 → B 850; self 425 / direct 85 / indirect 42; platform 448. Partial: N 600 →
// B 510 → 255 / 51 / 25.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  NOW,
  TIMEOUT,
  badDebtLines,
  clawbackKey,
  databaseFixture,
  harness,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04s#21] 受益人入账后进入注销 processing、净额 > 0：其扣回不写账户，改借 BAD_DEBT / 贷 UNION_RECEIVABLE（同一 uniq_key、类型不变、带受益人键），余额不变；其余照常，应收归 0',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    await h.markDeleting(o.user('direct'));
    const { result, rowVersion } = await h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' });
    const id = `P${String(rowVersion)}`;

    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(badDebtLines(o, 85n));
    expect(await h.voucherTypes(clawbackKey(o, 'direct', id))).toEqual(['CLAWBACK|FULL']);
    expect(await h.voucher(clawbackKey(o, 'direct', id))).toMatchObject({
      voucher_kind: 'CLAWBACK',
      beneficiary_user_id: o.user('direct'),
      role: 'direct',
    });
    expect(await h.balance(o.user('direct'))).toBe(85n);
    // The bad-debt clawback counts in the beneficiary's net (BR-FUND-08 / 19 ④).
    expect(await h.netOf(o, 'direct')).toBe(0n);
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 42n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.orderSubjectNet(o, 'BAD_DEBT')).toBe(85n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#22] 入账时已注销被没收（份额从没入过其账户、净额 0）：扣回不给该受益人写任何分录，没收的份额随平台已入账净额冲回（平台 448 + 85 = 533）',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'deleting' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    expect((await h.nets(o)).platform_net_fen).toBe(533n);
    const { rowVersion } = await h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' });
    const id = `P${String(rowVersion)}`;

    expect(await h.clawbackKeys(o)).toEqual(
      [
        clawbackKey(o, 'self', id),
        clawbackKey(o, 'indirect', id),
        platformClawbackKey(o, id),
      ].sort(),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 533n),
    );
    expect(await h.orderSubjectNet(o, 'BAD_DEBT')).toBe(0n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.orderSubjectNet(o, 'COMMISSION_REVENUE')).toBe(0n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#23] 受益人入账后被封禁：部分扣回的负向差额照常从 available 扣（85 → 51，扣 34），其余照常',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    await h.setRisk(p.db, o.user('direct'), 'banned');
    const rightsId = await h.rights(o);
    const id = `R${rightsId}`;

    expect(
      await h.apply(o, {
        cause: 'PARTIAL_REFUND',
        ref: { kind: 'rights', orderRightsId: rightsId },
        newCommissionFen: 600n,
      }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 34n),
    );
    expect(await h.balance(o.user('direct'))).toBe(51n);
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 170n),
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
  '[AC-B2-04s#24] 入账时冻结（暂缓、开了首次入账义务）且仍冻结：部分扣回不给其写凭证，义务保持 open；平台按「新留存 + 预留」冲回 179；应收净影响 = −400 − (51 − 85) = −366',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'frozen' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(915n);
    const [obligation] = await h.orderObligations(o);
    expect(obligation).toMatchObject({ kind: 'first_credit', status: 'open' });
    const rightsId = await h.rights(o);
    const id = `R${rightsId}`;

    expect(
      await h.apply(o, {
        cause: 'RIGHTS',
        ref: { kind: 'rights', orderRightsId: rightsId },
        newCommissionFen: 600n,
      }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R9', bookedBaseFen: 510n });
    expect(await h.clawbackKeys(o)).toEqual(
      [
        clawbackKey(o, 'self', id),
        clawbackKey(o, 'indirect', id),
        platformClawbackKey(o, id),
      ].sort(),
    );
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 170n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 17n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 179n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(549n);
    expect(await h.orderObligations(o)).toEqual([
      expect.objectContaining({
        beneficiary_credit_id: obligation?.beneficiary_credit_id,
        status: 'open',
        closed_by: null,
      }),
    ]);
    expect(await h.balance(o.user('direct'))).toBe(0n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#25] 入账时冻结（义务 open）后整单失效（R8）：同一事务作废该未完成义务（voided、closed_by R8），不给其写凭证；平台冲回 448，应收归 0',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'frozen' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    const { rowVersion } = await h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' });
    const id = `P${String(rowVersion)}`;

    expect(await h.clawbackKeys(o)).toEqual(
      [
        clawbackKey(o, 'self', id),
        clawbackKey(o, 'indirect', id),
        platformClawbackKey(o, id),
      ].sort(),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.orderObligations(o)).toEqual([
      expect.objectContaining({
        kind: 'first_credit',
        status: 'voided',
        closed_by: 'R8',
        closed_ref: expect.any(String),
        closed_at: new Date(NOW),
      }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#26] 入账时冻结（义务 open）、扣回前被封禁：部分扣回把其剩余未履约金额归平台，同一事务把义务记为没收（forfeited、closed_by R9）并追加 forfeited 事件（banned）；平台冲回 128，应收净影响 −315',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'frozen' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    await h.setRisk(p.db, o.user('direct'), 'banned');
    const eventsBefore = await h.beneficiaryEvents(o);
    const rightsId = await h.rights(o);
    const id = `R${rightsId}`;

    expect(
      await h.apply(o, {
        cause: 'RIGHTS',
        ref: { kind: 'rights', orderRightsId: rightsId },
        newCommissionFen: 600n,
      }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    expect(await h.clawbackKeys(o)).toEqual(
      [
        clawbackKey(o, 'self', id),
        clawbackKey(o, 'indirect', id),
        platformClawbackKey(o, id),
      ].sort(),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 128n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
    expect(await h.orderObligations(o)).toEqual([
      expect.objectContaining({ status: 'forfeited', closed_by: 'R9', closed_at: new Date(NOW) }),
    ]);
    expect((await h.beneficiaryEvents(o)).slice(eventsBefore.length)).toEqual([
      expect.objectContaining({
        user_id: o.user('direct'),
        role: 'direct',
        status: 'forfeited',
        reason: 'banned',
      }),
    ]);
    expect(await h.balance(o.user('direct'))).toBe(0n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#27] 负余额（BR-FUND-10）：本人 425 已冻结提现（available 0、frozen 425），全额扣回只从 available 扣 → available −425，frozen 仍 425',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    await h.freeze(o.user('self'), 425n);
    expect(await h.balance(o.user('self'))).toBe(0n);
    const { rowVersion } = await h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' });
    const id = `P${String(rowVersion)}`;

    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
    expect(await h.balance(o.user('self'))).toBe(-425n);
    expect(await h.frozenOf(o.user('self'))).toBe(425n);
    expect(await h.read(o)).toMatchObject({ rebate_status: 'CLAWED_BACK' });
  },
  TIMEOUT,
);
