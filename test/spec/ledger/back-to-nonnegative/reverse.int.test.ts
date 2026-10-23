import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-04ka#13] reverse 红冲扣回使负余额回到 0 时同事务调用一次，未回正的红冲与重放不调用', async () => {
  const { ledger, appId, onRecovered } = context();
  const a = await account(h.db, ledger, appId);
  const first = change(appId, a.account_id, 10n);
  const second = change(appId, a.account_id, 5n);
  await post(h.db, ledger, [a.user_id], first);
  await post(h.db, ledger, [a.user_id], second);
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    const partial = await ledger.reverse(trx, { appId, originalUniqKey: second.uniqKey });
    expect(partial.kind).toBe('posted');
    expect(
      (await ledger.getBalances(trx, { appId, userIds: [a.user_id] }))[0]?.available_fen,
    ).toBe(-10n);
    expect(onRecovered).not.toHaveBeenCalled();
  });
  const result = await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    const reversed = await ledger.reverse(trx, { appId, originalUniqKey: first.uniqKey });
    expect(reversed.kind).toBe('posted');
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onRecovered.mock.calls[0]?.[0]).toBe(trx);
    expect(onRecovered.mock.calls[0]?.[1]).toEqual({
      appId,
      userId: a.user_id,
      accountId: a.account_id,
      availableBefore: -10n,
      availableAfter: 0n,
      voucherId: reversed.voucherId,
    });
    expect(await markers(trx, appId, a.account_id)).toHaveLength(1);
    expect(await markers(h.right, appId, a.account_id)).toEqual([]);
    expect((await ledger.getBalances(h.right, { appId, userIds: [a.user_id] }))[0]).toMatchObject({
      available_fen: -10n,
      negative_since: '2032-06-15',
    });
    expect(await ledger.reverse(trx, { appId, originalUniqKey: first.uniqKey })).toEqual({
      kind: 'duplicate',
      voucherId: reversed.voucherId,
    });
    expect(onRecovered).toHaveBeenCalledTimes(1);
    return reversed;
  });
  expect(await markers(h.db, appId, a.account_id)).toEqual([
    expect.objectContaining({ event_id: result.voucherId }),
  ]);
  expect((await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]).toMatchObject({
    available_fen: 0n,
    negative_since: null,
  });
  const replay = await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    return ledger.reverse(trx, { appId, originalUniqKey: first.uniqKey });
  });
  expect(replay).toEqual({ kind: 'duplicate', voucherId: result.voucherId });
  expect(onRecovered).toHaveBeenCalledTimes(1);
  expect(await markers(h.db, appId, a.account_id)).toHaveLength(1);
});

it('[AC-B2-04ka#14] 多账户红冲各自判定：负转正调用，仍为负与非负间变化不调用', async () => {
  const { ledger, appId, onRecovered } = context();
  const a = await account(h.db, ledger, appId);
  const b = await account(h.db, ledger, appId);
  const c = await account(h.db, ledger, appId);
  await post(h.db, ledger, [a.user_id], change(appId, a.account_id, -3n, 'REBATE_CREDIT'));
  await post(h.db, ledger, [b.user_id], change(appId, b.account_id, 4n));
  await post(h.db, ledger, [c.user_id], change(appId, c.account_id, -20n, 'REBATE_CREDIT'));
  const base = change(appId, a.account_id, 15n);
  const original = {
    ...base,
    entries: [
      entry(a.account_id, 5n, 'CLAWBACK'),
      entry(b.account_id, 5n, 'CLAWBACK'),
      entry(c.account_id, 5n, 'CLAWBACK'),
      { ...base.entries[1]!, amount_fen: -15n },
    ],
  };
  await post(h.db, ledger, [a.user_id, b.user_id, c.user_id], original);
  expect(onRecovered).not.toHaveBeenCalled();
  const reversed = await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [c.user_id, b.user_id, a.user_id] });
    const result = await ledger.reverse(trx, { appId, originalUniqKey: original.uniqKey });
    expect(result.kind).toBe('posted');
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onRecovered.mock.calls[0]?.[0]).toBe(trx);
    expect(onRecovered.mock.calls[0]?.[1]).toEqual({
      appId,
      userId: a.user_id,
      accountId: a.account_id,
      availableBefore: -2n,
      availableAfter: 3n,
      voucherId: result.voucherId,
    });
    return result;
  });
  for (const [row, expected, count] of [
    [a, 3n, 1],
    [b, -4n, 0],
    [c, 20n, 0],
  ] as const) {
    expect(
      (await ledger.getBalances(h.db, { appId, userIds: [row.user_id] }))[0]?.available_fen,
    ).toBe(expected);
    expect(await markers(h.db, appId, row.account_id)).toHaveLength(count);
  }
  expect(await markers(h.db, appId, a.account_id)).toEqual([
    expect.objectContaining({ event_id: reversed.voucherId }),
  ]);
});
