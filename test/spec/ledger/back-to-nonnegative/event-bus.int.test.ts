import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  BALANCE_RECOVERED_HOOK,
  LEDGER,
  LedgerModule,
  type BalanceRecoveredHook,
  type Ledger,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { CLOCK, EVENT_BUS } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  TIMEOUT,
  account,
  change,
  close,
  context,
  entry,
  events,
  jobs,
  open,
  snapshot,
  type Harness,
} from '../went-negative/kit.ts';
import { mark, markers } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** Production LEDGER provider with the real platform event bus and a recording recovery port. */
function wired(f: ReturnType<typeof context>) {
  const onRecovered = vi.fn<BalanceRecoveredHook['onRecovered']>(mark);
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
  expect(tokens).toEqual(expect.arrayContaining([CLOCK, EVENT_BUS, BALANCE_RECOVERED_HOOK]));
  expect(provider.inject).toContainEqual({ token: EVENT_BUS, optional: true });
  expect(provider.inject).toContainEqual({ token: BALANCE_RECOVERED_HOOK, optional: true });
  const dependencies = new Map<unknown, unknown>([
    [CLOCK, f.clock],
    [EVENT_BUS, { publish: f.publish }],
    [BALANCE_RECOVERED_HOOK, { onRecovered }],
  ]);
  const ledger = provider.useFactory(...tokens.map((token) => dependencies.get(token)));
  return { ledger, onRecovered };
}

it('[AC-B2-04ka#15] 生产装配同时注入事件总线与回正端口：扣负同事务发布 account.went_negative，回正同事务调用端口', async () => {
  const f = context(h, `recovered-bus-${randomUUID()}`);
  const { appId } = f;
  const { ledger, onRecovered } = wired(f);
  const a = await account(h.db, ledger, appId);
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    expect((await ledger.post(trx, change(appId, a.account_id, 2n))).kind).toBe('posted');
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0]?.[0]).toBe(trx);
    expect(f.publish.mock.calls[0]?.[1]).toMatchObject({
      appId,
      name: 'account.went_negative',
      payload: { user_id: a.user_id },
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[3].trx).toBe(trx);
    expect(await events(trx, appId)).toHaveLength(1);
    expect(await jobs(trx, appId)).toHaveLength(1);
    expect(await events(h.right, appId)).toEqual([]);
    expect(await jobs(h.right, appId)).toEqual([]);
    expect(onRecovered).not.toHaveBeenCalled();
  });
  const recovered = await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    const posted = await ledger.post(trx, change(appId, a.account_id, -2n, 'REBATE_CREDIT'));
    expect(posted.kind).toBe('posted');
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onRecovered.mock.calls[0]?.[0]).toBe(trx);
    expect(onRecovered.mock.calls[0]?.[1]).toEqual({
      appId,
      userId: a.user_id,
      accountId: a.account_id,
      availableBefore: -2n,
      availableAfter: 0n,
      voucherId: posted.voucherId,
    });
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(await markers(trx, appId, a.account_id)).toHaveLength(1);
    expect(await markers(h.right, appId, a.account_id)).toEqual([]);
    return posted;
  });
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    await ledger.post(trx, change(appId, a.account_id, 1n, 'ADMIN_ADJUST'));
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.calls[1]?.[0]).toBe(trx);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    const posted = await ledger.post(trx, change(appId, a.account_id, -3n, 'REBATE_CREDIT'));
    expect(onRecovered).toHaveBeenCalledTimes(2);
    expect(onRecovered.mock.calls[1]?.[0]).toBe(trx);
    expect(onRecovered.mock.calls[1]?.[1]).toMatchObject({
      availableBefore: -1n,
      availableAfter: 2n,
      voucherId: posted.voucherId,
    });
    expect(f.publish).toHaveBeenCalledTimes(2);
  });
  expect(await events(h.db, appId)).toHaveLength(2);
  expect(await jobs(h.db, appId)).toHaveLength(2);
  expect(await markers(h.db, appId, a.account_id)).toHaveLength(2);
  expect(await markers(h.db, appId, a.account_id)).toEqual(
    expect.arrayContaining([expect.objectContaining({ event_id: recovered.voucherId })]),
  );
  expect((await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]).toMatchObject({
    available_fen: 2n,
    negative_since: null,
  });
});

it('[AC-B2-04ka#16] 同一凭证一个账户扣负一个账户回正时事件与端口都生效，端口抛错连同事件整体回滚后可重试', async () => {
  const f = context(h, `recovered-bus-${randomUUID()}`);
  const { appId } = f;
  const { ledger, onRecovered } = wired(f);
  const a = await account(h.db, ledger, appId);
  const b = await account(h.db, ledger, appId);
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [b.user_id] });
    await ledger.post(trx, change(appId, b.account_id, 1n));
  });
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(await events(h.db, appId)).toHaveLength(1);
  const before = await snapshot(h.db, appId);
  const base = change(appId, a.account_id, 1n);
  const v = {
    ...base,
    entries: [
      entry(a.account_id, 2n, 'CLAWBACK'),
      entry(b.account_id, -1n, 'CLAWBACK'),
      { ...base.entries[1]!, amount_fen: -1n },
    ],
  };
  const failure = new Error('cleanup failed');
  onRecovered.mockImplementationOnce(async (trx, input) => {
    await mark(trx, input);
    throw failure;
  });
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id, b.user_id] });
    await expect(ledger.post(trx, v)).rejects.toBe(failure);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(await snapshot(trx, appId)).toEqual(before);
    expect(await events(trx, appId)).toHaveLength(1);
    expect(await jobs(trx, appId)).toHaveLength(1);
    expect(await markers(trx, appId, b.account_id)).toEqual([]);
    const posted = await ledger.post(trx, v);
    expect(posted.kind).toBe('posted');
    expect(onRecovered).toHaveBeenCalledTimes(2);
    expect(onRecovered.mock.calls[1]?.[0]).toBe(trx);
    expect(onRecovered.mock.calls[1]?.[1]).toEqual({
      appId,
      userId: b.user_id,
      accountId: b.account_id,
      availableBefore: -1n,
      availableAfter: 0n,
      voucherId: posted.voucherId,
    });
    const logs = await events(trx, appId);
    expect(logs).toHaveLength(2);
    expect(logs.map((row) => row.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ v: 1, data: { user_id: a.user_id } }),
        expect.objectContaining({ v: 1, data: { user_id: b.user_id } }),
      ]),
    );
    expect(await jobs(trx, appId)).toHaveLength(2);
    expect(await events(h.right, appId)).toHaveLength(1);
  });
  expect(await events(h.db, appId)).toHaveLength(2);
  expect(await jobs(h.db, appId)).toHaveLength(2);
  expect(await markers(h.db, appId, a.account_id)).toEqual([]);
  expect(await markers(h.db, appId, b.account_id)).toHaveLength(1);
  const balances = await ledger.getBalances(h.db, { appId, userIds: [a.user_id, b.user_id] });
  expect(balances.find((row) => row.user_id === a.user_id)).toMatchObject({
    available_fen: -2n,
    negative_since: '2032-06-15',
  });
  expect(balances.find((row) => row.user_id === b.user_id)).toMatchObject({
    available_fen: 0n,
    negative_since: null,
  });
});
