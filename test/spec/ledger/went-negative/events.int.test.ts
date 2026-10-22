import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  LEDGER,
  LedgerModule,
  type Ledger,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { CLOCK, EVENT_BUS } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  TIMEOUT,
  INSTANT,
  account,
  change,
  close,
  context,
  entry,
  events,
  jobs,
  open,
  post,
  snapshot,
  bounded,
  waitBlocked,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each(['CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST'] as const)(
  '[AC-B2-04k#13] %s 从零扣负，事件日志与订阅任务在记账事务内可见、提交前外部不可见',
  async (type) => {
    const { ledger, appId, publish, send } = context(h);
    const a = await account(h.db, ledger, appId);
    const v = change(appId, a.account_id, 1n, type);
    await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      const posted = await ledger.post(trx, v);
      expect(posted.kind).toBe('posted');
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]?.[0]).toBe(trx);
      expect(publish.mock.calls[0]?.[1]).toMatchObject({
        appId,
        name: 'account.went_negative',
        payload: { user_id: a.user_id },
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[3].trx).toBe(trx);
      const logs = await events(trx, appId);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        app_id: appId,
        name: 'account.went_negative',
        occurred_at: new Date(INSTANT),
        payload: { v: 1, data: { user_id: a.user_id } },
      });
      const queued = await jobs(trx, appId);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        id: logs[0]!.event_id,
        state: 'created',
        data: {
          name: 'account.went_negative',
          payload: { app_id: appId, v: 1, occurred_at: INSTANT, data: { user_id: a.user_id } },
        },
      });
      expect(await events(h.right, appId)).toEqual([]);
      expect(await jobs(h.right, appId)).toEqual([]);
    });
    expect(await events(h.db, appId)).toHaveLength(1);
    expect(await jobs(h.db, appId)).toHaveLength(1);
    expect(
      (await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]?.available_fen,
    ).toBe(-1n);
  },
);

it('[AC-B2-04k#14] 只在穿过零点时发布：正到零、负到更负、负到零和负到正不发布，再次扣负产生新事件', async () => {
  const { ledger, appId, clock, publish } = context(h);
  const a = await account(h.db, ledger, appId);
  for (const [debit, type, expected, count] of [
    [-10n, 'REBATE_CREDIT', 10n, 0],
    [10n, 'CLAWBACK', 0n, 0],
    [1n, 'CLAWBACK', -1n, 1],
    [2n, 'SETTLE_ADJUST', -3n, 1],
    [-1n, 'REBATE_CREDIT', -2n, 1],
    [-2n, 'REBATE_CREDIT', 0n, 1],
    [1n, 'ADMIN_ADJUST', -1n, 2],
    [-2n, 'REBATE_CREDIT', 1n, 2],
    [2n, 'CLAWBACK', -1n, 3],
  ] as const) {
    clock.set('2032-06-16T16:00:00.000Z');
    await post(h.db, ledger, [a.user_id], change(appId, a.account_id, debit, type));
    expect(
      (await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]?.available_fen,
    ).toBe(expected);
    expect(publish).toHaveBeenCalledTimes(count);
    expect(await events(h.db, appId)).toHaveLength(count);
    expect(await jobs(h.db, appId)).toHaveLength(count);
  }
  const logs = await events(h.db, appId);
  expect(new Set(logs.map((row) => row.event_id)).size).toBe(3);
  expect(logs.every((row) => row.occurred_at.toISOString() === '2032-06-16T16:00:00.000Z')).toBe(
    true,
  );
});

it('[AC-B2-04k#15] 多账户逐个比较、同账户多分录按凭证净额比较，frozen 不参与', async () => {
  const { ledger, appId, publish } = context(h);
  const a = await account(h.db, ledger, appId);
  const b = await account(h.db, ledger, appId);
  const c = await account(h.db, ledger, appId);
  const d = await account(h.db, ledger, appId);
  await post(h.db, ledger, [a.user_id], change(appId, a.account_id, -10n, 'REBATE_CREDIT'));
  await post(h.db, ledger, [c.user_id], change(appId, c.account_id, 1n));
  publish.mockClear();
  const base = change(appId, a.account_id, 1n);
  await post(h.db, ledger, [d.user_id, c.user_id, b.user_id, a.user_id], {
    ...base,
    entries: [
      entry(a.account_id, 20n, 'CLAWBACK'),
      entry(a.account_id, -9n, 'CLAWBACK'),
      entry(b.account_id, 3n, 'CLAWBACK'),
      entry(b.account_id, -2n, 'CLAWBACK'),
      entry(c.account_id, 2n, 'CLAWBACK'),
      // An intermediate debit below zero, followed by an equal credit: final available = 0.
      entry(d.account_id, 5n, 'CLAWBACK'),
      entry(d.account_id, -5n, 'CLAWBACK'),
      { ...entry(d.account_id, -7n, 'CLAWBACK'), sub_account: 'frozen' },
      { ...base.entries[1]!, amount_fen: -7n },
    ],
  });
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish.mock.calls.map((call) => call[1].payload['user_id']).sort()).toEqual(
    [a.user_id, b.user_id].sort(),
  );
  const balances = await ledger.getBalances(h.db, {
    appId,
    userIds: [a.user_id, b.user_id, c.user_id, d.user_id],
  });
  expect(balances.find((row) => row.user_id === a.user_id)?.available_fen).toBe(-1n);
  expect(balances.find((row) => row.user_id === b.user_id)?.available_fen).toBe(-1n);
  expect(balances.find((row) => row.user_id === c.user_id)?.available_fen).toBe(-3n);
  expect(balances.find((row) => row.user_id === d.user_id)).toMatchObject({
    available_fen: 0n,
    frozen_fen: 7n,
  });
  expect(await events(h.db, appId)).toHaveLength(3);
  expect(await jobs(h.db, appId)).toHaveLength(3);
});

it('[AC-B2-04k#16] 同凭证重放不重发；同用户同凭证键在另一 app 独立判定', async () => {
  const f = context(h);
  const a = await account(h.db, f.ledger, f.appId);
  const v = change(f.appId, a.account_id, 1n);
  const first = await post(h.db, f.ledger, [a.user_id], v);
  expect(await post(h.db, f.ledger, [a.user_id], v)).toEqual({
    kind: 'duplicate',
    voucherId: first.voucherId,
  });
  expect(f.publish).toHaveBeenCalledTimes(1);
  const other = context(h, `${f.appId}-other`);
  const b = await account(h.db, other.ledger, other.appId, a.user_id);
  await post(
    h.db,
    other.ledger,
    [b.user_id],
    change(other.appId, b.account_id, 1n, 'CLAWBACK', { uniqKey: v.uniqKey }),
  );
  expect(await events(h.db, f.appId)).toHaveLength(1);
  expect(await events(h.db, other.appId)).toHaveLength(1);
  expect(await jobs(h.db, f.appId)).toHaveLength(1);
  expect(await jobs(h.db, other.appId)).toHaveLength(1);
});

it('[AC-B2-04k#17] 调用方回滚同时撤销余额、凭证、事件和任务，重试可完整提交', async () => {
  const { ledger, appId } = context(h);
  const a = await account(h.db, ledger, appId);
  const before = await snapshot(h.db, appId);
  const v = change(appId, a.account_id, 1n);
  const abort = new Error('caller rollback');
  await expect(
    h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      await ledger.post(trx, v);
      expect(await events(trx, appId)).toHaveLength(1);
      expect(await jobs(trx, appId)).toHaveLength(1);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await snapshot(h.db, appId)).toEqual(before);
  expect(await events(h.db, appId)).toEqual([]);
  expect(await jobs(h.db, appId)).toEqual([]);
  expect((await post(h.db, ledger, [a.user_id], v)).kind).toBe('posted');
  expect(await events(h.db, appId)).toHaveLength(1);
  expect(await jobs(h.db, appId)).toHaveLength(1);
});

it('[AC-B2-04k#18] 第二个账户入队失败时整体回滚，含第一个任务，调用方捕获后仍可重试', async () => {
  const { ledger, appId, send } = context(h);
  const a = await account(h.db, ledger, appId);
  const b = await account(h.db, ledger, appId);
  const before = await snapshot(h.db, appId);
  const base = change(appId, a.account_id, 1n);
  const v = {
    ...base,
    entries: [
      entry(a.account_id, 1n, 'CLAWBACK'),
      entry(b.account_id, 1n, 'CLAWBACK'),
      { ...base.entries[1]!, amount_fen: -2n },
    ],
  };
  const failure = new Error('queue unavailable');
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id, b.user_id] });
    send
      .mockImplementationOnce(h.setup.runtime.send.bind(h.setup.runtime))
      .mockRejectedValueOnce(failure);
    await expect(ledger.post(trx, v)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await snapshot(trx, appId)).toEqual(before);
    expect(await events(trx, appId)).toEqual([]);
    expect(await jobs(trx, appId)).toEqual([]);
    expect((await ledger.post(trx, v)).kind).toBe('posted');
  });
  expect(await events(h.db, appId)).toHaveLength(2);
  expect(await jobs(h.db, appId)).toHaveLength(2);
});

it('[AC-B2-04k#21] 连库装配的 LEDGER 工厂使用同一平台事件总线并在记账事务内发布扣负事件', async () => {
  const f = context(h);
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
  expect(tokens).toEqual(expect.arrayContaining([CLOCK, EVENT_BUS]));
  const dependencies = new Map<unknown, unknown>([
    [CLOCK, f.clock],
    [EVENT_BUS, { publish: f.publish }],
  ]);
  const ledger = provider.useFactory(...tokens.map((token) => dependencies.get(token)));
  const a = await account(h.db, ledger, f.appId);
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId: f.appId, userIds: [a.user_id] });
    await ledger.post(trx, change(f.appId, a.account_id, 1n));
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0]?.[0]).toBe(trx);
    expect(f.publish.mock.calls[0]?.[1]).toMatchObject({
      appId: f.appId,
      name: 'account.went_negative',
      payload: { user_id: a.user_id },
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[3].trx).toBe(trx);
    expect(await events(trx, f.appId)).toHaveLength(1);
    expect(await jobs(trx, f.appId)).toHaveLength(1);
    expect(await events(h.right, f.appId)).toEqual([]);
    expect(await jobs(h.right, f.appId)).toEqual([]);
  });
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(await events(h.db, f.appId)).toHaveLength(1);
  expect(await jobs(h.db, f.appId)).toHaveLength(1);
});

it('[AC-B2-04k#22] 同一事务先扣负、回零、再次扣负，两个凭证各自产生事件且重放不增加', async () => {
  const { ledger, appId, publish } = context(h);
  const a = await account(h.db, ledger, appId);
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    const first = change(appId, a.account_id, 1n);
    await ledger.post(trx, first);
    await ledger.post(trx, change(appId, a.account_id, -1n, 'REBATE_CREDIT'));
    await ledger.post(trx, change(appId, a.account_id, 1n));
    expect((await ledger.post(trx, first)).kind).toBe('duplicate');
    expect(publish).toHaveBeenCalledTimes(2);
    expect(await events(trx, appId)).toHaveLength(2);
    expect(await jobs(trx, appId)).toHaveLength(2);
  });
  expect(await events(h.db, appId)).toHaveLength(2);
  expect(await jobs(h.db, appId)).toHaveLength(2);
});

it.each(['WITHDRAW_FREEZE', 'WITHDRAW_FEE', 'TAX_WITHHOLD'] as const)(
  '[AC-B2-04k#19] 禁止 %s 扣负的失败凭证不发布事件或任务',
  async (type) => {
    const { ledger, appId, publish } = context(h);
    const a = await account(h.db, ledger, appId);
    const before = await snapshot(h.db, appId);
    await expect(
      post(h.db, ledger, [a.user_id], change(appId, a.account_id, 1n, type)),
    ).rejects.toMatchObject({ code: 'NEGATIVE_BALANCE' });
    expect(publish).not.toHaveBeenCalled();
    expect(await snapshot(h.db, appId)).toEqual(before);
    expect(await events(h.db, appId)).toEqual([]);
    expect(await jobs(h.db, appId)).toEqual([]);
  },
);

it.each(['same-voucher', 'different-voucher'] as const)(
  '[AC-B2-04k#20] 并发 %s 在余额锁内读取最新值，只发布首次跨零事件',
  async (mode) => {
    const { ledger, appId, publish } = context(h);
    const a = await account(h.db, ledger, appId);
    const v = change(appId, a.account_id, 1n);
    const ready = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const waiter = Promise.withResolvers<number>();
    const left = h.left.transaction().execute(async (trx) => {
      const pid = await bounded(trx);
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      const posted = await ledger.post(trx, v);
      ready.resolve(pid);
      await release.promise;
      return posted;
    });
    const leftDone = Promise.allSettled([left]);
    let rightDone: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([
        ready.promise,
        left.then(() => {
          throw new Error('missing holder barrier');
        }),
      ]);
      const right = h.right.transaction().execute(async (trx) => {
        waiter.resolve(await bounded(trx));
        await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
        return ledger.post(trx, mode === 'same-voucher' ? v : { ...v, uniqKey: randomUUID() });
      });
      rightDone = Promise.allSettled([right]);
      const waiterPid = await Promise.race([
        waiter.promise,
        right.then(() => {
          throw new Error('missing waiter barrier');
        }),
      ]);
      await waitBlocked(h.db, waiterPid, pid);
      release.resolve();
      expect((await right).kind).toBe(mode === 'same-voucher' ? 'duplicate' : 'posted');
      expect((await left).kind).toBe('posted');
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await events(h.db, appId)).toHaveLength(1);
      expect(await jobs(h.db, appId)).toHaveLength(1);
      expect(
        (await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]?.available_fen,
      ).toBe(mode === 'same-voucher' ? -1n : -2n);
    } finally {
      release.resolve();
      await leftDone;
      await rightDone;
    }
  },
  TIMEOUT,
);
