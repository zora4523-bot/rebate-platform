// B2-08c (规划/08 BR-WDR-20 累计方法 / 细则「在途」「计税年度」「冲回」; BR-ID-25 实名更正; 编排裁定
// D10-456 ④; task §9.2 1, §9.3 cumulative 算例 / 配置缺省): the calculator over PostgreSQL.
//   cumulative tax = max(0, due(ytd income + in-flight amounts + amount) − ytd withheld − in-flight
//   tax), where ytd = the tax_ytd row of the member's current identity (identity's
//   realname-identity-key port: a corrected real name's former row never counts; no verified real
//   name → 0 / 0 and a warning, never a refusal here), in-flight = the member's PENDING_REVIEW /
//   APPROVED / PAYING withdrawals (income SERVICE_FEE) created in the same +08:00 year as `now`
//   (REJECTED / FAILED / paid ones never; another member's never), all read on the handle given.
// Synthetic table (kit.ts TABLE): due(X) = 10 % below 100 000; 20 % − 10 000 below 500 000;
// 30 % − 60 000 from 500 000 on. Every test builds the calculator before it seeds anything.
// Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { taxRuleVersion } from '../../../../apps/api/src/modules/payout/application/fee-tax-calculator.ts';
import type { FeeTaxCalculator } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import {
  closeDb,
  correctRealname,
  openDb,
  randomHmac,
  seedMember,
  seedRealname,
  type DbHarness,
} from '../tax-ytd/kit.ts';
import {
  TIMEOUT,
  calculatorOf,
  newAppId,
  seedWithdrawal,
  seedYtd,
  setTax,
  type WithdrawalStatus,
} from './db-kit.ts';
import { TABLE, TABLE_JSON, logText, recordingLogger } from './kit.ts';

let h: DbHarness;
beforeAll(async () => {
  h = await openDb(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await closeDb(h);
}, TIMEOUT);

/** 2026-10-19 10:00 +08:00. */
const NOW = new Date('2026-10-19T02:00:00.000Z');
const EARLIER = new Date('2026-10-01T02:00:00.000Z');

/** A member of `app` with a verified real name (its id_no_hmac returned). */
async function verifiedMember(app: string): Promise<{ userId: string; hmac: string }> {
  const userId = await seedMember(h.db, app);
  const hmac = randomHmac();
  await seedRealname(h.db, app, userId, { status: 'verified', hmac });
  return { userId, hmac };
}

/** The member's tax_ytd row of `year` (default 2026) for `hmac`. */
function ytd(
  app: string,
  userId: string,
  hmac: string,
  income: bigint,
  withheld: bigint,
  year = 2026,
): Promise<void> {
  return seedYtd(h.db, { appId: app, userId, year, identityHmac: hmac, income, withheld });
}

/** A withdrawal of the member in `status` (default created 2026-10-01 10:00 +08:00). */
function withdrawal(
  app: string,
  userId: string,
  status: WithdrawalStatus,
  amount: bigint,
  tax: bigint,
  createdAt: Date = EARLIER,
  db: Kysely<DB> = h.db,
): Promise<string> {
  return seedWithdrawal(db, { appId: app, userId, status, amount, tax, createdAt });
}

function quote(
  calculator: FeeTaxCalculator,
  app: string,
  userId: string,
  amountFen: bigint,
  now: Date = NOW,
  handle: Kysely<DB> = h.db,
) {
  return calculator.calculate(handle, {
    appId: app,
    userId,
    deviceId: '0190a8a0-0000-7000-8000-000000000002',
    amountFen,
    now,
  });
}

it(
  '[AC-B2-08c#cumulative] 累计算例：本年已到账 10000 / 已扣 2000（当前身份行），在途一单 5000 / 税 1000，本次 20000 → 应扣(35000)=3500 − 3000 = 500',
  async () => {
    const logger = recordingLogger();
    const calculator = calculatorOf(logger);
    const app = newAppId();
    const { userId, hmac } = await verifiedMember(app);
    await setTax(h.db, app, { method: 'cumulative', rate_table: TABLE_JSON });
    await ytd(app, userId, hmac, 10_000n, 2_000n);
    await withdrawal(app, userId, 'PENDING_REVIEW', 5_000n, 1_000n);

    const result = await quote(calculator, app, userId, 20_000n);
    expect(result.fee_fen).toBe(0n);
    expect(result.tax_fen).toBe(500n);
    expect(result.net_fen).toBe(19_500n);
    expect(result.tax_rule_version).toBe(
      taxRuleVersion({ method: 'cumulative', rate_bp: 0n, rate_table: TABLE }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#in-flight] 在途 = 本人、同年度、PENDING_REVIEW / APPROVED / PAYING；驳回、失败、已到账（只经 tax_ytd 计入）与别的会员的单都不计',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const app = newAppId();
    const { userId } = await verifiedMember(app);
    const other = await verifiedMember(app);
    await setTax(h.db, app, { method: 'cumulative', rate_table: TABLE_JSON });
    await withdrawal(app, userId, 'PENDING_REVIEW', 100_000n, 10_000n);
    await withdrawal(app, userId, 'APPROVED', 150_000n, 20_000n);
    await withdrawal(app, userId, 'PAYING', 50_000n, 5_000n);
    await withdrawal(app, userId, 'REJECTED', 400_000n, 0n);
    await withdrawal(app, userId, 'FAILED', 300_000n, 0n);
    await withdrawal(app, userId, 'PAID_API', 200_000n, 40_000n);
    await withdrawal(app, other.userId, 'PENDING_REVIEW', 500_000n, 90_000n);

    // X = 300 000 in flight + 100 000 → due 70 000 − in-flight tax 35 000.
    const result = await quote(calculator, app, userId, 100_000n);
    expect(result.tax_fen).toBe(35_000n);
    expect(result.net_fen).toBe(65_000n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#reversal] 在途单把本次推进高档；该单失败后，下一次提现自动冲回（税 0），再下一次按累计补扣',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const app = newAppId();
    const { userId, hmac } = await verifiedMember(app);
    await setTax(h.db, app, { method: 'cumulative', rate_table: TABLE_JSON });
    await ytd(app, userId, hmac, 200_000n, 50_000n);
    const w1 = await withdrawal(app, userId, 'PAYING', 400_000n, 70_000n);

    // W1 still in flight: due(610 000) = 123 000 − 50 000 − 70 000.
    expect((await quote(calculator, app, userId, 10_000n)).tax_fen).toBe(3_000n);

    await sql`UPDATE app.withdrawals SET status = 'FAILED' WHERE id = ${w1}`.execute(h.db);
    // W1 failed: due(210 000) = 32 000 < 50 000 already withheld → 0.
    const back = await quote(calculator, app, userId, 10_000n);
    expect(back.tax_fen).toBe(0n);
    expect(back.net_fen).toBe(10_000n);
    // due(310 000) = 52 000 − 50 000.
    expect((await quote(calculator, app, userId, 110_000n)).tax_fen).toBe(2_000n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#year] 年度按 +08:00：次年 01-01 00:10（UTC 仍是前一年）只计次年的台账与在途；前一年 12-31 23:50 只计前一年',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const app = newAppId();
    const { userId, hmac } = await verifiedMember(app);
    await setTax(h.db, app, { method: 'cumulative', rate_table: TABLE_JSON });
    await ytd(app, userId, hmac, 1_000_000n, 240_000n, 2026);
    await ytd(app, userId, hmac, 30_000n, 3_000n, 2027);
    const lateIn2026 = new Date('2026-12-31T23:30:00+08:00');
    const earlyIn2027 = new Date('2027-01-01T00:05:00+08:00');
    await withdrawal(app, userId, 'PENDING_REVIEW', 400_000n, 70_000n, lateIn2026);
    await withdrawal(app, userId, 'PENDING_REVIEW', 50_000n, 5_000n, earlyIn2027);

    const newYear = new Date('2027-01-01T00:10:00+08:00');
    expect(newYear.getUTCFullYear()).toBe(2026);
    // 2027: X = 30 000 + 50 000 + 20 000 = 100 000 → due 10 000 − 3 000 − 5 000.
    expect((await quote(calculator, app, userId, 20_000n, newYear)).tax_fen).toBe(2_000n);
    // 2026: X = 1 000 000 + 400 000 + 20 000 → due 366 000 − 240 000 − 70 000.
    const lastDay = new Date('2026-12-31T23:50:00+08:00');
    expect((await quote(calculator, app, userId, 20_000n, lastDay)).tax_fen).toBe(56_000n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#identity] 实名更正后按新身份行累计：旧身份行的累计不计；日志不带任何 hmac',
  async () => {
    const logger = recordingLogger();
    const calculator = calculatorOf(logger);
    const app = newAppId();
    const { userId, hmac: oldHmac } = await verifiedMember(app);
    await setTax(h.db, app, { method: 'cumulative', rate_table: TABLE_JSON });
    await ytd(app, userId, oldHmac, 1_000_000n, 240_000n);
    const newHmac = randomHmac();
    await correctRealname(h.db, app, userId, newHmac);
    await ytd(app, userId, newHmac, 50_000n, 5_000n);

    // X = 50 000 + 50 000 = 100 000 → due 10 000 − 5 000.
    const result = await quote(calculator, app, userId, 50_000n);
    expect(result.tax_fen).toBe(5_000n);
    expect(logText(logger)).not.toContain(oldHmac);
    expect(logText(logger)).not.toContain(newHmac);
  },
  TIMEOUT,
);

it.each(['no-row', 'none-retained', 'failed'] as const)(
  '[AC-B2-08c#unverified] 未实名（%s）→ 累计按 0 / 0、在途照算，不拒绝，告警且日志不带 hmac',
  async (state) => {
    const logger = recordingLogger();
    const calculator = calculatorOf(logger);
    const app = newAppId();
    const userId = await seedMember(h.db, app);
    const retained = randomHmac();
    if (state === 'none-retained') {
      await seedRealname(h.db, app, userId, { status: 'none', retainedHmac: retained });
    } else if (state === 'failed') {
      await seedRealname(h.db, app, userId, { status: 'failed' });
    }
    await setTax(h.db, app, { method: 'cumulative', rate_table: TABLE_JSON });
    await ytd(app, userId, retained, 1_000_000n, 240_000n);
    await withdrawal(app, userId, 'PENDING_REVIEW', 100_000n, 10_000n);

    // X = 100 000 in flight + 100 000 → due 30 000 − 10 000.
    const result = await quote(calculator, app, userId, 100_000n);
    expect(result.tax_fen).toBe(20_000n);
    expect(result.net_fen).toBe(80_000n);
    expect(logger.warn).toHaveBeenCalled();
    expect(logText(logger)).not.toContain(retained);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#none] method=none（FUND-04 税率表到位前）：本年已有大额累计与在途，税仍为 0、到账 = 金额',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const app = newAppId();
    const { userId, hmac } = await verifiedMember(app);
    await setTax(h.db, app, { method: 'none', rate_bp: 0, rate_table: TABLE_JSON });
    await ytd(app, userId, hmac, 1_000_000n, 0n);
    await withdrawal(app, userId, 'PENDING_REVIEW', 400_000n, 0n);

    const result = await quote(calculator, app, userId, 100_000n);
    expect(result.tax_fen).toBe(0n);
    expect(result.net_fen).toBe(100_000n);
    expect(result.tax_rule_version).toBe(
      taxRuleVersion({ method: 'none', rate_bp: 0n, rate_table: TABLE }),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#default] 无种子（三键都没有）→ 等同 none：有累计与在途也不扣税，版本 = 缺省配置的版本，不告警',
  async () => {
    const logger = recordingLogger();
    const calculator = calculatorOf(logger);
    const app = newAppId();
    const { userId, hmac } = await verifiedMember(app);
    await ytd(app, userId, hmac, 1_000_000n, 0n);
    await withdrawal(app, userId, 'PENDING_REVIEW', 400_000n, 0n);

    const result = await quote(calculator, app, userId, 100_000n);
    expect(result.fee_fen).toBe(0n);
    expect(result.tax_fen).toBe(0n);
    expect(result.net_fen).toBe(100_000n);
    expect(result.tax_rule_version).toBe(
      taxRuleVersion({ method: 'none', rate_bp: 0n, rate_table: [] }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#table] cumulative + 空档位 [] → 税 0（合法配置，不告警），版本 = (cumulative, 0, []) 的版本',
  async () => {
    const logger = recordingLogger();
    const calculator = calculatorOf(logger);
    const app = newAppId();
    const { userId } = await verifiedMember(app);
    await setTax(h.db, app, { method: 'cumulative', rate_table: [] });
    await withdrawal(app, userId, 'PENDING_REVIEW', 300_000n, 0n);

    const result = await quote(calculator, app, userId, 100_000n);
    expect(result.tax_fen).toBe(0n);
    expect(result.net_fen).toBe(100_000n);
    expect(result.tax_rule_version).toBe(
      taxRuleVersion({ method: 'cumulative', rate_bp: 0n, rate_table: [] }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

const INVALID_TABLES: ReadonlyArray<readonly [string, unknown]> = [
  ['对象而非数组', {}],
  ['字符串', 'TABLE'],
  ['首档起点不是 0', [{ from_fen: 100, rate_bp: 1000, quick_deduction_fen: 0 }]],
  ['起点不升序', [TABLE_JSON[0], TABLE_JSON[2], TABLE_JSON[1]]],
  ['税率超过 10000bp', [{ from_fen: 0, rate_bp: 10001, quick_deduction_fen: 0 }]],
  ['速算扣除为负', [{ from_fen: 0, rate_bp: 1000, quick_deduction_fen: -1 }]],
  ['税率带小数', [{ from_fen: 0, rate_bp: 1000.5, quick_deduction_fen: 0 }]],
  ['缺字段', [{ from_fen: 0, rate_bp: 1000 }]],
  ['档位为 null', [TABLE_JSON[0], null]],
];

it.each(INVALID_TABLES)(
  '[AC-B2-08c#table] rate_table 非法（%s）→ 按缺省空档位：税 0，告警而不抛，版本 = (cumulative, 0, []) 的版本',
  async (_label, table) => {
    const logger = recordingLogger();
    const calculator = calculatorOf(logger);
    const app = newAppId();
    const { userId } = await verifiedMember(app);
    await setTax(h.db, app, { method: 'cumulative', rate_table: table });
    await withdrawal(app, userId, 'PENDING_REVIEW', 300_000n, 0n);

    // With any valid table this would be due(400 000) > 0.
    const result = await quote(calculator, app, userId, 100_000n);
    expect(result.tax_fen).toBe(0n);
    expect(result.net_fen).toBe(100_000n);
    expect(result.tax_rule_version).toBe(
      taxRuleVersion({ method: 'cumulative', rate_bp: 0n, rate_table: [] }),
    );
    expect(logger.warn).toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#handle] 在调用方给的事务上读：同一事务里尚未提交的在途单当场计入，另一连接看不到',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const app = newAppId();
    const { userId } = await verifiedMember(app);
    await setTax(h.db, app, { method: 'cumulative', rate_table: TABLE_JSON });

    const rollback = new Error('rollback on purpose');
    const seen: { inside?: bigint; outside?: bigint } = {};
    await expect(
      h.db.transaction().execute(async (trx) => {
        await withdrawal(app, userId, 'PENDING_REVIEW', 400_000n, 70_000n, EARLIER, trx);
        // due(600 000) = 120 000 − 70 000.
        seen.inside = (await quote(calculator, app, userId, 200_000n, NOW, trx)).tax_fen;
        // due(200 000) = 30 000.
        seen.outside = (await quote(calculator, app, userId, 200_000n, NOW, h.observer)).tax_fen;
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(seen).toEqual({ inside: 50_000n, outside: 30_000n });
  },
  TIMEOUT,
);
