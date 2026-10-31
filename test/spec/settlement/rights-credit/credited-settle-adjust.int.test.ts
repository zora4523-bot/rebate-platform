// B2-04lb rule tests, D10-474 ② (编排裁定): on a CREDITED order whose rights success waits for the
// union (WAIT_COMMISSION, BR-FUND-08 ③), the union's new settlement record that answers it moves the
// money as R10 SETTLE_ADJUST (BR-CALC-23 (a); BR-FUND-08「联盟新的结算记录带来的变化按 BR-FUND-09 与迁移
// R10 处理（负差即时写负向 SETTLE_ADJUST…）」), not as an R9 CLAWBACK; R9 stays for a rights success
// that carries its deduction. Same sync transaction: the WAIT_COMMISSION record is closed.
// Voucher keys follow the SETTLE_ADJUST templates (packages/domain ledger templates):
// `{order_key}:{user_id}:{role}:ADJ:{seq}` and `{order_key}:PLATFORM:ADJ:{seq}`, seq = the new
// order_settlements seq. Negative differences: debit USER_BALANCE / credit UNION_RECEIVABLE (user),
// debit COMMISSION_REVENUE / credit UNION_RECEIVABLE (platform). sub_type is not pinned here.
//
// Default order (credit kit), credited at N 1000: B 850 → 425 / 85 / 42, platform 448, receivable
// 1000.
//   New record 600 (seq 3) → B 510 → 255 / 51 / 25, platform 269: differences 170 / 34 / 17, 179.
//   New record 700 (seq 3) → B 595 → 297 / 59 / 29, platform 315: differences 128 / 26 / 13, 133.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  LATER,
  TIMEOUT,
  creditKey,
  databaseFixture,
  harness,
  platformDecreaseLines,
  platformKey,
  userClawbackLines,
  type Harness,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const ROLES = ['self', 'direct', 'indirect'] as const;
type Role = (typeof ROLES)[number];

const adjKey = (o: SeededOrder, role: Role, seq: number) =>
  `${o.orderKey}:${o.user(role)}:${role}:ADJ:${String(seq)}`;
const platformAdj = (o: SeededOrder, seq: number) => `${o.orderKey}:PLATFORM:ADJ:${String(seq)}`;

/** A credited default order whose rights success (no deduction) waits for the union commission. */
async function waitingCredited(h: Harness): Promise<{ o: SeededOrder; waitingId: string }> {
  const o = await h.credited();
  expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
  const waiting = await h.onlyRights(o);
  expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });
  await h.expectNets(o, { base: 850n, n: 1000n, self: 425n, direct: 85n, indirect: 42n });
  return { o, waitingId: waiting.id };
}

/**
 * The order's vouchers are the credit set plus exactly one R10 SETTLE_ADJUST set on `seq`, with the
 * given negative differences; no CLAWBACK voucher.
 */
async function expectSettleAdjust(
  h: Harness,
  o: SeededOrder,
  seq: number,
  diff: Readonly<Record<Role | 'platform', bigint>>,
): Promise<void> {
  const credit = [...ROLES.map((role) => creditKey(o, role)), platformKey(o)];
  const adjust = [...ROLES.map((role) => adjKey(o, role, seq)), platformAdj(o, seq)];
  expect(await h.orderVoucherKeys(o)).toEqual([...credit, ...adjust].sort());
  expect(await h.clawbackKeys(o)).toEqual([]);
  for (const role of ROLES) {
    // Debit USER_BALANCE / credit UNION_RECEIVABLE (same lines as a user decrease).
    expect(await h.voucherLines(adjKey(o, role, seq)), role).toEqual(
      userClawbackLines(o, role, diff[role]),
    );
  }
  const platformAdjLines = await h.voucherLines(platformAdj(o, seq));
  expect(platformAdjLines).toEqual(platformDecreaseLines(o, diff.platform));
  for (const key of adjust) {
    const types = await h.voucherTypes(key);
    expect(types, key).toHaveLength(1);
    expect(types[0]?.startsWith('SETTLE_ADJUST|'), `${key} ${String(types[0])}`).toBe(true);
  }
}

it(
  '[AC-B2-04lb#20] D10-474 ② 入账后 WAIT_COMMISSION 由联盟新结算记录 600（seq 3）回应 → 走 R10 SETTLE_ADJUST（不是 CLAWBACK）：同一同步事务写负向调整 170 / 34 / 17、平台 179（键 ADJ:3），净额 255 / 51 / 25、应收 600、booked 510 / 600，仍 CREDITED；该维权记录关闭为 SUCCEEDED（id 不变）、rights_pending 回到 false',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await waitingCredited(h);

    h.clock.set(LATER);
    await h.syncCredited(o, { event: 'PLATFORM_SETTLED', settleAfter: 600n, newSeq: 3 });
    await expectSettleAdjust(h, o, 3, { self: 170n, direct: 34n, indirect: 17n, platform: 179n });
    await h.expectNets(o, { base: 510n, n: 600n, self: 255n, direct: 51n, indirect: 25n });
    expect(await h.onlyRights(o)).toMatchObject({
      id: waitingId,
      status: 'SUCCEEDED',
      updated_at: new Date(LATER),
    });
    expect((await h.read(o)).rights_pending).toBe(false);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#21] D10-474 ② 新结算记录 700（seq 3）回应入账后 WAIT_COMMISSION：R10 SETTLE_ADJUST 128 / 26 / 13、平台 133（键 ADJ:3），净额 297 / 59 / 29、应收 700、booked 595 / 700；同一同步重投不再记账；之后同一维权单号再报应扣 400 → duplicate，不写 CLAWBACK、什么都不变',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await waitingCredited(h);

    h.clock.set(LATER);
    const arrival = await h.syncCredited(o, {
      event: 'PLATFORM_SETTLED',
      settleAfter: 700n,
      newSeq: 3,
    });
    await expectSettleAdjust(h, o, 3, { self: 128n, direct: 26n, indirect: 13n, platform: 133n });
    await h.expectNets(o, { base: 595n, n: 700n, self: 297n, direct: 59n, indirect: 29n });
    expect(await h.onlyRights(o)).toMatchObject({ id: waitingId, status: 'SUCCEEDED' });
    expect((await h.read(o)).rights_pending).toBe(false);

    const settled = await h.moneyState(o);
    await h.deliver(arrival.change, arrival.source);
    expect(await h.moneyState(o)).toEqual(settled);

    const closed = await h.everything();
    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'duplicate' });
    expect(await h.everything()).toEqual(closed);
    await expectSettleAdjust(h, o, 3, { self: 128n, direct: 26n, indirect: 13n, platform: 133n });
  },
  TIMEOUT,
);
