// B2-08b W5 (规划/08 BR-WDR-20; state machine W5 CHANNEL_SUCCESS → PAID_API; task §9.2 3, §9.3): the
// worker's landing job (B2-06fz, jobs/landing-job.ts) with identity's realname-identity-key port
// adds the paid withdrawal to tax_ytd on the landing's own transaction —
//   one row per (member, +08:00 year of created_at, SERVICE_FEE, verified real name's hmac):
//   cum_income_fen += amount_fen, cum_withheld_fen += tax_fen (¥100 with 2000 fen tax → 10000 /
//   2000; ¥100 then ¥200 → 30000, AC-S2-44 ③); a withdrawal created at 12-31 23:30 +08:00 and paid
//   in January counts for the year it was created in;
//   W6 (definite failure) and W3 (rejection) add nothing; a redelivered or second landing job of a
//   paid withdrawal moves no row and adds nothing;
//   a corrected real name (another hmac) starts a row of its own, the former row stays as it was;
//   no verified real name (a state the fixtures force) → the landing rolls back entirely (still
//   PAYING, no voucher, no event), the handler rejects and warns tax_ytd_identity_missing;
//   the invariant: per (member, year) Σ cum_income_fen = Σ amount_fen of the PAID_* withdrawals
//   created in that year, Σ cum_withheld_fen = Σ their tax_fen.
// Logs never carry the hmac (nor the payee). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { createRealnameIdentityKeyReader } from '../../../../apps/api/src/modules/identity/ports/realname-identity-key.ts';
import { createWithdrawalCommands } from '../../../../apps/api/src/modules/payout/application/withdrawal-commands.ts';
import { createPayoutAttemptsStore } from '../../../../apps/api/src/modules/payout/infra/payout-attempts-store.ts';
import {
  CHANNEL_PAID_AT,
  changesOf,
  close,
  expectNoPayeeInLogs,
  landJobOf,
  open,
  seedResult,
  seedSuccess,
  seedTransferFail,
  setup,
  snapshot,
  successResponse,
  withdrawal,
  withdrawalVouchers,
  type Harness,
  type ProcessFixture,
  type Seeded,
} from '../landing/kit.ts';
import {
  IDENTITY_MISSING,
  TIMEOUT,
  correctRealname,
  expected,
  invariantMismatches,
  logText,
  randomHmac,
  seedPaying,
  seedRealname,
  taxRows,
  totals,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/**
 * One app with the landing handler wired to identity's port (built first: red is the skeleton's
 * NotImplemented) and a funded member with a verified real name.
 */
async function landingApp() {
  const f = await setup(h);
  const handler = f.landingJob({ identityKey: createRealnameIdentityKeyReader() });
  const owner = await f.newUser(1_000_000n);
  const hmac = randomHmac();
  await seedRealname(h.db, f.appId, owner, { status: 'verified', hmac });
  return { f, handler, owner, hmac };
}

/** A success attempt of `w` and its landing job, run through `handler`; resolves. */
async function landSuccess(
  f: ProcessFixture,
  handler: ReturnType<ProcessFixture['landingJob']>,
  w: Seeded,
  values: { paidAt?: string; at?: Date; kind?: 'transfer' | 'query' } = {},
): Promise<string> {
  const attemptId = await seedSuccess(f, w, values);
  await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
  return attemptId;
}

it('[AC-B2-08b#W5] 到账（¥100，税 2000 分）→ PAID_API 的同一事务里 tax_ytd 恰一行：created_at 的 +08:00 年、SERVICE_FEE、当前实名 hmac，cum_income 10000、cum_withheld 2000；日志不含 hmac 与收款人', async () => {
  const { f, handler, owner, hmac } = await landingApp();
  const w = await seedPaying(f, { userId: owner, net: 8_000n, tax: 2_000n });

  await landSuccess(f, handler, w, { paidAt: CHANNEL_PAID_AT });

  expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAID_API' });
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
    `wd:${w.id}:PAID`,
  ]);
  expect((await taxRows(h.observer, f.appId)).map(totals)).toEqual([
    expected(f.appId, owner, 2026, hmac, 10_000n, 2_000n),
  ]);
  expect(await invariantMismatches(h.observer, f.appId)).toEqual([]);
  expect(logText(f.logger)).not.toContain(hmac);
  expectNoPayeeInLogs(f);
});

it('[AC-B2-08b#W5] 同一会员同一年两笔到账（¥100、¥200，method=none 税 0）→ 累加到同一行：cum_income 30000、cum_withheld 0（AC-S2-44 ③）；第二笔由查询成功落地也一样', async () => {
  const { f, handler, owner, hmac } = await landingApp();
  const first = await seedPaying(f, { userId: owner, net: 10_000n });
  const second = await seedPaying(f, { userId: owner, net: 20_000n, channel: 'bank_card' });

  await landSuccess(f, handler, first);
  const [row] = await taxRows(h.observer, f.appId);
  await landSuccess(f, handler, second, { kind: 'query' });

  const rows = await taxRows(h.observer, f.appId);
  expect(rows.map(totals)).toEqual([expected(f.appId, owner, 2026, hmac, 30_000n, 0n)]);
  expect(rows[0]!.id).toBe(row!.id);
  expect(await invariantMismatches(h.observer, f.appId)).toEqual([]);
});

it('[AC-B2-08b#W5] 年度取提现单 created_at 的 +08:00 年：12-31 23:30 +08:00 建单、次年 1 月到账 → 记建单那一年；01-01 00:30 +08:00 建单（UTC 仍是前一年）→ 记次年', async () => {
  const { f, handler, owner, hmac } = await landingApp();
  const lateDecember = await seedPaying(f, {
    userId: owner,
    net: 4_900n,
    tax: 100n,
    createdAt: new Date('2026-12-31T23:30:00+08:00'),
  });
  const newYear = await seedPaying(f, {
    userId: owner,
    net: 6_700n,
    tax: 300n,
    createdAt: new Date('2027-01-01T00:30:00+08:00'),
  });
  const january = '2027-01-01T09:00:00+08:00';

  await landSuccess(f, handler, lateDecember, { paidAt: january, at: new Date(january) });
  await landSuccess(f, handler, newYear, { paidAt: january, at: new Date(january) });

  expect(await withdrawal(f, lateDecember.id)).toMatchObject({
    status: 'PAID_API',
    paid_at: new Date(january),
  });
  expect((await taxRows(h.observer, f.appId)).map(totals)).toEqual([
    expected(f.appId, owner, 2026, hmac, 5_000n, 100n),
    expected(f.appId, owner, 2027, hmac, 7_000n, 300n),
  ]);
  expect(await invariantMismatches(h.observer, f.appId)).toEqual([]);
});

it('[AC-B2-08b#W5] W6 失败、W3 驳回都不累加（先做二者：台账仍无行）；之后同一会员一笔到账只记这一笔', async () => {
  const { f, handler, owner, hmac } = await landingApp();
  const failed = await seedPaying(f, { userId: owner, net: 5_000n, tax: 500n });
  const rejected = await f.seedWithdrawal({ userId: owner, status: 'APPROVED', net: 3_000n });
  const paid = await seedPaying(f, { userId: owner, net: 900n, tax: 100n });

  const failAttempt = await seedTransferFail(f, failed);
  await expect(handler(landJobOf(failed, failAttempt))).resolves.toBeUndefined();
  expect(await withdrawal(f, failed.id)).toMatchObject({ status: 'FAILED' });
  const commands = createWithdrawalCommands({
    clock: f.clock,
    ledger: f.ledger,
    lockUsersForUpdate,
    attempts: createPayoutAttemptsStore(),
    eventBus: f.options.eventBus,
  });
  const result = await h.db.transaction().execute((trx) =>
    commands.reject(trx, {
      appId: f.appId,
      withdrawalId: rejected.id,
      expectedStatus: 'APPROVED',
      expectedRowVersion: 2,
      reviewerId: randomUUID(),
      reasonCode: 'OTHER',
      note: null,
    }),
  );
  expect(result).toEqual({ kind: 'changed', status: 'REJECTED' });
  expect(await taxRows(h.observer, f.appId)).toEqual([]);

  await landSuccess(f, handler, paid);

  expect((await taxRows(h.observer, f.appId)).map(totals)).toEqual([
    expected(f.appId, owner, 2026, hmac, 1_000n, 100n),
  ]);
  expect(await invariantMismatches(h.observer, f.appId)).toEqual([]);
});

it('[AC-B2-08b#W5] 已到账的单：同一落地任务重投、再来一个查询成功的落地任务 → 都不再迁移，台账只加过一次', async () => {
  const { f, handler, owner, hmac } = await landingApp();
  const w = await seedPaying(f, { userId: owner, net: 1_800n, tax: 200n });

  const attemptId = await landSuccess(f, handler, w);
  const after = await taxRows(h.observer, f.appId);
  await expect(handler(landJobOf(w, attemptId, { attempt: 2 }))).resolves.toBeUndefined();
  const queryAttempt = await seedResult(f, w, {
    kind: 'query',
    result: 'success',
    respCode: '10000',
    respSubCode: null,
    response: successResponse(`CHQ${w.outBizNo}`),
  });
  await expect(handler(landJobOf(w, queryAttempt))).resolves.toBeUndefined();

  expect(await taxRows(h.observer, f.appId)).toEqual(after);
  expect(after.map(totals)).toEqual([expected(f.appId, owner, 2026, hmac, 2_000n, 200n)]);
  expect(await changesOf(f, w.id)).toHaveLength(1);
});

it('[AC-B2-08b#W5] 实名更正后（新 id_no_hmac）到账 → 新身份另起一行；旧身份行原样不动，不再累加', async () => {
  const { f, handler, owner, hmac } = await landingApp();
  const before = await seedPaying(f, { userId: owner, net: 9_000n, tax: 1_000n });
  const afterCorrection = await seedPaying(f, { userId: owner, net: 20_000n });
  const corrected = randomHmac();

  await landSuccess(f, handler, before);
  const [oldRow] = await taxRows(h.observer, f.appId);
  await correctRealname(h.db, f.appId, owner, corrected);
  await landSuccess(f, handler, afterCorrection);

  const rows = await taxRows(h.observer, f.appId);
  expect(rows).toHaveLength(2);
  expect(rows.map(totals)).toEqual(
    expect.arrayContaining([
      expected(f.appId, owner, 2026, hmac, 10_000n, 1_000n),
      expected(f.appId, owner, 2026, corrected, 20_000n, 0n),
    ]),
  );
  expect(rows.find((row) => row.identity_hmac === hmac)).toEqual(oldRow);
  expect(await invariantMismatches(h.observer, f.appId)).toEqual([]);
  expect(logText(f.logger)).not.toContain(hmac);
  expect(logText(f.logger)).not.toContain(corrected);
});

it.each(['absent', 'none', 'failed'] as const)(
  '[AC-B2-08b#W5] 未实名就到账（夹具造出的非法状态，realname %s）→ 落地事务整体回滚：仍 PAYING、无 PAID 凭证、无事件、冻结不变、台账无行；处理器抛错（不吞）并 warn tax_ytd_identity_missing',
  async (state) => {
    const f = await setup(h);
    const handler = f.landingJob({ identityKey: createRealnameIdentityKeyReader() });
    const owner = await f.newUser(1_000_000n);
    if (state !== 'absent') await seedRealname(h.db, f.appId, owner, { status: state });
    const w = await seedPaying(f, { userId: owner, net: 1_000n, tax: 50n });
    const attemptId = await seedSuccess(f, w);
    const before = await snapshot(f);

    await expect(handler(landJobOf(w, attemptId))).rejects.toBeInstanceOf(Error);

    expect(await snapshot(f)).toEqual(before);
    expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAYING', paid_at: null });
    expect(await taxRows(h.observer, f.appId)).toEqual([]);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ withdrawal_id: w.id }),
      IDENTITY_MISSING,
    );
    expectNoPayeeInLogs(f);
  },
);

it('[AC-B2-08b#W5] 不变量：两个会员、跨两个年度、成功与失败混合落地后，每 (会员, 年) Σcum_income = Σ该年建单的 PAID_* amount_fen、Σcum_withheld = Σtax_fen；行数与各行和一致', async () => {
  const f = await setup(h);
  const handler = f.landingJob({ identityKey: createRealnameIdentityKeyReader() });
  const a = await f.newUser(1_000_000n);
  const b = await f.newUser(1_000_000n);
  const hmacA = randomHmac();
  const hmacB = randomHmac();
  await seedRealname(h.db, f.appId, a, { status: 'verified', hmac: hmacA });
  await seedRealname(h.db, f.appId, b, { status: 'verified', hmac: hmacB });
  const created2027 = new Date('2027-01-01T00:00:00+08:00');

  const aPaid = await seedPaying(f, { userId: a, net: 8_000n, tax: 2_000n });
  const aFailed = await seedPaying(f, { userId: a, net: 5_000n });
  const aNextYear = await seedPaying(f, { userId: a, net: 3_000n, createdAt: created2027 });
  const bPaid = await seedPaying(f, { userId: b, net: 20_000n, channel: 'bank_card' });
  const bQuery = await seedPaying(f, { userId: b, net: 900n, tax: 100n });

  await landSuccess(f, handler, aPaid);
  const failAttempt = await seedTransferFail(f, aFailed);
  await expect(handler(landJobOf(aFailed, failAttempt))).resolves.toBeUndefined();
  await landSuccess(f, handler, aNextYear, { paidAt: '2027-01-02T10:00:00+08:00' });
  await landSuccess(f, handler, bPaid);
  await landSuccess(f, handler, bQuery, { kind: 'query' });

  expect(await invariantMismatches(h.observer, f.appId)).toEqual([]);
  const rows = await taxRows(h.observer, f.appId);
  expect(rows).toHaveLength(3);
  expect(rows.map(totals)).toEqual(
    expect.arrayContaining([
      expected(f.appId, a, 2026, hmacA, 10_000n, 2_000n),
      expected(f.appId, a, 2027, hmacA, 3_000n, 0n),
      expected(f.appId, b, 2026, hmacB, 21_000n, 100n),
    ]),
  );
});
