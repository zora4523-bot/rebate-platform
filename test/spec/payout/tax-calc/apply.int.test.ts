// B2-08c (规划/08 BR-WDR-20: tax_fen 在申请时计算，并与 tax_rule_version 一起固化; BR-WDR-07 锁序;
// task §9.2 2, §9.3 int / 估算): the withdrawal application (B2-05d's createWithdrawApply over the
// real ledger, identity's users lock and idempotency, apply/kit.ts) with createFeeTaxCalculator.
//   - the row stores tax_fen / net_fen / tax_rule_version of the quote recomputed under the locks
//     (users row → balances → payee), not the first pass's: cumulative depends on the in-flight
//     set, which a concurrent application of the same member may change before the locks;
//   - two applications of the same member never miss each other (the second sees the first);
//   - GET /v1/withdrawals/rules' est_tax_fen (createWithdrawRules.getRules) is the tax the
//     application then stores;
//   - without any tax.* row the application stores tax 0, net = amount and the default's version.
// Synthetic table (kit.ts TABLE): due(300 000) = 50 000, due(600 000) = 120 000. Every test builds
// the calculator before anything is seeded: red is the skeleton's NotImplemented.
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { taxRuleVersion } from '../../../../apps/api/src/modules/payout/application/fee-tax-calculator.ts';
import { createWithdrawApply } from '../../../../apps/api/src/modules/payout/application/withdraw-apply.ts';
import {
  createWithdrawRules,
  type FeeTaxCalculator,
} from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import {
  answer,
  close,
  fixture,
  invariant,
  open,
  rows,
  success,
  type Fixture,
  type Harness,
} from '../apply/kit.ts';
import { randomHmac, seedRealname } from '../tax-ytd/kit.ts';
import { TIMEOUT, calculatorOf, seedYtd } from './db-kit.ts';
import { TABLE, TABLE_JSON, TAX_KEYS, recordingLogger } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const CUMULATIVE = { method: 'cumulative', rate_bp: 0n, rate_table: TABLE } as const;

/**
 * The apply fixture (balance ¥10 000) with `calculator` as its fee / tax port and a verified real
 * name (the hmac returned) in app.realname for identity's identity-key port.
 */
async function member(calculator: FeeTaxCalculator): Promise<{ f: Fixture; hmac: string }> {
  const f = await fixture(h, { balance: 1_000_000n });
  f.options.rules.feeTax = calculator;
  const hmac = randomHmac();
  await seedRealname(h.db, f.actor.appId, f.actor.userId, { status: 'verified', hmac });
  return { f, hmac };
}

async function cumulative(f: Fixture): Promise<void> {
  await f.set(TAX_KEYS.method, 'cumulative');
  await f.set(TAX_KEYS.rateTable, TABLE_JSON);
}

async function rowOf(f: Fixture, id: string) {
  const row = (await rows(f)).find((r) => r.id === id);
  if (row === undefined) throw new Error(`no withdrawal ${id}`);
  return row;
}

it(
  '[AC-B2-08c#apply] 无任何 tax.* 配置：入库 tax_fen 0、net = 金额，tax_rule_version = 缺省配置 (none, 0, []) 的版本；冻结 = 金额',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const { f } = await member(calculator);

    const data = success(await h.db.transaction().execute((trx) => f.apply(trx, 10_000n)));
    expect(data.tax_fen).toBe(0);
    expect(data.net_fen).toBe(10_000);
    const row = await rowOf(f, data.withdrawal_id);
    expect(row).toMatchObject({ amount_fen: 10_000n, fee_fen: 0n, tax_fen: 0n, net_fen: 10_000n });
    expect(row.tax_rule_version).toBe(
      taxRuleVersion({ method: 'none', rate_bp: 0n, rate_table: [] }),
    );
    await invariant(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#apply] 08 例 flat_rate 2000bp：申请 ¥100 → 入库与响应 tax 2000、net 8000，tax_rule_version 固化 (flat_rate, 2000, [])；冻结仍是全额 10000',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const { f } = await member(calculator);
    await f.set(TAX_KEYS.method, 'flat_rate');
    await f.set(TAX_KEYS.rateBp, 2000);

    const data = success(await h.db.transaction().execute((trx) => f.apply(trx, 10_000n)));
    expect(data).toMatchObject({ amount_fen: 10_000, fee_fen: 0, tax_fen: 2_000, net_fen: 8_000 });
    const row = await rowOf(f, data.withdrawal_id);
    expect(row).toMatchObject({
      amount_fen: 10_000n,
      fee_fen: 0n,
      tax_fen: 2_000n,
      net_fen: 8_000n,
    });
    expect(row.tax_rule_version).toBe(
      taxRuleVersion({ method: 'flat_rate', rate_bp: 2000n, rate_table: [] }),
    );
    await invariant(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#apply] cumulative 逐笔申请：本年已到账 200000 / 已扣 30000；第一单 100000 → 20000，第二单 300000 看到第一单在途 → 70000',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const { f, hmac } = await member(calculator);
    await cumulative(f);
    await seedYtd(h.db, {
      appId: f.actor.appId,
      userId: f.actor.userId,
      year: 2026,
      identityHmac: hmac,
      income: 200_000n,
      withheld: 30_000n,
    });

    // due(300 000) = 50 000 − 30 000.
    const first = success(await h.db.transaction().execute((trx) => f.apply(trx, 100_000n)));
    expect(first.tax_fen).toBe(20_000);
    // due(600 000) = 120 000 − 30 000 − 20 000 in flight.
    const second = success(await h.db.transaction().execute((trx) => f.apply(trx, 300_000n)));
    expect(second.tax_fen).toBe(70_000);
    expect(second.net_fen).toBe(230_000);
    for (const [data, tax, net] of [
      [first, 20_000n, 80_000n],
      [second, 70_000n, 230_000n],
    ] as const) {
      const row = await rowOf(f, data.withdrawal_id);
      expect(row).toMatchObject({ tax_fen: tax, net_fen: net, income_type: 'SERVICE_FEE' });
      expect(row.tax_rule_version).toBe(taxRuleVersion(CUMULATIVE));
    }
    await invariant(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#locked] 锁前报价之后、加锁之前另一单已提交：入库的是锁下重算的税（看到那一单在途），不是锁前的旧报价',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const { f } = await member(calculator);
    await cumulative(f);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const firstQuotes: bigint[] = [];
    let calls = 0;
    const held: FeeTaxCalculator = {
      async calculate(handle, input) {
        const value = await calculator.calculate(handle, input);
        calls += 1;
        if (calls === 1) {
          firstQuotes.push(value.tax_fen);
          entered.resolve();
          await release.promise;
        }
        return value;
      },
    };
    const late = createWithdrawApply({ ...f.options, rules: { ...f.options.rules, feeTax: held } });
    const early = createWithdrawApply(f.options);
    const command = { ...f.actor, amountFen: 300_000n, stepUpValid: true };
    const pending = h.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      return late.apply(trx, command);
    });
    const settled = Promise.allSettled([pending]);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('missing first-pass quote barrier');
        }),
      ]);
      // Another application of the member commits while `late` holds its first-pass quote.
      const committed = success(
        await h.observer.transaction().execute(async (trx) => {
          await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
          return early.apply(trx, command);
        }),
      );
      expect(committed.tax_fen).toBe(50_000);
      release.resolve();
      const stored = success(await pending);
      // First pass saw nothing in flight (due(300 000)); under the locks the committed one counts.
      expect(firstQuotes).toEqual([50_000n]);
      expect(stored.tax_fen).toBe(70_000);
      expect(stored.net_fen).toBe(230_000);
      const row = await rowOf(f, stored.withdrawal_id);
      expect(row).toMatchObject({ tax_fen: 70_000n, net_fen: 230_000n });
      expect(row.tax_rule_version).toBe(taxRuleVersion(CUMULATIVE));
      await invariant(f);
    } finally {
      release.resolve();
      await settled;
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#concurrent] 同一会员两个并发申请（不同幂等键）：都成功，第二单看到第一单在途，两单税额 = {50000, 70000}、合计 = 应扣(600000)',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const { f } = await member(calculator);
    await cumulative(f);

    const responses = await Promise.all([
      f.request(randomUUID(), 300_000n),
      f.request(randomUUID(), 300_000n),
    ]);
    expect(responses.map((r) => answer(r).code)).toEqual([0, 0]);
    const stored = await rows(f);
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.tax_fen).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
      50_000n,
      70_000n,
    ]);
    for (const row of stored) {
      expect(row.net_fen).toBe(300_000n - row.tax_fen);
      expect(row.tax_rule_version).toBe(taxRuleVersion(CUMULATIVE));
    }
    await invariant(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08c#estimate] 估算 est_tax_fen / est_net_fen（GET /v1/withdrawals/rules）与随后申请入库的税额一致（同一 calculator、同一在途集合）',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const { f, hmac } = await member(calculator);
    await cumulative(f);
    await seedYtd(h.db, {
      appId: f.actor.appId,
      userId: f.actor.userId,
      year: 2026,
      identityHmac: hmac,
      income: 200_000n,
      withheld: 30_000n,
    });
    success(await h.db.transaction().execute((trx) => f.apply(trx, 100_000n)));

    const rules = createWithdrawRules(f.options.rules);
    const estimate = await rules.getRules(h.db, f.actor, 300_000n);
    expect(estimate.can_withdraw).toBe(true);
    // due(600 000) = 120 000 − 30 000 − 20 000 in flight.
    expect(estimate.est_fee_fen).toBe(0);
    expect(estimate.est_tax_fen).toBe(70_000);
    expect(estimate.est_net_fen).toBe(230_000);
    const applied = success(await h.db.transaction().execute((trx) => f.apply(trx, 300_000n)));
    expect(applied.tax_fen).toBe(estimate.est_tax_fen);
    expect(applied.net_fen).toBe(estimate.est_net_fen);
  },
  TIMEOUT,
);
