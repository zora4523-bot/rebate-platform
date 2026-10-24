// B2-04s rule tests: amounts, N_new sources and rights_event_id of apply() (BR-FUND-08 ① / ② /
// full causes; BR-CALC-09 full recomputation; BR-FUND-01 R8 / R9). Expected amounts are the 08
// examples, written by hand:
// - reserve_bp 2000, self 5000 / direct 1000, N 1000 → B 800, reserve 200; 400 / 80, platform 520.
//   ① new commission 600 → B 480, reserve 120 → 240 / 48 (−160 / −32), platform 312 (−208);
//   ② deduction 250 → N 750 → B 600 → 300 / 60 (−100 / −20), platform 390 (−130).
// - default order (reserve 1500, 5000 / 1000 / 500, N 1000 → 425 / 85 / 42, platform 448):
//   N 600 → B 510, reserve 90 → 255 / 51 / 25 (−170 / −34 / −17), platform 269 (−179).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  clawbackKey,
  databaseFixture,
  harness,
  platformClawbackKey,
  platformDecreaseLines,
  platformIncreaseLines,
  receivable,
  userClawbackLines,
  type OrderSpec,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const RESERVE_2000: OrderSpec = {
  people: [
    { role: 'self', ratioBp: 5000 },
    { role: 'direct', ratioBp: 1000 },
  ],
  settleFen: 1000n,
  reserveBp: 2000,
};

it(
  '[AC-B2-04s#8] 部分维权 ① 联盟新佣金 600（预留 2000）：R9，本人扣 160、直推扣 32、平台冲回 208，键 R{order_rights.id}，sub_type RIGHTS；应收净影响 −400；booked 成对 480 / 600；保持 CREDITED，原因码不改、差额原因 PART_REFUND，历史 RIGHTS_PARTIAL',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited(RESERVE_2000);
    expect(await h.balance(o.user('self'))).toBe(400n);
    const rightsId = await h.rights(o);
    const before = await h.read(o);
    const id = `R${rightsId}`;

    const result = await h.apply(o, {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: rightsId },
      newCommissionFen: 600n,
    });

    expect(result).toEqual({
      outcome: 'clawed_back',
      transition: 'R9',
      orderKey: o.orderKey,
      rightsEventId: id,
      bookedBaseFen: 480n,
      bookedNFen: 600n,
    });
    expect(await h.clawbackKeys(o)).toEqual(
      [clawbackKey(o, 'self', id), clawbackKey(o, 'direct', id), platformClawbackKey(o, id)].sort(),
    );
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 160n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 32n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 208n),
    );
    for (const key of await h.clawbackKeys(o)) {
      expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|RIGHTS']);
    }
    expect(await h.balance(o.user('self'))).toBe(240n);
    expect(await h.balance(o.user('direct'))).toBe(48n);
    expect(await h.netOf(o, 'self')).toBe(240n);
    expect(await h.netOf(o, 'direct')).toBe(48n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
    expect((await h.nets(o)).platform_net_fen).toBe(312n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 480n,
      booked_n_fen: 600n,
      reason: null,
      diff_reason_code: 'PART_REFUND',
      row_version: before.row_version + 1,
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'CREDITED',
        to_status: 'CREDITED',
        event: 'RIGHTS_PARTIAL',
      }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#9] 部分维权 ② 只给应扣佣金 250：N_new = booked_n 1000 − 250 = 750 → 本人扣 100、直推扣 20、平台冲回 130；应收净影响 −250；booked 600 / 750',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited(RESERVE_2000);
    const rightsId = await h.rights(o, { deductionFen: 250n });
    const id = `R${rightsId}`;

    const result = await h.apply(o, {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: rightsId },
      rightsDeductFen: 250n,
    });

    expect(result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      rightsEventId: id,
      bookedBaseFen: 600n,
      bookedNFen: 750n,
    });
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 100n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 20n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 130n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(750n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 600n,
      booked_n_fen: 750n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#10] 取值顺序：本次事件带来联盟新佣金（①）时不看应扣佣金（②）：① 600 与 ② 250 同时给出 → 按 600 扣（160 / 32 / 208）',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited(RESERVE_2000);
    const rightsId = await h.rights(o, { deductionFen: 250n });
    const id = `R${rightsId}`;

    const result = await h.apply(o, {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: rightsId },
      newCommissionFen: 600n,
      rightsDeductFen: 250n,
    });

    expect(result).toMatchObject({ bookedBaseFen: 480n, bookedNFen: 600n });
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 160n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 32n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 208n),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#11] 应扣佣金不小于 booked_n（② 1200 → N_new 按 0）：转 R8 全额扣回，sub_type RIGHTS、原因码 RIGHTS、历史 RIGHTS_FULL，booked 0 / 0',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited(RESERVE_2000);
    const rightsId = await h.rights(o, { deductionFen: 1200n });
    const id = `R${rightsId}`;

    const result = await h.apply(o, {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: rightsId },
      rightsDeductFen: 1200n,
    });

    expect(result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R8',
      bookedBaseFen: 0n,
      bookedNFen: 0n,
    });
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 400n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 80n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 520n),
    );
    for (const key of await h.clawbackKeys(o)) {
      expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|RIGHTS']);
    }
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      reason: 'RIGHTS',
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CLAWED_BACK',
        event: 'RIGHTS_FULL',
      }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#12] 部分退款（订单同步的佣金变化，键 C{commission_version} 取锁后重读的当前版本）：N 1000 → 600，三人扣 170 / 34 / 17、平台冲回 179，sub_type PART_REFUND，历史 PARTIAL_REFUND，booked 510 / 600',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    await h.bumpCommissionVersion(o, 5);
    const id = 'C5';

    const result = await h.apply(o, {
      cause: 'PARTIAL_REFUND',
      ref: { kind: 'commission' },
      newCommissionFen: 600n,
    });

    expect(result).toEqual({
      outcome: 'clawed_back',
      transition: 'R9',
      orderKey: o.orderKey,
      rightsEventId: id,
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    expect(await h.clawbackKeys(o)).toEqual(
      [
        clawbackKey(o, 'self', id),
        clawbackKey(o, 'direct', id),
        clawbackKey(o, 'indirect', id),
        platformClawbackKey(o, id),
      ].sort(),
    );
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
    for (const key of await h.clawbackKeys(o)) {
      expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|PART_REFUND']);
    }
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 510n,
      booked_n_fen: 600n,
      reason: null,
      diff_reason_code: 'PART_REFUND',
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CREDITED',
        event: 'PARTIAL_REFUND',
      }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#13] 舍入使平台留存增加（预留 0，两人各 3300bp，B 10 → 9）：受益人各扣 1，平台差额为负 → 借 UNION_RECEIVABLE 1 / 贷 COMMISSION_REVENUE 1；应收净影响 −1',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({
      people: [
        { role: 'self', ratioBp: 3300 },
        { role: 'direct', ratioBp: 3300 },
      ],
      settleFen: 10n,
      reserveBp: 0,
    });
    expect(await h.balance(o.user('self'))).toBe(3n);
    const rightsId = await h.rights(o);
    const id = `R${rightsId}`;

    const result = await h.apply(o, {
      cause: 'PARTIAL_REFUND',
      ref: { kind: 'rights', orderRightsId: rightsId },
      newCommissionFen: 9n,
    });

    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R9', bookedBaseFen: 9n });
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 1n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 1n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(platformIncreaseLines(o, 1n));
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(9n);
    expect((await h.nets(o)).platform_net_fen).toBe(5n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#14] 基数为 0 仍记预留的订单（预留 10000）：600 → R9 只冲平台 400；400 → 再冲 200；之后结算后退款 → R8 冲回 400，CLAWED_BACK，应收归 0；受益人从不写凭证',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({ settleFen: 1000n, reserveBp: 10000 });
    expect((await h.nets(o)).platform_net_fen).toBe(1000n);

    const r1 = await h.rights(o);
    expect(
      await h.apply(o, {
        cause: 'RIGHTS',
        ref: { kind: 'rights', orderRightsId: r1 },
        newCommissionFen: 600n,
      }),
    ).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      bookedBaseFen: 0n,
      bookedNFen: 600n,
    });
    expect(await h.clawbackKeys(o)).toEqual([platformClawbackKey(o, `R${r1}`)]);
    expect(await h.voucherLines(platformClawbackKey(o, `R${r1}`))).toEqual(
      platformDecreaseLines(o, 400n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
    expect(await h.read(o)).toMatchObject({ rebate_status: 'CREDITED', booked_n_fen: 600n });

    const r2 = await h.rights(o);
    expect(
      await h.apply(o, {
        cause: 'RIGHTS',
        ref: { kind: 'rights', orderRightsId: r2 },
        newCommissionFen: 400n,
      }),
    ).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      bookedBaseFen: 0n,
      bookedNFen: 400n,
    });
    expect(await h.voucherLines(platformClawbackKey(o, `R${r2}`))).toEqual(
      platformDecreaseLines(o, 200n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(400n);

    const rv = (await h.read(o)).row_version;
    const id = `P${String(rv)}`;
    expect(
      await h.apply(o, { cause: 'REFUND_AFTER_SETTLE', ref: { kind: 'platform' } }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R8', rightsEventId: id });
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 400n),
    );
    expect(await h.voucherTypes(platformClawbackKey(o, id))).toEqual(['CLAWBACK|FULL']);
    expect(await h.clawbackKeys(o)).toHaveLength(3);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.orderSubjectNet(o, 'COMMISSION_REVENUE')).toBe(0n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      reason: 'REFUND',
    });
    expect((await h.rebateHistoryAfterCredit(o)).map((r) => r.event)).toEqual([
      'RIGHTS_PARTIAL',
      'RIGHTS_PARTIAL',
      'REFUND_AFTER_SETTLE',
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#15] 幂等：同一 R9 事件重放（同一 rights_event_id、同一新佣金）→ no_change，不再写凭证，余额、booked 与平台净额不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited(RESERVE_2000);
    const rightsId = await h.rights(o);
    const spec = {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: rightsId },
      newCommissionFen: 600n,
    } as const;
    expect(await h.apply(o, spec)).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    const keys = await h.orderVoucherKeys(o);

    expect(await h.apply(o, spec)).toEqual({
      outcome: 'no_change',
      orderKey: o.orderKey,
      rightsEventId: `R${rightsId}`,
    });
    expect(await h.orderVoucherKeys(o)).toEqual(keys);
    expect(await h.balance(o.user('self'))).toBe(240n);
    expect(await h.balance(o.user('direct'))).toBe(48n);
    expect((await h.nets(o)).platform_net_fen).toBe(312n);
    expect(await h.read(o)).toMatchObject({ booked_base_fen: 480n, booked_n_fen: 600n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#16] 有效联盟佣金正数部分由 >0 变 0（COMMISSION，键 C{commission_version}）：R8，sub_type FULL、原因码 COMMISSION_ZERO、历史 COMMISSION_POSITIVE_ZERO',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    await h.bumpCommissionVersion(o, 3);
    const id = 'C3';

    const result = await h.apply(o, {
      cause: 'COMMISSION',
      ref: { kind: 'commission' },
      newCommissionFen: 0n,
    });

    expect(result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R8',
      rightsEventId: id,
      bookedBaseFen: 0n,
      bookedNFen: 0n,
    });
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
    for (const key of await h.clawbackKeys(o)) {
      expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|FULL']);
    }
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      reason: 'COMMISSION_ZERO',
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CLAWED_BACK',
        event: 'COMMISSION_POSITIVE_ZERO',
      }),
    ]);
    // Only jd's >0 → 0 is held for manual review (#43); taobao registers no recon diff.
    expect(await h.reconDiffs()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#43] 京东联盟佣金由 >0 变 0（口径待 规划/09 验证）：验证前按 R8 全额扣回（金额同 #16：425 / 85 / 42、平台 448），并多登记一条指向该子订单的待复核差错单（open）',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({ platform: 'jd' });
    await h.bumpCommissionVersion(o, 3);
    const id = 'C3';

    const result = await h.apply(o, {
      cause: 'COMMISSION',
      ref: { kind: 'commission' },
      newCommissionFen: 0n,
    });

    expect(result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R8',
      rightsEventId: id,
      bookedBaseFen: 0n,
      bookedNFen: 0n,
    });
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
    for (const key of await h.clawbackKeys(o)) {
      expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|FULL']);
    }
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      reason: 'COMMISSION_ZERO',
    });
    // 待编排裁定: recon_diffs.type has no value for「京东实际佣金归零待复核」(schema CHECK lists
    // union_mismatch … estimate_changed_after_credit), so the type is not pinned here.
    expect(await h.reconDiffs()).toEqual([
      expect.objectContaining({
        type: expect.any(String),
        status: 'open',
        ref_id: expect.stringContaining(o.orderKey),
      }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#17] 原基数大于 0 而新基数为 0（N 1000 → 1，预留 1500 → B_new 0）：R8 BASE_ZERO，受益人全扣，平台冲回 447，booked_base 0、booked_n 1，应收剩 1',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    await h.bumpCommissionVersion(o, 2);
    const id = 'C2';

    const result = await h.apply(o, {
      cause: 'COMMISSION',
      ref: { kind: 'commission' },
      newCommissionFen: 1n,
    });

    expect(result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R8',
      bookedBaseFen: 0n,
      bookedNFen: 1n,
    });
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
      platformDecreaseLines(o, 447n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(1n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 1n,
      reason: 'COMMISSION_ZERO',
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({ to_status: 'CLAWED_BACK', event: 'BASE_ZERO' }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#18] 联盟佣金下调但仍有正基数（COMMISSION 600）不是逆向事件：跳过 not_reverse，什么都不写（归 R10 / BR-FUND-09）',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    h.boot();
    const before = await h.state();

    expect(
      await h.apply(o, {
        cause: 'COMMISSION',
        ref: { kind: 'commission' },
        newCommissionFen: 600n,
      }),
    ).toEqual({ outcome: 'skipped', reason: 'not_reverse' });
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#19] 联盟佣金变为负数（COMMISSION −50，含结算佣金为负）：正数部分为 0 → R8，booked 0 / 0，平台冲回 448',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const id = `C${String((await h.read(o)).commission_version)}`;

    expect(
      await h.apply(o, {
        cause: 'COMMISSION',
        ref: { kind: 'commission' },
        newCommissionFen: -50n,
      }),
    ).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R8',
      bookedBaseFen: 0n,
      bookedNFen: 0n,
    });
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.read(o)).toMatchObject({ rebate_status: 'CLAWED_BACK', booked_n_fen: 0n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#20] 整单类原因（处罚）不看联盟新佣金：PUNISH 带 ① 600 仍按 N_new = 0 全额扣回（R8，sub_type PUNISH，键 R{id}）',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const rightsId = await h.rights(o, { type: 'PUNISH' });
    const id = `R${rightsId}`;

    expect(
      await h.apply(o, {
        cause: 'PUNISH',
        ref: { kind: 'rights', orderRightsId: rightsId },
        newCommissionFen: 600n,
      }),
    ).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R8',
      bookedBaseFen: 0n,
      bookedNFen: 0n,
    });
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    for (const key of await h.clawbackKeys(o)) {
      expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|PUNISH']);
    }
    expect(await h.read(o)).toMatchObject({ rebate_status: 'CLAWED_BACK', reason: 'PUNISH' });
  },
  TIMEOUT,
);
