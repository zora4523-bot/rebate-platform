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
  ['CLAWBACK', null],
  ['SETTLE_ADJUST', null],
  ['ADMIN_ADJUST', null],
  ['REBATE_CREDIT', 'REASSIGN_REV'],
  ['SHARE_CREDIT', 'REASSIGN_REV'],
  ['REFERRAL_CREDIT', 'REASSIGN_REV'],
] as const)('[AC-B2-02f#11] %s / %s 允许扣负，使用写后余额与版本', async (type, kind) => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  const v = voucher(appId, a.account_id, 400n, { voucherKind: kind });
  await post(h.db, ledger, [a.user_id], {
    ...v,
    entries: v.entries.map((e) => ({ ...e, ledger_type: type })),
  });
  expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
    { ...a, available_fen: -400n, version: 1n, negative_since: '2032-06-15' },
  ]);
  expect(
    (await snapshot(h.db, appId)).entries.find((e) => e.account_id === a.account_id),
  ).toMatchObject({
    amount_fen: 400n,
    balance_after_fen: -400n,
    account_version: 1n,
    ledger_type: type,
  });
});

it.each([
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'WITHDRAW_FREEZE',
  'WITHDRAW_PAID',
  'WITHDRAW_RETURN',
  'WITHDRAW_FEE',
  'TAX_WITHHOLD',
  'REWARD',
  'BAD_DEBT_WRITEOFF',
])('[AC-B2-02f#12] %s 不得使 available 变负，拒绝时当前事务零写入', async (type) => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  const v = voucher(appId, a.account_id, 1n);
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    const before = await snapshot(trx, appId);
    await expect(
      ledger.post(trx, { ...v, entries: v.entries.map((e) => ({ ...e, ledger_type: type })) }),
    ).rejects.toThrow();
    expect(await snapshot(trx, appId)).toEqual(before);
  });
});

it.each([
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'CLAWBACK',
  'SETTLE_ADJUST',
  'ADMIN_ADJUST',
])('[AC-B2-02f#13] 普通 %s :REVERSE 没有改派豁免，不得扣负', async (type) => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  const v = voucher(appId, a.account_id, 1n, { uniqKey: 'ADJ:original:REVERSE' });
  const before = await snapshot(h.db, appId);
  await expect(
    post(h.db, ledger, [a.user_id], {
      ...v,
      entries: v.entries.map((e) => ({ ...e, ledger_type: type })),
    }),
  ).rejects.toThrow();
  expect(await snapshot(h.db, appId)).toEqual(before);
});

it.each([
  { key: 'order:REASSIGN_REV:fake', sub: null, kind: null, type: 'REBATE_CREDIT' },
  { key: 'order:normal', sub: 'REASSIGN_REV', kind: null, type: 'REBATE_CREDIT' },
  { key: 'order:normal', sub: null, kind: 'REASSIGN_REV', type: 'WITHDRAW_FEE' },
])('[AC-B2-02f#14] 不能由键名、sub_type 或非入账类型冒充改派红冲：%j', async (row) => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  const v = voucher(appId, a.account_id, 1n, { uniqKey: row.key, voucherKind: row.kind });
  const before = await snapshot(h.db, appId);
  await expect(
    post(h.db, ledger, [a.user_id], {
      ...v,
      entries: v.entries.map((e) => ({ ...e, ledger_type: row.type, sub_type: row.sub })),
    }),
  ).rejects.toThrow();
  expect(await snapshot(h.db, appId)).toEqual(before);
});

it('[AC-B2-02f#15] 后续收入直接抵负；negative_since 保留首次负数日、归零清空、再负重记', async () => {
  const { ledger, clock, appId } = context();
  const a = await account(h.db, ledger, appId);
  for (const [amount, type, instant, expected, since, version] of [
    [400n, 'CLAWBACK', '2032-06-15T15:59:59.999Z', -400n, '2032-06-15', 1n],
    [-100n, 'REBATE_CREDIT', '2032-06-15T16:00:00.000Z', -300n, '2032-06-15', 2n],
    [50n, 'SETTLE_ADJUST', '2032-06-16T16:00:00.000Z', -350n, '2032-06-15', 3n],
    [-350n, 'ADMIN_ADJUST', '2032-06-17T16:00:00.000Z', 0n, null, 4n],
    [1n, 'CLAWBACK', '2032-06-18T16:00:00.000Z', -1n, '2032-06-19', 5n],
    [-201n, 'SHARE_CREDIT', '2032-06-19T16:00:00.000Z', 200n, null, 6n],
  ] as const) {
    clock.set(instant);
    const v = voucher(appId, a.account_id, amount);
    await post(h.db, ledger, [a.user_id], {
      ...v,
      entries: v.entries.map((e) => ({ ...e, ledger_type: type })),
    });
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, available_fen: expected, negative_since: since, version },
    ]);
  }
  // No extra debt-offset entries: each of the six vouchers has exactly two entries.
  expect((await snapshot(h.db, appId)).entries).toHaveLength(12);
});

it.each([
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'SETTLE_ADJUST',
  'ADMIN_ADJUST',
  'WITHDRAW_RETURN',
])('[AC-B2-02f#16] 负数期间的正向 %s 自然抵扣，收入来源共用一个余额', async (type) => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  const debt = voucher(appId, a.account_id, 400n);
  await post(h.db, ledger, [a.user_id], {
    ...debt,
    entries: debt.entries.map((e) => ({ ...e, ledger_type: 'CLAWBACK' })),
  });
  const credit = voucher(appId, a.account_id, -100n);
  await post(h.db, ledger, [a.user_id], {
    ...credit,
    entries: credit.entries.map((e) => ({ ...e, ledger_type: type })),
  });
  expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
    { ...a, available_fen: -300n, version: 2n, negative_since: '2032-06-15' },
  ]);
  expect((await snapshot(h.db, appId)).balances).toHaveLength(1);
});

it('[AC-B2-02f#17] 红冲扣回会增加余额，结果仍负也可记账；普通扣款到零允许', async () => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  const debt = voucher(appId, a.account_id, 400n);
  await post(h.db, ledger, [a.user_id], {
    ...debt,
    entries: debt.entries.map((e) => ({ ...e, ledger_type: 'CLAWBACK' })),
  });
  const reverse = voucher(appId, a.account_id, -100n, { uniqKey: `${debt.uniqKey}:REVERSE` });
  await post(h.db, ledger, [a.user_id], {
    ...reverse,
    entries: reverse.entries.map((e) => ({ ...e, ledger_type: 'CLAWBACK' })),
  });
  expect((await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]?.available_fen).toBe(
    -300n,
  );
  await post(h.db, ledger, [a.user_id], voucher(appId, a.account_id, -500n));
  const fee = voucher(appId, a.account_id, 200n);
  await post(h.db, ledger, [a.user_id], {
    ...fee,
    entries: fee.entries.map((e) => ({ ...e, ledger_type: 'WITHDRAW_FEE' })),
  });
  expect((await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]).toMatchObject({
    available_fen: 0n,
    negative_since: null,
    version: 4n,
  });
});

it('[AC-B2-02f#18] 允许 available 负数也不允许 frozen 负数，所有账户必须原子校验', async () => {
  const { ledger, appId } = context();
  const a = await account(h.db, ledger, appId);
  const b = await account(h.db, ledger, appId);
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [b.user_id, a.user_id] });
    const before = await snapshot(trx, appId);
    const v = voucher(appId, a.account_id, 10n);
    await expect(
      ledger.post(trx, {
        ...v,
        entries: [
          entry(a.account_id, -10n),
          { ...entry(b.account_id, 10n, 'CLAWBACK'), sub_account: 'frozen' },
        ],
      }),
    ).rejects.toThrow();
    expect(await snapshot(trx, appId)).toEqual(before);
    await expect(
      ledger.post(trx, {
        ...v,
        entries: [
          entry(a.account_id, 10n, 'CLAWBACK'),
          entry(b.account_id, 10n, 'WITHDRAW_FEE'),
          { ...v.entries[1]!, amount_fen: -20n },
        ],
      }),
    ).rejects.toThrow();
    expect(await snapshot(trx, appId)).toEqual(before);
  });
});
