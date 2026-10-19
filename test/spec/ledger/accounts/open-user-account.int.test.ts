import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  insertUser,
  type NewUser,
} from '../../../../apps/api/src/modules/identity/infra/registration-store.ts';
import * as ledgerPort from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  TIMEOUT,
  INSTANT,
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
} from '../posting/kit.ts';

// BR-FUND-13 / B2-02g §9: real database, application role, caller-owned transactions.
// The merged posting kit only supplies fixtures; this suite calls the NEW public function.
let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);
afterEach(() => {
  vi.restoreAllMocks();
});

function input(): { appId: string; userId: string } {
  return { appId: `accounts-${randomUUID()}`, userId: randomUUID() };
}

async function expectInitial(db: Kysely<DB>, who: ReturnType<typeof input>) {
  const stored = await snapshot(db, who.appId);
  expect(stored.accounts).toHaveLength(1);
  const account = stored.accounts[0]!;
  expect(account).toMatchObject({
    app_id: who.appId,
    owner_type: 'user',
    owner_id: who.userId,
    subject: 'USER_BALANCE',
  });
  expect(stored.balances).toEqual([
    expect.objectContaining({
      app_id: who.appId,
      account_id: account.id,
      available_fen: 0n,
      frozen_fen: 0n,
      version: 0n,
      negative_since: null,
    }),
  ]);
  expect(stored.vouchers).toEqual([]);
  expect(stored.entries).toEqual([]);
  return stored;
}

function newUser(appId: string): NewUser {
  const id = randomUUID();
  return {
    id,
    appId,
    phoneCipher: Buffer.from(`test-cipher-${id}`),
    phoneHmac: `test-hmac-${id}`,
    nickname: '开户测试用户',
    avatar: 'test-avatar',
    inviteCode: `invite-${id}`,
    attrCode: `attr-${id}`,
    level: 'L1',
    registerMethod: 'sms',
    registeredChannel: null,
    now: new FixedClock(INSTANT).now(),
  };
}

async function users(db: Kysely<DB>, appId: string) {
  return db.withSchema('app').selectFrom('users').selectAll().where('app_id', '=', appId).execute();
}

it(
  '[AC-B2-02g#1] 新开户在调用方事务内创建唯一 USER_BALANCE 和全零余额，提交后持久化',
  async () => {
    const who = input();
    const inside = await h.db.transaction().execute(async (trx) => {
      expect(await ledgerPort.openUserAccount(trx, who)).toBeUndefined();
      const stored = await expectInitial(trx, who);
      // A separate connection must not see an account before the caller commits.
      expect(await snapshot(h.right, who.appId)).toEqual({
        accounts: [],
        balances: [],
        vouchers: [],
        entries: [],
      });
      return stored;
    });
    expect(await expectInitial(h.db, who)).toEqual(inside);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02g#2] 同一事务重复开户不增加账户或余额，账户 id 和所有字段不变',
  async () => {
    const who = input();
    await h.db.transaction().execute(async (trx) => {
      await ledgerPort.openUserAccount(trx, who);
      const before = await expectInitial(trx, who);
      await ledgerPort.openUserAccount(trx, who);
      expect(await expectInitial(trx, who)).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02g#3] 分两个事务重复开户仍各一行，复用原账户 id 和原始行',
  async () => {
    const who = input();
    await h.db.transaction().execute((trx) => ledgerPort.openUserAccount(trx, who));
    const before = await expectInitial(h.db, who);
    await h.right.transaction().execute((trx) => ledgerPort.openUserAccount(trx, who));
    expect(await expectInitial(h.db, who)).toEqual(before);
  },
  TIMEOUT,
);

it.each([false, true])(
  '[AC-B2-02g#4] 已记账和冻结后重复开户不重置余额、version 或负余额起始日，负余额=%s',
  async (negative) => {
    const { ledger, appId } = context();
    const who = { appId, userId: randomUUID() };
    // Seed through the already merged ledger port, never by updating balance tables.
    const account = await h.db.transaction().execute((trx) => ledger.openUserAccount(trx, who));
    await post(h.db, ledger, [who.userId], voucher(appId, account.account_id, -700n));
    await post(
      h.db,
      ledger,
      [who.userId],
      voucher(appId, account.account_id, 200n, {
        entries: [
          entry(account.account_id, 200n, 'WITHDRAW_FREEZE'),
          { ...entry(account.account_id, -200n, 'WITHDRAW_FREEZE'), sub_account: 'frozen' },
        ],
      }),
    );
    if (negative) {
      const debit = voucher(appId, account.account_id, 800n);
      await post(h.db, ledger, [who.userId], {
        ...debit,
        entries: debit.entries.map((e) => ({ ...e, ledger_type: 'CLAWBACK' })),
      });
    }
    const before = await snapshot(h.db, appId);
    expect(await ledger.getBalances(h.db, { appId, userIds: [who.userId] })).toEqual([
      {
        ...account,
        available_fen: negative ? -300n : 500n,
        frozen_fen: 200n,
        version: negative ? 3n : 2n,
        negative_since: negative ? '2032-06-15' : null,
      },
    ]);
    await h.db.transaction().execute(async (trx) => {
      await ledgerPort.openUserAccount(trx, who);
      await ledgerPort.openUserAccount(trx, who);
    });
    expect(await snapshot(h.db, appId)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02g#5] 同一 userId 在两个品牌各有独立账户，一方记账和重复开户不影响另一方',
  async () => {
    const { ledger } = context();
    const a = input();
    const b = { appId: input().appId, userId: a.userId };
    for (const who of [a, b]) {
      await h.db.transaction().execute((trx) => ledgerPort.openUserAccount(trx, who));
    }
    const first = await expectInitial(h.db, a);
    const second = await expectInitial(h.db, b);
    expect(first.accounts[0]!.id).not.toBe(second.accounts[0]!.id);
    await post(h.db, ledger, [a.userId], voucher(a.appId, first.accounts[0]!.id, -319n));
    const changed = await snapshot(h.db, a.appId);
    for (const who of [b, a]) {
      await h.db.transaction().execute((trx) => ledgerPort.openUserAccount(trx, who));
    }
    expect(await snapshot(h.db, a.appId)).toEqual(changed);
    expect(await expectInitial(h.db, b)).toEqual(second);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02g#6] 两个真正重叠的开户事务均成功，唯一约束竞争后只有一套账户',
  async () => {
    const who = input();
    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const first = h.left.transaction().execute(async (trx) => {
      const pid = await bounded(trx);
      await ledgerPort.openUserAccount(trx, who);
      held.resolve(pid);
      await release.promise;
      return expectInitial(trx, who);
    });
    const firstDone = Promise.allSettled([first]);
    let secondDone: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([
        held.promise,
        first.then(() => {
          throw new Error('missing first opener barrier');
        }),
      ]);
      const started = Promise.withResolvers<number>();
      const second = h.right.transaction().execute(async (trx) => {
        started.resolve(await bounded(trx));
        await ledgerPort.openUserAccount(trx, who);
        return expectInitial(trx, who);
      });
      secondDone = Promise.allSettled([second]);
      const waiter = await Promise.race([
        started.promise,
        second.then(() => {
          throw new Error('missing second opener barrier');
        }),
      ]);
      await waitBlocked(h.db, waiter, pid);
      release.resolve();
      expect(await second).toEqual(await first);
      expect(await expectInitial(h.db, who)).toEqual(await first);
    } finally {
      release.resolve();
      await firstDone;
      await secondDone;
    }
  },
  TIMEOUT,
);

it.each(['appId', 'userId'] as const)(
  '[AC-B2-02g#7] %s 为空串抛 LedgerError INVALID_INPUT，事务仍可读且没有部分写入',
  async (field) => {
    const who = { ...input(), [field]: '' };
    const before = await snapshot(h.db, who.appId);
    await h.db.transaction().execute(async (trx) => {
      const result = ledgerPort.openUserAccount(trx, who);
      await expect(result).rejects.toBeInstanceOf(ledgerPort.LedgerError);
      await expect(result).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await snapshot(trx, who.appId)).toEqual(before);
    });
    expect(await snapshot(h.db, who.appId)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02g#8] insertUser 成功时用原事务和服务端身份调用一次公开开户函数',
  async () => {
    const user = newUser(input().appId);
    const spy = vi.spyOn(ledgerPort, 'openUserAccount');
    const inside = await h.db.transaction().execute(async (trx) => {
      expect(await insertUser(trx, user)).toBe('inserted');
      expect(spy).toHaveBeenCalledExactlyOnceWith(trx, { appId: user.appId, userId: user.id });
      expect(await users(trx, user.appId)).toHaveLength(1);
      const stored = await expectInitial(trx, { appId: user.appId, userId: user.id });
      expect(await users(h.right, user.appId)).toEqual([]);
      expect((await snapshot(h.right, user.appId)).accounts).toEqual([]);
      expect((await snapshot(h.right, user.appId)).balances).toEqual([]);
      return stored;
    });
    expect(await users(h.db, user.appId)).toEqual([
      expect.objectContaining({ id: user.id, app_id: user.appId, phone_hmac: user.phoneHmac }),
    ]);
    expect(await snapshot(h.db, user.appId)).toEqual(inside);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02g#9] 注册后调用方回滚，users、ledger_accounts 和 account_balances 一起消失',
  async () => {
    const user = newUser(input().appId);
    const rollback = new Error('intentional caller rollback');
    await expect(
      h.db.transaction().execute(async (trx) => {
        expect(await insertUser(trx, user)).toBe('inserted');
        expect(await users(trx, user.appId)).toHaveLength(1);
        await expectInitial(trx, { appId: user.appId, userId: user.id });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await users(h.db, user.appId)).toEqual([]);
    expect(await snapshot(h.db, user.appId)).toEqual({
      accounts: [],
      balances: [],
      vouchers: [],
      entries: [],
    });
  },
  TIMEOUT,
);

it.each([
  ['phoneHmac', 'phone_taken'],
  ['inviteCode', 'invite_code_taken'],
  ['attrCode', 'attr_code_taken'],
] as const)(
  '[AC-B2-02g#10] 注册 %s 冲突返回 %s，不为失败的新 id 开户，原事务可以继续',
  async (field, outcome) => {
    const user = newUser(input().appId);
    await h.db.transaction().execute((trx) => insertUser(trx, user));
    const before = await expectInitial(h.db, { appId: user.appId, userId: user.id });
    const conflicting = { ...newUser(user.appId), [field]: user[field] };
    const spy = vi.spyOn(ledgerPort, 'openUserAccount');
    await h.db.transaction().execute(async (trx) => {
      expect(await insertUser(trx, conflicting)).toBe(outcome);
      expect(spy).not.toHaveBeenCalled();
      expect(await snapshot(trx, user.appId)).toEqual(before);
      expect((await users(trx, user.appId)).map((row) => row.id)).toEqual([user.id]);
      // A subsequent valid insert proves rollback-to-savepoint left the transaction usable.
      const next = newUser(user.appId);
      expect(await insertUser(trx, next)).toBe('inserted');
      expect(spy).toHaveBeenCalledExactlyOnceWith(trx, { appId: next.appId, userId: next.id });
    });
    const stored = await snapshot(h.db, user.appId);
    expect(stored.accounts).toHaveLength(2);
    expect(stored.balances).toHaveLength(2);
    expect(stored.accounts.map((row) => row.owner_id)).not.toContain(conflicting.id);
    expect((await users(h.db, user.appId)).map((row) => row.id)).not.toContain(conflicting.id);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02g#11] 开户写入后失败原样上抛，不能按 users 唯一冲突吞错，注册整体回滚',
  async () => {
    const user = newUser(input().appId);
    const failure = Object.assign(new Error('injected account opening failure'), {
      code: '23505',
      constraint: 'users_phone_hmac_key',
    });
    const realOpen = ledgerPort.openUserAccount;
    const spy = vi.spyOn(ledgerPort, 'openUserAccount').mockImplementationOnce(async (trx, who) => {
      await realOpen(trx, who);
      await expectInitial(trx, who);
      throw failure;
    });
    await expect(h.db.transaction().execute((trx) => insertUser(trx, user))).rejects.toBe(failure);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await users(h.db, user.appId)).toEqual([]);
    expect(await snapshot(h.db, user.appId)).toEqual({
      accounts: [],
      balances: [],
      vouchers: [],
      entries: [],
    });
  },
  TIMEOUT,
);
