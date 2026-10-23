// B2-05k ⑦ (connected): the real AppModule of every booking entry hands payout's recovery port to
// ledger — the LEDGER provider (BALANCE_RECOVERED_HOOK token) and the worker's account.went_negative
// consumer. Real PG; the assembly runs no query and the queue is in memory.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LEDGER, type Ledger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  ENTRY_NOW,
  TIMEOUT,
  accountOf,
  assembled,
  balanceOf,
  block,
  changeAvailable,
  close,
  creditVoucher,
  locked,
  open,
  seedStatus,
  setup,
  wentNegativeJob,
  withdrawal,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each(['api', 'admin', 'worker', 'payout'] as const)(
  '[AC-B2-05k#7] %s 入口装配的 LEDGER 带 payout 回正挂点：回正入账提交后阻断即清，updated_at 取入口 Clock',
  async (entry) => {
    const f = await setup(h, 100n);
    const id = await f.startWithdrawal();
    await seedStatus(f, id, 'APPROVED');
    await changeAvailable(f, -1n);
    await block(f, id);
    const before = await withdrawal(f, id);
    const accountId = await accountOf(f);
    const clock = new FixedClock(ENTRY_NOW);
    const app = await assembled(entry, h.db, clock);
    try {
      const ledger = app.get(LEDGER) as Ledger;
      const posted = await locked(h.db, ledger, f.actor.appId, [f.actor.userId], (trx) =>
        ledger.post(trx, creditVoucher(f.actor.appId, accountId, 1n)),
      );
      expect(posted.kind).toBe('posted');
    } finally {
      await app.close();
    }
    expect((await balanceOf(f)).available_fen).toBe(0n);
    expect(await withdrawal(f, id)).toEqual({
      ...before,
      blocked_reason: null,
      updated_at: clock.now(),
      row_version: before.row_version + 1,
    });
  },
);

it('[AC-B2-05k#7] worker 的 account.went_negative 消费者：系统驳回的 WITHDRAW_RETURN 使余额回正，同一事务清空该会员 PAYING 单的阻断', async () => {
  const f = await setup(h, 200n);
  const rejected = await f.startWithdrawal();
  const paying = await f.startWithdrawal();
  await seedStatus(f, paying, 'PAYING');
  await changeAvailable(f, -50n);
  await block(f, paying);
  const before = await withdrawal(f, paying);
  const clock = new FixedClock(ENTRY_NOW);
  const app = await assembled('worker', h.db, clock);
  try {
    const registration = app.registrations.find((item) => item.name === 'evt.payout-went-negative');
    expect(registration).toBeDefined();
    // Still −50 under the lock: the open withdrawal is system-rejected and its 100 returns.
    await registration!.handler(
      wentNegativeJob(randomUUID(), f.actor.appId, f.actor.userId, clock.now()),
    );
  } finally {
    await app.close();
  }
  expect(await withdrawal(f, rejected)).toMatchObject({
    status: 'REJECTED',
    reject_reason_code: 'NEGATIVE_BALANCE',
  });
  expect(await balanceOf(f)).toMatchObject({
    available_fen: 50n,
    frozen_fen: 100n,
    negative_since: null,
  });
  // The PAYING withdrawal is not the consumer's; its block is cleared by the return voucher's
  // recovery, in the consumer's transaction.
  expect(await withdrawal(f, paying)).toEqual({
    ...before,
    blocked_reason: null,
    updated_at: clock.now(),
    row_version: before.row_version + 1,
  });
});
