// B1-01zzp: collectAutoPayoutDaily(db, clock) against PostgreSQL. Per app_id, the total is
// BR-WDR-30 ⑨'s 口径: Σ amount_fen of withdrawals with review_mode = auto, status ∉ {REJECTED,
// FAILED}, reviewed_at on the current +08:00 natural day of the injected clock (created_at does not
// matter); the cap is that app_id's withdraw.auto_payout.platform_daily_max_fen. "now" is the
// injected clock, never the database's now(): the fixture's clock is years after the database's
// real time, and NOW is 01:30 +08:00 while still the previous UTC date. It runs on a session whose
// every transaction is READ ONLY, so any write fails in PostgreSQL itself. Finally the worker
// registry renders the same values.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  collectAutoPayoutDaily,
  createMetricsRegistry,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { readOnlyUrl } from '../kit.ts';
import {
  APP_A,
  APP_B,
  APP_C,
  DAY_MS,
  DAY_START,
  NOW,
  autoFromText,
  configSnapshot,
  expectSnapshot,
  insertCap,
  seedAutoPayout,
  shift,
  withdrawalSnapshot,
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

it('[AC-B1-01zzp#10] 当日自动到账合计按 app_id：只计 review_mode=auto、status ∉ {REJECTED, FAILED}、reviewed_at 落在注入时钟的 +08:00 当日（含 00:00 整、按 reviewed_at 不按 created_at、按 amount_fen）；上限取该 app_id 的 platform_daily_max_fen；有上限没合计的 app_id 为 0', async () => {
  const t = await open();
  try {
    const expected = await seedAutoPayout(t.db);
    // The session really is read-only: the collector cannot write behind the test's back.
    await expect(
      insertCap(t.readOnly, 'fund_alerts_ro', 1),
      'fixture session must be read-only',
    ).rejects.toThrow(/read-only/);
    const withdrawalsBefore = await withdrawalSnapshot(t.db);
    const configBefore = await configSnapshot(t.db);

    const snapshot = await collectAutoPayoutDaily(t.readOnly, new FixedClock(NOW));
    expectSnapshot(snapshot, expected.atNow);

    expect(await withdrawalSnapshot(t.db)).toEqual(withdrawalsBefore);
    expect(await configSnapshot(t.db)).toEqual(configBefore);
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzp#11] 「当日」随注入时钟走、按 +08:00 切日：00:00 前 1 毫秒的时钟只计前一日的单；次日的时钟合计归零（上限不变）', async () => {
  const t = await open();
  try {
    const expected = await seedAutoPayout(t.db);
    const clock = new FixedClock(NOW);
    expectSnapshot(await collectAutoPayoutDaily(t.readOnly, clock), expected.atNow);

    // 2031-04-05 23:59:59.999 at +08:00: the previous +08:00 day.
    clock.set(shift(DAY_START, -1));
    expectSnapshot(await collectAutoPayoutDaily(t.readOnly, clock), expected.dayBefore);

    clock.set(shift(NOW, DAY_MS));
    expectSnapshot(await collectAutoPayoutDaily(t.readOnly, clock), expected.dayAfter);

    // Back at NOW: the same values again (nothing was cached across days).
    clock.set(NOW);
    expectSnapshot(await collectAutoPayoutDaily(t.readOnly, clock), expected.atNow);
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzp#12] worker registry 以真实采集渲染：两个 gauge 的值与夹具一致（合计 / 上限 = 0.5、0.8、0）', async () => {
  const t = await open();
  try {
    const expected = await seedAutoPayout(t.db);
    const clock = new FixedClock(NOW);
    const registry = createMetricsRegistry({
      entry: 'worker',
      collectAutoPayout: () => collectAutoPayoutDaily(t.readOnly, clock),
    });
    const rendered = autoFromText(await registry.render());
    expectSnapshot(rendered, expected.atNow);
    expect(rendered.totalFen[APP_A]! / rendered.capFen[APP_A]!).toBe(0.5);
    expect(rendered.totalFen[APP_B]! / rendered.capFen[APP_B]!).toBe(0.8);
    expect(rendered.totalFen[APP_C]! / rendered.capFen[APP_C]!).toBe(0);
  } finally {
    await t.close();
  }
}, 60_000);
