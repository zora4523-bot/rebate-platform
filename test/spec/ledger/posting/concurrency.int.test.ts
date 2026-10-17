import { randomInt, randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Ledger, PostingVoucher } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  TIMEOUT,
  account,
  bounded,
  close,
  context,
  entry,
  open,
  post,
  snapshot,
  voucher,
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

/** Hold the first writer AFTER its balance lock, with a real PG advisory-lock barrier.
 * Start the other connection, prove its balance lock waits, then release the first writer.
 * Every task is observed immediately and all backends are drained even on assertion failure. */
async function orderedPosts(
  ledger: Ledger,
  userIds: string[],
  first: PostingVoucher,
  second: PostingVoucher,
) {
  const key = randomInt(1, 2_000_000_000);
  const firstPid = Promise.withResolvers<number>();
  const secondPid = Promise.withResolvers<number>();
  await sql`SELECT pg_advisory_lock(${key})`.execute(h.control);
  const left = h.left.transaction().execute(async (trx) => {
    const pid = await bounded(trx);
    await ledger.lockBalances(trx, { appId: first.appId, userIds });
    firstPid.resolve(pid);
    await sql`SELECT pg_advisory_xact_lock(${key})`.execute(trx);
    return ledger.post(trx, first);
  });
  const leftDone = Promise.allSettled([left]);
  let rightDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const pid = await Promise.race([
      firstPid.promise,
      left.then(() => {
        throw new Error('missing first barrier');
      }),
    ]);
    const control = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(h.control);
    await waitBlocked(h.db, pid, control.rows[0]!.pid);
    const right = h.right.transaction().execute(async (trx) => {
      const id = await bounded(trx);
      secondPid.resolve(id);
      await ledger.lockBalances(trx, { appId: second.appId, userIds: [...userIds].reverse() });
      return ledger.post(trx, second);
    });
    rightDone = Promise.allSettled([right]);
    const waiter = await Promise.race([
      secondPid.promise,
      right.then(() => {
        throw new Error('missing second barrier');
      }),
    ]);
    await waitBlocked(h.db, waiter, pid);
  } finally {
    await sql`SELECT pg_advisory_unlock(${key})`.execute(h.control);
    await leftDone;
    await rightDone;
  }
  return [...(await leftDone), ...((await rightDone) ?? [])];
}

it.each(['freeze-first', 'clawback-first'] as const)(
  '[AC-B2-02f#19] 冻结与扣回并发 %s：取得余额行锁后用最新余额判断',
  async (order) => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    await post(h.db, ledger, [a.user_id], voucher(appId, a.account_id, -100n));
    const freeze = voucher(appId, a.account_id, 100n, {
      entries: [
        entry(a.account_id, 100n, 'WITHDRAW_FREEZE'),
        { ...entry(a.account_id, -100n, 'WITHDRAW_FREEZE'), sub_account: 'frozen' },
      ],
    });
    const base = voucher(appId, a.account_id, 100n);
    const clawback = {
      ...base,
      entries: base.entries.map((e) => ({ ...e, ledger_type: 'CLAWBACK' })),
    };
    const results = await orderedPosts(
      ledger,
      [a.user_id],
      order === 'freeze-first' ? freeze : clawback,
      order === 'freeze-first' ? clawback : freeze,
    );
    expect(results.map((r) => r.status)).toEqual(
      order === 'freeze-first' ? ['fulfilled', 'fulfilled'] : ['fulfilled', 'rejected'],
    );
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      {
        ...a,
        available_fen: order === 'freeze-first' ? -100n : 0n,
        frozen_fen: order === 'freeze-first' ? 100n : 0n,
        version: order === 'freeze-first' ? 3n : 2n,
        negative_since: order === 'freeze-first' ? '2032-06-15' : null,
      },
    ]);
    expect((await snapshot(h.db, appId)).vouchers).toHaveLength(order === 'freeze-first' ? 3 : 2);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02f#25] 同一用户同一凭证并发重放只入账一次，等待者返回原 voucherId',
  async () => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const v = voucher(appId, a.account_id, -617n);
    const results = await orderedPosts(ledger, [a.user_id], v, v);
    const stored = await snapshot(h.db, appId);
    expect(stored.vouchers).toHaveLength(1);
    expect(results).toEqual([
      { status: 'fulfilled', value: { kind: 'posted', voucherId: stored.vouchers[0]!.id } },
      { status: 'fulfilled', value: { kind: 'duplicate', voucherId: stored.vouchers[0]!.id } },
    ]);
    expect(stored.entries).toHaveLength(2);
    expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
      { ...a, available_fen: 617n, version: 1n },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02f#26] 并发开户最终只有一个账户与余额行，两调用方事务都能继续',
  async () => {
    const { ledger, appId } = context();
    const userId = randomUUID();
    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const first = h.left.transaction().execute(async (trx) => {
      const pid = await bounded(trx);
      const a = await ledger.openUserAccount(trx, { appId, userId });
      held.resolve(pid);
      await release.promise;
      return a;
    });
    const firstDone = Promise.allSettled([first]);
    let secondDone: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([
        held.promise,
        first.then(() => {
          throw new Error('missing open barrier');
        }),
      ]);
      const started = Promise.withResolvers<number>();
      const second = h.right.transaction().execute(async (trx) => {
        started.resolve(await bounded(trx));
        const a = await ledger.openUserAccount(trx, { appId, userId });
        expect(await ledger.getBalances(trx, { appId, userIds: [userId] })).toEqual([a]);
        return a;
      });
      secondDone = Promise.allSettled([second]);
      const waiter = await Promise.race([
        started.promise,
        second.then(() => {
          throw new Error('missing second opener');
        }),
      ]);
      await waitBlocked(h.db, waiter, pid);
      release.resolve();
      expect(await second).toEqual(await first);
    } finally {
      release.resolve();
      await firstDone;
      await secondDone;
    }
    const stored = await snapshot(h.db, appId);
    expect(stored.accounts).toHaveLength(1);
    expect(stored.balances).toHaveLength(1);
    expect(stored.vouchers).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02f#20] 两连接咨询锁栅栏交替先后 200 轮，两个受益账户无丢更新、无死锁',
  async () => {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    const b = await account(h.db, ledger, appId);
    for (let round = 0; round < 200; round += 1) {
      const base = voucher(appId, a.account_id, -1n);
      const credit = {
        ...base,
        entries: [
          entry(a.account_id, -1n),
          entry(b.account_id, -1n),
          { ...base.entries[1]!, amount_fen: 2n },
        ],
      };
      const debit = {
        ...voucher(appId, a.account_id, 1n),
        entries: [
          entry(b.account_id, 1n, 'CLAWBACK'),
          entry(a.account_id, 1n, 'CLAWBACK'),
          { ...base.entries[1]!, amount_fen: -2n, ledger_type: 'CLAWBACK' },
        ],
      };
      const results = await orderedPosts(
        ledger,
        [b.user_id, a.user_id],
        round % 2 === 0 ? credit : debit,
        round % 2 === 0 ? debit : credit,
      );
      expect(
        results.map((r) => r.status),
        `round ${round}`,
      ).toEqual(['fulfilled', 'fulfilled']);
      expect(
        (await ledger.getBalances(h.db, { appId, userIds: [a.user_id, b.user_id] })).map((r) => ({
          available: r.available_fen,
          frozen: r.frozen_fen,
          version: r.version,
        })),
      ).toEqual(
        [0, 1].map(() => ({ available: 0n, frozen: 0n, version: BigInt((round + 1) * 2) })),
      );
    }
    const state = await snapshot(h.db, appId);
    expect(state.vouchers).toHaveLength(400);
    expect(state.entries).toHaveLength(1200);
    for (const id of [a.account_id, b.account_id]) {
      expect(
        state.entries.filter((e) => e.account_id === id).map((e) => e.account_version),
      ).toEqual(Array.from({ length: 400 }, (_, index) => BigInt(index + 1)));
    }
  },
  TIMEOUT * 5,
);

it(
  '[AC-B2-02f#21] lockBalances 真正按 account_id 升序取锁，不跟输入或 user_id 顺序',
  async () => {
    const { ledger, appId } = context();
    const low = '00000000-0000-4000-8000-000000000001';
    const high = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    // Reverse the user order relative to account order. IDs are scoped by a fresh database file.
    for (const [accountId, userId] of [
      [low, high],
      [high, low],
    ]) {
      await h.db
        .insertInto('ledger_accounts')
        .values({
          id: accountId!,
          app_id: appId,
          owner_type: 'user',
          owner_id: userId!,
          subject: 'USER_BALANCE',
        })
        .execute();
      await h.db
        .insertInto('account_balances')
        .values({
          account_id: accountId!,
          app_id: appId,
          available_fen: 0n,
          frozen_fen: 0n,
          version: 0n,
          negative_since: null,
        })
        .execute();
    }
    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const holder = h.left.transaction().execute(async (trx) => {
      const pid = await bounded(trx);
      await trx
        .selectFrom('account_balances')
        .selectAll()
        .where('account_id', '=', high)
        .forUpdate()
        .execute();
      held.resolve(pid);
      await release.promise;
    });
    const holderDone = Promise.allSettled([holder]);
    let waiterDone: Promise<unknown> | undefined;
    try {
      const holderPid = await Promise.race([
        held.promise,
        holder.then(() => {
          throw new Error('missing holder');
        }),
      ]);
      const started = Promise.withResolvers<number>();
      const waiter = h.right.transaction().execute(async (trx) => {
        started.resolve(await bounded(trx));
        return ledger.lockBalances(trx, { appId, userIds: [low, high] });
      });
      waiterDone = Promise.allSettled([waiter]);
      const waiterPid = await Promise.race([
        started.promise,
        waiter.then(() => {
          throw new Error('missing waiter');
        }),
      ]);
      await waitBlocked(h.db, waiterPid, holderPid);
      // While blocked on high, low MUST already be held by the service transaction.
      await expect(
        h.db.transaction().execute(async (trx) => {
          await bounded(trx);
          await trx
            .selectFrom('account_balances')
            .selectAll()
            .where('account_id', '=', low)
            .forUpdate()
            .noWait()
            .execute();
        }),
      ).rejects.toMatchObject({ code: '55P03' });
      release.resolve();
      expect((await waiter).map((r) => r.account_id)).toEqual([low, high]);
    } finally {
      release.resolve();
      await holderDone;
      await waiterDone;
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-02f#22] 唯一键并发冲突返回 duplicate，外层事务可继续提交下一张凭证',
  async () => {
    const { ledger, appId } = context();
    // Platform-only posting removes user-row serialization: both writers reach the unique key.
    const base = voucher(appId, randomUUID(), 7n);
    const v = {
      ...base,
      entries: [
        {
          ...base.entries[0]!,
          account: { ownerType: 'platform' as const, subject: 'PLATFORM_REVENUE' },
        },
        base.entries[1]!,
      ],
    };
    // Precreate both platform subjects through the public port, avoiding a competing account insert.
    await h.db.transaction().execute((trx) => ledger.post(trx, { ...v, uniqKey: 'platform-seed' }));
    const held = Promise.withResolvers<{ pid: number; voucherId: string }>();
    const release = Promise.withResolvers<void>();
    const left = h.left.transaction().execute(async (trx) => {
      const pid = await bounded(trx);
      const result = await ledger.post(trx, v);
      held.resolve({ pid, voucherId: result.voucherId });
      await release.promise;
      return result;
    });
    const leftDone = Promise.allSettled([left]);
    let rightDone: Promise<unknown> | undefined;
    try {
      const first = await Promise.race([
        held.promise,
        left.then(() => {
          throw new Error('missing first insert');
        }),
      ]);
      const started = Promise.withResolvers<number>();
      const right = h.right.transaction().execute(async (trx) => {
        started.resolve(await bounded(trx));
        const duplicate = await ledger.post(trx, v);
        expect(duplicate).toEqual({ kind: 'duplicate', voucherId: first.voucherId });
        const next = await ledger.post(trx, { ...v, uniqKey: 'after-conflict' });
        expect(next.kind).toBe('posted');
        return next;
      });
      rightDone = Promise.allSettled([right]);
      const secondPid = await Promise.race([
        started.promise,
        right.then(() => {
          throw new Error('missing second insert');
        }),
      ]);
      await waitBlocked(h.db, secondPid, first.pid);
      release.resolve();
      expect((await right).kind).toBe('posted');
      expect((await left).kind).toBe('posted');
    } finally {
      release.resolve();
      await leftDone;
      await rightDone;
    }
    const state = await snapshot(h.db, appId);
    expect(state.vouchers).toHaveLength(3);
    expect(state.entries).toHaveLength(6);
    expect(state.balances).toEqual([]);
  },
  TIMEOUT,
);
