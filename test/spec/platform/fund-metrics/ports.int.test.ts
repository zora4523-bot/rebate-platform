// B1-01zzi brief B.1 / B.4: the three read-only fund ports against PostgreSQL, across every app_id.
// - orders: order_sync_pending rows in status open, per reason (no key without an open row);
// - settlement: settle_jobs job bill in status failed; settle_batches in status PARTIAL; beneficiary
//   keys (app_id, order_id, user_id, role) whose latest event (max event_seq) is held and whose
//   first held event was created at or before now − 30 days (BR-CALC-13 FUND-17);
// - payout: withdrawals in status PAYING with needs_manual set (BR-WDR-14 result unknown).
// "now" is the injected clock, never the database's now(): the fixture's clock is years after the
// database's real time. Every port runs on a session whose transactions are all READ ONLY, so any
// write fails in PostgreSQL itself. Finally the worker registry renders the same values.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { readOrderSyncPendingOpen } from '../../../../apps/api/src/modules/orders/application/metrics-read.ts';
import { readPayoutFundMetrics } from '../../../../apps/api/src/modules/payout/application/metrics-read.ts';
import { readSettlementFundMetrics } from '../../../../apps/api/src/modules/settlement/application/metrics-read.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createMetricsRegistry,
  type FundMetricsSnapshot,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { expectProcessMetrics } from '../metrics/kit.ts';
import {
  DAY,
  FUND_METRIC_NAMES,
  NOW,
  OTHER_APP,
  fundFromText,
  fundNamesIn,
  insertBeneficiaryEvents,
  insertOrderKey,
  insertPending,
  readOnlyUrl,
  seedBatches,
  seedBeneficiaries,
  seedFund,
  seedPending,
  seedSettleJobs,
  seedWithdrawals,
} from './kit.ts';

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  return {
    db,
    readOnly,
    async close() {
      await destroyDb(readOnly);
      await destroyDb(db);
      await database.drop();
    },
  };
}

it('[AC-B1-01zzi#8] orders 端口：open 的待处理记录按 reason 计数（跨 app_id），resolved / dismissed 不计，没有 open 记录的 reason 不出键', async () => {
  const t = await open();
  try {
    const expected = await seedPending(t.db);
    // The session really is read-only: the port cannot write behind the test's back.
    await expect(
      insertPending(t.readOnly, {
        appId: 'couli',
        reason: 'UNFREEZE_SIGNAL',
        status: 'open',
        subOrderId: 'ro',
      }),
      'fixture session must be read-only',
    ).rejects.toThrow(/read-only/);
    const result = await readOrderSyncPendingOpen(t.readOnly);
    expect({ ...result }).toEqual(expected);
    expect(Object.hasOwn(result, 'NO_RECEIVED_AT')).toBe(false);
    expect(Object.hasOwn(result, 'AMOUNT_PARSE_FAILED')).toBe(false);
    for (const value of Object.values(result)) expect(Number.isInteger(value)).toBe(true);

    // Opening one more row is seen by the next read (no cached value).
    await insertPending(t.db, {
      appId: OTHER_APP,
      reason: 'NO_RECEIVED_AT',
      status: 'open',
      subOrderId: 's9',
    });
    expect({ ...(await readOrderSyncPendingOpen(t.readOnly)) }).toEqual({
      ...expected,
      NO_RECEIVED_AT: 1,
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzi#9] settlement 端口：只计 job=bill 且 failed 的账单任务、status=PARTIAL 的批次（跨 app_id 与平台），与注入时钟无关', async () => {
  const t = await open();
  try {
    const billJobsFailed = await seedSettleJobs(t.db);
    const partialBatches = await seedBatches(t.db);
    const clock = new FixedClock(NOW);
    const result = await readSettlementFundMetrics(t.readOnly, clock);
    expect(result).toEqual({ billJobsFailed, partialBatches, beneficiariesHeldOver30Days: 0 });
    clock.advanceMs(40 * DAY * 1000);
    expect(await readSettlementFundMetrics(t.readOnly, clock)).toEqual({
      billJobsFailed,
      partialBatches,
      beneficiariesHeldOver30Days: 0,
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzi#10] settlement 端口：受益人份额按 (app_id, order_id, user_id, role) 取最新事件为 held、且首次 held 满 30×24 小时（含边界）才计；29 天、差 1 秒、已转 active / forfeited 不计；按注入时钟推进', async () => {
  const t = await open();
  try {
    const held = await seedBeneficiaries(t.db);
    const clock = new FixedClock(NOW);
    const atNow = await readSettlementFundMetrics(t.readOnly, clock);
    expect(atNow.beneficiariesHeldOver30Days).toBe(held.atNow);
    expect(atNow.billJobsFailed).toBe(0);
    expect(atNow.partialBatches).toBe(0);

    // One day later on the injected clock only: the 30-days-minus-one-second key and the 29-day
    // key (now exactly 30 × 24 h) join.
    clock.advanceMs(DAY * 1000);
    const later = await readSettlementFundMetrics(t.readOnly, clock);
    expect(later.beneficiariesHeldOver30Days).toBe(held.oneDayLater);

    // One second before NOW: the exactly-30-days key is one second short.
    clock.set(new Date(Date.parse(NOW) - 1000));
    const before = await readSettlementFundMetrics(t.readOnly, clock);
    expect(before.beneficiariesHeldOver30Days).toBe(held.atNow - 1);

    // A new key held just now does not count; releasing a counted key (latest event active)
    // removes it at once.
    clock.set(NOW);
    const orderId = await insertOrderKey(t.db, 'couli');
    const userId = '00000000-0000-4000-8000-0000000000aa';
    const fresh = { appId: 'couli', orderId, userId, role: 'self' as const };
    await insertBeneficiaryEvents(t.db, fresh, [['held', -DAY]]);
    expect((await readSettlementFundMetrics(t.readOnly, clock)).beneficiariesHeldOver30Days).toBe(
      held.atNow,
    );
    const released = { ...fresh, role: 'share' as const };
    await insertBeneficiaryEvents(t.db, released, [['held', -31 * DAY]]);
    expect((await readSettlementFundMetrics(t.readOnly, clock)).beneficiariesHeldOver30Days).toBe(
      held.atNow + 1,
    );
    await insertBeneficiaryEvents(t.db, released, [['active', 0]]);
    expect((await readSettlementFundMetrics(t.readOnly, clock)).beneficiariesHeldOver30Days).toBe(
      held.atNow,
    );
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzi#11] payout 端口：只计 PAYING 且 needs_manual 的提现单（跨 app_id）；needs_manual 但已到终态或驳回、PAYING 但未转人工都不计', async () => {
  const t = await open();
  try {
    const expected = await seedWithdrawals(t.db);
    expect(await readPayoutFundMetrics(t.readOnly)).toEqual({ payingNeedsManual: expected });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzi#12] 空库：pending 为空对象，其余计数为 0', async () => {
  const t = await open();
  try {
    const clock = new FixedClock(NOW);
    expect({ ...(await readOrderSyncPendingOpen(t.readOnly)) }).toEqual({});
    expect(await readSettlementFundMetrics(t.readOnly, clock)).toEqual({
      billJobsFailed: 0,
      partialBatches: 0,
      beneficiariesHeldOver30Days: 0,
    });
    expect(await readPayoutFundMetrics(t.readOnly)).toEqual({ payingNeedsManual: 0 });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzi#13] worker registry 以三个端口为 collectFund 渲染：五个资金指标的文本数值与夹具一致，下一次 scrape 跟随注入时钟', async () => {
  const t = await open();
  try {
    const expected = await seedFund(t.db);
    const clock = new FixedClock(NOW);
    const collectFund = async (): Promise<FundMetricsSnapshot> => ({
      orderSyncPendingOpen: await readOrderSyncPendingOpen(t.readOnly),
      ...(await readSettlementFundMetrics(t.readOnly, clock)),
      ...(await readPayoutFundMetrics(t.readOnly)),
    });
    const registry = createMetricsRegistry({ entry: 'worker', collectFund });
    const text = await registry.render();
    expectProcessMetrics(text);
    expect(fundNamesIn(text)).toEqual(FUND_METRIC_NAMES);
    expect(fundFromText(text)).toEqual(expected.atNow);
    expect(text).toMatch(/^couli_order_sync_pending_open\{reason="UNMAPPED_STATUS"\} 3$/m);
    expect(text).toMatch(/^couli_settle_bill_jobs_failed 4$/m);
    expect(text).toMatch(/^couli_settle_batches_partial 3$/m);
    expect(text).toMatch(/^couli_beneficiary_held_over_30d 6$/m);
    expect(text).toMatch(/^couli_withdrawals_paying_needs_manual 3$/m);

    clock.advanceMs(DAY * 1000);
    expect(fundFromText(await registry.render())).toEqual(expected.oneDayLater);
  } finally {
    await t.close();
  }
}, 60_000);
