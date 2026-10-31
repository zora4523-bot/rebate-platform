// B2-08c (规划/08 BR-WDR-20 细则「在途 = … 状态 ∈ {PENDING_REVIEW, APPROVED, PAYING}」; tax_ytd 只在
// PAID_API / PAID_MANUAL 时累加; task §9.2 1, §9.5 ①): a paid withdrawal — PAID_API or PAID_MANUAL —
// counts only through the tax_ytd row it already added to, never a second time as in flight. An
// implementation that selects in-flight rows by exclusion (status NOT IN REJECTED / FAILED /
// PAID_API) counts PAID_MANUAL twice and fails here.
// Synthetic table (kit.ts TABLE): due(X) = 10 % below 100 000; 20 % − 10 000 below 500 000;
// 30 % − 60 000 from 500 000 on. Every test builds the calculator before it seeds anything: red is
// the skeleton's NotImplemented. db-kit.ts is frozen, so the PAID_MANUAL row is seeded here.
// Top-level it() only (规划/11 §4.3).
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FeeTaxCalculator } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import {
  closeDb,
  openDb,
  randomHmac,
  seedMember,
  seedRealname,
  type DbHarness,
} from '../tax-ytd/kit.ts';
import {
  SERVICE_FEE,
  TIMEOUT,
  calculatorOf,
  newAppId,
  seedWithdrawal,
  seedYtd,
  setTax,
  type WithdrawalStatus,
} from './db-kit.ts';
import { TABLE_JSON, recordingLogger } from './kit.ts';

let h: DbHarness;
beforeAll(async () => {
  h = await openDb(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await closeDb(h);
}, TIMEOUT);

/** 2026-10-19 10:00 +08:00. */
const NOW = new Date('2026-10-19T02:00:00.000Z');
/** 2026-10-01 10:00 +08:00. */
const EARLIER = new Date('2026-10-01T02:00:00.000Z');

/** A member of `app` with a verified real name (its id_no_hmac returned). */
async function verifiedMember(app: string): Promise<{ userId: string; hmac: string }> {
  const userId = await seedMember(h.db, app);
  const hmac = randomHmac();
  await seedRealname(h.db, app, userId, { status: 'verified', hmac });
  return { userId, hmac };
}

function withdrawal(
  app: string,
  userId: string,
  status: WithdrawalStatus,
  amount: bigint,
  tax: bigint,
): Promise<string> {
  return seedWithdrawal(h.db, { appId: app, userId, status, amount, tax, createdAt: EARLIER });
}

/**
 * A PAID_MANUAL withdrawal of the member (BR-WDR-14 人工到账: paid_at, two distinct operators for
 * entry and confirmation, manual_resolution 'paid'; fee 0, net = amount − tax, alipay, synthetic
 * payee), created and paid at EARLIER.
 */
async function paidManual(app: string, userId: string, amount: bigint, tax: bigint) {
  const id = randomUUID();
  await sql`INSERT INTO app.withdrawals
    (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
     payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel,
     manual_resolution, manual_entry_by, manual_confirm_by, paid_at, created_at, updated_at)
    VALUES (${id}, ${app}, ${userId}, ${amount}, 0, ${tax}, ${amount - tax}, ${SERVICE_FEE},
      'alipay', '合成姓名', ${Buffer.from('synthetic-encrypted-account')},
      ${randomBytes(32).toString('hex')}, 'PAID_MANUAL', ${randomBytes(16).toString('hex')},
      'alipay', 'paid', ${randomUUID()}, ${randomUUID()}, ${EARLIER}, ${EARLIER},
      ${EARLIER})`.execute(h.db);
  return id;
}

function quote(calculator: FeeTaxCalculator, app: string, userId: string, amountFen: bigint) {
  return calculator.calculate(h.db, {
    appId: app,
    userId,
    deviceId: '0190a8a0-0000-7000-8000-000000000002',
    amountFen,
    now: NOW,
  });
}

it(
  '[AC-B2-08c#in-flight] 在途只含 PENDING_REVIEW / APPROVED / PAYING：PAID_API 与 PAID_MANUAL 只经 tax_ytd 计入一次（不再算在途），驳回、失败与别的会员的单都不计',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const app = newAppId();
    const { userId, hmac } = await verifiedMember(app);
    const other = await verifiedMember(app);
    await setTax(h.db, app, { method: 'cumulative', rate_table: TABLE_JSON });
    // Paid ones as B2-08b left them: PAID_API 200 000 / 40 000 + PAID_MANUAL 150 000 / 30 000.
    await withdrawal(app, userId, 'PAID_API', 200_000n, 40_000n);
    await paidManual(app, userId, 150_000n, 30_000n);
    await seedYtd(h.db, {
      appId: app,
      userId,
      year: 2026,
      identityHmac: hmac,
      income: 350_000n,
      withheld: 70_000n,
    });
    // In flight: 300 000 / 35 000.
    await withdrawal(app, userId, 'PENDING_REVIEW', 100_000n, 10_000n);
    await withdrawal(app, userId, 'APPROVED', 150_000n, 20_000n);
    await withdrawal(app, userId, 'PAYING', 50_000n, 5_000n);
    // Never counted.
    await withdrawal(app, userId, 'REJECTED', 400_000n, 0n);
    await withdrawal(app, userId, 'FAILED', 300_000n, 0n);
    await withdrawal(app, other.userId, 'PENDING_REVIEW', 500_000n, 90_000n);

    // X = 350 000 + 300 000 + 100 000 = 750 000 → due 165 000 − 70 000 − 35 000 = 60 000.
    // (Counting PAID_MANUAL as in flight too: due(900 000) = 210 000 − 70 000 − 65 000 = 75 000.)
    const result = await quote(calculator, app, userId, 100_000n);
    expect(result.tax_fen).toBe(60_000n);
    expect(result.net_fen).toBe(40_000n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#in-flight] 只有一条 PAID_MANUAL（已计入 tax_ytd）与一条 PAYING：本次只按台账 + PAYING 累计',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const app = newAppId();
    const { userId, hmac } = await verifiedMember(app);
    await setTax(h.db, app, { method: 'cumulative', rate_table: TABLE_JSON });
    await paidManual(app, userId, 400_000n, 70_000n);
    await seedYtd(h.db, {
      appId: app,
      userId,
      year: 2026,
      identityHmac: hmac,
      income: 400_000n,
      withheld: 70_000n,
    });
    await withdrawal(app, userId, 'PAYING', 50_000n, 15_000n);

    // X = 400 000 + 50 000 + 50 000 = 500 000 → due 90 000 − 70 000 − 15 000 = 5 000.
    // (Counting PAID_MANUAL as in flight too: due(900 000) = 210 000 − 70 000 − 85 000 = 55 000.)
    const result = await quote(calculator, app, userId, 50_000n);
    expect(result.tax_fen).toBe(5_000n);
    expect(result.net_fen).toBe(45_000n);
  },
  TIMEOUT,
);
