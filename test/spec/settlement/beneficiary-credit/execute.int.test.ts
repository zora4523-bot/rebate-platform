// B2-04q rule tests: execution of one beneficiary credit item (R5a; BR-FUND-04 ⑫; BR-CALC-13;
// BR-FUND-19 ⑤). One case per obligation kind × verdict: first_credit → CREDIT / FORFEIT,
// deferred → ADJ:DEFERRED / FORFEIT:DEFERRED, still frozen or appealing → deferred (nothing
// written); amounts are the remaining amount at execution time (booked_base_fen, not the snapshot).
// Numbers: see kit.ts (default 850 → direct 85 owed; adjustTo 1200 → 1020, a deferred direct owed 17).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  NOW,
  SETTLE_DIFF,
  TIMEOUT,
  adjDeferredKey,
  creditKey,
  databaseFixture,
  forfeitDeferredKey,
  forfeitKey,
  harness,
  platformKey,
  platformLines,
  receivable,
  userLines,
  type DeferredOrigin,
  type UserState,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04q#1] 首次入账义务、受益人已恢复正常：按剩余未履约金额 85 写 CREDIT 键凭证、余额到账，义务同事务记完成（R5a），⑤ 应收回到 booked_n',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const ob = o.obligation('direct');
    const before = await h.obligationRow(ob.beneficiaryCreditId);
    const result = await h.execute(o);

    const v = await h.voucher(creditKey(o, 'direct'));
    expect(v).toMatchObject({
      order_key: o.orderKey,
      beneficiary_user_id: o.user('direct'),
      role: 'direct',
      voucher_kind: 'CREDIT',
    });
    expect(result).toMatchObject({
      outcome: 'credited',
      beneficiaryCreditId: ob.beneficiaryCreditId,
      userId: o.user('direct'),
      role: 'direct',
      amountFen: 85n,
      voucherId: v?.id,
    });
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'direct'),
        creditKey(o, 'indirect'),
        platformKey(o),
      ].sort(),
    );
    expect(await h.voucherLines(creditKey(o, 'direct'))).toEqual(userLines(o, 'direct', 85n));
    // BR-FUND-05 分录模板：直推 REFERRAL_CREDIT / DIRECT。
    expect(await h.voucherTypes(creditKey(o, 'direct'))).toEqual(
      [`${receivable(o)}|REFERRAL_CREDIT|DIRECT`, 'USER_BALANCE|REFERRAL_CREDIT|DIRECT'].sort(),
    );
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1000n);
    expect(await h.netOf(o, 'direct')).toBe(85n);
    expect(await h.subjectNet(receivable(o))).toBe(1000n);

    expect(await h.obligationRow(ob.beneficiaryCreditId)).toEqual({
      ...before,
      status: 'done',
      closed_by: 'R5a',
      closed_ref: h.input(o).closedRef,
      closed_at: new Date(NOW),
      voucher_id: v?.id,
      row_version: before.row_version + 1,
    });
    // R5a 是状态不变的自迁移：订单仍 CREDITED，booked 不变，不设订单级 hold。
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      hold: false,
    });
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]?.[0]).toBe(h.transactions[0]);
  },
  TIMEOUT,
);

it.each<DeferredOrigin>([
  SETTLE_DIFF,
  { openedBy: 'R10', ledgerType: 'SETTLE_ADJUST', subType: 'PRICE_COMPARE' },
  { openedBy: 'R10', ledgerType: 'SETTLE_ADJUST', subType: 'PRICE_PROTECT' },
  { openedBy: 'R13', ledgerType: 'ADMIN_ADJUST', subType: 'RESTORE' },
])(
  '[AC-B2-04q#2] 延后差额义务（开立类型 $ledgerType / $subType）、受益人已恢复正常：只补剩余 17，键 ADJ:DEFERRED:{beneficiary_credit_id}，分录类型沿用开立事务，义务完成',
  async (origin) => {
    const h = await harness(p.db);
    const o = await h.order({ adjustTo: 1200n, deferred: ['direct'], origin });
    const ob = o.obligation('direct');
    expect(ob.kind).toBe('deferred');
    const before = await h.obligationRow(ob.beneficiaryCreditId);
    const result = await h.execute(o);

    const key = adjDeferredKey(o, 'direct');
    const v = await h.voucher(key);
    expect(v).toMatchObject({
      order_key: o.orderKey,
      beneficiary_user_id: o.user('direct'),
      role: 'direct',
    });
    expect(result).toMatchObject({
      outcome: 'credited',
      beneficiaryCreditId: ob.beneficiaryCreditId,
      amountFen: 17n,
      voucherId: v?.id,
    });
    expect(await h.voucherLines(key)).toEqual(userLines(o, 'direct', 17n));
    expect(await h.voucherTypes(key)).toEqual(
      [
        `${receivable(o)}|${origin.ledgerType}|${origin.subType}`,
        `USER_BALANCE|${origin.ledgerType}|${origin.subType}`,
      ].sort(),
    );
    // 首次入账的 CREDIT 只此一张；不另写 CREDIT 或 ADJ:{seq} 键。
    const keys = await h.voucherKeys();
    expect(keys.filter((k) => k === creditKey(o, 'direct'))).toHaveLength(1);
    const adjPrefix = `${o.orderKey}:${o.user('direct')}:direct:ADJ:`;
    expect(keys.filter((k) => k.startsWith(adjPrefix))).toEqual([key]);
    expect(await h.balance(o.user('direct'))).toBe(102n);
    // 凭证计入 BR-FUND-19 ④ 受益人净额与 ⑤ 应收：执行后 ⑤ 无待补记额。
    expect(await h.netOf(o, 'direct')).toBe(102n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1200n);

    expect(await h.obligationRow(ob.beneficiaryCreditId)).toEqual({
      ...before,
      status: 'done',
      closed_by: 'R5a',
      closed_ref: h.input(o).closedRef,
      closed_at: new Date(NOW),
      voucher_id: v?.id,
      row_version: before.row_version + 1,
    });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 1020n,
      booked_n_fen: 1200n,
    });
  },
  TIMEOUT,
);

it.each<{ state: UserState; reason: 'banned' | 'deleted' | 'minor' }>([
  { state: 'banned', reason: 'banned' },
  { state: 'deleting', reason: 'deleted' },
  { state: 'deleted', reason: 'deleted' },
  { state: 'minor', reason: 'minor' },
])(
  '[AC-B2-04q#3] 首次入账义务、直推锁后重读为 $state：首次整份没收，写 PLATFORM:FORFEIT:{uid}:{role}（借应收 / 贷收入，带 $reason），追加 forfeited 事件，义务记没收',
  async ({ state, reason }) => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    const ob = o.obligation('direct');
    const before = await h.obligationRow(ob.beneficiaryCreditId);
    const result = await h.execute(o);

    const v = await h.voucher(forfeitKey(o, 'direct'));
    expect(v).toMatchObject({ order_key: o.orderKey, voucher_kind: 'FORFEIT' });
    expect(v?.memo ?? '').toContain(reason);
    expect(result).toMatchObject({
      outcome: 'forfeited',
      beneficiaryCreditId: ob.beneficiaryCreditId,
      userId: o.user('direct'),
      role: 'direct',
      amountFen: 85n,
      forfeitReason: reason,
      voucherId: v?.id,
    });
    expect(await h.voucherLines(forfeitKey(o, 'direct'))).toEqual(platformLines(o, 85n));
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'indirect'),
        platformKey(o),
        forfeitKey(o, 'direct'),
      ].sort(),
    );
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.netOf(o, 'direct')).toBe(0n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1000n);
    expect(await h.subjectNet('COMMISSION_REVENUE')).toBe(-533n);

    expect(await h.newBeneficiaryEvents(o)).toEqual([
      expect.objectContaining({
        user_id: o.user('direct'),
        role: 'direct',
        status: 'forfeited',
        reason,
      }),
    ]);
    expect(h.appendBeneficiaryEvent).toHaveBeenCalledWith(
      h.transactions[0],
      expect.objectContaining({
        orderId: o.orderId,
        userId: o.user('direct'),
        status: 'forfeited',
      }),
    );
    expect(await h.obligationRow(ob.beneficiaryCreditId)).toEqual({
      ...before,
      status: 'forfeited',
      closed_by: 'R5a',
      closed_ref: h.input(o).closedRef,
      closed_at: new Date(NOW),
      voucher_id: v?.id,
      row_version: before.row_version + 1,
    });
  },
  TIMEOUT,
);

it.each<{ state: UserState; reason: 'banned' | 'deleted' | 'minor' }>([
  { state: 'banned', reason: 'banned' },
  { state: 'deleting', reason: 'deleted' },
  { state: 'minor', reason: 'minor' },
])(
  '[AC-B2-04q#4] 延后差额义务、直推锁后重读为 $state：只没收剩余 17，写 PLATFORM:FORFEIT:{uid}:{role}:DEFERRED:{id}，不追加 forfeited 事件，已入账的 85 不动',
  async ({ state, reason }) => {
    const h = await harness(p.db);
    const o = await h.order({
      adjustTo: 1200n,
      deferred: ['direct'],
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    const ob = o.obligation('direct');
    const before = await h.obligationRow(ob.beneficiaryCreditId);
    const result = await h.execute(o);

    const key = forfeitDeferredKey(o, 'direct');
    const v = await h.voucher(key);
    expect(v).toMatchObject({ order_key: o.orderKey, voucher_kind: 'FORFEIT' });
    expect(v?.memo ?? '').toContain(reason);
    expect(result).toMatchObject({
      outcome: 'forfeited',
      beneficiaryCreditId: ob.beneficiaryCreditId,
      amountFen: 17n,
      forfeitReason: reason,
      voucherId: v?.id,
    });
    expect(await h.voucherLines(key)).toEqual(platformLines(o, 17n));
    // 不是首次整份没收：没有 PLATFORM:FORFEIT:{uid}:{role} 键，也没有新的受益人凭证。
    const keys = await h.voucherKeys();
    expect(keys).not.toContain(forfeitKey(o, 'direct'));
    const beneficiaryPrefix = `${o.orderKey}:${o.user('direct')}:direct:`;
    expect(keys.filter((k) => k.startsWith(beneficiaryPrefix))).toEqual([creditKey(o, 'direct')]);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.netOf(o, 'direct')).toBe(85n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1200n);

    expect((await h.newBeneficiaryEvents(o)).filter((e) => e.status === 'forfeited')).toEqual([]);
    expect(h.appendBeneficiaryEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'forfeited' }),
    );
    expect(await h.obligationRow(ob.beneficiaryCreditId)).toEqual({
      ...before,
      status: 'forfeited',
      closed_by: 'R5a',
      closed_ref: h.input(o).closedRef,
      closed_at: new Date(NOW),
      voucher_id: v?.id,
      row_version: before.row_version + 1,
    });
  },
  TIMEOUT,
);

it.each<{ state: 'frozen' | 'appealing'; kind: 'first_credit' | 'deferred'; owed: bigint }>([
  { state: 'frozen', kind: 'first_credit', owed: 85n },
  { state: 'appealing', kind: 'first_credit', owed: 85n },
  { state: 'frozen', kind: 'deferred', owed: 17n },
  { state: 'appealing', kind: 'deferred', owed: 17n },
])(
  '[AC-B2-04q#5] $kind 义务、直推仍 $state：结果 deferred（金额 $owed），不写凭证、余额、事件，义务保持 open 不变',
  async ({ state, kind, owed }) => {
    const h = await harness(p.db);
    const people = [
      { role: 'self' as const, ratioBp: 5000 },
      { role: 'direct' as const, ratioBp: 1000, state },
      { role: 'indirect' as const, ratioBp: 500 },
    ];
    const o =
      kind === 'first_credit'
        ? await h.order({ people })
        : await h.order({ people, adjustTo: 1200n, deferred: ['direct'] });
    const ob = o.obligation('direct');
    const before = await h.state();
    const result = await h.execute(o);

    expect(result).toMatchObject({
      outcome: 'deferred',
      beneficiaryCreditId: ob.beneficiaryCreditId,
      userId: o.user('direct'),
      role: 'direct',
      amountFen: owed,
    });
    expect(h.post).not.toHaveBeenCalled();
    expect(await h.state()).toEqual(before);
    expect(await h.obligationRow(ob.beneficiaryCreditId)).toMatchObject({
      status: 'open',
      closed_by: null,
      closed_at: null,
      voucher_id: null,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#6] 注销冷静期（deletion_requests.status=cooling）不算失效：照常补记 CREDIT 85，义务完成',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'cooling' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    expect(await h.execute(o)).toMatchObject({ outcome: 'credited', amountFen: 85n });
    expect(await h.voucherLines(creditKey(o, 'direct'))).toEqual(userLines(o, 'direct', 85n));
    expect(await h.voucherKeys()).not.toContain(forfeitKey(o, 'direct'));
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.obligationRow(o.obligation().beneficiaryCreditId)).toMatchObject({
      status: 'done',
    });
    expect((await h.newBeneficiaryEvents(o)).filter((e) => e.status === 'forfeited')).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#7] 已识别未成年人只没收推广份额：本人（self）的首次入账义务照常补记 425（REBATE_CREDIT），不没收',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      held: ['self'],
      people: [
        { role: 'self', ratioBp: 5000, state: 'minor' },
        { role: 'direct', ratioBp: 1000 },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    expect((await h.nets(o)).union_receivable_net_fen).toBe(575n);
    expect(await h.execute(o)).toMatchObject({
      outcome: 'credited',
      userId: o.user('self'),
      role: 'self',
      amountFen: 425n,
    });
    expect(await h.voucherLines(creditKey(o, 'self'))).toEqual(userLines(o, 'self', 425n));
    expect(await h.voucherTypes(creditKey(o, 'self'))).toEqual(
      [`${receivable(o)}|REBATE_CREDIT|`, 'USER_BALANCE|REBATE_CREDIT|'].sort(),
    );
    expect(await h.voucherKeys()).not.toContain(forfeitKey(o, 'self'));
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1000n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#8] 剩余未履约金额为 0（booked_base_fen=0）且受益人正常：不写凭证，义务同样记完成，voucher_id 为空',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ reserveBp: 10000 });
    expect(o.bookedBaseFen).toBe(0n);
    const ob = o.obligation('direct');
    const before = await h.state();
    const result = await h.execute(o);
    expect(result).toMatchObject({
      outcome: 'credited',
      beneficiaryCreditId: ob.beneficiaryCreditId,
      amountFen: 0n,
      voucherId: null,
    });
    expect(h.post).not.toHaveBeenCalled();
    const after = await h.state();
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.lines).toEqual(before.lines);
    expect(after.balances).toEqual(before.balances);
    expect(await h.obligationRow(ob.beneficiaryCreditId)).toMatchObject({
      status: 'done',
      closed_by: 'R5a',
      closed_ref: h.input(o).closedRef,
      closed_at: new Date(NOW),
      voucher_id: null,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#9] 剩余未履约金额为 0 且受益人已封禁：不写 FORFEIT 凭证，义务记没收，首次入账义务仍追加 forfeited（banned）事件',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      reserveBp: 10000,
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'banned' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    const ob = o.obligation('direct');
    const before = await h.state();
    expect(await h.execute(o)).toMatchObject({
      outcome: 'forfeited',
      beneficiaryCreditId: ob.beneficiaryCreditId,
      amountFen: 0n,
      forfeitReason: 'banned',
      voucherId: null,
    });
    expect(h.post).not.toHaveBeenCalled();
    expect((await h.state()).vouchers).toEqual(before.vouchers);
    expect(await h.obligationRow(ob.beneficiaryCreditId)).toMatchObject({
      status: 'forfeited',
      closed_by: 'R5a',
      voucher_id: null,
    });
    expect(await h.newBeneficiaryEvents(o)).toEqual([
      expect.objectContaining({ user_id: o.user('direct'), status: 'forfeited', reason: 'banned' }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#10] 同键 CREDIT 已存在而义务未关（⑤ 仍成立、剩余 0）：不写第二张、余额只入一次，义务记完成',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const direct = { userId: o.user('direct'), role: 'direct' as const };
    await h.seedVoucher(
      h.userVoucher(o, creditKey(o, 'direct'), direct, 85n, 'CREDIT', 'REFERRAL_CREDIT', 'DIRECT'),
    );
    expect(await h.balance(direct.userId)).toBe(85n);
    const before = await h.state();

    expect(await h.execute(o)).toMatchObject({
      outcome: 'credited',
      amountFen: 0n,
      voucherId: null,
    });
    const after = await h.state();
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.lines).toEqual(before.lines);
    expect(await h.balance(direct.userId)).toBe(85n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1000n);
    expect(await h.obligationRow(o.obligation().beneficiaryCreditId)).toMatchObject({
      status: 'done',
      voucher_id: null,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#11] 金额按执行时的 booked_base_fen 重算：暂缓期间正差到账（booked_base 850 → 1020），首次入账义务补 102，不是 85，也不是快照 base 的份额',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ held: ['direct'], adjustTo: 1200n });
    expect(o.bookedBaseFen).toBe(1020n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1098n);
    expect(await h.execute(o)).toMatchObject({ outcome: 'credited', amountFen: 102n });
    expect(await h.voucherLines(creditKey(o, 'direct'))).toEqual(userLines(o, 'direct', 102n));
    expect(await h.balance(o.user('direct'))).toBe(102n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1200n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#12] 同单两个未完成义务：执行直推时间推义务的待补记额仍计入 ⑤，间推义务不动；再执行间推后应收 = booked_n',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ held: ['direct', 'indirect'] });
    expect((await h.nets(o)).union_receivable_net_fen).toBe(873n);
    const indirect = o.obligation('indirect');
    const indirectBefore = await h.obligationRow(indirect.beneficiaryCreditId);

    expect(await h.execute(o, { role: 'direct' })).toMatchObject({
      outcome: 'credited',
      role: 'direct',
      amountFen: 85n,
    });
    expect(await h.obligationRow(indirect.beneficiaryCreditId)).toEqual(indirectBefore);
    expect(await h.balance(o.user('indirect'))).toBe(0n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(958n);

    expect(await h.execute(o, { role: 'indirect' })).toMatchObject({
      outcome: 'credited',
      role: 'indirect',
      amountFen: 42n,
    });
    expect(await h.voucherLines(creditKey(o, 'indirect'))).toEqual(userLines(o, 'indirect', 42n));
    expect((await h.nets(o)).union_receivable_net_fen).toBe(1000n);
    expect((await h.obligations()).map((row) => row.status)).toEqual(['done', 'done']);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04q#13] 大额 N = 100 亿分（> 2^32）：booked_base 8_500_000_000，直推补记 850_000_000，金额全程 bigint',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ settleFen: 10_000_000_000n });
    expect(await h.execute(o)).toMatchObject({ outcome: 'credited', amountFen: 850_000_000n });
    expect(await h.voucherLines(creditKey(o, 'direct'))).toEqual(
      userLines(o, 'direct', 850_000_000n),
    );
    expect(await h.balance(o.user('direct'))).toBe(850_000_000n);
    expect((await h.nets(o)).union_receivable_net_fen).toBe(10_000_000_000n);
  },
  TIMEOUT,
);
