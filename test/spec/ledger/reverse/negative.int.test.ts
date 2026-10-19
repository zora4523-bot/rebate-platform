import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TIMEOUT,
  account,
  close,
  context,
  entry,
  open,
  post,
  refused,
  reverse,
  snapshot,
  voucher,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each([
  ['REBATE_CREDIT', null],
  ['SHARE_CREDIT', null],
  ['REFERRAL_CREDIT', 'DIRECT'],
  ['CLAWBACK', 'FULL'],
  ['SETTLE_ADJUST', 'SETTLE_DIFF'],
  ['ADMIN_ADJUST', 'RECON_FIX'],
] as const)(
  '[AC-B2-02i#10] 普通 %s 红冲不得扣成负余额，原类型白名单不绕过 REVERSE 限制',
  async (type, sub) => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const base = voucher(appId, a.account_id, -100n);
    const v = {
      ...base,
      entries: base.entries.map((row) => ({ ...row, ledger_type: type, sub_type: sub })),
    };
    await post(h.db, ledger, [a.user_id], v);
    await post(
      h.db,
      ledger,
      [a.user_id],
      voucher(appId, a.account_id, 60n, {
        entries: [
          entry(a.account_id, 60n, 'WITHDRAW_FREEZE'),
          { ...entry(a.account_id, -60n, 'WITHDRAW_FREEZE'), sub_account: 'frozen' },
        ],
      }),
    );
    const before = await snapshot(h.db, appId);
    await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      await refused(ledger.reverse(trx, { appId, originalUniqKey: v.uniqKey }), 'NEGATIVE_BALANCE');
      expect(await snapshot(trx, appId)).toEqual(before);
      // Refusal must leave the caller's transaction usable; an unrelated credit can commit.
      expect((await ledger.post(trx, voucher(appId, a.account_id, -1n))).kind).toBe('posted');
    });
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, available_fen: 41n, frozen_fen: 60n, version: 3n },
    ]);
    const after = await snapshot(h.db, appId);
    expect(after.vouchers).toHaveLength(3);
    expect(after.vouchers.some((row) => row.uniq_key === `${v.uniqKey}:REVERSE`)).toBe(false);
    expect(after.entries).toHaveLength(6);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02i#11] 多账户红冲有一个余额不足则整单零写入，补足后可首次成功',
  async () => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const b = await account(h.db, ledger, appId);
    const base = voucher(appId, a.account_id, -200n);
    const v = {
      ...base,
      entries: [entry(a.account_id, -100n), entry(b.account_id, -100n), base.entries[1]!],
    };
    await post(h.db, ledger, [a.user_id, b.user_id], v);
    const debit = voucher(appId, b.account_id, 50n);
    await post(h.db, ledger, [b.user_id], {
      ...debit,
      entries: debit.entries.map((row) => ({
        ...row,
        ledger_type: 'CLAWBACK',
        sub_type: 'PART_REFUND',
      })),
    });
    const before = await snapshot(h.db, appId);
    await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [b.user_id, a.user_id] });
      await refused(ledger.reverse(trx, { appId, originalUniqKey: v.uniqKey }), 'NEGATIVE_BALANCE');
      expect(await snapshot(trx, appId)).toEqual(before);
    });
    expect(await snapshot(h.db, appId)).toEqual(before);
    await post(h.db, ledger, [b.user_id], voucher(appId, b.account_id, -50n));
    expect(
      (await reverse(h.db, ledger, [a.user_id, b.user_id], { appId, originalUniqKey: v.uniqKey }))
        .kind,
    ).toBe('posted');
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, version: 2n },
    ]);
    expect(await ledger.getBalances(h.db, { appId, userIds: [b.user_id] })).toEqual([
      { ...b, version: 4n },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02i#12] 红冲扣回使负余额回升时放行，保留负起始日，归零后清除',
  async () => {
    const { ledger, clock, appId } = context();
    const a = await account(h.db, ledger, appId);
    const first = voucher(appId, a.account_id, 400n);
    const v = {
      ...first,
      voucherKind: 'CLAWBACK',
      entries: first.entries.map((row) => ({
        ...row,
        ledger_type: 'CLAWBACK',
        sub_type: 'PART_REFUND',
      })),
    };
    await post(h.db, ledger, [a.user_id], v);
    const second = { ...v, uniqKey: `${v.uniqKey}:SECOND` };
    await post(h.db, ledger, [a.user_id], second);
    clock.set('2032-07-02T16:00:00.000Z');
    const result = await reverse(h.db, ledger, [a.user_id], { appId, originalUniqKey: v.uniqKey });
    expect(result.kind).toBe('posted');
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, available_fen: -400n, version: 3n, negative_since: '2032-06-15' },
    ]);
    const lines = (await snapshot(h.db, appId)).entries.filter(
      (row) => row.voucher_id === result.voucherId,
    );
    expect(lines).toHaveLength(2);
    expect(lines.find((row) => row.account_id === a.account_id)).toMatchObject({
      amount_fen: -400n,
      ledger_type: 'CLAWBACK',
      sub_type: 'PART_REFUND',
      income_type: 'SERVICE_FEE',
      balance_after_fen: -400n,
      account_version: 3n,
    });
    expect(
      (await reverse(h.db, ledger, [a.user_id], { appId, originalUniqKey: second.uniqKey })).kind,
    ).toBe('posted');
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, version: 4n },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02i#13] 冻结金额已消耗后红冲冻结凭证，frozen 不得变负且拒绝零写入',
  async () => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    await post(h.db, ledger, [a.user_id], voucher(appId, a.account_id, -100n));
    const freeze = voucher(appId, a.account_id, 100n, {
      entries: [
        entry(a.account_id, 100n, 'WITHDRAW_FREEZE'),
        { ...entry(a.account_id, -100n, 'WITHDRAW_FREEZE'), sub_account: 'frozen' },
      ],
    });
    await post(h.db, ledger, [a.user_id], freeze);
    const paid = voucher(appId, a.account_id, 100n);
    await post(h.db, ledger, [a.user_id], {
      ...paid,
      entries: [
        { ...entry(a.account_id, 100n, 'WITHDRAW_PAID'), sub_account: 'frozen' },
        { ...paid.entries[1]!, ledger_type: 'WITHDRAW_PAID' },
      ],
    });
    const before = await snapshot(h.db, appId);
    await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      await refused(
        ledger.reverse(trx, { appId, originalUniqKey: freeze.uniqKey }),
        'INVALID_BALANCE',
      );
      expect(await snapshot(trx, appId)).toEqual(before);
    });
    expect(await snapshot(h.db, appId)).toEqual(before);
  },
  TIMEOUT,
);
