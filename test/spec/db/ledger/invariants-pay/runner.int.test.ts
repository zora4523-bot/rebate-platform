// B2-15j: the four collection invariants run in the ledger's daily check (BR-PAY-07 细则「不变量」;
// 规划/11 §4.2: every invariant reports its checked rows, 0 rows is its own empty-check warning).
// The runner is ledger's createDailyCheck with its default source (every db/invariants/ledger/*.sql
// not superseded); nothing is injected. Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { createDb, destroyDb } from '@couli/db';
import { expect, it } from 'vitest';
import {
  createDailyCheck,
  type DailyCheckLogger,
} from '../../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  DAY,
  TIMEOUT,
  anomalyReceipt,
  payAnomaly,
  payOrder,
  payRefund,
  post,
  receipt,
  refundVoucher,
  userAccount,
} from './kit.ts';

const CODES = ['pay-01', 'pay-02', 'pay-03', 'pay-04'] as const;

function runner() {
  const logs: Record<string, unknown>[] = [];
  const logger: DailyCheckLogger = {
    warn(fields) {
      logs.push(fields);
    },
    error(fields) {
      logs.push(fields);
    },
  };
  return {
    logs,
    check: createDailyCheck({ clock: new FixedClock('2032-06-15T17:00:00.000Z'), logger }),
  };
}

it(
  '[AC-B2-15j#57] 日终运行器默认加载 pay-01 ～ pay-04 四个文件（文件名 pay-0N_*.sql、invariant 编号即 pay-0N）：收款数据干净时四条都有检查行数且不报差异；没有收款数据时四条各记一次空检告警',
  async () => {
    const database = await createTestDatabase();
    const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    try {
      const { check, logs } = runner();
      const empty = await check.runDailyCheck(db, { accountingDate: DAY });
      for (const code of CODES) {
        const found = empty.checks.filter((c) => c.invariant === code);
        expect(found, code).toHaveLength(1);
        expect(found[0]!.file).toMatch(new RegExp(`^${code}_[^/]+\\.sql$`));
        expect(found[0]!.checkedRows).toBe(0n);
        expect(empty.emptyChecks).toContain(code);
        expect(logs).toContainEqual(
          expect.objectContaining({
            event: 'ledger_daily_check_empty',
            invariant: code,
            checked_rows: '0',
          }),
        );
      }

      const order = await payOrder(db);
      await receipt(db, order);
      await refundVoucher(db, order, await payRefund(db, order, { amount: 1_000n }));
      const anomaly = await payAnomaly(db, { amount: 990n });
      await anomalyReceipt(db, anomaly);
      const result = await check.runDailyCheck(db, { accountingDate: DAY });
      const counts = Object.fromEntries(
        result.checks
          .filter((c) => c.invariant.startsWith('pay-'))
          .map((c) => [c.invariant, c.checkedRows]),
      );
      expect(counts).toEqual({ 'pay-01': 3n, 'pay-02': 1n, 'pay-03': 1n, 'pay-04': 1n });
      const pay = [...result.accountDifferences, ...result.globalDifferences].filter((d) =>
        d.invariant.startsWith('pay-'),
      );
      expect(pay).toEqual([]);
      expect(result.emptyChecks.filter((code) => code.startsWith('pay-'))).toEqual([]);
    } finally {
      await destroyDb(db);
      await database.drop();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#58] 日终运行器报出收款不变量的差异：PAID 单缺收款凭证 → pay-02 全局差异；收款凭证落到用户账户 → pay-01 账户级差异（该用户账户）；按 appId 过滤时只报本 app',
  async () => {
    const database = await createTestDatabase();
    const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    try {
      const { check } = runner();
      const missing = await payOrder(db);
      const order = await payOrder(db, { channel: 'alipay' });
      const user = await userAccount(db, APP);
      await post(db, {
        app: APP,
        bizType: 'pay_order',
        bizId: order.id,
        uniqKey: `PAY_RECEIPT:${order.id}`,
        kind: 'PAY_RECEIPT',
        ledgerType: 'PAY_RECEIPT',
        subType: order.pay_channel,
        lines: [
          { to: `CASH_PAY:${order.pay_channel}`, amount: order.amount_fen },
          { to: user, amount: -order.amount_fen },
        ],
      });
      const result = await check.runDailyCheck(db, { accountingDate: DAY });
      expect(result.globalDifferences).toContainEqual(
        expect.objectContaining({
          invariant: 'pay-02',
          scope: 'global',
          app_id: APP,
          account_id: null,
          detail: expect.objectContaining({ pay_order_id: missing.id }),
        }),
      );
      expect(result.accountDifferences).toContainEqual(
        expect.objectContaining({
          invariant: 'pay-01',
          scope: 'account',
          app_id: APP,
          account_id: user.id,
        }),
      );
      const other = await check.runDailyCheck(db, { accountingDate: DAY, appId: 'pay-elsewhere' });
      expect(
        [...other.accountDifferences, ...other.globalDifferences].filter((d) =>
          d.invariant.startsWith('pay-'),
        ),
      ).toEqual([]);
    } finally {
      await destroyDb(db);
      await database.drop();
    }
  },
  TIMEOUT,
);
