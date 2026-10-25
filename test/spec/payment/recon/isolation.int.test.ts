// B2-15j isolation rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（收款的钱不进用户
// 余额：支付模块不得产生任何 USER_BALANCE 分录；收款差错单不得套用提现差错（R2）的做法，不冻结用户提现，
// 不做用户余额调账），BR-PAY-01 ③；payment/AGENTS.md 硬规则 1、9（只读写本模块的表，按 app 隔离）。
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { fixture, suite } from '../orders/kit.ts';
import { anomalies, tradeNo, vouchers } from '../result/kit.ts';
import {
  BILL_DATE,
  NOW,
  SUCCESS,
  closedOrder,
  diffs,
  lineOf,
  paidOrder,
  pendingOrder,
  recon,
  reconOf,
  snapshot,
  tradeLine,
  userTraces,
  withdrawHolds,
  type Recon,
} from './kit.ts';

const s = suite();

/** The payer's own USER_BALANCE account with a balance, as the rebate side would have it. */
async function payerBalance(r: Recon) {
  const id = randomUUID();
  await sql`INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
    VALUES (${id}::uuid, ${r.f.subject.app_id}, 'user', ${r.f.subject.user_id}, 'USER_BALANCE')`.execute(
    r.f.db,
  );
  await sql`INSERT INTO app.account_balances (app_id, account_id, available_fen, frozen_fen, version)
    VALUES (${r.f.subject.app_id}, ${id}::uuid, 5000, 0, 1)`.execute(r.f.db);
  return id;
}

async function balanceRows(r: Recon, accountId: string) {
  const result = await sql<{ available_fen: string; frozen_fen: string; version: string }>`
    SELECT available_fen::text, frozen_fen::text, version::text FROM app.account_balances
    WHERE app_id = ${r.f.subject.app_id} AND account_id = ${accountId}::uuid`.execute(r.f.db);
  return result.rows;
}

it('[AC-B2-15j#20] 对账写的凭证（PAY_ANOMALY、PAY_FEE）只记平台科目、不含 USER_BALANCE；付款用户的余额、用户分录不变，不建提现冻结；差错单全是 R4 收款差错，不是 R2', async () => {
  const r = await recon(s);
  const account = await payerBalance(r);
  const balances = await balanceRows(r, account);
  const traces = await userTraces(r.f);
  const pending = await pendingOrder(r, 'wechat_pay');
  const closed = await closedOrder(r, 'wechat_pay');
  await paidOrder(r, 'wechat_pay');
  r.channels.wechat_pay.setBill(BILL_DATE, [
    lineOf(pending, { feeFen: 20n }),
    lineOf(closed, { feeFen: 30n }),
  ]);
  await r.run('wechat_pay');
  const rows = await diffs(r);
  expect(rows.map((row) => row.type).sort()).toEqual([
    'pay_anomaly',
    'pay_mismatch',
    'pay_mismatch',
  ]);
  expect(rows.every((row) => row.source === 'R4')).toBe(true);
  expect(await anomalies(r.f)).toHaveLength(1);
  const kinds = (await vouchers(r.f)).map((v) => v.voucher_kind).sort();
  expect(kinds).toEqual(['PAY_ANOMALY', 'PAY_FEE', 'PAY_RECEIPT']);
  for (const v of await vouchers(r.f)) {
    for (const entry of v.entries) {
      expect(entry.owner_type, v.uniq_key).toBe('platform');
      expect(entry.subject, v.uniq_key).not.toBe('USER_BALANCE');
    }
  }
  expect(await userTraces(r.f)).toEqual(traces);
  expect(await balanceRows(r, account)).toEqual(balances);
  expect(await withdrawHolds(r.f)).toBe(0);
}, 60_000);

it('[AC-B2-15j#21] 按 app 隔离：本 app 账单里出现另一 app 的商户单号 → 在本 app 登记为找不到支付单的异常收款；另一 app 的支付单、凭证与差错单不动，另一 app 当天 PAID 的单也不因本 app 的账单报差错', async () => {
  const r = await recon(s);
  const other = await reconOf(await fixture(s, NOW));
  const theirs = await paidOrder(other, 'alipay');
  const mine = await paidOrder(r, 'alipay');
  const trade = tradeNo('alipay');
  r.channels.alipay.setBill(BILL_DATE, [
    lineOf(mine),
    tradeLine({
      outTradeNo: theirs.out_trade_no,
      channelTradeNo: trade,
      amountFen: theirs.amount_fen,
      state: SUCCESS.alipay,
    }),
  ]);
  const otherBefore = await snapshot(other);
  await r.run('alipay');
  const found = await anomalies(r.f);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    app_id: r.f.subject.app_id,
    out_trade_no: theirs.out_trade_no,
    pay_order_id: null,
    channel_trade_no: trade,
  });
  expect((await diffs(r)).map((row) => row.type)).toEqual(['pay_anomaly']);
  expect(await snapshot(other)).toEqual(otherBefore);
  expect(await diffs(other)).toEqual([]);
}, 60_000);
