// B2-04m rule tests: per-beneficiary verdicts of BR-CALC-13 inside the credit transaction
// (states re-read after the locks), BR-FUND-04 ⑩ (held ones only are deferred) and ⑫ (a held
// beneficiary with a positive share gets a first_credit obligation), BR-FUND-05 (FORFEIT vouchers).
// Example as in credit.int.test.ts: B = 850 → self 425, direct 85, indirect 42, platform 448.
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
  userCreditLines,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

it.each(['frozen', 'appealing'] as const)(
  '[AC-B2-04m#14] 直推受益人锁后重读为 %s：只暂缓本人（held 事件 + first_credit 义务），其余照常入账，应收 = N − 暂缓份额',
  async (state) => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    const result = await h.credit(o);

    expect(await h.voucherKeys()).toEqual(
      [creditKey(o, 'self'), creditKey(o, 'indirect'), platformKey(o)].sort(),
    );
    expect(await h.voucherLines(creditKey(o, 'self'))).toEqual(userCreditLines(o, 'self', 425n));
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 448n));
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
    expect(await h.subjectNet(receivable(o))).toBe(915n);

    const obligations = await h.obligations();
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({
      app_id: h.appId,
      order_id: o.orderId,
      user_id: o.user('direct'),
      role: 'direct',
      kind: 'first_credit',
      opened_by: 'R5',
      opened_ref: h.input(o).openedRef,
      status: 'open',
      closed_by: null,
      closed_ref: null,
      closed_at: null,
      voucher_id: null,
      origin_ledger_type: null,
      origin_sub_type: null,
      opened_at: new Date(NOW),
    });
    expect(obligations[0]?.beneficiary_credit_id).toMatch(UUID);
    expect(obligations[0]?.split_ref).not.toBe('');

    expect(await h.newBeneficiaryEvents(o)).toEqual([
      expect.objectContaining({ user_id: o.user('direct'), role: 'direct', status: 'held' }),
    ]);
    expect(h.appendBeneficiaryEvent).toHaveBeenCalledWith(
      h.transactions[0],
      expect.objectContaining({ orderId: o.orderId, userId: o.user('direct'), status: 'held' }),
    );
    expect(result).toMatchObject({
      outcome: 'credited',
      bCreditFen: 850n,
      platformCreditFen: 448n,
    });
    if (result.outcome !== 'credited') throw new Error('not credited');
    expect(result.beneficiaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: o.user('direct'),
          role: 'direct',
          shareFen: 85n,
          action: 'held',
          beneficiaryCreditId: obligations[0]?.beneficiary_credit_id,
        }),
      ]),
    );
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#15] 间推受益人已封禁：不写其 CREDIT，写平台 FORFEIT 凭证（借应收 / 贷收入）并追加 forfeited（banned），不开义务',
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
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'direct'),
        platformKey(o),
        forfeitKey(o, 'indirect'),
      ].sort(),
    );
    expect(await h.voucherLines(forfeitKey(o, 'indirect'))).toEqual(platformLines(o, 42n));
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 448n));
    expect(await h.balance(o.user('indirect'))).toBe(0n);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
    expect(await h.subjectNet('COMMISSION_REVENUE')).toBe(-490n);
    expect(await h.obligations()).toEqual([]);
    expect(await h.newBeneficiaryEvents(o)).toEqual([
      expect.objectContaining({
        user_id: o.user('indirect'),
        role: 'indirect',
        status: 'forfeited',
        reason: 'banned',
      }),
    ]);
  },
  TIMEOUT,
);

it.each(['deleting', 'deleted'] as const)(
  '[AC-B2-04m#16] 直推受益人注销状态 %s：份额归平台（FORFEIT，forfeit_reason=deleted），不写其余额',
  async (state) => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'indirect'),
        platformKey(o),
        forfeitKey(o, 'direct'),
      ].sort(),
    );
    expect(await h.voucherLines(forfeitKey(o, 'direct'))).toEqual(platformLines(o, 85n));
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
    expect(await h.obligations()).toEqual([]);
    expect(await h.newBeneficiaryEvents(o)).toEqual([
      expect.objectContaining({
        user_id: o.user('direct'),
        status: 'forfeited',
        reason: 'deleted',
      }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#17] 已识别未成年：推广份额（直推）没收（minor），本人返利照常入账',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000, state: 'minor' },
        { role: 'direct', ratioBp: 1000, state: 'minor' },
        { role: 'indirect', ratioBp: 500, state: 'adult' },
      ],
    });
    expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'indirect'),
        platformKey(o),
        forfeitKey(o, 'direct'),
      ].sort(),
    );
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
    expect(await h.voucherLines(forfeitKey(o, 'direct'))).toEqual(platformLines(o, 85n));
    expect(await h.newBeneficiaryEvents(o)).toEqual([
      expect.objectContaining({ user_id: o.user('direct'), status: 'forfeited', reason: 'minor' }),
    ]);
    expect(h.minorRead).toHaveBeenCalledWith(
      h.transactions[0],
      expect.objectContaining({ appId: h.appId, at: new Date(NOW) }),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#18] 快照阶段已没收的受益人：终局不变，不写其凭证也不写 FORFEIT（份额已在平台留存里），不追加事件',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, initialStatus: 'forfeited' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    expect(await h.credit(o)).toMatchObject({ outcome: 'credited', platformCreditFen: 533n });
    expect(await h.voucherKeys()).toEqual(
      [creditKey(o, 'self'), creditKey(o, 'indirect'), platformKey(o)].sort(),
    );
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 533n));
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
    expect(await h.obligations()).toEqual([]);
    expect(await h.newBeneficiaryEvents(o)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#19] 混合：本人冻结（暂缓）、直推封禁（没收）、间推正常（入账），同一事务各按锁后状态处理',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000, state: 'frozen' },
        { role: 'direct', ratioBp: 1000, state: 'banned' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    expect(await h.credit(o)).toMatchObject({ outcome: 'credited', bCreditFen: 850n });
    expect(await h.voucherKeys()).toEqual(
      [creditKey(o, 'indirect'), platformKey(o), forfeitKey(o, 'direct')].sort(),
    );
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
    // 应收 = booked_n_fen − 待补记（本人 425）。
    expect(await h.subjectNet(receivable(o))).toBe(575n);
    const obligations = await h.obligations();
    expect(obligations).toEqual([
      expect.objectContaining({
        user_id: o.user('self'),
        role: 'self',
        kind: 'first_credit',
        status: 'open',
      }),
    ]);
    const events = await h.newBeneficiaryEvents(o);
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: o.user('self'), status: 'held' }),
        expect.objectContaining({
          user_id: o.user('direct'),
          status: 'forfeited',
          reason: 'banned',
        }),
      ]),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#20] 暂缓受益人份额为 0（比例 0）：不开义务，不写凭证',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 0, state: 'frozen' },
      ],
    });
    expect(await h.credit(o)).toMatchObject({ outcome: 'credited', platformCreditFen: 575n });
    expect(await h.voucherKeys()).toEqual([creditKey(o, 'self'), platformKey(o)].sort());
    expect(await h.obligations()).toEqual([]);
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
  },
  TIMEOUT,
);
