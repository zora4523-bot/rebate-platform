import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createLedger, LedgerModule } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  TIMEOUT,
  account,
  close,
  context,
  entry,
  open,
  post,
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

it('[AC-B2-02f#1] 用户开户幂等、同一用户只有一个零余额账户；读取不写库', async () => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  const again = await account(h.db, ledger, appId, a.user_id);
  expect(again).toEqual(a);
  expect(a).toEqual({
    app_id: appId,
    user_id: a.user_id,
    account_id: a.account_id,
    available_fen: 0n,
    frozen_fen: 0n,
    version: 0n,
    negative_since: null,
  });
  const before = await snapshot(h.db, appId);
  expect(before.accounts).toHaveLength(1);
  expect(before.accounts[0]).toMatchObject({
    owner_type: 'user',
    owner_id: a.user_id,
    subject: 'USER_BALANCE',
  });
  expect(before.balances).toHaveLength(1);
  expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([a]);
  expect(await ledger.getBalances(h.db, { appId, userIds: [] })).toEqual([]);
  expect(await ledger.getBalances(h.db, { appId, userIds: [randomUUID()] })).toEqual([]);
  expect(await snapshot(h.db, appId)).toEqual(before);
});

it('[AC-B2-02f#2] 同 uniq_key 返回原凭证，不追加分录、不改缓存或版本', async () => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  const v = voucher(appId, a.account_id, -617n, {
    orderKey: 'taobao:order-1',
    beneficiaryUserId: a.user_id,
    role: 'self',
    voucherKind: 'CREDIT',
  });
  const first = await post(h.db, ledger, [a.user_id], v);
  expect(first.kind).toBe('posted');
  const before = await snapshot(h.db, appId);
  expect(before.vouchers).toHaveLength(1);
  expect(before.vouchers[0]).toMatchObject({
    id: first.voucherId,
    uniq_key: v.uniqKey,
    app_id: appId,
    biz_type: v.bizType,
    biz_id: v.bizId,
    operator: 'system',
    memo: null,
    order_key: 'taobao:order-1',
    beneficiary_user_id: a.user_id,
    role: 'self',
    voucher_kind: 'CREDIT',
  });
  expect(before.entries).toHaveLength(2);
  expect(await post(h.db, ledger, [a.user_id], v)).toEqual({
    kind: 'duplicate',
    voucherId: first.voucherId,
  });
  // A replay with different contents is still the existing business event.
  expect(
    await post(
      h.db,
      ledger,
      [a.user_id],
      voucher(appId, a.account_id, -999n, { uniqKey: v.uniqKey }),
    ),
  ).toEqual({ kind: 'duplicate', voucherId: first.voucherId });
  expect(await snapshot(h.db, appId)).toEqual(before);
});

it('[AC-B2-02f#3] 同事务多个凭证、两子户、逐张版本与余额快照连续', async () => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  await h.db.transaction().execute(async (trx) => {
    expect(await ledger.lockBalances(trx, { appId, userIds: [a.user_id, a.user_id] })).toEqual([a]);
    await ledger.post(trx, voucher(appId, a.account_id, -1000n));
    await ledger.post(trx, voucher(appId, a.account_id, -617n));
    await ledger.post(
      trx,
      voucher(appId, a.account_id, 400n, {
        entries: [
          entry(a.account_id, 400n, 'WITHDRAW_FREEZE'),
          { ...entry(a.account_id, -400n, 'WITHDRAW_FREEZE'), sub_account: 'frozen' },
        ],
      }),
    );
    expect(await ledger.getBalances(trx, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, available_fen: 1217n, frozen_fen: 400n, version: 3n },
    ]);
  });
  const state = await snapshot(h.db, appId);
  expect(
    state.entries
      .filter((e) => e.account_id === a.account_id)
      .map((e) => ({
        amount: e.amount_fen,
        sub: e.sub_account,
        after: e.balance_after_fen,
        version: e.account_version,
      })),
  ).toEqual([
    { amount: -1000n, sub: 'available', after: 1000n, version: 1n },
    { amount: -617n, sub: 'available', after: 1617n, version: 2n },
    { amount: 400n, sub: 'available', after: 1217n, version: 3n },
    { amount: -400n, sub: 'frozen', after: 400n, version: 3n },
  ]);
  const platform = state.accounts.filter((r) => r.owner_type === 'platform');
  expect(platform).toHaveLength(1);
  expect(platform[0]).toMatchObject({ owner_id: 'platform', subject: 'UNION_RECEIVABLE:taobao' });
  expect(state.balances).toHaveLength(1);
  expect(state.entries.filter((e) => e.account_id !== a.account_id)).toEqual([
    expect.objectContaining({ amount_fen: 1000n, balance_after_fen: null, account_version: null }),
    expect.objectContaining({ amount_fen: 617n, balance_after_fen: null, account_version: null }),
  ]);
});

it.each(['unbalanced', 'single', 'zero', 'empty'] as const)(
  '[AC-B2-02f#4] 无效凭证 %s 在当前事务零写入，事务仍可继续',
  async (kind) => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const valid = voucher(appId, a.account_id, -50n);
    const entries =
      kind === 'unbalanced'
        ? [valid.entries[0]!, { ...valid.entries[1]!, amount_fen: 49n }]
        : kind === 'single'
          ? [valid.entries[0]!]
          : kind === 'zero'
            ? valid.entries.map((e) => ({ ...e, amount_fen: 0n }))
            : [];
    await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      const before = await snapshot(trx, appId);
      await expect(ledger.post(trx, { ...valid, entries })).rejects.toThrow();
      expect(await snapshot(trx, appId)).toEqual(before);
      expect((await ledger.post(trx, valid)).kind).toBe('posted');
    });
  },
);

it('[AC-B2-02f#5] 未锁、别的事务曾锁过、只锁部分账户均拒绝且零写入', async () => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  const b = await account(h.db, ledger, appId);
  await h.db
    .transaction()
    .execute((trx) => ledger.lockBalances(trx, { appId, userIds: [a.user_id] }));
  const before = await snapshot(h.db, appId);
  await h.db.transaction().execute(async (trx) => {
    await expect(ledger.post(trx, voucher(appId, a.account_id, -50n))).rejects.toThrow();
    expect(await snapshot(trx, appId)).toEqual(before);
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    const v = voucher(appId, a.account_id, -50n);
    await expect(
      ledger.post(trx, {
        ...v,
        entries: [entry(a.account_id, -25n), entry(b.account_id, -25n), v.entries[1]!],
      }),
    ).rejects.toThrow();
    expect(await snapshot(trx, appId)).toEqual(before);
  });
});

it('[AC-B2-02f#6] 调用方抛错会回滚开户、惰性平台账户、凭证、分录与缓存', async () => {
  const { ledger, appId } = context();
  const before = await snapshot(h.db, appId);
  const abort = new Error('caller-abort');
  await expect(
    h.db.transaction().execute(async (trx) => {
      const a = await ledger.openUserAccount(trx, { appId, userId: randomUUID() });
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      expect((await ledger.post(trx, voucher(appId, a.account_id, -50n))).kind).toBe('posted');
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await snapshot(h.db, appId)).toEqual(before);
});

it('[AC-B2-02f#7] app_id 隔离开户、读取、锁定与幂等；拒绝外租户 account_id', async () => {
  const { ledger, appId } = context();
  const otherApp = `other-${randomUUID()}`;
  const a = await account(h.db, ledger, appId);
  const b = await account(h.db, ledger, otherApp, a.user_id);
  expect(b.account_id).not.toBe(a.account_id);
  const v = voucher(appId, a.account_id, -50n);
  const first = await post(h.db, ledger, [a.user_id], v);
  const second = await post(
    h.db,
    ledger,
    [b.user_id],
    voucher(otherApp, b.account_id, -80n, { uniqKey: v.uniqKey }),
  );
  expect(second.kind).toBe('posted');
  expect(second.voucherId).not.toBe(first.voucherId);
  expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
    { ...a, available_fen: 50n, version: 1n },
  ]);
  const before = await snapshot(h.db, otherApp);
  await h.db.transaction().execute(async (trx) => {
    const locked = await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    expect(locked.map((r) => r.account_id)).toEqual([a.account_id]);
    await expect(ledger.post(trx, voucher(appId, b.account_id, -90n))).rejects.toThrow();
  });
  expect(await snapshot(h.db, otherApp)).toEqual(before);
  expect((await snapshot(h.db, appId)).vouchers).toHaveLength(1);
});

it.each([
  ['2032-06-15T15:59:59.999Z', '2032-06-15'],
  ['2032-06-15T16:00:00.000Z', '2032-06-16'],
])('[AC-B2-02f#8] Clock %s 决定全部 booked_at 与 +08 会计日 %s，只取一次', async (instant, day) => {
  const { ledger: setup, appId } = context();
  const a = await account(h.db, setup, appId);
  const fixed = new FixedClock(instant);
  let calls = 0;
  const ledger = createLedger({
    clock: {
      now() {
        calls += 1;
        const result = fixed.now();
        fixed.advanceMs(86_400_000);
        return result;
      },
    },
  });
  await post(h.db, ledger, [a.user_id], voucher(appId, a.account_id, -50n));
  expect(calls).toBe(1);
  const stored = await snapshot(h.db, appId);
  expect(stored.entries.map((e) => e.booked_at.toISOString())).toEqual([instant, instant]);
  // PostgreSQL date is rendered as text, independent of the runner timezone.
  const rows = await h.db
    .selectFrom('ledger_vouchers')
    .select((eb) => eb.cast<string>('accounting_date', 'text').as('day'))
    .where('app_id', '=', appId)
    .execute();
  expect(rows).toEqual([{ day }]);
});

it('[AC-B2-02f#9] bigint 超过 JS 安全整数仍逐分精确，贷记增加用户余额', async () => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  await post(h.db, ledger, [a.user_id], voucher(appId, a.account_id, -9007199254740993n));
  await post(h.db, ledger, [a.user_id], voucher(appId, a.account_id, -1n));
  expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
    { ...a, available_fen: 9007199254740994n, version: 2n },
  ]);
});

it('[AC-B2-02f#10] Nest 模块声明并导出记账服务提供者', () => {
  const module = LedgerModule.forRoot();
  expect(module.module).toBe(LedgerModule);
  expect(module.providers?.length).toBeGreaterThan(0);
  expect(module.exports?.length).toBeGreaterThan(0);
});

it('[AC-B2-02f#27] 余额 bigint 上溢拒绝，原凭证与缓存完整保留', async () => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  await post(h.db, ledger, [a.user_id], voucher(appId, a.account_id, -9223372036854775807n));
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    const before = await snapshot(trx, appId);
    await expect(ledger.post(trx, voucher(appId, a.account_id, -1n))).rejects.toThrow();
    expect(await snapshot(trx, appId)).toEqual(before);
  });
});
