// B2-04q rule tests: the in-lock re-verification of BR-FUND-04 ⑫ (order CREDITED, rights_pending
// false, settlement seq unchanged, attribution snapshot unchanged, obligation still open) and the
// BR-FUND-19 ⑤ check before writing ("跳过并告警，不写凭证"). A failed check skips and writes nothing;
// replays of a closed obligation skip as well.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  ALERT,
  TIMEOUT,
  creditKey,
  databaseFixture,
  forfeitKey,
  harness,
  type Harness,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each(['WAITING', 'VOID', 'CLAWED_BACK'])(
  '[AC-B2-04q#14] 锁内重读 rebate_status=%s（不是 CREDITED）：跳过（not_credited），什么都不写',
  async (status) => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { rebate_status: status } });
    const before = await h.state();
    expect(await h.execute(o)).toEqual({ outcome: 'skipped', reason: 'not_credited' });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.appendBeneficiaryEvent).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#15] 锁内重读 rights_pending=true：跳过（rights_pending），什么都不写',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { rights_pending: true } });
    const before = await h.state();
    expect(await h.execute(o)).toEqual({ outcome: 'skipped', reason: 'rights_pending' });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#16] 生成补记项后又到了新结算记录（最大 seq 2 ≠ 明细的 1）：跳过（settlement_changed），什么都不写',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ laterSeqs: [2] });
    expect(o.itemSeq).toBe(1);
    const before = await h.state();
    expect(await h.execute(o)).toEqual({ outcome: 'skipped', reason: 'settlement_changed' });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#17] 明细记的 seq 与当前不一致（明细 0、当前 1）：跳过（settlement_changed），什么都不写',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const before = await h.state();
    expect(await h.execute(o, { input: { expectedSettleSeq: 0 } })).toEqual({
      outcome: 'skipped',
      reason: 'settlement_changed',
    });
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#18] 归属快照已变（义务的 split_ref 不是订单当前快照引用）：跳过（snapshot_changed），什么都不写',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ obligationPatch: { split_ref: 'commission_version:9' } });
    const before = await h.state();
    expect(await h.execute(o)).toEqual({ outcome: 'skipped', reason: 'snapshot_changed' });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it.each([
  { status: 'done', closed_by: 'R10' },
  { status: 'forfeited', closed_by: 'R9' },
  { status: 'voided', closed_by: 'R8' },
])(
  '[AC-B2-04q#19] 义务已关闭（$status，$closed_by 处置）：跳过（obligation_closed），不写凭证、不改义务',
  async ({ status, closed_by }) => {
    const h = await harness(p.db);
    const o = await h.order({
      obligationPatch: {
        status,
        closed_by,
        closed_ref: '2',
        closed_at: new Date('2032-08-01T10:00:00+08:00'),
      },
    });
    const before = await h.state();
    expect(await h.execute(o)).toEqual({ outcome: 'skipped', reason: 'obligation_closed' });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

interface Breakage {
  readonly name: string;
  readonly patch?: { readonly booked_n_fen: bigint };
  readonly after?: (h: Harness, o: SeededOrder) => Promise<void>;
}

const BREAKAGES: readonly Breakage[] = [
  {
    // 直推的份额已被别的事务归了平台（FORFEIT 已写），义务却未关闭：应收 1000 ≠ 1000 − 85。
    name: '份额已归平台而义务未关',
    after: async (h, o) => {
      await h.seedVoucher(
        h.platformVoucher(
          o,
          forfeitKey(o, 'direct'),
          85n,
          'FORFEIT',
          'REBATE_CREDIT',
          null,
          'forfeit_reason=banned',
        ),
      );
    },
  },
  {
    // booked_n_fen 与凭证对不上：应收 915 ≠ 1100 − 85。
    name: 'booked_n_fen 与应收不符',
    patch: { booked_n_fen: 1100n },
  },
];

it.each(BREAKAGES)(
  '[AC-B2-04q#20] 执行前 BR-FUND-19 ⑤ 不成立（$name）：跳过（invariant_mismatch）并告警，不写凭证、不改义务',
  async ({ patch, after }) => {
    const h = await harness(p.db);
    const o = await h.order(patch === undefined ? {} : { patch });
    if (after !== undefined) await after(h, o);
    const before = await h.state();
    expect(await h.execute(o)).toEqual({ outcome: 'skipped', reason: 'invariant_mismatch' });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.appendBeneficiaryEvent).not.toHaveBeenCalled();

    const alerts = h.alerts();
    expect(alerts).toHaveLength(1);
    expect(Number(alerts[0]?.['level'])).toBeGreaterThanOrEqual(40);
    expect(alerts[0]).toMatchObject({
      alert: ALERT,
      app_id: h.appId,
      order_id: o.orderId,
      beneficiary_credit_id: o.obligation().beneficiaryCreditId,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#37] 执行前 BR-FUND-19 ⑤ 后半句不成立（应收等式仍成立，但受益人净额合计 967 > booked_base_fen 850）：跳过（invariant_mismatch）并告警，不写凭证、不改义务',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    // One adjustment that moved 500 of the platform's part to self: self +500, platform −500, so
    // the receivable stays 915 = 1000 − 85 while self's net becomes 925 (925 + 42 > 850).
    const owner = { userId: o.user('self'), role: 'self' as const };
    await h.seedVoucher(
      h.userVoucher(
        o,
        `${o.orderKey}:${owner.userId}:self:ADJ:3`,
        owner,
        500n,
        'SETTLE_ADJUST',
        'SETTLE_ADJUST',
        'SETTLE_DIFF',
      ),
    );
    await h.seedVoucher(
      h.platformVoucher(
        o,
        `${o.orderKey}:PLATFORM:ADJ:3`,
        -500n,
        'SETTLE_ADJUST',
        'SETTLE_ADJUST',
        'SETTLE_DIFF',
      ),
    );
    expect((await h.nets(o)).union_receivable_net_fen).toBe(915n);
    expect(await h.netOf(o, 'self')).toBe(925n);
    expect(await h.netOf(o, 'direct')).toBe(0n);
    expect(await h.netOf(o, 'indirect')).toBe(42n);
    expect((await h.read(o)).booked_base_fen).toBe(850n);

    const before = await h.state();
    expect(await h.execute(o)).toEqual({ outcome: 'skipped', reason: 'invariant_mismatch' });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.appendBeneficiaryEvent).not.toHaveBeenCalled();
    expect(await h.obligationRow(o.obligation().beneficiaryCreditId)).toMatchObject({
      status: 'open',
      voucher_id: null,
    });

    const alerts = h.alerts();
    expect(alerts).toHaveLength(1);
    expect(Number(alerts[0]?.['level'])).toBeGreaterThanOrEqual(40);
    expect(alerts[0]).toMatchObject({
      alert: ALERT,
      app_id: h.appId,
      order_id: o.orderId,
      beneficiary_credit_id: o.obligation().beneficiaryCreditId,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#21] ⑤ 成立时不告警：正常补记没有 invariant_mismatch 告警行',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.execute(o)).toMatchObject({ outcome: 'credited', amountFen: 85n });
    expect(h.alerts()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#22] 重放：同一义务执行两次，第二次跳过（obligation_closed），凭证、余额、义务都不再变化',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.execute(o)).toMatchObject({ outcome: 'credited', amountFen: 85n });
    const after = await h.state();
    expect(await h.execute(o)).toEqual({ outcome: 'skipped', reason: 'obligation_closed' });
    expect(await h.state()).toEqual(after);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect((await h.voucherKeys()).filter((k) => k === creditKey(o, 'direct'))).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#23] 重放没收：首次入账义务没收后再执行，跳过（obligation_closed），不再追加 forfeited 事件、不写第二张 FORFEIT',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'banned' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    expect(await h.execute(o)).toMatchObject({ outcome: 'forfeited', amountFen: 85n });
    const after = await h.state();
    expect(await h.execute(o)).toEqual({ outcome: 'skipped', reason: 'obligation_closed' });
    expect(await h.state()).toEqual(after);
    expect((await h.newBeneficiaryEvents(o)).filter((e) => e.status === 'forfeited')).toHaveLength(
      1,
    );
    expect(h.appendBeneficiaryEvent).toHaveBeenCalledTimes(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#24] app_id 不匹配：抛错，两个 App 的订单、凭证、余额、义务都不变',
  async () => {
    const h = await harness(p.db);
    const other = await harness(p.db);
    const o = await h.order();
    await other.order();
    const mine = await h.state();
    const theirs = await other.state();
    h.boot();
    await expect(h.execute(o, { input: { appId: other.appId } })).rejects.toThrow();
    expect(await h.state()).toEqual(mine);
    expect(await other.state()).toEqual(theirs);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#25] 义务不属于明细所指的子订单（同 App 另一单）：抛错，两单都不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const another = await h.order();
    const before = await h.state();
    h.boot();
    await expect(h.execute(o, { input: { orderId: another.orderId } })).rejects.toThrow();
    expect(await h.state()).toEqual(before);
    expect(await h.obligationRow(o.obligation().beneficiaryCreditId)).toMatchObject({
      status: 'open',
    });
    expect(await h.obligationRow(another.obligation().beneficiaryCreditId)).toMatchObject({
      status: 'open',
    });
  },
  TIMEOUT,
);
