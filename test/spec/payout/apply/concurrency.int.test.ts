import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { voucher } from '../../ledger/posting/kit.ts';
import {
  answer,
  close,
  fixture,
  invariant,
  open,
  rows,
  state,
  success,
  TIMEOUT,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it(
  '[AC-B2-05d#20] 可用 100 元，20 个不同键并发各取 10 元：恰好 10 单且从不超额冻结',
  async () => {
    const f = await fixture(h);
    const responses = await Promise.all(Array.from({ length: 20 }, () => f.request()));
    expect(responses.filter((r) => answer(r).code === 0)).toHaveLength(10);
    expect(responses.filter((r) => answer(r).code === 30301)).toHaveLength(10);
    const s = await state(f);
    expect(s.withdrawals).toHaveLength(10);
    expect(s.vouchers).toHaveLength(10);
    expect(s.balances[0]).toMatchObject({ available_fen: 0n, frozen_fen: 10000n });
    expect(s.keys).toHaveLength(20);
    await invariant(f);
  },
  TIMEOUT,
);

it.each([
  ['daily_count_per_user', 'daily_count'],
  ['monthly_count_per_user', 'monthly_count'],
  ['payee_daily_count', 'payee_daily_count'],
] as const)(
  '[AC-B2-05d#21] %s=1，同用户并发两单恰好一单通过，另一单 %s',
  async (config, reason) => {
    const f = await fixture(h);
    await f.set(`withdraw.${config}`, 1);
    const responses = (await Promise.all([f.request(), f.request()])).map(answer);
    expect(responses.filter((r) => r.code === 0)).toHaveLength(1);
    expect(responses.filter((r) => r.code !== 0)).toEqual([
      { code: 30303, msg: '', trace_id: f.actor.userId, data: { reason } },
    ]);
    expect(await rows(f)).toHaveLength(1);
    await invariant(f);
  },
  TIMEOUT,
);

it.each(['payee_daily_count', 'payee_daily_distinct_users'] as const)(
  '[AC-B2-05d#22] 同 app 两用户共享历史快照 HMAC，以账号锁串行复核 %s',
  async (limit) => {
    const a = await fixture(h);
    const b = await fixture(h, { appId: a.actor.appId });
    await a.set(`withdraw.${limit}`, 1);
    // Existing current-binding uniqueness is identity's concern. These are two already-read
    // snapshots around a rebind, the race BR-WDR-07's payee lock must serialize.
    const snapshot = b.options.snapshot.read;
    b.options.snapshot.read = async (handle, actor) => {
      const row = await snapshot(handle, actor);
      return row === null ? null : { ...row, payee_hmac: a.hmac };
    };
    const subject = b.options.rules.subject.read;
    b.options.rules.subject.read = async (handle, actor) => {
      const row = await subject(handle, actor);
      return row === null ? null : { ...row, payee_hmac: a.hmac };
    };
    const responses = (await Promise.all([a.request(), b.request()])).map(answer);
    expect(responses.filter((r) => r.code === 0)).toHaveLength(1);
    expect(responses.find((r) => r.code !== 0)).toMatchObject({
      code: 30303,
      data: { reason: limit === 'payee_daily_count' ? 'payee_daily_count' : 'payee_daily_users' },
    });
    expect(await rows(a)).toHaveLength(1);
    await invariant(a);
  },
  TIMEOUT,
);

it.each(['balance', 'negative', 'hold', 'daily', 'minor'] as const)(
  '[AC-B2-05d#23] 锁外通过后另一事务修改 %s，锁内以最新状态拒绝，不建单不冻结',
  async (change) => {
    const f = await fixture(h);
    if (change === 'daily') await f.set('withdraw.daily_count_per_user', 1);
    if (change === 'minor') {
      await f.set('withdraw.minor_monthly_cap_fen', 1500);
      f.options.rules.realname.verified = async () => ({
        name: '合成姓名',
        birth_date: '2010-01-01',
        provider: 'synthetic',
        verified_at: f.clock.now(),
      });
    }
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calculator = f.options.rules.feeTax;
    let reads = 0;
    f.options.rules.feeTax = {
      calculate: async (handle, input) => {
        const value = await calculator.calculate(handle, input);
        reads += 1;
        if (reads === 1) {
          entered.resolve();
          await release.promise;
        }
        return value;
      },
    };
    const useCase = f.service(); // Throw the skeleton before creating a suspended transaction.
    const pending = h.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      return useCase.apply(trx, { ...f.actor, amountFen: 1000n, stepUpValid: true });
    });
    const settled = Promise.allSettled([pending]);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('missing outside-validation barrier');
        }),
      ]);
      if (change === 'balance' || change === 'negative') {
        await h.observer.transaction().execute(async (trx) => {
          await lockUsersForUpdate(trx, { appId: f.actor.appId, userIds: [f.actor.userId] });
          const balances = await f.ledger.lockBalances(trx, {
            appId: f.actor.appId,
            userIds: [f.actor.userId],
          });
          const v = voucher(
            f.actor.appId,
            balances[0]!.account_id,
            change === 'balance' ? 9500n : 10001n,
          );
          await f.ledger.post(trx, {
            ...v,
            entries: v.entries.map((entry) => ({ ...entry, ledger_type: 'CLAWBACK' })),
          });
        });
      } else if (change === 'hold') {
        await h.observer.transaction().execute(async (trx) => {
          await lockUsersForUpdate(trx, { appId: f.actor.appId, userIds: [f.actor.userId] });
          await f.ledger.lockBalances(trx, { appId: f.actor.appId, userIds: [f.actor.userId] });
          await sql`INSERT INTO app.withdraw_holds (id,app_id,user_id,reason,created_by)
            VALUES (gen_random_uuid(),${f.actor.appId},${f.actor.userId},'ledger_mismatch','synthetic')`.execute(
            trx,
          );
        });
      } else {
        // A second application commits while the first still holds its old validation input.
        const other = f.service();
        success(
          await h.observer
            .transaction()
            .execute((trx) =>
              other.apply(trx, { ...f.actor, amountFen: 1000n, stepUpValid: true }),
            ),
        );
      }
      const before = await state(f);
      release.resolve();
      const result = await pending;
      expect(result).toMatchObject(
        change === 'balance'
          ? { code: 30301 }
          : change === 'negative'
            ? { code: 30302 }
            : change === 'minor'
              ? { code: 30309, data: { remaining_fen: 500n } }
              : {
                  code: 30303,
                  data: { reason: change === 'hold' ? 'account_frozen' : 'daily_count' },
                },
      );
      expect(await state(f)).toEqual(before);
      await invariant(f);
    } finally {
      release.resolve();
      await settled;
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-05d#24] 锁顺序 users → balance → payee 单 bigint advisory；复核和 post 在同一事务',
  async () => {
    const f = await fixture(h);
    const calls: string[] = [];
    let transaction: unknown;
    async function payeeAvailable() {
      return h.observer.transaction().execute(async (trx) => {
        const r = await sql<{
          ok: boolean;
        }>`SELECT pg_try_advisory_xact_lock(hashtext(${`${f.actor.appId}:${f.hmac}`})::bigint) AS ok`.execute(
          trx,
        );
        return r.rows[0]!.ok;
      });
    }
    f.options.lockUsersForUpdate = async (trx, input) => {
      expect(calls).toEqual([]);
      transaction = trx;
      const result = await lockUsersForUpdate(trx, input);
      calls.push('users');
      return result;
    };
    f.options.ledger = {
      ...f.ledger,
      lockBalances: async (trx, input) => {
        expect(trx).toBe(transaction);
        expect(calls).toEqual(['users']);
        // Balance lock must not be taken before the user lock; NOWAIT observes the real PG row lock.
        await expect(
          h.observer
            .transaction()
            .execute((other) =>
              other
                .withSchema('app')
                .selectFrom('users')
                .select('id')
                .where('app_id', '=', f.actor.appId)
                .where('id', '=', f.actor.userId)
                .forNoKeyUpdate()
                .noWait()
                .execute(),
            ),
        ).rejects.toMatchObject({ code: '55P03' });
        expect(await payeeAvailable()).toBe(true);
        const result = await f.ledger.lockBalances(trx, input);
        calls.push('balance');
        return result;
      },
      post: async (trx, v) => {
        expect(trx).toBe(transaction);
        expect(calls).toEqual(['users', 'balance']);
        expect(await payeeAvailable()).toBe(false);
        calls.push('post');
        return f.ledger.post(trx, v);
      },
    };
    let reads = 0;
    f.options.rules.usage = {
      read: async (handle, input) => {
        reads += 1;
        if (reads > 1) {
          expect(handle).toBe(transaction);
          expect(calls).toEqual(['users', 'balance']);
          expect(await payeeAvailable()).toBe(false);
        }
        return (await import('../../../../apps/api/src/modules/payout/infra/withdraw-usage.ts'))
          .createWithdrawUsageReader()
          .read(handle, input);
      },
    };
    success(await h.db.transaction().execute((trx) => f.apply(trx)));
    expect(calls).toEqual(['users', 'balance', 'post']);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await payeeAvailable()).toBe(true);
  },
  TIMEOUT,
);
