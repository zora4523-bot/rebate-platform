import { randomUUID } from 'node:crypto';
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
  tuples,
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

it(
  '[AC-B2-02i#1] 整张红冲：多账户多类型逐条反号，保留分类和结构化列，原记录不变',
  async () => {
    const { ledger, clock, appId } = context();
    const a = await account(h.db, ledger, appId);
    const b = await account(h.db, ledger, appId);
    // Beyond Number.MAX_SAFE_INTEGER: catches lossy bigint-to-number negation.
    const large = 9_007_199_254_740_993n;
    const v = voucher(appId, a.account_id, -large, {
      orderKey: 'taobao:reverse-order',
      beneficiaryUserId: a.user_id,
      role: 'indirect',
      voucherKind: 'CREDIT',
      memo: 'correction fixture',
      entries: [
        entry(a.account_id, -large),
        { ...entry(a.account_id, -7n, 'REFERRAL_CREDIT'), sub_type: 'INDIRECT' },
        { ...entry(a.account_id, -7n, 'REFERRAL_CREDIT'), sub_type: 'INDIRECT' },
        { ...entry(b.account_id, -29n, 'REWARD'), sub_type: 'checkin', income_type: 'INCIDENTAL' },
        {
          ...entry(a.account_id, large + 43n),
          account: { ownerType: 'platform', subject: 'UNION_RECEIVABLE:taobao' },
          income_type: null,
        },
      ],
    });
    const original = await post(h.db, ledger, [b.user_id, a.user_id], v);
    const before = await snapshot(h.db, appId);
    clock.set('2032-06-15T16:00:00.000Z');
    const result = await reverse(h.db, ledger, [a.user_id, b.user_id], {
      appId,
      originalUniqKey: v.uniqKey,
    });
    const after = await snapshot(h.db, appId);
    expect(result.kind).toBe('posted');
    expect(result.voucherId).not.toBe(original.voucherId);
    expect(after.vouchers).toHaveLength(2);
    expect(after.vouchers.find((row) => row.id === original.voucherId)).toEqual(before.vouchers[0]);
    expect(after.vouchers.find((row) => row.id === result.voucherId)).toMatchObject({
      app_id: appId,
      uniq_key: `${v.uniqKey}:REVERSE`,
      order_key: v.orderKey,
      beneficiary_user_id: a.user_id,
      role: 'indirect',
      voucher_kind: 'CREDIT',
    });
    const dates = await h.db
      .selectFrom('ledger_vouchers')
      .select((eb) => eb.cast<string>('accounting_date', 'text').as('day'))
      .where('app_id', '=', appId)
      .where('id', '=', result.voucherId)
      .execute();
    expect(dates).toEqual([{ day: '2032-06-16' }]);
    const lines = after.entries.filter((row) => row.voucher_id === result.voucherId);
    expect(tuples(lines)).toEqual(
      tuples(
        before.entries.map((row) => ({
          ...row,
          amount_fen: -row.amount_fen,
        })),
      ),
    );
    expect(lines.reduce((sum, row) => sum + row.amount_fen, 0n)).toBe(0n);
    expect(after.entries.filter((row) => row.voucher_id === original.voucherId)).toEqual(
      before.entries,
    );
    expect(after.accounts).toEqual(before.accounts);
    expect(after.balances).toHaveLength(2); // No platform balance cache.
    for (const initial of [a, b]) {
      expect(await ledger.getBalances(h.db, { appId, userIds: [initial.user_id] })).toEqual([
        { ...initial, version: 2n },
      ]);
      expect(
        before.entries
          .filter((row) => row.account_id === initial.account_id)
          .map((row) => row.account_version),
      ).toEqual(initial === a ? [1n, 1n, 1n] : [1n]);
      for (const row of lines.filter((row) => row.account_id === initial.account_id)) {
        expect(row).toMatchObject({ balance_after_fen: 0n, account_version: 2n });
      }
    }
    for (const row of lines) {
      expect(row.booked_at.toISOString()).toBe('2032-06-15T16:00:00.000Z');
      if (row.account_id !== a.account_id && row.account_id !== b.account_id) {
        expect(row).toMatchObject({ balance_after_fen: null, account_version: null });
      }
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-02i#2] 冻结凭证红冲恢复 available 和 frozen，版本每张凭证只加一次',
  async () => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    await post(h.db, ledger, [a.user_id], voucher(appId, a.account_id, -1000n));
    const v = voucher(appId, a.account_id, 400n, {
      voucherKind: 'FREEZE',
      entries: [
        entry(a.account_id, 400n, 'WITHDRAW_FREEZE'),
        { ...entry(a.account_id, -400n, 'WITHDRAW_FREEZE'), sub_account: 'frozen' },
      ],
    });
    await post(h.db, ledger, [a.user_id], v);
    const result = await reverse(h.db, ledger, [a.user_id], { appId, originalUniqKey: v.uniqKey });
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, available_fen: 1000n, version: 3n },
    ]);
    const lines = (await snapshot(h.db, appId)).entries.filter(
      (row) => row.voucher_id === result.voucherId,
    );
    expect(lines).toHaveLength(2);
    expect(lines.find((row) => row.sub_account === 'available')).toMatchObject({
      amount_fen: -400n,
      balance_after_fen: 1000n,
      account_version: 3n,
      ledger_type: 'WITHDRAW_FREEZE',
    });
    expect(lines.find((row) => row.sub_account === 'frozen')).toMatchObject({
      amount_fen: 400n,
      balance_after_fen: 0n,
      account_version: 3n,
      ledger_type: 'WITHDRAW_FREEZE',
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02i#3] 重放返回同一红冲 voucherId，余额已不足也不再记账或改变时间',
  async () => {
    const { ledger, clock, appId } = context();
    const a = await account(h.db, ledger, appId);
    const v = voucher(appId, a.account_id, -617n);
    await post(h.db, ledger, [a.user_id], v);
    const input = { appId, originalUniqKey: v.uniqKey };
    const first = await reverse(h.db, ledger, [a.user_id], input);
    const before = await snapshot(h.db, appId);
    clock.set('2032-07-01T16:00:00.000Z');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await reverse(h.db, ledger, [a.user_id], input)).toEqual({
        kind: 'duplicate',
        voucherId: first.voucherId,
      });
    }
    expect(await snapshot(h.db, appId)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02i#4] 原凭证不存在返回明确 LedgerError，零写入且外层事务仍可提交',
  async () => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const before = await snapshot(h.db, appId);
    await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      await refused(
        ledger.reverse(trx, { appId, originalUniqKey: 'ADJ:missing' }),
        'ORIGINAL_NOT_FOUND',
      );
      expect(await snapshot(trx, appId)).toEqual(before);
      expect((await ledger.post(trx, voucher(appId, a.account_id, -50n))).kind).toBe('posted');
    });
    expect((await snapshot(h.db, appId)).vouchers).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02i#5] 不红冲红冲：已有和不存在的 REVERSE 原键都明确拒绝',
  async () => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const v = voucher(appId, a.account_id, -500n);
    await post(h.db, ledger, [a.user_id], v);
    await reverse(h.db, ledger, [a.user_id], { appId, originalUniqKey: v.uniqKey });
    const before = await snapshot(h.db, appId);
    await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      for (const key of [`${v.uniqKey}:REVERSE`, 'ADJ:missing:REVERSE']) {
        await refused(
          ledger.reverse(trx, { appId, originalUniqKey: key }),
          'CANNOT_REVERSE_REVERSAL',
        );
        expect(await snapshot(trx, appId)).toEqual(before);
      }
    });
    expect(await snapshot(h.db, appId)).toEqual(before);
  },
  TIMEOUT,
);

it.each(['none', 'partial'] as const)(
  '[AC-B2-02i#6] 本事务余额锁 %s：拒绝且所有账户零写入',
  async (locks) => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const b = await account(h.db, ledger, appId);
    const base = voucher(appId, a.account_id, -30n);
    const v = {
      ...base,
      entries: [entry(a.account_id, -10n), entry(b.account_id, -20n), base.entries[1]!],
    };
    await post(h.db, ledger, [a.user_id, b.user_id], v);
    const before = await snapshot(h.db, appId);
    await h.db.transaction().execute(async (trx) => {
      if (locks === 'partial') await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      await refused(ledger.reverse(trx, { appId, originalUniqKey: v.uniqKey }), 'NOT_LOCKED');
      expect(await snapshot(trx, appId)).toEqual(before);
    });
    expect(await snapshot(h.db, appId)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02i#7] 跨 app 同原键各自红冲，另一 app 的凭证不能当作本 app 原单',
  async () => {
    const { ledger, appId } = context();
    const otherApp = `reverse-${randomUUID()}`;
    const a = await account(h.db, ledger, appId);
    const b = await account(h.db, ledger, otherApp, a.user_id);
    const v = voucher(appId, a.account_id, -100n);
    await post(h.db, ledger, [a.user_id], v);
    const foreignBefore = await snapshot(h.db, appId);
    const localBefore = await snapshot(h.db, otherApp);
    await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId: otherApp, userIds: [b.user_id] });
      await refused(
        ledger.reverse(trx, { appId: otherApp, originalUniqKey: v.uniqKey }),
        'ORIGINAL_NOT_FOUND',
      );
      expect(await snapshot(trx, otherApp)).toEqual(localBefore);
    });
    expect(await snapshot(h.db, appId)).toEqual(foreignBefore);
    await post(
      h.db,
      ledger,
      [b.user_id],
      voucher(otherApp, b.account_id, -900n, { uniqKey: v.uniqKey }),
    );
    const bBefore = await snapshot(h.db, otherApp);
    const first = await reverse(h.db, ledger, [a.user_id], { appId, originalUniqKey: v.uniqKey });
    expect(await snapshot(h.db, otherApp)).toEqual(bBefore);
    const second = await reverse(h.db, ledger, [b.user_id], {
      appId: otherApp,
      originalUniqKey: v.uniqKey,
    });
    expect(first.kind).toBe('posted');
    expect(second.kind).toBe('posted');
    expect(second.voucherId).not.toBe(first.voucherId);
    for (const initial of [a, b]) {
      expect(
        await ledger.getBalances(h.db, { appId: initial.app_id, userIds: [initial.user_id] }),
      ).toEqual([{ ...initial, version: 2n }]);
      const state = await snapshot(h.db, initial.app_id);
      expect(state.vouchers).toHaveLength(2);
      expect(state.entries).toHaveLength(4);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-02i#8] 调用方回滚撤销全部红冲写入，重试仍为 posted',
  async () => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const v = voucher(appId, a.account_id, -500n);
    await post(h.db, ledger, [a.user_id], v);
    const before = await snapshot(h.db, appId);
    const rollback = new Error('caller rollback');
    const input = { appId, originalUniqKey: v.uniqKey };
    await expect(
      h.db.transaction().execute(async (trx) => {
        await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
        const result = await ledger.reverse(trx, input);
        expect(result.kind).toBe('posted');
        expect((await snapshot(trx, appId)).vouchers).toHaveLength(2);
        expect(await ledger.getBalances(trx, { appId, userIds: [a.user_id] })).toEqual([
          { ...a, version: 2n },
        ]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await snapshot(h.db, appId)).toEqual(before);
    expect((await reverse(h.db, ledger, [a.user_id], input)).kind).toBe('posted');
  },
  TIMEOUT,
);

it(
  '[AC-B2-02i#9] 同事务读到未提交原单并红冲，时间沿用该事务的 Clock 快照',
  async () => {
    const { ledger, clock, appId } = context();
    const a = await account(h.db, ledger, appId);
    const v = voucher(appId, a.account_id, -50n);
    await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      await ledger.post(trx, v);
      clock.set('2032-06-16T16:00:00.000Z');
      const result = await ledger.reverse(trx, { appId, originalUniqKey: v.uniqKey });
      expect(result.kind).toBe('posted');
      expect(await ledger.reverse(trx, { appId, originalUniqKey: v.uniqKey })).toEqual({
        kind: 'duplicate',
        voucherId: result.voucherId,
      });
      const state = await snapshot(trx, appId);
      const dates = await trx
        .selectFrom('ledger_vouchers')
        .select((eb) => eb.cast<string>('accounting_date', 'text').as('day'))
        .where('app_id', '=', appId)
        .execute();
      expect(dates).toEqual([{ day: '2032-06-15' }, { day: '2032-06-15' }]);
      expect(state.entries.map((row) => row.booked_at.toISOString())).toEqual(
        Array(4).fill('2032-06-15T15:59:59.999Z'),
      );
    });
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, version: 2n },
    ]);
  },
  TIMEOUT,
);
