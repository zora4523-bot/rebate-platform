import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BALANCE_RECOVERED_HOOK,
  LEDGER,
  LedgerModule,
  createLedger,
  type Ledger,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { CLOCK } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  TIMEOUT,
  account,
  change,
  close,
  context,
  entry,
  markers,
  open,
  post,
  snapshot,
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
  ['REBATE_CREDIT', -300n, 0n],
  ['REBATE_CREDIT', -500n, 200n],
  ['WITHDRAW_RETURN', -300n, 0n],
  ['BAD_DEBT_WRITEOFF', -300n, 0n],
  ['ADMIN_ADJUST', -500n, 200n],
] as const)(
  '[AC-B2-04ka#1] %s 借方 %s 使负余额回到 %s，同事务调用并随凭证提交',
  async (type, debit, after) => {
    const { ledger, appId, onRecovered } = context();
    const a = await account(h.db, ledger, appId);
    await post(h.db, ledger, [a.user_id], change(appId, a.account_id, 300n));
    const v = change(appId, a.account_id, debit, type);
    const result = await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      const posted = await ledger.post(trx, v);
      expect(posted.kind).toBe('posted');
      expect(onRecovered).toHaveBeenCalledTimes(1);
      expect(onRecovered.mock.calls[0]?.[0]).toBe(trx);
      expect(onRecovered.mock.calls[0]?.[1]).toEqual({
        appId,
        userId: a.user_id,
        accountId: a.account_id,
        availableBefore: -300n,
        availableAfter: after,
        voucherId: posted.voucherId,
      });
      expect(await ledger.getBalances(trx, { appId, userIds: [a.user_id] })).toEqual([
        { ...a, available_fen: after, version: 2n, negative_since: null },
      ]);
      expect(await markers(trx, appId, a.account_id)).toHaveLength(1);
      expect(await markers(h.right, appId, a.account_id)).toEqual([]);
      expect((await ledger.getBalances(h.right, { appId, userIds: [a.user_id] }))[0]).toMatchObject(
        {
          available_fen: -300n,
          negative_since: '2032-06-15',
        },
      );
      return posted;
    });
    expect(await markers(h.db, appId, a.account_id)).toEqual([
      expect.objectContaining({ event_id: result.voucherId }),
    ]);
    expect((await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]).toMatchObject({
      available_fen: after,
      negative_since: null,
    });
  },
);

it('[AC-B2-04ka#2] 未跨越负到非负边界不调用，包含部分抵扣、冻结余额变化和分录中间穿零', async () => {
  const { ledger, appId, onRecovered } = context();
  const a = await account(h.db, ledger, appId);
  for (const [debit, type, expected] of [
    [-10n, 'REBATE_CREDIT', 10n],
    [10n, 'CLAWBACK', 0n],
    [5n, 'ADMIN_ADJUST', -5n],
    [2n, 'SETTLE_ADJUST', -7n],
    [-2n, 'REBATE_CREDIT', -5n],
  ] as const) {
    await post(h.db, ledger, [a.user_id], change(appId, a.account_id, debit, type));
    expect(
      (await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]?.available_fen,
    ).toBe(expected);
    expect(onRecovered).not.toHaveBeenCalled();
  }
  const base = change(appId, a.account_id, -10n);
  await post(h.db, ledger, [a.user_id], {
    ...base,
    entries: [
      entry(a.account_id, -10n, 'CLAWBACK'),
      entry(a.account_id, 10n, 'CLAWBACK'),
      { ...entry(a.account_id, -20n, 'CLAWBACK'), sub_account: 'frozen' },
      { ...base.entries[1]!, amount_fen: 20n },
    ],
  });
  expect((await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]).toMatchObject({
    available_fen: -5n,
    frozen_fen: 20n,
    negative_since: '2032-06-15',
  });
  expect(onRecovered).not.toHaveBeenCalled();
  expect(await markers(h.db, appId, a.account_id)).toEqual([]);
});

it('[AC-B2-04ka#3] 多账户各按凭证前后净余额判定，同账户多分录只清理一次', async () => {
  const { ledger, appId, onRecovered } = context();
  const a = await account(h.db, ledger, appId);
  const b = await account(h.db, ledger, appId);
  const c = await account(h.db, ledger, appId);
  const d = await account(h.db, ledger, appId);
  for (const [row, debit] of [
    [a, 3n],
    [b, 4n],
    [c, 5n],
    [d, -2n],
  ] as const) {
    await post(h.db, ledger, [row.user_id], change(appId, row.account_id, debit));
  }
  const base = change(appId, a.account_id, -3n);
  const posted = await post(h.db, ledger, [d.user_id, c.user_id, b.user_id, a.user_id], {
    ...base,
    entries: [
      entry(a.account_id, -1n, 'CLAWBACK'),
      entry(a.account_id, -2n, 'CLAWBACK'),
      entry(b.account_id, -6n, 'CLAWBACK'),
      entry(c.account_id, -4n, 'CLAWBACK'),
      entry(d.account_id, 3n, 'CLAWBACK'),
      { ...base.entries[1]!, amount_fen: 10n },
    ],
  });
  expect(onRecovered).toHaveBeenCalledTimes(2);
  expect(onRecovered.mock.calls.map((call) => call[1])).toEqual(
    expect.arrayContaining([
      {
        appId,
        userId: a.user_id,
        accountId: a.account_id,
        availableBefore: -3n,
        availableAfter: 0n,
        voucherId: posted.voucherId,
      },
      {
        appId,
        userId: b.user_id,
        accountId: b.account_id,
        availableBefore: -4n,
        availableAfter: 2n,
        voucherId: posted.voucherId,
      },
    ]),
  );
  for (const [row, expected, count] of [
    [a, 0n, 1],
    [b, 2n, 1],
    [c, -1n, 0],
    [d, -1n, 0],
  ] as const) {
    expect(
      (await ledger.getBalances(h.db, { appId, userIds: [row.user_id] }))[0]?.available_fen,
    ).toBe(expected);
    expect(await markers(h.db, appId, row.account_id)).toHaveLength(count);
  }
});

it('[AC-B2-04ka#4] 同事务与提交后重放都不清理，后来再扣负也不能让旧凭证重放触发清理', async () => {
  const { ledger, appId, onRecovered } = context();
  const a = await account(h.db, ledger, appId);
  const v = change(appId, a.account_id, -1n, 'REBATE_CREDIT');
  const first = await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    await ledger.post(trx, change(appId, a.account_id, 1n));
    const result = await ledger.post(trx, v);
    expect(await ledger.post(trx, v)).toEqual({ kind: 'duplicate', voucherId: result.voucherId });
    expect(onRecovered).toHaveBeenCalledTimes(1);
    await ledger.post(trx, change(appId, a.account_id, 2n));
    const next = await ledger.post(trx, change(appId, a.account_id, -2n, 'REBATE_CREDIT'));
    expect(onRecovered).toHaveBeenCalledTimes(2);
    expect(onRecovered.mock.calls[1]?.[1]).toMatchObject({
      availableBefore: -2n,
      availableAfter: 0n,
      voucherId: next.voucherId,
    });
    return result;
  });
  await post(h.db, ledger, [a.user_id], change(appId, a.account_id, 1n));
  const before = await snapshot(h.db, appId);
  expect(await post(h.db, ledger, [a.user_id], v)).toEqual({
    kind: 'duplicate',
    voucherId: first.voucherId,
  });
  expect(onRecovered).toHaveBeenCalledTimes(2);
  expect(await markers(h.db, appId, a.account_id)).toHaveLength(2);
  expect(await snapshot(h.db, appId)).toEqual(before);
});

it('[AC-B2-04ka#5] 同用户与同凭证键在不同 app 独立回正，端口收到正确 app 与账户', async () => {
  const f = context();
  const a = await account(h.db, f.ledger, f.appId);
  const otherApp = `${f.appId}-other`;
  const b = await account(h.db, f.ledger, otherApp, a.user_id);
  for (const row of [a, b]) {
    await post(h.db, f.ledger, [row.user_id], change(row.app_id, row.account_id, 1n));
  }
  const v = change(f.appId, a.account_id, -1n, 'REBATE_CREDIT');
  await post(h.db, f.ledger, [a.user_id], v);
  expect(await markers(h.db, otherApp, b.account_id)).toEqual([]);
  expect(
    (await f.ledger.getBalances(h.db, { appId: otherApp, userIds: [b.user_id] }))[0]?.available_fen,
  ).toBe(-1n);
  await post(
    h.db,
    f.ledger,
    [b.user_id],
    change(otherApp, b.account_id, -1n, 'REBATE_CREDIT', { uniqKey: v.uniqKey }),
  );
  expect(f.onRecovered).toHaveBeenCalledTimes(2);
  expect(f.onRecovered.mock.calls.map((call) => call[1])).toEqual([
    expect.objectContaining({ appId: f.appId, userId: a.user_id, accountId: a.account_id }),
    expect.objectContaining({ appId: otherApp, userId: b.user_id, accountId: b.account_id }),
  ]);
});

it('[AC-B2-04ka#6] 不提供回正端口时使用缺省空实现，余额照常回零', async () => {
  const { clock, appId, onRecovered } = context();
  const ledger = createLedger({ clock });
  const a = await account(h.db, ledger, appId);
  await post(h.db, ledger, [a.user_id], change(appId, a.account_id, 1n));
  expect(
    (await post(h.db, ledger, [a.user_id], change(appId, a.account_id, -1n, 'REBATE_CREDIT'))).kind,
  ).toBe('posted');
  expect((await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]).toMatchObject({
    available_fen: 0n,
    negative_since: null,
  });
  expect(onRecovered).not.toHaveBeenCalled();
  expect(await markers(h.db, appId, a.account_id)).toEqual([]);
});

it.each([true, false])(
  '[AC-B2-04ka#7] LEDGER 装配支持可选端口，提供端口=%s 时连库验证回正',
  async (supplied) => {
    const { clock, appId, onRecovered } = context();
    const definition = LedgerModule.forRoot().providers?.find(
      (provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === LEDGER,
    );
    expect(definition).toBeDefined();
    const provider = definition as {
      inject: readonly unknown[];
      useFactory: (...args: unknown[]) => Ledger;
    };
    const tokens = provider.inject.map((dependency) =>
      typeof dependency === 'object' && dependency !== null && 'token' in dependency
        ? dependency.token
        : dependency,
    );
    expect(tokens).toEqual(expect.arrayContaining([CLOCK, BALANCE_RECOVERED_HOOK]));
    expect(provider.inject).toContainEqual({ token: BALANCE_RECOVERED_HOOK, optional: true });
    const dependencies = new Map<unknown, unknown>([
      [CLOCK, clock],
      [BALANCE_RECOVERED_HOOK, supplied ? { onRecovered } : undefined],
    ]);
    const ledger = provider.useFactory(...tokens.map((token) => dependencies.get(token)));
    const a = await account(h.db, ledger, appId);
    await post(h.db, ledger, [a.user_id], change(appId, a.account_id, 1n));
    await post(h.db, ledger, [a.user_id], change(appId, a.account_id, -1n, 'REBATE_CREDIT'));
    expect(onRecovered).toHaveBeenCalledTimes(supplied ? 1 : 0);
    expect(await markers(h.db, appId, a.account_id)).toHaveLength(supplied ? 1 : 0);
    expect(
      (await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]?.available_fen,
    ).toBe(0n);
  },
);
