// B2-08c (规划/08 BR-WDR-20 累计方法：同年度在途同类申请额 / 税额; BR-WDR-07 锁序; task §9.2 2「锁下
// （users 行锁之后、入库之前）重算一次报价并以锁下结果入库」, §9.5 ②): the second (stored) quote is
// computed while the users row lock is held, so a concurrent application of the same member can
// neither slip in between that quote and the insert nor be missed by it.
//   `late` stops inside its second calculate call; `early` then starts on the observer. With the
//   recompute under the lock, `early` waits on the users row until `late` commits, then sees it in
//   flight: taxes {50 000, 70 000}. A recompute made before the lock holds nothing: `early` runs
//   through and commits 50 000, then `late` stores its stale 50 000 — two equal taxes.
// `late` is released once `early` has either finished or is waiting on a lock in this database
// (pg_stat_activity), whichever comes first; nothing else runs in the test database meanwhile.
// Synthetic table (kit.ts TABLE): due(300 000) = 50 000, due(600 000) = 120 000. Every test builds
// the calculator before anything is seeded: red is the skeleton's NotImplemented.
// Top-level it() only (规划/11 §4.3).
import { setTimeout as sleep } from 'node:timers/promises';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { taxRuleVersion } from '../../../../apps/api/src/modules/payout/application/fee-tax-calculator.ts';
import {
  createWithdrawApply,
  type WithdrawApplyResult,
} from '../../../../apps/api/src/modules/payout/application/withdraw-apply.ts';
import type { FeeTaxCalculator } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import {
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
import { TIMEOUT, calculatorOf } from './db-kit.ts';
import { TABLE, TABLE_JSON, TAX_KEYS, recordingLogger } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const CUMULATIVE = { method: 'cumulative', rate_bp: 0n, rate_table: TABLE } as const;
/** Polls of pg_stat_activity, 10 ms apart, before giving up (well under lock_timeout). */
const POLLS = 300;

/**
 * The apply fixture (balance ¥10 000) with `calculator` as its fee / tax port, a verified real
 * name in app.realname for identity's identity-key port and tax.SERVICE_FEE cumulative over TABLE.
 */
async function member(calculator: FeeTaxCalculator): Promise<Fixture> {
  const f = await fixture(h, { balance: 1_000_000n });
  f.options.rules.feeTax = calculator;
  await seedRealname(h.db, f.actor.appId, f.actor.userId, {
    status: 'verified',
    hmac: randomHmac(),
  });
  await f.set(TAX_KEYS.method, 'cumulative');
  await f.set(TAX_KEYS.rateTable, TABLE_JSON);
  return f;
}

/** Sessions of the test database waiting on a heavyweight lock (row locks included). */
async function lockWaiters(): Promise<number> {
  const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(h.db);
  return result.rows[0]?.n ?? 0;
}

/** 'done' once `done()` holds, 'blocked' once a session of the database waits on a lock. */
async function doneOrBlocked(done: () => boolean): Promise<'done' | 'blocked'> {
  for (let poll = 0; poll < POLLS; poll += 1) {
    if (done()) return 'done';
    if ((await lockWaiters()) > 0) return 'blocked';
    await sleep(10);
  }
  throw new Error('the second application neither finished nor waited on a lock');
}

it(
  '[AC-B2-08c#locked] 锁下重算持有 users 行锁：late 停在第二次（锁下）报价里时，同会员的 early 等 users 行锁；放行后两单税额 = {50000, 70000}（锁前重算会存两次 50000）',
  async () => {
    const calculator = calculatorOf(recordingLogger());
    const f = await member(calculator);
    const enteredSecond = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const held: FeeTaxCalculator = {
      async calculate(handle, input) {
        const value = await calculator.calculate(handle, input);
        calls += 1;
        if (calls === 2) {
          enteredSecond.resolve();
          await release.promise;
        }
        return value;
      },
    };
    const late = createWithdrawApply({ ...f.options, rules: { ...f.options.rules, feeTax: held } });
    const early = createWithdrawApply(f.options);
    const command = { ...f.actor, amountFen: 300_000n, stepUpValid: true };
    const lateRun = h.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      return late.apply(trx, command);
    });
    let earlyRun: Promise<WithdrawApplyResult> | null = null;
    try {
      await Promise.race([
        enteredSecond.promise,
        lateRun.then(() => {
          throw new Error('missing the second (under-lock) quote');
        }),
      ]);
      let earlyFinished = false;
      earlyRun = h.observer.transaction().execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
        return early.apply(trx, command);
      });
      earlyRun.then(
        () => {
          earlyFinished = true;
        },
        () => {
          earlyFinished = true;
        },
      );
      const seen = await doneOrBlocked(() => earlyFinished);
      release.resolve();
      const [lateResult, earlyResult] = await Promise.all([lateRun, earlyRun]);

      const taxes = [success(lateResult).tax_fen, success(earlyResult).tax_fen].sort(
        (a, b) => a - b,
      );
      expect(taxes).toEqual([50_000, 70_000]);
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
      // `early` had to wait: `late` held the users row while it quoted the second time.
      expect(seen).toBe('blocked');
      await invariant(f);
    } finally {
      release.resolve();
      await Promise.allSettled([lateRun, earlyRun ?? Promise.resolve(null)]);
    }
  },
  TIMEOUT,
);
