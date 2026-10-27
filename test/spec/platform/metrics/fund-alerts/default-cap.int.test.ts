// B1-01zzp D10-393 (c) 告警与执行同口径, against PostgreSQL: the cap gauge of an app_id is the cap
// B2-11c's decision executes with — its withdraw.auto_payout.platform_daily_max_fen when valid, its
// 08 default when the row is absent or malformed — taken from the injected payout function, never
// from a default platform keeps. Every expected cap is computed by B2-11c's autoPayoutConfigOf
// (default-cap-kit.ts). The 80 % rule of couli-fund.yaml then fires on that default cap as
// BR-WDR-24 says (total ≥ 80 % of the cap). The session is READ ONLY, as in collect.int.test.ts.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  collectAutoPayoutDaily,
  createMetricsRegistry,
  type AutoPayoutDailySnapshot,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { insertUser } from '../../fund-metrics/kit.ts';
import { readOnlyUrl } from '../kit.ts';
import {
  MALFORMED_CAPS,
  VALID_CAPS,
  capFenOfValue,
  capRuleShares,
  defaultCapFen,
  fires,
  insertCapValue,
  nearCapLineFen,
  payoutCapFenOf,
  reachesNearCap,
  shiftedDefaultCap,
  withPayoutDefaultCap,
} from './default-cap-kit.ts';
import { HOUR_MS, NOW, autoFromText, expectSnapshot, insertWithdrawal, shift } from './kit.ts';

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

/** One auto payout of `amountFen` reviewed an hour before NOW (today at +08:00). */
async function autoPaidToday(db: Kysely<DB>, appId: string, amountFen: number): Promise<void> {
  const userId = await insertUser(db, appId);
  await insertWithdrawal(db, {
    appId,
    userId,
    status: 'PAID_API',
    reviewMode: 'auto',
    reviewedAt: shift(NOW, -HOUR_MS),
    createdAt: shift(NOW, -2 * HOUR_MS),
    amountFen,
    feeFen: 100,
  });
}

const UNSET = 'fund_alerts_unset';
/** Unconfigured too: today's total exactly on, and 1 fen below, the 80 % line of the default. */
const NEAR = 'fund_alerts_near';
const BELOW = 'fund_alerts_below';
const malformedApp = (i: number) => `fund_alerts_bad_${i}`;
const validApp = (i: number) => `fund_alerts_set_${i}`;
/** Today's total of UNSET: no cap row at all. */
const UNSET_TOTAL = 12_345;

/** The expected snapshot with every cap computed by B2-11c's function as it is now. */
function expectedCaps(): AutoPayoutDailySnapshot {
  const totalFen: Record<string, number> = { [UNSET]: UNSET_TOTAL };
  const capFen: Record<string, number> = { [UNSET]: defaultCapFen() };
  MALFORMED_CAPS.forEach((value, i) => {
    totalFen[malformedApp(i)] = 0;
    capFen[malformedApp(i)] = capFenOfValue(value);
  });
  VALID_CAPS.forEach((value, i) => {
    totalFen[validApp(i)] = 0;
    capFen[validApp(i)] = capFenOfValue(value);
  });
  return { totalFen, capFen };
}

it('[AC-B1-01zzp#14] 上限未配置的 app_id（当日有自动到账合计、没有 platform_daily_max_fen 行）仍出上限序列，值等于 B2-11c 执行所用的默认上限；值不合法（负数、非整数、字符串、null、布尔、超出安全整数、对象）同样回落到该默认，合法值（含 0）照用；B2-11c 默认值一变，未配置与不合法的上限随之变（取自注入的 payout 函数，不是 platform 另写的默认）', async () => {
  const t = await open();
  try {
    await autoPaidToday(t.db, UNSET, UNSET_TOTAL);
    for (const [i, value] of MALFORMED_CAPS.entries()) {
      await insertCapValue(t.db, malformedApp(i), value);
    }
    for (const [i, value] of VALID_CAPS.entries()) {
      await insertCapValue(t.db, validApp(i), value);
    }
    // Same 口径 as the decision: every malformed value falls back exactly as an absent row does,
    // and the valid ones are taken as they are (B2-11c's function, read here once as a check).
    for (const value of MALFORMED_CAPS) {
      expect(capFenOfValue(value), JSON.stringify(value)).toBe(defaultCapFen());
    }
    for (const value of VALID_CAPS) expect(capFenOfValue(value)).toBe(value);
    const clock = new FixedClock(NOW);

    const snapshot = await collectAutoPayoutDaily(t.readOnly, clock, payoutCapFenOf);
    expect(Object.hasOwn(snapshot.capFen, UNSET), `${UNSET} has a cap series`).toBe(true);
    expectSnapshot(snapshot, expectedCaps());

    // B2-11c's default moves: the unset and malformed caps follow it, the valid ones stay.
    const shifted = shiftedDefaultCap();
    const moved = await withPayoutDefaultCap(shifted, async () => {
      const again = await collectAutoPayoutDaily(t.readOnly, clock, payoutCapFenOf);
      expectSnapshot(again, expectedCaps());
      return again;
    });
    expect(moved.capFen[UNSET], 'unset follows the payout default').toBe(Number(shifted));
    expect(moved.capFen[malformedApp(0)], 'malformed follows the payout default').toBe(
      Number(shifted),
    );
    expect(moved.capFen[validApp(1)]).toBe(snapshot.capFen[validApp(1)]);
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzp#15] 上限未配置时 80% 告警按默认上限、按 BR-WDR-24 触发：合计恰为 ⌈默认上限 × 80%⌉ 的 app_id 触发 couli-fund.yaml 的 80% 规则，少 1 分的不触发（worker registry 渲染值）', async () => {
  const t = await open();
  try {
    const cap = defaultCapFen();
    const line = nearCapLineFen(cap);
    await autoPaidToday(t.db, NEAR, line);
    await autoPaidToday(t.db, BELOW, line - 1);
    const clock = new FixedClock(NOW);
    const registry = createMetricsRegistry({
      entry: 'worker',
      collectAutoPayout: () => collectAutoPayoutDaily(t.readOnly, clock, payoutCapFenOf),
    });
    const rendered = autoFromText(await registry.render());
    expectSnapshot(rendered, {
      totalFen: { [NEAR]: line, [BELOW]: line - 1 },
      capFen: { [NEAR]: cap, [BELOW]: cap },
    });

    expect(capRuleShares(), 'couli-fund.yaml has the 80 % rule').toContain(0.8);
    // BR-WDR-24 on the default cap, and the rule agreeing with it on the rendered series.
    const { totalFen, capFen } = rendered;
    expect(reachesNearCap(totalFen[NEAR]!, cap), 'BR-WDR-24 at the line').toBe(true);
    expect(reachesNearCap(totalFen[BELOW]!, cap), 'BR-WDR-24 1 fen below').toBe(false);
    expect(fires(0.8, totalFen[NEAR]!, capFen[NEAR]!), '80 % rule fires at the line').toBe(true);
    expect(fires(0.8, totalFen[BELOW]!, capFen[BELOW]!), '80 % rule 1 fen below').toBe(false);
  } finally {
    await t.close();
  }
}, 60_000);
