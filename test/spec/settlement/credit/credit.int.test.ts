// B2-04m rule tests: R5 credit of one WAITING sub-order (BR-FUND-01 R5, BR-FUND-04 ⑦,
// BR-FUND-05, BR-FUND-16 细则「加锁流程」). Example: N = 1000, reserve_bp = 1500 → B = 850,
// reserve 150; self 5000 / direct 1000 / indirect 500 → 425 / 85 / 42; platform 298 + 150 = 448.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  NOW,
  TIMEOUT,
  creditKey,
  databaseFixture,
  forfeitKey,
  harness,
  platformKey,
  platformLines,
  receivable,
  tracing,
  userCreditLines,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04m#1] WAITING 单全额入账：三张受益人 CREDIT 凭证 + 平台凭证（留存+预留），余额、booked 成对写、CREDITED、历史与 order.credited 同事务',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const initial = await h.read(o);
    const result = await h.credit(o);

    expect(result).toMatchObject({
      outcome: 'credited',
      orderKey: o.orderKey,
      bCreditFen: 850n,
      bookedNFen: 1000n,
      platformCreditFen: 448n,
    });
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'direct'),
        creditKey(o, 'indirect'),
        platformKey(o),
      ].sort(),
    );
    expect(await h.voucherLines(creditKey(o, 'self'))).toEqual(userCreditLines(o, 'self', 425n));
    expect(await h.voucherLines(creditKey(o, 'direct'))).toEqual(userCreditLines(o, 'direct', 85n));
    expect(await h.voucherLines(creditKey(o, 'indirect'))).toEqual(
      userCreditLines(o, 'indirect', 42n),
    );
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 448n));
    for (const v of await h.vouchers()) {
      expect(v.order_key, v.uniq_key).toBe(o.orderKey);
    }
    for (const role of ['self', 'direct', 'indirect'] as const) {
      const v = (await h.vouchers()).find((row) => row.uniq_key === creditKey(o, role));
      expect(v).toMatchObject({ beneficiary_user_id: o.user(role), role });
    }
    // BR-FUND-05 / BR-FUND-19 ⑤ 凭证类型：受益人入账与平台（留存 + 预留）都是 CREDIT；平台凭证不带
    // 受益人键（不计入受益人净额）。
    const kinds = Object.fromEntries(
      (await h.vouchers()).map((v) => [
        v.uniq_key,
        { kind: v.voucher_kind, user: v.beneficiary_user_id, role: v.role },
      ]),
    );
    expect(kinds).toEqual({
      [creditKey(o, 'self')]: { kind: 'CREDIT', user: o.user('self'), role: 'self' },
      [creditKey(o, 'direct')]: { kind: 'CREDIT', user: o.user('direct'), role: 'direct' },
      [creditKey(o, 'indirect')]: { kind: 'CREDIT', user: o.user('indirect'), role: 'indirect' },
      [platformKey(o)]: { kind: 'CREDIT', user: null, role: null },
    });
    // BR-FUND-05 分录模板：自购 REBATE_CREDIT，直推 / 间推 REFERRAL_CREDIT。
    const userLines = (await h.lines()).filter((l) => l.subject === 'USER_BALANCE');
    expect(userLines.find((l) => l.owner_id === o.user('self'))).toMatchObject({
      ledger_type: 'REBATE_CREDIT',
    });
    expect(userLines.find((l) => l.owner_id === o.user('direct'))).toMatchObject({
      ledger_type: 'REFERRAL_CREDIT',
      sub_type: 'DIRECT',
    });
    expect(userLines.find((l) => l.owner_id === o.user('indirect'))).toMatchObject({
      ledger_type: 'REFERRAL_CREDIT',
      sub_type: 'INDIRECT',
    });
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
    expect(await h.subjectNet('COMMISSION_REVENUE')).toBe(-448n);

    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      hold: false,
      rights_pending: false,
      row_version: initial.row_version + 1,
      settle_commission_fen: 1000n,
    });
    expect(await h.history(o)).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'WAITING',
        to_status: 'CREDITED',
        event: 'SETTLE_BATCH_CREDIT',
        source: 'system',
        at: new Date(NOW),
      }),
    ]);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledWith(
      h.transactions[0],
      expect.objectContaining({
        appId: h.appId,
        name: 'order.credited',
        payload: expect.objectContaining({ order_id: o.orderId }),
      }),
    );
    expect((await h.published()).map((e) => e.name)).toEqual(['order.credited']);
    expect(await h.obligations()).toEqual([]);
    expect(await h.newBeneficiaryEvents(o)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#2] 加锁流程：order_key advisory → users 行（经 BeneficiaryGate / identity 端口）→ 余额行 → 锁后重读状态 → 记账；订单在 advisory 之后重读',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const traced = tracing(p.db);
    await h.credit(o, { via: traced.db });

    const ids = o.people.map((person) => person.userId);
    expect(h.lockUsers).toHaveBeenCalled();
    expect(h.lockUsers.mock.calls[0]?.[1]).toMatchObject({ appId: h.appId });
    expect(h.lockUsers.mock.calls[0]?.[1]?.userIds).toEqual(expect.arrayContaining(ids));
    expect(h.identityLock).toHaveBeenCalled();
    expect(h.identityLock.mock.calls[0]?.[1]?.userIds).toEqual(expect.arrayContaining(ids));
    expect(h.lockBalances.mock.calls[0]?.[1]?.userIds).toEqual(expect.arrayContaining(ids));
    expect(h.readStates.mock.calls[0]?.[1]?.userIds).toEqual(expect.arrayContaining(ids));

    const firstUsers = Math.min(...h.lockUsers.mock.invocationCallOrder);
    const firstBalances = Math.min(...h.lockBalances.mock.invocationCallOrder);
    const lastBalances = Math.max(...h.lockBalances.mock.invocationCallOrder);
    const firstStates = Math.min(...h.readStates.mock.invocationCallOrder);
    const firstPost = Math.min(...h.post.mock.invocationCallOrder);
    const lastPost = Math.max(...h.post.mock.invocationCallOrder);
    expect(firstUsers).toBeLessThan(firstBalances);
    expect(firstBalances).toBeLessThan(firstStates);
    expect(lastBalances).toBeLessThan(firstPost);
    expect(firstStates).toBeLessThan(firstPost);
    expect(Math.min(...h.publish.mock.invocationCallOrder)).toBeGreaterThan(lastPost);
    expect(h.post).toHaveBeenCalledTimes(4);

    const statements = traced.queries.map((q) => q.sql);
    const advisory = statements.findIndex((s) => /pg_advisory_xact_lock/i.test(s));
    const usersLock = statements.findIndex(
      (s) => /from\s+(?:"app"\.)?"users"/i.test(s) && /for no key update/i.test(s),
    );
    const reread = statements.findIndex(
      (s, i) => i > advisory && /from\s+(?:"app"\.)?"orders"/i.test(s),
    );
    const firstVoucher = statements.findIndex((s) =>
      /insert\s+into\s+(?:"app"\.)?"ledger_vouchers"/i.test(s),
    );
    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(usersLock).toBeGreaterThan(advisory);
    expect(reread).toBeGreaterThan(advisory);
    expect(firstVoucher).toBeGreaterThan(usersLock);
    // One transaction: every collaborator got the caller's transaction object.
    const trx = h.transactions[0];
    for (const call of [
      ...h.lockUsers.mock.calls,
      ...h.lockBalances.mock.calls,
      ...h.readStates.mock.calls,
      ...h.post.mock.calls,
      ...h.publish.mock.calls,
    ]) {
      expect(call[0]).toBe(trx);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#3] 重放：已 CREDITED 再执行只跳过（not_waiting），凭证、余额、历史、事件都不再增加',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
    const after = await h.state();
    expect(await h.credit(o)).toEqual({ outcome: 'skipped', reason: 'not_waiting' });
    expect(await h.state()).toEqual(after);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(await h.balance(o.user('self'))).toBe(425n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#4] uniq_key 已存在视为已入账：同键凭证不再写第二张，余额只入一次，订单照常 CREDITED',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const self = o.user('self');
    const accountId = h.accounts.get(self);
    if (accountId === undefined) throw new Error('self has no account');
    // An earlier attempt left the self CREDIT voucher under the BR-FUND-05 key.
    await p.db.transaction().execute(async (trx) => {
      await h.ledger.lockBalances(trx, { appId: h.appId, userIds: [self] });
      await h.ledger.post(trx, {
        appId: h.appId,
        uniqKey: creditKey(o, 'self'),
        bizType: 'ORDER_CREDIT',
        bizId: o.orderKey,
        operator: 'system',
        memo: null,
        orderKey: o.orderKey,
        beneficiaryUserId: self,
        role: 'self',
        voucherKind: null,
        entries: [
          {
            account: { ownerType: 'platform', subject: receivable(o) },
            sub_account: 'available',
            amount_fen: 425n,
            ledger_type: 'REBATE_CREDIT',
            sub_type: null,
            income_type: null,
          },
          {
            account: { ownerType: 'user', accountId },
            sub_account: 'available',
            amount_fen: -425n,
            ledger_type: 'REBATE_CREDIT',
            sub_type: null,
            income_type: null,
          },
        ],
      });
    });
    expect(await h.balance(self)).toBe(425n);

    expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
    expect((await h.vouchers()).filter((v) => v.uniq_key === creditKey(o, 'self'))).toHaveLength(1);
    expect(await h.balance(self)).toBe(425n);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
    expect(await h.read(o)).toMatchObject({ rebate_status: 'CREDITED', booked_base_fen: 850n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#5] 锁内重读 hold=true：跳过（hold），不写任何凭证、余额、义务、事件与订单列',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { hold: true, hold_reason: 'CS' } });
    const before = await h.state();
    expect(await h.credit(o)).toEqual({ outcome: 'skipped', reason: 'hold' });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#6] 锁内重读 rights_pending=true：跳过（rights_pending），什么都不写',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { rights_pending: true } });
    const before = await h.state();
    expect(await h.credit(o)).toEqual({ outcome: 'skipped', reason: 'rights_pending' });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it.each(['ESTIMATED', 'CREDITED', 'VOID', 'CLAWED_BACK'])(
  '[AC-B2-04m#7] 锁内重读 rebate_status=%s（不是 WAITING）：跳过（not_waiting），什么都不写',
  async (status) => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { rebate_status: status } });
    const before = await h.state();
    expect(await h.credit(o)).toEqual({ outcome: 'skipped', reason: 'not_waiting' });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#8] 校验后又到了新结算记录（seq 2 ≠ 校验时的 1）：跳过（settlement_changed），什么都不写',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ seqs: [1, 2] });
    const before = await h.state();
    expect(await h.credit(o, { input: { expectedSettleSeq: 1 } })).toEqual({
      outcome: 'skipped',
      reason: 'settlement_changed',
    });
    expect(await h.state()).toEqual(before);
    expect(h.post).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#9] 没有任何结算记录：seq 对不上，跳过（settlement_changed），不按预估入账',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ seqs: [] });
    const before = await h.state();
    expect(await h.credit(o, { input: { expectedSettleSeq: 1 } })).toEqual({
      outcome: 'skipped',
      reason: 'settlement_changed',
    });
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#10] 跨平台同号子订单各自入账：order_key 带平台，凭证键不撞，各自 booked',
  async () => {
    const h = await harness(p.db);
    const sub = `same-${o4()}`;
    const taobao = await h.order({ platform: 'taobao', subOrderId: sub });
    const jd = await h.order({ platform: 'jd', subOrderId: sub });
    expect(await h.credit(taobao)).toMatchObject({
      outcome: 'credited',
      orderKey: `taobao:${sub}`,
    });
    expect(await h.credit(jd)).toMatchObject({ outcome: 'credited', orderKey: `jd:${sub}` });
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(taobao, 'self'),
        creditKey(taobao, 'direct'),
        creditKey(taobao, 'indirect'),
        platformKey(taobao),
        creditKey(jd, 'self'),
        creditKey(jd, 'direct'),
        creditKey(jd, 'indirect'),
        platformKey(jd),
      ].sort(),
    );
    expect(await h.subjectNet('UNION_RECEIVABLE:taobao')).toBe(1000n);
    expect(await h.subjectNet('UNION_RECEIVABLE:jd')).toBe(1000n);
    expect(await h.read(taobao)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_n_fen: 1000n,
    });
    expect(await h.read(jd)).toMatchObject({ rebate_status: 'CREDITED', booked_n_fen: 1000n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#11] app_id 不匹配：抛错，两个 App 的订单、凭证、余额都不变',
  async () => {
    const h = await harness(p.db);
    const other = await harness(p.db);
    const o = await h.order();
    const theirs = await other.order();
    const mine = await h.state();
    const before = await other.state();
    h.boot();
    await expect(h.credit(o, { input: { appId: other.appId } })).rejects.toThrow();
    expect(await h.state()).toEqual(mine);
    expect(await other.state()).toEqual(before);
    expect(await other.read(theirs)).toMatchObject({ rebate_status: 'WAITING' });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#12] B_credit=0 而预留>0（reserve_bp=10000）：受益人份额 0 不写凭证，只写平台凭证（预留）',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ reserveBp: 10000 });
    expect(await h.credit(o)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 0n,
      bookedNFen: 1000n,
      platformCreditFen: 1000n,
    });
    expect(await h.voucherKeys()).toEqual([platformKey(o)]);
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 1000n));
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 0n,
      booked_n_fen: 1000n,
    });
    expect(await h.obligations()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#13] 结算佣金为负：B 与预留都为 0，不写任何凭证，只迁移到 CREDITED，booked 成对写 0',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ settleFen: -50n });
    expect(await h.credit(o)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 0n,
      bookedNFen: 0n,
      platformCreditFen: 0n,
    });
    expect(await h.vouchers()).toEqual([]);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
    });
    expect(await h.history(o)).toEqual([
      expect.objectContaining({ from_status: 'WAITING', to_status: 'CREDITED' }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#38] 凭证类型按 BR-FUND-05：受益人 CREDIT、平台留存 + 预留一张 PLATFORM:CREDIT（CREDIT，无受益人键）、被剥夺份额一张平台 FORFEIT',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000 },
        { role: 'indirect', ratioBp: 500, state: 'banned' },
      ],
    });
    expect(await h.credit(o)).toMatchObject({ outcome: 'credited', platformCreditFen: 448n });
    const vouchers = await h.vouchers();
    expect(Object.fromEntries(vouchers.map((v) => [v.uniq_key, v.voucher_kind]))).toEqual({
      [creditKey(o, 'self')]: 'CREDIT',
      [creditKey(o, 'direct')]: 'CREDIT',
      [platformKey(o)]: 'CREDIT',
      [forfeitKey(o, 'indirect')]: 'FORFEIT',
    });
    expect(vouchers.find((v) => v.uniq_key === platformKey(o))).toMatchObject({
      order_key: o.orderKey,
      beneficiary_user_id: null,
      role: null,
    });
    expect(vouchers.find((v) => v.uniq_key === forfeitKey(o, 'indirect'))).toMatchObject({
      order_key: o.orderKey,
    });
    expect(await h.voucherLines(forfeitKey(o, 'indirect'))).toEqual(platformLines(o, 42n));
  },
  TIMEOUT,
);

it.each([
  // N = 1000, reserve_bp 1500: floor(1000 × 8500 / 10000) = 850, reserve 150 (BR-CALC-02).
  // 淘礼金 100：B = 850 − 100 = 750 → 375 / 75 / floor(37.5) = 37。
  { tlj: 100n, base: 750n, self: 375n, direct: 75n, indirect: 37n },
  // 淘礼金 900 > 850：B = max(0, 850 − 900) = 0，受益人都不入账。
  { tlj: 900n, base: 0n, self: 0n, direct: 0n, indirect: 0n },
])(
  '[AC-B2-04m#39] 淘礼金正常模式扣减 $tlj：经 readTljDeductFen 在本事务读取扣减额，B_credit = $base，受益人按扣减后的 B 拆分',
  async ({ tlj, base, self, direct, indirect }) => {
    const h = await harness(p.db);
    const o = await h.order({ tljDeductFen: tlj });
    const result = await h.credit(o);
    expect(result).toMatchObject({ outcome: 'credited', bCreditFen: base, bookedNFen: 1000n });

    expect(h.readTljDeductFen).toHaveBeenCalledWith(
      h.transactions[0],
      expect.objectContaining({ appId: h.appId, orderId: o.orderId, commissionVersion: 1 }),
    );
    expect(Math.min(...h.readTljDeductFen.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...h.post.mock.invocationCallOrder),
    );

    const shares = { self, direct, indirect };
    const userKeys: string[] = [];
    for (const role of ['self', 'direct', 'indirect'] as const) {
      expect(await h.balance(o.user(role))).toBe(shares[role]);
      if (shares[role] > 0n) {
        userKeys.push(creditKey(o, role));
        expect(await h.voucherLines(creditKey(o, role))).toEqual(
          userCreditLines(o, role, shares[role]),
        );
      }
    }
    const keys = await h.voucherKeys();
    expect(keys.filter((k) => k !== platformKey(o))).toEqual(userKeys.sort());
    // 平台凭证存在（留存 + 预留 150 > 0）；扣减额本身的去向在规则里未写明（BR-FUND-05 平台凭证
    // = 留存 + 预留，BR-FUND-19 ⑤ 应收 = booked_n_fen），金额待编排裁定，本例不断言。
    expect(keys).toContain(platformKey(o));
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: base,
      booked_n_fen: 1000n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#40] 大额 N = 100 亿分（> 2^31、> 2^32）：金额全程 bigint，不截断',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ settleFen: 10_000_000_000n });
    // B = floor(10_000_000_000 × 8500 / 10000) = 8_500_000_000，预留 1_500_000_000；
    // 份额 4_250_000_000 / 850_000_000 / 425_000_000，留存 2_975_000_000，平台 4_475_000_000。
    expect(await h.credit(o)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 8_500_000_000n,
      bookedNFen: 10_000_000_000n,
      platformCreditFen: 4_475_000_000n,
    });
    expect(await h.voucherLines(creditKey(o, 'self'))).toEqual(
      userCreditLines(o, 'self', 4_250_000_000n),
    );
    expect(await h.voucherLines(creditKey(o, 'direct'))).toEqual(
      userCreditLines(o, 'direct', 850_000_000n),
    );
    expect(await h.voucherLines(creditKey(o, 'indirect'))).toEqual(
      userCreditLines(o, 'indirect', 425_000_000n),
    );
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 4_475_000_000n));
    expect(await h.balance(o.user('self'))).toBe(4_250_000_000n);
    expect(await h.subjectNet(receivable(o))).toBe(10_000_000_000n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 8_500_000_000n,
      booked_n_fen: 10_000_000_000n,
    });
  },
  TIMEOUT,
);

/** A short colon-free id fragment for sub_order_id. */
function o4(): string {
  return Math.random().toString(36).slice(2, 10);
}
