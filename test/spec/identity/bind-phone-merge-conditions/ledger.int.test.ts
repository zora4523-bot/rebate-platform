// B1-20e: merge condition「无余额（余额无任何流水）」 reads the ledger (规划/08 BR-ID-06 并号 OPS-04;
// orchestrator ruling §9.2 item 2): any entry on the current account's USER_BALANCE account of this
// app refuses the merge offer (30411 only); an account row without entries does not. The ledger's
// exported read-only function hasUserBalanceEntries(executor, { appId, userId }) answers it: on the
// caller's executor, no account row → false, no write, no lock.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  closeKit,
  fixture,
  mergeable,
  occupied,
  openKit,
  type Kit,
} from '../bind-phone/http-kit.ts';
import { seedUser } from '../registration/kit.ts';
import {
  again,
  attempt,
  balanceAccount,
  entry,
  ledger,
  ledgerRows,
  otherApp,
  type EntryOptions,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const ENTRIES: readonly (EntryOptions & { label: string })[] = [
  { label: 'REBATE_CREDIT 入账', ledgerType: 'REBATE_CREDIT', amountFen: -100 },
  { label: 'REWARD 奖励', ledgerType: 'REWARD', amountFen: -1 },
  { label: 'ADMIN_ADJUST 调账', ledgerType: 'ADMIN_ADJUST', amountFen: 50 },
  { label: 'CLAWBACK 追回', ledgerType: 'CLAWBACK', amountFen: 100 },
  {
    label: 'WITHDRAW_FREEZE 冻结子账户',
    ledgerType: 'WITHDRAW_FREEZE',
    subAccount: 'frozen',
    amountFen: -100,
  },
  { label: 'SHARE_CREDIT 分享入账', ledgerType: 'SHARE_CREDIT', amountFen: -7 },
];

for (const { label, ...options } of ENTRIES) {
  it(`[AC-B1-20e#4] 第三方空号余额有一条分录（${label}）→ 只返回 30411（无 mergeable、无 ticket）`, async () => {
    const f = await fixture(kit, { method: 'wechat' });
    await f.owner();
    const account = await balanceAccount(f.db, f.appId, f.uid);
    await entry(kit, f.db, f.appId, account, options);
    occupied(kit, await attempt(f));
  });
}

it('[AC-B1-20e#5] 分录相互抵消、余额为 0 仍算有流水 → 只返回 30411', async () => {
  const f = await fixture(kit, { method: 'apple' });
  await f.owner();
  const account = await balanceAccount(f.db, f.appId, f.uid);
  await entry(kit, f.db, f.appId, account, { ledgerType: 'REBATE_CREDIT', amountFen: -300 });
  await entry(kit, f.db, f.appId, account, { ledgerType: 'CLAWBACK', amountFen: 300 });
  occupied(kit, await attempt(f));
});

it('[AC-B1-20e#6] 只有余额账户行、没有任何分录 → 仍可并号；只读函数答 false 且不开户、不记账', async () => {
  const f = await fixture(kit, { method: 'wechat' });
  await f.owner();
  await balanceAccount(f.db, f.appId, f.uid);
  mergeable(kit, await attempt(f));
  const { hasUserBalanceEntries } = await ledger();
  const before = await ledgerRows(kit.suite.db);
  await expect(
    hasUserBalanceEntries(kit.suite.db, { appId: f.appId, userId: f.uid }),
  ).resolves.toBe(false);
  expect(await ledgerRows(kit.suite.db)).toEqual(before);
});

it('[AC-B1-20e#7] 别的 app 下同一 user_id 的余额分录、本 app 目标账号的分录都不影响本 app 当前账号的判定', async () => {
  const f = await fixture(kit, { method: 'huawei' });
  const target = await f.owner();
  const elsewhere = otherApp();
  await entry(kit, f.db, elsewhere, await balanceAccount(f.db, elsewhere, f.uid));
  await entry(kit, f.db, f.appId, await balanceAccount(f.db, f.appId, target));
  mergeable(kit, await attempt(f));
  const { hasUserBalanceEntries } = await ledger();
  await expect(
    hasUserBalanceEntries(kit.suite.db, { appId: f.appId, userId: f.uid }),
  ).resolves.toBe(false);
  await expect(
    hasUserBalanceEntries(kit.suite.db, { appId: elsewhere, userId: f.uid }),
  ).resolves.toBe(true);
  await expect(
    hasUserBalanceEntries(kit.suite.db, { appId: f.appId, userId: target }),
  ).resolves.toBe(true);
});

it('[AC-B1-20e#8] 先可并号；当前账号余额记一条分录后再绑同一号码 → 只返回 30411', async () => {
  const f = await fixture(kit, { method: 'wechat' });
  await f.owner();
  const account = await balanceAccount(f.db, f.appId, f.uid);
  mergeable(kit, await attempt(f));
  await entry(kit, f.db, f.appId, account, { ledgerType: 'REWARD', amountFen: -1 });
  occupied(kit, await again(kit, f));
});

it('[AC-B1-20e#9] 只读函数：没有余额账户行 → false，且不开户', async () => {
  const { hasUserBalanceEntries } = await ledger();
  const appId = otherApp();
  const user = await seedUser(kit.suite.db, appId, { method: 'wechat' });
  const before = await ledgerRows(kit.suite.db);
  await expect(hasUserBalanceEntries(kit.suite.db, { appId, userId: user })).resolves.toBe(false);
  expect(await ledgerRows(kit.suite.db)).toEqual(before);
});

it('[AC-B1-20e#10] 只读函数：平台账户与他人余额账户的分录不算；只认该用户 USER_BALANCE 账户上的分录', async () => {
  const { hasUserBalanceEntries } = await ledger();
  const appId = otherApp();
  const user = await seedUser(kit.suite.db, appId, { method: 'wechat' });
  const other = await seedUser(kit.suite.db, appId, { method: 'sms' });
  await balanceAccount(kit.suite.db, appId, user);
  // The fixture voucher also books the opposite side on a platform account of the app.
  await entry(kit, kit.suite.db, appId, await balanceAccount(kit.suite.db, appId, other));
  await expect(hasUserBalanceEntries(kit.suite.db, { appId, userId: user })).resolves.toBe(false);
  await expect(hasUserBalanceEntries(kit.suite.db, { appId, userId: other })).resolves.toBe(true);
});

it('[AC-B1-20e#11] 只读函数在调用方的执行器上读：事务内未提交的分录可见，事务外不可见', async () => {
  const { hasUserBalanceEntries } = await ledger();
  const appId = otherApp();
  const user = await seedUser(kit.suite.db, appId, { method: 'apple' });
  const account = await balanceAccount(kit.suite.db, appId, user);
  const rollback = new Error('fixture rollback');
  await expect(
    kit.suite.db.transaction().execute(async (trx) => {
      await entry(kit, trx, appId, account);
      await expect(hasUserBalanceEntries(trx, { appId, userId: user })).resolves.toBe(true);
      await expect(hasUserBalanceEntries(kit.suite.db, { appId, userId: user })).resolves.toBe(
        false,
      );
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  await expect(hasUserBalanceEntries(kit.suite.db, { appId, userId: user })).resolves.toBe(false);
});

it('[AC-B1-20e#12] 只读函数不加锁：别的事务锁住账户行与分录时照常返回（lock_timeout 内）', async () => {
  const { hasUserBalanceEntries } = await ledger();
  const appId = otherApp();
  const user = await seedUser(kit.suite.db, appId, { method: 'wechat' });
  const account = await balanceAccount(kit.suite.db, appId, user);
  const voucher = await entry(kit, kit.suite.db, appId, account);
  await sql`INSERT INTO app.account_balances
      (app_id, account_id, available_fen, frozen_fen, negative_since, version)
    VALUES (${appId}, ${account}, 100, 0, null, 1)`.execute(kit.suite.db);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const rollback = new Error('fixture rollback');
  // The holder is a booking in flight, with the business role's own rights (no test role may
  // row-lock ledger_accounts / ledger_vouchers / ledger_entries; FOR UPDATE there is refused):
  // the balance row locked FOR UPDATE as the ledger's write path does (BR-FUND-16 ③), then
  // uncommitted entries on the account and on the existing voucher — their foreign keys lock the
  // account and voucher rows FOR KEY SHARE, and the inserts hold all three tables in ROW
  // EXCLUSIVE mode. Rolled back at the end, so nothing of it stays.
  const holder = kit.suite.db.transaction().execute(async (trx) => {
    await sql`SELECT account_id FROM app.account_balances
      WHERE app_id = ${appId} AND account_id = ${account} FOR UPDATE`.execute(trx);
    await entry(kit, trx, appId, account);
    await sql`INSERT INTO app.ledger_entries
        (app_id, voucher_id, account_id, sub_account, amount_fen, ledger_type, booked_at)
      VALUES (${appId}, ${voucher}, ${account}, 'available', -1, 'REBATE_CREDIT',
        ${kit.clock.now()})`.execute(trx);
    locked();
    await held;
    throw rollback;
  });
  // The holder settles only after release(), so this waits for its locks or its failure.
  await Promise.race([ready, holder]);
  try {
    const answer = await kit.suite.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
      return hasUserBalanceEntries(trx, { appId, userId: user });
    });
    expect(answer).toBe(true);
  } finally {
    release();
    await expect(holder).rejects.toBe(rollback);
  }
});
